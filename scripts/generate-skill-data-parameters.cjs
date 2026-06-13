#!/usr/bin/env node
// Generate skill [level info] / [static data] labels from local annotation dumps.
const fs = require('fs');
const path = require('path');
const opencc = require('opencc-js');

const root = path.resolve(__dirname, '..');
const defaultParameterDir = path.join(root, 'temporary file', '技能动静态参数');
const defaultSqrDir = path.join(root, 'temporary file', 'sqr相关注释');
const defaultOutFile = path.join(root, 'src', 'config', 'pvf', 'skillDataParameters.json');
const toSimplifiedChinese = opencc.Converter({ from: 'tw', to: 'cn' });

const sceneLabels = {
  default: '默认/通用',
  dungeon: '地下城',
  pvp: '决斗场',
  'death tower': '死亡之塔',
  warroom: '战争房间',
};

function parseArgs(argv) {
  const args = {
    parameterDir: defaultParameterDir,
    sqrDir: defaultSqrDir,
    outFile: defaultOutFile,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source') {
      args.parameterDir = path.resolve(argv[++i] || '');
    } else if (arg === '--sqr') {
      args.sqrDir = path.resolve(argv[++i] || '');
    } else if (arg === '--out') {
      args.outFile = path.resolve(argv[++i] || '');
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/generate-skill-data-parameters.cjs [--source <dir>] [--sqr <dir>] [--out <file>] [--dry-run]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function walk(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file, predicate, out);
    } else if (entry.isFile() && (!predicate || predicate(file))) {
      out.push(file);
    }
  }
  return out;
}

