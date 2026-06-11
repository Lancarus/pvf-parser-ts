import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import bundledBookmarks from '../config/pvf/bookmarks.json';
import type { PvfFileEntry } from './model';
import { pathContains, readConfiguredUnpackRoots } from './unpackEnv';
import type { UnpackExplorerEntry } from './unpackExplorerProvider';

interface BookmarkJsonNode {
  label?: string;
  path?: string;
  children?: BookmarkJsonNode[];
}

interface BookmarkJsonFile {
  schemaVersion?: number;
  roots?: BookmarkJsonNode[];
}

export interface BookmarkEntry {
  id: string;
  label: string;
  key?: string;
  children: BookmarkEntry[];
}

interface BookmarkTreeSnapshot {
  schemaVersion: 1;
  roots: BookmarkJsonNode[];
}

interface MoveLocation {
  parent: BookmarkEntry | undefined;
  index: number;
}

const STORAGE_FILE = 'bookmarks.json';
const BOOKMARK_MIME = 'application/vnd.code.tree.pvfbookmarkview';

function normalizeBookmarkPath(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

function nodeId(parentId: string, index: number, label: string, key?: string): string {
  const raw = key || label || String(index);
  const safe = raw.replace(/[^\w./-]+/g, '_');
  return parentId ? `${parentId}/${index}-${safe}` : `${index}-${safe}`;
}

function buildEntries(nodes: BookmarkJsonNode[] | undefined, parentId = ''): BookmarkEntry[] {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node, index) => {
      const label = typeof node?.label === 'string' ? node.label.trim() : '';
      if (!label) return undefined;
      const key = normalizeBookmarkPath(node.path);
      const id = nodeId(parentId, index, label, key);
      return {
        id,
        label,
        ...(key ? { key } : {}),
        children: buildEntries(node.children, id),
      };
    })
    .filter((entry): entry is BookmarkEntry => !!entry);
}

function entriesToJson(entries: BookmarkEntry[]): BookmarkJsonNode[] {
  return entries.map(entry => ({
    label: entry.label,
    ...(entry.key ? { path: entry.key } : {}),
    ...(entry.children.length ? { children: entriesToJson(entry.children) } : {}),
  }));
}

function cloneJsonNodes(nodes: BookmarkJsonNode[] | undefined): BookmarkJsonNode[] {
  if (!Array.isArray(nodes)) return [];
  const result: BookmarkJsonNode[] = [];
  for (const node of nodes) {
    const label = typeof node?.label === 'string' ? node.label.trim() : '';
    if (!label) continue;
    const key = normalizeBookmarkPath(node.path);
    const children = cloneJsonNodes(node.children);
    result.push({
      label,
      ...(key ? { path: key } : {}),
      ...(children.length ? { children } : {}),
    });
  }
  return result;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, '\\`');
}

function isDescendant(target: BookmarkEntry, candidateAncestor: BookmarkEntry): boolean {
  if (target === candidateAncestor) return true;
  return candidateAncestor.children.some(child => isDescendant(target, child));
}

function entryChildren(entry: BookmarkEntry | undefined, roots: BookmarkEntry[]): BookmarkEntry[] {
  return entry ? entry.children : roots;
}

async function statFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolveCaseInsensitive(root: string, relativePath: string): Promise<string | undefined> {
  const exact = path.resolve(root, relativePath);
  if (!pathContains(root, exact)) return undefined;
  if (await statFile(exact)) return exact;

  const parts = relativePath.split('/').filter(Boolean);
  let current = path.resolve(root);
  for (const part of parts) {
    let dirents: import('fs').Dirent[];
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const found = dirents.find(dirent => dirent.name.toLowerCase() === part.toLowerCase());
    if (!found) return undefined;
    current = path.join(current, found.name);
  }
  if (!pathContains(root, current)) return undefined;
  return await statFile(current) ? current : undefined;
}

export function bookmarkPathFromTarget(target: unknown): string {
  let value = target;
  if (Array.isArray(value) && value.length > 0) value = value[0];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      value = Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : parsed;
    } catch {
      return normalizeBookmarkPath(value);
    }
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return normalizeBookmarkPath(rec.key ?? rec.path ?? rec.filePath);
  }
  return '';
}

