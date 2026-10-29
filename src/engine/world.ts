// 세계 시뮬레이션: 플레이어와 상관없이 대한민국이 해마다 따로 굴러간다.
// 경기 순환, 금리·물가·최저임금, 선거 주기, 남북 긴장도, 감염병, 그해의 뉴스.

import { WORLD } from './data';
import type { Rng } from './rng';
import type { EconomyPhase, GameState, LogEntry, Mode, WorldState } from './types';

const BASE_YEAR = 2026;
const BASE_MIN_WAGE = 10320; // 2026년 최저임금 (보정표)

/** 대선: 2025년 6월 제21대 이후 5년마다 */
export function isPresidentialYear(year: number): boolean {
  return year >= 2030 && (year - 2030) % 5 === 0;
}
/** 총선: 2024년 제22대 이후 4년마다 */
export function isGeneralElectionYear(year: number): boolean {
  return year >= 2028 && (year - 2028) % 4 === 0;
}

const PHASE_NEXT: Record<EconomyPhase, [EconomyPhase, number][]> = {
  boom: [
    ['boom', 0.45],
    ['normal', 0.45],
    ['recession', 0.1],
  ],
  normal: [
    ['boom', 0.18],
    ['normal', 0.6],
    ['recession', 0.2],
    ['crisis', 0.02],
  ],
  recession: [
    ['boom', 0.04],
    ['normal', 0.45],
    ['recession', 0.45],
    ['crisis', 0.06],
  ],
  crisis: [
    ['normal', 0.3],
    ['recession', 0.6],
    ['crisis', 0.1],
  ],
};

const PHASE_VALUES: Record<
  EconomyPhase,
  { growth: number; unemployment: number; interest: number; inflation: number; stock: number; housing: number }
> = {
  boom: { growth: 3.5, unemployment: 2.6, interest: 3.5, inflation: 3.0, stock: 0.15, housing: 0.08 },
  normal: { growth: 2.0, unemployment: 3.0, interest: 2.8, inflation: 2.0, stock: 0.06, housing: 0.03 },
  recession: { growth: 0.3, unemployment: 3.8, interest: 2.0, inflation: 1.0, stock: -0.1, housing: -0.03 },
  crisis: { growth: -3.0, unemployment: 5.5, interest: 3.8, inflation: 4.0, stock: -0.3, housing: -0.1 },
};

export function initWorld(year: number): WorldState {
  const years = Math.max(0, year - BASE_YEAR);
  return {
    year,
    economy: {
      phase: 'normal',
      growth: 1.8,
      unemployment: 3.0,
      interest: 2.5,
      inflation: 2.0,
      priceIndex: Math.pow(1.025, years),
      stockIndex: 100,
      housingIndex: 100,
      minWage: Math.round((BASE_MIN_WAGE * Math.pow(1.03, years)) / 10) * 10,
    },
    politics: { ruling: null, approval: 45, lastPresidential: 2025 },
    tension: 45,
    war: { active: false, yearsLeft: 0 },
    unified: false,
    automation: 20,
    pandemic: 0,
    news: {},
  };
}

/**
 * 희귀할수록 크게, 흔할수록 작게 붙는 모드 배수.
 *
 * 희귀함은 '평생 한 번이라도 겪을 확률'로 잰다. 연 0.6%짜리 사건도 18년 동안 매년
 * 굴리면 평생 10%라 흔한 사건이기 때문이다 (연 단위로 재면 드라마 모드에서 학폭이
 * 인생의 60%에 일어났다). p₀는 연간 확률, years는 그 사건이 일어날 수 있는 햇수.
 */
export function lifetimeProbability(p0: number, years: number): number {
  return 1 - Math.pow(1 - Math.min(p0, 0.999999), Math.max(1, years));
}

export function modeMultiplier(mode: Mode, p0: number, years = 1): number {
  const curve = WORLD.modes[mode].curve;
  if (curve.length === 0) return 1;
  const x = Math.log10(Math.max(lifetimeProbability(p0, years), 1e-9));
  // 곡선은 평생 확률 내림차순 (흔한 사건 → 희귀한 사건)
  if (x >= Math.log10(curve[0][0])) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [p1, m1] = curve[i];
    const [p0prev, m0] = curve[i - 1];
    const x1 = Math.log10(p1);
    const x0 = Math.log10(p0prev);
    if (x >= x1) return m0 + ((m1 - m0) * (x - x0)) / (x1 - x0);
  }
  return curve[curve.length - 1][1];
}

