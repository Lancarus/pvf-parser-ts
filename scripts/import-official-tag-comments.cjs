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

function findCommentStart(line, initialInBacktick = false) {
  let inBacktick = initialInBacktick;
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

function splitCodeAndComment(line, initialInBacktick = false) {
  const index = findCommentStart(line, initialInBacktick);
  if (index < 0) {
    const state = { inBacktick: initialInBacktick };
    stripBacktickSegments(line, state);
    return { before: line, comment: '', hasComment: false, inBacktickEnd: state.inBacktick };
  }
  const before = line.slice(0, index);
  const state = { inBacktick: initialInBacktick };
  stripBacktickSegments(before, state);
  return {
    before,
    comment: line.slice(index + 2).trim(),
    hasComment: true,
    inBacktickEnd: state.inBacktick,
  };
}

function shouldCarryBacktickState(lines, index, split, cleanCode, tags, initialInBacktick) {
  if (!split.inBacktickEnd) return false;
  if (initialInBacktick) return true;
  if (cleanCode.trim() || tags.length) return false;
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('`')) return true;
    const probeSplit = splitCodeAndComment(line);
    const probeClean = stripBacktickSegments(probeSplit.before, { inBacktick: false });
    if (iterateTags(probeClean).length) return false;
  }
  return false;
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
  const closing = new Set();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let inBacktick = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const split = splitCodeAndComment(line, inBacktick);
    const code = split.before;
    const stripState = { inBacktick };
    const clean = stripBacktickSegments(code, stripState);
    const tags = iterateTags(clean);
    for (const tag of iterateTags(clean)) {
      if (tag.isClose) closing.add(normalizeTagName(tag.name));
    }
    inBacktick = shouldCarryBacktickState(lines, index, split, clean, tags, inBacktick)
      ? stripState.inBacktick
      : false;
  }
  return closing;
}

function ensureRecord(records, name, closing) {
  const displayName = normalizeDisplayName(name);
  const key = normalizeTagName(displayName);
  if (!records.has(key)) {
    records.set(key, {
      name: displayName,
      comments: new Set(),
      snippets: new Set(),
      closing: closing.has(key),
    });
  }
  return records.get(key);
}

function addOfficialSnippet(records, name, snippet, comments, closing) {
  const cleanSnippet = String(snippet || '').replace(/\r\n?/g, '\n').trim();
  if (!cleanSnippet) return;
  const record = ensureRecord(records, name, closing);
  record.snippets.add(cleanSnippet);
  for (const comment of comments || []) {
    const cleanComment = String(comment || '').trim();
    if (cleanComment) record.comments.add(cleanComment);
  }
}

function lastIndexOfStackTag(stack, key) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].key === key) return i;
  }
  return -1;
}

function buildLineInfos(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let inBacktick = false;
  return lines.map((raw, index) => {
    const split = splitCodeAndComment(raw, inBacktick);
    const stripState = { inBacktick };
    const cleanCode = stripBacktickSegments(split.before, stripState);
    const tags = iterateTags(cleanCode);
    inBacktick = shouldCarryBacktickState(lines, index, split, cleanCode, tags, inBacktick)
      ? stripState.inBacktick
      : false;
    return {
      index,
      raw,
      before: split.before,
      comment: split.comment,
      hasComment: split.hasComment && !!split.comment,
      tags,
      openingTags: tags.filter(tag => !tag.isClose),
      closingTags: tags.filter(tag => tag.isClose),
    };
  });
}

function snippetFromLines(infos, start, end) {
  let from = Math.max(0, start);
  let to = Math.min(infos.length - 1, end);
  while (from <= to && !infos[from].raw.trim()) from++;
  while (to >= from && !infos[to].raw.trim()) to--;
  if (from > to) return '';
  return infos.slice(from, to + 1)
    .map(info => info.raw.trimEnd())
    .join('\n')
    .trimEnd();
}

function commentsFromLines(infos, start, end) {
  const comments = [];
  for (let i = Math.max(0, start); i <= Math.min(infos.length - 1, end); i++) {
    if (infos[i].hasComment) comments.push(infos[i].comment);
  }
  return comments;
}

function precedingCommentStart(infos, index) {
  let start = index;
  for (let i = index - 1; i >= 0; i--) {
    const info = infos[i];
    if (!info.hasComment || info.before.trim() || info.tags.length) break;
    start = i;
  }
  return start;
}

function scalarSnippetEnd(infos, index) {
  let end = index;
  for (let i = index + 1; i < infos.length; i++) {
    const info = infos[i];
    if (!info.raw.trim()) break;
    if (info.tags.length) break;
    end = i;
  }
  return end;
}

function addScalarSnippets(records, infos, closing) {
  for (const info of infos) {
    const scalarTags = info.openingTags.filter(tag => !closing.has(normalizeTagName(tag.name)));
    if (!scalarTags.length) continue;
    const start = precedingCommentStart(infos, info.index);
    const end = scalarSnippetEnd(infos, info.index);
    const comments = commentsFromLines(infos, start, end);
    if (!comments.length) continue;
    const snippet = snippetFromLines(infos, start, end);
    for (const tag of scalarTags) addOfficialSnippet(records, tag.name, snippet, comments, closing);
  }
}

function addClosingBlockSnippets(records, infos, closing) {
  const stack = [];
  for (const info of infos) {
    if (info.hasComment && !info.tags.length && stack.length) {
      const top = stack[stack.length - 1];
      top.hasComment = true;
      top.comments.push(info.comment);
    }

    let lineCommentAttributed = !info.hasComment;
    for (const tag of info.tags) {
      const key = normalizeTagName(tag.name);
      if (tag.isClose) {
        const index = lastIndexOfStackTag(stack, key);
        if (index >= 0) {
          const context = stack[index];
          if (!lineCommentAttributed) {
            context.hasComment = true;
            context.comments.push(info.comment);
            lineCommentAttributed = true;
          }
          stack.splice(index);
          if (context.hasComment) {
            addOfficialSnippet(
              records,
              context.name,
              snippetFromLines(infos, context.start, info.index),
              context.comments,
              closing
            );
          }
        }
        continue;
      }

      if (!closing.has(key)) continue;
      const start = precedingCommentStart(infos, info.index);
      const comments = commentsFromLines(infos, start, info.index);
      const context = {
        name: normalizeDisplayName(tag.name),
        key,
        start,
        comments,
        hasComment: comments.length > 0,
      };
      if (!lineCommentAttributed && info.hasComment) {
        context.hasComment = true;
        context.comments.push(info.comment);
        lineCommentAttributed = true;
      }
      ensureRecord(records, context.name, closing);
      stack.push(context);
    }
  }
}

function collectOfficialRecords(text) {
  const records = new Map();
  const closing = collectClosingTags(text);
  const infos = buildLineInfos(text);
  addClosingBlockSnippets(records, infos, closing);
  addScalarSnippets(records, infos, closing);
  return Array.from(records.values()).map(record => ({
    name: record.name,
    comments: Array.from(record.comments),
    snippets: Array.from(record.snippets),
    closing: record.closing,
  })).filter(record => record.snippets.length);
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

function officialSection(sample, record) {
  const body = (record.snippets || []).map(snippet => `\`\`\`pvf\n${snippet}\n\`\`\``).join('\n\n');
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
    .map(record => officialSection(record.sample, record))
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
    if (typeof tag.description === 'string' && !tag.description.trim()) {
      delete tag.description;
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