export function bookmarkLabelFromTarget(target: unknown): string {
  let value = target;
  if (Array.isArray(value) && value.length > 0) value = value[0];
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const label = rec.label ?? rec.name;
    if (typeof label === 'string' && label.trim()) return label.trim();
  }
  const key = bookmarkPathFromTarget(target);
  return key.split('/').pop() || key;
}

export function bookmarkPathFromPvfTarget(target: unknown): string {
  let value = target;
  if (Array.isArray(value) && value.length > 0) value = value[0];
  if (value && typeof value === 'object') {
    const rec = value as PvfFileEntry;
    return normalizeBookmarkPath(rec.key);
  }
  return bookmarkPathFromTarget(value);
}

export function bookmarkPathFromUnpackTarget(target: unknown): string {
  let value = target;
  if (Array.isArray(value) && value.length > 0) value = value[0];
  if (value && typeof value === 'object') {
    const rec = value as UnpackExplorerEntry;
    return normalizeBookmarkPath(rec.key);
  }
  return bookmarkPathFromTarget(value);
}

export async function findBookmarkInUnpackRoots(context: vscode.ExtensionContext, key: string): Promise<vscode.Uri | undefined> {
  const normalized = normalizeBookmarkPath(key);
  if (!normalized || normalized.split('/').includes('..')) return undefined;
  const roots = await readConfiguredUnpackRoots(context);
  for (const root of roots) {
    const fsPath = await resolveCaseInsensitive(root, normalized);
    if (fsPath) return vscode.Uri.file(fsPath);
  }
  return undefined;
}

