// 직업 보정 보고: 밸런스 시뮬레이터와 같은 봇(src/engine/sim.ts)으로 인생을 돌려 소득 원장(career.work.ledger)을 요약한다.
//   npx tsx data/jobs/calibrate.ts --n 1200 --seed CHECK
// 결과는 docs/review/JOBS.md의 '보정' 절에 옮긴다. 금액은 모두 2026년 원이다 (원장은 물가지수를 나눠 적는다).
// 사람-해(person-year) 단위로 센다: 그 나이를 살아 있던 해 하나가 1이다. 봇은 무직이면 공고 두 곳에 지원하고
// 자격 공부·직업훈련·부업은 하지 않으므로, 그쪽 경로의 비중은 사건으로 생긴 것만 잡힌다 (봇 정책의 한계).

import { simulateLife } from '../../src/engine/sim';
import { JOB_BY_ID } from '../../src/engine/data';
import { FIELD_BY_ID, ledgerOf, TYPE_LABEL } from '../../src/engine/work';
import type { EmploymentType, GameState, WorkYear } from '../../src/engine/types';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const N = Number(arg('n', '1200'));
const PREFIX = arg('seed', 'CHECK');

const lives: GameState[] = [];
for (let i = 0; i < N; i++) {
  const s = simulateLife(`${PREFIX}-${i}`, { mode: 'reality' });
  s.log = [];
  lives.push(s);
}

const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  const i = (a.length - 1) * q;
  const lo = Math.floor(i);
  return a[lo] + (a[Math.min(a.length - 1, lo + 1)] - a[lo]) * (i - lo);
};
const man = (won: number) => (Number.isFinite(won) ? `${Math.round(won / 10_000).toLocaleString('ko-KR')}만` : '—');
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// ── 연령대별 ──────────────────────────────────────────────
const BANDS: [string, number, number][] = [
  ['15~19세', 15, 19],
  ['20~29세', 20, 29],
  ['30~39세', 30, 39],
  ['40~49세', 40, 49],
  ['50~59세', 50, 59],
  ['60~64세', 60, 64],
  ['65~74세', 65, 74],
];

/** 나이별 원장 (한 나이에 한 줄) */
function byAge(s: GameState): Map<number, WorkYear> {
  return new Map(ledgerOf(s.ch).map((y) => [y.age, y]));
}

const mean = lives.reduce((a, s) => a + s.ch.age, 0) / lives.length;
console.log(`표본 ${lives.length}명 (시드 ${PREFIX}-0…${lives.length - 1}, 현실 모드), 평균 사망 나이 ${mean.toFixed(2)}세`);
console.log('');
console.log('| 나이 | 살아 있던 사람-해 | 본업이 있던 비율 | 본업 세전 소득 중앙값 | 하위 25% | 상위 25% | 부업·급여 포함 중앙값 |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const [label, lo, hi] of BANDS) {
  let alive = 0;
  const gross: number[] = [];
  const total: number[] = [];
  for (const s of lives) {
    const rows = byAge(s);
    for (let a = lo; a <= hi; a++) {
      if (s.ch.age <= a) break; // 그 나이를 끝까지 살지 못했다
      alive++;
      const y = rows.get(a);
      if (y?.jobId) gross.push(y.gross);
      if (y) total.push(y.gross + (y.side ?? 0) + (y.benefit ?? 0));
    }
  }
  console.log(
    `| ${label} | ${alive.toLocaleString('ko-KR')} | ${pct(gross.length / Math.max(1, alive))} | ${man(quantile(gross, 0.5))} | ${man(quantile(gross, 0.25))} | ${man(quantile(gross, 0.75))} | ${man(quantile(total, 0.5))} |`,
  );
}

// ── 고용 형태·분야 ────────────────────────────────────────
const typeYears = new Map<EmploymentType, number>();
const fieldYears = new Map<string, number>();
let employedYears = 0;
for (const s of lives) {
  for (const y of ledgerOf(s.ch)) {
    if (!y.jobId || y.age < 15 || y.age > 64) continue;
    employedYears++;
    const t = y.type ?? 'regular';
    typeYears.set(t, (typeYears.get(t) ?? 0) + 1);
    const f = JOB_BY_ID.get(y.jobId)?.field ?? 'none';
    fieldYears.set(f, (fieldYears.get(f) ?? 0) + 1);
  }
}
console.log('');
console.log(`고용 형태 (15~64세 본업이 있던 사람-해 ${employedYears.toLocaleString('ko-KR')}):`);
console.log('');
console.log('| 고용 형태 | 사람-해 | 비율 |');
console.log('| --- | ---: | ---: |');
for (const [t, n] of [...typeYears].sort((a, b) => b[1] - a[1])) console.log(`| ${TYPE_LABEL[t]} | ${n.toLocaleString('ko-KR')} | ${pct(n / employedYears)} |`);
console.log('');
console.log('| 분야 | 비율 |');
console.log('| --- | ---: |');
for (const [f, n] of [...fieldYears].sort((a, b) => b[1] - a[1])) console.log(`| ${FIELD_BY_ID.get(f)?.label ?? f} | ${pct(n / employedYears)} |`);

// ── 경로 도달 ─────────────────────────────────────────────
const held = new Set<string>();
const exits = new Map<string, number>();
let benefitLives = 0;
let licensed = 0;
let sideYears = 0;
let injured = 0;
let arrears = 0;
let returned = 0;
let changed = 0;
for (const s of lives) {
  const hist = s.ch.career.history;
  for (const h of hist) held.add(h.jobId);
  const w = s.ch.career.work;
  if (ledgerOf(s.ch).some((y) => (y.benefit ?? 0) > 0)) benefitLives++;
  if (Object.values(w?.licenses ?? {}).some((r) => r.passed !== undefined)) licensed++;
  sideYears += ledgerOf(s.ch).filter((y) => y.side).length;
  if (s.counts.work_injury) injured++;
  if (s.counts.work_wage_arrears) arrears++;
  if (w?.exit) exits.set(w.exit.reason, (exits.get(w.exit.reason) ?? 0) + 1);
  // 같은 직업으로 돌아간 적 / 다른 직업으로 옮긴 적
  for (let i = 1; i < hist.length; i++) {
    if (hist.slice(0, i).some((h) => h.jobId === hist[i].jobId)) returned++;
    else changed++;
  }
}
console.log('');
console.log(`한 번이라도 가져 본 직업 정의: ${held.size}개 / 정의 ${JOB_BY_ID.size}개`);
console.log(`구직급여를 받은 인생 ${pct(benefitLives / lives.length)}, 면허·자격을 딴 인생 ${pct(licensed / lives.length)}, 부업 사람-해 ${sideYears}`);
console.log(`업무상 사고 카드를 본 인생 ${pct(injured / lives.length)}, 임금 체불 카드를 본 인생 ${pct(arrears / lives.length)}`);
console.log(`같은 직업으로 복귀한 이력 ${returned}건, 다른 직업으로 옮긴 이력 ${changed}건`);
console.log(`마지막 이직 사유: ${[...exits].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ')}`);
