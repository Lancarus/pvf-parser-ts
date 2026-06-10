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
  private readonly bundledVersion = normalizeTreeCommentVersion((bundledTreeComments as any).version ?? 0);
  private readonly bundledComments = normalizeCommentMap((bundledTreeComments as any).comments);
  private readonly userCommentsByVersion = new Map<string, Map<string, PvfTreeCommentEntry>>();
  private loaded = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly model: PvfModel,
    private readonly output?: vscode.OutputChannel,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.userFilePath(), 'utf8');
      const data = JSON.parse(raw) as PersistedTreeCommentFile;
      const versions = data.versions || {};
      this.userCommentsByVersion.clear();
      for (const [version, versionData] of Object.entries(versions)) {
        if (!versionData || typeof versionData !== 'object') continue;
        const comments = 'comments' in versionData
          ? (versionData as { comments?: Record<string, unknown> }).comments
          : versionData as Record<string, unknown>;
        const normalized = normalizeCommentMap(comments);
        if (normalized.size > 0) this.userCommentsByVersion.set(normalizeTreeCommentVersion(version), normalized);
      }
    } catch (err: any) {
      if (err && err.code !== 'ENOENT') {
        this.output?.appendLine(`[PVF] failed to load tree comments: ${String(err && err.message || err)}`);
      }
    } finally {
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
    const userEntry = this.userCommentsByVersion.get(versionKey)?.get(normalizedKey);
    if (userEntry) return userEntry;
    if (this.bundledVersion === '0' || this.bundledVersion === versionKey) {
      return this.bundledComments.get(normalizedKey);
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
    let comments = this.userCommentsByVersion.get(versionKey);
    if (!comments) {
      comments = new Map<string, PvfTreeCommentEntry>();
      this.userCommentsByVersion.set(versionKey, comments);
    }
    const text = comment.trim();
    if (text) {
      const existing = this.getEntry(normalizedKey);
      comments.set(normalizedKey, {
        comment: text,
        ...(existing?.detailedComment ? { detailedComment: existing.detailedComment } : {}),
      });
    } else {
      comments.delete(normalizedKey);
      if (comments.size === 0) this.userCommentsByVersion.delete(versionKey);
    }
    await this.save();
  }

  private userFilePath(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'tree-comments.user.json');
  }

  private async save(): Promise<void> {
    const versions: PersistedTreeCommentFile['versions'] = {};
    for (const [version, comments] of this.userCommentsByVersion) {
      const out: Record<string, PvfTreeCommentEntry> = {};
      for (const [key, entry] of comments) out[key] = entry;
      if (Object.keys(out).length > 0) versions![version] = { comments: out };
    }
    await fs.mkdir(path.dirname(this.userFilePath()), { recursive: true });
    await fs.writeFile(this.userFilePath(), JSON.stringify({
      schemaVersion: 1,
      versions,
    }, null, 2) + '\n', 'utf8');
  }
}
