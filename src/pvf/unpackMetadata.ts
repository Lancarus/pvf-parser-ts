import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import { parseScriptMetadata, normalizeImgLogical } from './metadata';
import { pathContains, readConfiguredNpkRoots } from './unpackEnv';

export type UnpackIconState = 'default' | 'loading' | 'ready' | 'missing' | 'error';

export interface UnpackIconReference {
  imagePath: string;
  frameIndex: number;
}

export interface UnpackResolvedMetadata {
  itemName?: string;
  itemCode?: number;
  rarity?: number;
  grade?: string;
  skillClass?: number;
  skillClassText?: string;
  skillKind?: 'active' | 'passive' | 'common' | 'guild';
  icon?: UnpackIconReference;
  iconPath?: string;
  iconDataUri?: string;
  iconWidth?: number;
  iconHeight?: number;
  iconState?: UnpackIconState;
}

export interface UnpackMetadataInput {
  fsPath: string;
  key: string;
  name: string;
  root: string;
  version: string;
}

interface MetadataCacheEntry {
  mtimeMs: number;
  size: number;
  metadata: UnpackResolvedMetadata;
}

interface LstCacheEntry {
  mtimeMs: number;
  size: number;
  fileToCode: Map<string, number>;
  codeToFile: Map<number, string>;
}

interface StrCacheEntry {
  mtimeMs: number;
  size: number;
  values: Map<string, string>;
}

interface ShopNpcMetadataIndex {
  byShopCode: Map<number, UnpackResolvedMetadata>;
  byDialogNpcId: Map<number, UnpackResolvedMetadata>;
}

interface SimpleParsedTags {
  name?: string;
  name2?: string;
  tags: Record<string, string | string[]>;
  icon?: UnpackIconReference;
}

interface DecodedIcon {
  filePath: string;
  width: number;
  height: number;
}

export const RARITY_LABELS = ['普通', '高级', '稀有', '神器', '史诗', '勇者', '传说', '神话'] as const;

export function rarityLabel(rarity: number | undefined): string | undefined {
  return typeof rarity === 'number' && rarity >= 0 && rarity < RARITY_LABELS.length
    ? RARITY_LABELS[rarity]
    : undefined;
}

export function rarityThemeColor(rarity: number | undefined): vscode.ThemeColor | undefined {
  return typeof rarity === 'number' && rarity >= 0 && rarity < RARITY_LABELS.length
    ? new vscode.ThemeColor(`pvf.rarity${rarity}Foreground`)
    : undefined;
}

export function defaultStringThemeColor(): vscode.ThemeColor {
  return new vscode.ThemeColor('pvf.unpackStringForeground');
}

export function defaultNumberThemeColor(): vscode.ThemeColor {
  return new vscode.ThemeColor('pvf.unpackNumberForeground');
}

function quickHash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = ((h << 5) - h + value.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function crc32(buf: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      const m = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & m);
    }
  }
  return ~crc >>> 0;
}

function writePngChunk(type: string, data: Uint8Array, out: number[]): void {
  const len = data.length;
  out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = new Uint8Array(typeBytes.length + data.length);
  chunk.set(typeBytes, 0);
  chunk.set(data, typeBytes.length);
  const crc = crc32(chunk);
  for (const byte of chunk) out.push(byte);
  out.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
}

function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const out: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
  writePngChunk('IHDR', ihdr, out);
  writePngChunk('IDAT', zlib.deflateSync(raw, { level: 9 }), out);
  writePngChunk('IEND', new Uint8Array(), out);
  return Buffer.from(out);
}

export function normalizeUnpackKey(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

function safeJoinArchivePath(root: string, key: string): string | undefined {
  const parts = normalizeUnpackKey(key).split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '..' || part.includes('\0'))) return undefined;
  const fullPath = path.resolve(root, ...parts);
  return pathContains(root, fullPath) ? fullPath : undefined;
}

function stripPvfValue(value: string): string {
  let text = value.trim();
  const linkText = text.match(/`([^`]*)`/);
  if (linkText) text = linkText[1];
  if ((text.startsWith('`') && text.endsWith('`')) || (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  return text.trim();
}

function normalizeGrade(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = stripPvfValue(value).trim().toLowerCase();
  if (!text) return undefined;
  return text.startsWith('[') && text.endsWith(']') ? text : `[${text.replace(/^\[|\]$/g, '')}]`;
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
  const stripped = stripPvfValue(value);
  return stripped || undefined;
}

function tagValueToInt(value: string | string[] | undefined): number | undefined {
  const text = tagValueToString(value);
  if (!text) return undefined;
  const match = text.match(/-?\d+/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function cleanPvfValue(value: string): string {
  let text = value.trim();
  const linkText = text.match(/`([^`]*)`/);
  if (linkText) text = linkText[1];
  text = text
    .replace(/^`+|`+$/g, '')
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '')
    .trim();
  return text;
}

