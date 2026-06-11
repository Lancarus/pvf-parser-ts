import { PvfWebApiNode } from './types';

const DATA_TYPE_NUMBER = 2;
const DATA_TYPE_SECTION = 5;
const DATA_TYPE_STRING = 7;

function tokenDataType(value: string): number {
  return /^[-+]?\d+(?:\.\d+)?$/.test(value.trim()) ? DATA_TYPE_NUMBER : DATA_TYPE_STRING;
}

function makeValueNode(value: string): PvfWebApiNode {
  return {
    SectionName: null,
    IsSection: false,
    HasEndSection: false,
    DataType: tokenDataType(value),
    Value: value,
    Children: [],
  };
}

function tokenizeValueLine(line: string): string[] {
  const tokens: string[] = [];
  const re = /`[^`]*`|"[^"]*"|'[^']*'|\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    tokens.push(match[0]);
  }
  return tokens;
}

function stripInlineComment(line: string): string {
  let inBacktick = false;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!quote && ch === '`') {
      inBacktick = !inBacktick;
      continue;
    }
    if (!inBacktick && (ch === '"' || ch === "'")) {
      quote = quote === ch ? undefined : (quote || ch);
      continue;
    }
    if (!inBacktick && !quote && ch === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

function findClosableSections(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine).trim();
    const match = line.match(/^\[\/([^\]]+)\]/);
    if (match) out.add(match[1].trim().toLowerCase());
  }
  return out;
}

export function parsePvfWebApiFileData(text: string): PvfWebApiNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const closable = findClosableSections(lines);
  const root: PvfWebApiNode[] = [];
  const stack: Array<{ name: string; node: PvfWebApiNode }> = [];
  let lastLeafSection: PvfWebApiNode | undefined;

  const currentChildren = () => stack.length ? stack[stack.length - 1].node.Children : root;

  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine).trim();
    if (!line || line.startsWith('#')) continue;

    const tag = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (tag) {
      const rawName = tag[1].trim();
      const lower = rawName.toLowerCase();
      if (lower.startsWith('/')) {
        const closeName = lower.slice(1).trim();
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === closeName) {
            stack.splice(i);
            break;
          }
        }
        lastLeafSection = undefined;
        continue;
      }

      const node: PvfWebApiNode = {
        SectionName: `[${rawName}]`,
        IsSection: true,
        HasEndSection: closable.has(lower),
        DataType: DATA_TYPE_SECTION,
        Value: null,
        Children: [],
      };
      currentChildren().push(node);
      lastLeafSection = node;

      const inline = tag[2]?.trim();
      if (inline) {
        for (const token of tokenizeValueLine(inline)) node.Children.push(makeValueNode(token));
      }
      if (node.HasEndSection) {
        stack.push({ name: lower, node });
        lastLeafSection = undefined;
      }
      continue;
    }

    const target = lastLeafSection || (stack.length ? stack[stack.length - 1].node : undefined);
    const values = tokenizeValueLine(line).map(makeValueNode);
    if (target) target.Children.push(...values);
    else root.push(...values);
  }

  return root;
}

export function parsePvfWebApiRootSections(text: string): PvfWebApiNode[] {
  return parsePvfWebApiFileData(text).filter(node => node.IsSection);
}

