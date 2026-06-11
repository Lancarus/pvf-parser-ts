import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import configJson from '../config/scriptLang/itemCodeHoverConfig.json';
import { getPvfModel } from '../pvf/runtimeModel';
import { getNameByCodeAndLst, NameLookupResult } from '../pvf/services/getPvfContent';
import { scriptTagLanguageId } from './genericTags';

interface ValidationRule {
    sectionName: string;
    value: string;
}

interface SectionRule {
    sectionName: string;
    parentSectionName?: string;
    indexes?: number[];
    startIndex?: number;
    lstFileNames: string[];
    description: string;
    ignoreCodes?: number[];
    validations?: ValidationRule[];
}

interface SectionGroupIndexRule {
    value: number;
    lstFileNames: string[];
    description: string;
    ignoreCodes?: number[];
}

interface SectionGroupRule {
    sectionName: string;
    parentSectionName?: string;
    indexes: SectionGroupIndexRule[];
    validations?: ValidationRule[];
}

interface FileRuleSet {
    fileName: string;
    sections?: SectionRule[];
    sectionRanges?: SectionRule[];
    sectionGroups?: SectionGroupRule[];
}

interface ItemCodeHoverConfig {
    lstAliases?: Record<string, string[]>;
    files: FileRuleSet[];
}

interface TagHit {
    isClose: boolean;
    rawName: string;
    tag: string;
    start: number;
    end: number;
}

interface CodeSegment {
    start: number;
    end: number;
}

interface ValueRange {
    line: number;
    start: number;
    end: number;
}

interface ParsedNode {
    tag: string;
    rawName: string;
    openLine: number;
    openStart: number;
    openEnd: number;
    closeLine?: number;
    closeEnd?: number;
    parent?: ParsedNode;
    children: ParsedNode[];
    valueRanges: ValueRange[];
}

interface ParsedDocument {
    root: ParsedNode;
    nodes: ParsedNode[];
    valueRanges: Array<ValueRange & { node: ParsedNode }>;
    backtickStateAtLine: boolean[];
}

interface NumberToken {
    text: string;
    code: number;
    range: vscode.Range;
    start: number;
    end: number;
}

interface TokenInfo {
    text: string;
    start: number;
    end: number;
}

interface MatchedRule {
    lstFileNames: string[];
    description: string;
}

interface LookupHit {
    description: string;
    lstName: string;
    result: NameLookupResult;
}

interface LookupMiss {
    description: string;
    lstName: string;
    lstPath: string;
    error: string;
}

interface LookupResult {
    hits: LookupHit[];
    misses: LookupMiss[];
}

const config = configJson as ItemCodeHoverConfig;
const parseCache = new Map<string, { version: number; parsed: ParsedDocument }>();
const lstPathCache = new Map<string, { signature: string; paths: string[] }>();
const diskLstCache = new Map<string, { mtimeMs: number; entries: Map<number, string> }>();
const diskNameCache = new Map<string, { mtimeMs: number; name: string | null }>();

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
    ['act', 'pvf-act'],
    ['dgn', 'pvf-dgn'],
    ['etc', 'pvf-etc'],
    ['map', 'pvf-map'],
    ['mm', 'pvf-mm'],
    ['mob', 'pvf-mob'],
    ['qst', 'pvf-qst'],
    ['shp', 'pvf-shp'],
    ['stk', 'pvf-stk']
]);

const LST_NAME_ALIASES: Record<string, string> = {
    dungeon: 'dungeon',
    tackable: 'stackable',
    wown: 'town'
};

function normalizePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function documentPath(doc: vscode.TextDocument): string {
    if (doc.uri.scheme === 'pvf') return normalizePath(decodeURIComponent(doc.uri.path));
    return normalizePath(doc.uri.fsPath || doc.fileName);
}

function normalizeSectionName(name: string | undefined): string | undefined {
    if (!name) return undefined;
    let s = name.trim();
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    if (s.startsWith('/')) s = s.slice(1);
    return s.trim().toLowerCase();
}

function normalizeLstName(name: string): string {
    const lower = name.trim().toLowerCase();
    return LST_NAME_ALIASES[lower] || lower;
}

