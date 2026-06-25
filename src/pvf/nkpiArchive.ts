import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import * as iconv from 'iconv-lite';
import { performance } from 'perf_hooks';
import { PvfFile } from './pvfFile';
import {
  PVF_DIRECTORY_MANIFEST_VERSION,
  PVF_MANIFEST_FILE,
  PvfArchivePhaseStats,
  PvfDirectoryManifest,
  PvfDiskFileKind,
  PvfDiskFileManifestEntry,
  createManifestEntryMap,
  normalizeArchiveKey,
  runConcurrent,
  stripUtf8Bom,
} from './directoryArchive';

const HEADER_SIZE = 0x30;
const FILE_ITEM_SIZE = 0x18;
const NKPI_SIGNATURE = 0x69706b6e;
const WINDOWS_INVALID_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

export type PvfArchiveFormat = 'classic' | 'nkpi';

export interface NkpiHeader {
  signature: number;
  guid: Buffer;
  fileCount: number;
  padding: number;
  bodySize: number;
  groupCount: number;
  hashTableSize: number;
  nameTableSize: number;
}

export interface NkpiFileItem {
  nameOffset: number;
  pathOffset: number;
  chunkIndex: number;
  dataOffset: number;
  dataSize: number;
  dataType: number;
}

export interface NkpiFileRecord {
  key: string;
  originalKey: string;
  name: string;
  dir: string;
  entry: NkpiFileItem;
}

export interface NkpiGroupItem {
  compressedSize: number;
  originalSize: number;
}

export interface NkpiArchiveData {
  header: NkpiHeader;
  files: NkpiFileRecord[];
  groups: NkpiGroupItem[];
  bodyOffset: number;
  bodyLength: number;
  allBytes: Buffer;
  strA: Buffer;
  strW: Buffer;
  rawTableOffset: number;
  rawTableSize: number;
  rawHashBytes: Buffer;
  rawNameBytes: Buffer;
  rawGrpiBytes: Buffer;
  stringOffsetCache?: Map<string, number>;
}

export interface NkpiModelState {
  archive: NkpiArchiveData;
  indexByKey: Map<string, number>;
  keyByFile: WeakMap<PvfFile, string>;
  dataTypeByKey: Map<string, number>;
}

export interface NkpiUnpackResult {
  total: number;
  extracted: number;
  skipped: number;
  errors: number;
  groups: number;
}

export interface NkpiRepackResult {
  totalFiles: number;
  replaced: number;
  unchanged: number;
  skippedChunks: number;
  rebuiltChunks: number;
  outputSize: number;
}

export interface NkpiRepackOptions {
  progress?: (current: number, total: number, label: string) => void;
  onStats?: (stats: PvfArchivePhaseStats) => void;
}

export function isNkpiPvf(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size < HEADER_SIZE) return false;
      const head = Buffer.alloc(HEADER_SIZE);
      fs.readSync(fd, head, 0, HEADER_SIZE, 0);
      const guarded = tryDecodeHeaderFromPrefix(head, true);
      if (guarded?.signature === NKPI_SIGNATURE) return true;
      const plain = tryDecodeHeaderFromPrefix(head, false);
      return plain?.signature === NKPI_SIGNATURE;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export async function openNkpiIntoModel(model: any, filePath: string, progress?: (n: number) => void): Promise<NkpiModelState> {
  resetModel(model);
  model.pvfPath = filePath;
  model.archiveFormat = 'nkpi';
  const allBytes = await fsp.readFile(filePath);
  const archive = parseNkpiArchive(allBytes);
  const indexByKey = new Map<string, number>();
  const keyByFile = new WeakMap<PvfFile, string>();
  const dataTypeByKey = new Map<string, number>();

  for (let i = 0; i < archive.files.length; i++) {
    const file = archive.files[i];
    const nameBytes = Buffer.from(file.key, 'utf8');
    const pf = new PvfFile(0, nameBytes, file.entry.dataSize, 0, i);
    (pf as any).fileNameOverride = file.key;
    (pf as any).nkpiDataType = file.entry.dataType;
    if (file.entry.dataSize <= 0) {
      pf.data = new Uint8Array(0);
    }
    model.fileList.set(file.key, pf);
    indexByKey.set(file.key, i);
    keyByFile.set(pf, file.key);
    dataTypeByKey.set(file.key, file.entry.dataType);
    if (progress && i % 4096 === 0) progress(Math.floor((i / Math.max(1, archive.files.length)) * 80));
  }

  model.nkpiState = { archive, indexByKey, keyByFile, dataTypeByKey };
  model.fileVersion = archive.header.padding;
  model.guid = archive.header.guid;
  model.guidLen = archive.header.guid.length;
  model.baseOffset = archive.bodyOffset;
  model.childrenCache?.clear?.();
  model.rootChildren = null;
  if (progress) progress(100);
  return model.nkpiState;
}

export function readNkpiFileData(state: NkpiModelState, f: PvfFile): Uint8Array {
  if (f.data) return f.data;
  const key = state.keyByFile.get(f) || (f as any).fileNameOverride;
  const index = typeof key === 'string' ? findNkpiFileIndex(state.indexByKey, key) : undefined;
  if (index === undefined) {
    f.data = new Uint8Array(0);
    return f.data;
  }
  const file = state.archive.files[index];
  const chunk = getChunkData(state.archive, file.entry.chunkIndex);
  if (!chunk || file.entry.dataOffset < 0 || file.entry.dataOffset + file.entry.dataSize > chunk.length) {
    f.data = new Uint8Array(0);
    return f.data;
  }
  const raw = chunk.subarray(file.entry.dataOffset, file.entry.dataOffset + file.entry.dataSize);
  f.data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice();
  return f.data;
}

function findNkpiFileIndex(indexByKey: Map<string, number>, key: string): number | undefined {
  const normalized = normalizeArchiveKey(key);
  return indexByKey.get(normalized)
    ?? indexByKey.get(`./${normalized}`)
    ?? (normalized.startsWith('./') ? indexByKey.get(normalized.slice(2)) : undefined);
}

export async function unpackNkpiToDirectory(
  pvfPath: string,
  destDir: string,
  progress?: (current: number, total: number, key: string) => void,
  options?: {
    chunkConcurrency?: number;
    skipExisting?: boolean;
    onStats?: (stats: PvfArchivePhaseStats) => void;
  },
): Promise<NkpiUnpackResult> {
  const phaseStart = performance.now();
  const allBytes = await fsp.readFile(pvfPath);
  const archive = parseNkpiArchive(allBytes);
  const targetRoot = path.resolve(destDir);
  await fsp.mkdir(targetRoot, { recursive: true });

  const manifestFiles = new Array<PvfDiskFileManifestEntry>(archive.files.length);
  const conflictPaths = buildConflictPaths(archive.files);
  const chunks = archive.groups.map((_, chunkIndex) => chunkIndex);
  let extracted = 0;
  let skipped = 0;
  let errors = 0;
  let lastPct = -1;

  await runConcurrent(chunks, clampInt(options?.chunkConcurrency, 1, 1, 8), async (chunkIndex) => {
    let chunk: Buffer | null;
    try {
      chunk = getChunkData(archive, chunkIndex);
    } catch {
      errors++;
      reportNkpiProgress();
      return;
    }
    const files = archive.files
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => file.entry.chunkIndex === chunkIndex);

    for (const { file, index } of files) {
      try {
        let key = file.key;
        if (!key || file.name.endsWith('/') || file.name.endsWith('\\')) {
          extracted++;
          reportNkpiProgress(key);
          continue;
        }
        if (conflictPaths.has(key)) key += '._file';
        const diskPath = safeJoinArchivePath(targetRoot, key);
        await fsp.mkdir(path.dirname(diskPath), { recursive: true });
        const prepared = prepareUnpackFileData(archive, file, chunk);
        if (!prepared) {
          manifestFiles[index] = [key, 'binary'];
          skipped++;
        } else {
          if (!options?.skipExisting || !fs.existsSync(diskPath)) {
            await fsp.writeFile(diskPath, prepared.data);
          }
          manifestFiles[index] = prepared.encoding ? [key, prepared.kind, prepared.encoding] : [key, prepared.kind];
          extracted++;
        }
      } catch {
        errors++;
      }
      reportNkpiProgress(file.key);
    }
  });

  const manifest: PvfDirectoryManifest = {
    version: PVF_DIRECTORY_MANIFEST_VERSION,
    archiveFormat: 'nkpi',
    guid: archive.header.guid.toString('hex'),
    guidLen: archive.header.guid.length,
    sourcePvfPath: pvfPath,
    fileVersion: archive.header.padding,
    encodingMode: 'NKPI',
    defaultEncoding: 'utf8',
    chineseConversion: 'off',
    fileCount: archive.files.length,
    files: manifestFiles.map((entry, index) => entry || [archive.files[index].key, 'binary']),
    nkpi: createNkpiManifestPayload(archive),
  };
  await fsp.writeFile(path.join(targetRoot, PVF_MANIFEST_FILE), JSON.stringify(manifest), 'utf8');

  const done = performance.now();
  options?.onStats?.({
    files: archive.files.length,
    totalMs: done - phaseStart,
    phases: {
      parse: 0,
      pipelineWrite: done - phaseStart,
      manifest: 0,
    },
  });
  return { total: archive.files.length, extracted, skipped, errors, groups: archive.groups.length };

  function reportNkpiProgress(key = '') {
    const doneCount = extracted + skipped + errors;
    const pct = archive.files.length > 0 ? Math.floor(doneCount * 100 / archive.files.length) : 100;
    if (progress && pct !== lastPct) {
      lastPct = pct;
      progress(doneCount, archive.files.length, key);
    }
  }
}

