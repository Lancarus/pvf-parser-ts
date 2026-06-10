import { createRequire } from 'module';

export type PvfChineseConversion = 'off' | 'tw2cn';

const requireOpencc = createRequire(__filename);
const opencc = requireOpencc('opencc-js') as {
  Converter: (options: { from: string; to: string }) => (text: string) => string;
};

const twToCn = opencc.Converter({ from: 'tw', to: 'cn' });
const cnToTw = opencc.Converter({ from: 'cn', to: 'tw' });

export function normalizeChineseConversion(value: unknown): PvfChineseConversion {
  return String(value ?? 'tw2cn').toLowerCase() === 'off' ? 'off' : 'tw2cn';
}

export function convertTextForUnpack(text: string, mode: PvfChineseConversion): string {
  return mode === 'tw2cn' ? twToCn(text) : text;
}

export function convertTextForRepack(text: string, mode: PvfChineseConversion): string {
  return mode === 'tw2cn' ? cnToTw(text) : text;
}
