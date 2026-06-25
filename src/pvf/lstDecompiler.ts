// Decompile .lst script-like binary into two-line-per-entry text similar to user expectation.
import { PvfFile } from './pvfFile';
import { PvfModel } from './model';

/**
 * Produce text of form:
 * #PVF_File\n<code>\t`relative/path/file`\n...
 * (No blank line after header, one line per entry)
 * nkpiFormat + nkpiResolve: NKPI 格式使用名称表解析路径（resolveString），而非 classic stringtable
 */
export function decompileLst(
  model: PvfModel,
  f: PvfFile,
  originalKey: string,
  nkpiFormat = false,
  nkpiResolve?: (offset: number) => string,
): string | null {
  if (!f.isScriptFile && !nkpiFormat) return null;
  const data = f.data; if (!data) return null;
  const len = f.dataLen; if (len < 12) return null;
  const idx = originalKey.lastIndexOf('/');
  const basePath = idx >= 0 ? originalKey.substring(0, idx + 1) : '';
  const lines: string[] = ['#PVF_File'];
  const startOff = nkpiFormat ? 0 : 2;
  const codeType = nkpiFormat ? 0 : 2;
  const pathType = nkpiFormat ? 6 : 7;
  for (let i = startOff; i + 10 <= len; i += 10) {
    const codeFlag = data[i];
    const pathFlag = data[i + 5];
    if (codeFlag !== codeType || pathFlag !== pathType) continue;
    const code = (data[i + 1]) | (data[i + 2] << 8) | (data[i + 3] << 16) | (data[i + 4] << 24);
    const nameIdx = (data[i + 6]) | (data[i + 7] << 8) | (data[i + 8] << 16) | (data[i + 9] << 24);
    if (code < 0 || nameIdx < 0) continue;
    const name = nkpiResolve ? nkpiResolve(nameIdx) : model.getStringFromTable(nameIdx);
    if (!name) continue;
    const filePath = name.replace(/\\/g, '/');
    lines.push(code + '\t`' + filePath + '`');
  }
  if (lines.length === 1) return null;
  return lines.join('\n') + '\n';
}

export function compileLstText(model: PvfModel, text: string, originalKey: string): Buffer | null {
  try {
    let src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);

    const st = (model as any)['strtable'];
    if (!st) return null;

    const idx = originalKey.lastIndexOf('/');
    const basePath = idx >= 0 ? originalKey.substring(0, idx + 1) : '';
    const out: number[] = [0xB0, 0xD0];
    const pushEntry = (flag: number, value: number) => {
      out.push(flag & 0xFF);
      out.push(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF);
    };
    const getIdx = (s: string) => st.getIndex(s) >= 0 ? st.getIndex(s) : st.add(s);

    for (const rawLine of src.split('\n')) {
      const raw = rawLine.trim();
      if (!raw || raw.startsWith('#')) continue;

      const tab = raw.indexOf('\t');
      if (tab < 0) continue;
      const code = parseInt(raw.slice(0, tab).trim(), 10);
      if (!Number.isFinite(code)) continue;

      let name = raw.slice(tab + 1).trim();
      if (name.startsWith('`') && name.endsWith('`')) name = name.slice(1, -1);
      name = name.replace(/\\/g, '/');
      const lowerName = name.toLowerCase();
      if (basePath && lowerName.startsWith(basePath)) {
        name = name.slice(basePath.length);
      }
      if (!name) continue;

      pushEntry(2, code | 0);
      pushEntry(7, getIdx(name) >>> 0);
    }

    return Buffer.from(out);
  } catch {
    return null;
  }
}