function normalizeValidationValue(value: string | undefined): string {
    return (value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function matchingFileRuleSets(doc: vscode.TextDocument): FileRuleSet[] {
    const path = documentPath(doc);
    return config.files
        .filter(file => fileRuleMatches(path, file.fileName))
        .sort((a, b) => specificityScore(b.fileName) - specificityScore(a.fileName));
}

function fileRuleMatches(path: string, pattern: string): boolean {
    const lowerPattern = normalizePath(pattern);
    if (lowerPattern.startsWith('*.')) {
        return path.endsWith(lowerPattern.slice(1));
    }
    return path === lowerPattern || path.endsWith('/' + lowerPattern);
}

function specificityScore(pattern: string): number {
    return pattern.includes('*') ? 0 : pattern.length;
}

function configuredLanguageIds(): vscode.DocumentSelector {
    const extensions = new Set<string>();
    for (const file of config.files) {
        const m = file.fileName.toLowerCase().match(/\.([a-z0-9_]+)$/);
        if (m) extensions.add(m[1]);
    }
    return [...extensions]
        .map(ext => LANGUAGE_BY_EXTENSION.get(ext) || scriptTagLanguageId(ext))
        .map(language => ({ language }));
}

function codeSegmentsOutsideBackticksAndComments(line: string, initialInBacktick: boolean): { segments: CodeSegment[]; inBacktickEnd: boolean } {
    const segments: CodeSegment[] = [];
    let inBacktick = initialInBacktick;
    let segmentStart: number | undefined = inBacktick ? undefined : 0;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (!inBacktick && ch === '/' && line[i + 1] === '/') {
            if (segmentStart !== undefined && segmentStart < i) segments.push({ start: segmentStart, end: i });
            return { segments, inBacktickEnd: inBacktick };
        }
        if (ch === '`') {
            if (inBacktick) {
                inBacktick = false;
                segmentStart = i + 1;
            } else {
                if (segmentStart !== undefined && segmentStart < i) segments.push({ start: segmentStart, end: i });
                inBacktick = true;
                segmentStart = undefined;
            }
        }
    }

    if (!inBacktick && segmentStart !== undefined && segmentStart < line.length) {
        segments.push({ start: segmentStart, end: line.length });
    }
    return { segments, inBacktickEnd: inBacktick };
}

function extractTags(line: string, initialInBacktick: boolean): { tags: TagHit[]; inBacktickEnd: boolean } {
    const scan = codeSegmentsOutsideBackticksAndComments(line, initialInBacktick);
    const tags: TagHit[] = [];
    const re = /\[(\/)?([^\]]*)\]/g;
    for (const seg of scan.segments) {
        re.lastIndex = 0;
        const text = line.slice(seg.start, seg.end);
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            const rawName = (m[2] || '').trim();
            if (!rawName) continue;
            const absoluteStart = seg.start + m.index;
            tags.push({
                isClose: !!m[1],
                rawName,
                tag: normalizeSectionName(rawName) || '',
                start: absoluteStart,
                end: absoluteStart + m[0].length
            });
        }
    }
    return { tags, inBacktickEnd: scan.inBacktickEnd };
}

function lineEndBeforeComment(line: string, initialInBacktick: boolean): number {
    let inBacktick = initialInBacktick;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (!inBacktick && ch === '/' && line[i + 1] === '/') return i;
        if (ch === '`') inBacktick = !inBacktick;
    }
    return line.length;
}

function getParsedDocument(doc: vscode.TextDocument): ParsedDocument {
    const cacheKey = doc.uri.toString();
    const cached = parseCache.get(cacheKey);
    if (cached?.version === doc.version) return cached.parsed;

    const parsed = parseDocument(doc);
    parseCache.set(cacheKey, { version: doc.version, parsed });
    return parsed;
}

