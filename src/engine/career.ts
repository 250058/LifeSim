// 학업·진로·직업: 내신과 수능, 대학 등급, 구직, 연봉 곡선, 퇴직금, 연금, 자영업.

import { evaluate } from './conditions';
import { JOB_BY_ID, JOBS, WORLD } from './data';
import { rngFor, type Rng } from './rng';
import { buildScope } from './scope';
import type { JobDef } from './schema';
import { ELITE_HIGH } from './format';
import type { Degree, GameState, HighType, UnivTier } from './types';

export const DEGREE_RANK: Record<Degree, number> = {
  none: 0,
  elementary: 1,
  middle: 2,
  high: 3,
  college: 4,
  university: 5,
};

export const DEGREE_LABEL: Record<Degree, string> = {
  none: '무학',
  elementary: '초졸',
  middle: '중졸',
  high: '고졸',
  college: '전문대졸',
  university: '대졸',
};

/** 학교 유형별 수능 보정 (학교 분위기와 교육과정) */
const CSAT_BY_HIGH: Record<HighType, number> = {
  general: 0,
  foreign: 4,
  autonomous: 4,
  gifted: 5,
  science: 4,
  arts: -4,
  sports: -6,
  vocational: -6,
  meister: -6,
  alternative: -3,
};

export const TIER_RANK: Record<UnivTier, number> = { S: 5, A: 4, B: 3, C: 2, D: 1 };
export const TIER_LABEL: Record<UnivTier, string> = {
  S: '최상위권',
  A: '인서울 상위권',
  B: '수도권',
  C: '지방 4년제',
  D: '전문대',
};

// ── 수능 ─────────────────────────────────────────────────

