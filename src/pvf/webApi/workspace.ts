import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { StringTable } from '../stringTable';
import {
  PvfDirectoryManifest,
  PvfDiskFileKind,
  PvfDiskFileManifestEntry,
  PVF_MANIFEST_FILE,
  normalizeArchiveKey,
} from '../directoryArchive';
import { encodingForKeyWithMode } from '../helpers';
import { parseScriptMetadata } from '../metadata';
import { readConfiguredUnpackRoots } from '../unpackEnv';
import { PvfWebApiFileInfo, PvfWebApiSettings } from './types';

interface LstCacheEntry {
  mtimeMs: number;
  size: number;
  byCode: Map<number, string>;
  byFile: Map<string, number>;
}

interface NameCacheEntry {
  mtimeMs: number;
  size: number;
  name: string | null;
}

export interface ResolvedPvfWebApiRoot {
  root: string;
  manifest?: PvfDirectoryManifest;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function stripPvfValue(value: string): string {
  let text = String(value || '').trim();
  const linkText = text.match(/`([^`]*)`/);
  if (linkText) text = linkText[1];
  if ((text.startsWith('`') && text.endsWith('`')) || (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  return text.trim();
}

function tagValueToString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const stripped = stripPvfValue(item);
      if (stripped) return stripped;
    }
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  return stripPvfValue(value) || undefined;
}

function likelyLstPath(name: string): string[] {
  const normalized = normalizeArchiveKey(name).replace(/\.lst$/i, '');
  const aliases: Record<string, string[]> = {
    tackable: ['stackable/stackable.lst'],
    stackable: ['stackable/stackable.lst'],
    equipment: ['equipment/equipment.lst'],
    dungeon: ['dungeon/dungeon.lst'],
    monster: ['monster/monster.lst'],
    n_quest: ['n_quest/quest.lst', 'n_quest/n_quest.lst'],
    npc: ['npc/npc.lst'],
    passiveobject: ['passiveobject/passiveobject.lst', 'passive_object/passiveobject.lst'],
    aicharacter: ['aicharacter/aicharacter.lst', 'ai_character/aicharacter.lst', 'character/aicharacter.lst'],
    town: ['town/town.lst'],
    wown: ['town/town.lst'],
    worldmap: ['worldmap/worldmap.lst'],
    map: ['map/map.lst'],
    creature: ['creature/creature.lst'],
    aura: ['aura/aura.lst'],
    itemshop: ['itemshop/itemshop.lst'],
    cashshop: ['cashshop/cashshop.lst'],
  };
  if (name.toLowerCase().endsWith('.lst')) return [normalizeArchiveKey(name)];
  return aliases[normalized] || [`${normalized}/${normalized}.lst`, `${normalized}.lst`];
}

function decodeJsonMaybe<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export class PvfWebApiWorkspace {
  private root = '';
  private manifest: PvfDirectoryManifest | undefined;
  private fileKinds = new Map<string, PvfDiskFileManifestEntry>();
  private fileSet = new Set<string>();
  private dirSet = new Set<string>();
  private rootDirs: string[] = [];
  private lstFiles: string[] = [];
  private lstCache = new Map<string, LstCacheEntry>();
  private nameCache = new Map<string, NameCacheEntry>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  getRoot(): string {
    return this.root;
  }

  getManifest(): PvfDirectoryManifest | undefined {
    return this.manifest;
  }

  async resolveRoot(settings: PvfWebApiSettings): Promise<ResolvedPvfWebApiRoot> {
    const candidates: string[] = [];
    if (settings.unpackRoot) candidates.push(settings.unpackRoot);
    candidates.push(...await readConfiguredUnpackRoots(this.context));

    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    if (!settings.unpackRoot && candidates.length === 0 && workspaceFolders.length === 1) {
      const folderRoot = workspaceFolders[0].uri.fsPath;
      try {
        const stat = await fs.stat(path.join(folderRoot, PVF_MANIFEST_FILE));
        if (stat.isFile()) candidates.push(folderRoot);
      } catch {
        // ignore
      }
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      const key = pathKey(resolved);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) continue;
        const manifest = await this.readManifest(resolved);
        return { root: resolved, manifest };
      } catch {
        continue;
      }
    }
    throw new Error('未找到可用的解包 PVF 根目录。请设置 pvf.webApi.unpackRoot 或 .env UNPACK_DIR。');
  }

  async load(settings: PvfWebApiSettings): Promise<void> {
    const resolved = await this.resolveRoot(settings);
    if (pathKey(resolved.root) === pathKey(this.root) && this.fileSet.size > 0) return;

    this.root = resolved.root;
    this.manifest = resolved.manifest;
    this.fileKinds.clear();
    this.fileSet.clear();
    this.dirSet.clear();
    this.rootDirs = [];
    this.lstFiles = [];
    this.lstCache.clear();
    this.nameCache.clear();

    if (this.manifest?.files?.length) {
      for (const entry of this.manifest.files) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
        const key = normalizeArchiveKey(entry[0]);
        if (!key || key === PVF_MANIFEST_FILE) continue;
        const normalizedEntry: PvfDiskFileManifestEntry = [key, entry[1] as PvfDiskFileKind, entry[2]];
        this.fileKinds.set(key, normalizedEntry);
        this.fileSet.add(key);
        this.addDirsForFile(key);
      }
    } else {
      await this.loadRootOnlyIndex();
    }
    this.rootDirs = [...new Set([...this.dirSet].map(item => item.split('/')[0]).filter(Boolean))].sort();
    this.lstFiles = [...this.fileSet].filter(item => item.endsWith('.lst')).sort();
  }

  normalizePath(value: string, options: { allowEmpty?: boolean } = {}): string {
    const raw = decodeURIComponent(String(value || '')).replace(/\\/g, '/').trim();
    if (!raw) {
      if (options.allowEmpty) return '';
      throw new Error('PVF path is empty');
    }
    if (raw.includes('\0')) throw new Error('PVF path contains NUL');
    if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('//')) throw new Error('PVF path must be relative');
    const parts: string[] = [];
    for (const part of raw.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' || part.includes(':')) throw new Error(`PVF path escapes root: ${value}`);
      parts.push(part);
    }
    if (parts.length === 0) {
      if (options.allowEmpty) return '';
      throw new Error('PVF path is empty');
    }
    return parts.join('/').toLowerCase();
  }

  diskPathForKey(key: string): string {
    const normalized = this.normalizePath(key);
    const full = path.resolve(this.root, ...normalized.split('/'));
    const rel = path.relative(path.resolve(this.root), full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`PVF path escapes root: ${key}`);
    return full;
  }

  async fileExists(key: string): Promise<boolean> {
    const normalized = this.normalizePath(key);
    if (this.fileSet.has(normalized)) {
      try {
        const stat = await fs.stat(this.diskPathForKey(normalized));
        return stat.isFile();
      } catch {
        return false;
      }
    }
    try {
      const stat = await fs.stat(this.diskPathForKey(normalized));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async folderExists(key: string): Promise<boolean> {
    const normalized = this.normalizePath(key, { allowEmpty: true });
    if (!normalized) return true;
    if (this.dirSet.has(normalized)) return true;
    try {
      const stat = await fs.stat(path.resolve(this.root, ...normalized.split('/')));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  getRootDirectories(): string[] {
    return this.rootDirs.slice();
  }

  getAllLstFiles(): string[] {
    return this.lstFiles.slice();
  }

  getFileList(dirName: string, fileType: string): string[] {
    const dir = this.normalizePath(dirName || '', { allowEmpty: true });
    const ext = String(fileType || '').trim().toLowerCase();
    const prefix = dir ? `${dir.replace(/\/+$/, '')}/` : '';
    return [...this.fileSet]
      .filter(key => (!prefix || key.startsWith(prefix)))
      .filter(key => !ext || key.endsWith(ext.startsWith('.') ? ext : `.${ext}`))
      .sort();
  }

  async readText(key: string, maxBytes: number): Promise<string> {
    const normalized = this.normalizePath(key);
    const diskPath = this.diskPathForKey(normalized);
    const stat = await fs.stat(diskPath);
    if (!stat.isFile()) throw new Error('文件不存在');
    if (stat.size > maxBytes) throw new Error(`文件过大: ${stat.size} bytes`);
    const buf = await fs.readFile(diskPath);
    if (buf.includes(0)) throw new Error('不支持读取二进制文件');
    let text = Buffer.from(buf).toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  }

  async readWebApiText(key: string, maxBytes: number): Promise<string> {
    const normalized = this.normalizePath(key);
    const text = await this.readText(normalized, maxBytes);
    if (normalized.endsWith('.lst')) return this.toPvfUtilityLstText(normalized, text);
    if (/^etc\/itemdropinfo.*\.etc$/i.test(normalized)) return this.toPvfUtilityItemDropInfoText(text);
    return text;
  }

  async getStringTable(): Promise<string[]> {
    const diskPath = this.diskPathForKey('stringtable.bin');
    const stat = await fs.stat(diskPath);
    if (!stat.isFile()) throw new Error('stringtable.bin 不存在');
    const buf = await fs.readFile(diskPath);
    const utf8 = Buffer.from(buf).toString('utf8');
    if (/^\d+\t/.test(utf8) || utf8.startsWith('\ufeff0\t')) {
      const text = utf8.charCodeAt(0) === 0xfeff ? utf8.slice(1) : utf8;
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => {
          const tab = line.indexOf('\t');
          return tab >= 0 && /^\d+$/.test(line.slice(0, tab)) ? line.slice(tab + 1) : line;
        });
    }
    const encodingMode = this.manifest?.encodingMode || 'AUTO';
    const defaultEncoding = this.manifest?.defaultEncoding || 'big5';
    const st = new StringTable(encodingForKeyWithMode('stringtable.bin', encodingMode, defaultEncoding));
    st.load(buf);
    const dumped = st.dumpText();
    return dumped ? dumped.split(/\n/).map(line => line.replace(/^\d+\t/, '')) : [];
  }

  async parseLst(key: string): Promise<Map<number, string>> {
    const normalized = this.normalizePath(key);
    const diskPath = this.diskPathForKey(normalized);
    const stat = await fs.stat(diskPath);
    if (!stat.isFile()) throw new Error('文件不存在');
    const cached = this.lstCache.get(normalized);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.byCode;

    const text = await this.readText(normalized, Math.max(100 * 1024 * 1024, stat.size + 1));
    const byCode = new Map<number, string>();
    const byFile = new Map<string, number>();
    for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^(-?\d+)\s+`?([^`]+)`?/);
      if (!match) continue;
      const code = Number(match[1]);
      if (!Number.isSafeInteger(code)) continue;
      const itemPath = match[2].trim().replace(/\\/g, '/');
      byCode.set(code, itemPath);
      for (const full of this.fullPathsForLstEntry(normalized, itemPath)) {
        byFile.set(full, code);
      }
    }
    this.lstCache.set(normalized, { mtimeMs: stat.mtimeMs, size: stat.size, byCode, byFile });
    return byCode;
  }

  async getLstFileInfo(key: string): Promise<Record<string, PvfWebApiFileInfo>> {
    const normalized = this.normalizePath(key);
    const byCode = await this.parseLst(normalized);
    const data: Record<string, PvfWebApiFileInfo> = {};
    const pathHeader = normalized.includes('/') ? normalized.slice(0, normalized.indexOf('/')) : path.posix.basename(normalized, '.lst');
    const resolveNames = byCode.size <= 2000;
    for (const [code, itemPath] of byCode) {
      const fullPath = this.bestFullPathForLstEntry(normalized, itemPath);
      data[String(code)] = {
        PathHeader: pathHeader,
        ItemPath: this.displayItemPathForLstEntry(normalized, itemPath),
        FullPath: fullPath,
        ItemName: resolveNames ? await this.getItemName(fullPath).catch(() => null) : this.nameCache.get(fullPath)?.name ?? null,
        ItemCode: code,
      };
    }
    return data;
  }

  async itemCodeToFileInfo(lstNames: string[], itemCode: number): Promise<{ FilePath: string; ItemName: string | null; Path: string } | undefined> {
    for (const lstName of lstNames) {
      for (const lstPath of this.resolveLstNames(lstName)) {
        if (!await this.fileExists(lstPath)) continue;
        const byCode = await this.parseLst(lstPath);
        const itemPath = byCode.get(itemCode);
        if (!itemPath) continue;
        const filePath = this.bestFullPathForLstEntry(lstPath, itemPath);
        return {
          FilePath: filePath,
          ItemName: await this.getItemName(filePath).catch(() => null),
          Path: this.displayItemPathForLstEntry(lstPath, itemPath),
        };
      }
    }
    return undefined;
  }

  async getItemInfo(filePath: string): Promise<{ ItemName: string | null; ItemCode: number | null }> {
    const normalized = this.normalizePath(filePath);
    if (!await this.fileExists(normalized)) throw new Error('文件不存在');
    return {
      ItemName: await this.getItemName(normalized).catch(() => null),
      ItemCode: await this.getItemCode(normalized),
    };
  }

  resolveLstNames(name: string): string[] {
    const raw = String(name || '').split(/[,\s;]+/).map(item => item.trim()).filter(Boolean);
    const candidates = raw.length ? raw : ['equipment', 'stackable'];
    const out: string[] = [];
    for (const item of candidates) out.push(...likelyLstPath(item));
    return [...new Set(out.map(item => normalizeArchiveKey(item)))];
  }

  private async readManifest(root: string): Promise<PvfDirectoryManifest | undefined> {
    try {
      const text = await fs.readFile(path.join(root, PVF_MANIFEST_FILE), 'utf8');
      return decodeJsonMaybe<PvfDirectoryManifest>(text);
    } catch {
      return undefined;
    }
  }

  private async loadRootOnlyIndex(): Promise<void> {
    const dirents = await fs.readdir(this.root, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.name === PVF_MANIFEST_FILE) continue;
      const key = normalizeArchiveKey(dirent.name);
      if (dirent.isDirectory()) this.dirSet.add(key);
      else if (dirent.isFile()) this.fileSet.add(key);
    }
  }

  private addDirsForFile(key: string): void {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      this.dirSet.add(parts.slice(0, i).join('/'));
    }
  }

  private fullPathsForLstEntry(lstPath: string, itemPath: string): string[] {
    const normalizedItem = normalizeArchiveKey(itemPath);
    const header = lstPath.includes('/') ? lstPath.slice(0, lstPath.indexOf('/')) : '';
    const parent = lstPath.includes('/') ? lstPath.slice(0, lstPath.lastIndexOf('/')) : '';
    return [...new Set([
      normalizedItem,
      header ? `${header}/${normalizedItem}` : normalizedItem,
      parent ? `${parent}/${normalizedItem}` : normalizedItem,
    ])];
  }

  private bestFullPathForLstEntry(lstPath: string, itemPath: string): string {
    const candidates = this.fullPathsForLstEntry(lstPath, itemPath);
    return candidates.find(candidate => this.fileSet.has(candidate)) || candidates[candidates.length - 1] || normalizeArchiveKey(itemPath);
  }

  private displayItemPathForLstEntry(lstPath: string, itemPath: string): string {
    const header = lstPath.includes('/') ? lstPath.slice(0, lstPath.indexOf('/')) : path.posix.basename(lstPath, '.lst');
    const normalized = itemPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const lower = normalized.toLowerCase();
    const prefix = `${header.toLowerCase()}/`;
    return lower.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  }

  private toPvfUtilityLstText(lstPath: string, text: string): string {
    const pieces = text.split(/(\r\n|\n|\r)/);
    for (let i = 0; i < pieces.length; i += 2) {
      pieces[i] = this.toPvfUtilityLstLine(lstPath, pieces[i]);
    }
    return pieces.join('');
  }

  private toPvfUtilityLstLine(lstPath: string, line: string): string {
    const quoted = line.match(/^(\s*-?\d+\s+)`([^`]*)`(\s*)$/);
    if (quoted) {
      return `${quoted[1]}\`${this.displayItemPathForLstEntry(lstPath, quoted[2])}\`${quoted[3]}`;
    }
    const plain = line.match(/^(\s*-?\d+\s+)(\S+)(\s*)$/);
    if (plain) {
      return `${plain[1]}${this.displayItemPathForLstEntry(lstPath, plain[2])}${plain[3]}`;
    }
    return line;
  }

  private toPvfUtilityItemDropInfoText(text: string): string {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const out: string[] = [];
    let section = '';
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        section = sectionMatch[1].trim().toLowerCase();
        out.push(rawLine);
        continue;
      }
      const numbers = trimmed.split(/\s+/).filter(Boolean);
      if (numbers.length > 1 && numbers.every(item => /^[-+]?\d+$/.test(item))) {
        if (section === 'basis of rarity dicision') {
          out.push(...this.formatNumberRows(numbers, 6, true));
          continue;
        }
        if (section === 'item drop ref table') {
          out.push(...this.formatNumberRows(numbers, 3, false));
          continue;
        }
      }
      out.push(rawLine);
    }
    return out.join('\r\n');
  }

  private formatNumberRows(numbers: string[], width: number, keepFirstSingle: boolean): string[] {
    const rows: string[] = [];
    let start = 0;
    if (keepFirstSingle && numbers.length > 0) {
      rows.push(`\t${numbers[0]}`);
      start = 1;
    }
    for (let i = start; i < numbers.length; i += width) {
      rows.push(`\t${numbers.slice(i, i + width).join('\t')}`);
    }
    return rows;
  }

  private async getItemCode(filePath: string): Promise<number | null> {
    const normalized = this.normalizePath(filePath);
    for (const lstPath of this.lstFiles) {
      const byCode = await this.parseLst(lstPath).catch(() => undefined);
      if (!byCode) continue;
      const cached = this.lstCache.get(lstPath);
      const code = cached?.byFile.get(normalized);
      if (typeof code === 'number') return code;
    }
    const base = path.posix.basename(normalized).replace(/\.[^.]+$/, '');
    return /^\d+$/.test(base) ? Number(base) : null;
  }

  private async getItemName(filePath: string): Promise<string | null> {
    const normalized = this.normalizePath(filePath);
    const diskPath = this.diskPathForKey(normalized);
    const stat = await fs.stat(diskPath);
    if (!stat.isFile()) return null;
    const cached = this.nameCache.get(normalized);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.name;
    const text = await this.readText(normalized, Math.min(Math.max(stat.size + 1, 64 * 1024), 1024 * 1024)).catch(() => '');
    const parsed = text ? parseScriptMetadata(text) : undefined;
    const name = parsed?.name
      || parsed?.name2
      || tagValueToString(parsed?.tags?.['set name'])
      || tagValueToString(parsed?.tags?.['shop name'])
      || tagValueToString(parsed?.tags?.['display name'])
      || null;
    this.nameCache.set(normalized, { mtimeMs: stat.mtimeMs, size: stat.size, name });
    return name;
  }
}
