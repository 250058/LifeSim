// 학업·진로·직업: 내신과 수능, 대학 등급, 구직, 연봉 곡선, 퇴직금, 연금, 자영업.

import { evaluate, type Scope } from './conditions';
import { JOB_BY_ID, JOBS, REGION_BY_ID, WORLD } from './data';
import { BARRED_JOBS, barredFromJob, publicSectorBarred, recordHireFactor } from './records';
import { rngFor, type Rng } from './rng';
import type { JobDef } from './schema';
import { ELITE_HIGH } from './format';
import type { Character, Degree, ExitReason, GameState, HighType, UnivTier } from './types';
import {
  canStart,
  currentType,
  degreeOk,
  endWork,
  extraRequirementsOk,
  fieldExperience,
  hasLicense,
  hasSeverance,
  isTrained,
  lastField,
  LICENSE_BY_ID,
  offerFor,
  payFactor,
  reqScope,
  standardType,
  startWork,
  TRAINING_TRACKS,
  workGross,
  workYearEnd,
  type Offer,
} from './work';

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
    ? `${c.tier === 'D' ? '전문대를' : `${TIER_LABEL[c.tier]} 대학을`} 노려볼 만하다.`
    : '어느 대학도 장담하기 어려운 점수다.';
  return `평균 ${c.grade}등급, 백분위 ${Math.round(c.percentile)}. ${tierText}`;
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

// ── 임용 자격 (R-018) ─────────────────────────────────────
//
// 응시·합격·임용은 다르다. 시험 공부와 응시는 결격 기간에도 막지 않고(gongsi_exam), 합격 여부는 사건의 판정이
// 정한다. 아래의 공통 자격은 직업이 실제로 바뀌는 순간(임용·채용)에만, 그리고 모든 경로에 똑같이 적용한다:
// 공고 지원·직접 지원·지인 추천·경력 복귀(game.ts applyForJob), 사건의 getJob(공채 합격 뒤 임용·마이스터고 채용·
// 현장실습·드래프트·데뷔·공공 일자리·눈높이를 낮춘 취업), 후계자 생성(heir.ts), 창업(startBusiness), 부업.
// 모두 takeJob 안에서 이 판정을 받고, 걸리면 지금 하던 일·이력·연봉이 그대로다.

/** 임용 자격 한 줄: 화면의 지원 조건 목록과 '채용되지 않은 까닭'에 그대로 쓴다 */
export interface AppointCheck {
  kind: 'age' | 'degree' | 'license' | 'barred';
  label: string;
  ok: boolean;
}

/**
 * 판결 때문에 이 직업에 임용될 수 없는가. records.ts의 결격 직업(barredFromJob: 9급 공무원·교사·부사관·공기업
 * 기술직·변호사)에 더해, 직업 정의에 publicBar가 붙은 공무원·군인·교원·공공기관 일자리도 같은 공공 부문
 * 결격 기간(국가공무원법 33조, 소년법 67조 예외 포함)을 따른다
 */
export function jobBarred(ch: Character, job: JobDef): boolean {
  return barredFromJob(ch, job.id) || (job.publicBar === true && publicSectorBarred(ch));
}

/** 판결에 따른 결격 기간이 적용되는 직업인가 (화면 안내용. 지금 결격인지는 jobBarred) */
export function barRuleApplies(job: JobDef): boolean {
  return job.publicBar === true || BARRED_JOBS.includes(job.id);
}

/**
 * 임용 직전의 공통 자격: 나이(최소·최대, 정년 전), 학력(또는 그 분야 직업훈련 이수), 필수 면허·자격,
 * 판결에 따른 결격. 대학 등급·고교 유형·같은 분야 경력·작품·능력치 조건은 채용 관행(선발 기준)이라
 * 공고 자격(meetsJob)에서만 본다. 사건이 정한 채용(드래프트·마이스터고 채용 등)은 그 선발을 사건이 대신한다
 */
