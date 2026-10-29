// 빌드 결과를 HTML 파일 하나로 합친다 (npm run build:artifact).
// claude.ai 아티팩트는 외부 스크립트를 정해진 CDN에서만 받으므로 우리 JS·CSS를 페이지 안에 넣는다.
// 문서 뼈대(doctype·html·head·body, charset·viewport)는 게시할 때 붙으므로 뺀다.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist-artifact';
const out = process.argv[3] ?? join(dir, 'lifesim.html');
let html = readFileSync(join(dir, 'index.html'), 'utf8');

html = html.replace(/<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/g, (_, src) => {
  const code = readFileSync(join(dir, src), 'utf8');
  if (code.includes('<!--')) throw new Error(`${src}에 '<!--'가 있어 인라인하면 HTML 파서가 헷갈린다`);
  return `<script type="module">${code.replace(/<\/script/gi, '<\\/script')}</script>`;
});
html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/g, (_, href) => {
  const css = readFileSync(join(dir, href), 'utf8');
  return `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
});

html = html
  .replace(/<!doctype html>/i, '')
  .replace(/<\/?html[^>]*>/gi, '')
  .replace(/<\/?head>/gi, '')
  .replace(/<\/?body>/gi, '')
  .replace(/<meta charset="[^"]*"\s*\/?>/i, '')
  .replace(/<meta name="viewport"[^>]*>/i, '')
  .replace(/\n\s*\n/g, '\n')
  .trim();

// 제목은 앞 8KB 안에 있어야 한다
const titleAt = html.indexOf('<title>');
if (titleAt < 0 || titleAt > 8000) throw new Error('<title>이 맨 앞에 없다');

writeFileSync(out, html + '\n');
console.log(`${out} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