function parseDocument(doc: vscode.TextDocument): ParsedDocument {
    const lineCount = doc.lineCount;
    const closable = new Set<string>();
    let inBacktick = false;

    for (let line = 0; line < lineCount; line++) {
        const extracted = extractTags(doc.lineAt(line).text, inBacktick);
        inBacktick = extracted.inBacktickEnd;
        for (const tag of extracted.tags) {
            if (tag.isClose) closable.add(tag.tag);
        }
    }

    const root: ParsedNode = {
        tag: '',
        rawName: '',
        openLine: -1,
        openStart: 0,
        openEnd: 0,
        children: [],
        valueRanges: []
    };
    const nodes: ParsedNode[] = [];
    const valueRanges: Array<ValueRange & { node: ParsedNode }> = [];
    const backtickStateAtLine: boolean[] = [];
    const stack: ParsedNode[] = [root];
    let lastValueNode: ParsedNode | null = null;
    inBacktick = false;

    const addValueRange = (node: ParsedNode, line: number, start: number, end: number) => {
        if (start >= end || !doc.lineAt(line).text.slice(start, end).trim()) return;
        const range = { line, start, end };
        node.valueRanges.push(range);
        valueRanges.push({ ...range, node });
    };

    for (let line = 0; line < lineCount; line++) {
        backtickStateAtLine[line] = inBacktick;
        const lineText = doc.lineAt(line).text;
        const extracted = extractTags(lineText, inBacktick);
        inBacktick = extracted.inBacktickEnd;
        const tags = extracted.tags;

        if (!tags.length) {
            const owner = lastValueNode || (stack.length > 1 ? stack[stack.length - 1] : null);
            if (owner) addValueRange(owner, line, 0, lineEndBeforeComment(lineText, backtickStateAtLine[line]));
            continue;
        }

        for (let i = 0; i < tags.length; i++) {
            const tag = tags[i];
            lastValueNode = null;
            if (tag.isClose) {
                for (let s = stack.length - 1; s >= 1; s--) {
                    if (stack[s].tag === tag.tag) {
                        const closed = stack[s];
                        closed.closeLine = line;
                        closed.closeEnd = tag.end;
                        stack.splice(s);
                        break;
                    }
                }
                continue;
            }

            const parent = stack[stack.length - 1];
            const node: ParsedNode = {
                tag: tag.tag,
                rawName: tag.rawName,
                openLine: line,
                openStart: tag.start,
                openEnd: tag.end,
                parent,
                children: [],
                valueRanges: []
            };
            parent.children.push(node);
            nodes.push(node);

            const nextTagStart = tags[i + 1]?.start ?? lineText.length;
            const valueEnd = Math.min(nextTagStart, lineEndBeforeComment(lineText, backtickStateAtLine[line]));
            addValueRange(node, line, tag.end, valueEnd);

            if (closable.has(tag.tag)) {
                stack.push(node);
            } else {
                lastValueNode = node;
            }
        }
    }

    return { root, nodes, valueRanges, backtickStateAtLine };
}

function findNumberToken(doc: vscode.TextDocument, pos: vscode.Position, parsed: ParsedDocument): NumberToken | undefined {
    const lineText = doc.lineAt(pos.line).text;
    const initialInBacktick = parsed.backtickStateAtLine[pos.line] || false;
    const scan = codeSegmentsOutsideBackticksAndComments(lineText, initialInBacktick);
    const tokenRe = /\S+/g;

    for (const seg of scan.segments) {
        if (pos.character < seg.start || pos.character > seg.end) continue;
        tokenRe.lastIndex = 0;
        const text = lineText.slice(seg.start, seg.end);
        let m: RegExpExecArray | null;
        while ((m = tokenRe.exec(text))) {
            const start = seg.start + m.index;
            const end = start + m[0].length;
            if (pos.character < start || pos.character > end) continue;
            if (!/^\d+$/.test(m[0])) return undefined;
            const code = Number(m[0]);
            if (!Number.isSafeInteger(code)) return undefined;
            return {
                text: m[0],
                code,
                start,
                end,
                range: new vscode.Range(pos.line, start, pos.line, end)
            };
        }
    }
    return undefined;
}

function findOwnerNode(parsed: ParsedDocument, token: NumberToken, line: number): ParsedNode | undefined {
    for (const vr of parsed.valueRanges) {
        if (vr.line === line && token.start >= vr.start && token.end <= vr.end) {
            return vr.node;
        }
    }
    return undefined;
}

function tokensInValueRange(doc: vscode.TextDocument, range: ValueRange): TokenInfo[] {
    const lineText = doc.lineAt(range.line).text.slice(range.start, range.end);
    const out: TokenInfo[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText))) {
        out.push({
            text: m[0],
            start: range.start + m.index,
            end: range.start + m.index + m[0].length
        });
    }
    return out;
}

