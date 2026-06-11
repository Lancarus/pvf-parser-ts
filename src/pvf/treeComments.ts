import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PvfFileEntry, PvfModel } from './model';
import bundledTreeComments from './resources/treeComments.json';

export interface PvfTreeCommentEntry {
  comment?: string;
  detailedComment?: string;
}

interface PersistedTreeCommentFile {
  schemaVersion?: number;
  version?: number | string;
  comments?: Record<string, PvfTreeCommentEntry | string | null>;
  versions?: Record<string, {
    comments?: Record<string, PvfTreeCommentEntry | string | null>;
  } | Record<string, PvfTreeCommentEntry | string | null>>;
}

export function normalizeTreeCommentPath(value: string): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}

function normalizeEntry(value: unknown): PvfTreeCommentEntry | undefined {
  if (typeof value === 'string') {
    const comment = value.trim();
    return comment ? { comment } : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  const comment = typeof rec.comment === 'string' ? rec.comment.trim() : '';
  const detailedComment = typeof rec.detailedComment === 'string' ? rec.detailedComment.trim() : '';
  if (!comment && !detailedComment) return undefined;
  return {
    ...(comment ? { comment } : {}),
    ...(detailedComment ? { detailedComment } : {}),
  };
}

function normalizeCommentMap(source: Record<string, unknown> | undefined): Map<string, PvfTreeCommentEntry> {
  const result = new Map<string, PvfTreeCommentEntry>();
  if (!source) return result;
  for (const [rawKey, rawEntry] of Object.entries(source)) {
    const key = normalizeTreeCommentPath(rawKey);
    const entry = normalizeEntry(rawEntry);
    if (key && entry) result.set(key, entry);
  }
  return result;
}

function commentMapsEqual(left: PvfTreeCommentEntry | undefined, right: PvfTreeCommentEntry | undefined): boolean {
  return (left?.comment || '') === (right?.comment || '')
    && (left?.detailedComment || '') === (right?.detailedComment || '');
}

function mapToJson(comments: Map<string, PvfTreeCommentEntry>): Record<string, PvfTreeCommentEntry> {
  const out: Record<string, PvfTreeCommentEntry> = {};
  for (const [key, entry] of comments) out[key] = entry;
  return out;
}

function serializeVersion(value: string): string | number {
  const n = Number(value);
  return Number.isFinite(n) && String(Math.trunc(n)) === value ? Math.trunc(n) : value;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, '\\`');
}

export function normalizeTreeCommentVersion(value: unknown): string {
  const n = Number(value);
  if (Number.isFinite(n)) return String(Math.trunc(n));
  const text = String(value || '').trim();
  return text || '0';
}