export function appointChecks(state: GameState, job: JobDef): AppointCheck[] {
  const ch = state.ch;
  const out: AppointCheck[] = [];
  const ageLabel = job.maxAge !== undefined ? `${job.minAge}~${job.maxAge}세` : `${job.minAge}세 이상`;
  const inRange = ch.age >= job.minAge && (job.maxAge === undefined || ch.age <= job.maxAge);
  out.push({ kind: 'age', label: inRange && ch.age >= job.retireAge ? `${job.retireAge}세 정년 전` : ageLabel, ok: inRange && ch.age < job.retireAge });
  if (job.minDegree !== 'none') {
    const alt = job.training ? ` (또는 ${TRAINING_TRACKS[job.training]?.label ?? job.training} 이수)` : '';
    out.push({ kind: 'degree', label: `${DEGREE_LABEL[job.minDegree]} 이상${alt}`, ok: degreeOk(ch, job) });
  }
  for (const id of job.licenses ?? []) out.push({ kind: 'license', label: LICENSE_BY_ID.get(id)?.name ?? id, ok: hasLicense(ch, id) });
  if (jobBarred(ch, job)) out.push({ kind: 'barred', label: '결격 기간 (판결)', ok: false });
  return out;
}

/** 임용을 막는 까닭 (없으면 빈 목록) */
export function appointIssues(state: GameState, job: JobDef): AppointCheck[] {
  return appointChecks(state, job).filter((c) => !c.ok);
}

/**
 * 지금 이 직업에 임용·채용될 수 있는가 (모든 진입 경로의 공통 자격). appointChecks와 같은 규칙을 문장 없이
 * 빠르게 본다: 공고 목록이 해마다 직업 수백 개를 훑는다 (두 함수가 같은 답을 내는지는 tests/jobs.test.ts가 본다)
 */
export function canAppoint(state: GameState, job: JobDef): boolean {
  const ch = state.ch;
  if (ch.age < job.minAge || (job.maxAge !== undefined && ch.age > job.maxAge) || ch.age >= job.retireAge) return false;
  if (!degreeOk(ch, job)) return false;
  if (job.licenses && !job.licenses.every((id) => hasLicense(ch, id))) return false;
  return !jobBarred(ch, job);
}

export function meetsJob(state: GameState, job: JobDef): boolean {
  return meetsJobWith(state, job, () => reqScope(state));
}

/**
 * 공고 자격 = 임용 자격(canAppoint) + 선발 기준(대학 등급·고교 유형·경력·작품·능력치 조건식).
 * 조건식 범위는 필요할 때 한 번만 만든다 (공고 목록이 직업 수백 개를 훑는다)
 */
function meetsJobWith(state: GameState, job: JobDef, scope: () => Scope): boolean {
  const ch = state.ch;
  if (!canAppoint(state, job)) return false;
  if (job.minTier) {
    const t = ch.edu.univ?.tier;
    if (!t || ch.edu.degree !== 'university' || TIER_RANK[t] < TIER_RANK[job.minTier]) return false;
  }
  if (!extraRequirementsOk(ch, job)) return false;
  if (job.req && !evaluate(job.req, scope())) return false;
  return true;
}

