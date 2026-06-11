#!/usr/bin/env node
// Sync comments and authors from PvfTabComments.bin into scriptTags JSON files.
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const root = path.resolve(__dirname, '..');
const tagDir = path.join(root, 'src', 'config', 'scriptLang', 'scriptTags');
const fallbackAuthor = 'lostluna1';

const dbPath = path.resolve(process.argv[2] || path.join(root, 'PvfTabComments.bin'));

const languageTargets = {
  act: { groups: [[2, 0]], useGlobalForExisting: true, addMissing: true },
  ai: { groups: [[21, 0]], useGlobalForExisting: false, addMissing: false },
  aic: { groups: [[21, 0]], useGlobalForExisting: true, addMissing: true },
  ani: { groups: [[1, 0], [1, 1], [17, 0], [17, 1]], useGlobalForExisting: true, addMissing: true },
  equ: { groups: [[0, 0], [0, 1]], useGlobalForExisting: true, addMissing: true },
  key: { groups: [[42, 0]], useGlobalForExisting: false, addMissing: true },
  skl: { groups: [[15, 0], [15, 1]], useGlobalForExisting: true, addMissing: true },
  stk: { groups: [[3, 0], [3, 1], [54, 0]], useGlobalForExisting: true, addMissing: true }
};

const knownGroupFormats = new Map([
  ['global:0', 'global'],
  ['0:0', 'equ'], ['0:1', 'equ'],
  ['1:0', 'ani'], ['1:1', 'ani'],
  ['2:0', 'act'],
  ['3:0', 'stk'], ['3:1', 'stk'],
  ['4:0', 'ptl'], ['4:1', 'ptl'],
  ['6:0', 'dgn'],
  ['7:0', 'tbl'],
  ['8:0', 'ai'],
  ['9:0', 'atk'],
  ['10:0', 'map'],
  ['11:0', 'mob'], ['11:1', 'mob'],
  ['12:0', 'obj'],
  ['14:0', 'qst'], ['14:1', 'qst'],
  ['15:0', 'skl'], ['15:1', 'skl'],
  ['16:0', 'ui'], ['16:1', 'ui'],
  ['17:0', 'ani'], ['17:1', 'ani'],
  ['21:0', 'aic'],
  ['22:0', 'shp'], ['22:1', 'shp'],
  ['24:0', 'npc'], ['24:1', 'npc'],
  ['26:0', 'etc'],
  ['28:0', 'co'], ['28:1', 'co'],
  ['29:0', 'nut'],
  ['30:0', 'cre'],
  ['32:0', 'evt'],
  ['39:0', 'exj'],
  ['41:0', 'twn'], ['41:1', 'twn'],
  ['42:0', 'key'],
  ['43:0', 'sd'], ['43:1', 'sd'],
  ['45:0', 'rgn'],
  ['46:0', 'chr'], ['46:1', 'chr'],
  ['48:0', 'lay'],
  ['49:0', 'wdm'],
  ['50:0', 'mm'],
  ['54:0', 'stk'],
  ['57:0', 'bm'],
  ['58:0', 'stm'],
  ['67:0', 'blu']
]);

const scanTextExts = new Set([
  'act', 'ani', 'skl', 'ai', 'aic', 'key', 'equ', 'stk', 'obj', 'atk', 'til', 'ptl',
  'qst', 'map', 'mob', 'apd', 'etc', 'dgn', 'ui', 'nut', 'npc', 'cre', 'msn', 'wrd',
  'shp', 'evt', 'gdata', 'emo', 'co', 'tbl', 'wdm', 'twn', 'chr', 'lay', 'cbt', 'pos',
  'exj', 'rgn', 'mm', 'stm', 'skt', 'cmb', 'pet', 'dl', 'evn', 'glist', 'tlk', 'ora',
  'bt', 'bm', 'blu', 'info'
]);

function normalizeName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function displayName(value) {
  return String(value ?? '').trim().replace(/[ \t\r\n]+/g, ' ');
}

function normalizeAuthors(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .split('|')
    .map(part => part.trim())
    .filter(part => part !== '谷歌翻译')
    .filter(Boolean)
    .join('|');
}