export class PvfTreeCommentService {
  private baseVersion = normalizeTreeCommentVersion((bundledTreeComments as PersistedTreeCommentFile).version ?? 0);
  private baseComments = normalizeCommentMap((bundledTreeComments as PersistedTreeCommentFile).comments as Record<string, unknown>);
  private readonly overrideCommentsByVersion = new Map<string, Map<string, PvfTreeCommentEntry>>();
  private treeCommentFilePath: string | undefined;
  private loaded = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly model: PvfModel,
    private readonly output?: vscode.OutputChannel,
  ) {}

  async load(): Promise<void> {
    try {
      const data = await this.readTreeCommentFile();
      this.applyTreeCommentFile(data);
    } catch (err: any) {
      this.applyTreeCommentFile(bundledTreeComments as PersistedTreeCommentFile);
      this.output?.appendLine(`[PVF] failed to load tree comments: ${String(err && err.message || err)}`);
    } finally {
      try {
        await this.migrateLegacyUserFile();
      } catch (err: any) {
        this.output?.appendLine(`[PVF] failed to migrate legacy tree comments: ${String(err && err.message || err)}`);
      }
      this.loaded = true;
    }
  }

  currentVersionKey(): string {
    return normalizeTreeCommentVersion(this.model.fileVersion || 0);
  }

  getEntry(key: string): PvfTreeCommentEntry | undefined {
    return this.getEntryForVersion(key, this.currentVersionKey());
  }

  getEntryForVersion(key: string, version: unknown): PvfTreeCommentEntry | undefined {
    const normalizedKey = normalizeTreeCommentPath(key);
    if (!normalizedKey) return undefined;
    const versionKey = normalizeTreeCommentVersion(version);
    const userEntry = this.overrideCommentsByVersion.get(versionKey)?.get(normalizedKey);
    if (userEntry) return userEntry;
    if (this.baseVersion === '0' || this.baseVersion === versionKey) {
      return this.baseComments.get(normalizedKey);
    }
    return undefined;
  }

  getComment(key: string): string | undefined {
    const comment = this.getEntry(key)?.comment?.trim();
    return comment || undefined;
  }

  getCommentForVersion(key: string, version: unknown): string | undefined {
    const comment = this.getEntryForVersion(key, version)?.comment?.trim();
    return comment || undefined;
  }

  getDescription(key: string): string | undefined {
    const comment = this.getComment(key);
    return comment ? `(${comment})` : undefined;
  }

  getTooltip(element: PvfFileEntry): vscode.MarkdownString | undefined {
    const entry = this.getEntry(element.key);
    if (!entry && element.isFile) return undefined;
    const args = encodeURIComponent(JSON.stringify([{
      key: element.key,
      name: element.name,
      isFile: element.isFile,
    }]));
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = { enabledCommands: ['pvf.editTreeComment'] };
    md.appendMarkdown(`**${escapeMarkdown(element.name)}**\n\n`);
    md.appendMarkdown(`路径: \`${escapeInlineCode(element.key)}\``);
    if (entry?.comment) md.appendMarkdown(`\n\n注释: ${escapeMarkdown(entry.comment)}`);
    if (entry?.detailedComment) md.appendMarkdown(`\n\n${escapeMarkdown(entry.detailedComment)}`);
    md.appendMarkdown(`\n\n版本: \`${escapeInlineCode(this.currentVersionKey())}\``);
    if (!element.isFile) {
      md.supportThemeIcons = true;
      md.appendMarkdown(`\n\n[$(edit) 编辑注释](command:pvf.editTreeComment?${args})`);
    }
    return md;
  }

  async setComment(key: string, comment: string): Promise<void> {
    return this.setCommentForVersion(key, comment, this.currentVersionKey());
  }

  async setCommentForVersion(key: string, comment: string, version: unknown): Promise<void> {
    const normalizedKey = normalizeTreeCommentPath(key);
    if (!normalizedKey) throw new Error('路径为空，无法保存注释。');
    if (!this.loaded) await this.load();
    const versionKey = normalizeTreeCommentVersion(version);
    const text = comment.trim();
    if (text) {
      let comments = this.overrideCommentsByVersion.get(versionKey);
      if (!comments) {
        comments = new Map<string, PvfTreeCommentEntry>();
        this.overrideCommentsByVersion.set(versionKey, comments);
      }
      const existing = this.getEntryForVersion(normalizedKey, versionKey);
      comments.set(normalizedKey, {
        comment: text,
        ...(existing?.detailedComment ? { detailedComment: existing.detailedComment } : {}),
      });
    } else {
      const comments = this.overrideCommentsByVersion.get(versionKey);
      comments?.delete(normalizedKey);
      if (comments && comments.size === 0) this.overrideCommentsByVersion.delete(versionKey);
    }
    await this.save();
  }

  private legacyUserFilePath(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'tree-comments.user.json');
  }

  private async resourceFilePath(): Promise<string> {
    if (this.treeCommentFilePath) return this.treeCommentFilePath;
    const extensionRoot = this.context.extensionUri.fsPath;
    const candidates = [
      path.join(extensionRoot, 'src', 'pvf', 'resources', 'treeComments.json'),
      path.join(extensionRoot, 'dist', 'pvf', 'resources', 'treeComments.json'),
      path.join(__dirname, 'resources', 'treeComments.json'),
    ];
    const uniqueCandidates = [...new Set(candidates.map(candidate => path.resolve(candidate)))];
    for (const candidate of uniqueCandidates) {
      if (await fileExists(candidate)) {
        this.treeCommentFilePath = candidate;
        return candidate;
      }
    }
    this.treeCommentFilePath = uniqueCandidates[0];
    return this.treeCommentFilePath;
  }

  private async readTreeCommentFile(): Promise<PersistedTreeCommentFile> {
    const file = await this.resourceFilePath();
    return JSON.parse(await fs.readFile(file, 'utf8')) as PersistedTreeCommentFile;
  }

  private applyTreeCommentFile(data: PersistedTreeCommentFile): void {
    this.baseVersion = normalizeTreeCommentVersion(data.version ?? 0);
    this.baseComments = normalizeCommentMap(data.comments as Record<string, unknown>);
    this.overrideCommentsByVersion.clear();
    this.mergeVersionOverrides(data);
  }

  private mergeVersionOverrides(data: PersistedTreeCommentFile): boolean {
    let changed = false;
    const versions = data.versions || {};
    for (const [version, versionData] of Object.entries(versions)) {
      if (!versionData || typeof versionData !== 'object') continue;
      const comments = 'comments' in versionData
        ? (versionData as { comments?: Record<string, unknown> }).comments
        : versionData as Record<string, unknown>;
      const normalized = normalizeCommentMap(comments);
      if (normalized.size === 0) continue;
      const versionKey = normalizeTreeCommentVersion(version);
      let target = this.overrideCommentsByVersion.get(versionKey);
      if (!target) {
        target = new Map<string, PvfTreeCommentEntry>();
        this.overrideCommentsByVersion.set(versionKey, target);
      }
      for (const [key, entry] of normalized) {
        if (!commentMapsEqual(target.get(key), entry)) changed = true;
        target.set(key, entry);
      }
    }
    return changed;
  }

  private async migrateLegacyUserFile(): Promise<void> {
    let data: PersistedTreeCommentFile;
    const legacyFile = this.legacyUserFilePath();
    try {
      data = JSON.parse(await fs.readFile(legacyFile, 'utf8')) as PersistedTreeCommentFile;
    } catch (err: any) {
      if (err && err.code !== 'ENOENT') {
        this.output?.appendLine(`[PVF] failed to migrate legacy tree comments: ${String(err && err.message || err)}`);
      }
      return;
    }

    const changed = this.mergeVersionOverrides(data);
    if (changed) {
      await this.save();
      this.output?.appendLine(`[PVF] migrated legacy tree comments into ${await this.resourceFilePath()}`);
    }
    await this.renameLegacyUserFile(legacyFile);
  }

  private async renameLegacyUserFile(legacyFile: string): Promise<void> {
    const parsed = path.parse(legacyFile);
    const backup = path.join(parsed.dir, `${parsed.name}.migrated-${Date.now()}${parsed.ext}`);
    try {
      await fs.rename(legacyFile, backup);
    } catch (err: any) {
      if (err && err.code !== 'ENOENT') {
        this.output?.appendLine(`[PVF] failed to rename legacy tree comments: ${String(err && err.message || err)}`);
      }
    }
  }

  private async save(): Promise<void> {
    const versions: PersistedTreeCommentFile['versions'] = {};
    for (const [version, comments] of this.overrideCommentsByVersion) {
      const out = mapToJson(comments);
      if (Object.keys(out).length > 0) versions![version] = { comments: out };
    }
    const file = await this.resourceFilePath();
    const snapshot: PersistedTreeCommentFile = {
      schemaVersion: 1,
      version: serializeVersion(this.baseVersion),
      comments: mapToJson(this.baseComments),
      ...(versions && Object.keys(versions).length > 0 ? { versions } : {}),
    };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  }
}
