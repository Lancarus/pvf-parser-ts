import * as fs from 'fs/promises';
import { Worker } from 'worker_threads';

export const PVF_MANIFEST_FILE = '.pvfmanifest.json';
export const PVF_DIRECTORY_MANIFEST_VERSION = 2;

export type PvfDiskFileKind = 'script' | 'binaryAni' | 'stringtable' | 'text' | 'binary';
export type PvfDiskFileManifestEntry = [key: string, kind: PvfDiskFileKind, encoding?: string];

export interface PvfDirectoryManifest {
  version: number;
  guid: string;
  guidLen: number;
  fileVersion: number;
  encodingMode: string;
  defaultEncoding: string;
  chineseConversion?: 'off' | 'tw2cn';
  fileCount: number;
  files: PvfDiskFileManifestEntry[];
}

export interface PvfArchivePhaseStats {
  files: number;
  dirs?: number;
  totalMs: number;
  phases: Record<string, number>;
}

export function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

export function normalizeArchiveKey(key: string): string {
  return key.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

export function safeJoinArchivePath(root: string, key: string, pathMod: typeof import('path')): string {
  const parts = normalizeArchiveKey(key).split('/').filter(Boolean);
  const diskPath = pathMod.resolve(root, ...parts);
  const rootPath = pathMod.resolve(root);
  const rel = pathMod.relative(rootPath, diskPath);
  if (rel.startsWith('..') || pathMod.isAbsolute(rel)) {
    throw new Error(`PVF path escapes target directory: ${key}`);
  }
  return diskPath;
}

export function createArchivePathResolver(root: string, pathMod: typeof import('path')): (key: string) => string {
  const rootPath = pathMod.resolve(root);
  return (key: string) => {
    const parts = normalizeArchiveKey(key)
      .split('/')
      .filter(part => part && part !== '.');
    if (parts.length === 0) {
      throw new Error(`PVF path is empty: ${key}`);
    }
    for (const part of parts) {
      if (part === '..' || part.includes('\0') || (pathMod.sep === '\\' && part.includes(':'))) {
        throw new Error(`PVF path escapes target directory: ${key}`);
      }
    }
    return pathMod.join(rootPath, ...parts);
  };
}

export async function runConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
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

export function createManifestEntryMap(manifest: Partial<PvfDirectoryManifest> | undefined): Map<string, PvfDiskFileManifestEntry> {
  const map = new Map<string, PvfDiskFileManifestEntry>();
  const files = Array.isArray(manifest?.files) ? manifest!.files : [];
  for (const entry of files) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') continue;
    map.set(normalizeArchiveKey(entry[0]), [normalizeArchiveKey(entry[0]), entry[1] as PvfDiskFileKind, entry[2]]);
  }
  return map;
}

export interface ParallelFileWriteRequest {
  path: string;
  data: Uint8Array | Buffer;
}

type PendingWrite = { resolve: () => void; reject: (err: Error) => void; cost: number };

interface WriterState {
  worker: Worker;
  pending: Map<number, PendingWrite>;
  inFlight: number;
}

export class ParallelFileWriter {
  private workers: WriterState[] = [];
  private nextId = 1;

  constructor(workerCount: number) {
    const count = Math.max(0, Math.floor(workerCount));
    if (count <= 0) return;

    const workerCode = `
      const fs = require('fs');
      const { parentPort } = require('worker_threads');
      parentPort.on('message', (msg) => {
        try {
          if (Array.isArray(msg.files)) {
            for (const file of msg.files) fs.writeFileSync(file.path, file.data);
          } else {
            fs.writeFileSync(msg.path, msg.data);
          }
          parentPort.postMessage({ id: msg.id });
        } catch (err) {
          parentPort.postMessage({ id: msg.id, error: err && err.stack || String(err) });
        }
      });
    `;

    for (let i = 0; i < count; i++) {
      const state: WriterState = {
        worker: new Worker(workerCode, { eval: true }),
        pending: new Map(),
        inFlight: 0,
      };
      state.worker.on('message', (msg: { id: number; error?: string }) => {
        const pending = state.pending.get(msg.id);
        if (!pending) return;
        state.pending.delete(msg.id);
        state.inFlight = Math.max(0, state.inFlight - pending.cost);
        if (msg.error) pending.reject(new Error(msg.error));
        else pending.resolve();
      });
      state.worker.on('error', (err) => {
        for (const pending of state.pending.values()) pending.reject(err);
        state.pending.clear();
        state.inFlight = 0;
      });
      this.workers.push(state);
    }
  }

  async writeFile(filePath: string, data: Uint8Array | Buffer): Promise<void> {
    await this.writeFiles([{ path: filePath, data }]);
  }

  async writeFiles(files: readonly ParallelFileWriteRequest[]): Promise<void> {
    if (files.length === 0) return;
    if (this.workers.length === 0) {
      await Promise.all(files.map(file => fs.writeFile(file.path, file.data)));
      return;
    }

    const worker = this.pickWorker();
    const id = this.nextId++;
    const payload = files.map(file => ({ path: file.path, data: toTransferableBytes(file.data) }));
    const transferList = payload.map(file => file.data.buffer as ArrayBuffer);
    const cost = Math.max(1, files.length);
    worker.inFlight += cost;

    await new Promise<void>((resolve, reject) => {
      worker.pending.set(id, { resolve, reject, cost });
      try {
        worker.worker.postMessage({ id, files: payload }, transferList);
      } catch (err) {
        worker.pending.delete(id);
        worker.inFlight = Math.max(0, worker.inFlight - cost);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map(async (state) => {
      while (state.pending.size > 0) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await state.worker.terminate();
    }));
    this.workers = [];
  }

  private pickWorker(): WriterState {
    let best = this.workers[0];
    for (let i = 1; i < this.workers.length; i++) {
      if (this.workers[i].inFlight < best.inFlight) best = this.workers[i];
    }
    return best;
  }
}

function toTransferableBytes(data: Uint8Array | Buffer): Uint8Array {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  // Always transfer a private copy. Transferring a view over PvfFile.data would
  // detach the model's backing buffer and corrupt later reads/saves.
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}