export async function repackNkpiDirectory(
  srcDir: string,
  templatePvfPath: string,
  outputPvfPath: string,
  options?: NkpiRepackOptions,
): Promise<NkpiRepackResult> {
  const phaseStart = performance.now();
  const archive = parseNkpiArchive(await fsp.readFile(templatePvfPath));
  const manifest = await readManifest(srcDir);
  const manifestEntries = createManifestEntryMap(manifest);
  const diskIndex = await buildDiskIndex(srcDir);
  const result: NkpiRepackResult = {
    totalFiles: archive.files.length,
    replaced: 0,
    unchanged: 0,
    skippedChunks: 0,
    rebuiltChunks: 0,
    outputSize: 0,
  };

  const chunkGroups = new Map<number, number[]>();
  const fileDiskPaths = new Array<string | undefined>(archive.files.length);
  for (let i = 0; i < archive.files.length; i++) {
    const file = archive.files[i];
    const list = chunkGroups.get(file.entry.chunkIndex) || [];
    list.push(i);
    chunkGroups.set(file.entry.chunkIndex, list);
    if (file.entry.dataSize > 0 && !file.name.endsWith('/') && !file.name.endsWith('\\')) {
      const manifestEntry = manifestEntries.get(file.key);
      const preferredKey = manifestEntry?.[0] || file.key;
      fileDiskPaths[i] = diskIndex.get(normalizeArchiveKey(preferredKey)) || diskIndex.get(file.key);
    }
  }

  const diskFileSizes = new Map<string, number>();
  for (const diskPath of fileDiskPaths) {
    if (!diskPath || diskFileSizes.has(diskPath)) continue;
    try {
      diskFileSizes.set(diskPath, (await fsp.stat(diskPath)).size);
    } catch {
      diskFileSizes.set(diskPath, -1);
    }
  }

  const newItems = archive.files.map(file => ({ ...file.entry }));
  const chunkNeedRebuild = new Array<boolean>(archive.groups.length).fill(false);
  for (let i = 0; i < archive.files.length; i++) {
    const diskPath = fileDiskPaths[i];
    if (!diskPath) continue;
    const item = archive.files[i].entry;
    const size = diskFileSizes.get(diskPath) ?? -1;
    if (size !== item.dataSize) {
      chunkNeedRebuild[item.chunkIndex] = true;
      continue;
    }
    if (size >= 0 && await fileContentDiffers(diskPath, archive, archive.files[i])) {
      chunkNeedRebuild[item.chunkIndex] = true;
    }
  }

  const outDir = path.dirname(outputPvfPath);
  if (outDir) await fsp.mkdir(outDir, { recursive: true });
  const tempBodyPath = outputPvfPath + '.body.tmp';
  const bodyFd = await fsp.open(tempBodyPath, 'w');
  const newGroups: NkpiGroupItem[] = [];
  let cumulativeCompressed = 0;
  let afterIndex = performance.now();
  let afterBody = afterIndex;

  try {
    for (let chunkIndex = 0; chunkIndex < archive.groups.length; chunkIndex++) {
      const fileIndices = chunkGroups.get(chunkIndex) || [];
      const needRebuild = chunkNeedRebuild[chunkIndex] && fileIndices.length > 0;
      if (!needRebuild) {
        const rawEncrypted = getChunkRawEncrypted(archive, chunkIndex);
        if (rawEncrypted) {
          await bodyFd.write(rawEncrypted);
          cumulativeCompressed += rawEncrypted.length;
          newGroups.push({ compressedSize: cumulativeCompressed, originalSize: archive.groups[chunkIndex].originalSize });
          result.skippedChunks++;
        }
      } else {
        const originalChunk = getChunkData(archive, chunkIndex);
        const updates: Array<{ fileIndex: number; newData?: Buffer }> = [];
        for (const fileIndex of fileIndices) {
          const diskPath = fileDiskPaths[fileIndex];
          const item = newItems[fileIndex];
          if (!diskPath || item.dataSize <= 0) {
            updates.push({ fileIndex });
            continue;
          }
          const diskSize = diskFileSizes.get(diskPath) ?? -1;
          const sourceKey = archive.files[fileIndex].key;
          let rawDisk = await fsp.readFile(diskPath);
          const manifestEntry = manifestEntries.get(sourceKey);
          rawDisk = prepareRepackData(rawDisk, manifestEntry?.[1], item.dataType, archive, sourceKey);
          if (diskSize !== item.dataSize || await fileContentDiffersBuffer(rawDisk, archive, archive.files[fileIndex])) {
            result.replaced++;
            updates.push({ fileIndex, newData: rawDisk });
          } else {
            result.unchanged++;
            updates.push({ fileIndex });
          }
        }
        const newChunk = rebuildChunk(originalChunk || Buffer.alloc(0), updates, newItems);
        const encrypted = zlibCompress(newChunk);
        decrypt('BodY', encrypted);
        await bodyFd.write(encrypted);
        cumulativeCompressed += encrypted.length;
        newGroups.push({ compressedSize: cumulativeCompressed, originalSize: newChunk.length });
        result.rebuiltChunks++;
      }
      if (options?.progress && (chunkIndex % 50 === 0 || chunkIndex === archive.groups.length - 1)) {
        options.progress(chunkIndex + 1, archive.groups.length, `chunk ${chunkIndex + 1}/${archive.groups.length}`);
      }
    }
  } finally {
    await bodyFd.close();
  }

  afterBody = performance.now();
  const tableBytes = buildFileItemTable(newItems);
  const hashBytes = buildHashTableBytes(newItems, offset => resolveString(archive.strA, archive.strW, offset));
  decrypt('HASH', hashBytes);
  const nameBytes = Buffer.from(archive.rawNameBytes);
  const grpiBytes = buildGrpiBytes(newGroups);
  decrypt('GRPI', grpiBytes);
  const headerBytes = buildHeaderBytes({
    ...archive.header,
    bodySize: cumulativeCompressed,
    groupCount: newGroups.length,
    hashTableSize: hashBytes.length,
    nameTableSize: nameBytes.length,
  });
  decrypt('HeaD', headerBytes);
  rotHeaderGuard(headerBytes);

  const outFd = await fsp.open(outputPvfPath, 'w');
  try {
    await outFd.write(headerBytes);
    await outFd.write(tableBytes);
    await outFd.write(hashBytes);
    await outFd.write(nameBytes);
    await outFd.write(grpiBytes);
    const body = await fsp.readFile(tempBodyPath);
    await outFd.write(body);
    result.outputSize = HEADER_SIZE + tableBytes.length + hashBytes.length + nameBytes.length + grpiBytes.length + body.length;
  } finally {
    await outFd.close();
    try { await fsp.unlink(tempBodyPath); } catch { /* ignore */ }
  }

  try {
    parseNkpiArchive(await fsp.readFile(outputPvfPath));
  } catch (err) {
    try { await fsp.unlink(outputPvfPath); } catch { /* ignore */ }
    throw new Error(`新版 PVF 写出后自检失败：${err instanceof Error ? err.message : String(err)}`);
  }

  const done = performance.now();
  options?.onStats?.({
    files: archive.files.length,
    totalMs: done - phaseStart,
    phases: {
      index: afterIndex - phaseStart,
      body: afterBody - afterIndex,
      assemble: done - afterBody,
    },
  });
  return result;
}

