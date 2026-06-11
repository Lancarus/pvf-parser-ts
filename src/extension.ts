import * as vscode from 'vscode';
import { PvfModel, PvfFileEntry } from './pvf/model';
import { parseMetadataForKeys } from './pvf/metadata';
import { PvfProvider } from './pvf/provider';
import { registerDiskTreeCommentDecorations } from './pvf/diskTreeCommentDecorations';
import { PvfTreeCommentService } from './pvf/treeComments';
import { UnpackExplorerWebviewProvider } from './pvf/unpackExplorerWebview';
import { UnpackMetadataService } from './pvf/unpackMetadata';
import { readConfiguredNpkRoots } from './pvf/unpackEnv';
import { registerPathLinkProvider } from './pvf/pathLinkProvider';
import { registerPvfDecorations } from './pvf/decorations';
import { registerAllCommands } from './commander/index.js';
import { registerScriptLanguages } from './scriptLang/index';
import * as indexer from './npk/indexer';
import * as fs from 'fs/promises';
import * as path from 'path';
import { registerSearchInPack } from './pvf/searchQuickOpen';
import { setPvfModel } from './pvf/runtimeModel';
import getPvfContent, { getIconBase64ByCode , getNameByCodeAndLst , parsePvfScriptToJson} from './pvf/services/getPvfContent';
import getIconFrameBase64 from './pvf/services/getIconFrame';
import { registerStringTableCodeLens } from './pvf/services/stringTableCodeLens';
import { registerPvfWebApiServer } from './pvf/webApi/server';
import { scriptTagLanguageIdForPath } from './scriptLang/genericTags';
import {
    BookmarkEntry,
    BookmarkProvider,
    bookmarkLabelFromTarget,
    bookmarkPathFromPvfTarget,
    bookmarkPathFromTarget,
    bookmarkPathFromUnpackTarget,
    findBookmarkInUnpackRoots,
} from './pvf/bookmarkProvider';

async function ensureNativeWhitespaceColor(output: vscode.OutputChannel) {
    try {
        const cfg = vscode.workspace.getConfiguration('workbench');
        const customizations = cfg.get<Record<string, unknown>>('colorCustomizations', {});
        if (customizations['editorWhitespace.foreground']) return;
        await cfg.update('colorCustomizations', {
            ...customizations,
            'editorWhitespace.foreground': '#7c8794',
        }, vscode.ConfigurationTarget.Global);
    } catch (err) {
        output.appendLine(`[PVF] failed to update native whitespace color: ${String(err)}`);
    }
}

async function applyPvfLanguageAndVisibleTabs(editor: vscode.TextEditor | undefined, output: vscode.OutputChannel) {
    if (!editor) return;
    const doc = editor.document;
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'pvf') return;
    const languageId = scriptTagLanguageIdForPath(doc.uri.fsPath || doc.fileName);
    if (!languageId && !doc.languageId.startsWith('pvf-')) return;

    if (languageId && doc.languageId !== languageId) {
        try {
            await vscode.languages.setTextDocumentLanguage(doc, languageId);
        } catch (err) {
            output.appendLine(`[PVF] failed to set language ${languageId} for ${doc.uri.toString()}: ${String(err)}`);
            return;
        }
    }

    const options = editor.options;
    const patch: vscode.TextEditorOptions = {};
    if (options.tabSize !== 4) patch.tabSize = 4;
    if (options.insertSpaces !== false) patch.insertSpaces = false;
    if (Object.keys(patch).length > 0) {
        editor.options = { ...options, ...patch };
    }
}

function registerPvfDiskFileLanguageActivation(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
    const applyVisibleEditors = () => {
        for (const editor of vscode.window.visibleTextEditors) {
            void applyPvfLanguageAndVisibleTabs(editor, output);
        }
    };
    applyVisibleEditors();
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            void applyPvfLanguageAndVisibleTabs(editor, output);
        }),
        vscode.window.onDidChangeVisibleTextEditors(() => applyVisibleEditors()),
        vscode.workspace.onDidOpenTextDocument(doc => {
            const editor = vscode.window.visibleTextEditors.find(item => item.document === doc);
            if (editor) void applyPvfLanguageAndVisibleTabs(editor, output);
        }),
    );
}

