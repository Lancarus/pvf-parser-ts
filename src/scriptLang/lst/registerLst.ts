import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

// ── LST 条目解析 ──────────────────────────────────────────
interface LstEntry {
  line: number;
  code: string;
  rawPath: string;       // 反引号内的原始路径
}

function parseLstLine(line: string, lineIdx: number): LstEntry | undefined {
  const m = line.match(/^(\d+)\s+`([^`]+)`/);
  return m ? { line: lineIdx, code: m[1], rawPath: m[2] } : undefined;
}

// ── 文件路径解析（磁盘解包区）──────────────────────────────
function lstDirForDoc(document: vscode.TextDocument): string {
  return path.dirname(document.uri.fsPath);
}

async function resolveLstEntryPath(
  lstDir: string,
  rawPath: string,
): Promise<string | undefined> {
  // 1. 直接拼接：lst 所在目录 + 条目路径
  const direct = path.resolve(lstDir, rawPath);
  try {
    const s = await fs.stat(direct);
    if (s.isFile()) return direct;
  } catch { /* not found */ }

  // 2. 如果 rawPath 不包含子目录（省略了子目录名），搜索 lstDir 下的一级子目录
  if (!rawPath.includes('/') && !rawPath.includes('\\')) {
    let subdirs: string[];
    try {
      subdirs = (await fs.readdir(lstDir, { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch { subdirs = []; }
    for (const sub of subdirs) {
      const candidate = path.resolve(lstDir, sub, rawPath);
      try {
        const s = await fs.stat(candidate);
        if (s.isFile()) return candidate;
      } catch { /* continue */ }
    }
  }

  return undefined;
}

// ── [name] 标签提取 ──────────────────────────────────────
function extractNameTag(text: string): string | undefined {
  // 匹配 [name] 后面第一个反引号内的内容，或下一行/同行的文本
  const m = text.match(/\[name\](?:\s*`([^`]+)`|$)/i);
  if (m && m[1]) return m[1].trim();
  // 如果 [name] 独占一行，取下一行内容
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[name\]\s*$/i.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        const trimmed = lines[j].trim();
        if (!trimmed || trimmed.startsWith('[')) break;
        const match = trimmed.match(/`([^`]+)`/);
        if (match) return match[1].trim();
        if (trimmed) return trimmed;
      }
    }
    const inline = lines[i].match(/\[name\]\s*`([^`]+)`/i);
    if (inline) return inline[1].trim();
  }
  return undefined;
}

// ── 文件名 → 代码的缓存（磁盘模式）───────────────────────
interface NameCacheEntry {
  name: string;
  mtime: number;
}
const nameCache = new Map<string, NameCacheEntry>();
const NAME_CACHE_MAX = 5000;

async function getTargetName(diskPath: string): Promise<string | undefined> {
  let stat: { mtimeMs: number };
  try { stat = await fs.stat(diskPath); } catch { return undefined; }
  const cached = nameCache.get(diskPath);
  if (cached && cached.mtime === stat.mtimeMs) return cached.name;
  try {
    const buf = await fs.readFile(diskPath);
    let text: string;
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      text = buf.toString('utf8', 3);
    } else {
      text = buf.toString('utf8');
    }
    const name = extractNameTag(text) || undefined;
    if (nameCache.size >= NAME_CACHE_MAX) nameCache.clear();
    nameCache.set(diskPath, { name: name ?? '', mtime: stat.mtimeMs });
    return name;
  } catch {
    return undefined;
  }
}

// ── 磁盘模式 DocumentLink 辅助 ────────────────────────────
function entryLinkTarget(rawPath: string, lstDir: string): vscode.Uri {
  const low = rawPath.toLowerCase();
  if (low.endsWith('.img')) {
    // .img → 换后缀为 .npk，尝试 NPK 根目录与同目录
    const npkName = rawPath.replace(/\.img$/i, '.npk');
    return vscode.Uri.file(path.resolve(lstDir, npkName));
  }
  return vscode.Uri.file(path.resolve(lstDir, rawPath));
}

