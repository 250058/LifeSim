// 범죄·사법: 체포 → 기소 → 재판 → 벌금·집행유예·실형 → 교도소 → 출소 후 전과자.
// 형량은 대법원 양형기준의 큰 줄기를 단순화했다. 미성년자는 소년법을 따른다.

import { leaveJob } from './career';
import { formatWon } from './format';
import type { Rng } from './rng';
import type { Change, GameState } from './types';

interface CrimeDef {
  name: string;
  /** 성인 초범 기준 결과 비율: 기소유예·불기소 / 벌금 / 집행유예 / 실형 */
  odds: { drop: number; fine: number; suspended: number; prison: number };
  fine?: [number, number];
  /** 실형 개월 수 */
  months?: [number, number];
  /** 소년도 형사처벌을 받을 수 있는 중대 범죄 */
  serious?: boolean;
}

export const CRIMES: Record<string, CrimeDef> = {
  theft: {
    name: '절도',
    odds: { drop: 0.1, fine: 0.6, suspended: 0.25, prison: 0.05 },
    fine: [2_000_000, 7_000_000],
    months: [6, 14],
  },
  gambling: {
    name: '도박',
    odds: { drop: 0.15, fine: 0.8, suspended: 0.05, prison: 0 },
    fine: [1_000_000, 5_000_000],
  },
  scam_accomplice: {
    name: '사기 방조(보이스피싱 현금 수거)',
    odds: { drop: 0, fine: 0, suspended: 0.35, prison: 0.65 },
    months: [12, 36],
    serious: true,
  },
  scam_accomplice_coop: {
    name: '사기 방조(보이스피싱 현금 수거)',
    odds: { drop: 0.05, fine: 0, suspended: 0.6, prison: 0.35 },
    months: [8, 24],
    serious: true,
  },
  courier_selfreport: {
    name: '사기 방조(자수)',
    odds: { drop: 0.8, fine: 0, suspended: 0.2, prison: 0 },
    serious: true,
  },
  compound_fraud: {
    name: '범죄단체 가입·활동',
    odds: { drop: 0.1, fine: 0, suspended: 0.45, prison: 0.45 },
    months: [12, 48],
    serious: true,
  },
  desertion: {
    name: '군무이탈',
    odds: { drop: 0, fine: 0, suspended: 0.5, prison: 0.5 },
    months: [12, 24],
    serious: true,
  },
  escape: {
    name: '도주',
    odds: { drop: 0, fine: 0, suspended: 0, prison: 1 },
    months: [12, 18],
    serious: true,
  },
};

export interface Verdict {
  kind: 'drop' | 'juvenile' | 'fine' | 'suspended' | 'prison';
  text: string;
  changes: Change[];
}

/** 재판. 상태를 바꾸고 판결을 돌려준다 */
export function prosecute(state: GameState, crimeId: string, rng: Rng, lenient = false): Verdict {
  const crime = CRIMES[crimeId];
  if (!crime) throw new Error(`없는 범죄: ${crimeId}`);
  const ch = state.ch;
  const changes: Change[] = [];
  const priors = ch.legal.convictions;

  // 만 14세 미만 촉법소년, 19세 미만은 대부분 소년보호처분
  if (ch.age < 14 || (ch.age < 19 && (!crime.serious || rng.chance(0.6)))) {
    ch.flags.juvenile_record = { since: ch.age };
    ch.state.stress = Math.min(100, ch.state.stress + 10);
    const text =
      ch.age < 14
        ? `${crime.name}. 촉법소년이라 형사처벌 대신 소년부로 넘겨졌다. 보호관찰 1년.`
        : `${crime.name}. 소년부 송치, 보호처분. 전과는 남지 않지만 기록은 남는다.`;
    changes.push({ text: '소년보호처분', sign: 'bad' });
    return { kind: 'juvenile', text, changes };
  }

  let { drop, fine, suspended, prison } = crime.odds;
  // 전과가 있으면 무거워지고, 자백·협조하면 가벼워진다
  for (let i = 0; i < priors; i++) {
    prison += suspended * 0.5 + fine * 0.2;
    suspended = suspended * 0.5 + fine * 0.3;
    fine *= 0.5;
    drop *= 0.3;
  }
  if (lenient) {
    drop += prison * 0.1;
    suspended += prison * 0.4;
    prison *= 0.5;
  }
  if (crimeId === 'compound_fraud' && ch.flags.compound_manager) {
    prison += suspended * 0.7;
    suspended *= 0.3;
  }
  const kind =
    rng.weighted(
      [
        ['drop', drop],
        ['fine', fine],
        ['suspended', suspended],
        ['prison', prison],
      ] as const,
      ([, w]) => w,
    )?.[0] ?? 'fine';

  if (kind === 'drop') {
    changes.push({ text: '기소유예', sign: 'info' });
    return { kind, text: `${crime.name} 혐의. 기소유예 처분을 받았다. 이번만은 넘어간다.`, changes };
  }

  ch.legal.convictions += 1;
  if (kind === 'fine') {
    const [lo, hi] = crime.fine ?? [1_000_000, 3_000_000];
    const amount = Math.round(rng.int(lo, hi) / 100_000) * 100_000;
    payOrBorrow(state, amount);
    changes.push({ text: `벌금 ${formatWon(amount)}`, sign: 'bad' });
    return { kind, text: `${crime.name}. 벌금 ${formatWon(amount)}을 선고받았다.`, changes };
  }

  ch.flags.criminal_record = { since: ch.age };
  changes.push({ text: '태그: 전과자', sign: 'bad' });
  const [mLo, mHi] = crime.months ?? [6, 12];
  const months = rng.int(mLo, mHi);
  const term = monthsText(months);

  if (kind === 'suspended') {
    ch.legal.probationUntil = ch.age + 2;
    changes.push({ text: `징역 ${term}, 집행유예 2년`, sign: 'bad' });
    return { kind, text: `${crime.name}. 징역 ${term}에 집행유예 2년. 다시 문제를 일으키면 바로 들어간다.`, changes };
  }

  const years = Math.max(1, Math.ceil(months / 12));
  ch.legal.prisonUntil = ch.age + years;
  if (state.ch.career.jobId && !state.ch.career.business) leaveJob(state, 0);
  if (state.ch.career.business) {
    state.ch.career.business = undefined;
    state.ch.career.jobId = undefined;
    state.ch.career.title = undefined;
  }
  if (['elementary', 'middle', 'high', 'university'].includes(ch.edu.status)) ch.edu.status = 'dropout';
  ch.stats.happiness = Math.max(0, ch.stats.happiness - 15);
  changes.push({ text: `징역 ${term} (실형)`, sign: 'bad' });
  return { kind, text: `${crime.name}. 징역 ${term}. 법정에서 바로 구속됐다.`, changes };
}

function monthsText(months: number): string {
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m}개월`;
  return m === 0 ? `${y}년` : `${y}년 ${m}개월`;
}

/** 현금이 모자라면 빚으로 */
export function payOrBorrow(state: GameState, amount: number): void {
  const r = state.ch.res;
  r.cash -= amount;
  if (r.cash < 0) {
    r.debt += -r.cash;
    r.cash = 0;
  }
}

export function release(state: GameState): void {
  state.ch.legal.prisonUntil = undefined;
  state.ch.flags.ex_convict_release = { since: state.ch.age, until: state.ch.age + 3 };
}
