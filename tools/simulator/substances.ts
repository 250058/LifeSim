// 술·담배·약물 유병률 보고: npx tsx tools/simulator/substances.ts [--n 300] [--seed SUBST]
//
// 밸런스 시뮬레이터(run.ts)와 같은 봇(src/engine/sim.ts)으로 인생을 살리고, 25·40·60세가 되는 해의 첫날
// (그해 봇이 고르기 전) 상태를 성별로 센다. 실제 통계와 견주는 참고 보고서다: 봇은 술·담배 취향 없이 활동을
// 무작위로 고르므로 습관 비율은 실제보다 낮게 나온다 (2026-10-29 시드 SUBST 300명: 25·40·60세 습관 0%,
// 실제 현재 흡연 남 약 30%·여 약 6%). 봇에 취향을 주면 흡연·과음의 건강 영향으로 수명 보정이 다시 필요하다.
// 판정하는 것은 하나뿐이다:
// 미성년자의 사용 이력 (R-009). 한 명이라도 있으면 종료 코드 1, 없으면 0.
//
// 참고값은 국민건강영양조사 2022의 대략값이다 (만 19세 이상, 성별). 게임의 '습관'·태그와 조사의 정의
// (현재 흡연: 평생 5갑 이상·현재 피움 / 고위험 음주: 주 2회 이상 한 번에 남 7잔·여 5잔 이상)는 같지 않다.

import { simulateLife } from '../../src/engine/sim';
import { readRecord } from '../../src/engine/substances';
import type { GameState, Sex, SubstanceId } from '../../src/engine/types';
import { SUBSTANCE_IDS } from '../../src/engine/types';
import { proportion } from './metrics';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const N = Number(arg('n', '300'));
const PREFIX = arg('seed', 'SUBST');
if (!Number.isInteger(N) || N < 1) {
  console.error(`--n은 1 이상의 정수여야 한다: ${arg('n', '')}`);
  process.exit(2);
}

const AGES = [25, 40, 60];
const LABEL: Record<SubstanceId, string> = { alcohol: '술', tobacco: '담배', drug: '약물' };
/** 대략의 참고값 (국민건강영양조사 2022). 판정하지 않는다 */
const REFERENCE: Record<string, Record<Sex, number>> = {
  'tobacco.flag': { M: 0.3, F: 0.06 },
  'alcohol.flag': { M: 0.17, F: 0.07 },
};

/** 나이·성별 칸마다 센 수 */
const counts = new Map<string, number>();
const inc = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
const get = (key: string) => counts.get(key) ?? 0;

/** 그 물질의 사용 태그 (흡연자·전자담배·술꾼·약물 사용) */
function tagged(state: GameState, id: SubstanceId): boolean {
  const f = state.ch.flags;
  if (id === 'tobacco') return Boolean(f.smoker || f.vaper);
  if (id === 'alcohol') return Boolean(f.heavy_drinker);
  return Boolean(f.drug_use);
}

let minorUse = 0;
for (let i = 0; i < N; i++) {
  const habitEver = new Set<SubstanceId>();
  const state = simulateLife(`${PREFIX}-${i}`, {
    mode: 'reality',
    observe: (s) => {
      const ch = s.ch;
      if (ch.age < 19 && SUBSTANCE_IDS.some((id) => readRecord(ch, id).ever)) minorUse++;
      for (const id of SUBSTANCE_IDS) if (readRecord(ch, id).habit > 0) habitEver.add(id);
      if (!AGES.includes(ch.age)) return;
      const cell = `${ch.age}:${ch.sex}`;
      inc(`alive@${cell}`);
      for (const id of SUBSTANCE_IDS) {
        const r = readRecord(ch, id);
        if (r.ever) inc(`${id}.ever@${cell}`);
        if (r.habit > 0) inc(`${id}.habit@${cell}`);
        if (tagged(s, id)) inc(`${id}.flag@${cell}`);
        if (r.abstinentSince !== undefined) inc(`${id}.quitting@${cell}`);
        if (r.treatmentStarts > 0) inc(`${id}.treated@${cell}`);
      }
    },
  });
  inc(`lives:${state.ch.sex}`);
  for (const id of SUBSTANCE_IDS) {
    const r = readRecord(state.ch, id);
    if (r.ever) inc(`${id}.lifeEver:${state.ch.sex}`);
    if (habitEver.has(id)) inc(`${id}.lifeHabit:${state.ch.sex}`);
    if (r.treatmentStarts > 0) inc(`${id}.lifeTreated:${state.ch.sex}`);
  }
}

const pct = (k: number, n: number) => {
  if (n === 0) return '  -  ';
  const e = proportion(k, n);
  return `${(e.value * 100).toFixed(1)}% [${(e.lo * 100).toFixed(1)}–${(e.hi * 100).toFixed(1)}]`;
};

console.log(`술·담배·약물 유병률 (현실 모드, ${N}명, 시드 ${PREFIX}). 참고 보고이며 판정하지 않는다.`);
for (const id of SUBSTANCE_IDS) {
  console.log(`\n[${LABEL[id]}] 나이·성별: 써 본 적 | 습관 | 태그 | 끊는 중 | 상담·치료 시작${REFERENCE[`${id}.flag`] ? ' | 태그 참고값' : ''}`);
  for (const age of AGES) {
    for (const sex of ['M', 'F'] as Sex[]) {
      const cell = `${age}:${sex}`;
      const n = get(`alive@${cell}`);
      const ref = REFERENCE[`${id}.flag`]?.[sex];
      const cols = ['ever', 'habit', 'flag', 'quitting', 'treated'].map((k) => pct(get(`${id}.${k}@${cell}`), n));
      console.log(`  ${age}세 ${sex === 'M' ? '남' : '여'} (n=${n}): ${cols.join(' | ')}${ref !== undefined ? ` | 약 ${Math.round(ref * 100)}%` : ''}`);
    }
  }
  for (const sex of ['M', 'F'] as Sex[]) {
    const n = get(`lives:${sex}`);
    console.log(
      `  평생 ${sex === 'M' ? '남' : '여'} (n=${n}): 써 본 적 ${pct(get(`${id}.lifeEver:${sex}`), n)} | 습관이 생긴 적 ${pct(get(`${id}.lifeHabit:${sex}`), n)} | 상담·치료 ${pct(get(`${id}.lifeTreated:${sex}`), n)}`,
    );
  }
}
console.log(`\n판정: 미성년자의 사용 이력 ${minorUse === 0 ? '없음 — 통과' : `${minorUse}건 — 실패`}`);
process.exit(minorUse === 0 ? 0 : 1);
