#!/usr/bin/env node
// Import translated official PVF sample comments into script tag JSON files.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const defaultSourceDir = path.join(root, 'temporary file', '官方pvf注释', '翻译后');
const tagRoot = path.join(root, 'src', 'config', 'scriptLang', 'scriptTags');
const officialAuthor = '官方PVF';
const sourceHeadingPrefix = '#### 官方示例: ';

const variantSamples = new Map(Object.entries({
  'avatarsample.equ': { short: 'equ', variant: 'avatar' },
  'creaturesample.equ': { short: 'equ', variant: 'creature' },
  'equipmentsample-change status on change hp.equ': { short: 'equ', variant: 'equipment' },
  'equipmentsample.equ': { short: 'equ', variant: 'equipment' },
  'equipmentsamplebytool.equ': { short: 'equ', variant: 'equipment' },
  'pieceset.equ': { short: 'equ', variant: 'piece-set' },

  '090302stackablesample.stk': { short: 'stk', variant: 'stackable' },
  'stackablesample.stk': { short: 'stk', variant: 'stackable' },
  'stackablesample-booster.stk': { short: 'stk', variant: 'booster' },
  'stackablesample-legacy.stk': { short: 'stk', variant: 'legacy' },
  'stackablesample-monster_card.stk': { short: 'stk', variant: 'monster-card' },
  'stackablesample-pandora.stk': { short: 'stk', variant: 'pandora' },
  'stackablesample-recipe.stk': { short: 'stk', variant: 'recipe' },
  'stackablesample-stackable_legacy.stk': { short: 'stk', variant: 'stackable-legacy' },
  'stackablesample-throwitem.stk': { short: 'stk', variant: 'throwitem' },

  'cashshopsample.etc': { short: 'etc', variant: 'cashshop' },
  'compoundavatarsample.etc': { short: 'etc', variant: 'compoundavatar' },
  'disjointsample.etc': { short: 'etc', variant: 'disjoint' },
  'questparameter.etc': { short: 'etc', variant: 'questparameter' },
  'tutorialtipsample.etc': { short: 'etc', variant: 'tutorialtip' },
  'ultimateskillcutscene.etc': { short: 'etc', variant: 'ultimateskillcutscene' },
}));

function parseArgs(argv) {
  const args = { dryRun: false, sourceDir: defaultSourceDir };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--dry-run') {
      args.dryRun = true;
    } else if (item === '--source') {
      args.sourceDir = path.resolve(argv[++i] || '');
    } else if (item === '--help' || item === '-h') {
      console.log('Usage: node scripts/import-official-tag-comments.cjs [--dry-run] [--source <dir>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }
  return args;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function normalizeTagName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeDisplayName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function stripBacktickSegments(line, state) {
  let out = '';
  let inBacktick = state.inBacktick;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '`') {
      inBacktick = !inBacktick;
      out += ' ';
      continue;
    }
    out += inBacktick ? ' ' : ch;
  }
  state.inBacktick = inBacktick;
  return out;
}

function findCommentStart(line) {
  let inBacktick = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (ch === '`') {
      inBacktick = !inBacktick;
      continue;
    }
    if (!inBacktick && ch === '/' && line[i + 1] === '/') return i;
  }
  return -1;
}

function extractLineComment(line) {
  const index = findCommentStart(line);
  if (index < 0) return undefined;
  return {
    before: line.slice(0, index),
    comment: line.slice(index + 2).trim(),
  };
}

function iterateTags(line) {
  const tags = [];
  const regex = /\[(\/)?([^\]]+)\]/g;
  let match;
  while ((match = regex.exec(line))) {
    const name = normalizeDisplayName(match[2]);
    if (!name) continue;
    tags.push({ name, isClose: !!match[1] });
  }
  return tags;
}

function collectClosingTags(text) {
  const state = { inBacktick: false };
  const closing = new Set();
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const clean = stripBacktickSegments(line, state);
    for (const tag of iterateTags(clean)) {
      if (tag.isClose) closing.add(normalizeTagName(tag.name));
    }
  }
  return closing;
}

function collectOfficialRecords(text) {
  const records = new Map();
  const closing = collectClosingTags(text);
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const split = extractLineComment(line);
    if (!split || !split.comment) continue;
    const cleanBefore = stripBacktickSegments(split.before, { inBacktick: false });
    const tag = iterateTags(cleanBefore).find(item => !item.isClose);
    if (!tag) continue;
    const name = normalizeDisplayName(tag.name);
    const key = normalizeTagName(name);
    if (!records.has(key)) {
      records.set(key, {
        name,
        comments: new Set(),
        closing: closing.has(key),
      });
    }
    records.get(key).comments.add(split.comment);
  }
  return Array.from(records.values()).map(record => ({
    name: record.name,
    comments: Array.from(record.comments),
    closing: record.closing,
  }));
}

