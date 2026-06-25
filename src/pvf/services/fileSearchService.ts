import { PvfModel } from '../model';

export interface FileIndexEntry {
  key: string; lower: string; base: string;
  displayName?: string;
  displayNameLower?: string;
}

let builtIndex: FileIndexEntry[] | null = null;
let building = false;

export interface FileSearchProgress { phase: 'index' | 'match' | 'done' | 'metadata'; processed?: number; total?: number; }

export async function ensureFileIndexAsync(model: PvfModel, progress?: (p: FileSearchProgress) => void): Promise<FileIndexEntry[] | null> {
  if (builtIndex || building) return builtIndex;
  building = true;
  // 先为所有非排除文件解析元数据，确保 [name] 中文名可用
  const allKeys = model.getAllKeys().sort();
  const metadataKeys = allKeys.filter(k => {
    const lower = k.toLowerCase();
    return !lower.endsWith('.nut') && !lower.endsWith('.lst') && !lower.endsWith('.ani') && !lower.endsWith('.ani.als')
      && !lower.endsWith('.als') && !lower.endsWith('.ui') && !lower.endsWith('.png') && !lower.endsWith('.jpg')
      && !lower.endsWith('.jpeg') && !lower.endsWith('.dds') && !lower.endsWith('.bmp') && !lower.endsWith('.tga')
      && !lower.endsWith('.gif') && !lower.endsWith('.wav') && !lower.endsWith('.ogg') && !lower.endsWith('.mp3')
      && !lower.endsWith('.bin');
  });
  if (metadataKeys.length > 0) {
    progress?.({ phase: 'metadata', processed: 0, total: metadataKeys.length });
    // 分批解析元数据，避免长时间阻塞事件循环
    const batchSize = 256;
    for (let start = 0; start < metadataKeys.length; start += batchSize) {
      const batch = metadataKeys.slice(start, start + batchSize);
      await (model as any).ensureMetadataForFiles?.(batch);
      progress?.({ phase: 'metadata', processed: Math.min(start + batchSize, metadataKeys.length), total: metadataKeys.length });
    }
  }
  const raw = allKeys;
  const out: FileIndexEntry[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const k = raw[i];
    const base = k.lastIndexOf('/') >= 0 ? k.substring(k.lastIndexOf('/') + 1) : k;
    const disp = model.getDisplayNameForFile(k);
    out[i] = { key: k, lower: k.toLowerCase(), base, displayName: disp, displayNameLower: disp?.toLowerCase() };
    if (i % 1000 === 0) { progress?.({ phase: 'index', processed: i, total: raw.length }); await Promise.resolve(); }
  }
  builtIndex = out;
  building = false;
  progress?.({ phase: 'index', processed: raw.length, total: raw.length });
  return builtIndex;
}

export function getIndexedFirst(count: number): FileIndexEntry[] { return builtIndex ? builtIndex.slice(0, count) : []; }

export async function rankFileMatchesAsync(token: string, limitCandidates = 8000, limitReturn = 600, progress?: (p: FileSearchProgress) => void): Promise<FileIndexEntry[]> {
  if (!builtIndex) return [];
  const candidates: FileIndexEntry[] = [];
  for (let i = 0; i < builtIndex.length; i++) {
    const e = builtIndex[i];
    if (!token || e.lower.indexOf(token) !== -1 || (e.displayNameLower && e.displayNameLower.indexOf(token) !== -1)) {
      candidates.push(e);
      if (candidates.length >= limitCandidates) break;
    }
    if (i % 5000 === 0) { progress?.({ phase: 'match', processed: i, total: builtIndex.length }); await Promise.resolve(); }
  }
  progress?.({ phase: 'match', processed: builtIndex.length, total: builtIndex.length });
  if (!token) return candidates.slice(0, limitReturn);
  return candidates
    .map(e => {
      const pLower = e.lower.indexOf(token);
      const pDisplay = e.displayNameLower ? e.displayNameLower.indexOf(token) : -1;
      const p = pLower !== -1 ? pLower : (pDisplay !== -1 ? pDisplay + 0.5 : Infinity);
      return { e, p };
    })
    .filter(o => o.p !== Infinity)
    .sort((a, b) => a.p - b.p || a.e.base.length - b.e.base.length || a.e.key.length - b.e.key.length)
    .slice(0, limitReturn)
    .map(o => o.e);
}

export function resetFileIndex() { builtIndex = null; }
