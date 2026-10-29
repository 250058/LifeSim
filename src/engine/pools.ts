// 생활 사건 풀: 병원, 몸, 밥상, 연애, 육아.
// 풀마다 사건이 수백~수천 개라 하나하나 확률을 굴리면 해마다 카드가 쏟아진다.
// 그래서 풀 사건은 독립된 연간 확률로 모델링하지 않고 '그해의 작은 장면 한 장'으로 다룬다(표시·표본 추상화).
// 해마다 YEAR_CHANCE 확률로 장면 자리가 하나 생기고, 자리는 poolWeights 비율로 한 풀에 돌아간다.
// 그 풀에서는 조건이 맞는 사건 전체(가중치 합 W)에서 가중치대로 하나를 고르되, W가 POOL_FULL_WEIGHT보다
// 작으면 남는 몫은 조용한 해(그 풀에서는 아무 장면도 없음)다 (eventEngine.ts의 drawPool).
//
//   사건 e가 그해 풀 장면으로 나올 확률 = YEAR_CHANCE × (풀 비율) × w_e / max(W, POOL_FULL_WEIGHT)
//
// 이 추첨은 그해 다른 사건이 몇 개 일어났는지와 무관하고, 일반 사건의 발생 확률에도 영향이 없다.
// 풀 사건의 weight.base는 연간 확률이 아니라 풀 안의 상대 가중치다 (catalog/build.ts가 0.001~1로 맞춘다).

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

/** 한 해에 생활 사건 카드가 나올 확률 (그해 나올 수 있는 풀 사건이 하나라도 있을 때) */
const YEAR_CHANCE: Record<Mode, number> = { reality: 0.6, drama: 0.7, makjang: 0.8 };

export function poolYearChance(mode: Mode): number {
  return YEAR_CHANCE[mode];
}

/**
 * 풀이 '꽉 찼다'고 보는 가중치 합: 흔한 장면(가중치 1) 20개 분량. 모든 풀이 같은 가중치 척도(0.001~1, 보정을 받아도
 * 1.5 이하)를 쓰므로 기준도 하나다.
 *
 * 왜 필요한가: 예전에는 고른 풀의 후보만으로 나눠(w / W) 후보가 적으면 몇 안 되는 사건이 자리를 독차지했다.
 * 0~2세 병원 풀은 W가 3~9, 밥상 풀은 후보 1~2개(W 0.7~1.4)라서 가중치 0.08인 장중첩증이 0세에 해마다 1.3%,
 * 인생의 2~3%에서 나왔다 (성인 병원 풀 W≈54에서는 같은 가중치가 해마다 0.02% 안팎). 같은 가중치가 나이에 따라
 * 수십 배 다른 빈도가 되어, 작가가 정한 '드묾'이 그 나이에 함께 쓰인 다른 콘텐츠 양에 따라 바뀌었다.
 * 후보가 하나도 없는 풀의 몫을 다른 풀에 넘기던 규칙도 남은 풀의 사건을 같은 식으로 부풀렸다.
 *
 * 그래서 W가 이 기준보다 작으면 w / POOL_FULL_WEIGHT로 '절대 비율'이 되고 남는 몫은 조용한 해다.
 * 후보가 없는 풀도 조용한 해이며 다른 풀로 넘기지 않는다. W가 기준 이상인 풀(몸·밥상은 5세 무렵부터 거의 늘,
 * 병원은 대략 성인부터)은 예전과 같은 상대 추첨이다(한 해 한 장이라는 표시 몫을 나눠 가진다). 결과적으로
 *  - 조건이 맞지 않는 후보, 다른 풀의 콘텐츠는 이 사건의 확률을 바꾸지 않는다.
 *  - 같은 풀에 후보를 더해도 그 풀이 꽉 차기 전까지는 다른 사건의 확률이 그대로다.
 *  - 가중치 1.5짜리 사건도 한 풀 자리의 7.5%를 넘지 못한다 (꽉 찬 풀에서는 더 작다).
 * 자동 플레이 300명에서 그해 풀 장면이 나올 확률은 0~4세가 60%에서 5·12·14·25·35%로 줄고, 5세 이후는 54~60%다
 * (갓 성인이 된 미혼은 연애 풀 후보가 적어 48%). 장중첩증은 인생의 2.4%에서 0.5%로 줄었다.
 *
 * 남은 한계: 꽉 찬 풀에서는 여전히 한 해 한 장을 나눠 가지므로, 같은 풀에 후보를 더하면 나머지 장면의 빈도가 준다.
 * 풀 장면 가운데 오래 남는 상태를 바꾸는 것(만성 질환 태그를 붙이는 231개, 연애 시작·이별·결혼·이혼·출산·실직 60개)의
 * 발생률을 콘텐츠 양과 떼려면, 그 시작을 풀 밖의 일반 사건(독립 연간 확률)으로 옮기고 풀에는 장면만 남겨야 한다.
 */
export const POOL_FULL_WEIGHT = 20;

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