function sourceName(sourceDir, file) {
  return path.relative(sourceDir, file).replace(/\\/g, '/').replace(/\.txt$/i, '');
}

function extForSample(sample) {
  const lower = sample.toLowerCase();
  if (lower.endsWith('.ani.als')) return 'ani';
  const ext = path.posix.extname(lower).replace(/^\./, '');
  return ext === 'als' ? 'ani' : ext;
}

function knownShorts() {
  return new Set(fs.readdirSync(tagRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.basename(entry.name, '.json'))
    .filter(short => short !== 'variantRules'));
}

function routeForSample(sample, shorts) {
  const normalized = sample.toLowerCase();
  const bySample = variantSamples.get(normalized);
  if (bySample) return bySample;
  const short = extForSample(normalized);
  if (short && shorts.has(short)) return { short };
  return { short: 'global' };
}

function tagFilePath(route) {
  if (route.variant) {
    return path.join(tagRoot, 'variants', route.short, `${route.variant}.json`);
  }
  return path.join(tagRoot, `${route.short}.json`);
}

function readTagFile(file) {
  if (!fs.existsSync(file)) return { tags: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeTagFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function appendAuthor(previous, author) {
  const parts = String(previous || '').split('|').map(part => part.trim()).filter(Boolean);
  if (!parts.some(part => part.toLowerCase() === author.toLowerCase())) parts.push(author);
  return parts.join('|');
}

function removeAuthor(previous, author) {
  const target = String(author || '').trim().toLowerCase();
  const parts = String(previous || '').split('|')
    .map(part => part.trim())
    .filter(part => part && part.toLowerCase() !== target);
  return parts.join('|');
}

function titleFromComment(name, comment) {
  const normalized = normalizeDisplayName(comment)
    .replace(/^[:：\-–—\s]+/, '')
    .replace(/\s*[,，。.;；:：].*$/, '');
  const withoutCode = normalized.replace(/`[^`]+`/g, '').trim();
  if (!withoutCode) return name;
  return withoutCode.length > 36 ? withoutCode.slice(0, 36) : withoutCode;
}

function officialSection(sample, comments) {
  const body = comments.map(comment => `- ${comment}`).join('\n');
  return `${sourceHeadingPrefix}${sample}\n\n${body}`;
}

function splitImportedOfficialSections(description) {
  const text = String(description || '').replace(/\r\n?/g, '\n').trimEnd();
  if (!text.includes(sourceHeadingPrefix)) return { description: text, officialSections: [] };

  const lines = text.split('\n');
  const kept = [];
  const officialSections = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i].startsWith(sourceHeadingPrefix)) {
      kept.push(lines[i]);
      i++;
      continue;
    }

    const section = [lines[i]];
    i++;
    if (i < lines.length && lines[i] === '') {
      section.push(lines[i]);
      i++;
    }
    while (i < lines.length) {
      if (lines[i].startsWith(sourceHeadingPrefix)) break;
      if (lines[i] === '' && i + 1 < lines.length && lines[i + 1].startsWith(sourceHeadingPrefix)) break;
      if (lines[i] !== '' && !lines[i].startsWith('- ')) break;
      section.push(lines[i]);
      i++;
    }
    officialSections.push(section.join('\n').trimEnd());

    while (i < lines.length && lines[i] === '' && i + 1 < lines.length && lines[i + 1].startsWith(sourceHeadingPrefix)) {
      i++;
    }
  }

  return {
    description: kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd(),
    officialSections,
  };
}

function parseOfficialSections(markdown) {
  const { officialSections } = splitImportedOfficialSections(markdown);
  return officialSections;
}

function uniqueSections(sections) {
  const seen = new Set();
  const out = [];
  for (const section of sections.map(item => String(item || '').replace(/\r\n?/g, '\n').trim()).filter(Boolean)) {
    const key = section.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(section);
  }
  return out;
}

function officialDescriptionFromRecords(records) {
  return records
    .map(record => officialSection(record.sample, record.comments))
    .join('\n\n');
}

function recordsByTag(sourceRecords) {
  const byTag = new Map();
  for (const record of sourceRecords) {
    const key = normalizeTagName(record.name);
    if (!byTag.has(key)) byTag.set(key, []);
    byTag.get(key).push(record);
  }
  for (const records of byTag.values()) {
    records.sort((a, b) => {
      const sample = a.sample.localeCompare(b.sample);
      return sample || a.name.localeCompare(b.name);
    });
  }
  return byTag;
}

function mergeRecordsIntoFile(file, sourceRecords) {
  const data = readTagFile(file);
  if (!Array.isArray(data.tags)) data.tags = [];
  const byName = new Map(data.tags.map(tag => [normalizeTagName(tag.name), tag]));
  const sourceByTag = recordsByTag(sourceRecords);
  const stats = { added: 0, updated: 0, sections: 0, migrated: 0 };

  for (const tag of data.tags) {
    const split = splitImportedOfficialSections(tag.description);
    if (split.officialSections.length) {
      if (split.description) tag.description = split.description;
      else delete tag.description;
      const existingSections = parseOfficialSections(tag.officialDescription);
      const sections = uniqueSections([...existingSections, ...split.officialSections]);
      tag.officialDescription = sections.join('\n\n');
      tag.officialAuthors = appendAuthor(tag.officialAuthors, officialAuthor);
      stats.migrated++;
      stats.updated++;
    }
    if (tag.officialDescription && typeof tag.description === 'string' && !tag.description.trim()) {
      delete tag.description;
      stats.updated++;
    }
  }

  for (const [key, records] of sourceByTag) {
    const firstRecord = records[0];
    let tag = byName.get(key);
    const nextOfficialDescription = officialDescriptionFromRecords(records);
    if (!tag) {
      tag = {
        name: firstRecord.name,
        title: titleFromComment(firstRecord.name, firstRecord.comments[0] || firstRecord.name),
        officialDescription: nextOfficialDescription,
        officialAuthors: officialAuthor,
      };
      if (records.some(record => record.closing)) tag.closing = true;
      data.tags.push(tag);
      byName.set(key, tag);
      stats.added++;
      stats.sections += records.length;
      continue;
    }

    let changed = false;
    if (!tag.title) {
      tag.title = titleFromComment(firstRecord.name, firstRecord.comments[0] || firstRecord.name);
      changed = true;
    }
    if ((tag.officialDescription || '').replace(/\r\n?/g, '\n').trimEnd() !== nextOfficialDescription) {
      tag.officialDescription = nextOfficialDescription;
      stats.sections += records.length;
      changed = true;
    }
    if ((tag.officialAuthors || '').trim() !== officialAuthor) {
      tag.officialAuthors = officialAuthor;
      changed = true;
    }
    const humanAuthors = removeAuthor(tag.authors, officialAuthor);
    if (humanAuthors !== (tag.authors || '')) {
      if (humanAuthors) tag.authors = humanAuthors;
      else delete tag.authors;
      changed = true;
    }
    if (typeof tag.closing !== 'boolean' && records.some(record => record.closing)) {
      tag.closing = true;
      changed = true;
    }
    if (changed) {
      stats.updated++;
    }
  }

  return { data, stats };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.sourceDir)) {
    throw new Error(`Source directory does not exist: ${args.sourceDir}`);
  }
  const shorts = knownShorts();
  const files = walk(args.sourceDir);
  const grouped = new Map();
  const skipped = [];

  for (const file of files) {
    const sample = sourceName(args.sourceDir, file);
    const text = fs.readFileSync(file, 'utf8');
    const records = collectOfficialRecords(text).map(record => ({ ...record, sample }));
    if (records.length === 0) {
      skipped.push(sample);
      continue;
    }
    const route = routeForSample(sample, shorts);
    const key = JSON.stringify(route);
    if (!grouped.has(key)) grouped.set(key, { route, records: [], samples: new Set() });
    const group = grouped.get(key);
    group.records.push(...records);
    group.samples.add(sample);
  }

  for (const [sample, route] of variantSamples) {
    const key = JSON.stringify(route);
    if (grouped.has(key)) continue;
    grouped.set(key, { route, records: [], samples: new Set([sample]) });
  }

  const report = [];
  for (const group of grouped.values()) {
    const file = tagFilePath(group.route);
    const { data, stats } = mergeRecordsIntoFile(file, group.records);
    report.push({
      target: path.relative(root, file).replace(/\\/g, '/'),
      samples: group.samples.size,
      records: group.records.length,
      ...stats,
    });
    if (!args.dryRun && (stats.added || stats.updated || (!fs.existsSync(file) && group.route.variant))) {
      writeTagFile(file, data);
    }
  }

  report.sort((a, b) => a.target.localeCompare(b.target));
  console.log(args.dryRun ? '[official-comments] dry run' : '[official-comments] imported');
  console.table(report);
  if (skipped.length) {
    console.log(`[official-comments] skipped ${skipped.length} files without importable line comments`);
    console.log(skipped.slice(0, 30).join('\n'));
    if (skipped.length > 30) console.log(`... ${skipped.length - 30} more`);
  }
}

main();