/** 표준정규분포 누적확률 */
function phi(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

const GRADE_CUTS = [4, 11, 23, 40, 60, 77, 89, 96]; // 누적 상위 %

export function computeCsat(state: GameState, rng: Rng): { percentile: number; grade: number; tier: UnivTier | null } {
  const ch = state.ch;
  const f = ch.flags;
  let score =
    0.42 * ch.stats.intelligence +
    0.25 * ch.edu.grade +
    0.12 * ch.personality.conscientiousness +
    1.6 * Math.min(ch.edu.highStudy, 12);
  if (f.csat_calm) score += 2;
  if (f.csat_focus) score += 4;
  if (f.csat_drowsy) score -= 4;
  if (f.csat_rushed) score -= 2;
  if (f.csat_shaken) score -= 4;
  if (f.csat_panic) score -= 6;
  score += CSAT_BY_HIGH[ch.edu.highType ?? 'general'];
  if ((state.counts.csat_dawn ?? 0) > 1) score += 3; // 재수 효과
  score += rng.normal(0, 7);
  const percentile = Math.round(Math.max(0.1, Math.min(99.9, phi((score - 47) / 12) * 100)) * 10) / 10;
  const top = 100 - percentile;
  let grade = 9;
  for (let i = 0; i < GRADE_CUTS.length; i++) {
    if (top <= GRADE_CUTS[i]) {
      grade = i + 1;
      break;
    }
  }
  const tier: UnivTier | null =
    percentile >= 97 ? 'S' : percentile >= 88 ? 'A' : percentile >= 70 ? 'B' : percentile >= 45 ? 'C' : percentile >= 15 ? 'D' : null;
  ch.edu.csat = { percentile, grade, age: ch.age, tier };
  return { percentile, grade, tier };
}

export function csatSummary(state: GameState): string {
  const c = state.ch.edu.csat;
  if (!c) return '';
  const tierText = c.tier
    ? `${TIER_LABEL[c.tier]} 대학을 노려볼 만하다.`
    : '어느 대학도 장담하기 어려운 점수다.';
  return `평균 ${c.grade}등급, 백분위 ${c.percentile}. ${tierText}`;
}

/** 수능 등급에 맞는 대학 이름 (가상 대학) */
export function admissionName(state: GameState, rng: Rng): string {
  const tier = state.ch.edu.csat?.tier ?? 'D';
  return rng.pick(WORLD.universities[tier]);
}

/** 수시 학생부종합으로 노려볼 만한 대학 등급: 내신과 학교 유형으로 정한다 */
export function susiTier(state: GameState): UnivTier {
  const e = state.ch.edu;
  const elite = e.highType !== undefined && ELITE_HIGH.includes(e.highType);
  if (e.grade >= 92 || (elite && e.grade >= 75)) return 'S';
  if (e.grade >= 82 || elite) return 'A';
  return 'B';
}

export function enterUniversity(
  state: GameState,
  rng: Rng,
  name = admissionName(state, rng),
  tier: UnivTier = state.ch.edu.csat?.tier ?? 'D',
): string {
  const ch = state.ch;
  ch.edu.status = 'university';
  ch.edu.univ = { name, tier, startAge: ch.age, years: tier === 'D' ? 2 : 4 };
  ch.edu.onLeave = false;
  return name;
}

export function graduateUniversity(state: GameState): void {
  const e = state.ch.edu;
  if (!e.univ) return;
  e.status = 'graduated';
  e.degree = e.univ.tier === 'D' ? 'college' : 'university';
}

// ── 직업 ─────────────────────────────────────────────────

export function jobSalary(job: JobDef, years: number, priceIndex: number, raise: number): number {
  const [start, peak] = job.salary;
  const base = start + (peak - start) * Math.min(1, years / 25);
  return Math.round(base * priceIndex * raise);
}

export function meetsJob(state: GameState, job: JobDef): boolean {
  const ch = state.ch;
  if (ch.age < job.minAge || (job.maxAge !== undefined && ch.age > job.maxAge)) return false;
  if (ch.age >= job.retireAge) return false;
  if (DEGREE_RANK[ch.edu.degree] < DEGREE_RANK[job.minDegree]) return false;
  if (job.minTier) {
    const t = ch.edu.univ?.tier;
    if (!t || ch.edu.degree !== 'university' || TIER_RANK[t] < TIER_RANK[job.minTier]) return false;
  }
  if (job.req && !evaluate(job.req, buildScope(state))) return false;
  return true;
}

export function hireChance(state: GameState, job: JobDef): number {
  const ch = state.ch;
  let p = job.hire;
  const skill = (ch.stats.intelligence * 0.5 + ch.stats.sociability * 0.3 + ch.stats.looks * 0.2) / 50;
  p *= 0.55 + 0.45 * skill;
  const tier = ch.edu.univ?.tier;
  if (tier && ch.edu.degree === 'university') p *= { S: 1.6, A: 1.3, B: 1.1, C: 1, D: 0.9 }[tier];
  if (ch.flags.criminal_record) p *= 0.45;
  if (ch.flags.certified) p *= 1.15;
  if (ch.age >= 45) p *= 0.65;
  if (ch.age >= 55) p *= 0.6;
  p *= 3 / Math.max(2, state.world.economy.unemployment);
  p *= 1 + ch.res.network / 200;
  return Math.max(0.02, Math.min(0.95, p));
}

/** 올해의 구인 공고 (같은 해에는 같은 목록) */
export function jobOpenings(state: GameState): { job: JobDef; chance: number }[] {
  const rng = rngFor(state.seed, 'jobs', state.ch.age);
  const eligible = JOBS.filter((j) => j.listed && j.id !== state.ch.career.jobId && meetsJob(state, j));
  return rng
    .shuffle([...eligible])
    .slice(0, 5)
    .map((job) => ({ job, chance: hireChance(state, job) }));
}

export function takeJob(state: GameState, jobId: string): JobDef {
  const job = JOB_BY_ID.get(jobId);
  if (!job) throw new Error(`없는 직업: ${jobId}`);
  const c = state.ch.career;
  if (c.jobId) endHistory(state);
  c.jobId = job.id;
  c.title = job.title;
  c.years = 0;
  c.raise = 1;
  c.retired = false;
  c.salary = jobSalary(job, 0, state.world.economy.priceIndex, 1);
  c.history.push({ jobId: job.id, title: job.title, fromAge: state.ch.age });
  delete state.ch.flags.unemployed;
  return job;
}

function endHistory(state: GameState): void {
  const h = state.ch.career.history;
  const last = h[h.length - 1];
  if (last && last.toAge === undefined) last.toAge = state.ch.age;
}

/** 일을 그만둔다. 퇴직금(근속 1년당 한 달 치) + 위로금. 받은 금액을 돌려준다 */
export function leaveJob(state: GameState, extraMonths = 0): number {
  const c = state.ch.career;
  if (!c.jobId) return 0;
  const monthly = c.salary / 12;
  const severance = Math.round(monthly * (c.years + extraMonths));
  endHistory(state);
  c.jobId = undefined;
  c.title = undefined;
  c.salary = 0;
  c.years = 0;
  c.raise = 1;
  state.ch.res.cash += severance;
  return severance;
}

/**
 * 국민연금(가입 기간·평균 소득 비례) + 기초연금. 2026년 원 기준 연간 금액.
 * 물가에 연동되므로 실제로 받는 돈은 해마다 물가지수를 곱한다.
 */
export function computePension(state: GameState): number {
  const c = state.ch.career;
  const pi = state.world.economy.priceIndex;
  let pension = c.avgSalary * Math.min(c.totalYears, 40) * 0.009;
  const basic = 4_000_000;
  const wealth = (state.ch.res.cash + state.ch.res.realEstate + state.ch.res.stocks) / pi;
  if (pension < basic * 2 && wealth < 500_000_000) pension += basic;
  return Math.round(pension);
}

/** 65세 연금 개시. 정년이 남은 직장은 계속 다닌다 */
export function retire(state: GameState): number {
  const c = state.ch.career;
  const job = c.jobId ? JOB_BY_ID.get(c.jobId) : undefined;
  if (c.jobId && !c.business && (!job || job.retireAge <= state.ch.age)) leaveJob(state, 0);
  c.pension = computePension(state);
  c.retired = !c.jobId;
  return Math.round(c.pension * state.world.economy.priceIndex);
}

export function startBusiness(state: GameState, capitalPct: number, name: string): number {
  const r = state.ch.res;
  const capital = Math.round(Math.max(0, r.cash) * capitalPct);
  r.cash -= capital;
  const c = state.ch.career;
  if (c.jobId) leaveJob(state, 0);
  c.business = { name, capital, years: 0 };
  c.jobId = 'self_employed';
  c.title = `${name} 사장`;
  c.salary = 0;
  c.retired = false;
  c.history.push({ jobId: 'self_employed', title: c.title, fromAge: state.ch.age });
  return capital;
}

export function closeBusiness(state: GameState, recoverPct: number): number {
  const c = state.ch.career;
  if (!c.business) return 0;
  const recovered = Math.round(c.business.capital * recoverPct);
  state.ch.res.cash += recovered;
  c.business = undefined;
  endHistory(state);
  c.jobId = undefined;
  c.title = undefined;
  c.salary = 0;
  return recovered;
}

/** 연말: 근속, 연봉 인상, 사업 소득, 연금. 올해 들어온 돈(세후)을 돌려준다 */
export function yearlyEarnings(state: GameState, rng: Rng): number {
  const c = state.ch.career;
  const pi = state.world.economy.priceIndex;
  // 연금은 물가에 연동된다
  const pension = state.ch.age >= 65 ? Math.round(c.pension * pi) : 0;
  if (c.business) {
    c.business.years += 1;
    const phase = state.world.economy.phase;
    const mean = phase === 'boom' ? 1.2 : phase === 'normal' ? 1 : phase === 'recession' ? 0.6 : 0.2;
    const profit = Math.round(28_000_000 * pi * (mean + rng.normal(0, 0.45)));
    c.salary = Math.max(0, profit);
    c.totalYears += 1;
    c.avgSalary += (Math.max(0, profit) / pi - c.avgSalary) / c.totalYears;
    return profit + pension;
  }
  if (c.jobId) {
    const job = JOB_BY_ID.get(c.jobId);
    if (!job) return pension;
    c.years += 1;
    c.totalYears += 1;
    c.salary = jobSalary(job, c.years, pi, c.raise);
    let gross = c.salary;
    if (job.volatility) gross = Math.round(gross * Math.exp(rng.normal(0, job.volatility)));
    c.avgSalary += (gross / pi - c.avgSalary) / c.totalYears;
    return Math.round(gross * (1 - taxRate(gross / pi))) + pension;
  }
  return pension;
}

/** 소득세·4대보험을 뭉뚱그린 실효 세율 (2026년 원 기준) */
export function taxRate(gross2026: number): number {
  if (gross2026 < 30_000_000) return 0.09;
  if (gross2026 < 50_000_000) return 0.14;
  if (gross2026 < 80_000_000) return 0.19;
  if (gross2026 < 150_000_000) return 0.26;
  return 0.33;
}
