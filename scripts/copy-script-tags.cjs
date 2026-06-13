#!/usr/bin/env node
// Copy JSON config definitions into dist for runtime (language providers and previews)
const fs = require('fs');
const path = require('path');
const root = __dirname + '/..';
const srcDir = path.join(root, 'src', 'config', 'scriptLang', 'scriptTags');
const outDir = path.join(root, 'dist', 'config', 'scriptLang', 'scriptTags');
const pvfSrcDir = path.join(root, 'src', 'config', 'pvf');
const pvfOutDir = path.join(root, 'dist', 'config', 'pvf');
function ensureInside(parent, child) {
  const rel = path.relative(parent, child);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to clean outside ${parent}: ${child}`);
  }
}
function copyJsonTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyJsonTree(src, dst);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      fs.copyFileSync(src, dst);
    }
  }
}
let copied = 0;
if (fs.existsSync(srcDir)) {
  ensureInside(path.resolve(root), path.resolve(outDir));
  fs.rmSync(outDir, { recursive: true, force: true });
  copyJsonTree(srcDir, outDir);
  copied++;
}
if (fs.existsSync(pvfSrcDir)) {
  ensureInside(path.resolve(root), path.resolve(pvfOutDir));
  fs.rmSync(pvfOutDir, { recursive: true, force: true });
  copyJsonTree(pvfSrcDir, pvfOutDir);
  copied++;
}
if (copied) console.log('[copy-script-tags] copied config json files to dist/config');