export function hireChance(state: GameState, job: JobDef): number {
  const ch = state.ch;
  let p = job.hire;
  const skill = (ch.stats.intelligence * 0.5 + ch.stats.sociability * 0.3 + ch.stats.looks * 0.2) / 50;
  p *= 0.55 + 0.45 * skill;
  const tier = ch.edu.univ?.tier;
  if (tier && ch.edu.degree === 'university') p *= { S: 1.6, A: 1.3, B: 1.1, C: 1, D: 0.9 }[tier];
  p *= recordHireFactor(ch); // 처분 종류·경과 기간별 (records.ts)
  if (ch.flags.certified) p *= 1.15;
  if (ch.flags.interview_ready) p *= 1.15;
  if (ch.flags.bankrupt) p *= 0.85;
  // 나이: 경비·청소·돌봄·운전·농업처럼 나이 든 사람을 많이 뽑는 일은 45·55세 감점이 없다.
  // 65세가 넘으면 어떤 일이든 새로 붙기는 점점 어렵다
  if (!job.ageFriendly) {
    if (ch.age >= 45) p *= 0.65;
    if (ch.age >= 55) p *= 0.6;
  }
  if (ch.age >= 60) p *= 0.6;
  if (ch.age >= 65) p *= 0.6;
  if (ch.age >= 70) p *= 0.6;
  if (ch.age >= 75) p *= 0.6;
  // 우대 자격: 하나에 15%, 최대 30%
  const preferred = (job.prefers ?? []).filter((id) => hasLicense(ch, id)).length;
  if (preferred > 0) p *= 1 + Math.min(0.3, 0.15 * preferred);
  // 같은 분야 경력: 해마다 4%, 10년까지
  const exp = fieldExperience(ch, job.expField ?? job.field);
  if (exp > 0) p *= 1 + 0.04 * Math.min(10, exp);
  if (isTrained(ch, job.training)) p *= 1.15;
  // 구직 공백: 2년째부터 해마다 8%씩 (최대 40%)
  const gap = ch.flags.unemployed ? ch.age - ch.flags.unemployed.since : 0;
  if (gap >= 2) p *= Math.max(0.6, 1 - 0.08 * (gap - 1));
  p *= 3 / Math.max(2, state.world.economy.unemployment);
  p *= 1 + ch.res.network / 200;
  return Math.max(0.02, Math.min(0.95, p));
}

/** 한 해에 보이는 공고 수 (경력 복귀·지인 추천 공고는 따로 더한다) */
export const POSTINGS = 8;

/** 학력 눈높이를 재는 단계 (중졸 이하 / 고졸 / 전문대졸 / 대졸) */
const LEVEL: Record<Degree, number> = { none: 0, elementary: 0, middle: 0, high: 1, college: 2, university: 3 };

export interface JobOpening {
  job: JobDef;
  chance: number;
  /** 올해 이 직업이 내미는 조건: 고용 형태·근로시간·첫해 연봉·개업 자금 */
  offer?: Offer;
  /** 경력 복귀(그만둔 일과 같은 직업) 또는 지인 추천 */
  via?: 'return' | 'referral';
}

/** 공고 무게를 정하는 그 사람의 사정 (공고 목록 한 번에 한 번만 읽는다) */
interface Seeker {
  age: number;
  level: number;
  jobless: number;
  last: string;
  metro: boolean;
}

/**
 * 공고 무게: 취업자 규모 × 학력 눈높이 × 같은 분야 × 나이대 × 지역. 학력보다 한참 낮은 일의 공고는
 * 덜 찾아볼 뿐이고, 찾아보기에서 직접 지원할 수는 있다 (applyForJob)
 */
function postingWeight(s: Seeker, job: JobDef): number {
  let w = job.workers ?? 50;
  // 구직이 길어지면 눈높이를 낮춰 더 아래 단계의 공고까지 찾아본다
  const gap = s.level - LEVEL[job.minDegree];
  w *= gap <= 0 ? 1 : gap === 1 ? 0.5 : gap === 2 ? (s.jobless >= 1 ? 0.4 : 0.15) : s.jobless >= 2 ? 0.15 : 0.03;
  if (job.field && job.field === s.last) w *= 2;
  if (job.ageFriendly) w *= s.age < 40 ? 0.5 : s.age >= 55 ? 1.6 : 1;
  if (job.field === 'agri' && s.metro) w *= 0.3;
  return w;
}

/** 나이가 들수록 찾아지는 공고가 줄어든다 */
function postingCount(age: number): number {
  return age >= 70 ? 1 : age >= 65 ? 2 : age >= 60 ? 3 : POSTINGS;
}