export async function repackNkpiFromModel(model: any, outputPvfPath: string, progress?: (n: number) => void): Promise<boolean> {
  const state = model.nkpiState as NkpiModelState | undefined;
  if (!state) throw new Error('当前没有打开新版 PVF');
  const archive = state.archive;
  const newItems = archive.files.map(file => ({ ...file.entry }));
  const modifiedChunks = new Set<number>();
  for (const [key, index] of state.indexByKey.entries()) {
    const f = model.fileList.get(key) as PvfFile | undefined;
    if (f?.changed) modifiedChunks.add(archive.files[index].entry.chunkIndex);
  }

  if (modifiedChunks.size === 0) {
    await fsp.writeFile(outputPvfPath, assembleNkpiBytes(
      archive,
      buildFileItemTable(newItems),
      archive.rawHashBytes,
      archive.rawNameBytes,
      archive.rawGrpiBytes,
      archive.bodyLength,
    ));
    return true;
  }

  const outDir = path.dirname(outputPvfPath);
  if (outDir) await fsp.mkdir(outDir, { recursive: true });
  const tempBodyPath = outputPvfPath + '.body.tmp';
  const bodyFd = await fsp.open(tempBodyPath, 'w');
  const newGroups: NkpiGroupItem[] = [];
  let cumulativeCompressed = 0;
  try {
    for (let chunkIndex = 0; chunkIndex < archive.groups.length; chunkIndex++) {
      if (!modifiedChunks.has(chunkIndex)) {
        const rawEncrypted = getChunkRawEncrypted(archive, chunkIndex);
        if (rawEncrypted) {
          await bodyFd.write(rawEncrypted);
          cumulativeCompressed += rawEncrypted.length;
          newGroups.push({ compressedSize: cumulativeCompressed, originalSize: archive.groups[chunkIndex].originalSize });
        }
      } else {
        const originalChunk = getChunkData(archive, chunkIndex) || Buffer.alloc(0);
        const updates: Array<{ fileIndex: number; newData?: Buffer }> = [];
        for (let i = 0; i < archive.files.length; i++) {
          if (archive.files[i].entry.chunkIndex !== chunkIndex) continue;
          const file = archive.files[i];
          const f = model.fileList.get(file.key) as PvfFile | undefined;
          updates.push({ fileIndex: i, newData: f?.changed && f.data ? Buffer.from(f.data.subarray(0, f.dataLen)) : undefined });
        }
        const newChunk = rebuildChunk(originalChunk, updates, newItems);
        const encrypted = zlibCompress(newChunk);
        decrypt('BodY', encrypted);
        await bodyFd.write(encrypted);
        cumulativeCompressed += encrypted.length;
        newGroups.push({ compressedSize: cumulativeCompressed, originalSize: newChunk.length });
      }
      if (progress && chunkIndex % 50 === 0) progress(Math.floor((chunkIndex / Math.max(1, archive.groups.length)) * 100));
    }
  } finally {
    await bodyFd.close();
  }

  const tableBytes = buildFileItemTable(newItems);
  const hashBytes = buildHashTableBytes(newItems, offset => resolveString(archive.strA, archive.strW, offset));
  decrypt('HASH', hashBytes);
  const nameBytes = Buffer.from(archive.rawNameBytes);
  const grpiBytes = buildGrpiBytes(newGroups);
  decrypt('GRPI', grpiBytes);
  const headerBytes = buildHeaderBytes({
    ...archive.header,
    bodySize: cumulativeCompressed,
    groupCount: newGroups.length,
    hashTableSize: hashBytes.length,
    nameTableSize: nameBytes.length,
  });
  decrypt('HeaD', headerBytes);
  rotHeaderGuard(headerBytes);

  const outFd = await fsp.open(outputPvfPath, 'w');
  try {
    await outFd.write(headerBytes);
    await outFd.write(tableBytes);
    await outFd.write(hashBytes);
    await outFd.write(nameBytes);
    await outFd.write(grpiBytes);
    const body = await fsp.readFile(tempBodyPath);
    await outFd.write(body);
  } finally {
    await outFd.close();
    try { await fsp.unlink(tempBodyPath); } catch { /* ignore */ }
  }
  for (const key of state.indexByKey.keys()) {
    const f = model.fileList.get(key) as PvfFile | undefined;
    if (f) f.changed = false;
  }
  if (progress) progress(100);
  return true;
}

export function decodeNkpiFileForEditor(data: Uint8Array, dataType: number, archive: NkpiArchiveData, key?: string): Buffer | undefined {
  if (dataType === 1) return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(decodeType1(Buffer.from(data), archive, key), 'utf8')]);
  if (dataType === 3) return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(Buffer.from(data).toString('utf16le'), 'utf8')]);
  return undefined;
}

export function encodeNkpiEditorContent(content: Uint8Array, dataType: number, archive: NkpiArchiveData, key?: string): Buffer | undefined {
  let text = Buffer.from(content).toString('utf8');
  text = stripUtf8Bom(text);
  if (dataType === 1) return encodeType1Text(text, archive, key);
  if (dataType === 3) return Buffer.from(text, 'utf16le');
  return undefined;
}

export function parseNkpiArchive(allBytesInput: Buffer | Uint8Array): NkpiArchiveData {
  const allBytes = Buffer.isBuffer(allBytesInput)
    ? allBytesInput
    : Buffer.from(allBytesInput.buffer, allBytesInput.byteOffset, allBytesInput.byteLength);
  const header = decodeHeader(allBytes);
  let pos = HEADER_SIZE;
  const tableOffset = pos;
  const tableSize = header.fileCount * FILE_ITEM_SIZE;
  pos += tableSize;
  const hashOffset = pos;
  pos += header.hashTableSize;
  const nameOffset = pos;
  pos += header.nameTableSize;
  const grpiOffset = pos;
  const grpiSize = header.groupCount * 8;
  pos += grpiSize;
  const bodyOffset = pos;

  const hashBytes = Buffer.from(allBytes.subarray(hashOffset, hashOffset + header.hashTableSize));
  const nameBytes = Buffer.from(allBytes.subarray(nameOffset, nameOffset + header.nameTableSize));
  const grpiBytes = Buffer.from(allBytes.subarray(grpiOffset, grpiOffset + grpiSize));
  decrypt('HASH', hashBytes);
  decrypt('GRPI', grpiBytes);

  const nameState = { index: 8 };
  const strA = decryptStringBuffer(nameBytes, nameState, 'sTrA', 0xaa74472e);
  const strW = decryptStringBuffer(nameBytes, nameState, 'sTrW', 0x9a82f037);
  const stringCache = new Map<number, string>();
  const getString = (offset: number): string => {
    if (stringCache.has(offset)) return stringCache.get(offset)!;
    const value = resolveString(strA, strW, offset);
    stringCache.set(offset, value);
    return value;
  };

  const files: NkpiFileRecord[] = [];
  for (let i = 0; i < header.fileCount; i++) {
    const off = tableOffset + i * FILE_ITEM_SIZE;
    const entry: NkpiFileItem = {
      nameOffset: allBytes.readInt32LE(off),
      pathOffset: allBytes.readInt32LE(off + 4),
      chunkIndex: allBytes.readInt32LE(off + 8),
      dataOffset: allBytes.readInt32LE(off + 12),
      dataSize: allBytes.readInt32LE(off + 16),
      dataType: allBytes.readInt32LE(off + 20),
    };
    const name = getString(entry.nameOffset);
    const dir = getString(entry.pathOffset);
    const originalKey = normalizeArchiveKey(dir ? `${dir}/${name}` : name);
    const key = sanitizeArchiveKey(originalKey);
    files.push({ key, originalKey, name, dir, entry });
  }

  const groups: NkpiGroupItem[] = [];
  for (let i = 0; i < header.groupCount; i++) {
    const off = i * 8;
    groups.push({
      compressedSize: grpiBytes.readInt32LE(off),
      originalSize: grpiBytes.readInt32LE(off + 4),
    });
  }

  return {
    header,
    files,
    groups,
    bodyOffset,
    bodyLength: header.bodySize,
    allBytes,
    strA,
    strW,
    rawTableOffset: tableOffset,
    rawTableSize: tableSize,
    rawHashBytes: hashBytes,
    rawNameBytes: Buffer.from(allBytes.subarray(nameOffset, nameOffset + header.nameTableSize)),
    rawGrpiBytes: grpiBytes,
  };
}

