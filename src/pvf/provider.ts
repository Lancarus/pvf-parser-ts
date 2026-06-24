import * as vscode from 'vscode';
import { PvfModel, PvfFileEntry } from './model';
import { getIconForFile } from './fileIcons';
import { getFileCategory } from './fileCategoryService';
import { PvfTreeCommentService } from './treeComments';
import * as path from 'path';

export class PvfProvider implements vscode.TreeDataProvider<PvfFileEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PvfFileEntry | undefined | void>();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _metadataRequested = new Set<string>();

  constructor(private model: PvfModel, private output?: vscode.OutputChannel, private treeComments?: PvfTreeCommentService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PvfFileEntry): vscode.TreeItem {
    const comment = this.treeComments?.getComment(element.key);
    const commentDescription = comment ? `(${comment})` : undefined;
    const item = new vscode.TreeItem(element.name,
      element.isFile ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    item.contextValue = element.isFile ? 'pvf.file' : 'pvf.folder';
    item.resourceUri = vscode.Uri.parse(`pvf:/${element.key}`);
    const tooltip = this.treeComments?.getTooltip(element);
    if (tooltip) item.tooltip = tooltip;
    if (element.isFile) {
      const cat = getFileCategory(element.name);
      // 优先使用 metadata 生成的 NPK 图标
      try {
        const store: Map<string, any> | undefined = (this.model as any)._fileIconMeta;
        const rec = store ? store.get(element.key) : undefined;
        if (rec && rec.pngPath) {
          const pngUri = vscode.Uri.file(rec.pngPath);
          item.iconPath = { light: pngUri, dark: pngUri };
        }
      } catch { /* ignore */ }
      if (!item.iconPath) {
        // 无 NPK 图标时使用扩展预设图标
        try {
          const icon = getIconForFile(element.name);
          if (icon) {
            const me = vscode.extensions.getExtension('local.pvf-parser-ts');
            const base = me?.extensionPath;
            if (base) {
              const iconFile = path.join(base, 'media', 'icons', icon);
              const uri = vscode.Uri.file(iconFile);
              item.iconPath = { light: uri, dark: uri };
            }
          }
        } catch { /* ignore */ }
      }
      // 描述：物品名 + 代码（不显示中文类别标签，注释体系已完善）
      const cfg = vscode.workspace.getConfiguration();
      const showName = cfg.get<boolean>('pvf.showScriptDisplayName', true);
      const showCode = cfg.get<boolean>('pvf.showScriptCode', true);
      const parts: string[] = [];
      if (showName) {
        const disp = (this.model as any).getDisplayNameForFile ? (this.model as any).getDisplayNameForFile(element.key) : undefined;
        if (disp) parts.push(disp);
      }
      if (showCode) {
        const code = (this.model as any).getCodeForFile ? (this.model as any).getCodeForFile(element.key) : -1;
        if (code !== -1) parts.push(`<${code}>`);
      }
      if (commentDescription) parts.push(commentDescription);
      if (parts.length) item.description = parts.join(' ');
    } else if (commentDescription) {
      item.description = commentDescription;
    }
    if (element.isFile) item.command = { command: 'pvf.openFile', title: '打开', arguments: [element] };
    return item;
  }

  getChildren(element?: PvfFileEntry): Thenable<PvfFileEntry[]> {
    const label = element ? `children:${element.key}` : 'children:<root>';
    const start = Date.now();
    const result = !element ? this.model.getChildren() : (!element.isFile ? this.model.getChildren(element.key) : []);
    const ms = Date.now() - start;
    this.output?.appendLine(`[PVF] get${label} -> ${Array.isArray(result) ? result.length : 0} items in ${ms}ms`);
    if (result.length) {
      const fileKeys = result.filter(r=>r.isFile).map(r=>r.key).filter(k=>!this._metadataRequested.has(k));
      if (fileKeys.length) {
        fileKeys.forEach(k=>this._metadataRequested.add(k));
        this.model.ensureMetadataForFiles(fileKeys).then(()=>{
          this._onDidChangeTreeData.fire();
        }).catch(()=>{});
      }
    }
    return Promise.resolve(result);
  }
}