function normalizeComment(value) {
  return String(value ?? '')
    .replace(/\r+\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

function groupKey(fileType, pvfCommentType) {
  return `${fileType === null || fileType === undefined ? 'global' : Number(fileType)}:${pvfCommentType === null || pvfCommentType === undefined ? 'null' : Number(pvfCommentType)}`;
}

function parseGroupKey(key) {
  const [fileType, pvfCommentType] = key.split(':');
  return {
    fileType: fileType === 'global' ? null : Number(fileType),
    pvfCommentType: pvfCommentType === 'null' ? null : Number(pvfCommentType)
  };
}

function safeFilePart(value) {
  return String(value || 'unknown').replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'unknown';
}

function appendRows(targetMap, sourceMap) {
  for (const [section, rows] of sourceMap.entries()) {
    const list = targetMap.get(section) || [];
    list.push(...rows);
    targetMap.set(section, list);
  }
}

function isGoogleRow(row) {
  const authors = String(row.Authors ?? '')
    .replace(/\r?\n/g, ' ')
    .split('|')
    .map(part => part.trim())
    .filter(Boolean);
  return authors.length > 0 && authors.every(part => part === '谷歌翻译');
}

function compareRows(a, b) {
  const aAuth = normalizeAuthors(a.Authors);
  const bAuth = normalizeAuthors(b.Authors);
  const aCurated = aAuth ? 1 : 0;
  const bCurated = bAuth ? 1 : 0;
  if (aCurated !== bCurated) return bCurated - aCurated;
  const byTime = String(b.UpdateTime || '').localeCompare(String(a.UpdateTime || ''));
  if (byTime !== 0) return byTime;
  return Number(b.Id || 0) - Number(a.Id || 0);
}

function pickBest(rows, allowEmptyAuthors = false) {
  const candidates = rows
    .filter(row => !isGoogleRow(row))
    .filter(row => allowEmptyAuthors || normalizeAuthors(row.Authors))
    .filter(row => normalizeName(row.Section))
    .filter(row => row.Comment !== null && row.Comment !== undefined)
    .sort(compareRows);
  return candidates[0];
}

function rowToTag(row, existing) {
  const tag = existing ? { ...existing } : { name: displayName(row.Section) };
  tag.description = normalizeComment(row.Comment);
  tag.authors = normalizeAuthors(row.Authors) || fallbackAuthor;
  return tag;
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^([^=]+)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1].trim()] = value;
  }
  return out;
}

function collectUnpackExtensionTags(unpackDir) {
  const abs = path.resolve(unpackDir || '');
  if (!unpackDir || !fs.existsSync(abs)) return new Map();
  const extFiles = new Map();
  const stack = [abs];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (!scanTextExts.has(ext)) continue;
      const files = extFiles.get(ext) || [];
      if (files.length < 240) files.push(file);
      extFiles.set(ext, files);
    }
  }

  const extTags = new Map();
  for (const [ext, files] of extFiles.entries()) {
    const tags = new Set();
    let read = 0;
    for (const file of files) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.size > 1024 * 1024) continue;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      read++;
      const regex = /\[(\/)?([^\]\r\n]{1,80})\]/g;
      let match;
      while ((match = regex.exec(text))) {
        const tag = normalizeName(match[2]);
        if (tag) tags.add(tag);
      }
    }
    extTags.set(ext, { tags, read });
  }
  return extTags;
}

function inferFormats(byGroup) {
  const formats = new Map(knownGroupFormats);
  const env = parseEnvFile(path.join(root, '.env'));
  const extTags = collectUnpackExtensionTags(env.UNPACK_DIR);
  if (extTags.size === 0) return formats;

  for (const [key, sectionMap] of byGroup.entries()) {
    if (formats.has(key)) continue;
    const sections = new Set(sectionMap.keys());
    const scores = [];
    for (const [ext, info] of extTags.entries()) {
      let hits = 0;
      for (const section of sections) {
        if (info.tags.has(section)) hits++;
      }
      if (!hits) continue;
      const score = hits / Math.sqrt(Math.max(1, sections.size) * Math.max(1, info.tags.size));
      scores.push({ ext, hits, score });
    }
    scores.sort((a, b) => b.score - a.score || b.hits - a.hits);
    if (scores[0] && scores[0].score >= 0.12) {
      formats.set(key, scores[0].ext);
    }
  }
  return formats;
}

function getSectionMap(container, key) {
  let sectionMap = container.get(key);
  if (!sectionMap) {
    sectionMap = new Map();
    container.set(key, sectionMap);
  }
  return sectionMap;
}

function pushSectionRow(sectionMap, row) {
  const section = normalizeName(row.Section);
  if (!section) return;
  const list = sectionMap.get(section) || [];
  list.push(row);
  sectionMap.set(section, list);
}

