import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PVF_MANIFEST_FILE, PvfDirectoryManifest } from './directoryArchive';
import { normalizeTreeCommentPath, normalizeTreeCommentVersion, PvfTreeCommentService } from './treeComments';
import { readConfiguredUnpackRoots } from './unpackEnv';
import {
  UnpackMetadataService,
  UnpackResolvedMetadata,
  normalizeUnpackKey,
  rarityLabel,
  shouldResolveUnpackMetadataKey,
} from './unpackMetadata';

export interface UnpackExplorerEntry {
  fsPath: string;
  key: string;
  name: string;
  isDirectory: boolean;
  root: string;
  version: string;
}

interface UnpackExplorerRow {
  id: string;
  name: string;
  key: string;
  fsPath: string;
  isDirectory: boolean;
  contextValue: string;
  comment?: string;
  itemName?: string;
  itemCode?: number;
  itemCodeText?: string;
  rarity?: number;
  grade?: string;
  rarityLabel?: string;
  icon?: {
    src: string;
    displayWidth: number;
    displayHeight: number;
    isQuestTag: boolean;
  };
  tooltip: string;
}

async function readManifest(file: string): Promise<PvfDirectoryManifest | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as PvfDirectoryManifest;
  } catch {
    return undefined;
  }
}

function nonce(): string {
  let value = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) value += chars.charAt(Math.floor(Math.random() * chars.length));
  return value;
}

