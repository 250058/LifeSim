// 데이터 JSON 정리 (node tools/event-editor/format.mjs)
// 짧은 객체·배열은 한 줄로, 긴 것은 두 칸 들여쓰기. 사람이 읽고 고치기 쉬운 모양을 유지한다.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX = 110;

function flat(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(flat).join(', ')}]`;
  const entries = Object.entries(v);
  if (entries.length === 0) return '{}';
  return `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${flat(x)}`).join(', ')} }`;
}

function fmt(v, indent = '', prefix = 0) {
  const one = flat(v);
  if (v === null || typeof v !== 'object' || indent.length + prefix + one.length <= MAX) return one;
  const inner = indent + '  ';
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + fmt(x, inner)).join(',\n')}\n${indent}]`;
  const lines = Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${fmt(x, inner, JSON.stringify(k).length + 2)}`);
  return `{\n${lines.join(',\n')}\n${indent}}`;
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.json')) writeFileSync(path, fmt(JSON.parse(readFileSync(path, 'utf8'))) + '\n');
  }
}

walk(new URL('../../data', import.meta.url).pathname);