function allTagLines(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.flatMap(item => item.split(/\r?\n/)).map(item => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  return [];
}

function iconFromTagValue(value: string | string[] | undefined): UnpackIconReference | undefined {
  for (const line of allTagLines(value)) {
    const match = line.match(/^([`'"])(.+?\.img)\1\s+(-?\d+)/i) || line.match(/^(.+?\.img)\s+(-?\d+)$/i);
    if (!match) continue;
    const imagePath = match.length >= 4 ? match[2] : match[1];
    const frameText = match[match.length - 1];
    const frameIndex = Number(frameText);
    if (!imagePath || !Number.isSafeInteger(frameIndex) || frameIndex < 0) continue;
    return { imagePath: normalizeImgLogical(imagePath), frameIndex };
  }
  return undefined;
}

function isUsefulDisplayName(value: string | undefined): value is string {
  if (!value) return false;
  const text = value.trim();
  if (!text) return false;
  if (/\.((img)|(ani)|(wav)|(ogg)|(npk))$/i.test(text)) return false;
  return true;
}

function pickNameLikeTag(tags: Record<string, string | string[]> | undefined): string | undefined {
  if (!tags) return undefined;
  const priority = [
    'set name',
    'shop name',
    'field name',
    'display name',
    'npc name',
    'monster name',
    'skill name',
  ];
  for (const key of priority) {
    const value = tagValueToString(tags[key]);
    if (isUsefulDisplayName(value)) return value;
  }
  for (const [key, raw] of Object.entries(tags)) {
    if (!/\bname\b/i.test(key)) continue;
    const value = tagValueToString(raw);
    if (isUsefulDisplayName(value)) return value;
  }
  return undefined;
}

function pickShopNameTag(tags: Record<string, string | string[]> | undefined): string | undefined {
  if (!tags) return undefined;
  for (const key of ['shop name', 'display name']) {
    const value = tagValueToString(tags[key]);
    if (isUsefulDisplayName(value)) return value;
  }
  return undefined;
}

function faceIconFromTags(tags: Record<string, string | string[]> | undefined): UnpackIconReference | undefined {
  if (!tags) return undefined;
  for (const key of ['small face', 'popup face', 'big face']) {
    const icon = iconFromTagValue(tags[key]);
    if (icon) return icon;
  }
  return undefined;
}

function aniFirstImageIcon(text: string): UnpackIconReference | undefined {
  const imageTag = /\[IMAGE\]/i.exec(text);
  if (!imageTag) return undefined;
  const lines = text.slice(imageTag.index + imageTag[0].length).split(/\r?\n/);
  let imagePath = '';
  let frameIndex: number | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!imagePath) {
      if (line.startsWith('[')) return undefined;
      imagePath = stripPvfValue(line);
      continue;
    }
    if (line.startsWith('[')) break;
    const parsed = Number(line.match(/-?\d+/)?.[0]);
    if (Number.isSafeInteger(parsed) && parsed >= 0) frameIndex = parsed;
    break;
  }
  return imagePath && typeof frameIndex === 'number'
    ? { imagePath: normalizeImgLogical(imagePath), frameIndex }
    : undefined;
}

function questIconFromTags(tags: Record<string, string | string[]> | undefined): UnpackIconReference | undefined {
  const rewardType = normalizeGrade(tagValueToString(tags?.['reward type']));
  if (rewardType === '[awakening type]') {
    return { imagePath: normalizeImgLogical('Interface/Quest/quest_tag.img'), frameIndex: 7 };
  }
  if (rewardType === '[creature evolution]') {
    return { imagePath: normalizeImgLogical('Interface/Quest/quest_tag.img'), frameIndex: 8 };
  }
  const grade = normalizeGrade(tagValueToString(tags?.grade));
  if (!grade) return undefined;
  const frameByGrade: Record<string, number> = {
    '[epic]': 0,
    '[common unique]': 1,
    '[training]': 3,
    '[normaly repeat]': 1,
    '[daily]': 11,
    '[daily random]': 11,
    '[achievement]': 12,
    '[title]': 1,
    '[urgent]': 14,
  };
  const frameIndex = frameByGrade[grade];
  return typeof frameIndex === 'number'
    ? { imagePath: normalizeImgLogical('Interface/Quest/quest_tag.img'), frameIndex }
    : undefined;
}

function codeFromFileName(key: string): number | undefined {
  const base = path.posix.basename(normalizeUnpackKey(key)).replace(/\.[^.]+$/, '');
  if (!/^\d+$/.test(base)) return undefined;
  const code = Number(base);
  return Number.isSafeInteger(code) ? code : undefined;
}

const SKILL_LST_CANDIDATES = [
  'skill/swordmanskill.lst',
  'skill/atswordmanskill.lst',
  'skill/dsswordmanskill.lst',
  'skill/fighterskill.lst',
  'skill/gunnerskill.lst',
  'skill/mageskill.lst',
  'skill/priestskill.lst',
  'skill/atgunnerskill.lst',
  'skill/thiefskill.lst',
  'skill/atfighterskill.lst',
  'skill/atmageskill.lst',
  'skill/creatormageskill.lst',
  'skill/knight.lst',
  'skill/autoskill.lst',
  'skill/skilllist.lst',
  'skill/skilllist.jpn.lst',
  'skill/demonicswordman.lst',
  'skill/creatormage.lst',
  'skill/skill.lst',
] as const;

function skillClassText(_key: string, value: number | undefined): string | undefined {
  if (typeof value !== 'number') return undefined;
  return value === 4 ? '通用' : String(value);
}

function parseSimpleScriptTags(text: string): SimpleParsedTags {
  const tags: Record<string, string | string[]> = {};
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let current = '';
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const tag = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (tag) {
      const name = tag[1].trim().toLowerCase();
      if (name.startsWith('/')) {
        if (current === name.slice(1).trim()) current = '';
        continue;
      }
      current = name;
      if (!tags[current]) tags[current] = [];
      const inline = stripLineComment(tag[2] || '').trim();
      if (inline) appendSimpleTagValue(tags, current, inline);
      continue;
    }
    if (current) appendSimpleTagValue(tags, current, stripLineComment(trimmed).trim());
  }

  const name = tagValueToString(tags.name);
  const name2 = tagValueToString(tags.name2);
  const directIcon = iconFromTagValue(tags.icon);
  return {
    ...(name ? { name } : {}),
    ...(name2 ? { name2 } : {}),
    tags,
    ...(directIcon ? { icon: directIcon } : {}),
  };
}

function appendSimpleTagValue(tags: Record<string, string | string[]>, key: string, value: string): void {
  if (!value) return;
  const existing = tags[key];
  if (Array.isArray(existing)) {
    existing.push(value);
  } else if (typeof existing === 'string') {
    tags[key] = [existing, value];
  } else {
    tags[key] = [value];
  }
}

function stripLineComment(value: string): string {
  const index = value.indexOf('//');
  return index >= 0 ? value.slice(0, index) : value;
}

function numbersFromText(value: string): number[] {
  const out: number[] = [];
  for (const match of value.matchAll(/-?\d+/g)) {
    const parsed = Number(match[0]);
    if (Number.isSafeInteger(parsed)) out.push(parsed);
  }
  return out;
}

function normalizeSkillType(value: string | undefined): 'active' | 'passive' | undefined {
  const token = cleanPvfValue(value || '').replace(/^\[|\]$/g, '').trim().toLowerCase();
  if (token === 'active') return 'active';
  if (token === 'passive') return 'passive';
  return undefined;
}

function looksLikeGuildSkill(key: string, itemName: string | undefined): boolean {
  const normalized = normalizeUnpackKey(key);
  const base = path.posix.basename(normalized, '.skl');
  const name = (itemName || '').toLowerCase();
  return /\bguild\b/i.test(normalized)
    || base === 'statusup'
    || base === 'experienceup'
    || name.includes('guild')
    || (itemName || '').includes('公会');
}

function skillKindFor(
  key: string,
  parsed: SimpleParsedTags,
  itemCode: number | undefined,
  commonSkillCodes: Set<number> | undefined,
  itemName: string | undefined,
): UnpackResolvedMetadata['skillKind'] | undefined {
  const normalized = normalizeUnpackKey(key);
  if (!normalized.endsWith('.skl')) return undefined;
  if (looksLikeGuildSkill(normalized, itemName || parsed.name)) return 'guild';
  if (typeof itemCode === 'number' && commonSkillCodes?.has(itemCode)) return 'common';
  if (tagValueToInt(parsed.tags['skill class']) === 4) return 'common';
  const type = normalizeSkillType(tagValueToString(parsed.tags.type));
  return type;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function lstCandidatesForKey(key: string): string[] {
  const normalized = normalizeUnpackKey(key);
  const first = normalized.split('/')[0] || '';
  const candidates: string[] = [];
  if (first === 'equipment') candidates.push('equipment/equipment.lst');
  if (first === 'stackable') candidates.push('stackable/stackable.lst');
  if (first === 'skill') candidates.push(...SKILL_LST_CANDIDATES);
  if (first === 'creature') candidates.push('creature/creature.lst');
  if (first === 'n_quest' || normalized.endsWith('.qst')) candidates.push('n_quest/quest.lst', 'n_quest/n_quest.lst');
  if (first) candidates.push(`${first}/${first}.lst`);
  return unique(candidates);
}

function strCandidatesForKey(key: string): string[] {
  const normalized = normalizeUnpackKey(key);
  const first = normalized.split('/')[0] || '';
  if (!first) return [];
  return unique([
    `${first}/${first}.chn.str`,
    `${first}/${first}.kor.str`,
    `${first}/${first}.jpn.str`,
  ]);
}

export function shouldResolveUnpackMetadataKey(key: string): boolean {
  const lower = normalizeUnpackKey(key);
  if (!lower || lower.endsWith('/')) return false;
  return !/\.(ani|ani\.als|als|lst|str|nut|png|jpg|jpeg|dds|bmp|tga|gif|wav|ogg|mp3|bin)$/i.test(lower);
}

async function readUtf8Text(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  let text = Buffer.from(buf).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

export async function readLstFileToCodeMap(lstDiskPath: string, lstKey?: string): Promise<Map<string, number>> {
  const text = await readUtf8Text(lstDiskPath);
  const fileToCode = new Map<string, number>();
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(-?\d+)\s+`?([^`]+)`?/);
    if (!match) continue;
    const code = Number(match[1]);
    if (!Number.isSafeInteger(code)) continue;
    for (const key of lstEntryKeys(match[2], lstKey)) {
      if (!fileToCode.has(key)) fileToCode.set(key, code);
    }
  }
  return fileToCode;
}

function lstEntryKeys(value: string, lstKey: string | undefined): string[] {
  const entry = normalizeUnpackKey(value).replace(/^(?:\.\/)+/, '');
  if (!entry) return [];
  const normalizedLstKey = normalizeUnpackKey(lstKey || '');
  const slash = normalizedLstKey.lastIndexOf('/');
  const prefix = slash > 0 ? normalizedLstKey.slice(0, slash) : '';
  if (!prefix || entry.startsWith(`${prefix}/`)) return [entry];
  return [`${prefix}/${entry}`, entry];
}

function lstCacheKey(lstDiskPath: string, lstKey: string | undefined): string {
  return `${path.resolve(lstDiskPath)}\0${normalizeUnpackKey(lstKey || '')}`;
}

async function readStrFile(strDiskPath: string): Promise<Map<string, string>> {
  const text = await readUtf8Text(strDiskPath);
  const values = new Map<string, string>();
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf('>');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key) values.set(key, value);
  }
  return values;
}

export function parseUnpackScriptText(text: string, key = ''): Omit<UnpackResolvedMetadata, 'itemCode' | 'iconPath' | 'iconState'> {
  if (!/\[(name|name2|set name|shop name|field name|field animation|icon|rarity|grade|small face|big face|popup face|npc|role|type|skill class)\]/i.test(text)) return {};
  const parsed = parseSimpleScriptTags(text);
  const normalizedKey = normalizeUnpackKey(key);
  const isShop = normalizedKey.endsWith('.shp');
  const itemName = parsed.name || parsed.name2 || (isShop ? pickShopNameTag(parsed.tags) : pickNameLikeTag(parsed.tags));
  const rarity = tagValueToInt(parsed.tags?.rarity);
  const skillClass = normalizedKey.endsWith('.skl') ? tagValueToInt(parsed.tags?.['skill class']) : undefined;
  const isQuest = normalizedKey.endsWith('.qst');
  const grade = isQuest ? normalizeGrade(tagValueToString(parsed.tags?.grade)) : undefined;
  const icon = parsed.icon
    || faceIconFromTags(parsed.tags)
    || (isQuest ? questIconFromTags(parsed.tags) : undefined);
  return {
    ...(itemName ? { itemName } : {}),
    ...(typeof rarity === 'number' ? { rarity } : {}),
    ...(grade ? { grade } : {}),
    ...(typeof skillClass === 'number' ? { skillClass, skillClassText: skillClassText(normalizedKey, skillClass) } : {}),
    ...(icon ? { icon } : {}),
  };
}

function configBool(primary: string, legacy: string, fallback: boolean): boolean {
  const cfg = vscode.workspace.getConfiguration();
  const primaryValue = cfg.get<boolean>(primary);
  if (typeof primaryValue === 'boolean') return primaryValue;
  const legacyValue = cfg.get<boolean>(legacy);
  return typeof legacyValue === 'boolean' ? legacyValue : fallback;
}

function configNumber(primary: string, legacy: string, fallback: number): number {
  const cfg = vscode.workspace.getConfiguration();
  const primaryValue = cfg.get<number>(primary);
  const legacyValue = cfg.get<number>(legacy);
  const raw = Number.isFinite(primaryValue) ? primaryValue : legacyValue;
  return Number.isFinite(raw) ? Math.max(16, Math.min(64, Math.floor(raw as number))) : fallback;
}

function configStringArray(primary: string, legacy: string): string[] {
  const cfg = vscode.workspace.getConfiguration();
  const primaryValue = cfg.get<unknown>(primary);
  const legacyValue = cfg.get<unknown>(legacy);
  const raw = Array.isArray(primaryValue) && primaryValue.length > 0 ? primaryValue : legacyValue;
  return Array.isArray(raw) ? raw.map(item => String(item || '').trim()).filter(Boolean) : [];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readPngDimensions(filePath: string): Promise<{ width: number; height: number } | undefined> {
  try {
    const buf = await fs.readFile(filePath);
    if (buf.length < 24) return undefined;
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return undefined;
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  } catch {
    return undefined;
  }
}

async function readPngDataUri(filePath: string): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(filePath);
    if (buf.length < 24) return undefined;
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return undefined;
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

export class UnpackMetadataService {
  private readonly metadataCache = new Map<string, MetadataCacheEntry>();
  private readonly lstCache = new Map<string, LstCacheEntry>();
  private readonly strCache = new Map<string, StrCacheEntry>();
  private readonly lstPromises = new Map<string, Promise<LstCacheEntry | undefined>>();
  private readonly strPromises = new Map<string, Promise<StrCacheEntry | undefined>>();
  private readonly iconPromises = new Map<string, Promise<DecodedIcon | undefined>>();
  private readonly shopNpcPromises = new Map<string, Promise<ShopNpcMetadataIndex>>();
  private readonly commonSkillCodePromises = new Map<string, Promise<Set<number>>>();
  private npkRootsCache: Promise<string[]> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output?: vscode.OutputChannel,
  ) {}

  clear(): void {
    this.metadataCache.clear();
    this.lstCache.clear();
    this.strCache.clear();
    this.lstPromises.clear();
    this.strPromises.clear();
    this.iconPromises.clear();
    this.shopNpcPromises.clear();
    this.commonSkillCodePromises.clear();
    this.npkRootsCache = undefined;
  }

  invalidate(input: UnpackMetadataInput): void {
    const key = normalizeUnpackKey(input.key);
    if (!key) return;
    if (key.endsWith('.lst') || key.endsWith('.str') || key.endsWith('stringtable.bin')) {
      this.clear();
      return;
    }
    this.metadataCache.delete(this.cacheKey(input));
  }

  getCached(input: UnpackMetadataInput): UnpackResolvedMetadata | undefined {
    return this.metadataCache.get(this.cacheKey(input))?.metadata;
  }

  async resolveMetadata(input: UnpackMetadataInput): Promise<UnpackResolvedMetadata> {
    const stat = await fs.stat(input.fsPath);
    const cacheKey = this.cacheKey(input);
    const cached = this.metadataCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.metadata;

    if (!stat.isFile() || !shouldResolveUnpackMetadataKey(input.key)) {
      const metadata: UnpackResolvedMetadata = {};
      this.metadataCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, metadata });
      return metadata;
    }

    const text = await readUtf8Text(input.fsPath);
    const parsed = parseUnpackScriptText(text, input.key);
    const itemCode = await this.resolveItemCode(input);
    const normalizedKey = normalizeUnpackKey(input.key);
    const simpleParsed = normalizedKey.endsWith('.skl') ? parseSimpleScriptTags(text) : undefined;
    const itemName = parsed.itemName
      ? (normalizedKey.endsWith('.npc')
        ? await this.resolveNpcDisplayName(input.root, input.fsPath, parsed.itemName) || parsed.itemName
        : await this.resolveStringReference(input, parsed.itemName) || parsed.itemName)
      : undefined;
    const commonSkillCodes = normalizedKey.endsWith('.skl') ? await this.loadCommonSkillCodes(input.root, input.version) : undefined;
    const skillKind = simpleParsed ? skillKindFor(normalizedKey, simpleParsed, itemCode, commonSkillCodes, itemName) : undefined;
    const asyncNpcIcon = !parsed.icon && normalizedKey.endsWith('.npc')
      ? await this.resolveFieldAnimationIcon(input.root, input.fsPath, parseScriptMetadata(text).tags)
      : undefined;
    const metadata: UnpackResolvedMetadata = {
      ...parsed,
      ...(asyncNpcIcon ? { icon: asyncNpcIcon } : {}),
      ...(itemName ? { itemName } : {}),
      ...(typeof itemCode === 'number' ? { itemCode } : {}),
      ...(skillKind ? { skillKind } : {}),
    };
    if (metadata.icon) metadata.iconState = 'default';
    this.metadataCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, metadata });
    return metadata;
  }

  async resolveIcon(input: UnpackMetadataInput): Promise<UnpackResolvedMetadata | undefined> {
    const entry = this.metadataCache.get(this.cacheKey(input));
    const metadata = entry?.metadata;
    if (!metadata?.icon) return metadata;
    if (metadata.iconPath && metadata.iconState === 'ready') {
      if (!metadata.iconWidth || !metadata.iconHeight) {
        const dimensions = await readPngDimensions(metadata.iconPath);
        if (dimensions) {
          metadata.iconWidth = dimensions.width;
          metadata.iconHeight = dimensions.height;
        }
      }
      if (!metadata.iconDataUri) {
        metadata.iconDataUri = await readPngDataUri(metadata.iconPath);
      }
      return metadata;
    }
    if (!configBool('pvf.unpackExplorer.npkIcon.enabled', 'pvfExplorer.npkIcon.enabled', true)) {
      metadata.iconState = 'default';
      return metadata;
    }

    metadata.iconState = 'loading';
    try {
      const decoded = await this.decodeIcon(metadata.icon);
      if (decoded) {
        metadata.iconPath = decoded.filePath;
        metadata.iconDataUri = await readPngDataUri(decoded.filePath);
        metadata.iconWidth = decoded.width;
        metadata.iconHeight = decoded.height;
        metadata.iconState = 'ready';
      } else {
        metadata.iconState = 'missing';
      }
    } catch (err: any) {
      metadata.iconState = 'error';
      this.output?.appendLine(`[PVF] failed to decode unpack icon ${input.key}: ${String(err && err.message || err)}`);
    }
    return metadata;
  }

  private cacheKey(input: UnpackMetadataInput): string {
    return `${path.resolve(input.root)}\0${normalizeUnpackKey(input.key)}\0${input.version}`;
  }

  private async resolveItemCode(input: UnpackMetadataInput): Promise<number | undefined> {
    const key = normalizeUnpackKey(input.key);
    for (const lstKey of lstCandidatesForKey(key)) {
      const lstPath = safeJoinArchivePath(input.root, lstKey);
      if (!lstPath) continue;
      const entry = await this.loadLst(lstPath, lstKey);
      const code = entry?.fileToCode.get(key);
      if (typeof code === 'number') return code;
    }
    return codeFromFileName(key);
  }

  private loadCommonSkillCodes(root: string, version: string): Promise<Set<number>> {
    const cacheKey = `${path.resolve(root)}\0${version}`;
    let promise = this.commonSkillCodePromises.get(cacheKey);
    if (!promise) {
      promise = this.readCommonSkillCodes(root);
      this.commonSkillCodePromises.set(cacheKey, promise);
    }
    return promise;
  }

  private async readCommonSkillCodes(root: string): Promise<Set<number>> {
    const filePath = safeJoinArchivePath(root, 'clientonly/commonskilllist.co');
    if (!filePath) return new Set();
    let text = '';
    try {
      text = await readUtf8Text(filePath);
    } catch {
      return new Set();
    }

    const codes = new Set<number>();
    let inCommonSkill = false;
    for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      const tag = line.match(/^\[([^\]]+)\]/);
      if (tag) {
        const name = tag[1].trim().toLowerCase();
        if (name === 'common skill') {
          inCommonSkill = true;
          const inline = line.slice(tag[0].length);
          for (const code of numbersFromText(inline)) codes.add(code);
          continue;
        }
        if (name === '/common skill') {
          inCommonSkill = false;
          continue;
        }
      }
      if (!inCommonSkill) continue;
      for (const code of numbersFromText(stripLineComment(line))) codes.add(code);
    }
    return codes;
  }

  private async loadLst(lstDiskPath: string, lstKey?: string): Promise<LstCacheEntry | undefined> {
    const cacheKey = lstCacheKey(lstDiskPath, lstKey);
    let stat: import('fs').Stats;
    try {
      stat = await fs.stat(lstDiskPath);
      if (!stat.isFile()) return undefined;
    } catch {
      return undefined;
    }

    const cached = this.lstCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;

    const existing = this.lstPromises.get(cacheKey);
    if (existing) return existing;

    const promise = readLstFileToCodeMap(lstDiskPath, lstKey)
      .then(fileToCode => {
        const codeToFile = new Map<number, string>();
        for (const [file, code] of fileToCode) {
          if (!codeToFile.has(code)) codeToFile.set(code, file);
        }
        const entry = { mtimeMs: stat.mtimeMs, size: stat.size, fileToCode, codeToFile };
        this.lstCache.set(cacheKey, entry);
        return entry;
      })
      .catch((err: any) => {
        this.output?.appendLine(`[PVF] failed to read unpack lst ${lstDiskPath}: ${String(err && err.message || err)}`);
        return undefined;
      })
      .finally(() => this.lstPromises.delete(cacheKey));
    this.lstPromises.set(cacheKey, promise);
    return promise;
  }

  private async loadStr(strDiskPath: string): Promise<StrCacheEntry | undefined> {
    let stat: import('fs').Stats;
    try {
      stat = await fs.stat(strDiskPath);
      if (!stat.isFile()) return undefined;
    } catch {
      return undefined;
    }

    const cached = this.strCache.get(strDiskPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;

    const existing = this.strPromises.get(strDiskPath);
    if (existing) return existing;

    const promise = readStrFile(strDiskPath)
      .then(values => {
        const entry = { mtimeMs: stat.mtimeMs, size: stat.size, values };
        this.strCache.set(strDiskPath, entry);
        return entry;
      })
      .catch((err: any) => {
        this.output?.appendLine(`[PVF] failed to read unpack str ${strDiskPath}: ${String(err && err.message || err)}`);
        return undefined;
      })
      .finally(() => this.strPromises.delete(strDiskPath));
    this.strPromises.set(strDiskPath, promise);
    return promise;
  }

  private async resolveStringReference(input: UnpackMetadataInput, value: string): Promise<string | undefined> {
    if (!/^[a-z][a-z0-9_]*_[a-z0-9_]+$/i.test(value)) return undefined;
    for (const strKey of strCandidatesForKey(input.key)) {
      const strPath = safeJoinArchivePath(input.root, strKey);
      if (!strPath) continue;
      const entry = await this.loadStr(strPath);
      const resolved = entry?.values.get(value);
      if (resolved && resolved !== value) return resolved;
    }
    return undefined;
  }

  private async resolveNpcDisplayName(root: string, npcPath: string, rawName: string | undefined): Promise<string | undefined> {
    const key = normalizeUnpackKey(path.relative(root, npcPath));
    const input: UnpackMetadataInput = {
      fsPath: npcPath,
      key,
      name: path.basename(npcPath),
      root,
      version: '0',
    };
    if (rawName) {
      const resolved = await this.resolveStringReference(input, rawName);
      if (resolved && resolved !== rawName && isUsefulDisplayName(resolved)) return resolved;
    }

    const base = path.basename(npcPath, path.extname(npcPath)).toLowerCase();
    for (const candidate of [`name_${base}`, `field_name_${base}`]) {
      const resolved = await this.resolveStringReference(input, candidate);
      if (resolved && resolved !== candidate && isUsefulDisplayName(resolved)) return resolved;
    }

    return isUsefulDisplayName(rawName) ? rawName : undefined;
  }

  private async resolveFieldAnimationIcon(
    root: string,
    ownerPath: string,
    tags: Record<string, string | string[]> | undefined,
  ): Promise<UnpackIconReference | undefined> {
    const raw = tagValueToString(tags?.['field animation']);
    if (!raw) return undefined;
    const normalized = normalizeUnpackKey(raw);
    const candidates = unique([
      path.resolve(path.dirname(ownerPath), ...normalized.split('/').filter(Boolean)),
      ...(safeJoinArchivePath(root, normalized) ? [safeJoinArchivePath(root, normalized)!] : []),
      ...(safeJoinArchivePath(root, `npc/${normalized}`) ? [safeJoinArchivePath(root, `npc/${normalized}`)!] : []),
    ]);
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) continue;
        const icon = aniFirstImageIcon(await readUtf8Text(candidate));
        if (icon) return icon;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async resolveDelegatedMetadata(input: UnpackMetadataInput, itemCode: number | undefined, text: string): Promise<UnpackResolvedMetadata | undefined> {
    const key = normalizeUnpackKey(input.key);
    if (!key.endsWith('.shp') || typeof itemCode !== 'number') return undefined;
    const index = await this.loadShopNpcMetadata(input.root, input.version);
    const parsed = parseScriptMetadata(text);
    const npcId = tagValueToInt(parsed.tags?.npc);
    if (typeof npcId === 'number') {
      const byNpc = index.byDialogNpcId.get(npcId);
      if (byNpc) return byNpc;
    }
    return index.byShopCode.get(itemCode);
  }

  private loadShopNpcMetadata(root: string, version: string): Promise<ShopNpcMetadataIndex> {
    const cacheKey = `${path.resolve(root)}\0${version}`;
    let promise = this.shopNpcPromises.get(cacheKey);
    if (!promise) {
      promise = this.buildShopNpcMetadata(root);
      this.shopNpcPromises.set(cacheKey, promise);
    }
    return promise;
  }

  private async buildShopNpcMetadata(root: string): Promise<ShopNpcMetadataIndex> {
    const byShopCode = new Map<number, UnpackResolvedMetadata>();
    const byDialogNpcId = new Map<number, UnpackResolvedMetadata>();
    const npcDir = path.join(root, 'npc');
    let dirents: import('fs').Dirent[];
    try {
      dirents = await fs.readdir(npcDir, { withFileTypes: true });
    } catch {
      return { byShopCode, byDialogNpcId };
    }

    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith('.npc')) continue;
      const npcPath = path.join(npcDir, dirent.name);
      let text: string;
      try {
        text = await readUtf8Text(npcPath);
      } catch {
        continue;
      }
      const parsed = parseScriptMetadata(text);
      const roleLines = allTagLines(parsed.tags?.role);
      const shopCodes: number[] = [];
      for (const line of roleLines) {
        if (!/\[item shop\]/i.test(line)) continue;
        const match = line.match(/\[item shop\][^\d-]*(-?\d+)/i);
        const code = match ? Number(match[1]) : NaN;
        if (Number.isSafeInteger(code)) shopCodes.push(code);
      }
      const dialogIds = new Set<number>();
      for (const match of text.matchAll(/<npc::(-?\d+)>/gi)) {
        const id = Number(match[1]);
        if (Number.isSafeInteger(id)) dialogIds.add(id);
      }
      if (shopCodes.length === 0 && dialogIds.size === 0) continue;

      const rawName = parsed.name || parsed.name2 || pickNameLikeTag(parsed.tags);
      const resolvedName = await this.resolveNpcDisplayName(root, npcPath, rawName);
      const icon = faceIconFromTags(parsed.tags) || await this.resolveFieldAnimationIcon(root, npcPath, parsed.tags);
      const metadata: UnpackResolvedMetadata = {
        ...(isUsefulDisplayName(resolvedName) ? { itemName: resolvedName } : {}),
        ...(icon ? { icon } : {}),
      };
      if (!metadata.itemName && !metadata.icon) continue;
      for (const code of shopCodes) {
        if (!byShopCode.has(code)) byShopCode.set(code, metadata);
      }
      for (const id of dialogIds) {
        if (!byDialogNpcId.has(id)) byDialogNpcId.set(id, metadata);
      }
    }
    return { byShopCode, byDialogNpcId };
  }

  private async getNpkRoots(): Promise<string[]> {
    if (!this.npkRootsCache) {
      this.npkRootsCache = (async () => {
        const cfg = vscode.workspace.getConfiguration();
        const settingRoots = configStringArray('pvf.unpackExplorer.npkIcon.paths', 'pvfExplorer.npkIcon.paths');
        const envRoots = await readConfiguredNpkRoots(this.context);
        const legacyRoot = (cfg.get<string>('pvf.npkRoot') || '').trim();
        return unique([...settingRoots, ...envRoots, ...(legacyRoot ? [legacyRoot] : [])]);
      })();
    }
    return this.npkRootsCache;
  }

  private async decodeIcon(icon: UnpackIconReference): Promise<DecodedIcon | undefined> {
    const roots = await this.getNpkRoots();
    if (roots.length === 0) return undefined;
    const size = configNumber('pvf.unpackExplorer.npkIcon.size', 'pvfExplorer.npkIcon.size', 16);
    const cacheEnabled = configBool('pvf.unpackExplorer.npkIcon.cache.enabled', 'pvfExplorer.npkIcon.cache.enabled', true);
    const sessionNonce = cacheEnabled ? 'cache' : `${Date.now()}:${Math.random()}`;
    const promiseKey = `${roots.join('|')}\0${icon.imagePath}\0${icon.frameIndex}\0${size}\0${sessionNonce}`;
    const existing = this.iconPromises.get(promiseKey);
    if (existing) return existing;

    const promise = this.decodeIconUncached(roots, icon, promiseKey, cacheEnabled)
      .finally(() => this.iconPromises.delete(promiseKey));
    this.iconPromises.set(promiseKey, promise);
    return promise;
  }

  private async decodeIconUncached(
    roots: string[],
    icon: UnpackIconReference,
    cacheKeyInput: string,
    cacheEnabled: boolean,
  ): Promise<DecodedIcon | undefined> {
    const hash = quickHash(`${cacheKeyInput}\0unpack-png-v1`);
    const cacheDir = path.join(this.context.globalStorageUri.fsPath, 'unpack-icon-cache');
    const filePath = path.join(cacheDir, `${hash}.png`);
    if (cacheEnabled && await fileExists(filePath)) {
      const dimensions = await readPngDimensions(filePath);
      return dimensions ? { filePath, width: dimensions.width, height: dimensions.height } : { filePath, width: 0, height: 0 };
    }

    const indexer = await import('../npk/indexer.js');
    const { ensureIndex, loadAlbumForImage } = await import('../commander/previewAni/npkResolver.js');
    const { getSpriteRgba } = await import('../npk/imgReader.js');
    await ensureIndex(this.context).catch(() => undefined);
    const index = indexer.getIndex();
    if (!index || index.size === 0) return undefined;
    const hasPathPlaceholder = /%0?\d*d/i.test(icon.imagePath);
    if (!hasPathPlaceholder && !await indexer.findNpkFor(icon.imagePath)) return undefined;
    for (const root of roots) {
      const album = await loadAlbumForImage(this.context, root, icon.imagePath, this.output).catch(() => undefined);
      const sprite = album?.sprites?.[icon.frameIndex];
      if (!album || !sprite) continue;
      const rgba = getSpriteRgba(album as any, icon.frameIndex);
      if (!rgba) continue;
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(filePath, encodePng(rgba, sprite.width, sprite.height));
      return { filePath, width: sprite.width, height: sprite.height };
    }
    return undefined;
  }
}