function tokenIndexInNode(doc: vscode.TextDocument, node: ParsedNode, token: NumberToken): number | undefined {
    const range = node.valueRanges.find(vr => vr.line === token.range.start.line && token.start >= vr.start && token.end <= vr.end);
    if (!range) return undefined;
    const tokens = tokensInValueRange(doc, range);
    return tokens.findIndex(t => t.start === token.start && t.end === token.end);
}

function nodeValueText(doc: vscode.TextDocument, node: ParsedNode): string | undefined {
    for (const vr of node.valueRanges) {
        const tokens = tokensInValueRange(doc, vr);
        if (tokens.length) return tokens.map(t => t.text).join(' ');
    }
    return undefined;
}

function nearestSiblingValue(doc: vscode.TextDocument, node: ParsedNode, tag: string): string | undefined {
    const parent = node.parent;
    if (!parent) return undefined;
    const siblings = parent.children;
    const currentIndex = siblings.indexOf(node);

    for (let i = currentIndex - 1; i >= 0; i--) {
        if (siblings[i].tag === tag) return nodeValueText(doc, siblings[i]);
    }
    for (let i = currentIndex + 1; i < siblings.length; i++) {
        if (siblings[i].tag === tag) return nodeValueText(doc, siblings[i]);
    }
    return undefined;
}

function findValidationValue(doc: vscode.TextDocument, node: ParsedNode, sectionName: string): string | undefined {
    const tag = normalizeSectionName(sectionName);
    if (!tag) return undefined;

    const directChild = node.children.find(child => child.tag === tag);
    if (directChild) return nodeValueText(doc, directChild);

    let cursor: ParsedNode | undefined = node;
    while (cursor) {
        const siblingValue = nearestSiblingValue(doc, cursor, tag);
        if (siblingValue !== undefined) return siblingValue;
        cursor = cursor.parent;
    }
    return undefined;
}

function validationsMatch(doc: vscode.TextDocument, node: ParsedNode, validations: ValidationRule[] | undefined): boolean {
    if (!validations?.length) return true;
    return validations.every(validation => {
        const actual = findValidationValue(doc, node, validation.sectionName);
        return normalizeValidationValue(actual) === normalizeValidationValue(validation.value);
    });
}

function parentMatches(node: ParsedNode, parentSectionName?: string): boolean {
    const parent = normalizeSectionName(parentSectionName);
    if (!parent) return true;
    return node.parent?.tag === parent;
}

function codeAllowed(code: number, ignoreCodes?: number[]): boolean {
    return !(ignoreCodes || []).includes(code);
}

function matchRules(doc: vscode.TextDocument, fileRules: FileRuleSet[], node: ParsedNode, tokenIndex: number, code: number): MatchedRule[] {
    const out: MatchedRule[] = [];

    for (const file of fileRules) {
        for (const group of file.sectionGroups || []) {
            if (node.tag !== normalizeSectionName(group.sectionName)) continue;
            if (!parentMatches(node, group.parentSectionName)) continue;
            if (!validationsMatch(doc, node, group.validations)) continue;
            const indexRule = group.indexes.find(index => index.value === tokenIndex);
            if (!indexRule || !codeAllowed(code, indexRule.ignoreCodes)) continue;
            out.push({ lstFileNames: indexRule.lstFileNames, description: indexRule.description });
        }

        for (const section of file.sections || []) {
            if (node.tag !== normalizeSectionName(section.sectionName)) continue;
            if (!parentMatches(node, section.parentSectionName)) continue;
            if (!validationsMatch(doc, node, section.validations)) continue;
            if (section.indexes?.length && !section.indexes.includes(tokenIndex)) continue;
            if (!codeAllowed(code, section.ignoreCodes)) continue;
            out.push({ lstFileNames: section.lstFileNames, description: section.description });
        }

        for (const range of file.sectionRanges || []) {
            if (node.tag !== normalizeSectionName(range.sectionName)) continue;
            if (!parentMatches(node, range.parentSectionName)) continue;
            if (!validationsMatch(doc, node, range.validations)) continue;
            if (tokenIndex < (range.startIndex || 0)) continue;
            if (!codeAllowed(code, range.ignoreCodes)) continue;
            out.push({ lstFileNames: range.lstFileNames, description: range.description });
        }
    }

    return dedupeMatchedRules(out);
}