/** 그해 직업마다 받는 균등 난수 (직업 목록 순서대로 한 줄기에서 뽑는다. 같은 시드·나이면 늘 같다) */
const yearDraws = new Map<string, Float64Array>();
function postingDraws(seed: string, age: number): Float64Array {
  const key = `${seed}|${age}`;
  let u = yearDraws.get(key);
  if (!u) {
    const rng = rngFor(seed, 'jobs', age);
    u = new Float64Array(JOBS.length);
    for (let i = 0; i < JOBS.length; i++) u[i] = rng.next();
    // 순수 계산의 캐시라 비워도 결과는 같다
    if (yearDraws.size >= 64) yearDraws.clear();
    yearDraws.set(key, u);
  }
  return u;
}

/**
 * 올해의 구인 공고 (같은 해에는 같은 목록). 자격이 되는 직업 가운데 공고 무게대로 8개를 뽑는다.
 * 직업마다 그해 열쇠를 따로 받는 가중 비복원 추첨이라, 면허를 따서 자격이 하나 늘어도 다른 공고는 남는다.
 * 실직 중이면 그만둔 직업(경력 복귀), 지인 추천을 받았으면 추천 자리가 더 붙는다
 */
export function jobOpenings(state: GameState): JobOpening[] {
  // 나이 조건을 넘는 공고가 하나도 없으면 (대개 일흔이 넘은 사람) 난수도 뽑지 않는다. 결과는 같다
  if (listedForAge(state.ch.age).length === 0) return [];
  // 같은 상태로 다시 물으면 (지원 직전 확인, 화면 다시 그리기) 계산을 되풀이하지 않는다
  const memoKey = openingsKey(state);
  const memo = openingsMemo.get(state);
  if (memo && memo.key === memoKey) return memo.result.slice();
  const result = computeOpenings(state);
  openingsMemo.set(state, { key: memoKey, result });
  return result.slice();
}

/** 공고 계산 결과의 캐시: 상태 객체마다 하나. 열쇠가 같으면 입력이 같아 결과도 같다 */
const openingsMemo = new WeakMap<GameState, { key: string; result: JobOpening[] }>();

/**
 * 공고가 읽는 상태를 모두 담은 열쇠: 나이·학력·지역·이력·면허·훈련·재능·능력치·돈·인맥·구직 태그·사법 기록·부모·
 * 그만둔 일·실업률·물가. 직업 조건식(req)은 능력치만 읽는다 (tests/jobs.test.ts가 검사한다)
 */
function openingsKey(state: GameState): string {
  const ch = state.ch;
  const w = ch.career.work;
  const f = ch.flags;
  const lic = w?.licenses ? Object.entries(w.licenses).map(([id, r]) => `${id}:${r.passed ?? ''}:${r.lapsed ? 1 : 0}`) : [];
  return [
    state.seed,
    ch.age,
    ch.career.jobId ?? '',
    ch.edu.degree,
    ch.edu.univ?.tier ?? '',
    ch.edu.highType ?? '',
    ch.region,
    ch.career.history.map((h) => `${h.jobId}:${h.fromAge}:${h.toAge ?? ''}`).join(','),
    lic.join(','),
    (w?.trained ?? []).join(','),
    ch.talents.map((t) => (t.discovered ? t.key : '')).join(','),
    Object.values(ch.stats).join(','),
    ch.res.cash,
    ch.res.network,
    [f.unemployed?.since, f.work_referral?.since, f.certified?.since, f.interview_ready?.since, f.bankrupt?.since, f.criminal_record?.since].join(','),
    JSON.stringify(ch.legal),
    ch.npcs.filter((n) => n.alive && (n.role === 'mother' || n.role === 'father')).length,
    w?.exit?.jobId ?? '',
    state.world.economy.unemployment,
    state.world.economy.priceIndex,
  ].join('|');
}

