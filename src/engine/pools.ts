// 생활 사건 풀: 병원, 몸, 밥상, 연애, 육아.
// 풀마다 사건이 수백~수천 개라 하나하나 확률을 굴리면 해마다 카드가 쏟아진다.
// 그래서 디렉터가 고르고 남은 자리가 있을 때 해마다 한 번 풀 추첨을 하고,
// 뽑힌 풀 안에서 조건이 맞는 사건 하나를 가중치대로 고른다.

import type { PoolId } from './schema';
import type { GameState, Mode } from './types';
import { alive, partnerOf, spouseOf } from './relations';

export const POOL_IDS: PoolId[] = ['medical', 'physiology', 'nutrition', 'romance', 'parenting'];

export const POOL_LABEL: Record<PoolId, string> = {
  medical: '병원',
  physiology: '몸',
  nutrition: '밥상',
  romance: '연애',
  parenting: '육아',
};

/** 한 해에 생활 사건 카드가 나올 확률 (빈자리가 있을 때) */
const YEAR_CHANCE: Record<Mode, number> = { reality: 0.6, drama: 0.7, makjang: 0.8 };

export function poolYearChance(mode: Mode): number {
  return YEAR_CHANCE[mode];
}

/** 나이와 처지에 따라 어느 풀이 잘 뽑히는가 */
export function poolWeights(state: GameState): Record<PoolId, number> {
  const ch = state.ch;
  const age = ch.age;
  const medicalByAge = age < 7 ? 0.9 : age < 19 ? 0.5 : age < 40 ? 0.7 : age < 60 ? 1 : 1.6;
  const kids = alive(ch, 'child');
  const youngKids = kids.filter((k) => state.year - k.birthYear < 20).length;
  const coupled = Boolean(partnerOf(ch) || spouseOf(ch));
  return {
    medical: medicalByAge * (ch.stats.health < 50 ? 1.5 : 1),
    physiology: age < 3 ? 0.4 : 1,
    nutrition: age < 3 ? 0.3 : 0.9,
    romance: age >= 19 ? (coupled ? 0.9 : 0.7) * (age >= 70 ? 0.5 : 1) : 0,
    parenting: kids.length === 0 ? 0 : youngKids > 0 ? 1.1 : 0.4,
  };
}
