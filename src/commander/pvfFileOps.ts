import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as iconv from 'iconv-lite';
import { performance } from 'perf_hooks';
import { Deps } from './types';
import { PvfFile } from '../pvf/pvfFile';
import { saveImpl } from '../pvf/modelIO';
import { getFileNameHashCode } from '../pvf/util';
import { PvfModel } from '../pvf/model';
import { encodingForKeyWithMode, isPvfScriptExtension, isTextByExtensionForExport, isPrintableText } from '../pvf/helpers';
import { StringTable } from '../pvf/stringTable';
import { ScriptCompiler } from '../pvf/scriptCompiler';
import { compileBinaryAni } from '../pvf/aniCompiler';
import { compileLstText } from '../pvf/lstDecompiler';
import { convertTextForRepack, normalizeChineseConversion, PvfChineseConversion } from '../pvf/chineseConversion';
import {
  createManifestEntryMap,
  normalizeArchiveKey,
  PVF_MANIFEST_FILE,
  PvfArchivePhaseStats,
  PvfDirectoryManifest,
  PvfDiskFileKind,
  runConcurrent,
  stripUtf8Bom,
} from '../pvf/directoryArchive';

interface RepackFile {
  key: string;
  diskPath: string;
  kind: PvfDiskFileKind;
  encoding?: string;
}