function resetModel(model: any): void {
  try {
    model.fileList?.clear?.();
    model.childrenCache?.clear?.();
    model.rootChildren = null;
    model.encodingCache?.clear?.();
    model.fileCodeMap?.clear?.();
    model.fileDisplayNameMap?.clear?.();
    model.originalTextMeta?.clear?.();
    model.originalAlsBytes?.clear?.();
    model.strtable = undefined;
    model.strview = undefined;
    model.guid = Buffer.alloc(0);
    model.guidLen = 0;
    model.fileVersion = 0;
    model.nkpiState = undefined;
  } catch {
    // ignore reset errors
  }
}

function tryDecodeHeaderFromPrefix(prefix: Buffer, useGuard: boolean): NkpiHeader | null {
  if (prefix.length < HEADER_SIZE) return null;
  const headerBytes = Buffer.from(prefix.subarray(0, HEADER_SIZE));
  if (useGuard) rotHeaderGuard(headerBytes);
  if (decrypt('HeaD', headerBytes) !== 0) return null;
  return parseHeaderBytes(headerBytes);
}

function decodeHeader(allBytes: Buffer): NkpiHeader {
  if (!allBytes || allBytes.length < HEADER_SIZE) throw new Error('文件太小，无法读取新版 PVF 头');
  const guarded = tryDecodeHeader(allBytes, true);
  if (guarded) return guarded;
  const plain = tryDecodeHeader(allBytes, false);
  if (plain) return plain;
  throw new Error('新版 PVF 头解密失败或区段长度不匹配');
}

function tryDecodeHeader(allBytes: Buffer, useGuard: boolean): NkpiHeader | null {
  const header = tryDecodeHeaderFromPrefix(allBytes.subarray(0, HEADER_SIZE), useGuard);
  if (!header || !isHeaderLayoutValid(header, allBytes.length)) return null;
  return header;
}

function parseHeaderBytes(headerBytes: Buffer): NkpiHeader {
  return {
    signature: headerBytes.readUInt32LE(0),
    guid: Buffer.from(headerBytes.subarray(4, 24)),
    fileCount: headerBytes.readInt32LE(24),
    padding: headerBytes.readInt32LE(28),
    bodySize: headerBytes.readInt32LE(32),
    groupCount: headerBytes.readInt32LE(36),
    hashTableSize: headerBytes.readInt32LE(40),
    nameTableSize: headerBytes.readInt32LE(44),
  };
}

function isHeaderLayoutValid(header: NkpiHeader, fileLength: number): boolean {
  if (header.signature !== NKPI_SIGNATURE) return false;
  if (header.fileCount < 0 || header.bodySize < 0 || header.groupCount < 0 || header.hashTableSize < 0 || header.nameTableSize < 0) return false;
  const expected = HEADER_SIZE
    + header.fileCount * FILE_ITEM_SIZE
    + header.hashTableSize
    + header.nameTableSize
    + header.groupCount * 8
    + header.bodySize;
  return expected === fileLength;
}

function rotHeaderGuard(buf: Buffer): void {
  if (!buf || buf.length < 28) return;
  for (let i = 24; i < 28; i++) buf[i] ^= 0x55;
}

function decryptCore(key: string, buf: Buffer, magic: number): number {
  if (!key || !buf || buf.length === 0) return 0;
  const k = Buffer.from(key, 'ascii');
  if (k.length < 4) return 0;
  let seed = Math.imul(0x76826701, k[0]) + Math.imul(0x1c1, k[3] + Math.imul(0x1c1, k[2] + Math.imul(0x1c1, k[1])));
  const quadCount = buf.length >> 2;
  const tail = buf.length - (quadCount << 2);
  for (let i = 0; i < quadCount; i++) {
    const t1 = (Math.imul(0x343fd, seed) + magic) | 0;
    seed = (Math.imul(0x343fd, t1) + magic) | 0;
    const xorKey = ((((seed >> 16) & 0xffff) + (t1 & 0xffff0000)) >>> 0);
    const off = i << 2;
    buf.writeUInt32LE((buf.readUInt32LE(off) ^ xorKey) >>> 0, off);
  }
  if (tail > 0) {
    const t1 = (Math.imul(0x343fd, seed) + magic) | 0;
    const t2 = (Math.imul(0x343fd, t1) + magic) | 0;
    const finalKey = (((t1 & 0xffff0000) + ((t2 >> 16) & 0xffff)) >>> 0);
    const keyBytes = Buffer.allocUnsafe(4);
    keyBytes.writeUInt32LE(finalKey, 0);
    const start = buf.length - tail;
    for (let i = 0; i < tail; i++) buf[start + i] ^= keyBytes[i];
  }
  return tail;
}

function decrypt(key: string, buf: Buffer): number {
  return decryptCore(key, buf, 0x269ec3);
}

function decryptName(key: string, buf: Buffer): number {
  return decryptCore(key, buf, 0x269ec9);
}

function decryptStringBuffer(nameBytes: Buffer, state: { index: number }, key: string, xorConst: number): Buffer {
  if (state.index + 8 > nameBytes.length) return Buffer.alloc(0);
  const cnt1 = nameBytes.readInt32LE(state.index); state.index += 4;
  state.index += 4;
  const encSize = (cnt1 ^ xorConst) | 0;
  if (encSize <= 0 || state.index + encSize > nameBytes.length) return Buffer.alloc(0);
  const encrypted = Buffer.from(nameBytes.subarray(state.index, state.index + encSize));
  state.index += encSize;
  decryptName(key, encrypted);
  return zlibDecompress(encrypted);
}

function zlibDecompress(buf: Buffer): Buffer {
  if (!buf || buf.length < 6 || buf[0] !== 0x78) {
    throw new Error('invalid zlib stream');
  }
  return zlib.inflateSync(buf);
}

function zlibCompress(data: Buffer): Buffer {
  return zlib.deflateSync(data);
}

function readUtf8String(buffer: Buffer, start: number): string {
  if (!buffer || start < 0 || start >= buffer.length) return '';
  let end = start;
  while (end < buffer.length && buffer[end] !== 0) end++;
  return buffer.subarray(start, end).toString('utf8');
}

function readUtf16String(buffer: Buffer, start: number): string {
  if (!buffer || start < 0 || start >= buffer.length) return '';
  let end = start;
  for (; end + 1 < buffer.length; end += 2) {
    if (buffer[end] === 0 && buffer[end + 1] === 0) break;
  }
  const len = Math.max(0, end - start);
  return len > 0 ? buffer.subarray(start, start + (len & ~1)).toString('utf16le') : '';
}

