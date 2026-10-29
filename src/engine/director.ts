// 디렉터: 인생의 완급을 조절한다 (RimWorld의 스토리텔러).
//
// - 긴장도 = 최근 사건 충격량의 합. 해마다 줄어든다.
// - 긴장도가 높으면 회복 구간(평온): 큰 비극을 줄이고 회복·도움 사건을 늘린다.
// - 평온이 오래가면 격동: 드라마 확률을 올린다.
// - 연간 사건 수: 평온 0~1, 보통 1~2, 격동 2~3
// 현실 모드는 실제 통계 그대로라 디렉터가 확률을 건드리지 않는다.

import type { EventDef } from './schema';
import type { DirectorState, GameState, Tone } from './types';
import { WORLD } from './data';

export const RECOVERY_TENSION = 45;
export const CALM_YEARS_FOR_DRAMA = 3;
/** 이 충격량 이상이면 '큰 사건'으로 보고 평온 기간을 끊는다 */
export const BIG_IMPACT = 20;

export function initDirector(): DirectorState {
  return { tension: 0, calmYears: 0, pace: 'normal', yearPeak: 0 };
}

export function updatePace(state: GameState): void {
  const d = state.director;
  if (d.tension >= RECOVERY_TENSION) d.pace = 'calm';
  else if (d.calmYears >= CALM_YEARS_FOR_DRAMA) d.pace = 'turbulent';
  else d.pace = 'normal';
}

const FACTORS: Record<DirectorState['pace'], Record<Tone, number>> = {
  calm: { tragedy: 0.3, drama: 0.6, positive: 1.5, neutral: 1, recovery: 2 },
  normal: { tragedy: 1, drama: 1, positive: 1, neutral: 1, recovery: 1 },
  turbulent: { tragedy: 1.5, drama: 2, positive: 1, neutral: 1, recovery: 1 },
};

/** 확률 공식의 D */
export function directorFactor(state: GameState, ev: EventDef): number {
  if (state.mode === 'reality') return 1;
  return FACTORS[state.director.pace][ev.tone ?? 'neutral'];
}

/** [최소, 최대] 연간 사건 수. 최소는 일상 사건으로 채운다 */
export function countRange(state: GameState): [number, number] {
  if (!WORLD.modes[state.mode].filler) return [0, 3];
  switch (state.director.pace) {
    case 'calm':
      return [0, 1];
    case 'normal':
      return [1, 2];
    case 'turbulent':
      return [2, 3];
  }
}

export function addImpact(state: GameState, impact: number): void {
  state.director.tension += impact;
  state.director.yearPeak = Math.max(state.director.yearPeak, impact);
}

/** 연말: 긴장도 감소, 평온 햇수 갱신 */
export function directorYearEnd(state: GameState): void {
  const d = state.director;
  d.tension = Math.round(d.tension * 0.55 * 10) / 10;
  d.calmYears = d.yearPeak >= BIG_IMPACT ? 0 : d.calmYears + 1;
  d.yearPeak = 0;
}