function dedupeMatchedRules(rules: MatchedRule[]): MatchedRule[] {
    const seen = new Set<string>();
    const out: MatchedRule[] = [];
    for (const rule of rules) {
        const key = `${rule.description}\0${rule.lstFileNames.map(normalizeLstName).join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rule);
    }
    return out;
}

function resolveLstPaths(lstName: string): string[] {
    const normalizedName = normalizeLstName(lstName);
    const cacheKey = normalizedName;
    const model = getPvfModel();
    const keys = model?.getAllKeys?.() || [];
    const signature = `${model?.pvfPath || ''}:${keys.length}`;
    const cached = lstPathCache.get(cacheKey);
    if (cached && cached.signature === signature) return cached.paths;

    const candidates: string[] = [];
    const aliasCandidates = config.lstAliases?.[lstName.toLowerCase()] || config.lstAliases?.[normalizedName] || [];
    candidates.push(...aliasCandidates.map(normalizePath));

    if (normalizedName.endsWith('.lst')) {
        candidates.push(normalizePath(normalizedName));
    } else {
        candidates.push(`${normalizedName}/${normalizedName}.lst`);
        candidates.push(`${normalizedName}.lst`);
    }

    if (keys.length) {
        const lowerKeys = keys.map(normalizePath).filter(key => key.endsWith('.lst'));
        const existingCandidates = candidates.filter(candidate => lowerKeys.includes(candidate));
        const dynamicMatches = lowerKeys.filter(key => {
            const base = key.split('/').pop() || key;
            const folder = key.includes('/') ? key.slice(0, key.lastIndexOf('/')).split('/').pop() || '' : '';
            return base === `${normalizedName}.lst`
                || folder === normalizedName
                || base.replace(/\.lst$/, '') === normalizedName
                || key.endsWith(`/${normalizedName}.lst`);
        });
        lstPathCache.set(cacheKey, { signature, paths: unique([...existingCandidates, ...dynamicMatches, ...candidates]) });
    } else {
        lstPathCache.set(cacheKey, { signature, paths: unique(candidates) });
    }

    return lstPathCache.get(cacheKey)!.paths;
}

function unique<T>(values: T[]): T[] {
    return [...new Set(values)];
}

function diskCandidateRoots(doc: vscode.TextDocument): string[] {
    if (doc.uri.scheme !== 'file') return [];
    const roots: string[] = [];
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (workspaceFolder) roots.push(workspaceFolder.uri.fsPath);

    let cursor = path.dirname(doc.uri.fsPath);
    for (let i = 0; i < 10; i++) {
        roots.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
    }

    const seen = new Set<string>();
    return roots
        .map(root => path.resolve(root))
        .filter(root => {
            const key = process.platform === 'win32' ? root.toLowerCase() : root;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function joinArchivePath(root: string, archivePath: string): string {
    return path.join(root, ...normalizePath(archivePath).split('/').filter(Boolean));
}

async function readUtf8Text(filePath: string): Promise<string> {
    const buf = await fs.readFile(filePath);
    let text = Buffer.from(buf).toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
}

async function readDiskLstEntries(lstDiskPath: string): Promise<Map<number, string> | undefined> {
    try {
        const stat = await fs.stat(lstDiskPath);
        const cached = diskLstCache.get(lstDiskPath);
        if (cached && cached.mtimeMs === stat.mtimeMs) return cached.entries;

        const text = await readUtf8Text(lstDiskPath);
        const entries = new Map<number, string>();
        for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const m = line.match(/^(-?\d+)\s+`?([^`]+)`?/);
            if (!m) continue;
            const code = Number(m[1]);
            if (!Number.isSafeInteger(code)) continue;
            entries.set(code, normalizePath(m[2]));
        }
        diskLstCache.set(lstDiskPath, { mtimeMs: stat.mtimeMs, entries });
        return entries;
    } catch {
        return undefined;
    }
}