/** 将磁盘目录重新封装为 .pvf 文件。脚本/文本文件从 UTF-8 转回原始格式，二进制文件原样写入。 */
async function repackDirectory(
  srcDir: string,
  destPath: string,
  progress?: (current: number, total: number, key: string) => void,
  options?: {
    readConcurrency?: number;
    onStats?: (stats: PvfArchivePhaseStats) => void;
  },
) {
  const phaseStart = performance.now();
  let afterManifest = phaseStart;
  let afterWalk = phaseStart;
  let afterStringTable = phaseStart;
  let afterConvert = phaseStart;
  // 1. 读取 manifest（如果存在）
  let guid = Buffer.alloc(0);
  let guidLen = 0;
  let fileVersion = 0;
  let encodingMode = 'AUTO';
  let defaultEncoding = 'big5';
  let chineseConversion: PvfChineseConversion = 'off';
  let manifest: Partial<PvfDirectoryManifest> | undefined;
  try {
    const manifestRaw = await fs.readFile(path.join(srcDir, PVF_MANIFEST_FILE), 'utf8');
    manifest = JSON.parse(manifestRaw);
    if (manifest?.guid) guid = Buffer.from(manifest.guid, 'hex');
    guidLen = manifest?.guidLen ?? guid.length;
    fileVersion = manifest?.fileVersion ?? 0;
    if (manifest?.encodingMode) encodingMode = manifest.encodingMode;
    if (manifest?.defaultEncoding) defaultEncoding = manifest.defaultEncoding;
    chineseConversion = normalizeChineseConversion(manifest?.chineseConversion ?? 'off');
  } catch { /* 使用默认值 */ }
  const manifestEntries = createManifestEntryMap(manifest);
  const unpackedTextToPvfText = (text: string): string => convertTextForRepack(stripUtf8Bom(text), chineseConversion);
  afterManifest = performance.now();

  // 2. 递归收集所有文件（排除 .pvfmanifest.json）
  const files: RepackFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const subdirs: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = normalizeArchiveKey(path.relative(srcDir, full));
      if (!rel || e.name === PVF_MANIFEST_FILE) continue;
      if (e.isDirectory()) {
        subdirs.push(full);
      } else if (e.isFile()) {
        const entry = manifestEntries.get(rel);
        files.push({
          key: rel,
          diskPath: full,
          kind: entry?.[1] ?? inferDiskFileKind(rel),
          encoding: entry?.[2],
        });
      }
    }
    await runConcurrent(subdirs, 16, async (subdir) => walk(subdir));
  }
  await walk(srcDir);
  files.sort((a, b) => a.key < b.key ? -1 : (a.key > b.key ? 1 : 0));
  afterWalk = performance.now();

  // 3. 解析 stringtable.bin（若存在），供脚本编译和 stringtable 重建
  let strTable: StringTable | undefined;
  const stPath = files.find(f => f.key === 'stringtable.bin');
  if (stPath) {
    try {
      const stText = await fs.readFile(stPath.diskPath, 'utf8');
      strTable = new StringTable(encodingForKeyWithMode('stringtable.bin', encodingMode, defaultEncoding));
      strTable.parseFromText(unpackedTextToPvfText(stText));
    } catch { /* 解析失败则跳过 */ }
  }
  if (!strTable && files.some(f => f.kind === 'script')) {
    strTable = new StringTable(encodingForKeyWithMode('stringtable.bin', encodingMode, defaultEncoding));
  }
  afterStringTable = performance.now();

  // 4. 创建临时 PvfModel 并填充
  const tempModel = new PvfModel();
  (tempModel as any).guid = guid;
  (tempModel as any).guidLen = guidLen;
  (tempModel as any).fileVersion = fileVersion;
  (tempModel as any).pvfPath = '';
  if (strTable) (tempModel as any).strtable = strTable;

  const compiler = strTable ? new ScriptCompiler(tempModel as any) : null;
  let lastReportedPct = -1;
  let completed = 0;

  const readConcurrency = clampInt(options?.readConcurrency, 192, 1, 1024);
  const readTextForRepack = (raw: Uint8Array): string => {
    return unpackedTextToPvfText(Buffer.from(raw).toString('utf8'));
  };
  await runConcurrent(files, readConcurrency, async ({ key, diskPath, kind, encoding }) => {
    const raw = new Uint8Array(await fs.readFile(diskPath));
    const lower = key.toLowerCase();

    let finalBytes: Uint8Array;

    if (lower === 'stringtable.bin' || kind === 'stringtable') {
      if (strTable) {
        const bin = strTable.createBinary();
        finalBytes = new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
      } else {
        finalBytes = raw;
      }
    } else if (kind === 'binary') {
      finalBytes = raw;
    } else if (kind === 'binaryAni') {
      const text = readTextForRepack(raw);
      const compiledAni = compileBinaryAni(text, key);
      if (compiledAni && compiledAni.length > 0) {
        finalBytes = compiledAni;
      } else if (!manifestEntries.has(lower) && text.startsWith('#PVF_File') && compiler) {
        const compiled = compiler.compile(text);
        finalBytes = compiled && compiled.length >= 2 && compiled[0] === 0xB0 && compiled[1] === 0xD0
          ? new Uint8Array(compiled.buffer, compiled.byteOffset, compiled.byteLength)
          : raw;
      } else {
        finalBytes = raw;
      }
    } else if (kind === 'script') {
      const text = readTextForRepack(raw);
      if (!manifestEntries.has(lower) && !text.trimStart().startsWith('#PVF_File')) {
        finalBytes = raw;
      } else {
        const compiled = lower.endsWith('.lst')
          ? compileLstText(tempModel as any, text, lower)
          : compiler?.compile(text);
        if (compiled && compiled.length >= 2 && compiled[0] === 0xB0 && compiled[1] === 0xD0) {
          finalBytes = new Uint8Array(compiled.buffer, compiled.byteOffset, compiled.byteLength);
        } else if (lower.endsWith('.ani')) {
          const compiledAni = compileBinaryAni(text, key);
          finalBytes = compiledAni && compiledAni.length > 0 ? compiledAni : Buffer.from(text, 'utf8');
        } else {
          const targetEnc = encoding || encodingForKeyWithMode(key, encodingMode, defaultEncoding);
          const encoded = iconv.encode(text, targetEnc);
          finalBytes = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
        }
      }
    } else if (kind === 'text') {
      const text = readTextForRepack(raw);
      const targetEnc = encoding || encodingForKeyWithMode(key, encodingMode, defaultEncoding);
      const encoded = iconv.encode(text, targetEnc);
      finalBytes = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    } else {
      // 尝试按 UTF-8 文本解读
      let text: string | null = null;
      try {
        const t = readTextForRepack(raw);
        // 仅当内容为可打印文本时才视为 UTF-8 文本
        if (isPrintableText(t.slice(0, 4096))) text = t;
      } catch { /* 非 UTF-8，作为二进制 */ }

      if (text !== null) {
        if (lower.endsWith('.ani')) {
          const compiledAni = compileBinaryAni(text, key);
          if (compiledAni && compiledAni.length > 0) {
            finalBytes = compiledAni;
          } else if (text.startsWith('#PVF_File') && compiler) {
            const compiled = compiler.compile(text);
            finalBytes = compiled && compiled.length >= 2 && compiled[0] === 0xB0 && compiled[1] === 0xD0
              ? new Uint8Array(compiled.buffer, compiled.byteOffset, compiled.byteLength)
              : Buffer.from(text, 'utf8');
          } else {
            const targetEnc = encodingForKeyWithMode(key, encodingMode, defaultEncoding);
            const encoded = iconv.encode(text, targetEnc);
            finalBytes = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
          }
        } else if (text.startsWith('#PVF_File') && compiler) {
          // 脚本文件（反编译文本）→ 编译回二进制
          const compiled = lower.endsWith('.lst')
            ? compileLstText(tempModel as any, text, lower)
            : compiler.compile(text);
          if (compiled && compiled.length >= 2 && compiled[0] === 0xB0 && compiled[1] === 0xD0) {
            finalBytes = new Uint8Array(compiled.buffer, compiled.byteOffset, compiled.byteLength);
          } else {
            // 编译失败则按文本编码处理
            const targetEnc = encodingForKeyWithMode(key, encodingMode, defaultEncoding);
            const encoded = iconv.encode(text, targetEnc);
            finalBytes = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
          }
        } else if (lower.endsWith('.nut')) {
          const encoded = iconv.encode(text, 'cp949');
          finalBytes = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
        } else if (isTextByExtensionForExport(lower)) {
          const targetEnc = encodingForKeyWithMode(key, encodingMode, defaultEncoding);
          const encoded = iconv.encode(text, targetEnc);
          finalBytes = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
        } else {
          finalBytes = raw; // 启发式文本但未知类型 → 原样保留
        }
      } else {
        finalBytes = raw;
      }
    }

    const nameBytes = iconv.encode(key, 'cp949');
    const fileNameChecksum = getFileNameHashCode(nameBytes);
    const pf = new PvfFile(fileNameChecksum, nameBytes, finalBytes.length, 0, 0);
    pf.writeFileData(finalBytes);
    (tempModel as any).fileList.set(key, pf);

    // 每 1% 进度回调一次
    completed++;
    const pct = files.length > 0 ? Math.floor((completed / files.length) * 100) : 100;
    if (progress && pct !== lastReportedPct) {
      lastReportedPct = pct;
      progress(completed, files.length, key);
    }
  });
  afterConvert = performance.now();

  // 5. 调用 saveImpl 写出 .pvf
  await saveImpl.call(tempModel, destPath, (n: number) => {
    if (progress) {
      progress(Math.floor((n / 100) * files.length), files.length, '写入中...');
    }
  });
  try {
    const done = performance.now();
    const stats: PvfArchivePhaseStats = {
      files: files.length,
      totalMs: done - phaseStart,
      phases: {
        manifest: afterManifest - phaseStart,
        walk: afterWalk - afterManifest,
        stringtable: afterStringTable - afterWalk,
        convert: afterConvert - afterStringTable,
        save: done - afterConvert,
      },
    };
    options?.onStats?.(stats);
    console.log('[pvf repack] phases (ms):', {
      manifest: stats.phases.manifest.toFixed(1),
      walk: stats.phases.walk.toFixed(1),
      stringtable: stats.phases.stringtable.toFixed(1),
      convert: stats.phases.convert.toFixed(1),
      save: stats.phases.save.toFixed(1),
      total: stats.totalMs.toFixed(1),
      files: stats.files,
      readConcurrency,
      chineseConversion,
    });
  } catch { /* ignore profiling output errors */ }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(min, Math.min(max, n));
}