// ═══════════════════════════════════════════════════════════
// CodeLens provider: 在可见行内显示目标文件的 [name]
// ═══════════════════════════════════════════════════════════
function registerLstCodeLens(context: vscode.ExtensionContext) {
  const emitter = new vscode.EventEmitter<void>();
  const selector: vscode.DocumentSelector = { language: 'pvf-lst', scheme: 'file' };
  const MARGIN = 200;
  const DEBOUNCE = 120;

  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: emitter.event,
    async provideCodeLenses(document, token) {
      if (token.isCancellationRequested) return [];
      const editor = vscode.window.activeTextEditor;
      const lines = document.lineCount;
      let startLine = 0;
      let endLine = Math.min(lines - 1, 199);
      if (editor && editor.document === document) {
        const vr = editor.visibleRanges;
        if (vr.length > 0) {
          startLine = Math.max(0, vr[0].start.line - MARGIN);
          endLine = Math.min(lines - 1, vr[vr.length - 1].end.line + MARGIN);
        }
      }
      const lstDir = lstDirForDoc(document);
      const lenses: vscode.CodeLens[] = [];
      const promises: Promise<void>[] = [];
      for (let i = startLine; i <= endLine; i++) {
        const line = document.lineAt(i).text;
        const entry = parseLstLine(line, i);
        if (!entry) continue;
        // 记录 CodeLens 占位（先空着，等 name 解析完成后再填充）
        const lens = new vscode.CodeLens(new vscode.Range(i, 0, i, 0), { title: '…', command: '' });
        lenses.push(lens);
        promises.push(
          resolveLstEntryPath(lstDir, entry.rawPath)
            .then(async diskPath => {
              if (!diskPath) {
                lens.command = { title: '(文件未找到)', command: '' };
                return;
              }
              const name = await getTargetName(diskPath);
              lens.command = {
                title: name ? `${name}` : '(无 name 标签)',
                command: '',
              };
            })
            .catch(() => {
              lens.command = { title: '(错误)', command: '' };
            }),
        );
      }
      await Promise.all(promises);
      return lenses;
    },
  };

  context.subscriptions.push(vscode.languages.registerCodeLensProvider(selector, provider));

  // 滚动时刷新
  let timer: NodeJS.Timeout | undefined;
  context.subscriptions.push(vscode.window.onDidChangeTextEditorVisibleRanges(e => {
    if (e.textEditor.document.languageId === 'pvf-lst') {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => emitter.fire(), DEBOUNCE);
    }
  }));
}

// ═══════════════════════════════════════════════════════════
// DocumentLink provider: 让反引号路径可点击跳转（磁盘模式）
// ═══════════════════════════════════════════════════════════
function registerLstDocumentLink(context: vscode.ExtensionContext) {
  const selector: vscode.DocumentSelector = { language: 'pvf-lst', scheme: 'file' };

  const provider: vscode.DocumentLinkProvider = {
    provideDocumentLinks(document) {
      const lines = document.lineCount;
      const lstDir = lstDirForDoc(document);
      const links: vscode.DocumentLink[] = [];
      const maxLinks = 6000;
      for (let i = 0; i < lines && links.length < maxLinks; i++) {
        const line = document.lineAt(i).text;
        const entry = parseLstLine(line, i);
        if (!entry) continue;
        const startTick = line.indexOf('`');
        const endTick = startTick >= 0 ? line.indexOf('`', startTick + 1) : -1;
        if (startTick < 0 || endTick <= startTick) continue;
        const range = new vscode.Range(new vscode.Position(i, startTick + 1), new vscode.Position(i, endTick));
        links.push(new vscode.DocumentLink(range, entryLinkTarget(entry.rawPath, lstDir)));
      }
      return links;
    },
  };

  context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(selector, provider));
}

// ═══════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════
export function registerLstLanguage(context: vscode.ExtensionContext) {
  // 诊断集合
  const collection = vscode.languages.createDiagnosticCollection('pvf-lst');
  context.subscriptions.push(collection);

  async function refresh(doc: vscode.TextDocument) {
    if (doc.languageId !== 'pvf-lst') return;
    const diags: vscode.Diagnostic[] = [];
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[0].trim().length > 0 && lines[0].trim() !== '#PVF_File' && !lines[0].startsWith('#')) {
      diags.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, lines[0].length), '首行建议使用 #PVF_File 作为文件头', vscode.DiagnosticSeverity.Hint));
    }
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw) continue;
      if (raw.startsWith('#')) continue;
      if (i === 0 && raw.trim() === '#PVF_File') continue;
      const tab = raw.indexOf('\t');
      if (tab === -1) {
        diags.push(new vscode.Diagnostic(new vscode.Range(i, 0, i, raw.length), '缺少制表符分隔的 key\tvalue', vscode.DiagnosticSeverity.Warning));
        continue;
      }
      const key = raw.substring(0, tab).trim();
      const value = raw.substring(tab + 1);
      if (!key) {
        diags.push(new vscode.Diagnostic(new vscode.Range(i, 0, i, tab), '空的 key', vscode.DiagnosticSeverity.Warning));
      } else if (!/^\d+$/.test(key)) {
        diags.push(new vscode.Diagnostic(new vscode.Range(i, 0, i, tab), 'key 期望为数字', vscode.DiagnosticSeverity.Information));
      }
      if (value.length === 0) {
        diags.push(new vscode.Diagnostic(new vscode.Range(i, tab + 1, i, tab + 1), '缺少值内容', vscode.DiagnosticSeverity.Hint));
      }
    }
    collection.set(doc.uri, diags);
  }

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(refresh));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => refresh(e.document)));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri)));

  for (const doc of vscode.workspace.textDocuments) { void refresh(doc); }

  // 注册新功能
  registerLstCodeLens(context);
  registerLstDocumentLink(context);
}
