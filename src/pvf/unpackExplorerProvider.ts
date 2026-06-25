import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PVF_MANIFEST_FILE, PvfDirectoryManifest } from './directoryArchive';
import { normalizeTreeCommentPath, normalizeTreeCommentVersion, PvfTreeCommentService } from './treeComments';
import { readUnpackExplorerRoots } from './unpackEnv';
import { UnpackMetadataService, UnpackResolvedMetadata, normalizeUnpackKey, rarityLabel, shouldResolveUnpackMetadataKey } from './unpackMetadata';

export interface UnpackExplorerEntry {
  fsPath: string;
  key: string;
  name: string;
  isDirectory: boolean;
  root: string;
  version: string;
}

async function readManifest(file: string): Promise<PvfDirectoryManifest | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as PvfDirectoryManifest;
  } catch {
    return undefined;
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, '\\`');
}

export class UnpackExplorerProvider implements vscode.TreeDataProvider<UnpackExplorerEntry> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<UnpackExplorerEntry | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private rootsCache: Promise<UnpackExplorerEntry[]> | undefined;
  private readonly metadata: UnpackMetadataService;
  private readonly metadataQueue: UnpackExplorerEntry[] = [];
  private readonly metadataQueued = new Set<string>();
  private readonly iconQueue: UnpackExplorerEntry[] = [];
  private readonly iconQueued = new Set<string>();
  private readonly pendingRefresh = new Map<string, UnpackExplorerEntry>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private activeMetadataTasks = 0;
  private activeIconTasks = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly comments: PvfTreeCommentService,
    private readonly output?: vscode.OutputChannel,
    metadata?: UnpackMetadataService,
  ) {
    this.metadata = metadata || new UnpackMetadataService(context, output);
  }

  refresh(): void {
    this.rootsCache = undefined;
    this.metadata.clear();
    this.metadataQueue.length = 0;
    this.iconQueue.length = 0;
    this.metadataQueued.clear();
    this.iconQueued.clear();
    this.pendingRefresh.clear();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.activeMetadataTasks = 0;
    this.activeIconTasks = 0;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: UnpackExplorerEntry): vscode.TreeItem {
    const comment = this.comments.getCommentForVersion(element.key, element.version);
    const item = new vscode.TreeItem(element.name, element.isDirectory
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None);
    if (comment) item.description = `(${comment})`;
    item.contextValue = this.contextValueFor(element);
    item.resourceUri = vscode.Uri.file(element.fsPath);
    const metadata = element.isDirectory ? undefined : this.metadata.getCached(element);
    item.tooltip = this.tooltipFor(element, comment, metadata);
    if (element.isDirectory) {
      item.iconPath = vscode.ThemeIcon.Folder;
    } else {
      item.description = this.descriptionFor(comment, metadata);
      item.iconPath = this.iconFor(metadata);
      item.command = {
        command: 'vscode.open',
        title: '打开文件',
        arguments: [vscode.Uri.file(element.fsPath)],
      };
      this.scheduleMetadata(element, metadata);
    }
    return item;
  }

  async getChildren(element?: UnpackExplorerEntry): Promise<UnpackExplorerEntry[]> {
    if (!element) return this.getRoots();
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

  private async getRoots(): Promise<UnpackExplorerEntry[]> {
    if (!this.rootsCache) this.rootsCache = this.loadRoots();
    return this.rootsCache;
  }

  private async loadRoots(): Promise<UnpackExplorerEntry[]> {
    const roots = await readUnpackExplorerRoots(this.context);
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

  private contextValueFor(element: UnpackExplorerEntry): string {
    if (!element.key) return 'pvf.unpackRoot';
    if (element.isDirectory) return 'pvf.unpackFolder';
    const lower = element.name.toLowerCase();
    if (lower.endsWith('.ani')) return 'pvf.unpackFile.ani';
    if (lower.endsWith('.aic')) return 'pvf.unpackFile.aic';
    return 'pvf.unpackFile';
  }

  private descriptionFor(comment: string | undefined, metadata: UnpackResolvedMetadata | undefined): string | undefined {
    const cfg = vscode.workspace.getConfiguration();
    const showComment = cfg.get<boolean>('pvf.unpackExplorer.metadata.showComment', true);
    const showItemName = cfg.get<boolean>('pvf.unpackExplorer.metadata.showItemName', true);
    const showItemCode = cfg.get<boolean>('pvf.unpackExplorer.metadata.showItemCode', true);
    const codeFormat = cfg.get<string>('pvf.unpackExplorer.metadata.itemCodeFormat', '<{code}>') || '<{code}>';
    const parts: string[] = [];
    if (showComment && comment) parts.push(`(${comment})`);
    if (showItemName && metadata?.itemName) parts.push(metadata.itemName);
    if (showItemCode && typeof metadata?.itemCode === 'number') parts.push(codeFormat.replace(/\{code\}/g, String(metadata.itemCode)));
    return parts.length ? parts.join(' ') : undefined;
  }

  private iconFor(metadata: UnpackResolvedMetadata | undefined): vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri } {
    if (metadata?.iconPath) {
      const uri = vscode.Uri.file(metadata.iconPath);
      return { light: uri, dark: uri };
    }
    return vscode.ThemeIcon.File;
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
    const limit = 3;
    while (this.activeMetadataTasks < limit && this.metadataQueue.length > 0) {
      const element = this.metadataQueue.shift()!;
      const key = this.queueKey(element);
      this.activeMetadataTasks++;
      void this.metadata.resolveMetadata(element)
        .then(meta => {
          this.queueRefresh(element);
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
        .then(() => this.queueRefresh(element))
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

  private queueRefresh(element: UnpackExplorerEntry): void {
    this.pendingRefresh.set(this.queueKey(element), element);
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => this.flushRefresh(), 120);
  }

  private flushRefresh(): void {
    this.refreshTimer = undefined;
    const elements = Array.from(this.pendingRefresh.values());
    this.pendingRefresh.clear();
    if (elements.length === 0) return;
    if (elements.length > 40) {
      this._onDidChangeTreeData.fire();
      return;
    }
    for (const element of elements) {
      this._onDidChangeTreeData.fire(element);
    }
  }

  private tooltipFor(element: UnpackExplorerEntry, comment: string | undefined, metadata?: UnpackResolvedMetadata): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = { enabledCommands: ['pvf.editTreeComment'] };
    md.appendMarkdown(`**${escapeMarkdown(element.name)}**\n\n`);
    if (element.key) md.appendMarkdown(`PVF 路径: \`${escapeInlineCode(element.key)}\`\n\n`);
    md.appendMarkdown(`磁盘路径: \`${escapeInlineCode(element.fsPath)}\``);
    if (comment) md.appendMarkdown(`\n\n注释: ${escapeMarkdown(comment)}`);
    if (metadata?.itemName) md.appendMarkdown(`\n\n名称: ${escapeMarkdown(metadata.itemName)}`);
    if (typeof metadata?.itemCode === 'number') md.appendMarkdown(`\n\n代码: \`${metadata.itemCode}\``);
    if (typeof metadata?.rarity === 'number') {
      const label = rarityLabel(metadata.rarity);
      md.appendMarkdown(`\n\n稀有度: \`${metadata.rarity}${label ? ` ${label}` : ''}\``);
    }
    if (metadata?.grade) md.appendMarkdown(`\n\n任务品级: \`${escapeInlineCode(metadata.grade)}\``);
    if (metadata?.icon) md.appendMarkdown(`\n\n图标: \`${escapeInlineCode(metadata.icon.imagePath)}\` #${metadata.icon.frameIndex}`);
    md.appendMarkdown(`\n\n版本: \`${escapeInlineCode(element.version)}\``);
    if (element.key) {
      const args = encodeURIComponent(JSON.stringify([{
        key: element.key,
        name: element.name,
        isFile: !element.isDirectory,
        version: element.version,
        uri: vscode.Uri.file(element.fsPath).toString(),
      }]));
      md.supportThemeIcons = true;
      md.appendMarkdown(`\n\n[$(edit) 编辑注释](command:pvf.editTreeComment?${args})`);
    }
    return md;
  }
}