function resolveString(strA: Buffer, strW: Buffer, magicOffset: number): string {
  if (magicOffset < 0) return '';
  return (magicOffset & 1) !== 0
    ? readUtf16String(strW, (magicOffset >> 1) * 2)
    : readUtf8String(strA, magicOffset >> 1);
}

function resolveDisplayString(strA: Buffer, strW: Buffer, magicOffset: number, restoreCp949MojibakeText: boolean): string {
  const text = resolveString(strA, strW, magicOffset);
  return restoreCp949MojibakeText ? restoreCp949Mojibake(text) : text;
}

function restoreCp949Mojibake(text: string): string {
  if (!looksLikeChineseMojibake(text)) return text;
  const restored = iconv.decode(iconv.encode(text, 'gb18030'), 'cp949');
  return isLikelyRestoredCp949(restored) ? restored : text;
}

function looksLikeChineseMojibake(text: string): boolean {
  let cjk = 0;
  let hangul = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
    else if (code >= 0xac00 && code <= 0xd7af) hangul++;
  }
  return cjk > 0 && hangul === 0;
}

function isLikelyRestoredCp949(text: string): boolean {
  let hangul = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7af) hangul++;
    else if (code >= 0x4e00 && code <= 0x9fff) cjk++;
    else if (isSafeRestoredCp949Char(ch)) {
      // Safe punctuation/ASCII commonly appears in Korean name lists.
    }
    else other++;
  }
  return hangul > 0 && cjk === 0 && other === 0 && hangul >= Math.ceil((hangul + cjk) * 0.8);
}

function isSafeRestoredCp949Char(ch: string): boolean {
  return /[A-Za-z0-9\s`~!@#$%^&*()[\]{}_\-+=:;"',.<>/?\\|]/.test(ch)
    || '☆★○●◎◇◆□■△▲▽▼※·ㆍ…，。、：；！？（）【】《》〈〉'.includes(ch);
}

function sanitizePathPart(part: string): string {
  return part.replace(WINDOWS_INVALID_NAME_CHARS, '_');
}

function sanitizeArchiveKey(key: string): string {
  return normalizeArchiveKey(key).split('/').filter(p => p.length > 0 && p !== '.').map(sanitizePathPart).join('/');
}

function safeJoinArchivePath(root: string, key: string): string {
  const parts = sanitizeArchiveKey(key).split('/').filter(Boolean);
  if (parts.length === 0) throw new Error(`PVF path is empty: ${key}`);
  for (const part of parts) {
    if (part === '..' || part.includes('\0') || part.includes(':')) {
      throw new Error(`PVF path escapes target directory: ${key}`);
    }
  }
  const diskPath = path.resolve(root, ...parts);
  const rel = path.relative(path.resolve(root), diskPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`PVF path escapes target directory: ${key}`);
  }
  return diskPath;
}

function getChunkData(archive: NkpiArchiveData, chunkIndex: number): Buffer | null {
  if (chunkIndex < 0 || chunkIndex >= archive.groups.length) return null;
  const prevCompressed = chunkIndex > 0 ? archive.groups[chunkIndex - 1].compressedSize : 0;
  const currCompressed = archive.groups[chunkIndex].compressedSize;
  const start = archive.bodyOffset + prevCompressed;
  const size = currCompressed - prevCompressed;
  if (size <= 0 || start + size > archive.bodyOffset + archive.bodyLength) return null;
  const encrypted = Buffer.from(archive.allBytes.subarray(start, start + size));
  decrypt('BodY', encrypted);
  return zlibDecompress(encrypted);
}

function getChunkRawEncrypted(archive: NkpiArchiveData, chunkIndex: number): Buffer | null {
  if (chunkIndex < 0 || chunkIndex >= archive.groups.length) return null;
  const prevCompressed = chunkIndex > 0 ? archive.groups[chunkIndex - 1].compressedSize : 0;
  const currCompressed = archive.groups[chunkIndex].compressedSize;
  const start = archive.bodyOffset + prevCompressed;
  const size = currCompressed - prevCompressed;
  if (size <= 0 || start + size > archive.bodyOffset + archive.bodyLength) return null;
  return Buffer.from(archive.allBytes.subarray(start, start + size));
}

function formatFloat32(value: number): string {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32LE(value >>> 0, 0);
  const f = buf.readFloatLE(0);
  const fixed = f.toFixed(6);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

interface NkpiType1Token {
  kind: 'tag' | 'marker' | 'data';
  text: string;
}

interface NkpiScriptTagToken {
  name: string;
  closing: boolean;
}

function decodeType1(data: Buffer, archive: NkpiArchiveData, key = ''): string {
  const normalizedKey = normalizeArchiveKey(key);
  const tokens = decodeType1Tokens(data, archive, shouldRestoreNkpiLstCp949Mojibake(normalizedKey));
  if (normalizedKey.endsWith('.lst')) return formatNkpiLst(tokens);
  return formatNkpiScript(tokens, key);
}

function decodeType1Tokens(data: Buffer, archive: NkpiArchiveData, restoreCp949MojibakeText: boolean): NkpiType1Token[] {
  const tokens: NkpiType1Token[] = [];
  for (let off = 0; off + 4 < data.length; off += 5) {
    const type = data[off];
    const value = data.readInt32LE(off + 1);
    const uvalue = value >>> 0;
    switch (type) {
      case 0:
        tokens.push({ kind: 'data', text: String(value) });
        break;
      case 2:
        tokens.push({ kind: 'data', text: formatFloat32(uvalue) });
        break;
      case 3:
        tokens.push({ kind: 'tag', text: resolveDisplayString(archive.strA, archive.strW, value, restoreCp949MojibakeText) });
        break;
      case 5:
        tokens.push({ kind: 'marker', text: formatType1Marker(5, value) });
        break;
      case 6:
        tokens.push({ kind: 'data', text: '`' + resolveDisplayString(archive.strA, archive.strW, value, restoreCp949MojibakeText) + '`' });
        break;
      case 7:
        tokens.push({ kind: 'marker', text: formatType1Marker(7, value) });
        break;
      default:
        tokens.push({ kind: 'data', text: `{${type}=${value}}` });
        break;
    }
  }
  return tokens;
}

function formatNkpiLst(tokens: NkpiType1Token[]): string {
  const lines = ['#PVF_File'];
  for (let i = 0; i < tokens.length;) {
    const a = tokens[i++];
    if (!a) break;
    const b = tokens[i];
    if (b && a.kind === 'data' && b.kind === 'data') {
      lines.push(formatNkpiLstPair(a.text, b.text));
      i++;
    } else {
      lines.push(a.text);
    }
  }
  return lines.join('\n') + '\n';
}

function formatType1Marker(type: number, value: number): string {
  return value === 0 ? `{${type}=\`\`}` : `{${type}=${value}}`;
}

function formatNkpiLstPair(left: string, right: string): string {
  if (isIntegerToken(left) && !isIntegerToken(right)) return `${left}\t${right}`;
  if (isIntegerToken(right) && !isIntegerToken(left)) return `${right}\t${left}`;
  return `${left}\t${right}`;
}

function isIntegerToken(value: string): boolean {
  return /^-?\d+$/.test(value);
}

function formatNkpiScript(tokens: NkpiType1Token[], key: string): string {
  const lines = ['#PVF_File', ''];
  const isSkl = key.toLowerCase().endsWith('.skl');
  const pairedTags = collectPairedScriptTags(tokens);
  const stack: string[] = [];
  let currentSection = '';
  let currentIndent = 0;
  let dataTokens: NkpiType1Token[] = [];
  const flushData = () => {
    if (dataTokens.length > 0) {
      emitScriptDataLines(dataTokens, lines, currentIndent, currentSection, isSkl);
      dataTokens = [];
    }
  };
  const pushTagLine = (text: string, indent: number, closing = false) => {
    if (!closing && indent === 0 && lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`${indentTabs(indent)}${text}`);
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'tag') {
      flushData();
      const tag = parseNkpiScriptTag(token.text);
      if (tag?.closing) {
        const top = stack[stack.length - 1];
        let indent = Math.max(0, stack.length - 1);
        if (top === tag.name) {
          stack.pop();
          indent = stack.length;
        } else {
          const matchIndex = stack.lastIndexOf(tag.name);
          if (matchIndex >= 0) {
            stack.length = matchIndex;
            indent = stack.length;
          }
        }
        pushTagLine(token.text, indent, true);
        currentSection = stack[stack.length - 1] || '';
        currentIndent = stack.length;
      } else {
        const name = tag?.name || token.text.toLowerCase();
        const indent = stack.length;
        pushTagLine(token.text, indent, false);
        currentSection = name;
        currentIndent = indent + 1;
        if (pairedTags.has(name)) stack.push(name);
      }
      continue;
    }
    if (token.kind === 'marker') {
      dataTokens.push(token);
      continue;
    }
    dataTokens.push(token);
  }
  flushData();
  return lines.join('\n');
}

function collectPairedScriptTags(tokens: NkpiType1Token[]): Set<string> {
  const paired = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'tag') continue;
    const tag = parseNkpiScriptTag(token.text);
    if (tag?.closing) paired.add(tag.name);
  }
  return paired;
}