export function activate(context: vscode.ExtensionContext) {
    const model = new PvfModel();
    setPvfModel(model);
    // 供 metadata.ts 生成图标时访问上下文 (globalStorage)
    (model as any)._extCtx = context;
    const output = vscode.window.createOutputChannel('PVF');
    const treeComments = new PvfTreeCommentService(context, model, output);
    const tree = new PvfProvider(model, output, treeComments);
    const unpackMetadata = new UnpackMetadataService(context, output);
    const unpackTree = new UnpackExplorerWebviewProvider(context, treeComments, output, unpackMetadata);
    const bookmarkTree = new BookmarkProvider(context, output);
    const deco = registerPvfDecorations(context, model);
    const diskTreeCommentDeco = registerDiskTreeCommentDecorations(context, treeComments, output);
    void treeComments.load().then(() => {
        tree.refresh();
        unpackTree.refresh();
        diskTreeCommentDeco.refreshAll();
    });
    void ensureNativeWhitespaceColor(output);
    registerPvfDiskFileLanguageActivation(context, output);
    // 图标逻辑：在 provider 中通过 vscode.extensions.getExtension 查找当前扩展根路径，从 media/icons 读取 png
    // 若需要在运行时修改映射，可暴露命令以动态刷新（后续可扩展）

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('pvfExplorerView', tree),
        vscode.window.registerWebviewViewProvider('pvfUnpackExplorerView', unpackTree, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.createTreeView('pvfBookmarkView', {
            treeDataProvider: bookmarkTree,
            dragAndDropController: bookmarkTree,
            canSelectMany: true,
        }),
    );
    // register document link provider for .lst/.nut and other path-like tokens
    registerPathLinkProvider(context, model);

    // Register all commands from commander modules
    registerAllCommands(context, { model, tree, deco: deco as any, output });
    registerPvfWebApiServer({ context, extensionVersion: context.extension.packageJSON?.version || '0.0.0', output });
    // 注册快速搜索（模糊/多关键字）
    registerSearchInPack(context, model);

    // 激活时自动构建（若尚未有索引且配置了根目录）
    (async () => {
        const cfg = vscode.workspace.getConfiguration();
        const legacyRoot = (cfg.get<string>('pvf.npkRoot') || '').trim();
        const envRoots = await readConfiguredNpkRoots(context);
        const roots = Array.from(new Set([...envRoots, ...(legacyRoot ? [legacyRoot] : [])].map(item => path.resolve(item))));
        const m = await indexer.loadIndexFromDisk(context);
        if ((!m || m.size === 0) && roots.length > 0) {
            void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在构建 NPK 索引…' }, async (p) => {
                let lastReport = 0;
                const map = await indexer.buildIndex(context, roots, (done, total, file) => {
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                    if (pct !== lastReport) {
                        const delta = pct - lastReport;
                        lastReport = pct;
                        p.report({ increment: delta, message: `${done}/${total} ${file ? file.split(/[\\/]/).pop() : ''}` });
                    }
                });
                p.report({ increment: 100, message: `已索引 ${map.size} 项` });
                unpackTree.refresh();
                diskTreeCommentDeco.refreshAll();
                return map;
            });
        } else if (roots.length === 0) {
            output.appendLine('[PVF] 未设置 NPK 根目录 (pvf.npkRoot 或 .env NPK_DIR)，跳过自动构建索引。');
        }
    })();

    // register command to rebuild index explicitly
    context.subscriptions.push(vscode.commands.registerCommand('pvf.rebuildNpkIndex', async () => {
        const cfg = vscode.workspace.getConfiguration();
        const legacyRoot = (cfg.get<string>('pvf.npkRoot') || '').trim();
        const envRoots = await readConfiguredNpkRoots(context);
        const roots = Array.from(new Set([...envRoots, ...(legacyRoot ? [legacyRoot] : [])].map(item => path.resolve(item))));
        if (roots.length === 0) {
            vscode.window.showWarningMessage('请先在设置 pvf.npkRoot 或 .env NPK_DIR 指定 ImagePacks 根目录');
            return;
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在重建 NPK 索引…' }, async (p) => {
            let lastReport = 0;
            const m = await indexer.buildIndex(context, roots, (done, total, file) => {
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                if (pct !== lastReport) {
                    const delta = pct - lastReport;
                    lastReport = pct;
                    p.report({ increment: delta, message: `${done}/${total} ${file ? file.split(/[\\/]/).pop() : ''}` });
                }
            });
            p.report({ increment: 100, message: `已索引 ${m.size} 项` });
            unpackTree.refresh();
            diskTreeCommentDeco.refreshAll();
        });
        vscode.window.showInformationMessage('NPK 索引已重建');
    }));

    // 插件设置入口：在视图标题“插件设置”按钮调用，聚焦 pvf.* 设置
    context.subscriptions.push(vscode.commands.registerCommand('pvf.openSettings', async () => {
        try {
            // 使用扩展标识过滤自身设置；支持再附加 pvf. 前缀便于集中显示
            await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.pvf-parser-ts pvf.');
        } catch {
            try { await vscode.commands.executeCommand('workbench.action.openSettings', 'pvf.'); } catch {}
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.editTreeComment', async (target?: PvfFileEntry | vscode.Uri | { key?: string; name?: string; isFile?: boolean; version?: string; uri?: string }) => {
        let key = '';
        let version = treeComments.currentVersionKey();
        let refreshUri: vscode.Uri | undefined;

        if (target instanceof vscode.Uri) {
            const diskTarget = await diskTreeCommentDeco.targetFromUri(target);
            if (diskTarget) {
                key = diskTarget.key;
                version = diskTarget.version;
                refreshUri = target;
            }
        } else if (target && typeof target === 'object' && typeof target.key === 'string') {
            const record = target as Record<string, unknown>;
            key = target.key;
            version = typeof record.version === 'string' ? record.version : version;
            if (typeof record.uri === 'string') {
                try { refreshUri = vscode.Uri.parse(record.uri); } catch {}
            }
        }

        if (!key) {
            vscode.window.showWarningMessage('请在 PVF 资源树中选择路径，或在包含 .pvfmanifest.json 的解包目录中选择文件/文件夹。');
            return;
        }
        const current = treeComments.getCommentForVersion(key, version) || '';
        const value = await vscode.window.showInputBox({
            title: '编辑资源树注释',
            prompt: `路径: ${key}    PVF 版本: ${version}。保存后会写入内置路径注释文件；留空会删除当前版本覆盖项。`,
            placeHolder: '例如: 装备',
            value: current,
            ignoreFocusOut: true,
        });
        if (value === undefined) return;
        try {
            await treeComments.setCommentForVersion(key, value, version);
            tree.refresh();
            unpackTree.refresh();
            if (refreshUri) diskTreeCommentDeco.refreshUri(refreshUri);
            else diskTreeCommentDeco.refreshAll();
            vscode.window.showInformationMessage(value.trim() ? '已保存资源树注释' : '已删除当前版本路径注释覆盖项');
        } catch (err: any) {
            const message = String(err && err.message || err);
            output.appendLine(`[PVF] failed to save tree comment: ${message}`);
            vscode.window.showErrorMessage(message);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.refreshUnpackExplorer', () => {
        unpackTree.refresh();
        diskTreeCommentDeco.refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.copyUnpackPath', async (target?: { fsPath?: string; key?: string }) => {
        const text = typeof target?.fsPath === 'string'
            ? target.fsPath
            : (typeof target?.key === 'string' ? target.key : '');
        if (!text) return;
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage('已复制路径到剪贴板');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.refreshBookmarks', () => {
        void bookmarkTree.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.createBookmarkFolder', async (target?: BookmarkEntry) => {
        const parent = target && !target.key ? target : undefined;
        await bookmarkTree.createFolder(parent);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.deleteBookmark', async (target?: BookmarkEntry) => {
        if (!target) return;
        await bookmarkTree.deleteEntry(target);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.renameBookmark', async (target?: BookmarkEntry) => {
        if (!target) return;
        await bookmarkTree.renameEntry(target);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.resetBookmarks', async () => {
        const ok = await vscode.window.showWarningMessage('重置书签为插件内置默认内容？当前自定义书签会被覆盖。', { modal: true }, '重置');
        if (ok !== '重置') return;
        await bookmarkTree.resetToBuiltIn();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.addPvfToBookmarks', async (target?: PvfFileEntry) => {
        const key = bookmarkPathFromPvfTarget(target);
        if (!key) {
            vscode.window.showWarningMessage('无法添加书签：缺少 PVF 路径。');
            return;
        }
        if (target && !target.isFile) {
            const parent = await bookmarkTree.pickFolder(key);
            if (parent === false) return;
            await bookmarkTree.createFolder(parent, bookmarkLabelFromTarget(target));
            return;
        }
        await bookmarkTree.addBookmarkInteractive({ key, label: bookmarkLabelFromTarget(target) });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.addUnpackToBookmarks', async (target?: { key?: string; name?: string; isDirectory?: boolean }) => {
        const key = bookmarkPathFromUnpackTarget(target);
        if (!key) {
            vscode.window.showWarningMessage('无法添加书签：缺少 PVF 路径。');
            return;
        }
        if (target?.isDirectory) {
            const parent = await bookmarkTree.pickFolder(key);
            if (parent === false) return;
            await bookmarkTree.createFolder(parent, bookmarkLabelFromTarget(target));
            return;
        }
        await bookmarkTree.addBookmarkInteractive({ key, label: bookmarkLabelFromTarget(target) });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.copyBookmarkPath', async (target?: unknown) => {
        const key = bookmarkPathFromTarget(target);
        if (!key) return;
        await vscode.env.clipboard.writeText(key);
        vscode.window.showInformationMessage('已复制书签路径到剪贴板');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.openBookmarkOnDisk', async (target?: unknown) => {
        const key = bookmarkPathFromTarget(target);
        if (!key) return;
        const uri = await findBookmarkInUnpackRoots(context, key);
        if (!uri) {
            vscode.window.showWarningMessage(`解包目录中未找到书签文件: ${key}`);
            return;
        }
        await vscode.commands.executeCommand('vscode.open', uri);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.openBookmarkInPack', async (target?: unknown) => {
        const key = bookmarkPathFromTarget(target);
        if (!key) return;
        await vscode.commands.executeCommand('pvf.openFuzzyPath', key);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pvf.openBookmark', async (target?: unknown) => {
        const key = bookmarkPathFromTarget(target);
        if (!key) return;
        const uri = await findBookmarkInUnpackRoots(context, key);
        if (uri) {
            await vscode.commands.executeCommand('vscode.open', uri);
            return;
        }
        await vscode.commands.executeCommand('pvf.openFuzzyPath', key);
    }));

    // diagnostic command: show index status and storage path
    context.subscriptions.push(vscode.commands.registerCommand('pvf.showNpkIndexStatus', async () => {
        const storagePath = context.globalStorageUri.fsPath;
        const indexFile = path.join(storagePath, 'npk-index.sqlite');
        let exists = false;
        let size = 0;
        try { const st = await fs.stat(indexFile); exists = true; size = st.size; } catch { exists = false; }
        let idx = indexer.getIndex();
        if (!idx) {
            try { idx = await indexer.loadIndexFromDisk(context); } catch { idx = null; }
        }
        const entries = idx ? idx.size : 0;
        const msg = `globalStorage: ${storagePath}\nindex db: ${indexFile}\nfile exists: ${exists}\nfile size: ${size}\nin-memory entries: ${entries}`;
        vscode.window.showInformationMessage('已在输出面板写入索引信息');
        const out = vscode.window.createOutputChannel('PVF');
        out.show(true);
        out.appendLine(msg);
    }));


    context.subscriptions.push(
        // Provide editable virtual FS for pvf: scheme
        vscode.workspace.registerFileSystemProvider('pvf', new (class implements vscode.FileSystemProvider {
            private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
            onDidChangeFile = this._emitter.event;
            watch(): vscode.Disposable { return new vscode.Disposable(() => { }); }
            stat(uri: vscode.Uri): vscode.FileStat {
                const key = uri.path.replace(/^\//, '');
                return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: model.getTextSize(key) };
            }
            readDirectory(): [string, vscode.FileType][] { return []; }
            createDirectory(): void { /* no-op */ }
            async readFile(uri: vscode.Uri): Promise<Uint8Array> {
                const key = uri.path.replace(/^\//, '');
                return await model.readFileBytes(key);
            }
            async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
                const key = uri.path.replace(/^\//, '');
                model.updateFileData(key, content);
                this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
                deco.refreshUris([uri]);
                // 异步重新解析 [name]/[icon]，以及 .lst 代码映射
                (async () => {
                    try {
                        // 清除元数据扫描缓存，确保重新解析
                        try { (model as any)._metadataScannedFiles?.delete(key); } catch {}
                        // 清除已生成的图标缓存，下次生成使用新内容
                        try { (model as any)._fileIconMeta?.delete(key); } catch {}
                        // 清除旧显示名（若内容改动删除了 [name]）
                        try { (model as any).fileDisplayNameMap?.delete(key); } catch {}
                        await parseMetadataForKeys(model, [key]);
                    } catch {}
                    try {
                        if (key.toLowerCase().endsWith('.lst')) {
                            // 重建 lst 索引（私有方法反射调用）
                            const anyModel: any = model as any;
                            if (typeof anyModel.buildListFileIndices === 'function') {
                                await anyModel.buildListFileIndices();
                            }
                        }
                    } catch {}
                    // 刷新树以更新描述和动态图标
                    try { tree.refresh(); } catch {}
                })();
            }
            delete(): void { /* implement if needed */ }
            rename(): void { /* implement if needed */ }
        })(), { isCaseSensitive: true, isReadonly: false }),
    );

    // 注册脚本语言特性 (.act 等)
    registerScriptLanguages(context, model);

    // 注册 stringtable.bin CodeLens （按需构建字符串引用索引）
    registerStringTableCodeLens(context, model);

    // AIC Editor (APC 预览编辑) 命令
    context.subscriptions.push(vscode.commands.registerCommand('pvf.openAicEditor', async (target?: vscode.Uri | { fsPath?: string }) => {
        let doc: vscode.TextDocument | undefined;
        if (target instanceof vscode.Uri) {
            doc = await vscode.workspace.openTextDocument(target);
        } else if (target && typeof target.fsPath === 'string') {
            doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target.fsPath));
        } else {
            doc = vscode.window.activeTextEditor?.document;
        }
        if (!doc) { vscode.window.showWarningMessage('没有活动的编辑器'); return; }
        if (!/\.aic$/i.test(doc.fileName)) { vscode.window.showWarningMessage('请在一个 .aic 文件中使用该命令'); return; }
        // 显示源文档在第一列
        try { await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true }); } catch {}
        const panel = vscode.window.createWebviewPanel('pvfAicEditor', `APC: ${doc.fileName.split(/[\\/]/).pop()}`, vscode.ViewColumn.Two, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [context.extensionUri]
        });
        try { panel.reveal(vscode.ViewColumn.Two, false); } catch {}
        const nonce = (() => { let t=''; const s='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; for(let i=0;i<32;i++){ t+=s.charAt(Math.floor(Math.random()*s.length)); } return t; })();
        const clientJsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media','webview','apcEditor.js')).toString();
        const init = { path: doc.fileName, text: doc.getText(), version: String(doc.version) };
        const initJson = JSON.stringify(init).replace(/</g,'\\u003C');
        panel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" />\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; img-src ${panel.webview.cspSource} data:; font-src ${panel.webview.cspSource}; script-src ${panel.webview.cspSource} 'nonce-${nonce}';" />\n<title>APC 编辑器</title>\n<style>html,body,#root{height:100%;margin:0;padding:0;}</style></head><body><div id="root"></div>\n<script nonce="${nonce}">window.__INIT=${initJson};</script>\n<script src="${clientJsUri}" nonce="${nonce}"></script></body></html>`;
        // 文档变更同步
        const changeSub = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === doc.uri.toString()) {
                panel.webview.postMessage({ type: 'docUpdate', text: e.document.getText() });
            }
        });
        panel.onDidDispose(() => changeSub.dispose());
        // === 通用 RPC Handler 映射（只在此处集中定义，与 UI 逻辑解耦） ===
        const rpcHandlers: Record<string, (...a: any[]) => any | Promise<any>> = {
            async getPvfContent(path: string) { return await getPvfContent(path); },
            async getPvfJson(path: string) { return await parsePvfScriptToJson(path); },
            async getIconFrame(path: string, frameIndex: number) { return await getIconFrameBase64(path, frameIndex); },
            // webview 端调用顺序为 (lstPath, code)
            async getNameByCodeAndLst(lstPath: string, code: number) { return await getNameByCodeAndLst(lstPath, code); },
            async getIconBase64ByCode(lstPath: string, code: number) { return await getIconBase64ByCode(lstPath, code); }
            // 后续新增方法仅需在此添加，无需再扩展 switch / case
        };

        panel.webview.onDidReceiveMessage(async msg => {
            if (!msg || typeof msg !== 'object') return;
            // 兼容旧消息 & 通用 RPC
            if (msg.type === 'requestInit') {
                panel.webview.postMessage({ type: 'init', data: init });
                return;
            }
            if (msg.type === 'applyEdit') {
                if (typeof msg.text === 'string') {
                    const edit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
                    edit.replace(doc.uri, fullRange, msg.text);
                    vscode.workspace.applyEdit(edit).then(ok => {
                        if (ok) vscode.window.showInformationMessage('已写回文档'); else vscode.window.showWarningMessage('写回失败');
                    });
                }
                return;
            }
            if (msg.type === 'rpc' && msg.id && typeof msg.method === 'string') {
                const { id, method, params = [] } = msg as { id: string; method: string; params: any[] };
                const fn = rpcHandlers[method];
                if (!fn) {
                    panel.webview.postMessage({ type: 'rpcResult', id, ok: false, error: `No such method: ${method}` });
                    return;
                }
                try {
                    const result = await Promise.resolve(fn(...params));
                    panel.webview.postMessage({ type: 'rpcResult', id, ok: true, result });
                } catch (err: any) {
                    panel.webview.postMessage({ type: 'rpcResult', id, ok: false, error: String(err && err.message || err) });
                }
                return;
            }
        });
    }));

    // 启动时可选择自动关闭被 VS Code session 恢复的 pvf: 虚拟编辑器标签
    try {
        const cfg = vscode.workspace.getConfiguration();
        const autoClose = cfg.get<boolean>('pvf.closeVirtualEditorsOnStartup', true);
        if (autoClose) {
            // 延迟一点点等 VS Code 恢复完成
            setTimeout(async () => {
                try {
                    const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.scheme === 'pvf');
                    for (const ed of editors) {
                        try { await vscode.window.showTextDocument(ed.document, { preview: true, preserveFocus: true }); } catch {}
                        // 使用内置命令关闭活动编辑器
                        try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
                    }
                } catch {}
            }, 800);
        }
    } catch {}

    // 首次激活或尚未提示时，提示用户可调整编码设置
    (async () => {
        const shownKey = 'pvf.encodingHintShown';
        const already = context.globalState.get<boolean>(shownKey, false);
        const cfg = vscode.workspace.getConfiguration();
        const autoShow = cfg.get<boolean>('pvf.encoding.showHintOnStartup', true); // 预留未来可扩展（当前未在 package.json 暴露）
        if (!already && autoShow) {
            const actionOpen = '打开设置';
            const actionNever = '不再提示';
            const pick = await vscode.window.showInformationMessage('如果打开 PVF / 脚本文件出现乱码，可在设置中调整PVF编码格式(TW/CN/KR)。', actionOpen, actionNever);
            if (pick === actionOpen) {
                try { await vscode.commands.executeCommand('workbench.action.openSettings', 'pvf.encodingMode'); } catch {}
            } else if (pick === actionNever) {
                try { await context.globalState.update(shownKey, true); } catch {}
            }
        }
    })();


}

export function deactivate() { }



