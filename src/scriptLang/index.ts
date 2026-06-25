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

// 版本缓存：key = document.uri.toString(), value = { version, links }
const pathLinkCache = new Map<string, { version: number; links: vscode.DocumentLink[] }>();
const PATH_LINK_LANGS = ['pvf-act','pvf-ani','pvf-skl','pvf-lst','pvf-str','pvf-equ','pvf-ai','pvf-aic','pvf-key','pvf-stk','pvf-shp','pvf-qst','pvf-etc','pvf-co','pvf-nut'];

// ═══════════════════════════════════════════════════════════
// 通用 DocumentLink：所有 PVF 脚本文件中反引号路径可点击跳转
// ═══════════════════════════════════════════════════════════
function registerPvfPathLinkProvider(context: vscode.ExtensionContext) {
  const selectors = PATH_LINK_LANGS.map(lang => ({ language: lang, scheme: 'file' } as vscode.DocumentFilter));

  const provider: vscode.DocumentLinkProvider = {
    provideDocumentLinks(document) {
      const key = document.uri.toString();
      const cached = pathLinkCache.get(key);
      if (cached && cached.version === document.version) return cached.links;

      const links: vscode.DocumentLink[] = [];
      const docDir = path.dirname(document.uri.fsPath);
      const lines = document.lineCount;
      const re = /`([^`]+)`/g;

      for (let i = 0; i < lines; i++) {
        const line = document.lineAt(i).text;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const rawPath = m[1];
          if (rawPath.length < 3) continue;
          const low = rawPath.toLowerCase();
          if (!low.includes('/') && !low.includes('\\') && !/\.\w{1,6}$/.test(low)) continue;
          const target = low.endsWith('.img')
            ? vscode.Uri.file(path.resolve(docDir, rawPath.replace(/\.img$/i, '.npk')))
            : vscode.Uri.file(path.resolve(docDir, rawPath));
          const range = new vscode.Range(i, m.index + 1, i, m.index + 1 + rawPath.length);
          links.push(new vscode.DocumentLink(range, target));
        }
      }

      pathLinkCache.set(key, { version: document.version, links });
      return links;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(selectors, provider),
    // 关闭文档时清理缓存
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
