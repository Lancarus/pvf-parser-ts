import * as vscode from 'vscode';
import * as path from 'path';
import { registerActLanguage } from './act/registerAct.js';
import { registerActFormatter } from './act/formatter';
import { registerAniLanguage } from './ani/registerAni.js';
import { registerAniFormatter } from './ani/formatter';
// register SKL language and formatter
import { registerSklLanguage } from './skl/registerSkl';
import { registerSklFormatter } from './skl/formatter';
import { registerLstLanguage } from './lst/registerLst';
import { registerStrLanguage } from './str/registerStr';
import { registerEquLanguage } from './equ/registerEqu';
import { registerEquFormatter } from './equ/formatter';
import { registerAiLanguage } from './ai/registerAi';
import { registerAicLanguage } from './aic/registerAic';
import { registerAiFormatter } from './ai/formatter';
import { registerAicFormatter } from './aic/formatter';
import { registerKeyLanguage } from './key/registerKey';
import { registerKeyFormatter } from './key/formatter';
import { registerScriptTagCommentEditor } from './tagCommentEditor';
import { registerGenericScriptTagLanguages } from './genericTags';
import { registerItemCodeHover } from './itemCodeHover';

interface PathLinkEntry { version: number; links: vscode.DocumentLink[] }
const pathLinkCache = new Map<string, PathLinkEntry>();
const PATH_LINK_LANGS = ['pvf-act','pvf-ani','pvf-skl','pvf-lst','pvf-str','pvf-equ','pvf-ai','pvf-aic','pvf-key','pvf-stk','pvf-shp','pvf-qst','pvf-etc','pvf-co','pvf-nut'];

function resolveBacktickPath(rawPath: string, docDir: string): vscode.Uri | undefined {
  if (rawPath.length < 3) return undefined;
  const low = rawPath.toLowerCase();
  if (!low.includes('/') && !low.includes('\\') && !/\.\w{1,6}$/.test(low)) return undefined;
  try {
    return low.endsWith('.img')
      ? vscode.Uri.file(path.resolve(docDir, rawPath.replace(/\.img$/i, '.npk')))
      : vscode.Uri.file(path.resolve(docDir, rawPath));
  } catch { return undefined; }
}

function scanDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
  const links: vscode.DocumentLink[] = [];
  const docDir = path.dirname(document.uri.fsPath);
  const lines = document.lineCount;
  const re = /`([^`]+)`/g;

  for (let i = 0; i < lines; i++) {
    const line = document.lineAt(i).text;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const target = resolveBacktickPath(m[1], docDir);
      if (!target) continue;
      links.push(new vscode.DocumentLink(
        new vscode.Range(i, m.index + 1, i, m.index + 1 + m[1].length),
        target,
      ));
    }
  }
  return links;
}

// ═══════════════════════════════════════════════════════════
// 通用 DocumentLink + Hover：所有 PVF 脚本文件中反引号路径可点击跳转
//   - DocumentLink：全量异步扫描，VS Code 约 1000 条渲染上限内行内可见
//   - Hover：任意位置悬停显示可点击的打开链接，弥补行内上限
// ═══════════════════════════════════════════════════════════
function registerPvfPathLinkProvider(context: vscode.ExtensionContext) {
  const selectors = PATH_LINK_LANGS.map(lang => ({ language: lang, scheme: 'file' } as vscode.DocumentFilter));

  // ─── DocumentLink provider（全量异步扫描） ───────────────
  const linkProvider: vscode.DocumentLinkProvider = {
    provideDocumentLinks(document) {
      const key = document.uri.toString();
      const cached = pathLinkCache.get(key);
      if (cached && cached.version === document.version) return cached.links;

      const links = scanDocumentLinks(document);
      pathLinkCache.set(key, { version: document.version, links });
      return links;
    },
  };

  // ─── Hover provider（任意位置悬停回退） ──────────────────
  const hoverProvider: vscode.HoverProvider = {
    provideHover(document, position) {
      const line = document.lineAt(position.line).text;
      // 找到当前行中最接近 position 的反引号路径
      const re = /`([^`]+)`/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const start = m.index + 1;
        const end = m.index + 1 + m[1].length;
        if (position.character >= start && position.character <= end) {
          const rawPath = m[1];
          const docDir = path.dirname(document.uri.fsPath);
          const target = resolveBacktickPath(rawPath, docDir);
          if (!target) return;
          const range = new vscode.Range(position.line, start - 1, position.line, end + 1);
          const cmdUri = vscode.Uri.parse(`command:vscode.open?${encodeURIComponent(JSON.stringify([target]))}`);
          const md = new vscode.MarkdownString(`[${target.fsPath}](${cmdUri})`, true);
          md.isTrusted = true;
          return new vscode.Hover(md, range);
        }
      }
    },
  };

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(selectors, linkProvider),
    vscode.languages.registerHoverProvider(selectors, hoverProvider),
    vscode.workspace.onDidCloseTextDocument(doc => {
      if (doc.uri.scheme === 'file') pathLinkCache.delete(doc.uri.toString());
    }),
  );
}

// 未来可扩展：扫描 scriptTags 下的定义动态生成补全与 hover。
export function registerScriptLanguages(context: vscode.ExtensionContext, model?: any) {
    registerScriptTagCommentEditor(context);
    registerGenericScriptTagLanguages(context);
    registerActLanguage(context);
    registerActFormatter(context);
    registerAniLanguage(context);
    registerAniFormatter(context);
    // register SKL language and formatter
    registerSklLanguage(context);
    registerSklFormatter(context);
    registerLstLanguage(context);
    registerStrLanguage(context);
    registerEquLanguage(context, model);
    registerEquFormatter(context);
    registerAiLanguage(context);
    registerAicLanguage(context);
    registerAiFormatter(context);
    registerAicFormatter(context);
    registerKeyLanguage(context);
    registerKeyFormatter(context);
    registerItemCodeHover(context);
    // 通用路径超链接（所有 pvf-* 语言）
    registerPvfPathLinkProvider(context);
}