export class BookmarkProvider implements vscode.TreeDataProvider<BookmarkEntry>, vscode.TreeDragAndDropController<BookmarkEntry> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BookmarkEntry | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  readonly dragMimeTypes = [BOOKMARK_MIME];
  readonly dropMimeTypes = [BOOKMARK_MIME];
  private roots: BookmarkEntry[] = [];
  private loadPromise: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly output?: vscode.OutputChannel) {
    this.loadPromise = this.load();
  }

  async refresh(): Promise<void> {
    this.loadPromise = this.load();
    await this.loadPromise;
    this._onDidChangeTreeData.fire();
  }

  async resetToBuiltIn(): Promise<void> {
    this.roots = this.defaultRoots();
    await this.save();
  }

  getTreeItem(element: BookmarkEntry): vscode.TreeItem {
    const isFolder = !element.key;
    const item = new vscode.TreeItem(element.label, isFolder
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None);

    if (element.key) {
      item.contextValue = 'pvf.bookmarkFile';
      item.description = element.key;
      item.resourceUri = vscode.Uri.from({ scheme: 'pvf', path: `/${element.key}` });
      item.command = {
        command: 'pvf.openBookmark',
        title: '打开书签',
        arguments: [element],
      };
    } else {
      item.contextValue = 'pvf.bookmarkFolder';
      item.iconPath = vscode.ThemeIcon.Folder;
    }
    item.tooltip = this.tooltipFor(element);
    return item;
  }

  async getChildren(element?: BookmarkEntry): Promise<BookmarkEntry[]> {
    await this.ensureLoaded();
    return element ? element.children : this.roots;
  }

  async getParent(element: BookmarkEntry): Promise<BookmarkEntry | undefined> {
    await this.ensureLoaded();
    return this.findParent(element.id);
  }

  handleDrag(source: readonly BookmarkEntry[], dataTransfer: vscode.DataTransfer): void {
    dataTransfer.set(BOOKMARK_MIME, new vscode.DataTransferItem(source.map(item => item.id)));
  }

  async handleDrop(target: BookmarkEntry | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    await this.ensureLoaded();
    const item = dataTransfer.get(BOOKMARK_MIME);
    if (!item) return;
    const ids = Array.isArray(item.value) ? item.value.map(String) : [];
    if (ids.length === 0) return;

    const moving = ids
      .map(id => this.findEntry(id))
      .filter((entry): entry is BookmarkEntry => !!entry);
    if (moving.length === 0) return;
    if (target && moving.some(entry => isDescendant(target, entry))) return;
    const targetId = target?.id;

    const detached: BookmarkEntry[] = [];
    for (const id of ids) {
      const entry = this.detach(id);
      if (entry) detached.push(entry);
    }
    if (detached.length === 0) return;

    const location = this.dropLocation(targetId ? this.findEntry(targetId) : undefined);
    const children = entryChildren(location.parent, this.roots);
    const index = Math.max(0, Math.min(location.index, children.length));
    children.splice(index, 0, ...detached);
    this.reindex();
    await this.save();
  }

  async createFolder(parent?: BookmarkEntry, defaultName = ''): Promise<BookmarkEntry | undefined> {
    await this.ensureLoaded();
    const name = await vscode.window.showInputBox({
      title: '新建书签文件夹',
      prompt: parent ? `父级: ${parent.label}` : '父级: 书签根目录',
      placeHolder: '文件夹名称',
      value: defaultName,
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : '请输入文件夹名称',
    });
    if (name === undefined) return undefined;
    const folder: BookmarkEntry = { id: '', label: name.trim(), children: [] };
    entryChildren(parent, this.roots).push(folder);
    this.reindex();
    await this.save();
    return folder;
  }

  async addBookmark(key: string, label: string, parent?: BookmarkEntry): Promise<BookmarkEntry | undefined> {
    await this.ensureLoaded();
    const normalized = normalizeBookmarkPath(key);
    if (!normalized) return undefined;
    const targetParent = parent?.key ? this.findParent(parent.id) : parent;
    const siblings = entryChildren(targetParent, this.roots);
    const existing = siblings.find(item => item.key === normalized);
    if (existing) {
      vscode.window.showInformationMessage(`书签已存在: ${normalized}`);
      return existing;
    }
    const entry: BookmarkEntry = {
      id: '',
      label: label.trim() || normalized.split('/').pop() || normalized,
      key: normalized,
      children: [],
    };
    siblings.push(entry);
    this.reindex();
    await this.save();
    vscode.window.showInformationMessage(`已添加书签: ${entry.label}`);
    return entry;
  }

  async addBookmarkInteractive(target: { key: string; label: string }): Promise<BookmarkEntry | undefined> {
    await this.ensureLoaded();
    const normalized = normalizeBookmarkPath(target.key);
    if (!normalized) {
      vscode.window.showWarningMessage('无法添加书签：缺少 PVF 路径。');
      return undefined;
    }
    const parent = await this.pickFolder(normalized);
    if (parent === false) return undefined;
    const label = await vscode.window.showInputBox({
      title: '书签名称',
      value: target.label || normalized.split('/').pop() || normalized,
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : '请输入书签名称',
    });
    if (label === undefined) return undefined;
    return this.addBookmark(normalized, label, parent);
  }

  async deleteEntry(entry: BookmarkEntry): Promise<void> {
    await this.ensureLoaded();
    const message = entry.key
      ? `删除书签 "${entry.label}"?`
      : `删除书签文件夹 "${entry.label}" 及其所有子项?`;
    const ok = await vscode.window.showWarningMessage(message, { modal: true }, '删除');
    if (ok !== '删除') return;
    if (!this.detach(entry.id)) return;
    this.reindex();
    await this.save();
  }

  async renameEntry(entry: BookmarkEntry): Promise<void> {
    await this.ensureLoaded();
    const value = await vscode.window.showInputBox({
      title: entry.key ? '重命名书签' : '重命名书签文件夹',
      value: entry.label,
      ignoreFocusOut: true,
      validateInput: text => text.trim() ? undefined : '请输入名称',
    });
    if (value === undefined) return;
    entry.label = value.trim();
    this.reindex();
    await this.save();
  }

  folderItems(): BookmarkEntry[] {
    const out: BookmarkEntry[] = [];
    const visit = (entries: BookmarkEntry[]) => {
      for (const entry of entries) {
        if (entry.key) continue;
        out.push(entry);
        visit(entry.children);
      }
    };
    visit(this.roots);
    return out;
  }

  async pickFolder(placeHolder = ''): Promise<BookmarkEntry | undefined | false> {
    await this.ensureLoaded();
    const folders = this.folderItems();
    const picks = [
      { label: '书签根目录', description: '', folder: undefined as BookmarkEntry | undefined },
      ...folders.map(folder => ({ label: folder.label, description: this.folderPath(folder), folder })),
    ];
    const selected = await vscode.window.showQuickPick(picks, {
      title: '选择书签目录',
      placeHolder,
      ignoreFocusOut: true,
    });
    return selected ? selected.folder : false;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loadPromise) await this.loadPromise;
  }

  private async load(): Promise<void> {
    const fromDisk = await this.readPersisted();
    this.roots = buildEntries(fromDisk?.roots) || [];
    if (this.roots.length === 0) this.roots = this.defaultRoots();
    this.reindex();
  }

  private defaultRoots(): BookmarkEntry[] {
    return buildEntries(cloneJsonNodes((bundledBookmarks as BookmarkJsonFile).roots));
  }

  private async readPersisted(): Promise<BookmarkTreeSnapshot | undefined> {
    try {
      const file = path.join(this.context.globalStorageUri.fsPath, STORAGE_FILE);
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as BookmarkTreeSnapshot;
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.roots)) return parsed;
    } catch {
      // Missing user bookmark file is normal; fall back to bundled defaults.
    }
    return undefined;
  }

  private async save(): Promise<void> {
    const file = path.join(this.context.globalStorageUri.fsPath, STORAGE_FILE);
    const snapshot: BookmarkTreeSnapshot = {
      schemaVersion: 1,
      roots: entriesToJson(this.roots),
    };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    this._onDidChangeTreeData.fire();
  }

  private findEntry(id: string): BookmarkEntry | undefined {
    let found: BookmarkEntry | undefined;
    const visit = (entries: BookmarkEntry[]) => {
      for (const entry of entries) {
        if (entry.id === id) {
          found = entry;
          return;
        }
        visit(entry.children);
        if (found) return;
      }
    };
    visit(this.roots);
    return found;
  }

  private findParent(id: string): BookmarkEntry | undefined {
    let found: BookmarkEntry | undefined;
    const visit = (entries: BookmarkEntry[], parent: BookmarkEntry | undefined) => {
      for (const entry of entries) {
        if (entry.id === id) {
          found = parent;
          return;
        }
        visit(entry.children, entry);
        if (found !== undefined) return;
      }
    };
    visit(this.roots, undefined);
    return found;
  }

  private detach(id: string): BookmarkEntry | undefined {
    const removeFrom = (entries: BookmarkEntry[]): BookmarkEntry | undefined => {
      const index = entries.findIndex(entry => entry.id === id);
      if (index >= 0) return entries.splice(index, 1)[0];
      for (const entry of entries) {
        const removed = removeFrom(entry.children);
        if (removed) return removed;
      }
      return undefined;
    };
    return removeFrom(this.roots);
  }

  private dropLocation(target: BookmarkEntry | undefined): MoveLocation {
    if (!target) return { parent: undefined, index: this.roots.length };
    if (!target.key) return { parent: target, index: target.children.length };
    const parent = this.findParent(target.id);
    const siblings = entryChildren(parent, this.roots);
    const index = siblings.findIndex(entry => entry.id === target.id);
    return { parent, index: index >= 0 ? index + 1 : siblings.length };
  }

  private reindex(): void {
    const assign = (entries: BookmarkEntry[], parentId = '') => {
      entries.forEach((entry, index) => {
        entry.id = nodeId(parentId, index, entry.label, entry.key);
        assign(entry.children, entry.id);
      });
    };
    assign(this.roots);
  }

  private folderPath(folder: BookmarkEntry): string {
    const names: string[] = [folder.label];
    let current = this.findParent(folder.id);
    while (current) {
      names.unshift(current.label);
      current = this.findParent(current.id);
    }
    return names.join(' / ');
  }

  private tooltipFor(element: BookmarkEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.supportThemeIcons = true;
    md.isTrusted = { enabledCommands: ['pvf.openBookmark', 'pvf.openBookmarkInPack', 'pvf.openBookmarkOnDisk'] };
    md.appendMarkdown(`**${escapeMarkdown(element.label)}**`);
    if (element.key) {
      const args = encodeURIComponent(JSON.stringify([element]));
      md.appendMarkdown(`\n\nPVF 路径: \`${escapeInlineCode(element.key)}\``);
      md.appendMarkdown(`\n\n[$(go-to-file) 打开](command:pvf.openBookmark?${args})`);
      md.appendMarkdown(`  [$(archive) PVF](command:pvf.openBookmarkInPack?${args})`);
      md.appendMarkdown(`  [$(folder-opened) 解包目录](command:pvf.openBookmarkOnDisk?${args})`);
    } else {
      md.appendMarkdown(`\n\n拖动书签或文件夹到这里可移动目录。`);
    }
    return md;
  }
}
