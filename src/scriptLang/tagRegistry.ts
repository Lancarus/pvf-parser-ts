import * as vscode from 'vscode';
import * as fs from 'fs/promises';

export interface ScriptTagInfo { name: string; description?: string; authors?: string; closing?: boolean; }
interface TagFile { tags: ScriptTagInfo[] }

const cache = new Map<string, ScriptTagInfo[]>();
const GLOBAL_TAGS_SHORT = 'global';

function sanitizeMarkdown(markdown: string): string {
    return markdown.replace(/\]\(\s*command:[^)]+\)/gi, '](#)');
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function editCommentCommandUri(short: string, name: string): string {
    const args = encodeURIComponent(JSON.stringify([{ short, name }]));
    return `command:pvf.editScriptTagComment?${args}`;
}

function appendTagFooter(md: vscode.MarkdownString, short: string, tag: ScriptTagInfo) {
    const author = escapeMarkdownTableCell((tag.authors || '').trim() || '未署名');
    md.appendMarkdown(`\n\n---\n\n| 作者: ${author} | [$(edit) 编辑注释](${editCommentCommandUri(short, tag.name)}) |\n|:--|--:|\n`);
}

function tagDocumentationMarkdown(description: string | undefined, options?: { trustEditCommand?: boolean; short?: string; name?: string }): vscode.MarkdownString | undefined {
    if (!description && !options?.trustEditCommand) return undefined;
    const md = new vscode.MarkdownString(undefined, true);
    if (description) {
        md.appendMarkdown(sanitizeMarkdown(description));
    }
    if (options?.trustEditCommand && options.short && options.name) {
        md.supportThemeIcons = true;
        md.isTrusted = { enabledCommands: ['pvf.editScriptTagComment'] };
        md.appendMarkdown(`\n\n[$(edit) 编辑注释](${editCommentCommandUri(options.short, options.name)})`);
    }
    return md;
}

async function loadTagFile(context: vscode.ExtensionContext, short: string): Promise<ScriptTagInfo[]> {
    const candidates = [
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'scriptLang', 'scriptTags', `${short}.json`),
        vscode.Uri.joinPath(context.extensionUri, 'src', 'scriptLang', 'scriptTags', `${short}.json`)
    ];
    for (const u of candidates) {
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

export function clearTagCache(short?: string) { if (short) cache.delete(short); else cache.clear(); }

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
        const tags = await loadTags(context, short);
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
                    const tags = await loadTags(context, short);
                    const tag = tags.find(x => x.name.toLowerCase() === t.rawName.toLowerCase()) || { name: t.rawName, description: '', authors: '' };
                    const nameRange = new vscode.Range(pos.line, t.nameStart, pos.line, t.nameEnd);
                    const md = new vscode.MarkdownString(undefined, true);
                    md.supportThemeIcons = true;
                    md.isTrusted = { enabledCommands: ['pvf.editScriptTagComment'] };
                    md.appendCodeblock(tag.name, langId);
                    if (tag.description) {
                        md.appendMarkdown('\n\n' + sanitizeMarkdown(tag.description));
                    } else if (!tags.some(x => x.name.toLowerCase() === t.rawName.toLowerCase())) {
                        md.appendMarkdown('\n\n未找到标签注释。');
                    }
                    appendTagFooter(md, short, tag);
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
            const tags = await loadTags(context, short);
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
                        const isCloseCandidate = false; // we only need depth (root-level) for trigger; treat any open closable as depth++ and its close as depth--
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
                ci.documentation = tagDocumentationMarkdown(t.description);
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
        provideCodeActions(doc, range, codeActionContext) {
            const hasUnknownTagDiagnostic = codeActionContext.diagnostics.some(d => d.message.startsWith('未知标签') || d.message.startsWith('未知闭合标签'));
            if (!hasUnknownTagDiagnostic) return [];
            const lineText = doc.lineAt(range.start.line).text;
            for (const tag of iterateBracketTags(lineText)) {
                const tagRange = new vscode.Range(range.start.line, tag.matchStart, range.start.line, tag.matchEnd);
                if (!tagRange.intersection(range)) continue;
                const action = new vscode.CodeAction(`编辑 [${tag.rawName}] 注释`, vscode.CodeActionKind.QuickFix);
                action.command = {
                    title: `编辑 [${tag.rawName}] 注释`,
                    command: 'pvf.editScriptTagComment',
                    arguments: [{ short, name: tag.rawName }]
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
            const tags = await loadTags(context, short);
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
            const tags = await loadTags(context, short);
            if (!tags.length) return builder.build();
            // We'll simulate stack to apply dynamic rule for TRIGGER (act)
            const baseClosing = new Set(tags.filter(t => t.closing).map(t => t.name.toLowerCase()));
            const baseNonClosing = new Set(tags.filter(t => !t.closing).map(t => t.name.toLowerCase()));
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