/** 나이별로 공고에 나올 수 있는 직업의 순번 (공고에 나오는 직업 중 나이·정년 조건만 본 색인. 나이마다 한 번 만든다) */
const ageIndex = new Map<number, number[]>();
function listedForAge(age: number): number[] {
  let list = ageIndex.get(age);
  if (!list) {
    list = [];
    for (let i = 0; i < JOBS.length; i++) {
      const j = JOBS[i];
      if (j.listed && age >= j.minAge && (j.maxAge === undefined || age <= j.maxAge) && age < j.retireAge) list.push(i);
    }
    ageIndex.set(age, list);
  }
  return list;
}

function computeOpenings(state: GameState): JobOpening[] {
  const ch = state.ch;
  let scope: Scope | undefined;
  // 직업 조건식은 능력치만 읽는다: 전체 범위(buildScope) 대신 가벼운 범위를 한 번만 만든다
  const lazyScope = () => (scope ??= reqScope(state));
  const last = lastField(ch);
  const seeker: Seeker = {
    age: ch.age,
    level: LEVEL[ch.edu.degree],
    jobless: ch.flags.unemployed ? ch.age - ch.flags.unemployed.since : 0,
    last,
    metro: Boolean(REGION_BY_ID.get(ch.region)?.metro),
  };
  const draws = postingDraws(state.seed, ch.age);
  const cands: { job: JobDef; key: number }[] = [];
  // 나이 조건으로 먼저 거른 직업만 자세히 본다 (은퇴 뒤에도 해마다 묻는 봇이 직업 수백 개를 다 훑지 않게).
  // 열쇠는 직업 목록 순서의 난수를 그대로 쓰므로 결과는 전부 훑을 때와 같다
  for (const i of listedForAge(ch.age)) {
    const job = JOBS[i];
    if (job.id === ch.career.jobId || !meetsJobWith(state, job, lazyScope) || !canStart(state, job)) continue;
    const w = postingWeight(seeker, job);
    if (w > 0) cands.push({ job, key: -Math.log(1 - draws[i]) / w });
  }
  cands.sort((a, b) => a.key - b.key);
  const posting = (job: JobDef, boost: number, via?: JobOpening['via']): JobOpening => ({
    job,
    offer: offerFor(state, job) ?? undefined,
    chance: Math.min(0.95, hireChance(state, job) * boost),
    ...(via ? { via } : {}),
  });
  const out = cands.slice(0, postingCount(ch.age)).map((c) => posting(c.job, 1));
  const shown = new Set(out.map((o) => o.job.id));
  // 경력 복귀: 실직 중이면 그만둔 일과 같은 직업이 보인다 (경력을 알아 주는 만큼 붙기 쉽다)
  const exit = ch.career.work?.exit;
  const back = exit && ch.flags.unemployed ? cands.find((c) => c.job.id === exit.jobId) : undefined;
  if (back && !shown.has(back.job.id)) {
    out.push(posting(back.job, 1.25, 'return'));
    shown.add(back.job.id);
  }
  // 지인 추천: 남은 후보 중 같은 분야를 먼저 (추천서가 붙어 합격 가능성이 높다)
  if (ch.flags.work_referral) {
    const rest = cands.filter((c) => !shown.has(c.job.id));
    const pick = rest.find((c) => c.job.field === last) ?? rest[0];
    if (pick) out.push(posting(pick.job, 1.6, 'referral'));
  }
  return out;
}

/**
 * 직업을 얻는다. 직업 상태를 바꾸기 직전에 임용 자격(appointIssues)을 다시 본다: 하나라도 걸리면 아무것도
 * 바꾸지 않고 null을 돌려준다 (지금 하던 일·이력·연봉·부업·구직 태그 그대로). 까닭은 appointIssues로 읽는다
 */
export function takeJob(state: GameState, jobId: string): JobDef | null {
  const job = JOB_BY_ID.get(jobId);
  if (!job) throw new Error(`없는 직업: ${jobId}`);
  if (!canAppoint(state, job)) return null;
  const c = state.ch.career;
  if (c.jobId) endHistory(state);
  c.jobId = job.id;
  c.title = job.title;
  c.years = 0;
  c.raise = 1;
  c.retired = false;
  c.salary = jobSalary(job, 0, state.world.economy.priceIndex, 1);
  c.history.push({ jobId: job.id, title: job.title, fromAge: state.ch.age });
  // 고용 형태·근로시간·계약 기간 (work.ts): 첫해 연봉도 형태에 맞게 고친다
  startWork(state, job);
  delete state.ch.flags.unemployed;
  return job;
}

