import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PVF_MANIFEST_FILE, PvfDirectoryManifest } from './directoryArchive';
import { normalizeTreeCommentPath, normalizeTreeCommentVersion, PvfTreeCommentService } from './treeComments';
import { pathContains, readConfiguredUnpackRoots } from './unpackEnv';

export interface DiskTreeCommentTarget {
  uri: string;
  key: string;
  version: string;
}

interface PvfDiskPathInfo {
  root: string;
  key: string;
  version: string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(file: string): Promise<PvfDirectoryManifest | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as PvfDirectoryManifest;
  } catch {
    return undefined;
  }
}

export function registerDiskTreeCommentDecorations(
  context: vscode.ExtensionContext,
  comments: PvfTreeCommentService,
  output?: vscode.OutputChannel,
) {
  class DiskTreeCommentDecorationProvider implements vscode.FileDecorationProvider {
    private readonly _emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._emitter.event;
    private readonly infoCache = new Map<string, PvfDiskPathInfo | undefined>();
    private readonly manifestCache = new Map<string, Promise<PvfDirectoryManifest | undefined>>();
    private envRootsPromise: Promise<string[]> | undefined;

    refreshAll() {
      this.infoCache.clear();
      this.manifestCache.clear();
      this.envRootsPromise = undefined;
      this._emitter.fire(undefined);
    }

    refreshUri(uri: vscode.Uri) {
      this.infoCache.delete(uri.toString());
      this._emitter.fire(uri);
    }

    async targetFromUri(uri: vscode.Uri): Promise<DiskTreeCommentTarget | undefined> {
      const info = await this.resolveInfo(uri);
      if (!info) return undefined;
      return {
        uri: uri.toString(),
        key: info.key,
        version: info.version,
      };
    }

    async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
      if (uri.scheme !== 'file') return undefined;
      const info = await this.resolveInfo(uri);
      if (!info) return undefined;
      const entry = comments.getEntryForVersion(info.key, info.version);
      if (!entry?.comment) return undefined;
      const tooltip = entry.detailedComment
        ? `${entry.comment}\n\n${entry.detailedComment}`
        : entry.comment;
      const decoration = new vscode.FileDecoration(undefined, tooltip);
      decoration.propagate = false;
      return decoration;
    }

    private async resolveInfo(uri: vscode.Uri): Promise<PvfDiskPathInfo | undefined> {
      if (uri.scheme !== 'file') return undefined;
      const cacheKey = uri.toString();
      if (this.infoCache.has(cacheKey)) return this.infoCache.get(cacheKey);
      const resolved = await this.findPvfPathInfo(uri.fsPath);
      this.infoCache.set(cacheKey, resolved);
      return resolved;
    }

    private async findPvfPathInfo(filePath: string): Promise<PvfDiskPathInfo | undefined> {
      const envInfo = await this.findEnvRootPathInfo(filePath);
      if (envInfo) return envInfo;

      let current = path.resolve(filePath);
      try {
        const stat = await fs.stat(current);
        if (!stat.isDirectory()) current = path.dirname(current);
      } catch {
        current = path.dirname(current);
      }

      while (true) {
        const manifestPath = path.join(current, PVF_MANIFEST_FILE);
        if (await exists(manifestPath)) {
          const manifest = await this.getManifest(manifestPath);
          if (!manifest) return undefined;
          const rel = normalizeTreeCommentPath(path.relative(current, filePath));
          if (!rel || rel === PVF_MANIFEST_FILE.toLowerCase()) return undefined;
          return {
            root: current,
            key: rel,
            version: normalizeTreeCommentVersion(manifest.fileVersion ?? 0),
          };
        }
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
      }
    }

    private async findEnvRootPathInfo(filePath: string): Promise<PvfDiskPathInfo | undefined> {
      const roots = await this.getEnvUnpackRoots();
      const root = roots
        .filter(item => pathContains(item, filePath))
        .sort((a, b) => b.length - a.length)[0];
      if (!root) return undefined;
      const rel = normalizeTreeCommentPath(path.relative(root, filePath));
      if (!rel || rel === PVF_MANIFEST_FILE.toLowerCase()) return undefined;
      const manifest = await this.getManifestIfExists(path.join(root, PVF_MANIFEST_FILE));
      return {
        root,
        key: rel,
        version: normalizeTreeCommentVersion(manifest?.fileVersion ?? 0),
      };
    }

    private async getEnvUnpackRoots(): Promise<string[]> {
      if (!this.envRootsPromise) {
        this.envRootsPromise = this.readEnvUnpackRoots();
      }
      return this.envRootsPromise;
    }

    private async readEnvUnpackRoots(): Promise<string[]> {
      return readConfiguredUnpackRoots(context);
    }

    private async getManifestIfExists(file: string): Promise<PvfDirectoryManifest | undefined> {
      if (!await exists(file)) return undefined;
      return this.getManifest(file);
    }

    private getManifest(file: string): Promise<PvfDirectoryManifest | undefined> {
      const normalized = path.resolve(file);
      let cached = this.manifestCache.get(normalized);
      if (!cached) {
        cached = readManifest(normalized).catch(err => {
          output?.appendLine(`[PVF] failed to read unpack manifest ${normalized}: ${String(err && err.message || err)}`);
          return undefined;
        });
        this.manifestCache.set(normalized, cached);
      }
      return cached;
    }
  }

  const provider = new DiskTreeCommentDecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(provider));
  return provider;
}
