import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PVF_MANIFEST_FILE, PvfDirectoryManifest } from './directoryArchive';
import { normalizeTreeCommentPath, normalizeTreeCommentVersion, PvfTreeCommentService } from './treeComments';
import { readConfiguredUnpackRoots } from './unpackEnv';

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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly comments: PvfTreeCommentService,
    private readonly output?: vscode.OutputChannel,
  ) {}

  refresh(): void {
    this.rootsCache = undefined;
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
    item.tooltip = this.tooltipFor(element, comment);
    if (element.isDirectory) {
      item.iconPath = vscode.ThemeIcon.Folder;
    } else {
      item.iconPath = vscode.ThemeIcon.File;
      item.command = {
        command: 'vscode.open',
        title: '打开文件',
        arguments: [vscode.Uri.file(element.fsPath)],
      };
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

  private tooltipFor(element: UnpackExplorerEntry, comment: string | undefined): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = { enabledCommands: ['pvf.editTreeComment'] };
    md.appendMarkdown(`**${escapeMarkdown(element.name)}**\n\n`);
    if (element.key) md.appendMarkdown(`PVF 路径: \`${escapeInlineCode(element.key)}\`\n\n`);
    md.appendMarkdown(`磁盘路径: \`${escapeInlineCode(element.fsPath)}\``);
    if (comment) md.appendMarkdown(`\n\n注释: ${escapeMarkdown(comment)}`);
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
