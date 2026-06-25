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

const PATH_LINK_LANGS = ['pvf-act','pvf-ani','pvf-skl','pvf-lst','pvf-str','pvf-equ','pvf-ai','pvf-aic','pvf-key','pvf-stk','pvf-shp','pvf-qst','pvf-etc','pvf-co','pvf-nut'];

function resolveBacktickPath(rawPath: string, docDir: string, scheme: string, pvfDir: string): vscode.Uri | undefined {
  if (rawPath.length < 3) return undefined;
  const low = rawPath.toLowerCase();
  if (!low.includes('/') && !low.includes('\\') && !/\.\w{1,6}$/.test(low)) return undefined;
  try {
    if (scheme === 'pvf') {
      const resolved = path.posix.join(pvfDir, rawPath).replace(/\\/g, '/');
      return vscode.Uri.parse('pvf:/' + resolved);
    }
    return low.endsWith('.img')
      ? vscode.Uri.file(path.resolve(docDir, rawPath.replace(/\.img$/i, '.npk')))
      : vscode.Uri.file(path.resolve(docDir, rawPath));
  } catch { return undefined; }
}

// ═══════════════════════════════════════════════════════════
// InlayHints — 反引号路径可点击打开
// provideInlayHints 的 range 参数即可见行范围，配合 scroll 事件强制刷新
// ═══════════════════════════════════════════════════════════
function registerPvfPathLens(context: vscode.ExtensionContext) {
  const selectors = PATH_LINK_LANGS.map(lang => ({ language: lang } as vscode.DocumentFilter));
  const re = /`([^`]+)`/g;
  const changeEmitter = new vscode.EventEmitter<void>();

  const provider: vscode.InlayHintsProvider = {
    onDidChangeInlayHints: changeEmitter.event,
    provideInlayHints(document, range) {
      const docDir = path.dirname(document.uri.fsPath);
      const scheme = document.uri.scheme;
      const pvfRaw = document.uri.path.replace(/^\//, '');
      const pvfDir = pvfRaw.includes('/') ? pvfRaw.substring(0, pvfRaw.lastIndexOf('/')) : '';
      const hints: vscode.InlayHint[] = [];
      for (let i = range.start.line; i <= range.end.line; i++) {
        const line = document.lineAt(i).text;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        const parts: vscode.InlayHintLabelPart[] = [];
        while ((m = re.exec(line)) !== null) {
          const target = resolveBacktickPath(m[1], docDir, scheme, pvfDir);
          if (!target) continue;
          const part = new vscode.InlayHintLabelPart(path.basename(target.fsPath || target.path));
          part.command = { command: 'vscode.open', arguments: [target], title: '打开文件' };
          parts.push(part);
        }
        if (parts.length > 0) {
          const hint = new vscode.InlayHint(
            new vscode.Position(i, line.length),
            parts,
            vscode.InlayHintKind.Parameter,
          );
          hint.paddingLeft = true;
          hints.push(hint);
        }
      }
      return hints;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(selectors, provider),
  );
  // 滚动时强制刷新 InlayHints
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorVisibleRanges(() => {
      changeEmitter.fire();
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
    // 通用路径超链接（所有 pvf-* 语言）— 使用 InlayHints，VS Code 自动按可见行渲染
    registerPvfPathLens(context);
}
