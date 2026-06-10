import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { clearTagCache, iterateBracketTags, ScriptTagInfo } from './tagRegistry';

interface TagFile { tags: ScriptTagInfo[] }
interface EditTagCommentArgs { short?: string; name?: string }

const SHORT_BY_LANG: Record<string, string> = {
    'pvf-act': 'act',
    'pvf-ai': 'ai',
    'pvf-aic': 'aic',
    'pvf-ani': 'ani',
    'pvf-equ': 'equ',
    'pvf-key': 'key',
    'pvf-skl': 'skl'
};

const VALID_SHORTS = new Set(Object.values(SHORT_BY_LANG));
const DEFAULT_AUTHOR = 'Lancarus';

function normalizeTagName(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeAuthor(value: unknown): string {
    return String(value || '').trim();
}

function configuredAuthor(): string {
    return normalizeAuthor(vscode.workspace.getConfiguration().get<string>('pvf.scriptTagComment.author')) || DEFAULT_AUTHOR;
}

function appendAuthor(previous: string | undefined, author: string): string {
    const next = normalizeAuthor(author);
    if (!next) return normalizeAuthor(previous);
    const parts = normalizeAuthor(previous).split('|').map(s => s.trim()).filter(Boolean);
    if (!parts.some(part => part.toLowerCase() === next.toLowerCase())) parts.push(next);
    return parts.join('|');
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.stat(file);
        return true;
    } catch {
        return false;
    }
}

function tagFilePaths(context: vscode.ExtensionContext, short: string): string[] {
    const root = context.extensionUri.fsPath;
    return [
        path.join(root, 'src', 'scriptLang', 'scriptTags', `${short}.json`),
        path.join(root, 'dist', 'scriptLang', 'scriptTags', `${short}.json`)
    ];
}

async function readTagFile(context: vscode.ExtensionContext, short: string): Promise<{ file: string; data: TagFile }> {
    for (const file of tagFilePaths(context, short)) {
        if (!await exists(file)) continue;
        const text = await fs.readFile(file, 'utf8');
        return { file, data: JSON.parse(text) as TagFile };
    }
    throw new Error(`找不到 ${short}.json`);
}

async function readTag(context: vscode.ExtensionContext, short: string, name: string): Promise<ScriptTagInfo> {
    const { data } = await readTagFile(context, short);
    const expected = normalizeTagName(name);
    const tag = (data.tags || []).find(item => normalizeTagName(item.name) === expected);
    if (!tag) throw new Error(`找不到标签 [${name}]`);
    return tag;
}

async function saveTagDescription(context: vscode.ExtensionContext, short: string, name: string, description: string): Promise<{ files: number; authors: string }> {
    const expected = normalizeTagName(name);
    let saved = 0;
    let savedAuthors = '';
    const author = configuredAuthor();
    for (const file of tagFilePaths(context, short)) {
        if (!await exists(file)) continue;
        const text = await fs.readFile(file, 'utf8');
        const data = JSON.parse(text) as TagFile;
        const tag = (data.tags || []).find(item => normalizeTagName(item.name) === expected);
        if (!tag) continue;
        tag.description = description.replace(/\r\n?/g, '\n').trimEnd();
        tag.authors = appendAuthor(tag.authors, author);
        savedAuthors = tag.authors || '';
        await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
        saved++;
    }
    if (saved === 0) throw new Error(`找不到标签 [${name}]`);
    clearTagCache(short);
    return { files: saved, authors: savedAuthors };
}

function tagAtActiveCursor(): EditTagCommentArgs | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const short = SHORT_BY_LANG[editor.document.languageId];
    if (!short) return undefined;
    const pos = editor.selection.active;
    const lineText = editor.document.lineAt(pos.line).text;
    for (const tag of iterateBracketTags(lineText)) {
        if (pos.character >= tag.nameStart && pos.character <= tag.nameEnd) {
            return { short, name: tag.rawName };
        }
    }
    return undefined;
}

function nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

function safeJson(value: unknown): string {
    return JSON.stringify(value).replace(/[<>&]/g, ch => {
        switch (ch) {
            case '<': return '\\u003C';
            case '>': return '\\u003E';
            case '&': return '\\u0026';
            default: return ch;
        }
    });
}