function endHistory(state: GameState): void {
  const h = state.ch.career.history;
  const last = h[h.length - 1];
  if (last && last.toAge === undefined) last.toAge = state.ch.age;
}

/**
 * 일을 그만둔다. 퇴직금(근로자만: 근속 1년당 한 달 치) + 위로금. 받은 금액을 돌려준다.
 * 플랫폼·프리랜서·일용·자영업·가족종사는 퇴직금이 없다. 그만둔 까닭(reason)을 주지 않으면
 * 상태로 짐작해 남긴다 (구직급여 자격과 경력 복귀, work.ts)
 */
export function leaveJob(state: GameState, extraMonths = 0, reason?: ExitReason): number {
  const c = state.ch.career;
  if (!c.jobId) return 0;
  const monthly = c.salary / 12;
  const type = currentType(state);
  const months = (type && !hasSeverance(type) ? 0 : c.years) + extraMonths;
  const severance = Math.round(monthly * months);
  endWork(state, extraMonths, reason);
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

/** 창업. 자영업 정의(self_employed)의 임용 자격을 같은 규칙으로 보고, 걸리면 돈도 일도 그대로 두고 0을 돌려준다 */
export function startBusiness(state: GameState, capitalPct: number, name: string): number {
  const self = JOB_BY_ID.get('self_employed');
  if (self && !canAppoint(state, self)) return 0;
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
  // 폐업도 실직 기록으로 남긴다 (경력 복귀 공고, 구직급여는 자영업이라 없다)
  endWork(state, 0, 'closed');
  c.business = undefined;
  endHistory(state);
  c.jobId = undefined;
  c.title = undefined;
  c.salary = 0;
  return recovered;
}

/**
 * 연말: 근속, 연봉 인상, 사업 소득, 연금. 올해 들어온 돈(세후)을 돌려준다.
 * 본업 소득은 고용 형태대로 출렁이고(일용직 날수·플랫폼·프리랜서·자영업, work.ts), 이어서 일터 정리
 * (계약 판정·체불·산재·부업·구직급여·소득 원장)를 한다. 일터 쪽 난수는 따로 써서 이 함수의 난수 순서는 그대로다
 */
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
    return profit + pension + workYearEnd(state, { gross: profit });
  }
  if (c.jobId) {
    const job = JOB_BY_ID.get(c.jobId);
    if (!job) return pension + workYearEnd(state, { gross: 0 });
    c.years += 1;
    c.totalYears += 1;
    c.salary = Math.round(jobSalary(job, c.years, pi, c.raise) * payFactor(job, currentType(state) ?? standardType(job)));
    let gross = c.salary;
    if (job.volatility) gross = Math.round(gross * Math.exp(rng.normal(0, job.volatility)));
    const main = workGross(state, job, gross);
    c.avgSalary += (Math.max(0, main.gross) / pi - c.avgSalary) / c.totalYears;
    // 자영업 적자는 세금 없이 그대로 현금에서 빠진다
    const net = main.gross > 0 ? Math.round(main.gross * (1 - taxRate(main.gross / pi))) : main.gross;
    return net + pension + workYearEnd(state, main);
  }
  return pension + workYearEnd(state, { gross: 0 });
}

/** 소득세·4대보험을 뭉뚱그린 실효 세율 (2026년 원 기준) */
export function taxRate(gross2026: number): number {
  if (gross2026 < 30_000_000) return 0.09;
  if (gross2026 < 50_000_000) return 0.14;
  if (gross2026 < 80_000_000) return 0.19;
  if (gross2026 < 150_000_000) return 0.26;
  return 0.33;
}