function parseNkpiScriptTag(text: string): NkpiScriptTagToken | undefined {
  const match = text.trim().match(/^\[(\/?)([^\]]+)\]$/);
  if (!match) return undefined;
  return { name: match[2].trim().toLowerCase(), closing: match[1] === '/' };
}

function indentTabs(indent: number): string {
  return '\t'.repeat(Math.max(0, indent));
}

function emitScriptDataLines(
  tokens: NkpiType1Token[],
  lines: string[],
  indent: number,
  sectionName: string,
  isSkl: boolean,
): void {
  const values = tokens.map(token => token.text);
  if (values.length === 0) return;
  if (isSkl && sectionName === 'level info') {
    emitSklLevelInfoLines(values, lines, indent);
    return;
  }
  if (tokens.every(token => token.kind === 'marker')) {
    emitFixedWidthTokenLines(values, lines, indent, 1);
    return;
  }
  if (sectionName === 'icon' && values.length > 2 && values.length % 2 === 0) {
    emitFixedWidthTokenLines(values, lines, indent, 2);
    return;
  }
  emitWrappedTokenLines(values, lines, indent);
}

function emitSklLevelInfoLines(tokens: string[], lines: string[], indent: number): void {
  if (tokens.length === 0) return;
  const colCount = Number(tokens[0]);
  if (!Number.isInteger(colCount) || colCount <= 0) {
    emitWrappedTokenLines(tokens, lines, indent);
    return;
  }
  const prefix = indentTabs(indent);
  lines.push(`${prefix}${tokens[0]}`);
  const bodyColumnCount = levelInfoBodyColumnCount(tokens, colCount, prefix.length);
  for (let start = 1; start < tokens.length; start += bodyColumnCount) {
    lines.push(`${prefix}${tokens.slice(start, start + bodyColumnCount).join('\t')}`);
  }
}

function levelInfoBodyColumnCount(tokens: string[], declaredColumnCount: number, prefixLength: number): number {
  const maxLineLength = 160;
  const sample = tokens.slice(1, Math.min(tokens.length, declaredColumnCount + 1));
  const declaredLineLength = prefixLength + sample.join('\t').length;
  if (declaredColumnCount <= 32 && declaredLineLength <= maxLineLength) return declaredColumnCount;
  let columns = Math.min(declaredColumnCount, 16);
  while (columns > 1) {
    const sampleLine = tokens.slice(1, Math.min(tokens.length, columns + 1)).join('\t');
    if (prefixLength + sampleLine.length <= maxLineLength) return columns;
    columns--;
  }
  return 1;
}

function emitFixedWidthTokenLines(tokens: string[], lines: string[], indent: number, width: number): void {
  const prefix = indentTabs(indent);
  for (let start = 0; start < tokens.length; start += width) {
    lines.push(`${prefix}${tokens.slice(start, start + width).join('\t')}`);
  }
}

function emitWrappedTokenLines(tokens: string[], lines: string[], indent: number): void {
  const prefix = indentTabs(indent);
  let row: string[] = [];
  const maxLineLength = 160;
  const flush = () => {
    if (row.length > 0) {
      lines.push(`${prefix}${row.join('\t')}`);
      row = [];
    }
  };
  for (const token of tokens) {
    const next = row.length ? `${row.join('\t')}\t${token}` : token;
    if (row.length > 0 && prefix.length + next.length > maxLineLength) flush();
    row.push(token);
  }
  flush();
}

function prepareUnpackFileData(archive: NkpiArchiveData, file: NkpiFileRecord, chunk: Buffer | null): { kind: PvfDiskFileKind; encoding?: string; data: Buffer } | null {
  const item = file.entry;
  if (item.dataSize <= 0) {
    return { kind: 'binary', data: Buffer.alloc(0) };
  }
  if (!chunk || item.dataOffset < 0 || item.dataOffset + item.dataSize > chunk.length) {
    return null;
  }
  const raw = chunk.subarray(item.dataOffset, item.dataOffset + item.dataSize);
  if (item.dataType === 1) {
    return { kind: 'script', data: Buffer.from(decodeType1(raw, archive, file.key), 'utf8') };
  }
  if (item.dataType === 3) {
    return { kind: 'text', encoding: 'utf16le', data: Buffer.from(raw.toString('utf16le'), 'utf8') };
  }
  return { kind: 'binary', data: Buffer.from(raw) };
}

function prepareRepackData(
  rawDisk: Buffer,
  kind: PvfDiskFileKind | undefined,
  dataType: number,
  archive: NkpiArchiveData,
  key?: string,
): Buffer {
  if (dataType === 1 && (kind === 'script' || looksUtf8Text(rawDisk))) {
    return encodeType1Text(stripUtf8Bom(rawDisk.toString('utf8')), archive, key);
  }
  if (dataType === 3 && (kind === 'text' || looksUtf8Text(rawDisk))) return Buffer.from(stripUtf8Bom(rawDisk.toString('utf8')), 'utf16le');
  return rawDisk;
}

function encodeType1Text(text: string, archive: NkpiArchiveData | undefined, key?: string): Buffer {
  const out: number[] = [];
  const getOffset = (s: string): number => {
    if (!s) return archive ? findEmptyStringOffset(archive) : 0;
    return archive ? findOrResolveNameOffset(archive, s) : 0;
  };
  const lowerKey = normalizeArchiveKey(key || '');
  if (lowerKey.endsWith('.lst')) return encodeType1LstText(text, getOffset, shouldEncodeNkpiLstStringFirst(lowerKey));
  const lines = text.replace(/\r/g, '').split('\n');
  encodeType1Lines(lines, out, getOffset);
  return Buffer.from(out);
}

