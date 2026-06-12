import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pathContains, readConfiguredUnpackRoots } from '../pvf/unpackEnv';

export interface ScriptTagInfo {
    name: string;
    title?: string;
    description?: string;
    authors?: string;
    officialDescription?: string;
    officialAuthors?: string;
    closing?: boolean;
}
interface TagFile { tags: ScriptTagInfo[] }
interface VariantRule {
    short: string;
    variant: string;
    label?: string;
    priority?: number;
    pathIncludes?: string[];
    contentTags?: string[];
    contentIncludes?: string[];
    equipmentTypes?: string[];
    stackableTypes?: string[];
}
interface VariantRulesFile { rules?: VariantRule[] }
export interface ResolvedScriptTags { tags: ScriptTagInfo[]; variant?: string }

const cache = new Map<string, ScriptTagInfo[]>();
const variantRulesCache = new Map<string, VariantRule[]>();
const GLOBAL_TAGS_SHORT = 'global';
const PVF_MANIFEST_FILE = '.pvfmanifest.json';
const MAX_VARIANT_SCAN_CHARS = 64 * 1024;

function sanitizeMarkdown(markdown: string): string {
    return markdown.replace(/\]\(\s*command:[^)]+\)/gi, '](#)');
}

function normalizeLooseHeading(line: string): string {
    return line.replace(/^(#{1,6})([^\s#].*)$/, '$1 $2');
}

function isMarkdownTableRow(line: string): boolean {
    return /^\s*\|?.+\|.+\|?\s*$/.test(line);
}

function isMarkdownTableDivider(line: string): boolean {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitMarkdownTableRow(row: string): string[] {
    return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function markdownTableText(rows: string[][]): string {
    const header = rows[0] || [];
    const body = rows.slice(1);
    const width = Math.max(header.length, ...body.map(row => row.length));
    const normalize = (row: string[]) => {
        const cells = row.slice(0, width);
        while (cells.length < width) cells.push('');
        return `| ${cells.join(' | ')} |`;
    };
    return [
        normalize(header),
        `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
        ...body.map(normalize)
    ].join('\n');
}

function displayWidth(value: string): number {
    let width = 0;
    for (const ch of value) {
        width += ch.charCodeAt(0) > 0xff ? 2 : 1;
    }
    return width;
}

function padCell(value: string, width: number): string {
    return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function codeTableText(rows: string[][]): string {
    const header = rows[0] || [];
    const body = rows.slice(1);
    const columnCount = Math.max(header.length, ...body.map(row => row.length));
    const normalizedRows = rows.map(row => {
        const cells = row.slice(0, columnCount);
        while (cells.length < columnCount) cells.push('');
        return cells;
    });
    const widths = Array.from({ length: columnCount }, (_, column) => {
        return Math.max(3, ...normalizedRows.map(row => displayWidth(row[column] || '')));
    });
    const border = '+' + widths.map(width => '-'.repeat(width + 2)).join('+') + '+';
    const renderRow = (row: string[]) => '| ' + row.map((cell, column) => padCell(cell, widths[column])).join(' | ') + ' |';
    const out = [border, renderRow(normalizedRows[0] || []), border];
    for (const row of normalizedRows.slice(1)) {
        out.push(renderRow(row));
    }
    out.push(border);
    return out.map(line => '    ' + line).join('\n');
}

function readMarkdownTable(lines: string[], start: number): { rows: string[][]; next: number } | undefined {
    if (start + 1 >= lines.length) return undefined;
    if (!isMarkdownTableRow(lines[start]) || !isMarkdownTableDivider(lines[start + 1])) return undefined;
    const rows = [splitMarkdownTableRow(lines[start])];
    let i = start + 2;
    while (i < lines.length && isMarkdownTableRow(lines[i])) {
        rows.push(splitMarkdownTableRow(lines[i]));
        i++;
    }
    return { rows, next: i };
}

function formatCommentMarkdown(markdown: string, options?: { tableStyle?: 'markdown' | 'code' }): string {
    const lines = sanitizeMarkdown(markdown).replace(/\r\n?/g, '\n').split('\n');
    const out: string[] = [];
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            out.push(line);
            continue;
        }
        if (!inFence) {
            const table = readMarkdownTable(lines, i);
            if (table) {
                out.push(options?.tableStyle === 'code' ? codeTableText(table.rows) : markdownTableText(table.rows));
                i = table.next - 1;
                continue;
            }
            out.push(normalizeLooseHeading(line));
        } else {
            out.push(line);
        }
    }
    return out.join('\n');
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function escapeMarkdownHeading(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/([`*_{}\[\]()#+\-.!|>])/g, '\\$1').replace(/\r?\n/g, ' ').trim();
}

function editCommentCommandUri(short: string, name: string, variant?: string): string {
    const args = encodeURIComponent(JSON.stringify([{ short, name, ...(variant ? { variant } : {}) }]));
    return `command:pvf.editScriptTagComment?${args}`;
}

function appendTagFooter(md: vscode.MarkdownString, short: string, tag: ScriptTagInfo, variant?: string) {
    const author = escapeMarkdownTableCell((tag.authors || '').trim() || '未署名');
    md.appendMarkdown(`\n\n---\n\n| 作者: ${author} | [$(edit) 编辑注释](${editCommentCommandUri(short, tag.name, variant)}) |\n|:--|--:|\n`);
}

function tagTitle(tag: Pick<ScriptTagInfo, 'name' | 'title'>): string {
    const title = (tag.title || '').trim();
    return title || tag.name;
}

function hasTagDocumentation(tag: ScriptTagInfo): boolean {
    return !!tag.description || !!tag.officialDescription || !!tag.title;
}

function appendTagDocumentationSections(md: vscode.MarkdownString, tag: ScriptTagInfo, options?: { tableStyle?: 'markdown' | 'code' }) {
    if (tag.description) {
        md.appendMarkdown('\n\n' + formatCommentMarkdown(tag.description, options));
    }
    if (tag.officialDescription) {
        md.appendMarkdown('\n\n---\n\n### 官方注释');
        if (tag.officialAuthors) {
            md.appendMarkdown(`\n\n来源: ${escapeMarkdownHeading(tag.officialAuthors)}`);
        }
        md.appendMarkdown('\n\n' + formatCommentMarkdown(tag.officialDescription, options));
    }
}

function tagDocumentationMarkdown(tag: ScriptTagInfo, options?: { trustEditCommand?: boolean; short?: string; name?: string; variant?: string }): vscode.MarkdownString | undefined {
    if (!hasTagDocumentation(tag) && !options?.trustEditCommand) return undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendCodeblock(tag.name, options?.short ? `pvf-${options.short}` : undefined);
    md.appendMarkdown(`\n\n### ${escapeMarkdownHeading(tagTitle(tag))}`);
    appendTagDocumentationSections(md, tag);
    if (options?.trustEditCommand && options.short && options.name) {
        md.supportThemeIcons = true;
        md.isTrusted = { enabledCommands: ['pvf.editScriptTagComment'] };
        md.appendMarkdown(`\n\n[$(edit) 编辑注释](${editCommentCommandUri(options.short, options.name, options.variant)})`);
    }
    return md;
}

function normalizeTagName(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizePvfPath(value: string): string {
    return decodeURIComponent(String(value || ''))
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .toLowerCase();
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.stat(file);
        return true;
    } catch {
        return false;
    }
}

function tagFileCandidates(context: vscode.ExtensionContext, short: string, variant?: string): vscode.Uri[] {
    const parts = variant
        ? ['config', 'scriptLang', 'scriptTags', 'variants', short, `${variant}.json`]
        : ['config', 'scriptLang', 'scriptTags', `${short}.json`];
    return [
        vscode.Uri.joinPath(context.extensionUri, 'dist', ...parts),
        vscode.Uri.joinPath(context.extensionUri, 'src', ...parts)
    ];
}

function mergeDelimitedAuthors(previous: string | undefined, additions: string | undefined): string | undefined {
    const authors = new Set(String(previous || '').split('|').map(item => item.trim()).filter(Boolean));
    for (const author of String(additions || '').split('|').map(item => item.trim()).filter(Boolean)) {
        authors.add(author);
    }
    return authors.size ? Array.from(authors).join('|') : undefined;
}

function appendMergedMarkdown(previous: string | undefined, addition: string | undefined): string | undefined {
    const source = (addition || '').trim();
    if (!source) return previous;
    const current = (previous || '').trimEnd();
    if (!current) return source;
    if (current.includes(source)) return current;
    return `${current}\n\n${source}`;
}

function mergeTagLists(base: ScriptTagInfo[], additions: ScriptTagInfo[], options?: { mergeDescriptions?: boolean }): ScriptTagInfo[] {
    const merged = base.map(tag => ({ ...tag }));
    const byName = new Map(merged.map(tag => [normalizeTagName(tag.name), tag]));
    for (const source of additions) {
        const key = normalizeTagName(source.name);
        const target = byName.get(key);
        if (!target) {
            const copy = { ...source };
            merged.push(copy);
            byName.set(key, copy);
            continue;
        }
        if (!options?.mergeDescriptions) continue;
        target.description = appendMergedMarkdown(target.description, source.description);
        target.officialDescription = appendMergedMarkdown(target.officialDescription, source.officialDescription);
        if (!target.title && source.title) target.title = source.title;
        if (typeof target.closing !== 'boolean' && typeof source.closing === 'boolean') target.closing = source.closing;
        target.authors = mergeDelimitedAuthors(target.authors, source.authors);
        target.officialAuthors = mergeDelimitedAuthors(target.officialAuthors, source.officialAuthors);
    }
    return merged;
}

async function loadTagFile(context: vscode.ExtensionContext, short: string, variant?: string): Promise<ScriptTagInfo[]> {
    for (const u of tagFileCandidates(context, short, variant)) {
        try {
            const txt = await fs.readFile(u.fsPath, 'utf8');
            const data: TagFile = JSON.parse(txt);
            const arr = data.tags || [];
            return arr;
        } catch { }
    }
    return [];
}

export async function loadTags(context: vscode.ExtensionContext, short: string): Promise<ScriptTagInfo[]> {
    if (cache.has(short)) return cache.get(short)!;
    const local = await loadTagFile(context, short);
    if (short === GLOBAL_TAGS_SHORT) {
        cache.set(short, local);
        return local;
    }
    const global = await loadTags(context, GLOBAL_TAGS_SHORT);
    if (!global.length) {
        cache.set(short, local);
        return local;
    }
    const seen = new Set(local.map(tag => tag.name.toLowerCase()));
    const merged = local.concat(global.filter(tag => !seen.has(tag.name.toLowerCase())));
    cache.set(short, merged);
    return merged;
}

export async function loadVariantTags(context: vscode.ExtensionContext, short: string, variant: string): Promise<ScriptTagInfo[]> {
    const key = `${short}:${variant}`;
    if (cache.has(key)) return cache.get(key)!;
    const local = await loadTagFile(context, short, variant);
    cache.set(key, local);
    return local;
}

export async function loadTagsForVariant(context: vscode.ExtensionContext, short: string, variant?: string): Promise<ScriptTagInfo[]> {
    if (!variant) return loadTags(context, short);
    const key = `${short}:${variant}:merged`;
    if (cache.has(key)) return cache.get(key)!;
    const local = await loadTagFile(context, short);
    const variantTags = await loadVariantTags(context, short, variant);
    const global = short === GLOBAL_TAGS_SHORT ? [] : await loadTags(context, GLOBAL_TAGS_SHORT);
    const localWithVariant = mergeTagLists(local, variantTags, { mergeDescriptions: true });
    const merged = mergeTagLists(localWithVariant, global);
    cache.set(key, merged);
    return merged;
}

async function loadVariantRules(context: vscode.ExtensionContext): Promise<VariantRule[]> {
    const key = context.extensionUri.toString();
    if (variantRulesCache.has(key)) return variantRulesCache.get(key)!;
    const candidates = [
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'config', 'scriptLang', 'scriptTags', 'variantRules.json'),
        vscode.Uri.joinPath(context.extensionUri, 'src', 'config', 'scriptLang', 'scriptTags', 'variantRules.json')
    ];
    for (const u of candidates) {
        try {
            const txt = await fs.readFile(u.fsPath, 'utf8');
            const data: VariantRulesFile = JSON.parse(txt);
            const rules = (data.rules || [])
                .filter(rule => rule.short && rule.variant)
                .sort((a, b) => (b.priority || 0) - (a.priority || 0));
            variantRulesCache.set(key, rules);
            return rules;
        } catch { }
    }
    variantRulesCache.set(key, []);
    return [];
}

function documentScanText(doc: vscode.TextDocument): string {
    const text = doc.getText();
    return text.length > MAX_VARIANT_SCAN_CHARS ? text.slice(0, MAX_VARIANT_SCAN_CHARS) : text;
}

function extractDocumentTags(text: string): Set<string> {
    const tags = new Set<string>();
    let inBacktick = false;
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        const res = extractTagsOutsideBackticks(line, inBacktick);
        inBacktick = res.inBacktickEnd;
        for (const tag of res.tags) {
            if (!tag.isClose) tags.add(normalizeTagName(tag.rawName));
        }
    }
    return tags;
}

function extractFirstTagValue(text: string, tagName: string): string | undefined {
    const expected = normalizeTagName(tagName);
    let inBacktick = false;
    for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
        const line = rawLine.slice(0, rawLine.indexOf('//') >= 0 ? rawLine.indexOf('//') : rawLine.length);
        const res = extractTagsOutsideBackticks(line, inBacktick);
        inBacktick = res.inBacktickEnd;
        for (const tag of res.tags) {
            if (tag.isClose || normalizeTagName(tag.rawName) !== expected) continue;
            const rest = line.slice(tag.matchEnd);
            const value = /\[([^\]]+)\]/.exec(rest);
            if (value) return normalizeTagName(value[1]);
            const code = /`([^`]+)`/.exec(rest);
            if (code) return normalizeTagName(code[1]).replace(/^\[|\]$/g, '');
            return normalizeTagName(rest);
        }
    }
    return undefined;
}

async function pvfKeyFromDiskFile(context: vscode.ExtensionContext, filePath: string): Promise<string | undefined> {
    let current = path.resolve(path.dirname(filePath));
    while (true) {
        const manifest = path.join(current, PVF_MANIFEST_FILE);
        if (await exists(manifest)) {
            const relative = path.relative(current, filePath);
            return normalizePvfPath(relative);
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    const roots = await readConfiguredUnpackRoots(context).catch(() => []);
    const root = roots
        .filter(candidate => pathContains(candidate, filePath))
        .sort((a, b) => b.length - a.length)[0];
    if (!root) return undefined;
    return normalizePvfPath(path.relative(root, filePath));
}

async function normalizedDocumentPath(context: vscode.ExtensionContext, doc: vscode.TextDocument): Promise<string> {
    if (doc.uri.scheme === 'pvf') return normalizePvfPath(doc.uri.path || doc.fileName);
    if (doc.uri.scheme === 'file') {
        const key = await pvfKeyFromDiskFile(context, doc.uri.fsPath);
        if (key) return key;
        return normalizePvfPath(doc.uri.fsPath);
    }
    return normalizePvfPath(doc.uri.path || doc.fileName);
}

function arrayIncludesNormalized(values: string[] | undefined, needle: string | undefined): boolean {
    if (!needle) return false;
    const normalizedNeedle = normalizeTagName(needle);
    return (values || []).some(value => normalizeTagName(value) === normalizedNeedle || normalizedNeedle.includes(normalizeTagName(value)));
}

function ruleMatchesPath(rule: VariantRule, normalizedPath: string): boolean {
    return (rule.pathIncludes || []).some(fragment => normalizedPath.includes(fragment.toLowerCase()));
}

function ruleMatchesContent(rule: VariantRule, scanText: string, tags: Set<string>): boolean {
    if ((rule.contentTags || []).some(tag => tags.has(normalizeTagName(tag)))) return true;
    const lowerText = scanText.toLowerCase();
    if ((rule.contentIncludes || []).some(value => lowerText.includes(value.toLowerCase()))) return true;
    if (rule.short === 'equ' && rule.equipmentTypes?.length) {
        const equipmentType = extractFirstTagValue(scanText, 'equipment type');
        if (arrayIncludesNormalized(rule.equipmentTypes, equipmentType)) return true;
    }
    if (rule.short === 'stk' && rule.stackableTypes?.length) {
        const stackableType = extractFirstTagValue(scanText, 'stackable type');
        if (arrayIncludesNormalized(rule.stackableTypes, stackableType)) return true;
    }
    if (rule.short === 'etc' && rule.variant === 'cashshop') {
        return tags.has('avatar') && tags.has('item');
    }
    return false;
}

export async function resolveScriptTagVariant(context: vscode.ExtensionContext, short: string, doc: vscode.TextDocument): Promise<string | undefined> {
    const rules = (await loadVariantRules(context)).filter(rule => rule.short === short);
    if (!rules.length) return undefined;
    const normalizedPath = await normalizedDocumentPath(context, doc);
    const pathMatch = rules.find(rule => ruleMatchesPath(rule, normalizedPath));
    if (pathMatch) return pathMatch.variant;
    const scanText = documentScanText(doc);
    const tags = extractDocumentTags(scanText);
    const contentMatch = rules.find(rule => ruleMatchesContent(rule, scanText, tags));
    return contentMatch?.variant;
}

export async function loadTagsForDocument(context: vscode.ExtensionContext, short: string, doc: vscode.TextDocument): Promise<ResolvedScriptTags> {
    const variant = await resolveScriptTagVariant(context, short, doc);
    return { tags: await loadTagsForVariant(context, short, variant), variant };
}

export function clearTagCache(short?: string) {
    if (!short) {
        cache.clear();
        variantRulesCache.clear();
        return;
    }
    for (const key of Array.from(cache.keys())) {
        if (key === short || key.startsWith(`${short}:`)) cache.delete(key);
    }
}

// Internal: iterate all bracketed tags in a single line of text.
export function* iterateBracketTags(lineText: string): Generator<{ isClose: boolean; rawName: string; matchStart: number; matchEnd: number; nameStart: number; nameEnd: number }> {
    const regex = /\[(\/)?([^\]]*)\]/g; // capture full inside (may include spaces or operators)
    let m: RegExpExecArray | null;
    while ((m = regex.exec(lineText))) {
        const isClose = !!m[1];
        const inner = m[2].trim();
        if (!inner) continue;
        const nameStart = m.index + 1 + (isClose ? 1 : 0);
        const nameEnd = m.index + m[0].length - 1; // before ']'
        yield { isClose, rawName: inner, matchStart: m.index, matchEnd: m.index + m[0].length, nameStart, nameEnd };
    }
}

// Helper: split a line into segments outside backtick string regions.
// Maintains and returns updated inBacktick state (multi-line backtick blocks allowed).
interface TagMatch { isClose: boolean; rawName: string; matchStart: number; matchEnd: number; nameStart: number; nameEnd: number }
function extractTagsOutsideBackticks(lineText: string, inBacktick: boolean): { tags: TagMatch[]; inBacktickEnd: boolean } {
    if (lineText.indexOf('`') === -1 && !inBacktick) {
        // fast path
        return { tags: Array.from(iterateBracketTags(lineText)), inBacktickEnd: false };
    }
    const segments: { text: string; offset: number }[] = [];
    let last = 0;
    for (let i = 0; i < lineText.length; i++) {
        const ch = lineText[i];
        if (ch === '`') {
            if (!inBacktick) {
                // segment before entering string
                if (i > last) segments.push({ text: lineText.slice(last, i), offset: last });
                inBacktick = true;
                last = i + 1;
            } else {
                // closing string; ignore contents inside backticks entirely
                inBacktick = false;
                last = i + 1;
            }
        }
    }
    if (!inBacktick && last < lineText.length) {
        segments.push({ text: lineText.slice(last), offset: last });
    }
    const tags: TagMatch[] = [];
    for (const seg of segments) {
        for (const t of iterateBracketTags(seg.text)) {
            tags.push({
                isClose: t.isClose,
                rawName: t.rawName,
                matchStart: t.matchStart + seg.offset,
                matchEnd: t.matchEnd + seg.offset,
                nameStart: t.nameStart + seg.offset,
                nameEnd: t.nameEnd + seg.offset
            });
        }
    }
    return { tags, inBacktickEnd: inBacktick };
}

