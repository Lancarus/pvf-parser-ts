#!/usr/bin/env node
// Copy scriptTags definitions into dist for runtime (language providers)
const fs = require('fs');
const path = require('path');
const root = __dirname + '/..';
const srcDir = path.join(root, 'src', 'scriptLang', 'scriptTags');
const outDir = path.join(root, 'dist', 'scriptLang', 'scriptTags');
if (!fs.existsSync(srcDir)) process.exit(0);
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
ensureInside(path.resolve(root), path.resolve(outDir));
fs.rmSync(outDir, { recursive: true, force: true });
copyJsonTree(srcDir, outDir);
console.log('[copy-script-tags] copied tag json files to dist/scriptLang/scriptTags');
