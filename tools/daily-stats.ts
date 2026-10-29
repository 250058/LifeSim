// 하루 사슬(F-001 세탁 지연) 측정: npx tsx tools/daily-stats.ts [--n 600] [--seed DAILY] [--mode reality]
//
// 시뮬레이터 보고서에는 사건 횟수만 있다. 이 도구는 같은 봇(sim.ts simulateLife)으로 인생을 돌려
// 사슬의 결과·다음 날 일정(일터)·의무 정리 상태·인생당 사슬 수를 센다. 같은 시드면 같은 숫자다.
// 맨 앞에는 '쓴 규칙', '의미가 다른 상황', '생성된 ID'를 따로 적는다 (검토 지시: 셋을 섞어 세지 않는다).

import dailyJson from '../data/events/daily.json';
import { DAILY_LINES, readDaily, WEATHERS } from '../src/engine/daily';
import { simulateLife } from '../src/engine/sim';
import type { Mode } from '../src/engine/types';

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const N = Number(arg('n', '600'));
const SEED = arg('seed', 'DAILY');
const MODE = arg('mode', 'reality') as Mode;

function bump(m: Record<string, number>, k: string, by = 1): void {
  m[k] = (m[k] ?? 0) + by;
}

function table(title: string, m: Record<string, number>): void {
  const total = Object.values(m).reduce((a, b) => a + b, 0);
  console.log(`\n${title} (합계 ${total})`);
  for (const [k, v] of Object.entries(m).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(22)} ${String(v).padStart(6)}  ${((100 * v) / Math.max(1, total)).toFixed(1)}%`);
  }
}

// ── 쓴 규칙 · 의미가 다른 상황 (데이터에서 센다) ──

const L = DAILY_LINES;
const events = (dailyJson as unknown as { events: { id: string; choices?: unknown[] }[] }).events;
const choices = events.reduce((a, e) => a + (e.choices?.length ?? 0), 0);
console.log('# 하루 사슬 측정');
console.log(`쓴 규칙: 사건 ${events.length}개(선택지 ${choices}개), 문장 ${Object.keys(L.say).length}줄,`);
console.log(`  일정 문장 ${Object.keys(L.schedule).length}개 · 조정 문장 ${Object.keys(L.adjust).length}개 · 옷 목록 ${Object.keys(L.items).length}개 · 날씨 ${WEATHERS.length}개 · 건조기 사정 ${L.dryer.length}개`);
const itemCount = Object.values(L.items).reduce((a, l) => a + l.length, 0);
console.log(`의미가 다른 상황: 일정 ${Object.keys(L.schedule).length}가지 × 옷(일정마다 2~3벌, 모두 ${itemCount}벌) × 날씨 ${WEATHERS.length}가지`);

// ── 인생을 돌려 센다 ──

const outcome: Record<string, number> = {};
const schedule: Record<string, number> = {};
const obligation: Record<string, number> = {};
const memory: Record<string, number> = {};
const perLife: Record<string, number> = {};
let chains = 0;
let chainIds = 0;
let obIds = 0;
let livesWith = 0;
let maxPer = 0;
let steps = 0;
let late = 0;
let spent = 0;

for (let i = 0; i < N; i++) {
  const s = simulateLife(`${SEED}-${i}`, { mode: MODE });
  const d = readDaily(s.ch);
  const h = d.history;
  chains += h.length;
  if (h.length > 0) livesWith++;
  maxPer = Math.max(maxPer, h.length);
  bump(perLife, String(Math.min(h.length, 6)) + (h.length >= 6 ? '+' : ''));
  for (const r of h) {
    bump(outcome, r.outcome);
    bump(schedule, r.schedule === 'office' ? `office:${r.work ?? 'office'}` : r.schedule === 'outing' ? `outing:${r.outing ?? '?'}` : r.schedule);
    steps += r.steps.length - 1;
    late += r.late > 0 ? 1 : 0;
    spent += r.spent;
  }
  for (const o of d.obligations) bump(obligation, o.status);
  for (const m of d.memory) bump(memory, m.kind);
  // 생성된 ID: 사슬은 d1·d2…, 의무는 o3… (한 순번을 함께 쓴다)
  const all = [...h.map((r) => r.id), ...d.obligations.map((o) => o.id)];
  chainIds += all.filter((x) => x.startsWith('d')).length;
  obIds += all.filter((x) => x.startsWith('o')).length;
}

console.log(`\n인생 ${N}개 (${MODE}, 시드 ${SEED}): 사슬이 한 번이라도 있었던 인생 ${livesWith}개 (${((100 * livesWith) / N).toFixed(1)}%)`);
console.log(`사슬 ${chains}개, 인생당 평균 ${(chains / N).toFixed(2)}개 · 최대 ${maxPer}개 · 사슬당 고른 횟수 ${(steps / Math.max(1, chains)).toFixed(2)}`);
console.log(`지각이 남은 사슬 ${late}개 · 사슬에서 쓴 돈 평균 ${Math.round(spent / Math.max(1, chains)).toLocaleString('ko-KR')}원`);
console.log(`생성된 ID: 사슬 ${chainIds}개 · 의무 ${obIds}개 (기록 상한 안의 것만: 사슬 40, 닫힌 의무 20)`);
table('인생당 사슬 수', perLife);
table('결과', outcome);
table('다음 날 일정 (출근은 일터별)', schedule);
table('의무 상태', obligation);
table('인물 기억', memory);