export function registerTagDiagnostics(context: vscode.ExtensionContext, langId: string, short: string) {
    const collection = vscode.languages.createDiagnosticCollection(`${langId}-tags`);
    context.subscriptions.push(collection);

    async function lint(doc: vscode.TextDocument) {
        if (doc.languageId !== langId) return;
        const { tags } = await loadTagsForDocument(context, short, doc);
        if (!tags.length) { collection.delete(doc.uri); return; }
        const needCloseBase = new Set(tags.filter(t => t.closing).map(t => t.name.toLowerCase()));
        const knownTags = new Set(tags.map(t => t.name.toLowerCase()));
        const stack: { tag: string; line: number; start: number }[] = [];
        const diags: vscode.Diagnostic[] = [];
        let inBacktick = false;
        for (let lineNum = 0; lineNum < doc.lineCount; lineNum++) {
            const text = doc.lineAt(lineNum).text;
            const res = extractTagsOutsideBackticks(text, inBacktick);
            inBacktick = res.inBacktickEnd;
            for (const t of res.tags) {
                const lower = t.rawName.toLowerCase();
                const range = new vscode.Range(lineNum, t.matchStart, lineNum, t.matchEnd);
                if (!knownTags.has(lower)) {
                    // ani 特殊：动态 FRAME### 视为合法（不在静态列表）
                    if (short === 'ani' && /^frame\d{3,}$/.test(lower)) {
                        // 跳过未知告警，后续单独帧范围诊断在 ani/registerAni.ts
                        continue;
                    }
                    // 兼容旧拼写：ATTACT BOX -> ATTACK BOX，提示修正建议
                    if (short === 'ani' && lower === 'attact box') {
                        const d = new vscode.Diagnostic(range, '未知标签 [ATTACT BOX]，是否想写 ATTACK BOX ?', vscode.DiagnosticSeverity.Information);
                        diags.push(d);
                        continue;
                    }
                    const msg = t.isClose ? `未知闭合标签 [/${t.rawName}]` : `未知标签 [${t.rawName}]`;
                    diags.push(new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning));
                    continue;
                }
                if (!t.isClose) {
                    // dynamic rule for act: TRIGGER only closable at root level
                    let dynamicClosing = needCloseBase.has(lower);
                    if (short === 'act' && lower === 'trigger') {
                        dynamicClosing = stack.length === 0; // only root-level
                    }
                    if (dynamicClosing) {
                        stack.push({ tag: lower, line: lineNum, start: t.nameStart });
                    }
                } else {
                    let foundIndex = -1;
                    for (let i = stack.length - 1; i >= 0; i--) {
                        if (stack[i].tag === lower) { foundIndex = i; break; }
                    }
                    if (foundIndex === -1) {
                        diags.push(new vscode.Diagnostic(range, `多余的闭合标签 [/${t.rawName}]`, vscode.DiagnosticSeverity.Warning));
                    } else {
                        stack.splice(foundIndex, 1);
                    }
                }
            }
        }
        for (const pending of stack) {
            const range = new vscode.Range(pending.line, pending.start, pending.line, pending.start + 1);
            diags.push(new vscode.Diagnostic(range, `缺少闭合标签 [/${pending.tag}]`, vscode.DiagnosticSeverity.Warning));
        }
        collection.set(doc.uri, diags);
    }

    const debouncers = new Map<string, NodeJS.Timeout>();
    function schedule(doc: vscode.TextDocument) {
        if (doc.languageId !== langId) return;
        const key = doc.uri.toString();
        clearTimeout(debouncers.get(key));
        debouncers.set(key, setTimeout(() => void lint(doc), 250));
    }

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(lint));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri)));
    for (const d of vscode.workspace.textDocuments) void lint(d);
}

