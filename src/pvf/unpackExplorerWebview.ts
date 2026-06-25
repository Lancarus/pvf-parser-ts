import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PVF_MANIFEST_FILE, PvfDirectoryManifest } from './directoryArchive';
import { normalizeTreeCommentPath, normalizeTreeCommentVersion, PvfTreeCommentService } from './treeComments';
import { pathContains, readUnpackExplorerRoots } from './unpackEnv';
import {
  UnpackMetadataService,
  UnpackResolvedMetadata,
  normalizeUnpackKey,
  rarityLabel,
  shouldResolveUnpackMetadataKey,
} from './unpackMetadata';
import { UnpackHoverPreviewPanel } from './unpackPreviewPanel';
import { UnpackHoverPreview, UnpackPreviewService } from './unpackPreview';

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
  skillClass?: number;
  skillClassText?: string;
  skillKind?: UnpackResolvedMetadata['skillKind'];
  icon?: {
    src: string;
    displayWidth: number;
    displayHeight: number;
    isQuestTag: boolean;
  };
  tooltip: string;
}

interface UnpackExplorerReveal {
  targetId: string;
  pathIds: string[];
  key: string;
  fsPath: string;
}

async function readManifest(file: string): Promise<PvfDirectoryManifest | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as PvfDirectoryManifest;
  } catch {
    return undefined;
  }
}