function ensureInside(parent, child) {
  const rel = path.relative(parent, child);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside ${parent}: ${child}`);
  }
}

async function main() {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`SQLite database not found: ${dbPath}`);
  }
  if (!fs.existsSync(tagDir)) {
    throw new Error(`scriptTags directory not found: ${tagDir}`);
  }

  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
  try {
    const rows = await all(db, `
      SELECT Id, PvfCommentType, FileType, Section, Comment, Authors, UpdateTime
      FROM pvf_comment
      WHERE Section IS NOT NULL
        AND Comment IS NOT NULL
    `);

    const byGroup = new Map();
    const byGlobalSection = new Map();
    for (const row of rows) {
      if (isGoogleRow(row)) continue;
      const key = groupKey(row.FileType, row.PvfCommentType);
      pushSectionRow(getSectionMap(byGroup, key), row);
      if (row.FileType === null || row.FileType === undefined) {
        pushSectionRow(byGlobalSection, row);
      }
    }

    let totalUpdated = 0;
    let totalMatched = 0;
    let totalAdded = 0;
    const report = [];

    for (const short of Object.keys(languageTargets).sort()) {
      const file = path.join(tagDir, `${short}.json`);

      const target = languageTargets[short];
      const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { tags: [] };
      const tags = Array.isArray(data.tags) ? data.tags : [];
      const tagMap = new Map(tags.map(tag => [normalizeName(tag.name), tag]));
      let matched = 0;
      let updated = 0;
      let added = 0;
      let authorFilled = 0;

      for (const tag of tags) {
        const section = normalizeName(tag.name);
        if (!section) continue;
        const candidates = [];
        for (const group of target.groups) {
          const sectionRows = byGroup.get(groupKey(group[0], group[1]))?.get(section) || [];
          candidates.push(...sectionRows);
        }
        if (target.useGlobalForExisting) {
          candidates.push(...(byGlobalSection.get(section) || []));
        }
        const picked = pickBest(candidates, false);
        if (!picked) continue;

        matched++;
        const next = rowToTag(picked, tag);
        if (tag.description !== next.description || tag.authors !== next.authors) {
          Object.assign(tag, next);
          updated++;
        }
      }

      if (target.addMissing) {
        for (const group of target.groups) {
          const sectionMap = byGroup.get(groupKey(group[0], group[1]));
          if (!sectionMap) continue;
          for (const [section, sectionRows] of sectionMap.entries()) {
            if (tagMap.has(section)) continue;
            const picked = pickBest(sectionRows, true);
            if (!picked) continue;
            const tag = rowToTag(picked);
            tags.push(tag);
            tagMap.set(section, tag);
            added++;
          }
        }
      }

      for (const tag of tags) {
        if (!normalizeAuthors(tag.authors)) {
          tag.authors = fallbackAuthor;
          authorFilled++;
        }
      }

      data.tags = tags;
      if (updated > 0 || added > 0 || authorFilled > 0) {
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
      }
      totalMatched += matched;
      totalUpdated += updated;
      totalAdded += added;
      report.push(`${short}: matched ${matched}, updated ${updated}, added ${added}, filledAuthors ${authorFilled}`);
    }

    const formats = inferFormats(byGroup);

    const generatedByFormat = new Map();
    const skippedUnknownGroups = [];
    for (const key of [...byGroup.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      const sectionMap = byGroup.get(key);
      const format = formats.get(key);
      if (!format) {
        skippedUnknownGroups.push(key);
        continue;
      }
      const short = safeFilePart(format);
      if (!short || languageTargets[short]) continue;
      let formatMap = generatedByFormat.get(short);
      if (!formatMap) {
        formatMap = new Map();
        generatedByFormat.set(short, formatMap);
      }
      appendRows(formatMap, sectionMap);
    }

    const generated = [];
    for (const [short, sectionMap] of [...generatedByFormat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const tags = [];
      for (const [, sectionRows] of [...sectionMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const picked = pickBest(sectionRows, true);
        if (picked) tags.push(rowToTag(picked));
      }
      if (!tags.length) continue;
      const fileName = `${short}.json`;
      const outFile = path.join(tagDir, fileName);
      ensureInside(tagDir, outFile);
      fs.writeFileSync(outFile, JSON.stringify({ tags }, null, 2) + '\n', 'utf8');
      generated.push({ file: fileName, tags: tags.length });
    }

    for (const line of report) console.log(`[sync-tab-comments] ${line}`);
    console.log(`[sync-tab-comments] database rows read: ${rows.length}`);
    console.log(`[sync-tab-comments] total matched tags: ${totalMatched}`);
    console.log(`[sync-tab-comments] total updated tags: ${totalUpdated}`);
    console.log(`[sync-tab-comments] total added language tags: ${totalAdded}`);
    console.log(`[sync-tab-comments] generated format files: ${generated.length}`);
    if (skippedUnknownGroups.length) {
      console.log(`[sync-tab-comments] skipped unknown format groups: ${skippedUnknownGroups.join(', ')}`);
    }
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('[sync-tab-comments] failed:', err && err.stack || err);
  process.exit(1);
});
