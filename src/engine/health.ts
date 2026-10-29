// 건강·노화·사망. 기본 사망률은 2024 생명표에 맞춘 곰페르츠-메이컴 모형이고,
// 건강 수치와 병이 그 위에 배수로 얹힌다.
//
// 맞춘 값 (보정표): 기대수명 남 80.8 / 여 86.6, 80세까지 생존 남 64.4% / 여 82.2%
// 피팅 결과: 남 a=0.0004 b=8.712e-7 c=0.1394, 여 a=0.0002 b=1.5274e-7 c=0.152

import { TAG_BY_ID, WORLD } from './data';
import type { Rng } from './rng';
import { substanceHealthDelta } from './substances';
import type { Character, Sex } from './types';

const GOMPERTZ: Record<Sex, { a: number; b: number; c: number }> = {
  M: { a: 0.0004, b: 8.712e-7, c: 0.1394 },
  F: { a: 0.0002, b: 1.5274e-7, c: 0.152 },
};

/** 영아 사망률 (0세) */
const INFANT_Q = 0.0025;

/**
 * 시뮬레이터 보정값. 사건(암, 사고, 감금 등)으로 생기는 사망이 생명표 위에 더해지므로
 * 기본 사망률을 조금 낮춘다. tools/simulator로 맞춘 값.
 */
export const BASE_HAZARD_SCALE = 0.78;

/** 생명표 기준 연간 사망 확률 */
export function baseMortality(age: number, sex: Sex): number {
  if (age <= 0) return INFANT_Q;
  const { a, b, c } = GOMPERTZ[sex];
  return 1 - Math.exp(-(a + b * Math.exp(c * age)));
}

const TARGET_POINTS: [number, number][] = [
  [0, 88],
  [30, 88],
  [50, 80],
  [70, 66],
  [85, 48],
  [100, 30],
  [120, 20],
];

/** 그 나이의 평범한 사람이 가지는 건강 수치. 건강은 해마다 이 값으로 조금씩 돌아간다 */
export function healthTarget(age: number): number {
  for (let i = 1; i < TARGET_POINTS.length; i++) {
    const [x1, y1] = TARGET_POINTS[i];
    const [x0, y0] = TARGET_POINTS[i - 1];
    if (age <= x1) return y0 + ((y1 - y0) * (age - x0)) / (x1 - x0);
  }
  return TARGET_POINTS[TARGET_POINTS.length - 1][1];
}

/** 건강이 같은 나이 평균보다 나쁘면 위험이 커진다 */
export function healthRiskMultiplier(health: number, age: number): number {
  const rr = Math.exp(0.03 * (healthTarget(age) - health));
  return Math.min(6, Math.max(0.6, rr));
}

/** 건강이 바닥이면 나이와 상관없이 위험하다 */
function frailty(health: number): number {
  if (health >= 25) return 0;
  const x = (25 - health) / 25;
  return x * x * 0.35;
}

export function deathProbability(ch: Character): number {
  const { age, sex } = ch;
  let p = baseMortality(age, sex) * BASE_HAZARD_SCALE * healthRiskMultiplier(ch.stats.health, age);
  if (ch.flags.dementia) p *= 1.6;
  else if (ch.flags.dementia_mild) p *= 1.2;
  if (ch.flags.cancer) p += 0.07;
  if (ch.traits.includes('congenital_heart') && age < 40) p += 0.002;
  p += frailty(ch.stats.health);
  return Math.min(0.97, p);
}

/** NPC는 능력치 대신 건강만 본다 */
export function npcDeathProbability(age: number, sex: Sex, health: number): number {
  const p = baseMortality(age, sex) * BASE_HAZARD_SCALE * healthRiskMultiplier(health, age) + frailty(health);
  return Math.min(0.97, p);
}

/** 사망 원인. 앓던 병이 있으면 그 병이 먼저다 */
export function pickCause(ch: Character, rng: Rng): string {
  if (ch.flags.cancer && rng.chance(0.85)) return '암';
  if (ch.flags.dementia && rng.chance(0.35)) return '치매 합병증';
  return pickCauseByAge(ch.age, ch.sex, rng);
}

/**
 * 나이별 사망 원인표. 플레이어의 암은 '암 진단' 사건이 따로 만들므로 표의 암 비중은
 * 진단받지 않은 채 맞는 죽음(NPC 포함)만큼만 둔다.
 */
export function pickCauseByAge(age: number, sex: Sex, rng: Rng): string {
  const table = WORLD.causesOfDeath.find((t) => age <= t.maxAge) ?? WORLD.causesOfDeath[WORLD.causesOfDeath.length - 1];
  // 남성은 암 사망 비중이 높다 (보정표: 암 사망 확률 남 24.5%, 여 15.2%)
  const cancerX = sex === 'M' ? 0.8 : 0.2;
  const picked = rng.weighted(table.causes, ([cause, w]) => (cause === '암' ? w * cancerX : w));
  return picked ? picked[0] : '노환';
}

/** 연말 건강 변화: 나이 기준점으로 돌아가는 힘 + 생활습관 + 병 */
export function yearlyHealthDelta(ch: Character, rng: Rng): number {
  const { age, stats, flags, state } = ch;
  let d = (healthTarget(age) - stats.health) * 0.18;
  // 술·담배·약물: 올해 실제로 쓴 빈도만큼 (매일 흡연 −1.2, 과음 −0.8은 기존 보정 그대로). 끊으면 붙지 않는다
  d += substanceHealthDelta(ch);
  if (flags.diet_healthy) d += 0.6;
  if (flags.diet_junk) d -= 0.8;
  if (flags.diet_vegan) d += 0.3;
  if (flags.ptsd) d -= 0.5;
  if (state.stress > 70) d -= (state.stress - 70) * 0.1;
  if (flags.cancer) d -= 6;
  if (flags.dementia) d -= 3;
  else if (flags.dementia_mild) d -= 1;
  if (ch.traits.includes('congenital_heart')) d -= 0.5;
  // 만성 질환 같은 태그는 tags.json(또는 사건 목록)의 healthPerYear만큼 해마다 건강을 바꾼다
  let chronic = 0;
  for (const id of Object.keys(flags)) chronic += TAG_BY_ID.get(id)?.healthPerYear ?? 0;
  d += Math.max(-4, Math.min(2, chronic));
  d += rng.normal(0, 2);
  return d;
}

/** 나이에 따른 능력치 노화 (연간) */
export function agingDeltas(age: number): { stamina: number; looks: number; intelligence: number } {
  const stamina = age < 25 ? 0 : age < 35 ? -0.3 : age < 50 ? -0.6 : age < 65 ? -1.0 : age < 75 ? -1.5 : -2.0;
  const looks = age < 30 ? 0 : age < 40 ? -0.3 : age < 55 ? -0.6 : -0.8;
  const intelligence = age < 60 ? 0 : age < 70 ? -0.3 : age < 80 ? -0.8 : -1.5;
  return { stamina, looks, intelligence };
}