function stripPvfValue(value: string): string {
    let text = value.trim();
    const linkText = text.match(/`([^`]*)`/);
    if (linkText) text = linkText[1];
    if (text.startsWith('`') && text.endsWith('`')) text = text.slice(1, -1);
    return text.trim();
}

function extractNameFromScriptText(text: string): string | undefined {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(/^\s*\[name\]\s*(.*)$/i);
        if (!m) continue;
        const inline = stripPvfValue(m[1] || '');
        if (inline && !inline.startsWith('[')) return inline;
        for (let j = i + 1; j < lines.length; j++) {
            const valueLine = lines[j].trim();
            if (!valueLine) continue;
            if (/^\s*\[\/?name\]\s*$/i.test(valueLine)) continue;
            if (/^\s*\[/.test(valueLine)) return undefined;
            const value = stripPvfValue(valueLine);
            if (value) return value;
        }
    }
    return undefined;
}

async function getDiskName(scriptDiskPath: string): Promise<string | undefined> {
    try {
        const stat = await fs.stat(scriptDiskPath);
        const cached = diskNameCache.get(scriptDiskPath);
        if (cached && cached.mtimeMs === stat.mtimeMs) return cached.name || undefined;

        const text = await readUtf8Text(scriptDiskPath);
        const name = extractNameFromScriptText(text);
        diskNameCache.set(scriptDiskPath, { mtimeMs: stat.mtimeMs, name: name || null });
        return name;
    } catch {
        return undefined;
    }
}

async function lookupDiskCode(doc: vscode.TextDocument, lstPath: string, code: number): Promise<NameLookupResult | undefined> {
    for (const root of diskCandidateRoots(doc)) {
        const lstDiskPath = joinArchivePath(root, lstPath);
        const entries = await readDiskLstEntries(lstDiskPath);
        if (!entries) continue;

        const scriptPath = entries.get(code);
        if (!scriptPath) {
            return { ok: false, code, lstPath: normalizePath(path.relative(root, lstDiskPath)), error: 'not_found' };
        }

        const scriptCandidates = unique([
            path.isAbsolute(scriptPath) ? scriptPath : joinArchivePath(root, scriptPath),
            path.join(path.dirname(lstDiskPath), ...scriptPath.split('/').filter(Boolean))
        ]);

        for (const scriptDiskPath of scriptCandidates) {
            try {
                const stat = await fs.stat(scriptDiskPath);
                if (!stat.isFile()) continue;
            } catch {
                continue;
            }
            const archiveScriptPath = normalizePath(path.relative(root, scriptDiskPath));
            const archiveLstPath = normalizePath(path.relative(root, lstDiskPath));
            const name = await getDiskName(scriptDiskPath);
            return name
                ? { ok: true, code, lstPath: archiveLstPath, scriptPath: archiveScriptPath, name }
                : { ok: false, code, lstPath: archiveLstPath, scriptPath: archiveScriptPath, error: 'no_name' };
        }

        return { ok: false, code, lstPath: normalizePath(path.relative(root, lstDiskPath)), scriptPath, error: 'script_not_found' };
    }

    return undefined;
}

async function lookupCode(doc: vscode.TextDocument, rules: MatchedRule[], code: number): Promise<LookupResult> {
    const hits: LookupHit[] = [];
    const misses: LookupMiss[] = [];
    const seen = new Set<string>();

    for (const rule of rules) {
        for (const lstName of rule.lstFileNames) {
            for (const lstPath of resolveLstPaths(lstName).slice(0, 8)) {
                const key = `${rule.description}\0${normalizeLstName(lstName)}\0${lstPath}`;
                if (seen.has(key)) continue;
                seen.add(key);
                let pvfError = '';
                try {
                    const result = await getNameByCodeAndLst(lstPath, code);
                    if (result.scriptPath) {
                        hits.push({ description: rule.description, lstName, result });
                        continue;
                    } else {
                        pvfError = result.error || 'not_found';
                    }
                } catch (err: any) {
                    pvfError = String(err?.message || err || 'lookup_error');
                }

                const diskResult = await lookupDiskCode(doc, lstPath, code);
                if (diskResult?.scriptPath) {
                    hits.push({ description: rule.description, lstName, result: diskResult });
                } else {
                    misses.push({ description: rule.description, lstName, lstPath: diskResult?.lstPath || lstPath, error: diskResult?.error || pvfError || 'not_found' });
                }
            }
        }
    }

    return { hits, misses };
}

function escapeMarkdown(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/([`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

