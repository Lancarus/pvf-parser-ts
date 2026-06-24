import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { PVF_MANIFEST_FILE } from './directoryArchive';

function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
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

function uniqueResolved(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const resolved = path.resolve(item);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function pathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function shouldIgnoreDevelopmentEnv(context: vscode.ExtensionContext, base: string): boolean {
  return context.extensionMode === vscode.ExtensionMode.Development
    && pathKey(base) === pathKey(context.extensionUri.fsPath);
}

function configStringArray(key: string): string[] {
  const raw = vscode.workspace.getConfiguration().get<unknown>(key);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
}

async function hasPvfManifest(root: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(root, PVF_MANIFEST_FILE));
    return stat.isFile();
  } catch {
    return false;
  }
}

export function pathContains(root: string, filePath: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(filePath);
  const rel = path.relative(resolvedRoot, resolvedFile);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function readUnpackExplorerRoots(context: vscode.ExtensionContext): Promise<string[]> {
  const roots = [...configStringArray('pvf.unpackExplorer.roots')];
  const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) || [];
  for (const root of workspaceRoots) {
    if (await hasPvfManifest(root)) roots.push(root);
  }
  return uniqueResolved(roots);
}

export async function readConfiguredUnpackRoots(context: vscode.ExtensionContext): Promise<string[]> {
  const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) || [];
  const candidates = workspaceRoots.filter(base => !shouldIgnoreDevelopmentEnv(context, base));
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const base of candidates) {
    const envPath = path.join(base, '.env');
    let env: Record<string, string>;
    try {
      env = parseEnv(await fs.readFile(envPath, 'utf8'));
    } catch {
      continue;
    }
    const unpackDir = env.UNPACK_DIR || env.PVF_UNPACK_DIR || env.pvf_unpack_dir;
    if (!unpackDir) continue;
    const resolved = path.resolve(base, unpackDir);
    const key = pathKey(resolved);
    if (!seen.has(key)) {
      seen.add(key);
      roots.push(resolved);
    }
  }
  return roots;
}

export async function readConfiguredNpkRoots(context: vscode.ExtensionContext): Promise<string[]> {
  const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) || [];
  const candidates = workspaceRoots.filter(base => !shouldIgnoreDevelopmentEnv(context, base));
  const roots: string[] = [];
  for (const base of candidates) {
    const envPath = path.join(base, '.env');
    let env: Record<string, string>;
    try {
      env = parseEnv(await fs.readFile(envPath, 'utf8'));
    } catch {
      continue;
    }
    const configured = env.NPK_DIR || env.PVF_NPK_DIR || env.pvf_npk_dir || env.NPK_ROOT || env.PVF_NPK_ROOT || env.pvf_npk_root;
    if (!configured) continue;
    roots.push(path.resolve(base, configured));
  }
  return uniqueResolved(roots);
}