function encodeType1Lines(lines: string[], out: number[], getOffset: (s: string) => number): void {
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    let line = lines[lineIndex];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.length >= 2 && trimmed.startsWith('[') && trimmed.endsWith(']')) {
      pushType1(out, 3, getOffset(trimmed));
      continue;
    }
    if (trimmed === '{5=``}') {
      pushType1(out, 5, 0);
      continue;
    }
    if (trimmed === '{7=``}') {
      pushType1(out, 7, 0);
      continue;
    }
    let i = 0;
    while (i < line.length) {
      while (i < line.length && /\s/.test(line[i])) i++;
      if (i >= line.length) break;
      if (line[i] === '`') {
        let token = '';
        let cursor = i + 1;
        while (true) {
          const close = line.indexOf('`', cursor);
          if (close >= 0) {
            token += line.slice(cursor, close);
            pushType1(out, 6, getOffset(token));
            i = close + 1;
            break;
          }
          token += line.slice(cursor);
          if (lineIndex + 1 >= lines.length) {
            pushType1(out, 6, getOffset(token));
            i = line.length;
            break;
          }
          token += '\n';
          lineIndex++;
          line = lines[lineIndex];
          cursor = 0;
        }
        continue;
      }
      const start = i;
      while (i < line.length && !/\s/.test(line[i])) i++;
      const token = line.slice(start, i);
      if (/^-?\d+$/.test(token)) {
        pushType1(out, 0, parseInt(token, 10) | 0);
      } else if (/^-?(?:\d+\.\d*|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(token)) {
        const b = Buffer.allocUnsafe(4);
        b.writeFloatLE(Number(token), 0);
        pushType1(out, 2, b.readInt32LE(0));
      } else if (token.startsWith('{') && token.endsWith('}') && token.includes('=')) {
        const body = token.slice(1, -1);
        const eq = body.indexOf('=');
        const type = parseInt(body.slice(0, eq), 10);
        const rawValue = body.slice(eq + 1);
        let value = 0;
        if ((type === 5 || type === 7) && rawValue === '``') value = 0;
        else if (rawValue.startsWith('`') && rawValue.endsWith('`')) value = getOffset(rawValue.slice(1, -1));
        else value = parseInt(rawValue, 10) | 0;
        pushType1(out, type, value);
      } else {
        pushType1(out, 6, getOffset(token));
      }
    }
  }
}

