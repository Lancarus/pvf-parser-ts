import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

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

export function pathContains(root: string, filePath: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(filePath);
  const rel = path.relative(resolvedRoot, resolvedFile);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function readConfiguredUnpackRoots(context: vscode.ExtensionContext): Promise<string[]> {
  const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) || [];
  const extensionRoot = context.extensionUri.fsPath;
  const candidates = [...workspaceRoots, extensionRoot];
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
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      roots.push(resolved);
    }
  }
  return roots;
}