function stableId(element: UnpackExplorerEntry): string {
  const raw = `${path.resolve(element.root)}\0${normalizeUnpackKey(element.key)}\0${element.version}`;
  return Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function configBool(primary: string, fallback: boolean): boolean {
  const value = vscode.workspace.getConfiguration().get<boolean>(primary);
  return typeof value === 'boolean' ? value : fallback;
}

function configNumber(primary: string, fallback: number): number {
  const raw = vscode.workspace.getConfiguration().get<number>(primary);
  return Number.isFinite(raw) ? Math.max(16, Math.min(64, Math.floor(raw as number))) : fallback;
}

function codeTextFor(code: number | undefined): string | undefined {
  if (typeof code !== 'number') return undefined;
  const format = vscode.workspace.getConfiguration().get<string>('pvf.unpackExplorer.metadata.itemCodeFormat', '<{code}>') || '<{code}>';
  return format.replace(/\{code\}/g, String(code));
}

export class UnpackExplorerWebviewProvider implements vscode.WebviewViewProvider {
  private webviewView: vscode.WebviewView | undefined;
  private rootsCache: Promise<UnpackExplorerEntry[]> | undefined;
  private readonly metadata: UnpackMetadataService;
  private readonly entriesById = new Map<string, UnpackExplorerEntry>();
  private readonly metadataQueue: UnpackExplorerEntry[] = [];
  private readonly metadataQueued = new Set<string>();
  private readonly iconQueue: UnpackExplorerEntry[] = [];
  private readonly iconQueued = new Set<string>();
  private readonly pendingRows = new Map<string, UnpackExplorerEntry>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private activeMetadataTasks = 0;
  private activeIconTasks = 0;
  private generation = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly comments: PvfTreeCommentService,
    private readonly output?: vscode.OutputChannel,
    metadata?: UnpackMetadataService,
  ) {
    this.metadata = metadata || new UnpackMetadataService(context, output);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri,
        this.context.globalStorageUri,
        vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview'),
      ],
    };
    webviewView.webview.html = this.htmlFor(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(message => {
      void this.handleMessage(message);
    });
    void this.postRoots();
  }

  refresh(): void {
    this.generation++;
    this.rootsCache = undefined;
    this.metadata.clear();
    this.entriesById.clear();
    this.metadataQueue.length = 0;
    this.iconQueue.length = 0;
    this.metadataQueued.clear();
    this.iconQueued.clear();
    this.pendingRows.clear();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.activeMetadataTasks = 0;
    this.activeIconTasks = 0;
    void this.postRoots();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const record = message as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';
    if (type === 'ready') {
      await this.postRoots();
      return;
    }
    const id = typeof record.id === 'string' ? record.id : '';
    const element = id ? this.entriesById.get(id) : undefined;
    if (type === 'children') {
      if (element?.isDirectory) await this.postChildren(element);
      return;
    }
    if (!element) return;
    if (type === 'open') {
      if (!element.isDirectory) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(element.fsPath));
      return;
    }
    if (type === 'copy') {
      await vscode.commands.executeCommand('pvf.copyUnpackPath', element);
      return;
    }
    if (type === 'editComment') {
      await vscode.commands.executeCommand('pvf.editTreeComment', this.commandTarget(element));
      return;
    }
    if (type === 'bookmark') {
      await vscode.commands.executeCommand('pvf.addUnpackToBookmarks', element);
      return;
    }
    if (type === 'previewAni') {
      await vscode.commands.executeCommand('pvf.previewAni', vscode.Uri.file(element.fsPath));
      return;
    }
    if (type === 'openAniEditor') {
      await vscode.commands.executeCommand('pvf.openAniEditor', vscode.Uri.file(element.fsPath));
      return;
    }
    if (type === 'openAicEditor') {
      await vscode.commands.executeCommand('pvf.openAicEditor', vscode.Uri.file(element.fsPath));
    }
  }

  private commandTarget(element: UnpackExplorerEntry): { key: string; name: string; isFile: boolean; version: string; uri: string } {
    return {
      key: element.key,
      name: element.name,
      isFile: !element.isDirectory,
      version: element.version,
      uri: vscode.Uri.file(element.fsPath).toString(),
    };
  }

  private async postRoots(): Promise<void> {
    const view = this.webviewView;
    if (!view) return;
    const generation = this.generation;
    let roots: UnpackExplorerEntry[] = [];
    try {
      roots = await this.getRoots();
    } catch (err: any) {
      this.output?.appendLine(`[PVF] failed to read unpack roots: ${String(err && err.message || err)}`);
    }
    if (!this.webviewView || generation !== this.generation) return;
    for (const root of roots) this.entriesById.set(stableId(root), root);
    await view.webview.postMessage({
      type: 'roots',
      rows: roots.map(root => this.rowFor(root)),
      empty: roots.length === 0,
    });
  }

  private async postChildren(parent: UnpackExplorerEntry): Promise<void> {
    const view = this.webviewView;
    if (!view) return;
    const generation = this.generation;
    let rows: UnpackExplorerEntry[] = [];
    try {
      rows = await this.getChildren(parent);
    } catch (err: any) {
      this.output?.appendLine(`[PVF] failed to read unpack dir ${parent.fsPath}: ${String(err && err.message || err)}`);
    }
    if (!this.webviewView || generation !== this.generation) return;
    for (const row of rows) this.entriesById.set(stableId(row), row);
    await view.webview.postMessage({
      type: 'children',
      id: stableId(parent),
      rows: rows.map(row => this.rowFor(row)),
    });
  }

  private async getRoots(): Promise<UnpackExplorerEntry[]> {
    if (!this.rootsCache) this.rootsCache = this.loadRoots();
    return this.rootsCache;
  }

  private async loadRoots(): Promise<UnpackExplorerEntry[]> {
    const roots = await readConfiguredUnpackRoots(this.context);
    const entries: UnpackExplorerEntry[] = [];
    for (const root of roots) {
      try {
        const stat = await fs.stat(root);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      const manifest = await readManifest(path.join(root, PVF_MANIFEST_FILE));
      entries.push({
        fsPath: root,
        key: '',
        name: path.basename(path.resolve(root)) || root,
        isDirectory: true,
        root,
        version: normalizeTreeCommentVersion(manifest?.fileVersion ?? 0),
      });
    }
    return entries;
  }

  private async getChildren(element: UnpackExplorerEntry): Promise<UnpackExplorerEntry[]> {
    if (!element.isDirectory) return [];
    let dirents: import('fs').Dirent[];
    try {
      dirents = await fs.readdir(element.fsPath, { withFileTypes: true });
    } catch (err: any) {
      this.output?.appendLine(`[PVF] failed to read unpack dir ${element.fsPath}: ${String(err && err.message || err)}`);
      return [];
    }
    const entries = dirents
      .filter(dirent => dirent.name !== PVF_MANIFEST_FILE)
      .filter(dirent => dirent.isDirectory() || dirent.isFile())
      .map(dirent => this.entryFromPath(path.join(element.fsPath, dirent.name), dirent.name, dirent.isDirectory(), element.root, element.version));
    entries.sort((a, b) => a.isDirectory === b.isDirectory
      ? a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
      : (a.isDirectory ? -1 : 1));
    return entries;
  }

  private entryFromPath(fsPath: string, name: string, isDirectory: boolean, root: string, version: string): UnpackExplorerEntry {
    return {
      fsPath,
      key: normalizeTreeCommentPath(path.relative(root, fsPath)),
      name,
      isDirectory,
      root,
      version,
    };
  }

  private rowFor(element: UnpackExplorerEntry): UnpackExplorerRow {
    const metadata = element.isDirectory ? undefined : this.metadata.getCached(element);
    const comment = this.comments.getCommentForVersion(element.key, element.version);
    if (!element.isDirectory) this.scheduleMetadata(element, metadata);
    const row: UnpackExplorerRow = {
      id: stableId(element),
      name: element.name,
      key: element.key,
      fsPath: element.fsPath,
      isDirectory: element.isDirectory,
      contextValue: this.contextValueFor(element),
      ...(comment ? { comment } : {}),
      ...(metadata?.itemName ? { itemName: metadata.itemName } : {}),
      ...(typeof metadata?.itemCode === 'number' ? { itemCode: metadata.itemCode, itemCodeText: codeTextFor(metadata.itemCode) } : {}),
      ...(typeof metadata?.rarity === 'number' ? { rarity: metadata.rarity, rarityLabel: rarityLabel(metadata.rarity) } : {}),
      ...(metadata?.grade ? { grade: metadata.grade } : {}),
      tooltip: this.tooltipFor(element, comment, metadata),
    };
    const icon = this.iconFor(metadata);
    if (icon) row.icon = icon;
    return row;
  }

  private contextValueFor(element: UnpackExplorerEntry): string {
    if (!element.key) return 'pvf.unpackRoot';
    if (element.isDirectory) return 'pvf.unpackFolder';
    const lower = element.name.toLowerCase();
    if (lower.endsWith('.ani')) return 'pvf.unpackFile.ani';
    if (lower.endsWith('.aic')) return 'pvf.unpackFile.aic';
    return 'pvf.unpackFile';
  }

  private iconFor(metadata: UnpackResolvedMetadata | undefined): UnpackExplorerRow['icon'] | undefined {
    if (!metadata?.iconDataUri) return undefined;
    const size = configNumber('pvf.unpackExplorer.npkIcon.size', 16);
    const width = Math.max(1, metadata.iconWidth || size);
    const height = Math.max(1, metadata.iconHeight || size);
    const isQuestTag = !!metadata.icon && normalizeUnpackKey(metadata.icon.imagePath).endsWith('interface/quest/quest_tag.img');
    const displayHeight = size;
    const displayWidth = isQuestTag
      ? Math.max(size, Math.min(96, Math.round((width / height) * displayHeight)))
      : size;
    return {
      src: metadata.iconDataUri,
      displayWidth,
      displayHeight,
      isQuestTag,
    };
  }

  private queueKey(element: UnpackExplorerEntry): string {
    return `${path.resolve(element.root)}\0${normalizeUnpackKey(element.key)}\0${element.version}`;
  }

  private scheduleMetadata(element: UnpackExplorerEntry, cached: UnpackResolvedMetadata | undefined): void {
    if (element.isDirectory || !element.key) return;
    if (!shouldResolveUnpackMetadataKey(element.key)) return;
    if (cached) {
      if (cached.icon && !cached.iconPath && cached.iconState !== 'loading' && cached.iconState !== 'missing' && cached.iconState !== 'error') {
        this.scheduleIcon(element);
      }
      return;
    }
    const key = this.queueKey(element);
    if (this.metadataQueued.has(key)) return;
    this.metadataQueued.add(key);
    this.metadataQueue.push(element);
    this.pumpMetadataQueue();
  }

  private pumpMetadataQueue(): void {
    const limit = 8;
    while (this.activeMetadataTasks < limit && this.metadataQueue.length > 0) {
      const element = this.metadataQueue.shift()!;
      const key = this.queueKey(element);
      this.activeMetadataTasks++;
      void this.metadata.resolveMetadata(element)
        .then(meta => {
          this.queueRowRefresh(element);
          if (meta.icon) this.scheduleIcon(element);
        })
        .catch((err: any) => {
          this.output?.appendLine(`[PVF] failed to resolve unpack metadata ${element.key}: ${String(err && err.message || err)}`);
        })
        .finally(() => {
          this.metadataQueued.delete(key);
          this.activeMetadataTasks--;
          this.pumpMetadataQueue();
        });
    }
  }

  private scheduleIcon(element: UnpackExplorerEntry): void {
    const key = this.queueKey(element);
    if (this.iconQueued.has(key)) return;
    this.iconQueued.add(key);
    this.iconQueue.push(element);
    this.pumpIconQueue();
  }

  private pumpIconQueue(): void {
    const limit = 2;
    while (this.activeIconTasks < limit && this.iconQueue.length > 0) {
      const element = this.iconQueue.shift()!;
      const key = this.queueKey(element);
      this.activeIconTasks++;
      void this.metadata.resolveIcon(element)
        .then(() => this.queueRowRefresh(element))
        .catch((err: any) => {
          this.output?.appendLine(`[PVF] failed to resolve unpack icon ${element.key}: ${String(err && err.message || err)}`);
        })
        .finally(() => {
          this.iconQueued.delete(key);
          this.activeIconTasks--;
          this.pumpIconQueue();
        });
    }
  }

  private queueRowRefresh(element: UnpackExplorerEntry): void {
    this.pendingRows.set(this.queueKey(element), element);
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => this.flushRowRefresh(), 80);
  }

  private flushRowRefresh(): void {
    this.refreshTimer = undefined;
    const view = this.webviewView;
    if (!view) return;
    const rows = Array.from(this.pendingRows.values());
    this.pendingRows.clear();
    if (rows.length === 0) return;
    void view.webview.postMessage({
      type: 'rows',
      rows: rows.map(row => this.rowFor(row)),
    });
  }

  private tooltipFor(element: UnpackExplorerEntry, comment: string | undefined, metadata?: UnpackResolvedMetadata): string {
    const parts = [
      element.name,
      element.key ? `PVF 路径: ${element.key}` : undefined,
      `磁盘路径: ${element.fsPath}`,
      comment ? `注释: ${comment}` : undefined,
      metadata?.itemName ? `名称: ${metadata.itemName}` : undefined,
      typeof metadata?.itemCode === 'number' ? `代码: ${metadata.itemCode}` : undefined,
      typeof metadata?.rarity === 'number' ? `稀有度: ${metadata.rarity}${rarityLabel(metadata.rarity) ? ` ${rarityLabel(metadata.rarity)}` : ''}` : undefined,
      metadata?.grade ? `任务品级: ${metadata.grade}` : undefined,
      metadata?.icon ? `图标: ${metadata.icon.imagePath} #${metadata.icon.frameIndex}` : undefined,
      `版本: ${element.version}`,
    ];
    return parts.filter((part): part is string => !!part).join('\n');
  }

  private htmlFor(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview', 'unpackExplorerClient.js')).toString();
    const n = nonce();
    const showComment = configBool('pvf.unpackExplorer.metadata.showComment', true);
    const showItemName = configBool('pvf.unpackExplorer.metadata.showItemName', true);
    const showItemCode = configBool('pvf.unpackExplorer.metadata.showItemCode', true);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>解包目录</title>
<style>
:root {
  --row-height: 24px;
  --indent: 14px;
  --icon-size: ${configNumber('pvf.unpackExplorer.npkIcon.size', 16)}px;
  --string-color: var(--vscode-pvf-unpackStringForeground, #ce9178);
  --number-color: var(--vscode-pvf-unpackNumberForeground, #b5cea8);
  --rarity-0: var(--vscode-pvf-rarity0Foreground, #d4d4d4);
  --rarity-1: var(--vscode-pvf-rarity1Foreground, #68d5ed);
  --rarity-2: var(--vscode-pvf-rarity2Foreground, #b36bff);
  --rarity-3: var(--vscode-pvf-rarity3Foreground, #ff4df2);
  --rarity-4: var(--vscode-pvf-rarity4Foreground, #ffb100);
  --rarity-5: var(--vscode-pvf-rarity5Foreground, #ff6666);
  --rarity-6: var(--vscode-pvf-rarity6Foreground, #ff7800);
  --rarity-7: var(--vscode-pvf-rarity7Foreground, #36e6ff);
}
* { box-sizing: border-box; }
html, body { min-height: 100%; margin: 0; padding: 0; }
body {
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  color: var(--vscode-foreground);
  font: var(--vscode-font-weight) var(--vscode-font-size) var(--vscode-font-family);
  overflow: auto;
}
#tree { min-width: max-content; padding: 3px 0 8px; }
.row {
  display: flex;
  align-items: center;
  height: var(--row-height);
  min-height: var(--row-height);
  padding-right: 8px;
  color: var(--vscode-foreground);
  white-space: nowrap;
  user-select: none;
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.row.selected .label { color: var(--vscode-list-activeSelectionForeground); }
.spacer { flex: 0 0 calc(var(--depth, 0) * var(--indent)); width: calc(var(--depth, 0) * var(--indent)); }
.twisty {
  position: relative;
  flex: 0 0 16px;
  width: 16px;
  height: var(--row-height);
  border: 0;
  padding: 0;
  margin: 0;
  background: transparent;
}
.twisty.folder::before {
  content: "";
  position: absolute;
  left: 5px;
  top: 8px;
  border-style: solid;
  border-width: 4px 0 4px 5px;
  border-color: transparent transparent transparent var(--vscode-descriptionForeground);
}
.twisty.folder.expanded::before {
  left: 4px;
  top: 10px;
  border-width: 5px 4px 0 4px;
  border-color: var(--vscode-descriptionForeground) transparent transparent transparent;
}
.icon {
  flex: 0 0 var(--icon-w, var(--icon-size));
  width: var(--icon-w, var(--icon-size));
  height: var(--icon-h, var(--icon-size));
  margin-right: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-icon-foreground);
}
.icon img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
.fallback-file {
  width: 16px;
  height: 16px;
  opacity: .9;
  background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%23000' d='M3 1.5h6.5L13 5v9.5H3v-13Zm1 1V13.5h8V5.75L8.75 2.5H4Zm5 0V6h3.5L9 2.5Z'/%3E%3C/svg%3E") center / 16px 16px no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%23000' d='M3 1.5h6.5L13 5v9.5H3v-13Zm1 1V13.5h8V5.75L8.75 2.5H4Zm5 0V6h3.5L9 2.5Z'/%3E%3C/svg%3E") center / 16px 16px no-repeat;
}
.fallback-folder {
  width: 16px;
  height: 16px;
  opacity: .9;
  background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%23000' d='M1.5 4h5l1.2 1.5h6.8v8h-13v-9.5Zm1 2.5v6h11v-6H7.22L6.02 5h-3.52v1.5Z'/%3E%3C/svg%3E") center / 16px 16px no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%23000' d='M1.5 4h5l1.2 1.5h6.8v8h-13v-9.5Zm1 2.5v6h11v-6H7.22L6.02 5h-3.52v1.5Z'/%3E%3C/svg%3E") center / 16px 16px no-repeat;
}
.label {
  color: var(--vscode-foreground);
  min-width: 0;
}
.meta {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
  margin-left: 7px;
}
.comment { color: var(--vscode-descriptionForeground); }
.item-name.string { color: var(--string-color); }
.item-code { color: var(--number-color); }
.rarity-0 { color: var(--rarity-0); }
.rarity-1 { color: var(--rarity-1); }
.rarity-2 { color: var(--rarity-2); }
.rarity-3 { color: var(--rarity-3); }
.rarity-4 { color: var(--rarity-4); }
.rarity-5 { color: var(--rarity-5); }
.rarity-6 { color: var(--rarity-6); }
.rarity-7 { color: var(--rarity-7); }
.status {
  padding: 8px 10px;
  color: var(--vscode-descriptionForeground);
}
.loading-row {
  display: flex;
  align-items: center;
  height: var(--row-height);
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}
</style>
</head>
<body>
<div id="tree" role="tree" aria-label="解包目录"></div>
<script nonce="${n}">
window.__PVF_UNPACK_CONFIG__ = ${JSON.stringify({ showComment, showItemName, showItemCode })};
</script>
<script src="${scriptUri}" nonce="${n}"></script>
</body>
</html>`;
  }
}
