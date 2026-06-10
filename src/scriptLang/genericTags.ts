import * as vscode from 'vscode';
import { provideSharedTagFeatures } from './tagRegistry';

export const SCRIPT_TAG_SHORTS = [
  'act', 'ai', 'aic', 'ani', 'atk', 'blu', 'bm', 'chr', 'co', 'cre',
  'dgn', 'equ', 'etc', 'evt', 'exj', 'key', 'lay', 'map', 'mm', 'mob',
  'npc', 'nut', 'obj', 'pos', 'ptl', 'qst', 'rgn', 'sd', 'shp', 'skl',
  'stk', 'stm', 'tbl', 'twn', 'ui', 'wdm'
] as const;

export const GENERIC_SCRIPT_TAG_SHORTS = [
  'atk', 'blu', 'bm', 'chr', 'co', 'cre', 'dgn', 'etc', 'evt', 'exj',
  'lay', 'map', 'mm', 'mob', 'npc', 'nut', 'obj', 'pos', 'ptl', 'qst',
  'rgn', 'sd', 'shp', 'stk', 'stm', 'tbl', 'twn', 'ui', 'wdm'
] as const;

export type ScriptTagShort = typeof SCRIPT_TAG_SHORTS[number];

export function scriptTagLanguageId(short: string): string {
  return `pvf-${short}`;
}

export const SHORT_BY_LANGUAGE_ID: Record<string, string> = Object.fromEntries(
  SCRIPT_TAG_SHORTS.map(short => [scriptTagLanguageId(short), short])
);

export function scriptTagLanguageIdForPath(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ani.als') || lower.endsWith('.als')) return 'pvf-ani';
  const short = SCRIPT_TAG_SHORTS.find(item => lower.endsWith(`.${item}`));
  return short ? scriptTagLanguageId(short) : undefined;
}

export function registerGenericScriptTagLanguages(context: vscode.ExtensionContext) {
  for (const short of GENERIC_SCRIPT_TAG_SHORTS) {
    provideSharedTagFeatures(context, scriptTagLanguageId(short), short);
  }
}