export function provideSharedTagFeatures(context: vscode.ExtensionContext, langId: string, short: string) {
    context.subscriptions.push(vscode.languages.registerHoverProvider(langId, {
        async provideHover(doc, pos) {
            const lineText = doc.lineAt(pos.line).text;
            // Need to know if position is inside backtick string: scan from start of document.
            let inBacktick = false;
            for (let ln = 0; ln <= pos.line; ln++) {
                const lt = doc.lineAt(ln).text;
                for (let i = 0; i < lt.length; i++) {
                    if (lt[i] === '`') inBacktick = !inBacktick;
                }
            }
            if (inBacktick) return; // inside backtick string: do not treat bracket tokens as tags
            for (const t of iterateBracketTags(lineText)) {
                if (pos.character >= t.nameStart && pos.character <= t.nameEnd) {
                    const resolved = await loadTagsForDocument(context, short, doc);
                    const tags = resolved.tags;
                    const tag = tags.find(x => x.name.toLowerCase() === t.rawName.toLowerCase()) || { name: t.rawName, description: '', authors: '' };
                    const nameRange = new vscode.Range(pos.line, t.nameStart, pos.line, t.nameEnd);
                    const md = new vscode.MarkdownString(undefined, true);
                    md.supportThemeIcons = true;
                    md.isTrusted = { enabledCommands: ['pvf.editScriptTagComment'] };
                    md.appendCodeblock(tag.name, langId);
                    md.appendMarkdown(`\n\n### ${escapeMarkdownHeading(tagTitle(tag))}`);
                    if (tag.description || tag.officialDescription) {
                        appendTagDocumentationSections(md, tag, { tableStyle: 'code' });
                    } else if (!tags.some(x => x.name.toLowerCase() === t.rawName.toLowerCase())) {
                        md.appendMarkdown('\n\n未找到标签注释。');
                    }
                    appendTagFooter(md, short, tag, resolved.variant);
                    return new vscode.Hover(md, nameRange);
                }
            }
            return;
        }
    }));

    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(langId, {
        async provideCompletionItems(doc, pos) {
            const line = doc.lineAt(pos).text.slice(0, pos.character);
            if (!/\[[^\]]*$/.test(line)) return;
            // Skip if cursor currently inside backtick multi-line string
            let inBacktick = false;
            for (let ln = 0; ln <= pos.line; ln++) {
                const lt = doc.lineAt(ln).text;
                for (let i = 0; i < lt.length; i++) if (lt[i] === '`') inBacktick = !inBacktick;
            }
            if (inBacktick) return;
            const resolved = await loadTagsForDocument(context, short, doc);
            const tags = resolved.tags;
            const fullLine = doc.lineAt(pos.line).text;
            const nextChar = pos.character < fullLine.length ? fullLine[pos.character] : '';
            const replaceClosing = nextChar === ']';
            // compute current stack up to position for dynamic closing evaluation
            function computeDepth(): number {
                let depth = 0;
                for (let ln = 0; ln <= pos.line; ln++) {
                    const text = doc.lineAt(ln).text;
                    for (const t of iterateBracketTags(text)) {
                        if (ln === pos.line && t.matchStart >= line.length) break; // don't process after cursor
                        const lower = t.rawName.toLowerCase();
                        // Determine dynamic closing for trigger same as diagnostics
                        if (short === 'act' && lower === 'trigger') {
                            // root-level closable; nested not closable => only increase depth if depth==0
                            if (depth === 0) depth++;
                        } else {
                            const base = tags.find(tag => tag.name.toLowerCase() === lower);
                            if (base?.closing) depth++;
                        }
                        // We don't attempt to simulate close tokens here since position before potential close.
                    }
                }
                return depth;
            }
            const depth = computeDepth();
            return tags.map(t => {
                const lower = t.name.toLowerCase();
                let dynamicClosing = t.closing;
                if (short === 'act' && lower === 'trigger') dynamicClosing = depth === 0; // root-level only
                const ci = new vscode.CompletionItem(t.name, vscode.CompletionItemKind.Keyword);
                ci.detail = dynamicClosing ? '标签 (需闭合)' : '标签';
                ci.documentation = tagDocumentationMarkdown(t, resolved.variant ? { short, name: t.name, variant: resolved.variant } : undefined);
                if (dynamicClosing) {
                    ci.insertText = new vscode.SnippetString(`${t.name}]$0[/${t.name}]`);
                } else {
                    ci.insertText = t.name + ']';
                }
                if (replaceClosing) {
                    ci.range = new vscode.Range(pos.line, pos.character, pos.line, pos.character + 1);
                }
                return ci;
            });
        }
    }, '[', '/'));

    context.subscriptions.push(vscode.languages.registerCodeActionsProvider(langId, {
        async provideCodeActions(doc, range, codeActionContext) {
            const hasUnknownTagDiagnostic = codeActionContext.diagnostics.some(d => d.message.startsWith('未知标签') || d.message.startsWith('未知闭合标签'));
            if (!hasUnknownTagDiagnostic) return [];
            const variant = await resolveScriptTagVariant(context, short, doc);
            const lineText = doc.lineAt(range.start.line).text;
            for (const tag of iterateBracketTags(lineText)) {
                const tagRange = new vscode.Range(range.start.line, tag.matchStart, range.start.line, tag.matchEnd);
                if (!tagRange.intersection(range)) continue;
                const action = new vscode.CodeAction(`编辑 [${tag.rawName}] 注释`, vscode.CodeActionKind.QuickFix);
                action.command = {
                    title: `编辑 [${tag.rawName}] 注释`,
                    command: 'pvf.editScriptTagComment',
                    arguments: [{ short, name: tag.rawName, ...(variant ? { variant } : {}) }]
                };
                action.diagnostics = [...codeActionContext.diagnostics];
                action.isPreferred = true;
                return [action];
            }
            return [];
        }
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));

    context.subscriptions.push(vscode.languages.registerFoldingRangeProvider(langId, {
        async provideFoldingRanges(doc) {
            const { tags } = await loadTagsForDocument(context, short, doc);
            if (!tags.length) return [];
            const closers = new Set(tags.filter(t => t.closing).map(t => t.name.toLowerCase()));
            const out: vscode.FoldingRange[] = [];
            const stack: { tag: string; line: number }[] = [];
            let inBacktick = false;
            for (let i = 0; i < doc.lineCount; i++) {
                const text = doc.lineAt(i).text;
                const res = extractTagsOutsideBackticks(text, inBacktick);
                inBacktick = res.inBacktickEnd;
                for (const t of res.tags) {
                    const lower = t.rawName.toLowerCase();
                    if (!t.isClose) {
                        let dynamicClosing = closers.has(lower);
                        if (short === 'act' && lower === 'trigger') dynamicClosing = stack.length === 0; // only root-level
                        if (dynamicClosing) stack.push({ tag: lower, line: i });
                    } else {
                        for (let s = stack.length - 1; s >= 0; s--) {
                            if (stack[s].tag === lower) {
                                const start = stack[s].line;
                                if (i > start) out.push(new vscode.FoldingRange(start, i));
                                stack.splice(s, 1);
                                break;
                            }
                        }
                    }
                }
            }
            return out;
        }
    }));

    registerTagDiagnostics(context, langId, short);

    // Semantic Tokens：区分需闭合与无需闭合标签
    const tokenTypes = ['keyword', 'type']; // keyword: non-closing, type: closing
    const legend = new vscode.SemanticTokensLegend(tokenTypes, []);
    context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider({ language: langId }, {
        async provideDocumentSemanticTokens(doc) {
            const builder = new vscode.SemanticTokensBuilder(legend);
            const { tags } = await loadTagsForDocument(context, short, doc);
            if (!tags.length) return builder.build();
            // We'll simulate stack to apply dynamic rule for TRIGGER (act)
            const baseClosing = new Set(tags.filter(t => t.closing).map(t => t.name.toLowerCase()));
            const stack: { tag: string }[] = [];
            let inBacktick = false;
            for (let lineNum = 0; lineNum < doc.lineCount; lineNum++) {
                const text = doc.lineAt(lineNum).text;
                const res = extractTagsOutsideBackticks(text, inBacktick);
                inBacktick = res.inBacktickEnd;
                for (const t of res.tags) {
                    const lower = t.rawName.toLowerCase();
                    const len = t.nameEnd - t.nameStart;
                    if (len <= 0) continue;
                    let dynamicClosing = baseClosing.has(lower);
                    if (short === 'act' && lower === 'trigger') dynamicClosing = stack.length === 0; // only root-level triggers treated as closing
                    if (!t.isClose) {
                        if (dynamicClosing) stack.push({ tag: lower });
                        builder.push(lineNum, t.nameStart, len, tokenTypes.indexOf(dynamicClosing ? 'type' : 'keyword'), 0);
                    } else {
                        // closing token itself always colored as type if it matches an open closable
                        let matched = false;
                        for (let s = stack.length - 1; s >= 0; s--) {
                            if (stack[s].tag === lower) { stack.splice(s, 1); matched = true; break; }
                        }
                        builder.push(lineNum, t.nameStart, len, tokenTypes.indexOf(matched ? 'type' : 'keyword'), 0);
                    }
                }
            }
            return builder.build();
        }
    }, legend));
}
