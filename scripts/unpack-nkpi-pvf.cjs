#!/usr/bin/env node
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

const HEADER_SIZE = 0x30;
const FILE_ITEM_SIZE = 0x18;
const NKPI_SIGNATURE = 0x69706b6e;
const MANIFEST_FILE = '.pvfmanifest.json';
const WINDOWS_INVALID_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

function parseEnv(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function rotHeaderGuard(buf) {
  if (!buf || buf.length < 28) return;
  for (let i = 24; i < 28; i++) buf[i] ^= 0x55;
}

function decryptCore(key, buf, magic) {
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

function decrypt(key, buf) {
  return decryptCore(key, buf, 0x269ec3);
}

function decryptName(key, buf) {
  return decryptCore(key, buf, 0x269ec9);
}

function zlibDecompress(buf) {
  if (!buf || buf.length < 6 || buf[0] !== 0x78) {
    throw new Error('invalid zlib stream');
  }
  return zlib.inflateSync(buf);
}

function tryDecodeHeader(allBytes, useGuard) {
  const headerBytes = Buffer.from(allBytes.subarray(0, HEADER_SIZE));
  if (useGuard) rotHeaderGuard(headerBytes);
  if (decrypt('HeaD', headerBytes) !== 0) return null;

  const header = {
    signature: headerBytes.readUInt32LE(0),
    guid: Buffer.from(headerBytes.subarray(4, 24)),
    fileCount: headerBytes.readInt32LE(24),
    padding: headerBytes.readInt32LE(28),
    bodySize: headerBytes.readInt32LE(32),
    groupCount: headerBytes.readInt32LE(36),
    hashTableSize: headerBytes.readInt32LE(40),
    nameTableSize: headerBytes.readInt32LE(44),
  };

  if (header.signature !== NKPI_SIGNATURE) return null;
  if (header.fileCount < 0 || header.bodySize < 0 || header.groupCount < 0 || header.hashTableSize < 0 || header.nameTableSize < 0) {
    return null;
  }
  const expectedLength = HEADER_SIZE
    + header.fileCount * FILE_ITEM_SIZE
    + header.hashTableSize
    + header.nameTableSize
    + header.groupCount * 8
    + header.bodySize;
  if (expectedLength !== allBytes.length) return null;
  return header;
}

function decodeHeader(allBytes) {
  if (!allBytes || allBytes.length < HEADER_SIZE) throw new Error('file is too small for nkpi header');
  const guarded = tryDecodeHeader(allBytes, true);
  if (guarded) return guarded;
  const plain = tryDecodeHeader(allBytes, false);
  if (plain) return plain;
  throw new Error('nkpi header decrypt failed or section sizes do not match');
}

function decryptStringBuffer(nameBytes, state, key, xorConst) {
  if (state.index + 8 > nameBytes.length) return Buffer.alloc(0);
  const cnt1 = nameBytes.readInt32LE(state.index); state.index += 4;
  state.index += 4; // cnt2, kept by the reference tool but not needed for decompression.
  const encSize = (cnt1 ^ xorConst) | 0;
  if (encSize <= 0 || state.index + encSize > nameBytes.length) return Buffer.alloc(0);
  const encrypted = Buffer.from(nameBytes.subarray(state.index, state.index + encSize));
  state.index += encSize;
  decryptName(key, encrypted);
  return zlibDecompress(encrypted);
}

function readUtf8String(buffer, start) {
  if (!buffer || start < 0 || start >= buffer.length) return '';
  let end = start;
  while (end < buffer.length && buffer[end] !== 0) end++;
  if (end < start) return '';
  return buffer.subarray(start, end).toString('utf8');
}

function readUtf16String(buffer, start) {
  if (!buffer || start < 0 || start >= buffer.length) return '';
  let end = start;
  for (; end + 1 < buffer.length; end += 2) {
    if (buffer[end] === 0 && buffer[end + 1] === 0) break;
  }
  const len = Math.max(0, end - start);
  return len > 0 ? buffer.subarray(start, start + (len & ~1)).toString('utf16le') : '';
}

function resolveString(strA, strW, magicOffset) {
  if (magicOffset < 0) return '';
  if ((magicOffset & 1) !== 0) return readUtf16String(strW, (magicOffset >> 1) * 2);
  return readUtf8String(strA, magicOffset >> 1);
}

function normalizeArchiveKey(key) {
  return String(key || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function sanitizePathPart(part) {
  return part.replace(WINDOWS_INVALID_NAME_CHARS, '_');
}

function sanitizeArchiveKey(key) {
  return normalizeArchiveKey(key).split('/').filter(Boolean).map(sanitizePathPart).join('/');
}

function safeJoinArchivePath(root, key) {
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

function parseNkpiArchive(allBytes) {
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
  const bodyLength = header.bodySize;

  const hashBytes = Buffer.from(allBytes.subarray(hashOffset, hashOffset + header.hashTableSize));
  const nameBytes = Buffer.from(allBytes.subarray(nameOffset, nameOffset + header.nameTableSize));
  const grpiBytes = Buffer.from(allBytes.subarray(grpiOffset, grpiOffset + grpiSize));
  decrypt('HASH', hashBytes);
  decrypt('GRPI', grpiBytes);

  const nameState = { index: 8 };
  const strA = decryptStringBuffer(nameBytes, nameState, 'sTrA', 0xaa74472e);
  const strW = decryptStringBuffer(nameBytes, nameState, 'sTrW', 0x9a82f037);

  const stringCache = new Map();
  const getString = (offset) => {
    if (stringCache.has(offset)) return stringCache.get(offset);
    const value = resolveString(strA, strW, offset);
    stringCache.set(offset, value);
    return value;
  };

  const files = [];
  for (let i = 0; i < header.fileCount; i++) {
    const off = tableOffset + i * FILE_ITEM_SIZE;
    const entry = {
      nameOffset: allBytes.readInt32LE(off),
      pathOffset: allBytes.readInt32LE(off + 4),
      chunkIndex: allBytes.readInt32LE(off + 8),
      dataOffset: allBytes.readInt32LE(off + 12),
      dataSize: allBytes.readInt32LE(off + 16),
      dataType: allBytes.readInt32LE(off + 20),
    };
    const name = getString(entry.nameOffset);
    const dir = getString(entry.pathOffset);
    const key = sanitizeArchiveKey(dir ? `${dir}/${name}` : name);
    files.push({ key, name, dir, entry });
  }

  const groups = [];
  for (let i = 0; i < header.groupCount; i++) {
    const off = i * 8;
    groups.push({
      compressedSize: grpiBytes.readInt32LE(off),
      originalSize: grpiBytes.readInt32LE(off + 4),
    });
  }

  return { header, files, groups, bodyOffset, bodyLength, allBytes, strA, strW };
}

function getChunkData(archive, chunkIndex) {
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

function formatFloat32(value) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32LE(value >>> 0, 0);
  const f = buf.readFloatLE(0);
  const fixed = f.toFixed(6);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function decodeType1(data, archive) {
  const lines = ['#PVF_File', ''];
  let line = [];
  const flushLine = () => {
    if (line.length > 0) {
      lines.push(line.join(' '));
      line = [];
    }
  };
  for (let off = 0; off + 4 < data.length; off += 5) {
    const type = data[off];
    const value = data.readInt32LE(off + 1);
    const uvalue = value >>> 0;
    switch (type) {
      case 0:
        line.push(String(value));
        break;
      case 2:
        line.push(formatFloat32(uvalue));
        break;
      case 3:
        flushLine();
        lines.push(resolveString(archive.strA, archive.strW, value));
        break;
      case 5:
        flushLine();
        lines.push('{5=``}');
        break;
      case 6:
        line.push('`' + resolveString(archive.strA, archive.strW, value) + '`');
        break;
      case 7:
        flushLine();
        lines.push('{7=``}');
        break;
      default:
        line.push(`{${type}=${value}}`);
        break;
    }
  }
  flushLine();
  return lines.join('\n');
}

function prepareFileData(archive, file, chunk) {
  const item = file.entry;
  if (item.dataSize <= 0) {
    return { kind: 'binary', data: Buffer.alloc(0) };
  }
  if (!chunk || item.dataOffset < 0 || item.dataOffset + item.dataSize > chunk.length) {
    return null;
  }
  const raw = chunk.subarray(item.dataOffset, item.dataOffset + item.dataSize);
  if (item.dataType === 1) {
    return { kind: 'script', data: Buffer.from(decodeType1(raw, archive), 'utf8') };
  }
  if (item.dataType === 3) {
    return { kind: 'text', encoding: 'utf16le', data: Buffer.from(raw.toString('utf16le'), 'utf8') };
  }
  return { kind: 'binary', data: Buffer.from(raw) };
}

async function runConcurrent(items, concurrency, worker) {
  const limit = Math.max(1, Math.floor(concurrency));
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) break;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function unpackNkpi(pvfPath, destDir, options = {}) {
  const allBytes = fs.readFileSync(pvfPath);
  const archive = parseNkpiArchive(allBytes);
  const targetRoot = path.resolve(destDir);
  await fsp.mkdir(targetRoot, { recursive: true });

  const manifestFiles = new Array(archive.files.length);
  const conflictPaths = new Set();
  const filePathSet = new Set();
  const dirPathSet = new Set();
  for (const file of archive.files) {
    filePathSet.add(file.key);
    let dir = path.posix.dirname(file.key);
    while (dir && dir !== '.') {
      dirPathSet.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  for (const dir of dirPathSet) {
    if (filePathSet.has(dir)) conflictPaths.add(dir);
  }

  let lastPct = -1;
  let extracted = 0;
  let skipped = 0;
  let errors = 0;
  const started = Date.now();
  const chunks = archive.groups.map((_, chunkIndex) => chunkIndex);

  await runConcurrent(chunks, options.chunkConcurrency || 1, async (chunkIndex) => {
    let chunk;
    try {
      chunk = getChunkData(archive, chunkIndex);
    } catch (err) {
      errors++;
      console.error(`[PVF-new] chunk ${chunkIndex} failed: ${err && err.stack || err}`);
      return;
    }
    const files = archive.files
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => file.entry.chunkIndex === chunkIndex);

    for (const { file, index } of files) {
      try {
        let key = file.key;
        if (!key || file.name.endsWith('/') || file.name.endsWith('\\')) {
          await fsp.mkdir(safeJoinArchivePath(targetRoot, key || `__dir_${index}`), { recursive: true });
          extracted++;
          continue;
        }
        if (conflictPaths.has(key)) key += '._file';
        const diskPath = safeJoinArchivePath(targetRoot, key);
        await fsp.mkdir(path.dirname(diskPath), { recursive: true });
        const prepared = prepareFileData(archive, file, chunk);
        if (!prepared) {
          skipped++;
        } else {
          if (!options.skipExisting || !fs.existsSync(diskPath)) {
            await fsp.writeFile(diskPath, prepared.data);
          }
          manifestFiles[index] = prepared.encoding ? [key, prepared.kind, prepared.encoding] : [key, prepared.kind];
          extracted++;
        }
      } catch (err) {
        errors++;
        console.error(`[PVF-new] file failed ${file.key}: ${err && err.stack || err}`);
      }
    }

    const done = extracted + skipped + errors;
    const pct = archive.files.length > 0 ? Math.floor(done * 100 / archive.files.length) : 100;
    if (pct !== lastPct) {
      lastPct = pct;
      const elapsed = Math.max(0.001, (Date.now() - started) / 1000);
      const rate = Math.round(done / elapsed);
      console.log(`[PVF-new] unpack ${pct}% (${done}/${archive.files.length}) chunk=${chunkIndex + 1}/${archive.groups.length} rate=${rate}/s errors=${errors}`);
    }
  });

  const manifest = {
    version: 2,
    archiveFormat: 'nkpi',
    guid: archive.header.guid.toString('hex'),
    guidLen: archive.header.guid.length,
    fileVersion: archive.header.padding,
    encodingMode: 'NKPI',
    defaultEncoding: 'utf8',
    chineseConversion: 'off',
    fileCount: archive.files.length,
    files: manifestFiles.map((entry, index) => entry || [archive.files[index].key, 'binary']),
    nkpi: {
      bodySize: archive.header.bodySize,
      groupCount: archive.header.groupCount,
      hashTableSize: archive.header.hashTableSize,
      nameTableSize: archive.header.nameTableSize,
    },
  };
  await fsp.writeFile(path.join(targetRoot, MANIFEST_FILE), JSON.stringify(manifest), 'utf8');
  return { total: archive.files.length, extracted, skipped, errors, groups: archive.groups.length };
}

async function main() {
  const repoRoot = process.cwd();
  const env = parseEnv(await fsp.readFile(path.join(repoRoot, '.env'), 'utf8'));
  const pvfPath = path.resolve(repoRoot, env.PVF_DIR || env.pvf_dir || '');
  const destDir = path.resolve(repoRoot, env.UNPACK_DIR || env.PVF_UNPACK_DIR || env.pvf_unpack_dir || '');
  if (!pvfPath || !fs.existsSync(pvfPath)) throw new Error(`PVF not found: ${pvfPath}`);
  if (!destDir) throw new Error('UNPACK_DIR is not configured in .env');
  console.log(`[PVF-new] source=${pvfPath}`);
  console.log(`[PVF-new] dest=${destDir}`);
  const result = await unpackNkpi(pvfPath, destDir, {
    chunkConcurrency: Number(process.env.PVF_NKPI_CHUNK_CONCURRENCY || 1),
    skipExisting: process.env.PVF_NKPI_SKIP_EXISTING === '1',
  });
  console.log(`[PVF-new] done total=${result.total} extracted=${result.extracted} skipped=${result.skipped} errors=${result.errors} groups=${result.groups}`);
  if (result.errors > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[PVF-new] FAILED');
  console.error(err && err.stack || err);
  process.exitCode = 1;
});
