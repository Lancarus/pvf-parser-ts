import * as vscode from 'vscode';
import { Box3D, FrameSeqEntry } from './types';

export interface ParseResult {
  framesSeq: FrameSeqEntry[];
  groups: Map<string, { img: string; frames: FrameSeqEntry[] }>;
}

export function parseAniText(text: string, options: { silent?: boolean } = {}): ParseResult {
  const groups = new Map<string, { img: string; frames: FrameSeqEntry[] }>();
  const framesSeq: FrameSeqEntry[] = [];
  let lastImagePath = '';
  const blockRegex = /\[FRAME(\d{3})\]([\s\S]*?)(?=\n\[FRAME|$)/gi; let bm: RegExpExecArray | null;
  while ((bm = blockRegex.exec(text)) !== null) {
    const block = bm[2] || '';
    // [IMAGE]
    let img = '';
    let idx = 0;
    const imgHeader = /\[IMAGE\]/i.exec(block);
    if (imgHeader) {
      const imageLines = readTagValueLines(block, imgHeader.index + imgHeader[0].length);
      const parsedImage = parseImageValueLines(imageLines, lastImagePath);
      img = parsedImage.img;
      idx = parsedImage.idx;
      if (parsedImage.lastImagePath) lastImagePath = parsedImage.lastImagePath;
    }
    const delayM = /\[DELAY\]\s*\r?\n\s*(\d+)/i.exec(block); const delay = delayM ? parseInt(delayM[1], 10) : 50;
    const posM = /\[IMAGE POS\]\s*\r?\n\s*(-?\d+)\s+(-?\d+)/i.exec(block); const pos = posM ? { x: parseInt(posM[1], 10), y: parseInt(posM[2], 10) } : undefined;
    const geM = /\[GRAPHIC\s+EFFECT\]\s*\r?\n\s*([^\r\n]+)/i.exec(block);
    const rateM = /\[IMAGE\s+RATE\]\s*\r?\n\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/i.exec(block);
    const rotM = /\[IMAGE\s+ROTATE\]\s*\r?\n\s*(-?\d+(?:\.\d+)?)/i.exec(block);
    const rgbaM = /\[RGBA\]\s*\r?\n\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i.exec(block);
    // boxes
    const atkBoxes: Box3D[] = [];
    const dmgBoxes: Box3D[] = [];
    const boxScan = (re: RegExp, into: Box3D[]) => {
      let m: RegExpExecArray | null;
      const rex = new RegExp(re.source, re.flags + (re.flags.includes('g') ? '' : 'g'));
      while ((m = rex.exec(block)) !== null) {
        const x = parseInt(m[1], 10) | 0;
        const y = parseInt(m[2], 10) | 0;
        const z = parseInt(m[3], 10) | 0;
        const w = parseInt(m[4], 10) | 0;
        const h = parseInt(m[5], 10) | 0;
        const d = parseInt(m[6], 10) | 0;
        into.push({ x, y, z, w, h, d });
      }
    };
    boxScan(/\[ATTACK\s+BOX\][^\r\n]*\r?\n\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/i, atkBoxes);
    boxScan(/\[DAMAGE\s+BOX\][^\r\n]*\r?\n\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/i, dmgBoxes);
    let gfx: string | undefined = undefined;
    if (geM) { let g = String(geM[1]).trim(); if (/^["'`].*["'`]$/.test(g)) g = g.slice(1, -1); gfx = g.toUpperCase(); }
    let scale: { x: number, y: number } | undefined = undefined;
    if (rateM) { const x = parseFloat(rateM[1]); const y = parseFloat(rateM[2]); if (isFinite(x) && isFinite(y)) scale = { x, y }; }
    const rotate = rotM ? (parseFloat(rotM[1]) || 0) : undefined;
    let tint: [number, number, number, number] | undefined = undefined;
    if (rgbaM) {
      const r = Math.max(0, Math.min(255, parseInt(rgbaM[1], 10) || 0));
      const g = Math.max(0, Math.min(255, parseInt(rgbaM[2], 10) || 0));
      const b = Math.max(0, Math.min(255, parseInt(rgbaM[3], 10) || 0));
      const a = Math.max(0, Math.min(255, parseInt(rgbaM[4], 10) || 0));
      tint = [r, g, b, a];
    }
    if (!groups.has(img)) groups.set(img, { img, frames: [] });
    const frame = { img, idx, delay, pos, gfx, scale, rotate, tint, atk: atkBoxes, dmg: dmgBoxes };
    groups.get(img)!.frames.push(frame);
    framesSeq.push(frame);
  }
  if (groups.size === 0 && !options.silent) { vscode.window.showWarningMessage('未解析到任何帧，请检查 ANI 格式或文件内容'); }
  return { framesSeq, groups };
}

function readTagValueLines(block: string, valueStart: number): string[] {
  const afterTag = block.slice(valueStart);
  const lines = afterTag.split(/\r?\n/);
  const values: string[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (values.length === 0) continue;
      values.push('');
      continue;
    }
    if (/^\[[^\]]+\]/.test(trimmed)) break;
    values.push(trimmed);
  }
  return values.filter(line => line.trim().length > 0);
}

function cleanQuotedValue(value: string): string {
  const text = (value || '').trim();
  if ((text.startsWith('`') && text.endsWith('`')) || (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function parseImageValueLines(lines: string[], lastImagePath: string): { img: string; idx: number; lastImagePath: string } {
  const firstLine = (lines[0] || '').trim();
  const secondLine = (lines[1] || '').trim();
  const firstAsIndex = parseStrictInt(firstLine);
  if (isExplicitEmptyImage(firstLine)) {
    const inlineIndex = parseTrailingInt(firstLine);
    const nextIndex = parseStrictInt(secondLine);
    return { img: '', idx: inlineIndex ?? nextIndex ?? 0, lastImagePath };
  }
  if (typeof firstAsIndex === 'number') {
    return { img: lastImagePath, idx: firstAsIndex, lastImagePath };
  }

  const inline = parseImagePathAndIndex(firstLine);
  if (inline.path) {
    const fallbackIndex = parseStrictInt(secondLine);
    return {
      img: inline.path,
      idx: inline.idx ?? fallbackIndex ?? 0,
      lastImagePath: inline.path,
    };
  }

  const img = cleanQuotedValue(firstLine);
  const parsed = parseStrictInt(secondLine);
  return {
    img,
    idx: parsed ?? 0,
    lastImagePath: img || lastImagePath,
  };
}

function parseImagePathAndIndex(value: string): { path: string; idx?: number } {
  const text = (value || '').trim();
  const quoted = text.match(/^[`'"]([^`'"]+)[`'"]\s*(.*)$/);
  if (quoted) {
    return { path: quoted[1].trim(), idx: parseLeadingInt(quoted[2]) };
  }
  const bare = text.match(/^([^\s]+\.img)\s*(.*)$/i);
  if (bare) {
    return { path: bare[1].trim(), idx: parseLeadingInt(bare[2]) };
  }
  return { path: '' };
}

function isExplicitEmptyImage(value: string): boolean {
  const text = (value || '').trim();
  return /^(``|""|'')(?:\s+-?\d+)?$/.test(text);
}

function parseStrictInt(value: string): number | undefined {
  const text = (value || '').trim();
  if (!/^-?\d+$/.test(text)) return undefined;
  const parsed = parseInt(text, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseLeadingInt(value: string | undefined): number | undefined {
  const match = (value || '').trim().match(/^-?\d+/);
  return match ? parseStrictInt(match[0]) : undefined;
}

function parseTrailingInt(value: string): number | undefined {
  const match = (value || '').trim().match(/(?:^|\s)(-?\d+)\s*$/);
  return match ? parseStrictInt(match[1]) : undefined;
}
