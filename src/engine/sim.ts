// 자동 플레이: 밸런스 시뮬레이터와 테스트가 쓰는 봇.
// 봇은 평범한 사람처럼 군다: 공부·운동·친구를 고르고, 무직이면 구직하고,
// 여윳돈으로 빚을 갚고, 선택지는 무작위로 고른다.
// 단, 보이스피싱·감금 단지 같은 사기 아크에서는 열에 아홉은 끊거나 거절·신고한다
// (실제 사람은 대부분 전화를 끊는다. 무작위로 고르면 피싱 피해가 부풀려진다. 비율은 봇 가정이지 통계가 아니다).

import { activityViews } from './activities';
import { jobOpenings } from './career';
import { EVENT_BY_ID } from './data';
import { applyForJob, buyHome, buyStocks, choose, doActivity, endTurn, homePrice, newGame, proceed, repayDebt } from './game';
import { Rng } from './rng';
import type { ActiveCard, GameState, Mode } from './types';

/** 끊기·거절이 당연한 사기 아크 */
const SCAM_ARCS = ['voice_phishing', 'scam_compound'];
/** 끊기·거절·신고를 뜻하는 선택지 문구 */
const REFUSE_TEXT = /끊|거절|신고|112|경찰/;
/** 사기 아크에서 끊거나 거절하는 비율 (나머지는 평소처럼 고른다) */
export const SCAM_REFUSE_RATE = 0.9;

export interface SimOptions {
  mode?: Mode;
  birthYear?: number;
  /** 위험한 활동(범죄·도박)을 고를 확률 */
  riskTaste?: number;
}

function botActions(state: GameState, bot: Rng, riskTaste: number): void {
  const ch = state.ch;
  // 무직이면 올해 공고 중 붙을 확률이 높은 곳부터 두 군데 지원
  if (ch.age >= 19 && !ch.career.jobId && ch.edu.status !== 'university' && ch.military.status !== 'serving') {
    const openings = jobOpenings(state).sort((a, b) => b.chance - a.chance).slice(0, 2);
    for (const o of openings) if (!ch.career.jobId) applyForJob(state, o.job.id);
  }
  // 돈 관리
  if (ch.res.debt > 0 && ch.res.cash > 0 && bot.chance(0.7)) repayDebt(state);
  if (ch.age >= 30 && ch.age <= 55 && !ch.flags.homeowner && ch.res.cash > homePrice(state) * 0.4 && bot.chance(0.3)) {
    buyHome(state);
  }
  if (ch.age >= 25 && ch.res.cash > 50_000_000 * state.world.economy.priceIndex && bot.chance(0.15)) buyStocks(state, 0.3);

  // 시간 포인트 쓰기
  for (let guard = 0; guard < 10 && state.points.left > 0 && state.phase === 'action'; guard++) {
    const views = activityViews(state).filter((v) => v.enabled);
    if (views.length === 0) break;
    const safe = views.filter((v) => v.def.group !== 'risk');
    const risky = views.filter((v) => v.def.group === 'risk');
    const student = ['elementary', 'middle', 'high', 'university'].includes(ch.edu.status);
    let pick = bot.chance(riskTaste) && risky.length > 0 ? bot.pick(risky) : undefined;
    if (!pick && student && bot.chance(0.4)) pick = safe.find((v) => v.def.id === 'study');
    if (!pick && ch.state.stress > 70) pick = safe.find((v) => v.def.id === 'rest');
    if (!pick) pick = bot.pick(safe.length > 0 ? safe : views);
    doActivity(state, pick.def.id);
  }
}

/** 사기 아크 카드에서 끊기·거절·신고 선택지의 화면 번호. 사기 아크가 아니거나 그런 선택지가 없으면 undefined */
export function refusalChoice(card: ActiveCard): number | undefined {
  const arc = EVENT_BY_ID.get(card.eventId)?.arc;
  if (!arc || !SCAM_ARCS.includes(arc)) return undefined;
  const i = card.choices.findIndex((c) => REFUSE_TEXT.test(c.text));
  return i >= 0 ? i : undefined;
}

function botChoice(card: ActiveCard, bot: Rng): number {
  const refuse = refusalChoice(card);
  if (refuse !== undefined && bot.chance(SCAM_REFUSE_RATE)) return refuse;
  // 평범한 사람은 무난한 첫 선택지를 자주 고른다
  return bot.chance(0.4) ? 0 : bot.int(0, card.choices.length - 1);
}

/** 한 인생을 끝까지 자동으로 산다 */
export function simulateLife(seed: string, opts: SimOptions = {}): GameState {
  const state = newGame({ seed, mode: opts.mode ?? 'drama', birthYear: opts.birthYear ?? 2026 });
  const bot = new Rng(`bot|${seed}`);
  const riskTaste = opts.riskTaste ?? 0.01;
  let lastAge = -1;
  for (let guard = 0; guard < 20_000 && state.phase !== 'dead'; guard++) {
    if (state.phase === 'action') {
      if (state.ch.age !== lastAge) {
        lastAge = state.ch.age;
        botActions(state, bot, riskTaste);
        if (state.phase !== 'action') continue;
      }
      endTurn(state);
    } else if (state.phase === 'event') {
      const card = state.card!;
      if (card.choices.length > 0 && !card.result) choose(state, botChoice(card, bot));
      else proceed(state);
    }
  }
  return state;
}