function openCommandUri(path: string): string {
    return `command:pvf.openFuzzyPath?${encodeURIComponent(JSON.stringify([path]))}`;
}

function buildHover(code: number, hits: LookupHit[], range: vscode.Range): vscode.Hover {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['pvf.openFuzzyPath'] };
    md.supportThemeIcons = true;
    md.appendMarkdown(`**PVF 代码** \`${code}\``);
    md.appendMarkdown('\n\n| 类型 | 名称 | LST | 脚本 |\n|---|---|---|---|\n');

    for (const hit of hits) {
        const name = hit.result.name ? escapeMarkdown(hit.result.name) : escapeMarkdown('未找到 [name]');
        const lstPath = escapeMarkdown(hit.result.lstPath || '');
        const scriptPath = hit.result.scriptPath || '';
        const scriptLink = scriptPath
            ? `[${escapeMarkdown(scriptPath)}](${openCommandUri(scriptPath)})`
            : '';
        md.appendMarkdown(`| ${escapeMarkdown(hit.description)} | ${name} | \`${lstPath}\` | ${scriptLink} |\n`);
    }

    return new vscode.Hover(md, range);
}

function buildLiteralHover(code: number, title: string, detail: string, range: vscode.Range): vscode.Hover {
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**PVF 代码** \`${code}\``);
    md.appendMarkdown(`\n\n| 类型 | 名称 | 说明 |\n|---|---|---|\n`);
    md.appendMarkdown(`| ${escapeMarkdown(title)} | ${escapeMarkdown(detail)} | 内置规则 |\n`);
    return new vscode.Hover(md, range);
}

function buildLookupMissHover(code: number, rules: MatchedRule[], lookup: LookupResult, range: vscode.Range): vscode.Hover {
    const md = new vscode.MarkdownString(undefined, true);
    const model = getPvfModel();
    md.appendMarkdown(`**PVF 代码** \`${code}\``);
    md.appendMarkdown('\n\n已命中代码 hover 规则，但没有在候选 `.lst` 中找到对应脚本。');
    if (!model?.getAllKeys?.().length) {
        md.appendMarkdown('\n\n当前没有已打开的 PVF 包；如果这是磁盘解包目录，扩展会按当前文件路径向上查找候选 `.lst`。');
    }
    md.appendMarkdown('\n\n| 类型 | 候选 LST | 状态 |\n|---|---|---|\n');

    const rows = lookup.misses.length
        ? lookup.misses
        : rules.flatMap(rule => rule.lstFileNames.flatMap(lstName => resolveLstPaths(lstName).map(lstPath => ({
            description: rule.description,
            lstName,
            lstPath,
            error: 'not_found'
        }))));
    for (const miss of rows.slice(0, 8)) {
        md.appendMarkdown(`| ${escapeMarkdown(miss.description)} | \`${escapeMarkdown(miss.lstPath)}\` | ${escapeMarkdown(miss.error)} |\n`);
    }
    return new vscode.Hover(md, range);
}

export function registerItemCodeHover(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(configuredLanguageIds(), {
            async provideHover(doc, pos) {
                const fileRules = matchingFileRuleSets(doc);
                if (!fileRules.length) return undefined;

                const parsed = getParsedDocument(doc);
                const token = findNumberToken(doc, pos, parsed);
                if (!token) return undefined;

                const node = findOwnerNode(parsed, token, pos.line);
                if (!node) return undefined;

                const tokenIndex = tokenIndexInNode(doc, node, token);
                if (tokenIndex === undefined || tokenIndex < 0) return undefined;

                const matchedRules = matchRules(doc, fileRules, node, tokenIndex, token.code);
                if (!matchedRules.length) return undefined;

                if (doc.languageId === 'pvf-qst' && node.tag === 'reward int data' && tokenIndex === 0 && token.code === 0) {
                    return buildLiteralHover(token.code, '金币', '任务金币奖励', token.range);
                }

                const lookup = await lookupCode(doc, matchedRules, token.code);
                if (!lookup.hits.length) return buildLookupMissHover(token.code, matchedRules, lookup, token.range);

                return buildHover(token.code, lookup.hits, token.range);
            }
        }),
        vscode.workspace.onDidCloseTextDocument(doc => parseCache.delete(doc.uri.toString()))
    );
}