function findPreviewSkillNode(preview: UnpackHoverPreview | undefined, key: string, code: number | undefined): { fsPath?: string } | undefined {
  if (!preview?.skillTrees?.length) return undefined;
  const normalized = key ? normalizeUnpackKey(key) : '';
  for (const group of preview.skillTrees) {
    for (const node of group.nodes || []) {
      if (normalized && node.key && normalizeUnpackKey(node.key) === normalized) return node;
      if (!normalized && typeof code === 'number' && node.code === code && node.fsPath) return node;
    }
  }
  return undefined;
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

function affectsSharedUnpackMetadata(key: string): boolean {
  const normalized = normalizeUnpackKey(key);
  return normalized === 'stringtable.bin' || normalized.endsWith('.lst') || normalized.endsWith('.str');
}

function skillKindLabel(kind: UnpackResolvedMetadata['skillKind']): string {
  if (kind === 'active') return '主动';
  if (kind === 'passive') return '被动';
  if (kind === 'common') return '通用';
  if (kind === 'guild') return '公会';
  return '';
}

function resourceRoleLabel(role: string): string {
  if (role === 'script') return 'NUT脚本';
  if (role === 'action') return '动作';
  if (role === 'avatar') return '时装/角色';
  if (role === 'skillEffect') return '技能特效';
  if (role === 'attack') return '攻击信息';
  if (role === 'object') return '对象';
  return '资源';
}

function previewText(preview: UnpackHoverPreview): string {
  const lines: string[] = [];
  lines.push(preview.title || preview.key);
  const subtitle = [preview.subtitle, typeof preview.itemCode === 'number' ? `<${preview.itemCode}>` : undefined, preview.rarityLabel]
    .filter((part): part is string => !!part)
    .join('  ');
  if (subtitle) lines.push(subtitle);
  if (preview.key) lines.push(`PVF 路径: ${preview.key}`);
  if (preview.fsPath) lines.push(`磁盘路径: ${preview.fsPath}`);
  if (preview.message) {
    lines.push('');
    lines.push(preview.message);
  }
  const maxSections = 8;
  const maxSectionLines = 18;
  let sectionCount = 0;
  for (const section of preview.sections || []) {
    if (sectionCount >= maxSections) {
      lines.push('');
      lines.push(`另有 ${(preview.sections || []).length - sectionCount} 个分区未展示。`);
      break;
    }
    sectionCount++;
    lines.push('');
    lines.push(`[${section.title || '信息'}]`);
    let emitted = 0;
    for (const field of section.fields || []) {
      if (emitted >= maxSectionLines) break;
      lines.push(`${field.label}: ${field.value}`);
      emitted++;
    }
    for (const line of section.lines || []) {
      if (emitted >= maxSectionLines) break;
      lines.push(line);
      emitted++;
    }
    for (const table of section.tables || []) {
      if (emitted >= maxSectionLines) break;
      if (table.caption) {
        lines.push(table.caption);
        emitted++;
      }
      if (emitted >= maxSectionLines) break;
      lines.push((table.headers || []).join(' | '));
      emitted++;
      for (const row of (table.rows || []).slice(0, 5)) {
        if (emitted >= maxSectionLines) break;
        lines.push(row.join(' | '));
        emitted++;
      }
    }
    for (const entry of section.entries || []) {
      if (emitted >= maxSectionLines) break;
      const name = entry.name || (entry.unresolved ? '未解析' : '');
      const prefix = typeof entry.code === 'number' ? `${entry.code}  ` : '';
      const qty = typeof entry.quantity === 'number' ? ` x${entry.quantity}` : '';
      const details = [
        entry.resourceRole ? resourceRoleLabel(entry.resourceRole) : (entry.resourceKind ? String(entry.resourceKind).toUpperCase() : undefined),
        entry.branch,
        typeof entry.x === 'number' && typeof entry.y === 'number' ? `坐标 ${entry.x}, ${entry.y}` : undefined,
        entry.common ? '通用' : undefined,
        entry.key,
        entry.fsPath,
        entry.detail,
      ].filter((part): part is string => !!part).join('  ');
      lines.push(`${prefix}${name}${qty}${details ? `  ${details}` : ''}`);
      emitted++;
    }
    const total = (section.fields || []).length + (section.lines || []).length + (section.entries || []).length
      + (section.tables || []).reduce((sum, table) => sum + 2 + Math.min(5, (table.rows || []).length), 0);
    if (total > emitted) lines.push(`... 另有 ${total - emitted} 项未展示`);
  }
  const text = lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
  return text.length > 6000 ? `${text.slice(0, 6000)}\n... 内容过长，已截断` : text;
}

// 性能计时
interface TimingSpan { label: string; start: number; }
const timings: TimingSpan[] = [];
const TIMING_LOG_LIMIT = 40;
function startTiming(label: string): void {
  if (timings.length >= TIMING_LOG_LIMIT) return;
  timings.push({ label, start: Date.now() });
}
function endTiming(label: string, output?: vscode.OutputChannel): void {
  const idx = timings.findIndex(t => t.label === label && t.start > 0);
  if (idx === -1) return;
  const elapsed = Date.now() - timings[idx].start;
  timings[idx] = { label: `${label} (${elapsed}ms)`, start: 0 };
  output?.appendLine(`[PVF perf] ${label}: ${elapsed}ms`);
}
function flushTimings(output?: vscode.OutputChannel): void {
  // 按标签去重保留最后一条
  const map = new Map<string, number>();
  for (const t of timings) {
    if (t.start !== 0) continue;
    const key = t.label;
    map.set(key, (map.get(key) || 0) + 1);
  }
  if (map.size === 0) return;
  output?.appendLine(`[PVF perf] ── timing summary ──`);
  for (const [label, count] of map) {
    const m = label.match(/^(.+)\((\d+)ms\)$/);
    if (m && m[1] && m[2]) {
      output?.appendLine(`[PVF perf]   ${m[1]}: ${m[2]}ms${count > 1 ? ` (x${count})` : ''}`);
    }
  }
  output?.appendLine(`[PVF perf] ────────────────────`);
  timings.length = 0;
}

export class UnpackExplorerWebviewProvider implements vscode.WebviewViewProvider {
  private webviewView: vscode.WebviewView | undefined;
  private rootsCache: Promise<UnpackExplorerEntry[]> | undefined;
  private readonly metadata: UnpackMetadataService;
  private readonly preview: UnpackPreviewService;
  private readonly previewPanel: UnpackHoverPreviewPanel;
  private readonly entriesById = new Map<string, UnpackExplorerEntry>();
  private readonly metadataQueue: UnpackExplorerEntry[] = [];
  private readonly metadataQueued = new Set<string>();
  private readonly iconQueue: UnpackExplorerEntry[] = [];
  private readonly iconQueued = new Set<string>();
  private readonly pendingRows = new Map<string, UnpackExplorerEntry>();
  private readonly dirChildrenCache = new Map<string, UnpackExplorerEntry[]>();
  private preloading = false;
  private readonly pendingChangedFiles = new Set<string>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private structureRefreshTimer: NodeJS.Timeout | undefined;
  private changedFileTimer: NodeJS.Timeout | undefined;
  private activeMetadataTasks = 0;
  private activeIconTasks = 0;
  private activePreviewPanelRequestId = '';
  private activePreviewElement: UnpackExplorerEntry | undefined;
  private activeEditorPreviewPath = '';
  private editorPreviewTimer: NodeJS.Timeout | undefined;
  private pendingReveal: UnpackExplorerReveal | undefined;
  private generation = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly comments: PvfTreeCommentService,
    private readonly output?: vscode.OutputChannel,
    metadata?: UnpackMetadataService,
  ) {
    this.metadata = metadata || new UnpackMetadataService(context, output);
    this.preview = new UnpackPreviewService(this.metadata, context, output);
    this.previewPanel = new UnpackHoverPreviewPanel(context);
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        void this.onActiveTextEditorChanged(editor);
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        void this.onTextDocumentSaved(document);
      }),
      vscode.workspace.onDidCreateFiles(event => {
        void this.scheduleExplorerFileOperationRefresh(event.files);
      }),
      vscode.workspace.onDidDeleteFiles(event => {
        void this.scheduleExplorerFileOperationRefresh(event.files);
      }),
      vscode.workspace.onDidRenameFiles(event => {
        void this.scheduleExplorerFileOperationRefresh(event.files.flatMap(item => [item.oldUri, item.newUri]));
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.refresh();
      }),
    );
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
    startTiming('resolveWebviewView init');
    void this.postRoots().then(() => {
      startTiming('postRoots done → preloadUnpackTree');
      this.syncActiveEditorToExplorer(false);
      void this.preloadUnpackTree().finally(() => {
        endTiming('preloadUnpackTree', this.output);
        flushTimings(this.output);
        endTiming('resolveWebviewView init', this.output);
      });
    });
  }

  refresh(): void {
    this.generation++;
    this.rootsCache = undefined;
    this.metadata.clear();
    this.preview.clear();
    this.entriesById.clear();
    this.dirChildrenCache.clear();
    this.preloading = false;
    this.metadataQueue.length = 0;
    this.iconQueue.length = 0;
    this.metadataQueued.clear();
    this.iconQueued.clear();
    this.pendingRows.clear();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    if (this.structureRefreshTimer) clearTimeout(this.structureRefreshTimer);
    this.structureRefreshTimer = undefined;
    if (this.changedFileTimer) clearTimeout(this.changedFileTimer);
    this.changedFileTimer = undefined;
    this.pendingChangedFiles.clear();
    this.activeMetadataTasks = 0;
    this.activeIconTasks = 0;
    this.activePreviewElement = undefined;
    this.activeEditorPreviewPath = '';
    if (this.editorPreviewTimer) clearTimeout(this.editorPreviewTimer);
    this.editorPreviewTimer = undefined;
    this.pendingReveal = undefined;
    void this.postRoots().then(() => this.syncActiveEditorToExplorer(false));
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
    if (type === 'preview') {
      await this.postPreview(id, element, record);
      return;
    }
    if (type === 'previewCancel') {
      const requestId = typeof record.requestId === 'string' ? record.requestId : '';
      if (!requestId || this.activePreviewPanelRequestId === requestId) this.activePreviewPanelRequestId = '';
      return;
    }
    if (!element) return;
    if (type === 'open') {
      if (!element.isDirectory) {
        if (this.shouldOpenPreviewWithTextEditor() && this.canPreviewElement(element)) await this.openFileWithPreview(element);
        else await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(element.fsPath));
      }
      return;
    }
    if (type === 'showPreview') {
      if (!element.isDirectory) await this.openFileWithPreview(element);
      return;
    }
    if (type === 'openPreviewSkill') {
      if (!element.isDirectory) await this.openPreviewSkill(element, record);
      return;
    }
    if (type === 'openPreviewLine') {
      if (!element.isDirectory) await this.openPreviewLine(element, record);
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

  private async postPreview(id: string, element: UnpackExplorerEntry | undefined, record: Record<string, unknown>): Promise<void> {
    const view = this.webviewView;
    if (!view) return;
    const requestId = typeof record.requestId === 'string' ? record.requestId : '';
    const location = typeof record.location === 'string' ? record.location : 'inline';
    const usePanel = location === 'editorPanel';
    const resolvePreviewIcon = usePanel || location === 'inline';
    const renderRichPreview = usePanel;
    const showLoading = record.showLoading === true;
    const enabled = configBool('pvf.unpackExplorer.hoverPreview.enabled', true);
    if (!enabled || !element || element.isDirectory) {
      if (usePanel && this.activePreviewPanelRequestId === requestId) this.activePreviewPanelRequestId = '';
      await view.webview.postMessage({ type: 'preview', id, requestId, preview: undefined });
      return;
    }
    const generation = this.generation;
    if (usePanel) {
      this.activePreviewPanelRequestId = requestId;
      if (showLoading) this.previewPanel.showLoading(element.name, element.key);
    }
    const preview = await this.preview.resolvePreview(element, { resolveIcon: resolvePreviewIcon, renderRich: renderRichPreview }).catch((err: any) => {
      this.output?.appendLine(`[PVF] failed to build hover preview ${element.key}: ${String(err && err.message || err)}`);
      return undefined;
    });
    if (!this.webviewView || generation !== this.generation) return;
    const previewWithText = preview ? { ...preview, text: previewText(preview) } : undefined;
    if (usePanel) {
      if (this.activePreviewPanelRequestId !== requestId) {
        await view.webview.postMessage({ type: 'preview', id, requestId, preview: previewWithText });
        return;
      }
      this.activePreviewPanelRequestId = '';
      if (previewWithText) {
        this.previewPanel.show(previewWithText);
      } else if (showLoading) {
        this.previewPanel.clear('此文件没有可用的解包预览。');
      }
    }
    await view.webview.postMessage({ type: 'preview', id, requestId, preview: previewWithText });
  }

  private async openFileWithPreview(element: UnpackExplorerEntry): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(element.fsPath));
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      preview: true,
    });
    await this.showPreviewPanelForElement(element, true);
  }

  private async openPreviewSkill(element: UnpackExplorerEntry, record: Record<string, unknown>): Promise<void> {
    const key = typeof record.key === 'string' ? normalizeUnpackKey(record.key) : '';
    const code = typeof record.code === 'number' ? record.code : undefined;
    if (!key && typeof code !== 'number') return;
    const preview = await this.preview.resolvePreview(element, { resolveIcon: false }).catch((err: any) => {
      this.output?.appendLine(`[PVF] failed to resolve inline skill tree click ${element.key}: ${String(err && err.message || err)}`);
      return undefined;
    });
    const node = findPreviewSkillNode(preview, key, code);
    if (!node?.fsPath) {
      vscode.window.showWarningMessage('无法跳转：这个技能节点没有解析到对应的 .skl 文件。');
      return;
    }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(node.fsPath));
  }

  private async openPreviewLine(element: UnpackExplorerEntry, record: Record<string, unknown>): Promise<void> {
    const line = typeof record.line === 'number' ? Math.floor(record.line) : -1;
    const character = typeof record.character === 'number' ? Math.floor(record.character) : 0;
    if (!Number.isInteger(line) || line < 0) return;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(element.fsPath));
      const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One, false);
      const boundedLine = Math.max(0, Math.min(line, document.lineCount - 1));
      const lineText = document.lineAt(boundedLine).text;
      const boundedCharacter = Math.max(0, Math.min(character, lineText.length));
      const position = new vscode.Position(boundedLine, boundedCharacter);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (err: any) {
      vscode.window.showWarningMessage(`无法跳转到行 ${line + 1}: ${String(err && err.message || err)}`);
    }
  }

  private async showPreviewPanelForElement(element: UnpackExplorerEntry, preserveFocus: boolean): Promise<void> {
    this.activePreviewElement = element;
    this.activeEditorPreviewPath = path.resolve(element.fsPath);
    this.activePreviewPanelRequestId = '';
    this.previewPanel.showLoading(element.name, element.key, preserveFocus);
    const preview = await this.preview.resolvePreview(element, { resolveIcon: true, renderRich: true }).catch((err: any) => {
      this.output?.appendLine(`[PVF] failed to build unpack preview panel ${element.key}: ${String(err && err.message || err)}`);
      return undefined;
    });
    if (preview) {
      this.previewPanel.show({ ...preview, text: previewText(preview) }, preserveFocus);
    } else {
      this.previewPanel.clear('此文件没有可用的解包预览。');
    }
  }

  private canPreviewElement(element: UnpackExplorerEntry): boolean {
    if (element.isDirectory) return false;
    const key = normalizeUnpackKey(element.key || element.name).toLowerCase();
    if (key.endsWith('.ani') || key.endsWith('.equ') || key.endsWith('.stk') || key.endsWith('.shp') || key.endsWith('.qst') || key.endsWith('.skl')) return true;
    if (/^clientonly\/skilltree\/.+_(sp|tp)\.co$/i.test(key)) return true;
    if (/^clientonly\/skillshoptree(sp|tp)index\.co$/i.test(key)) return true;
    if (/^etc\/pvpskilltree\/.+\.etc$/i.test(key)) return true;
    if (key.endsWith('.co') || key.endsWith('.etc')) return true;
    return false;
  }

  private async onActiveTextEditorChanged(editor: vscode.TextEditor | undefined): Promise<void> {
    const uri = editor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      this.pendingReveal = undefined;
      return;
    }
    const fsPath = path.resolve(uri.fsPath);
    if (this.editorPreviewTimer) clearTimeout(this.editorPreviewTimer);
    this.editorPreviewTimer = setTimeout(() => {
      this.editorPreviewTimer = undefined;
      void this.syncDiskFileWithExplorer(fsPath, true, false, true);
    }, 120);
  }

  private syncActiveEditorToExplorer(openPreview: boolean): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      this.pendingReveal = undefined;
      return;
    }
    void this.syncDiskFileWithExplorer(path.resolve(uri.fsPath), openPreview, false, true);
  }

  private async onTextDocumentSaved(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') return;
    const fsPath = path.resolve(document.uri.fsPath);
    this.scheduleChangedFileSync(fsPath);
    if (!this.shouldOpenPreviewWithTextEditor() && !this.activePreviewElement) return;
    const activePath = this.activePreviewElement ? path.resolve(this.activePreviewElement.fsPath) : '';
    if (activePath && activePath === fsPath) {
      await this.syncDiskFileWithExplorer(fsPath, true, true);
      return;
    }
    const activeEditor = vscode.window.activeTextEditor?.document.uri;
    if (activeEditor?.scheme === 'file' && path.resolve(activeEditor.fsPath) === fsPath) {
      await this.syncDiskFileWithExplorer(fsPath, true, true);
    }
  }

  private scheduleStructureRefresh(_reason = ''): void {
    if (this.structureRefreshTimer) clearTimeout(this.structureRefreshTimer);
    this.structureRefreshTimer = setTimeout(() => {
      this.structureRefreshTimer = undefined;
      this.refresh();
    }, 160);
  }

  private async scheduleExplorerFileOperationRefresh(uris: readonly vscode.Uri[]): Promise<void> {
    const fileUris = uris.filter(uri => uri.scheme === 'file');
    if (fileUris.length === 0) return;
    if (fileUris.some(uri => path.basename(uri.fsPath).toLowerCase() === PVF_MANIFEST_FILE.toLowerCase())) {
      this.scheduleStructureRefresh('manifest');
      return;
    }
    const roots = await readUnpackExplorerRoots(this.context).catch((err: any) => {
      this.output?.appendLine(`[PVF] failed to read unpack roots for file operation sync: ${String(err && err.message || err)}`);
      return [] as string[];
    });
    const affectsRoot = fileUris.some(uri => roots.some(root => pathContains(root, uri.fsPath)));
    if (affectsRoot) this.scheduleStructureRefresh('explorer-file-operation');
  }

  private scheduleChangedFileSync(fsPath: string): void {
    const resolved = path.resolve(fsPath);
    if (path.basename(resolved).toLowerCase() === PVF_MANIFEST_FILE.toLowerCase()) {
      this.scheduleStructureRefresh(`manifest:${resolved}`);
      return;
    }
    this.pendingChangedFiles.add(resolved);
    if (this.changedFileTimer) clearTimeout(this.changedFileTimer);
    this.changedFileTimer = setTimeout(() => {
      this.changedFileTimer = undefined;
      const files = Array.from(this.pendingChangedFiles);
      this.pendingChangedFiles.clear();
      void this.syncChangedDiskFiles(files);
    }, 120);
  }

  private async syncChangedDiskFiles(files: string[]): Promise<void> {
    let needsFullRefresh = false;
    const changedElements: UnpackExplorerEntry[] = [];
    for (const fsPath of files) {
      const element = await this.entryFromDiskFile(fsPath);
      if (!element) continue;
      if (affectsSharedUnpackMetadata(element.key)) {
        needsFullRefresh = true;
        break;
      }
      this.metadata.invalidate(element);
      this.preview.invalidate(element);
      changedElements.push(element);
    }
    if (needsFullRefresh) {
      this.refresh();
      return;
    }
    for (const element of changedElements) this.queueRowRefresh(element);
  }

  private async syncDiskFileWithExplorer(fsPath: string, openPreview: boolean, forceRefresh: boolean, requireActive = false): Promise<void> {
    const resolved = path.resolve(fsPath);
    const element = await this.entryFromDiskFile(resolved);
    if (requireActive && !this.isActiveDiskFile(resolved)) return;
    if (!element) {
      this.pendingReveal = undefined;
      return;
    }
    await this.revealElement(element);
    if (!openPreview || !this.shouldOpenPreviewWithTextEditor() || !this.canPreviewElement(element)) return;
    if (!forceRefresh && this.activeEditorPreviewPath === resolved) return;
    this.activeEditorPreviewPath = resolved;
    if (forceRefresh) {
      this.metadata.invalidate(element);
      this.preview.invalidate(element);
      this.queueRowRefresh(element);
    }
    await this.showPreviewPanelForElement(element, true);
  }

  private isActiveDiskFile(fsPath: string): boolean {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return !!uri && uri.scheme === 'file' && path.resolve(uri.fsPath) === path.resolve(fsPath);
  }

  private shouldOpenPreviewWithTextEditor(): boolean {
    return configBool('pvf.unpackExplorer.preview.openWithTextEditor', true);
  }

  private async entryFromDiskFile(fsPath: string): Promise<UnpackExplorerEntry | undefined> {
    const resolved = path.resolve(fsPath);
    let roots: UnpackExplorerEntry[];
    try {
      roots = await this.getRoots();
    } catch (err: any) {
      this.output?.appendLine(`[PVF] failed to resolve unpack roots for preview ${resolved}: ${String(err && err.message || err)}`);
      return undefined;
    }
    const root = roots
      .filter(item => pathContains(item.fsPath, resolved))
      .sort((a, b) => b.fsPath.length - a.fsPath.length)[0];
    if (!root) return undefined;
    const relative = path.relative(root.fsPath, resolved);
    if (!relative || relative === PVF_MANIFEST_FILE) return undefined;
    return {
      fsPath: resolved,
      key: normalizeTreeCommentPath(relative),
      name: path.basename(resolved),
      isDirectory: false,
      root: root.fsPath,
      version: root.version,
    };
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
    await this.postPendingReveal();
  }

  private async preloadUnpackTree(): Promise<void> {
    if (this.preloading) return;
    this.preloading = true;
    startTiming('preloadUnpackTree');
    try {
      const roots = await this.getRoots();
      const concurrency = 8;
      for (const root of roots) {
        await this.preloadDir(root);
        const children = this.dirChildrenCache.get(stableId(root));
        if (children) {
          const dirs = children.filter(c => c.isDirectory);
          // 并发 preloadDir，限制 concurrency 避免 fd 耗尽
          let i = 0;
          const next = (): Promise<void> => {
            if (i >= dirs.length) return Promise.resolve();
            const dir = dirs[i++];
            return this.preloadDir(dir).then(next);
          };
          const workers: Promise<void>[] = [];
          for (let w = 0; w < Math.min(concurrency, dirs.length); w++) workers.push(next());
          await Promise.all(workers);
        }
      }
    } catch { /* 预载是后台任务，失败不影响核心功能 */ }
    this.preloading = false;
  }

  private async postChildren(parent: UnpackExplorerEntry): Promise<void> {
    startTiming('postChildren');
    const view = this.webviewView;
    if (!view) return;
    const generation = this.generation;
    let entries = this.dirChildrenCache.get(stableId(parent));
    if (!entries) {
      try {
        startTiming('getChildren (uncached)');
        entries = await this.getChildren(parent);
        endTiming('getChildren (uncached)', this.output);
      } catch (err: any) {
        this.output?.appendLine(`[PVF] failed to read unpack dir ${parent.fsPath}: ${String(err && err.message || err)}`);
      }
      if (!this.webviewView || generation !== this.generation) {
        endTiming('postChildren', this.output);
        return;
      }
      if (entries) {
        for (const entry of entries) this.entriesById.set(stableId(entry), entry);
        this.dirChildrenCache.set(stableId(parent), entries);
      }
    }
    if (!entries) { endTiming('postChildren', this.output); return; }
    const batchSize = 500;
    if (entries.length > batchSize) {
      // 大批量时分批发送，避免单次 JSON.stringify block 事件循环
      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        const rows = batch.map(entry => this.rowFor(entry));
        await view.webview.postMessage({
          type: 'appendChildren',
          id: stableId(parent),
          rows,
          total: entries.length,
          offset: i,
        });
        // 每批让出事件循环
        await new Promise(r => setTimeout(r, 0));
      }
    } else {
      const rows = entries.map(entry => this.rowFor(entry));
      await view.webview.postMessage({
        type: 'children',
        id: stableId(parent),
        rows,
        total: entries.length,
      });
    }
    endTiming('postChildren', this.output);
  }

  private async preloadDir(entry: UnpackExplorerEntry): Promise<void> {
    const id = stableId(entry);
    if (this.dirChildrenCache.has(id)) return;
    try {
      const children = await this.getChildren(entry);
      for (const child of children) this.entriesById.set(stableId(child), child);
      this.dirChildrenCache.set(id, children);
    } catch { /* ignore */ }
  }

  private async revealElement(element: UnpackExplorerEntry): Promise<void> {
    const reveal = this.revealForElement(element);
    this.pendingReveal = reveal;
    await this.postPendingReveal();
  }

  private revealForElement(element: UnpackExplorerEntry): UnpackExplorerReveal {
    const pathIds: string[] = [];
    const rootEntry: UnpackExplorerEntry = {
      fsPath: element.root,
      key: '',
      name: path.basename(path.resolve(element.root)) || element.root,
      isDirectory: true,
      root: element.root,
      version: element.version,
    };
    pathIds.push(stableId(rootEntry));
    const segments = normalizeTreeCommentPath(element.key).split('/').filter(Boolean);
    let key = '';
    let fsPath = element.root;
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      key = key ? `${key}/${segment}` : segment;
      fsPath = path.join(fsPath, segment);
      pathIds.push(stableId({
        fsPath,
        key,
        name: segment,
        isDirectory: index < segments.length - 1 || element.isDirectory,
        root: element.root,
        version: element.version,
      }));
    }
    return {
      targetId: pathIds[pathIds.length - 1],
      pathIds,
      key: element.key,
      fsPath: element.fsPath,
    };
  }

  private async postPendingReveal(): Promise<void> {
    const view = this.webviewView;
    const reveal = this.pendingReveal;
    if (!view || !reveal) return;
    await view.webview.postMessage({
      type: 'reveal',
      targetId: reveal.targetId,
      pathIds: reveal.pathIds,
      key: reveal.key,
      fsPath: reveal.fsPath,
    });
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
      ...(typeof metadata?.skillClass === 'number' ? { skillClass: metadata.skillClass } : {}),
      ...(metadata?.skillClassText ? { skillClassText: metadata.skillClassText } : {}),
      ...(metadata?.skillKind ? { skillKind: metadata.skillKind } : {}),
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
    const limit = 3;
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
      metadata?.skillKind ? `技能类型: ${skillKindLabel(metadata.skillKind)}` : undefined,
      typeof metadata?.skillClass === 'number' ? `技能类: ${metadata.skillClassText || metadata.skillClass}` : undefined,
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
    const hoverPreviewEnabled = configBool('pvf.unpackExplorer.hoverPreview.enabled', true);
    const hoverPreviewDelayMs = Math.max(0, Math.min(2000, vscode.workspace.getConfiguration().get<number>('pvf.unpackExplorer.hoverPreview.delayMs', 350) || 350));
    const rawHoverPreviewLocation = vscode.workspace.getConfiguration().get<string>('pvf.unpackExplorer.hoverPreview.location', 'nativeTooltip');
    const hoverPreviewLocation = rawHoverPreviewLocation === 'inline' || rawHoverPreviewLocation === 'editorPanel'
      ? rawHoverPreviewLocation
      : 'nativeTooltip';
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
  --skill-active-color: var(--vscode-pvf-skillActiveForeground, #ffe88c);
  --skill-passive-color: var(--vscode-pvf-skillPassiveForeground, #aee080);
  --skill-common-color: var(--vscode-pvf-skillCommonForeground, #0096ff);
  --skill-guild-color: var(--vscode-pvf-skillGuildForeground, #ffafff);
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
.skill-class { color: var(--number-color); }
.skill-active { color: var(--skill-active-color); }
.skill-passive { color: var(--skill-passive-color); }
.skill-common { color: var(--skill-common-color); }
.skill-guild { color: var(--skill-guild-color); }
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
.hover-preview {
  position: fixed;
  z-index: 900;
  display: grid;
  grid-template-columns: minmax(280px, 360px);
  gap: 8px;
  width: max-content;
  max-width: calc(100vw - 16px);
  overflow: visible;
  color: #ded8ca;
  font: 12px/1.42 var(--vscode-font-family);
  user-select: text;
  pointer-events: auto;
}
.hover-preview.split {
  grid-template-columns: repeat(2, minmax(280px, 360px));
}
.hover-preview.skill-tree {
  grid-template-columns: minmax(420px, min(760px, calc(100vw - 16px)));
}
.hover-preview.skill {
  grid-template-columns: minmax(360px, 620px);
}
.hover-preview.skill-tree.split {
  grid-template-columns: repeat(2, minmax(340px, 420px));
}
.hover-preview.hidden { display: none; }
.preview-frame {
  min-width: 0;
  padding: 8px 9px 9px;
  background:
    linear-gradient(180deg, rgba(38,42,56,.82), rgba(10,11,17,.96) 34px, rgba(5,6,10,.98)),
    #07080c;
  border: 1px solid #74716a;
  box-shadow: 0 8px 22px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.05);
}
.preview-loading {
  color: var(--vscode-descriptionForeground);
  padding: 4px 2px;
}
.preview-head {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 8px;
  align-items: start;
  min-height: 34px;
}
.preview-icon {
  width: 32px;
  height: 32px;
  border: 1px solid #4a4a4a;
  background: #1b1b1b;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #777;
}
.preview-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
.preview-title {
  font-size: 14px;
  line-height: 1.25;
  font-weight: 600;
  color: #f1f1f1;
  overflow-wrap: anywhere;
}
.preview-title.rarity-0 { color: var(--rarity-0); }
.preview-title.rarity-1 { color: var(--rarity-1); }
.preview-title.rarity-2 { color: var(--rarity-2); }
.preview-title.rarity-3 { color: var(--rarity-3); }
.preview-title.rarity-4 { color: var(--rarity-4); }
.preview-title.rarity-5 { color: var(--rarity-5); }
.preview-title.rarity-6 { color: var(--rarity-6); }
.preview-title.rarity-7 { color: var(--rarity-7); }
.preview-subtitle {
  margin-top: 2px;
  color: #aaa39a;
  font-size: 11px;
}
.preview-badges {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.preview-badge {
  border: 1px solid #5f574a;
  color: #d5be7a;
  padding: 0 5px;
  font-size: 10px;
}
.preview-path {
  margin-top: 6px;
  color: #777;
  font-size: 10px;
  overflow-wrap: anywhere;
}
.preview-sep {
  height: 1px;
  background: #303033;
  margin: 7px 0;
}
.preview-section {
  margin-top: 7px;
}
.preview-section-title {
  color: #d9c27a;
  font-size: 11px;
  margin-bottom: 3px;
}
.preview-section.blue .preview-line,
.preview-section.blue .preview-field-value,
.preview-section.skill .preview-line,
.preview-section.skill .preview-field-value {
  color: #7db4ff;
}
.preview-section.flavor .preview-line {
  color: #8c8c8c;
}
.preview-section.set .preview-line,
.preview-section.set .preview-entry-name {
  color: #d4b1ff;
}
.preview-field {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 8px;
  min-height: 16px;
}
.preview-field-label {
  color: #9b948b;
}
.preview-field-value {
  color: #e1ded8;
  overflow-wrap: anywhere;
}
.preview-field-value.magic { color: #77aaff; }
.preview-line {
  white-space: pre-wrap;
  color: #ddd8cc;
  overflow-wrap: anywhere;
}
.preview-table-caption {
  margin: 6px 0 3px;
  color: #b7b0a4;
  font-size: 10px;
}
.preview-table-wrap {
  max-width: 100%;
  max-height: 220px;
  overflow: auto;
  border: 1px solid #343943;
  background: rgba(7, 9, 14, .42);
}
.preview-table {
  min-width: 100%;
  width: max-content;
  border-collapse: collapse;
  font-size: 11px;
  line-height: 1.35;
}
.preview-table th,
.preview-table td {
  border-right: 1px solid #303641;
  border-bottom: 1px solid #303641;
  padding: 2px 6px;
  white-space: nowrap;
  text-align: left;
}
.preview-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  color: #d9c27a;
  background: #171b24;
}
.preview-table td {
  color: #d6dfef;
}
.preview-table td:first-child {
  color: #aaa39a;
}
.preview-table-link {
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.preview-table-link:hover {
  color: #d9c27a;
  text-decoration: underline;
}
.preview-entry {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 6px;
  align-items: center;
  min-height: 26px;
  padding: 2px 0;
}
.preview-entry-icon {
  width: 24px;
  height: 24px;
  border: 1px solid #383838;
  background: #171717;
  display: flex;
  align-items: center;
  justify-content: center;
}
.preview-entry-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
.preview-entry-name {
  color: #e8e0d0;
  overflow-wrap: anywhere;
}
.preview-entry-detail {
  color: #8f8f8f;
  font-size: 10px;
  overflow-wrap: anywhere;
}
.preview-minimap {
  position: relative;
  height: 130px;
  border: 1px solid #3f3f45;
  background:
    linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px),
    #111318;
  background-size: 24px 24px;
  margin-top: 7px;
  overflow: hidden;
}
.preview-map-point {
  position: absolute;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: #4da3ff;
  box-shadow: 0 0 5px rgba(77,163,255,.7);
}
.preview-map-point.unresolved { background: #6a6a6a; box-shadow: none; }
.preview-map-point.common { background: #d8b657; box-shadow: 0 0 5px rgba(216,182,87,.7); }
.skill-tree-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 8px;
}
.skill-tree-card {
  min-width: 0;
  border: 1px solid #4f4b41;
  background:
    linear-gradient(rgba(255,255,255,.028) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.024) 1px, transparent 1px),
    #0d0f15;
  background-size: 36px 36px;
}
.skill-tree-title {
  height: 24px;
  padding: 4px 8px;
  border-bottom: 1px solid #38352f;
  color: #d9c27a;
  background: rgba(0,0,0,.34);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-tree-canvas {
  position: relative;
  height: var(--skill-tree-height, 280px);
  min-height: 210px;
  overflow: hidden;
}
.skill-tree-lines {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.skill-tree-line {
  stroke: rgba(132, 147, 168, .44);
  stroke-width: 1.5;
}
.skill-tree-node {
  position: absolute;
  left: var(--node-left);
  top: var(--node-top);
  width: 34px;
  height: 34px;
  padding: 1px;
  transform: translate(-50%, -50%);
  border: 1px solid #84735a;
  background: #111;
  font: inherit;
  appearance: none;
  box-shadow: 0 1px 0 rgba(255,255,255,.12) inset, 0 4px 10px rgba(0,0,0,.45);
}
.skill-tree-node.resolved {
  cursor: pointer;
}
.skill-tree-node.common {
  border-color: #d8b657;
}
.skill-tree-node.unresolved {
  border-color: #575757;
  background: #1b1b1b;
  color: #8b8b8b;
}
.skill-tree-node:hover {
  outline: 1px solid #e4c66f;
  z-index: 2;
}
.skill-tree-node img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
.skill-tree-fallback {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  color: #aaa39a;
  font-size: 10px;
  line-height: 1;
}
</style>
</head>
<body>
<div id="tree" role="tree" aria-label="解包目录"></div>
<script nonce="${n}">
window.__PVF_UNPACK_CONFIG__ = ${JSON.stringify({ showComment, showItemName, showItemCode })};
window.__PVF_UNPACK_HOVER__ = ${JSON.stringify({ enabled: hoverPreviewEnabled, delayMs: hoverPreviewDelayMs, location: hoverPreviewLocation })};
</script>
<script src="${scriptUri}" nonce="${n}"></script>
</body>
</html>`;
  }
}