function headline(key: string, rng: Rng, vars: Record<string, string>): string {
  const list = WORLD.news[key];
  if (!list || list.length === 0) return '';
  return rng.pick(list).replace(/\{([^}]+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}

/** 한 해 세계 갱신. 그해의 뉴스 헤드라인을 돌려준다 */
export function updateWorld(state: GameState, rng: Rng): LogEntry[] {
  const w = state.world;
  const year = state.year;
  w.year = year;
  const e = w.economy;
  const prevPhase = e.phase;

  // 경기 순환
  e.phase = rng.weighted(PHASE_NEXT[e.phase], ([, p]) => p)?.[0] ?? 'normal';
  const v = PHASE_VALUES[e.phase];
  e.growth = round1(v.growth + rng.normal(0, 0.6));
  e.unemployment = round1(Math.max(1.8, v.unemployment + rng.normal(0, 0.3) + w.automation * 0.01));
  e.interest = round1(Math.max(0.5, v.interest + rng.normal(0, 0.3)));
  e.inflation = round1(Math.max(-0.5, v.inflation + rng.normal(0, 0.5)));
  e.priceIndex *= 1 + e.inflation / 100;
  e.stockIndex = Math.max(20, e.stockIndex * (1 + v.stock + rng.normal(0, 0.12)));
  e.housingIndex = Math.max(30, e.housingIndex * (1 + v.housing + rng.normal(0, 0.03)));
  e.minWage = Math.round((e.minWage * (1 + Math.max(0, e.inflation + 1) / 100)) / 10) * 10;

  // 안보: 도발 → 국지전 → 전면전. 전쟁은 휴전이나 통일로 끝난다
  let provocation = false;
  let skirmish = false;
  let warStart = false;
  let warEnd = false;
  if (w.unified) {
    w.tension = Math.max(0, Math.min(30, w.tension + rng.normal((8 - w.tension) * 0.3, 3)));
  } else if (w.war.active) {
    w.war.yearsLeft -= 1;
    if (w.war.yearsLeft <= 0) {
      const outcome = rng.weighted(
        [
          ['armistice', 70],
          ['unification', 20],
          ['continue', 10],
        ] as const,
        ([, x]) => x,
      )![0];
      if (outcome === 'continue') w.war.yearsLeft = 1;
      else {
        w.war = { active: false, yearsLeft: 0, startYear: w.war.startYear, outcome };
        warEnd = true;
        if (outcome === 'unification') w.unified = true;
        w.tension = outcome === 'unification' ? 10 : 70;
      }
    }
  } else {
    if (rng.chance(0.08)) {
      w.tension += rng.int(12, 25);
      provocation = true;
    }
    w.tension = Math.max(5, Math.min(99, w.tension + rng.normal((45 - w.tension) * 0.2, 9)));
    if (w.tension >= 75 && rng.chance(0.18)) skirmish = true;
    // 전면전: 현실 모드에서 평생 1~2%, 드라마 모드 4~6%가 되도록 맞췄다
    if (w.tension >= 85 && rng.chance(0.012 * modeMultiplier(state.mode, 0.00015, 85))) {
      w.war = { active: true, yearsLeft: rng.chance(0.4) ? 2 : 1, startYear: year };
      warStart = true;
    }
  }
  if (warStart || w.war.active) {
    // 전쟁 중 경제: 금융시장 패닉, 집값 하락
    e.phase = 'crisis';
    if (warStart) {
      e.stockIndex *= 0.7;
      e.housingIndex *= 0.85;
    }
  }

  // 기술·감염병
  w.automation = Math.min(95, w.automation + 1.2 + rng.normal(0, 0.5));
  let pandemicStart = false;
  if (w.pandemic > 0) w.pandemic -= 1;
  else if (rng.chance(0.006 * modeMultiplier(state.mode, 0.006, 85))) {
    w.pandemic = rng.int(2, 3);
    pandemicStart = true;
  }

  // 그해의 뉴스 플래그: 사회 현상과 재난
  w.news = {
    scamCompound: rng.chance(0.15),
    voicePhishing: rng.chance(0.3),
    jeonseFraud: rng.chance(0.12),
    pandemicStart,
    pandemicOngoing: w.pandemic > 0,
    provocation,
    skirmish,
    warStart,
    warOngoing: w.war.active && !warStart,
    warEnd,
    quake: rng.chance(0.02),
    typhoon: rng.chance(0.35),
    flood: rng.chance(0.3),
    heatwave: rng.chance(0.35),
    coldwave: rng.chance(0.25),
    wildfire: rng.chance(0.12),
    fineDust: rng.chance(0.5),
    outage: rng.chance(0.04),
    protest: rng.chance(w.politics.approval < 25 ? 0.3 : 0.04),
    priceSurge: e.inflation >= 3.5,
  };

  // 선거
  const vars: Record<string, string> = {
    연도: String(year),
    최저시급: e.minWage.toLocaleString('ko-KR'),
    성장률: e.growth.toFixed(1),
    실업률: e.unemployment.toFixed(1),
  };
  const news: string[] = [];
  // 전쟁과 국지전 소식이 가장 먼저다
  if (warStart) news.push(headline('warStart', rng, vars));
  else if (w.war.active) news.push(headline('warOngoing', rng, vars));
  if (warEnd) news.push(headline(w.war.outcome === 'unification' ? 'unification' : 'armistice', rng, vars));
  if (skirmish) news.push(headline('skirmish', rng, vars));
  if (isPresidentialYear(year) && !w.war.active) {
    const winner = pickParty(w, rng);
    w.politics.ruling = winner;
    w.politics.approval = rng.int(45, 60);
    w.politics.lastPresidential = year;
    vars.정당 = winner;
    vars.대수 = String(22 + (year - 2030) / 5);
    news.push(headline('presidential', rng, vars));
  } else if (isGeneralElectionYear(year) && !w.war.active) {
    vars.정당 = pickParty(w, rng);
    vars.대수 = String(23 + (year - 2028) / 4);
    news.push(headline('general', rng, vars));
  }
  w.politics.approval = Math.max(15, Math.min(75, w.politics.approval + rng.normal(-2, 6)));

  if (w.news.quake) news.push(headline('quake', rng, vars));
  if (w.news.wildfire && rng.chance(0.5)) news.push(headline('wildfire', rng, vars));
  if (provocation) news.push(headline('tensionHigh', rng, vars));
  if (e.phase !== prevPhase || rng.chance(0.25)) news.push(headline(e.phase, rng, vars));
  if (w.news.pandemicStart) news.push(headline('pandemic', rng, vars));
  if (w.tension < 20 && !w.unified) news.push(headline('tensionLow', rng, vars));
  if (w.news.protest) news.push(headline('protest', rng, vars));
  if (w.news.scamCompound) news.push(headline('scamCompound', rng, vars));
  if (w.news.jeonseFraud) news.push(headline('jeonseFraud', rng, vars));
  if (w.news.typhoon && rng.chance(0.3)) news.push(headline('typhoon', rng, vars));
  if (w.news.heatwave && rng.chance(0.3)) news.push(headline('heatwave', rng, vars));
  if (w.news.voicePhishing && rng.chance(0.4)) news.push(headline('voicePhishing', rng, vars));
  if (rng.chance(0.2)) news.push(headline('minWage', rng, vars));
  if (w.automation > 40 && rng.chance(0.15)) news.push(headline('automation', rng, vars));

  // 한 해에 헤드라인은 최대 두 줄
  return news
    .filter(Boolean)
    .slice(0, 2)
    .map((text) => ({ year, age: state.ch.age, kind: 'news' as const, text }));
}

function pickParty(w: WorldState, rng: Rng): string {
  const parties = WORLD.parties;
  // 집권당은 지지율이 낮으면 정권을 내주기 쉽다
  if (w.politics.ruling && rng.chance(w.politics.approval / 100)) return w.politics.ruling;
  const others = parties.filter((p) => p !== w.politics.ruling);
  return rng.pick(others.length ? others : parties);
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