function normalizeKey(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

function skillPathKey(value) {
  const normalized = normalizeKey(value);
  return normalized.startsWith('skill/') ? normalized.slice('skill/'.length) : normalized;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`\[\]【】()（）:：,，.。/\\_\-\s]+/g, '');
}

function compactToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function simplifyText(value) {
  return toSimplifiedChinese(String(value || ''));
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function relativeSource(file) {
  return normalizeKey(path.relative(root, file));
}

function createEntry(name, skillPath) {
  return {
    name: name || undefined,
    path: skillPath,
    codes: new Set(),
    scenes: new Map(),
    references: {
      nut: new Set(),
      ani: new Set(),
    },
    sources: new Set(),
  };
}

function getScene(entry, sceneKey = 'default') {
  let scene = entry.scenes.get(sceneKey);
  if (!scene) {
    scene = {
      levelInfo: new Map(),
      staticData: new Map(),
    };
    entry.scenes.set(sceneKey, scene);
  }
  return scene;
}

function addLabel(entry, kind, index, label, sourceFile) {
  if (!Number.isInteger(index) || index < 0) return false;
  const cleaned = cleanLabel(label);
  if (!cleaned) return false;
  const scene = getScene(entry, 'default');
  const target = kind === 'static' ? scene.staticData : scene.levelInfo;
  const labels = target.get(index) || [];
  if (!labels.includes(cleaned)) labels.push(cleaned);
  target.set(index, labels);
  if (sourceFile) entry.sources.add(sourceFile);
  return true;
}

function addReference(entry, kind, file) {
  const rel = relativeSource(file);
  if (kind === 'ani') entry.references.ani.add(rel);
  else entry.references.nut.add(rel);
}

function cleanLabel(value) {
  return simplifyText(value)
    .replace(/`/g, ' ')
    .replace(/\[(?:范围信息|level property|static data|level info)[^\]]*\]/gi, ' ')
    .replace(/(?:动态|静态)『\d+』/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b(?:LEVEL|STATIC)\b/gi, ' ')
    .replace(/^\s*\d+\s*[.:：、-]\s*/g, '')
    .replace(/[：:，,、;；/+\-~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function labelUnit(line, markerEnd) {
  const tail = line.slice(markerEnd).replace(/^\s+/, '');
  if (tail.startsWith('%%') || tail.startsWith('%')) return '%';
  const unit = tail.match(/^(秒|毫秒|ms|px|次|个|個|级|Lv|LV|%)/);
  return unit ? unit[1] : '';
}

function markerLabel(line, markerIndex, markerEnd) {
  const beforeMarker = line.slice(0, markerIndex);
  const colonIndex = Math.max(beforeMarker.lastIndexOf(':'), beforeMarker.lastIndexOf('：'));
  const context = colonIndex >= 0 ? cleanLabel(beforeMarker.slice(0, colonIndex)) : '';
  const segmentStart = Math.max(
    colonIndex,
    beforeMarker.lastIndexOf('，'),
    beforeMarker.lastIndexOf(','),
    beforeMarker.lastIndexOf('、'),
    beforeMarker.lastIndexOf(';'),
    beforeMarker.lastIndexOf('；'),
    beforeMarker.lastIndexOf('+'),
    beforeMarker.lastIndexOf('~'),
  );
  const segment = cleanLabel(beforeMarker.slice(segmentStart + 1));
  const base = [context, segment && segment !== context ? segment : ''].filter(Boolean).join(' ') || context || segment;
  const unit = labelUnit(line, markerEnd);
  if (!base) return '';
  return unit ? `${base} (${unit})` : base;
}

function parseParameterAnnotations(parameterDir) {
  const entries = new Map();
  const files = walk(parameterDir, file => file.toLowerCase().endsWith('.txt'));
  let markerCount = 0;
  for (const file of files) {
    const sourceFile = relativeSource(file);
    const chunks = readText(file).split(/^--------------------------------------------------\s*$/m);
    for (const chunk of chunks) {
      const lines = chunk.split('\n').map(line => line.trimEnd());
      const header = findSkillHeader(lines);
      if (!header) continue;
      const key = skillPathKey(header.path);
      if (!key.endsWith('.skl')) continue;
      let entry = entries.get(key);
      if (!entry) {
        entry = createEntry(header.name, key);
        entries.set(key, entry);
      } else if (!entry.name && header.name) {
        entry.name = header.name;
      }

      for (const line of lines) {
        const markerRegex = /(动态|静态)『(\d+)』/g;
        let match;
        while ((match = markerRegex.exec(line))) {
          const kind = match[1] === '静态' ? 'static' : 'level';
          const index = Number(match[2]);
          const label = markerLabel(line, match.index, markerRegex.lastIndex);
          if (addLabel(entry, kind, index, label, sourceFile)) markerCount++;
        }
      }
    }
  }
  return { entries, files: files.map(relativeSource), markerCount };
}

function findSkillHeader(lines) {
  let previous = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('[') || line.startsWith('-')) continue;
    const match = line.match(/([a-z0-9_ -]+[\\/][^\s`]+\.skl)\b/i);
    if (!match) {
      previous = line;
      continue;
    }
    const before = line.slice(0, match.index).trim();
    return {
      name: before || previous,
      path: match[1],
    };
  }
  return undefined;
}

function buildSkillLookups(entries) {
  const byJobBase = new Map();
  const byBase = new Map();
  const byJobName = new Map();
  for (const [key, entry] of entries) {
    const parts = key.split('/');
    const job = parts.length > 1 ? parts[0] : '';
    const base = compactToken(path.posix.basename(key, '.skl'));
    pushMap(byJobBase, `${job}:${base}`, key);
    pushMap(byBase, base, key);
    if (entry.name) pushMap(byJobName, `${job}:${normalizeName(entry.name)}`, key);
  }
  return { byJobBase, byBase, byJobName };
}

function pushMap(map, key, value) {
  const values = map.get(key) || [];
  if (!values.includes(value)) values.push(value);
  map.set(key, values);
}

function inferSqrJob(relPath) {
  const parts = normalizeKey(relPath).split('/');
  const characterIdx = parts.indexOf('character');
  if (characterIdx >= 0 && parts[characterIdx + 1]) return parts[characterIdx + 1];
  return '';
}

function inferSqrSkillDir(relPath) {
  const parts = normalizeKey(relPath).split('/');
  const characterIdx = parts.indexOf('character');
  if (characterIdx < 0) return undefined;
  const job = parts[characterIdx + 1];
  const skillDir = parts[characterIdx + 2];
  if (!job || !skillDir || !parts[characterIdx + 3]) return undefined;
  return { job, skillDir };
}

function resolveIndexExpression(expr, job, constants) {
  const value = String(expr || '').trim();
  if (/^-?\d+$/.test(value)) return Number(value);
  const direct = constants.byJob.get(`${job}:${value}`);
  if (Number.isInteger(direct)) return direct;
  const global = constants.global.get(value);
  if (Number.isInteger(global)) return global;
  const suffix = value.match(/(?:IDX|LV|COLUMN|LI|STATIC_INT_IDX|LVL_COLUMN_IDX|SKL_LV|SKL_CL_LI)_?(\d+)$/i);
  if (suffix) return Number(suffix[1]);
  return undefined;
}

function parseSqrAnnotations(sqrDir, entries) {
  const files = walk(sqrDir, file => /\.(nut|ani)$/i.test(file));
  const lookups = buildSkillLookups(entries);
  const constants = collectSqrConstants(files, sqrDir);
  const constantSkills = resolveSkillConstants(constants.skillDeclarations, lookups, entries);
  let referenceCount = 0;
  let labelCount = 0;
  let codeCount = 0;

  for (const file of files) {
    const rel = normalizeKey(path.relative(sqrDir, file));
    const ext = path.extname(file).toLowerCase();
    const kind = ext === '.ani' ? 'ani' : 'nut';
    const dirInfo = inferSqrSkillDir(rel);
    if (dirInfo) {
      const dirMatches = lookupSkillByToken(lookups, dirInfo.job, dirInfo.skillDir);
      for (const key of dirMatches) {
        const entry = entries.get(key);
        if (!entry) continue;
        addReference(entry, kind, file);
        referenceCount++;
      }
    }
    if (kind !== 'nut') continue;

    const job = inferSqrJob(rel);
    const lines = readText(file).split('\n');
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const rawLine = lines[lineNo];
      if (/^\s*\/\//.test(rawLine)) {
        const explicit = rawLine.match(/\/\/\s*(\d+)\s+`([^`]+\.skl)`/i);
        if (explicit) {
          const key = skillPathKey(explicit[2]);
          const entry = entries.get(key);
          if (entry) {
            entry.codes.add(Number(explicit[1]));
            entry.sources.add(relativeSource(file));
            codeCount++;
          }
        }
        continue;
      }
      const comment = extractLineComment(rawLine);
      const codeLine = stripLineComment(rawLine);
      for (const call of findDataCalls(codeLine)) {
        const parsed = parseDataCall(call, job, constants);
        if (!parsed) continue;
        const skillKey = constantSkills.get(`${job}:${parsed.skillConstant}`) || constantSkills.get(`:${parsed.skillConstant}`);
        if (!skillKey) continue;
        const entry = entries.get(skillKey);
        if (!entry) continue;
        addReference(entry, 'nut', file);
        const label = cleanNutComment(comment);
        if (label && addLabel(entry, parsed.kind, parsed.index, label, relativeSource(file))) labelCount++;
      }
    }
  }

  return {
    files: files.map(relativeSource),
    referenceCount,
    labelCount,
    codeCount,
  };
}

function collectSqrConstants(files, sqrDir) {
  const byJob = new Map();
  const globalValues = new Map();
  const globalCollisions = new Set();
  const skillDeclarations = [];
  for (const file of files.filter(file => file.toLowerCase().endsWith('.nut'))) {
    const rel = normalizeKey(path.relative(sqrDir, file));
    const job = inferSqrJob(rel);
    const lines = readText(file).split('\n');
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const line = lines[lineNo];
      if (/^\s*\/\//.test(line)) continue;
      const match = line.match(/\b([A-Z][A-Z0-9_]+)\s*<-\s*(-?\d+)\b(?:.*?\/\/\s*(.*))?/);
      if (!match) continue;
      const name = match[1];
      const value = Number(match[2]);
      const comment = cleanNutComment(match[3] || '');
      byJob.set(`${job}:${name}`, value);
      if (globalValues.has(name) && globalValues.get(name) !== value) {
        globalCollisions.add(name);
      } else {
        globalValues.set(name, value);
      }
      if (name.startsWith('SKILL_')) {
        skillDeclarations.push({ job, name, value, comment, file, lineNo: lineNo + 1 });
      }
    }
  }
  for (const name of globalCollisions) globalValues.delete(name);
  return { byJob, global: globalValues, skillDeclarations };
}

function resolveSkillConstants(declarations, lookups, entries) {
  const out = new Map();
  for (const decl of declarations) {
    const keys = resolveDeclarationSkill(decl, lookups, entries);
    if (!keys.length) continue;
    const key = keys[0];
    const mapKey = `${decl.job}:${decl.name}`;
    out.set(mapKey, key);
    if (!out.has(`:${decl.name}`)) out.set(`:${decl.name}`, key);
    const entry = entries.get(key);
    if (entry) {
      entry.codes.add(decl.value);
      entry.sources.add(relativeSource(decl.file));
    }
  }
  return out;
}

function resolveDeclarationSkill(decl, lookups, entries) {
  const suffix = decl.name.replace(/^SKILL_/, '');
  const direct = lookupSkillByToken(lookups, decl.job, suffix);
  if (direct.length) return direct;
  const commentName = normalizeName(decl.comment);
  if (commentName) {
    const byName = lookups.byJobName.get(`${decl.job}:${commentName}`);
    if (byName?.length) return byName;
    const globalByName = [];
    for (const [key, entry] of entries) {
      if (normalizeName(entry.name) === commentName) globalByName.push(key);
    }
    if (globalByName.length === 1) return globalByName;
  }
  return [];
}

function lookupSkillByToken(lookups, job, token) {
  const base = compactToken(token.replace(/^SKILL_/, ''));
  const byJob = lookups.byJobBase.get(`${job}:${base}`);
  if (byJob?.length) return byJob;
  const global = lookups.byBase.get(base);
  return global?.length === 1 ? global : [];
}

function extractLineComment(line) {
  const idx = line.indexOf('//');
  return idx >= 0 ? line.slice(idx + 2) : '';
}

function stripLineComment(line) {
  const idx = line.indexOf('//');
  return idx >= 0 ? line.slice(0, idx) : line;
}

function cleanNutComment(value) {
  return simplifyText(value)
    .replace(/^\s*(?:LEVEL|STATIC)\s*/i, '')
    .replace(/^\s*\(?\d+\)?\s*[.:：、-]\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findDataCalls(line) {
  const names = [
    'sq_GetLevelData',
    'sq_GetIntData',
    'sq_GetBonusRateWithPassive',
    'sq_GetPowerWithPassive',
  ];
  const calls = [];
  for (const name of names) {
    let searchFrom = 0;
    while (searchFrom < line.length) {
      const idx = line.indexOf(name, searchFrom);
      if (idx < 0) break;
      const open = line.indexOf('(', idx + name.length);
      if (open < 0) break;
      const close = findMatchingParen(line, open);
      if (close < 0) {
        searchFrom = open + 1;
        continue;
      }
      calls.push({ name, args: splitArgs(line.slice(open + 1, close)) });
      searchFrom = close + 1;
    }
  }
  return calls;
}

function findMatchingParen(line, open) {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitArgs(value) {
  const args = [];
  let current = '';
  let depth = 0;
  for (const ch of value) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function parseDataCall(call, job, constants) {
  if (!call.args.length) return undefined;
  if (call.name === 'sq_GetIntData') {
    return parseSkillIndexCall(call, job, constants, 'static', 1);
  }
  if (call.name === 'sq_GetLevelData') {
    return parseSkillIndexCall(call, job, constants, 'level', 1);
  }
  if (call.name === 'sq_GetBonusRateWithPassive' || call.name === 'sq_GetPowerWithPassive') {
    const firstSkill = /^SKILL_[A-Z0-9_]+$/.test(call.args[0] || '');
    const skillArg = firstSkill ? call.args[0] : call.args[1];
    const indexArg = firstSkill ? call.args[2] : call.args[3];
    if (!/^SKILL_[A-Z0-9_]+$/.test(skillArg || '')) return undefined;
    const index = resolveIndexExpression(indexArg, job, constants);
    if (!Number.isInteger(index)) return undefined;
    return { skillConstant: skillArg, kind: 'level', index };
  }
  return undefined;
}

function parseSkillIndexCall(call, job, constants, kind) {
  const firstSkill = /^SKILL_[A-Z0-9_]+$/.test(call.args[0] || '');
  const skillArg = firstSkill ? call.args[0] : call.args[1];
  const indexArg = firstSkill ? call.args[1] : call.args[2];
  if (!/^SKILL_[A-Z0-9_]+$/.test(skillArg || '')) return undefined;
  const index = resolveIndexExpression(indexArg, job, constants);
  if (!Number.isInteger(index)) return undefined;
  return { skillConstant: skillArg, kind, index };
}

function toPlainConfig(entries, parameterStats, sqrStats) {
  const skills = {};
  const byCode = {};
  for (const [key, entry] of Array.from(entries).sort((a, b) => a[0].localeCompare(b[0]))) {
    const scenes = {};
    for (const [sceneKey, scene] of Array.from(entry.scenes).sort((a, b) => a[0].localeCompare(b[0]))) {
      const sceneOut = {};
      const levelInfo = mapOfLabels(scene.levelInfo);
      const staticData = mapOfLabels(scene.staticData);
      if (Object.keys(levelInfo).length) sceneOut.levelInfo = levelInfo;
      if (Object.keys(staticData).length) sceneOut.staticData = staticData;
      if (Object.keys(sceneOut).length) scenes[sceneKey] = sceneOut;
    }
    const references = {};
    const nut = Array.from(entry.references.nut).sort();
    const ani = Array.from(entry.references.ani).sort();
    if (nut.length) references.nut = nut;
    if (ani.length) references.ani = ani;
    const codes = Array.from(entry.codes).filter(Number.isInteger).sort((a, b) => a - b);
    for (const code of codes) {
      const codeKey = String(code);
      if (!byCode[codeKey]) byCode[codeKey] = [];
      if (!byCode[codeKey].includes(key)) byCode[codeKey].push(key);
    }
    const skillOut = {
      ...(entry.name ? { name: simplifyText(entry.name) } : {}),
      ...(codes.length ? { codes } : {}),
      scenes,
      ...(Object.keys(references).length ? { references } : {}),
      sources: Array.from(entry.sources).sort(),
    };
    skills[key] = skillOut;
  }
  for (const code of Object.keys(byCode)) byCode[code].sort();
  return {
    schemaVersion: 1,
    description: 'Skill [level info] and [static data] parameter labels generated from local annotation libraries. Default labels apply to dungeon, pvp, death tower, and warroom scenes unless a scene override exists.',
    sceneLabels,
    sources: {
      parameterFiles: parameterStats.files,
      sqrRoot: 'temporary file/sqr相关注释',
    },
    stats: {
      skills: Object.keys(skills).length,
      parameterMarkers: parameterStats.markerCount,
      sqrLabels: sqrStats.labelCount,
      sqrReferences: sqrStats.referenceCount,
      sqrCodes: sqrStats.codeCount,
    },
    skills,
    byCode,
  };
}

function mapOfLabels(map) {
  const out = {};
  for (const [index, labels] of Array.from(map).sort((a, b) => a[0] - b[0])) {
    out[String(index)] = labels;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const parameterStats = parseParameterAnnotations(args.parameterDir);
  const sqrStats = parseSqrAnnotations(args.sqrDir, parameterStats.entries);
  const config = toPlainConfig(parameterStats.entries, parameterStats, sqrStats);
  const json = `${JSON.stringify(config, null, 2)}\n`;
  if (!args.dryRun) {
    fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
    fs.writeFileSync(args.outFile, json, 'utf8');
  }
  console.log(`[generate-skill-data-parameters] skills=${config.stats.skills} markers=${config.stats.parameterMarkers} sqrLabels=${config.stats.sqrLabels} sqrRefs=${config.stats.sqrReferences}`);
  console.log(`[generate-skill-data-parameters] ${args.dryRun ? 'would write' : 'wrote'} ${path.relative(root, args.outFile)}`);
}

main();