function inferDiskFileKind(key: string): PvfDiskFileKind {
  const lower = key.toLowerCase();
  if (lower === 'stringtable.bin') return 'stringtable';
  if (lower.endsWith('.nut')) return 'text';
  if (lower.endsWith('.ani')) return 'binaryAni';
  if (isPvfScriptExtension(lower)) return 'script';
  if (isTextByExtensionForExport(lower)) return 'text';
  return 'binary';
}

function formatArchiveStats(label: string, stats: PvfArchivePhaseStats, extra?: Record<string, number>): string {
  const phases = Object.entries(stats.phases)
    .map(([name, ms]) => `${name}=${ms.toFixed(0)}ms`)
    .join(', ');
  const extras = extra
    ? ' | ' + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(', ')
    : '';
  const rate = stats.files > 0 ? Math.round(stats.files / Math.max(0.001, stats.totalMs / 1000)) : 0;
  return `[PVF] ${label}: total=${stats.totalMs.toFixed(0)}ms, rate=${rate}/s, files=${stats.files}${stats.dirs !== undefined ? `, dirs=${stats.dirs}` : ''} | ${phases}${extras}`;
}

export function registerPvfFileOps(context: vscode.ExtensionContext, deps: Deps) {
  const { model, tree, deco, output } = deps;
  context.subscriptions.push(
    vscode.commands.registerCommand('pvf._setClipboard', (payload: any) => { context.workspaceState.update('pvf.clipboard', payload); }),
    vscode.commands.registerCommand('pvf._getClipboard', async () => { deco.refreshAll(); return context.workspaceState.get('pvf.clipboard'); }),
    vscode.commands.registerCommand('pvf.selectForCompare', async (node) => { if (!node) return; await context.workspaceState.update('pvf.compareSelection', node.key); vscode.window.showInformationMessage(`已选择 ${node.name} 用于比较`); }),
    vscode.commands.registerCommand('pvf.compareWithSelection', async (node) => {
      if (!node) return; const sel = context.workspaceState.get<string>('pvf.compareSelection'); if (!sel) { vscode.window.showWarningMessage('请先选择一个文件用于比较'); return; }
      const left = vscode.Uri.parse(`pvf:/${sel}`); const right = vscode.Uri.parse(`pvf:/${node.key}`); vscode.commands.executeCommand('vscode.diff', left, right, `${sel} ↔ ${node.key}`);
    }),
    vscode.commands.registerCommand('pvf.cut', async (node) => { if (!node) return; await context.workspaceState.update('pvf.clipboard', { op: 'cut', key: node.key }); vscode.window.showInformationMessage(`已剪切 ${node.name}`); }),
    vscode.commands.registerCommand('pvf.copy', async (node) => { if (!node) return; await context.workspaceState.update('pvf.clipboard', { op: 'copy', key: node.key }); vscode.window.showInformationMessage(`已复制 ${node.name}`); }),
    vscode.commands.registerCommand('pvf.paste', async (node) => {
      if (!node || node.isFile) { vscode.window.showWarningMessage('请选择目标文件夹粘贴'); return; }
      const clip = context.workspaceState.get<any>('pvf.clipboard'); if (!clip) { vscode.window.showWarningMessage('剪贴板为空'); return; }
      const destBase = node.key; const f = model.getFileByKey(clip.key); if (!f) { vscode.window.showErrorMessage('源文件不存在'); return; }
      const baseName = clip.key.split('/').pop() || clip.key; const idx = baseName.lastIndexOf('.'); const namePart = idx >= 0 ? baseName.substring(0, idx) : baseName; const extPart = idx >= 0 ? baseName.substring(idx) : '';
      let candidate = baseName; let n = 1; while (model.getFileByKey(`${destBase}/${candidate}`)) { candidate = `${namePart} (${n})${extPart}`; n++; }
      const destKey = `${destBase}/${candidate}`; const bytes = await model.loadFileData(f); model.createEmptyFile(destKey); const pf = model.getFileByKey(destKey); if (pf) { pf.writeFileData(bytes); pf.changed = true; }
      if (clip.op === 'cut') { model.deleteFile(clip.key); await context.workspaceState.update('pvf.clipboard', undefined); vscode.window.showInformationMessage('移动完成'); } else { vscode.window.showInformationMessage('粘贴完成'); }
      tree.refresh();
    }),
    vscode.commands.registerCommand('pvf.copyPath', async (node) => { if (!node) return; await vscode.env.clipboard.writeText(node.key); vscode.window.showInformationMessage('已复制路径到剪贴板'); }),
    vscode.commands.registerCommand('pvf.openPack', async () => {
      const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'PVF': ['pvf'] } }); if (!uris || uris.length === 0) { return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '打开 PVF…' }, async (p) => {
        const t0 = Date.now(); output.appendLine(`[PVF] open start: ${uris[0].fsPath}`); await model.open(uris[0].fsPath, (n: number) => { p.report({ increment: 0, message: `${n}%` }); }); const ms = Date.now() - t0; output.appendLine(`[PVF] open done in ${ms}ms (parsed header+tree only)`);
      }); tree.refresh(); deco.refreshAll();
      try { await vscode.commands.executeCommand('setContext', 'pvf.hasOpenPack', true); } catch {}
    }),
    vscode.commands.registerCommand('pvf.savePack', async () => {
      if (!model || !(model as any).pvfPath) {
        vscode.window.showWarningMessage('尚未打开任何 PVF 文件'); return;
      }
      const dest = await vscode.window.showSaveDialog({ filters: { 'PVF': ['pvf'] } }); if (!dest) { return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '保存 PVF…' }, async (p) => {
        let last = 0; const ok = await model.save(dest.fsPath, (n: number) => { const inc = Math.max(0, Math.min(100, n) - last); last = Math.max(last, Math.min(100, n)); p.report({ increment: inc, message: `${last}%` }); });
        if (ok) { vscode.window.showInformationMessage('另存为成功'); (model as any).pvfPath = dest.fsPath; try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '重新加载 PVF…' }, async (pp) => { await model.open(dest.fsPath, (n: number) => { pp.report({ increment: 0, message: `${n}%` }); }); }); tree.refresh(); deco.refreshAll(); } catch { vscode.window.showWarningMessage('保存成功，但重新加载封包失败'); } }
        else { vscode.window.showErrorMessage('保存失败'); }
      });
    }),
    vscode.commands.registerCommand('pvf.savePackInPlace', async () => {
      if (!model.pvfPath) { vscode.window.showWarningMessage('尚未打开任何 PVF 文件'); return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '保存 PVF…' }, async (p) => {
        let last = 0; const ok = await model.save(model.pvfPath, (n: number) => { const inc = Math.max(0, Math.min(100, n) - last); last = Math.max(last, Math.min(100, n)); p.report({ increment: inc, message: `${last}%` }); });
        if (ok) { vscode.window.showInformationMessage('已保存到当前文件'); try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '重新加载 PVF…' }, async (pp) => { await model.open(model.pvfPath, (n: number) => { pp.report({ increment: 0, message: `${n}%` }); }); }); tree.refresh(); deco.refreshAll(); } catch { vscode.window.showWarningMessage('保存成功，但重新加载封包失败'); } }
        else { vscode.window.showErrorMessage('保存失败'); }
      });
    }),
    vscode.commands.registerCommand('pvf.exportFile', async (node) => { if (!node || !node.isFile) return; const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(node.name) }); if (!dest) return; await model.exportFile(node.key, dest.fsPath); vscode.window.showInformationMessage('导出完成'); }),
    vscode.commands.registerCommand('pvf.replaceFile', async (node) => { if (!node || !node.isFile) return; const src = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false }); if (!src || src.length === 0) return; const res = await model.replaceFile(node.key, src[0].fsPath); if (!res.success) { vscode.window.showErrorMessage('替换失败'); } tree.refresh(); deco.refreshUris([vscode.Uri.parse(`pvf:/${node.key}`)]); }),
    vscode.commands.registerCommand('pvf.deleteFile', async (node) => { if (!node || !node.isFile) return; model.deleteFile(node.key); tree.refresh(); deco.refreshAll(); }),
    vscode.commands.registerCommand('pvf.createFolder', async (node) => { const base = node && !node.isFile ? node.key : ''; const name = await vscode.window.showInputBox({ prompt: '输入新文件夹名称', placeHolder: '例如: new_folder' }); if (!name) return; model.createFolder(base ? `${base}/${name}` : name); tree.refresh(); deco.refreshAll(); }),
    vscode.commands.registerCommand('pvf.deleteFolder', async (node) => { if (!node || node.isFile) return; const ok = await vscode.window.showWarningMessage(`确定删除文件夹 ${node.name} 及其所有子项吗？`, { modal: true }, '删除'); if (ok !== '删除') return; model.deleteFolder(node.key); tree.refresh(); deco.refreshAll(); }),
    vscode.commands.registerCommand('pvf.createFile', async (node) => { const base = node && !node.isFile ? node.key : ''; const name = await vscode.window.showInputBox({ prompt: '输入新文件名（含扩展名）', placeHolder: '例如: readme.txt' }); if (!name) return; const key = base ? `${base}/${name}` : name; model.createEmptyFile(key); tree.refresh(); deco.refreshUris([vscode.Uri.parse(`pvf:/${key}`)]); }),
    // ===== 解封 / 封装 =====
    vscode.commands.registerCommand('pvf.unpackPack', async () => {
      if (!model.pvfPath) { vscode.window.showWarningMessage('请先打开一个 PVF 文件'); return; }
      const dirs = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '选择解封目标目录' });
      if (!dirs || dirs.length === 0) return;
      const destDir = dirs[0].fsPath;
      const total = model.getAllKeys().length;
      const t0 = Date.now();
      const cfg = vscode.workspace.getConfiguration();
      const writeConcurrency = cfg.get<number>('pvf.unpack.writeConcurrency', 512);
      const workerCount = cfg.get<number>('pvf.unpack.workerCount', 12);
      const writeBatchSize = cfg.get<number>('pvf.unpack.writeBatchSize', 64);
      const chineseConversion = normalizeChineseConversion(cfg.get<string>('pvf.unpack.chineseConversion', 'tw2cn'));
      const mkdirConcurrency = cfg.get<number>('pvf.unpack.mkdirConcurrency', 128);
      let phaseStats: PvfArchivePhaseStats | undefined;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在解封 PVF…' }, async (p) => {
        let lastReport = 0;
        await model.unpackTo(destDir, (current, _total, key) => {
          const pct = Math.floor((current / _total) * 100);
          if (pct !== lastReport) { const inc = pct - lastReport; lastReport = pct; p.report({ increment: inc, message: `(${current}/${_total}) ${key.split('/').pop()}` }); }
        }, { writeConcurrency, workerCount, writeBatchSize, chineseConversion, mkdirConcurrency, onStats: stats => { phaseStats = stats; } });
      });
      const seconds = Math.max(0.001, (Date.now() - t0) / 1000);
      const rate = Math.round(total / seconds);
      output.appendLine(`[PVF] unpack done: ${total} files in ${seconds.toFixed(1)}s (${rate}/s) -> ${destDir}`);
      if (phaseStats) output.appendLine(formatArchiveStats('unpack phases', phaseStats, { writeConcurrency, workerCount, writeBatchSize, mkdirConcurrency }));
      output.appendLine(`[PVF] unpack chineseConversion=${chineseConversion}`);
      vscode.window.showInformationMessage(`解封完成：${total} 个文件，${rate} 文件/秒 → ${destDir}`);
    }),
    vscode.commands.registerCommand('pvf.repackPack', async () => {
      const dirs = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '选择要封装的目录' });
      if (!dirs || dirs.length === 0) return;
      const srcDir = dirs[0].fsPath;
      const dest = await vscode.window.showSaveDialog({ filters: { 'PVF': ['pvf'] }, defaultUri: vscode.Uri.file(srcDir + '.pvf') });
      if (!dest) return;
      const t0 = Date.now();
      let finalTotal = 0;
      const cfg = vscode.workspace.getConfiguration();
      const readConcurrency = cfg.get<number>('pvf.repack.readConcurrency', 192);
      let phaseStats: PvfArchivePhaseStats | undefined;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在封装 PVF…' }, async (p) => {
        let lastReport = 0;
        await repackDirectory(srcDir, dest.fsPath, (current, total, _key) => {
          finalTotal = total;
          const pct = Math.floor((current / total) * 100);
          if (pct !== lastReport) { const inc = pct - lastReport; lastReport = pct; p.report({ increment: inc, message: `${current}/${total}` }); }
        }, { readConcurrency, onStats: stats => { phaseStats = stats; } });
      });
      const seconds = Math.max(0.001, (Date.now() - t0) / 1000);
      const rate = finalTotal > 0 ? Math.round(finalTotal / seconds) : 0;
      output.appendLine(`[PVF] repack done: ${finalTotal} files in ${seconds.toFixed(1)}s (${rate}/s) -> ${dest.fsPath}`);
      if (phaseStats) output.appendLine(formatArchiveStats('repack phases', phaseStats, { readConcurrency }));
      vscode.window.showInformationMessage(`封装完成：${finalTotal} 个文件，${rate} 文件/秒 → ${dest.fsPath}`);
    }),
  );
}