function pushType1(out: number[], type: number, value: number): void {
  out.push(type & 0xff, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
}

function findEmptyStringOffset(archive: NkpiArchiveData): number {
  // NKPI 名称表中空串表示为孤立 null 字节。搜索第一个连续 null 的位置
  for (let i = 0; i < archive.strA.length - 1; i++) {
    if (archive.strA[i] === 0 && archive.strA[i + 1] === 0) return i << 1;
  }
  if (archive.strA.length > 0 && archive.strA[archive.strA.length - 1] === 0) return (archive.strA.length - 1) << 1;
  for (let i = 0; i < archive.strW.length - 2; i += 2) {
    if (archive.strW[i] === 0 && archive.strW[i + 1] === 0 && archive.strW[i + 2] === 0 && archive.strW[i + 3] === 0) return (i / 2) << 1 | 1;
  }
  return 0;
}

function encodeType1LstText(text: string, getOffset: (s: string) => number, stringFirst: boolean): Buffer {
  const out: number[] = [];
  const body = text.replace(/\r/g, '\n').replace(/^#PVF_File\b[^\n]*(?:\n|$)/i, '');
  const pattern = /(-?\d+)\s+`([^`]*)`/g;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    matched = true;
    const code = parseInt(match[1], 10) | 0;
    const valueOffset = getOffset(match[2]);
    if (stringFirst) {
      pushType1(out, 6, valueOffset);
      pushType1(out, 0, code);
    } else {
      pushType1(out, 0, code);
      pushType1(out, 6, valueOffset);
    }
  }
  return matched ? Buffer.from(out) : encodeType1GenericText(text, getOffset);
}

function shouldEncodeNkpiLstStringFirst(key: string): boolean {
  const normalized = normalizeArchiveKey(key);
  const base = normalized.startsWith('./') ? normalized.slice(2) : normalized;
  return !base.includes('/')
    && /^(?:aicharactername|itemname|monstername|npcname|passiveobjectname|skillname\d*)\.lst$/i.test(base);
}

function shouldRestoreNkpiLstCp949Mojibake(key: string): boolean {
  return shouldEncodeNkpiLstStringFirst(key);
}

function encodeType1GenericText(text: string, getOffset: (s: string) => number): Buffer {
  const out: number[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  encodeType1Lines(lines, out, getOffset);
  return Buffer.from(out);
}

function findOrResolveNameOffset(archive: NkpiArchiveData, text: string): number {
  if (!text) return findEmptyStringOffset(archive);
  const direct = findNameOffset(archive, text);
  if (direct !== undefined) return direct;
  const legacyCp949 = toLegacyCp949Mojibake(text);
  if (legacyCp949 !== text) {
    const legacy = findNameOffset(archive, legacyCp949);
    if (legacy !== undefined) return legacy;
  }
  return appendNameString(archive, text);
}

function findNameOffset(archive: NkpiArchiveData, text: string): number | undefined {
  return getStringOffsetCache(archive).get(text);
}

function getStringOffsetCache(archive: NkpiArchiveData): Map<string, number> {
  if (!archive.stringOffsetCache) {
    const cache = new Map<string, number>();
    addStringOffsetCacheEntries(cache, archive.strA, false);
    addStringOffsetCacheEntries(cache, archive.strW, true);
    archive.stringOffsetCache = cache;
  }
  return archive.stringOffsetCache;
}

function addStringOffsetCacheEntries(cache: Map<string, number>, buffer: Buffer, utf16: boolean): void {
  let start = 0;
  while (start < buffer.length) {
    let end = start;
    if (utf16) {
      for (; end + 1 < buffer.length; end += 2) {
        if (buffer[end] === 0 && buffer[end + 1] === 0) break;
      }
      const len = Math.max(0, end - start);
      if (len > 0) {
        const text = buffer.subarray(start, start + (len & ~1)).toString('utf16le');
        if (!cache.has(text)) cache.set(text, (start / 2) << 1 | 1);
      }
      start = end + 2;
    } else {
      while (end < buffer.length && buffer[end] !== 0) end++;
      if (end > start) {
        const text = buffer.subarray(start, end).toString('utf8');
        if (!cache.has(text)) cache.set(text, start << 1);
      }
      start = end + 1;
    }
  }
}

function toLegacyCp949Mojibake(text: string): string {
  if (!hasHangul(text)) return text;
  return iconv.decode(iconv.encode(text, 'cp949'), 'gb18030');
}

function hasHangul(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7af) return true;
  }
  return false;
}

function appendNameString(archive: NkpiArchiveData, text: string): number {
  let prefersUnicode = false;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      prefersUnicode = true;
      break;
    }
  }
  if (!prefersUnicode && /^\s/.test(text)) prefersUnicode = true;

  let magicOffset: number;
  if (prefersUnicode) {
    let oldLen = archive.strW.length;
    if ((oldLen & 1) !== 0) {
      archive.strW = Buffer.concat([archive.strW, Buffer.from([0])]);
      oldLen++;
    }
    archive.strW = Buffer.concat([archive.strW, Buffer.from(text, 'utf16le'), Buffer.from([0, 0])]);
    magicOffset = (oldLen / 2) << 1 | 1;
  } else {
    const oldLen = archive.strA.length;
    archive.strA = Buffer.concat([archive.strA, Buffer.from(text, 'utf8'), Buffer.from([0])]);
    magicOffset = oldLen << 1;
  }
  archive.rawNameBytes = buildRawNameBytes(archive.rawNameBytes, archive.strA, archive.strW);
  archive.stringOffsetCache = undefined;
  return magicOffset;
}

function buildRawNameBytes(previousRawNameBytes: Buffer, strA: Buffer, strW: Buffer): Buffer {
  const prefix = previousRawNameBytes.length >= 8 ? previousRawNameBytes.subarray(0, 8) : Buffer.alloc(8);

  const compA = zlibCompress(strA);
  const encA = Buffer.from(compA);
  decryptName('sTrA', encA);
  const compW = zlibCompress(strW);
  const encW = Buffer.from(compW);
  decryptName('sTrW', encW);

  const out = Buffer.alloc(prefix.length + 8 + encA.length + 8 + encW.length);
  let pos = 0;
  prefix.copy(out, pos); pos += prefix.length;
  out.writeInt32LE((encA.length ^ 0xaa74472e) | 0, pos); pos += 4;
  out.writeInt32LE(compA.length, pos); pos += 4;
  encA.copy(out, pos); pos += encA.length;
  out.writeInt32LE((encW.length ^ 0x9a82f037) | 0, pos); pos += 4;
  out.writeInt32LE(compW.length, pos); pos += 4;
  encW.copy(out, pos);
  return out;
}

function buildConflictPaths(files: NkpiFileRecord[]): Set<string> {
  const filePaths = new Set<string>();
  const dirPaths = new Set<string>();
  for (const file of files) {
    filePaths.add(file.key);
    let dir = path.posix.dirname(file.key);
    while (dir && dir !== '.') {
      dirPaths.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  const conflicts = new Set<string>();
  for (const dir of dirPaths) {
    if (filePaths.has(dir)) conflicts.add(dir);
  }
  return conflicts;
}

function createNkpiManifestPayload(archive: NkpiArchiveData): unknown {
  return {
    templatePvfPath: archive.allBytes ? undefined : undefined,
    bodySize: archive.header.bodySize,
    groupCount: archive.header.groupCount,
    hashTableSize: archive.header.hashTableSize,
    nameTableSize: archive.header.nameTableSize,
  };
}

async function readManifest(srcDir: string): Promise<Partial<PvfDirectoryManifest> | undefined> {
  try {
    return JSON.parse(await fsp.readFile(path.join(srcDir, PVF_MANIFEST_FILE), 'utf8'));
  } catch {
    return undefined;
  }
}

async function buildDiskIndex(rootDir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(full);
      } else if (entry.isFile() && entry.name !== PVF_MANIFEST_FILE) {
        index.set(normalizeArchiveKey(path.relative(rootDir, full)), full);
      }
    }
    await runConcurrent(dirs, 16, walk);
  }
  await walk(rootDir);
  return index;
}

async function fileContentDiffers(diskPath: string, archive: NkpiArchiveData, file: NkpiFileRecord): Promise<boolean> {
  const raw = await fsp.readFile(diskPath);
  return fileContentDiffersBuffer(raw, archive, file);
}

async function fileContentDiffersBuffer(raw: Buffer, archive: NkpiArchiveData, file: NkpiFileRecord): Promise<boolean> {
  const chunk = getChunkData(archive, file.entry.chunkIndex);
  if (!chunk || file.entry.dataOffset < 0 || file.entry.dataOffset + file.entry.dataSize > chunk.length) return true;
  const original = chunk.subarray(file.entry.dataOffset, file.entry.dataOffset + file.entry.dataSize);
  return !original.equals(raw);
}

function rebuildChunk(originalChunk: Buffer, updates: Array<{ fileIndex: number; newData?: Buffer }>, newItems: NkpiFileItem[]): Buffer {
  const segments = updates
    .map(update => {
      const item = newItems[update.fileIndex];
      return { origOffset: item.dataOffset, origSize: item.dataSize, fileIndex: update.fileIndex, newData: update.newData };
    })
    .filter(seg => seg.origSize > 0 || (seg.newData && seg.newData.length > 0))
    .sort((a, b) => a.origOffset - b.origOffset);
  const parts: Buffer[] = [];
  let srcPos = 0;
  let outputPos = 0;
  for (const seg of segments) {
    if (seg.origOffset > srcPos && originalChunk) {
      const gap = originalChunk.subarray(srcPos, seg.origOffset);
      parts.push(gap);
      outputPos += gap.length;
    }
    const item = newItems[seg.fileIndex];
    item.dataOffset = outputPos;
    if (seg.newData) {
      parts.push(seg.newData);
      outputPos += seg.newData.length;
      item.dataSize = seg.newData.length;
    } else if (originalChunk && seg.origOffset >= 0 && seg.origOffset + seg.origSize <= originalChunk.length) {
      const kept = originalChunk.subarray(seg.origOffset, seg.origOffset + seg.origSize);
      parts.push(kept);
      outputPos += kept.length;
    }
    newItems[seg.fileIndex] = item;
    srcPos = seg.origOffset + seg.origSize;
  }
  if (originalChunk && srcPos < originalChunk.length) {
    parts.push(originalChunk.subarray(srcPos));
  }
  return Buffer.concat(parts);
}

function buildFileItemTable(items: NkpiFileItem[]): Buffer {
  const table = Buffer.alloc(items.length * FILE_ITEM_SIZE);
  for (let i = 0; i < items.length; i++) {
    const off = i * FILE_ITEM_SIZE;
    const item = items[i];
    table.writeInt32LE(item.nameOffset, off);
    table.writeInt32LE(item.pathOffset, off + 4);
    table.writeInt32LE(item.chunkIndex, off + 8);
    table.writeInt32LE(item.dataOffset, off + 12);
    table.writeInt32LE(item.dataSize, off + 16);
    table.writeInt32LE(item.dataType, off + 20);
  }
  return table;
}

function buildHashTableBytes(items: NkpiFileItem[], resolve: (offset: number) => string): Buffer {
  const offsets = new Set<number>();
  for (const item of items) {
    offsets.add(item.nameOffset);
    if (item.pathOffset >= 0) offsets.add(item.pathOffset);
  }
  const sorted = [...offsets].sort((a, b) => {
    const sa = resolve(a);
    const sb = resolve(b);
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  });
  const out = Buffer.alloc(4 + items.length * 8 + 4 + sorted.length * 4);
  let pos = 0;
  out.writeInt32LE(items.length, pos); pos += 4;
  for (const item of items) {
    out.writeInt32LE(item.nameOffset, pos); pos += 4;
    out.writeInt32LE(item.pathOffset, pos); pos += 4;
  }
  out.writeInt32LE(sorted.length, pos); pos += 4;
  for (const offset of sorted) {
    out.writeInt32LE(offset, pos); pos += 4;
  }
  return out;
}

function buildGrpiBytes(groups: NkpiGroupItem[]): Buffer {
  const out = Buffer.alloc(groups.length * 8);
  for (let i = 0; i < groups.length; i++) {
    out.writeInt32LE(groups[i].compressedSize, i * 8);
    out.writeInt32LE(groups[i].originalSize, i * 8 + 4);
  }
  return out;
}

function buildHeaderBytes(header: NkpiHeader): Buffer {
  const out = Buffer.alloc(HEADER_SIZE);
  out.writeUInt32LE(header.signature, 0);
  Buffer.from(header.guid).copy(out, 4, 0, Math.min(20, header.guid.length));
  out.writeInt32LE(header.fileCount, 24);
  out.writeInt32LE(header.padding, 28);
  out.writeInt32LE(header.bodySize, 32);
  out.writeInt32LE(header.groupCount, 36);
  out.writeInt32LE(header.hashTableSize, 40);
  out.writeInt32LE(header.nameTableSize, 44);
  return out;
}

function assembleNkpiBytes(
  archive: NkpiArchiveData,
  tableBytes: Buffer,
  rawHashBytes: Buffer,
  rawNameBytes: Buffer,
  rawGrpiBytes: Buffer,
  bodyLength: number,
): Buffer {
  const hashBytes = Buffer.from(rawHashBytes);
  decrypt('HASH', hashBytes);
  const grpiBytes = Buffer.from(rawGrpiBytes);
  decrypt('GRPI', grpiBytes);
  const headerBytes = buildHeaderBytes({
    ...archive.header,
    bodySize: bodyLength,
    hashTableSize: hashBytes.length,
    nameTableSize: rawNameBytes.length,
    groupCount: rawGrpiBytes.length / 8,
  });
  decrypt('HeaD', headerBytes);
  rotHeaderGuard(headerBytes);
  const body = archive.allBytes.subarray(archive.bodyOffset, archive.bodyOffset + bodyLength);
  return Buffer.concat([headerBytes, tableBytes, hashBytes, rawNameBytes, grpiBytes, body]);
}

function looksUtf8Text(raw: Buffer): boolean {
  if (raw.length === 0) return true;
  const text = raw.toString('utf8');
  const probe = text.slice(0, 4096);
  if (probe.includes('\ufffd')) return false;
  let printable = 0;
  for (let i = 0; i < probe.length; i++) {
    const c = probe.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) printable++;
  }
  return probe.length === 0 || printable / probe.length > 0.95;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(min, Math.min(max, n));
}