function editorHtml(panel: vscode.WebviewPanel, init: { short: string; name: string; description: string; authors: string; currentAuthor: string }): string {
    const n = nonce();
    const initJson = safeJson(init);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data: https:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>编辑标签注释</title>
<style>
:root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border);
    --panel: var(--vscode-editorWidget-background);
    --button: var(--vscode-button-background);
    --button-fg: var(--vscode-button-foreground);
    --button-hover: var(--vscode-button-hoverBackground);
    --input: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --focus: var(--vscode-focusBorder);
}
* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; margin: 0; padding: 0; }
body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
}
.shell { min-height: 100%; display: grid; grid-template-rows: auto 1fr auto; }
.topbar {
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
}
.title { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spacer { flex: 1; }
button {
    border: 0;
    min-height: 28px;
    padding: 4px 12px;
    color: var(--button-fg);
    background: var(--button);
    cursor: pointer;
    font: inherit;
}
button:hover { background: var(--button-hover); }
button:focus-visible, textarea:focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; }
.body {
    display: grid;
    grid-template-columns: minmax(260px, 1fr) minmax(260px, 1fr);
    min-height: 0;
}
.pane { min-height: 0; display: grid; grid-template-rows: auto 1fr; }
.pane + .pane { border-left: 1px solid var(--border); }
.paneHeader {
    min-height: 34px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    line-height: 18px;
}
textarea {
    width: 100%;
    height: 100%;
    resize: none;
    border: 0;
    padding: 12px;
    color: var(--input-fg);
    background: var(--input);
    font-family: var(--vscode-editor-font-family), Consolas, monospace;
    font-size: var(--vscode-editor-font-size);
    line-height: 1.5;
}
.preview {
    overflow: auto;
    padding: 12px 18px 32px;
    line-height: 1.6;
}
.preview h1, .preview h2, .preview h3, .preview h4 { line-height: 1.25; margin: 18px 0 10px; }
.preview h1 { font-size: 1.55em; border-bottom: 1px solid var(--border); padding-bottom: 0.25em; }
.preview h2 { font-size: 1.32em; border-bottom: 1px solid var(--border); padding-bottom: 0.2em; }
.preview h3 { font-size: 1.15em; }
.preview p, .preview ul, .preview ol, .preview blockquote, .preview pre { margin: 0 0 12px; }
.preview ul, .preview ol { padding-left: 24px; }
.preview code {
    padding: 0.1em 0.35em;
    border-radius: 3px;
    background: var(--vscode-textCodeBlock-background);
    font-family: var(--vscode-editor-font-family), Consolas, monospace;
}
.preview pre {
    overflow: auto;
    padding: 10px 12px;
    border-radius: 4px;
    background: var(--vscode-textCodeBlock-background);
}
.preview pre code { padding: 0; background: transparent; }
.preview blockquote {
    border-left: 3px solid var(--border);
    padding-left: 12px;
    color: var(--muted);
}
.preview table { border-collapse: collapse; width: 100%; margin: 0 0 12px; }
.preview th, .preview td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
.preview a { color: var(--vscode-textLink-foreground); }
.preview img { max-width: 100%; }
.status {
    min-height: 28px;
    padding: 5px 12px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
}
.status.error { color: var(--vscode-errorForeground); }
@media (max-width: 760px) {
    .body { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
    .pane + .pane { border-left: 0; border-top: 1px solid var(--border); }
}
</style>
</head>
<body>
<div class="shell">
    <div class="topbar">
        <div class="title">编辑注释</div>
        <div class="tag"></div>
        <div class="spacer"></div>
        <button id="save" type="button">保存</button>
    </div>
    <div class="body">
        <section class="pane">
            <div class="paneHeader">Markdown</div>
            <textarea id="editor" spellcheck="false"></textarea>
        </section>
        <section class="pane">
            <div class="paneHeader">预览</div>
            <div id="preview" class="preview"></div>
        </section>
    </div>
    <div id="status" class="status"></div>
</div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const init = ${initJson};
const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const status = document.getElementById('status');
const saveButton = document.getElementById('save');
document.querySelector('.tag').textContent = init.short + ' / [' + init.name + ']';
editor.value = init.description || '';
let lastSaved = editor.value;
let saveTimer = 0;

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
}

function escapeAttr(value) {
    return escapeHtml(value).replace(new RegExp(String.fromCharCode(96), 'g'), '&#96;');
}

function safeUrl(value) {
    const url = String(value || '').trim();
    if (/^(https?:|mailto:|data:image\\/)/i.test(url)) return url;
    return '#';
}

function inlineMarkdown(text) {
    const tick = String.fromCharCode(96);
    const code = [];
    let s = String(text).replace(new RegExp(tick + '([^' + tick + ']+)' + tick, 'g'), (_, body) => {
        const index = code.push('<code>' + escapeHtml(body) + '</code>') - 1;
        return '\\u0000CODE' + index + '\\u0000';
    });
    s = escapeHtml(s);
    s = s.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g, (_, alt, url) => '<img alt="' + escapeAttr(alt) + '" src="' + escapeAttr(safeUrl(url)) + '">');
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, (_, label, url) => '<a href="' + escapeAttr(safeUrl(url)) + '">' + label + '</a>');
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|\\W)\\*([^*]+)\\*(?=\\W|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|\\W)_([^_]+)_(?=\\W|$)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s.replace(/\\u0000CODE(\\d+)\\u0000/g, (_, index) => code[Number(index)] || '');
}

function renderTable(lines, start) {
    if (start + 1 >= lines.length) return null;
    if (!/^\\s*\\|?.+\\|.+\\|?\\s*$/.test(lines[start])) return null;
    if (!/^\\s*\\|?\\s*:?-{3,}:?\\s*(\\|\\s*:?-{3,}:?\\s*)+\\|?\\s*$/.test(lines[start + 1])) return null;
    const rows = [];
    let i = start;
    while (i < lines.length && /^\\s*\\|?.+\\|.+\\|?\\s*$/.test(lines[i])) {
        rows.push(lines[i]);
        i++;
        if (i === start + 1) i++;
    }
    const split = row => row.trim().replace(/^\\|/, '').replace(/\\|$/, '').split('|').map(cell => inlineMarkdown(cell.trim()));
    const head = split(rows[0]);
    const body = rows.slice(1).map(split);
    let html = '<table><thead><tr>' + head.map(cell => '<th>' + cell + '</th>').join('') + '</tr></thead><tbody>';
    html += body.map(row => '<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('');
    html += '</tbody></table>';
    return { html, next: i };
}

function renderMarkdown(source) {
    const lines = String(source || '').replace(/\\r\\n?/g, '\\n').split('\\n');
    const html = [];
    let inFence = false;
    let fence = [];
    let fenceLang = '';
    let listType = '';

    function closeList() {
        if (listType) {
            html.push('</' + listType + '>');
            listType = '';
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const tick = String.fromCharCode(96);
        const fenceMatch = new RegExp('^\\\\s*' + tick + tick + tick + '\\\\s*([^' + tick + ']*)$').exec(line);
        if (fenceMatch) {
            if (inFence) {
                html.push('<pre><code class="language-' + escapeAttr(fenceLang.trim()) + '">' + escapeHtml(fence.join('\\n')) + '</code></pre>');
                inFence = false;
                fence = [];
                fenceLang = '';
            } else {
                closeList();
                inFence = true;
                fenceLang = fenceMatch[1] || '';
            }
            continue;
        }
        if (inFence) {
            fence.push(line);
            continue;
        }

        if (!line.trim()) {
            closeList();
            continue;
        }

        const table = renderTable(lines, i);
        if (table) {
            closeList();
            html.push(table.html);
            i = table.next - 1;
            continue;
        }

        const heading = /^(#{1,4})\\s+(.+)$/.exec(line);
        if (heading) {
            closeList();
            const level = heading[1].length;
            html.push('<h' + level + '>' + inlineMarkdown(heading[2]) + '</h' + level + '>');
            continue;
        }

        if (/^\\s*(-{3,}|\\*{3,}|_{3,})\\s*$/.test(line)) {
            closeList();
            html.push('<hr>');
            continue;
        }

        const quote = /^\\s*>\\s?(.*)$/.exec(line);
        if (quote) {
            closeList();
            html.push('<blockquote>' + inlineMarkdown(quote[1]) + '</blockquote>');
            continue;
        }

        const ul = /^\\s*[-*+]\\s+(.+)$/.exec(line);
        if (ul) {
            if (listType !== 'ul') {
                closeList();
                html.push('<ul>');
                listType = 'ul';
            }
            html.push('<li>' + inlineMarkdown(ul[1]) + '</li>');
            continue;
        }

        const ol = /^\\s*\\d+\\.\\s+(.+)$/.exec(line);
        if (ol) {
            if (listType !== 'ol') {
                closeList();
                html.push('<ol>');
                listType = 'ol';
            }
            html.push('<li>' + inlineMarkdown(ol[1]) + '</li>');
            continue;
        }

        closeList();
        html.push('<p>' + inlineMarkdown(line) + '</p>');
    }

    closeList();
    if (inFence) html.push('<pre><code>' + escapeHtml(fence.join('\\n')) + '</code></pre>');
    return html.join('\\n');
}

function setStatus(text, isError) {
    status.textContent = text || '';
    status.classList.toggle('error', !!isError);
}

function updatePreview() {
    preview.innerHTML = renderMarkdown(editor.value);
    vscode.setState({ text: editor.value });
    const authorText = init.authors ? '作者: ' + init.authors : '作者: 未署名';
    const signerText = init.currentAuthor ? '保存签名: ' + init.currentAuthor : '';
    setStatus((editor.value === lastSaved ? '已保存' : '未保存') + '    ' + authorText + (signerText ? '    ' + signerText : ''));
}

function save() {
    window.clearTimeout(saveTimer);
    saveButton.disabled = true;
    setStatus('保存中...');
    vscode.postMessage({ type: 'save', description: editor.value });
}

editor.addEventListener('input', updatePreview);
saveButton.addEventListener('click', save);
document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
    }
});
window.addEventListener('message', event => {
    const msg = event.data || {};
    saveButton.disabled = false;
    if (msg.type === 'saved') {
        lastSaved = editor.value;
        init.authors = msg.authors || init.authors;
        setStatus('已保存到 ' + msg.files + ' 个文件    作者: ' + (init.authors || '未署名'));
    } else if (msg.type === 'error') {
        setStatus(msg.message || '保存失败', true);
    }
});
const state = vscode.getState();
if (state && typeof state.text === 'string') editor.value = state.text;
updatePreview();
editor.focus();
</script>
</body>
</html>`;
}

export function registerScriptTagCommentEditor(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('pvf.editScriptTagComment', async (arg?: EditTagCommentArgs) => {
        const resolved = arg && arg.short && arg.name ? arg : tagAtActiveCursor();
        if (!resolved?.short || !resolved.name) {
            vscode.window.showWarningMessage('请先把光标放在 PVF 标签名上。');
            return;
        }
        const short = resolved.short;
        if (!VALID_SHORTS.has(short)) {
            vscode.window.showWarningMessage(`不支持的标签类型: ${short}`);
            return;
        }

        let tag: ScriptTagInfo;
        try {
            tag = await readTag(context, short, resolved.name);
        } catch (err: any) {
            vscode.window.showWarningMessage(String(err && err.message || err));
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'pvfScriptTagComment',
            `注释: [${tag.name}]`,
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        panel.webview.html = editorHtml(panel, {
            short,
            name: tag.name,
            description: tag.description || '',
            authors: tag.authors || '',
            currentAuthor: configuredAuthor()
        });

        panel.webview.onDidReceiveMessage(async msg => {
            if (!msg || typeof msg !== 'object') return;
            if (msg.type !== 'save' || typeof msg.description !== 'string') return;
            try {
                const result = await saveTagDescription(context, short, tag.name, msg.description);
                panel.webview.postMessage({ type: 'saved', files: result.files, authors: result.authors });
                vscode.window.showInformationMessage(`已保存 [${tag.name}] 注释`);
            } catch (err: any) {
                const message = String(err && err.message || err);
                panel.webview.postMessage({ type: 'error', message });
                vscode.window.showErrorMessage(message);
            }
        });
    }));
}
