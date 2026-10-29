// 일터: 고용 형태·근로시간·계약·소득의 출렁임·부업·면허/자격·직업훈련·실직과 복귀.
// career.ts는 채용과 연봉 곡선을, 이 파일은 '어떤 조건으로 어떻게 일하는가'를 맡는다.
//
//   형태        받는 몫(표준 대비)  계약   구직급여        퇴직금  해마다의 소득
//   정규직      1                   없음   ○               ○       연봉 곡선 (직업 고유 변동만)
//   계약직      0.9                 2년    ○               ○       〃
//   파견·용역   0.85                2년    ○               ○       〃
//   시간제      근로시간 비례        1년    ○               ○       〃
//   일용직      일한 날만큼          없음   ○               ×       일감 날수 (경기·체력·작업반)
//   플랫폼      1                   없음   ○ (노무제공자)   ×       로그정규 σ 0.3
//   프리랜서    1                   없음   ×               ×       로그정규 σ 0.4, 일감이 끊기는 해
//   자영업      1                   없음   ×               ×       경기 평균 + 정규 σ 0.35 (적자 가능)
//   가족종사    0.35 (생활비 몫)     없음   ×               ×       나머지 일의 값 일부는 가업(부모 재산)에 쌓인다
//
// 배수와 확률은 게임 보정값이다. 제도의 근거와 단순화한 부분은 docs/review/JOBS.md에 적었다.
// 난수는 모두 이 파일만의 줄기(rngFor(seed, 'work-…'))를 써서 다른 판정의 난수 순서를 바꾸지 않는다.
// 사건 카드는 효과로 '의사 표시 태그'(work_*)만 붙이고, 실제 계약·소득·면허 처리는 연말에 여기서 한다.

import { evaluate, type Scope } from './conditions';
import { appointChecks, DEGREE_LABEL, DEGREE_RANK, jobBarred, jobSalary, leaveJob, meetsJob, TIER_LABEL, TIER_RANK } from './career';
import { JOB_BY_ID, JOB_TABLES } from './data';
import { addFlag, changeAttr } from './effects';
import { formatWon, HIGH_TYPE_LABEL, josa } from './format';
import type { ActionResult } from './game';
import { alive, changeCloseness } from './relations';
import { rngFor, type Rng } from './rng';
import type { JobDef } from './schema';
import { TALENT_LABEL } from './text';
import type {
  Change,
  Character,
  Degree,
  EmploymentType,
  ExitReason,
  GameState,
  LicenseRecord,
  LogEntry,
  Tone,
  WorkSchedule,
  WorkState,
  WorkYear,
} from './types';

// ── 표 ───────────────────────────────────────────────────

/** 직업 분야 (계획서의 17개 묶음) */
export interface JobFieldDef {
  id: string;
  label: string;
  /** 이 분야가 주로 걸치는 KSCO 대분류 */
  ksco: string[];
  desc?: string;
}

/** 면허·자격 */
export interface LicenseDef {
  id: string;
  name: string;
  /** 국가기술자격·국가전문자격·면허·교육 이수·민간자격 */
  kind: string;
  field: string;
  minAge: number;
  minDegree?: Degree;
  /** 먼저 있어야 하는 면허 */
  needs?: string[];
  /** 응시 자격: 같은 분야 경력 */
  exp?: { field: string; years: number };
  /** 그 밖의 조건식 */
  req?: string;
  /** 한 번 응시(교육 포함)에 드는 돈 (2026년 원) */
  cost: number;
  /** 한 번 응시에 드는 시간 포인트 */
  points: number;
  /** 평범한 사람(지능 50)의 첫 응시 합격률 (게임 근사) */
  pass: number;
  /** 떨어질 때마다 다음 합격률에 더해지는 비율 (최대 4번까지) */
  learn?: number;
  /** n년마다 갱신 (적성검사) */
  renew?: number;
  /** 교육 과정을 마치고 보는 시험 */
  course?: boolean;
  note?: string;
}

export const JOB_FIELDS: JobFieldDef[] = JOB_TABLES.fields as JobFieldDef[];
export const FIELD_BY_ID: Map<string, JobFieldDef> = new Map(JOB_FIELDS.map((f) => [f.id, f]));
export const LICENSES: LicenseDef[] = JOB_TABLES.licenses as LicenseDef[];
export const LICENSE_BY_ID: Map<string, LicenseDef> = new Map(LICENSES.map((l) => [l.id, l]));
export const JOB_SOURCES: Record<string, string> = JOB_TABLES.sources;

export const TYPE_LABEL: Record<EmploymentType, string> = {
  regular: '정규직',
  contract: '계약직',
  dispatch: '파견·용역',
  daily: '일용직',
  parttime: '시간제',
  platform: '플랫폼',
  freelance: '프리랜서',
  self: '자영업',
  family: '가족종사',
};

export const SCHEDULE_LABEL: Record<WorkSchedule, string> = {
  day: '주간',
  shift: '교대',
  night: '야간',
  remote: '재택',
  field: '현장',
  travel: '출장',
  seasonal: '계절',
  irregular: '불규칙',
};

/** 직업훈련 과정: 국민내일배움카드로 듣는 과정을 묶었다. 본인 부담은 2026년 원 근사 */
export const TRAINING_TRACKS: Record<string, { label: string; cost: number; points: number; license?: string[]; desc: string }> = {
  care: { label: '요양보호사 과정', cost: 300_000, points: 1, license: ['care_cert'], desc: '이론·실습 320시간. 마치면 요양보호사 시험' },
  it: { label: 'IT 국비 과정', cost: 500_000, points: 2, desc: '6개월 개발 실무. 학력 대신 훈련 이수로 지원할 수 있는 개발 일자리가 열린다' },
  trade: { label: '용접·전기 기능 과정', cost: 400_000, points: 1, license: ['electrician', 'welder'], desc: '실습 위주 4개월. 마치면 기능사 시험' },
  office: { label: '사무·회계 과정', cost: 200_000, points: 1, license: ['accounting'], desc: '전산회계와 문서 실무 3개월' },
  drive: { label: '대형 운전 과정', cost: 600_000, points: 1, license: ['driver_1', 'driver_large'], desc: '대형 면허와 운수 자격 준비' },
};

// ── 고용 형태의 규칙 ──────────────────────────────────────

/** 표준 형태 대비 받는 몫 (시간제는 근로시간으로 따로 계산) */
const TYPE_PAY: Record<EmploymentType, number> = {
  regular: 1,
  contract: 0.9,
  dispatch: 0.85,
  daily: 1,
  parttime: 1,
  platform: 1,
  freelance: 1,
  self: 1,
  family: 0.35,
};
/** 고용주가 있는 일 (임금 체불·공상 처리·작업 중지 요구가 성립한다) */
const EMPLOYEE_TYPES: ReadonlySet<EmploymentType> = new Set(['regular', 'contract', 'dispatch', 'parttime', 'daily']);
/** 조직에 속한 일 (회식·인사 발표가 어울린다) */
const ORG_TYPES: ReadonlySet<EmploymentType> = new Set(['regular', 'contract', 'dispatch', 'parttime']);
/** 구조조정(희망퇴직) 대상이 되는 형태 */
const LAYOFF_TYPES: ReadonlySet<EmploymentType> = new Set(['regular', 'contract']);
/** 고용보험 구직급여 대상 (플랫폼은 2022년부터 노무제공자로 적용) */
const INSURED_TYPES: ReadonlySet<EmploymentType> = new Set(['regular', 'contract', 'dispatch', 'parttime', 'daily', 'platform']);
/** 산재보험 대상 (자영업·무급 가족종사는 임의가입이라 빼고, 프리랜서는 일부 직종만이라 뺐다) */
const INJURY_COVER_TYPES: ReadonlySet<EmploymentType> = new Set(['regular', 'contract', 'dispatch', 'parttime', 'daily', 'platform']);
/** 퇴직금 (1년 이상 계속 근로) */
const SEVERANCE_TYPES: ReadonlySet<EmploymentType> = new Set(['regular', 'contract', 'dispatch', 'parttime']);
/** 구직급여를 받을 수 있는 이직 사유 (비자발적 이직과 정당한 이직 사유) */
const INVOLUNTARY: ReadonlySet<ExitReason> = new Set(['layoff', 'contract_end', 'injury', 'arrears', 'deactivated', 'retire']);

const FULL_HOURS = 40;
const PART_HOURS = 20;
/** 부업의 주당 시간 상한 */
const SIDE_HOURS = 15;
/** 본업과 부업을 합쳐 버틸 수 있는 주당 시간 */
export const MAX_WEEK_HOURS = 72;
/** 일용직 연봉(salary)은 한 해 220일 일한 기준이다 */
const DAILY_BASE_DAYS = 220;
/** 소득 원장에 남기는 해 수 */
const LEDGER_MAX = 100;

/** 경기에 따른 평균: 일용직 일감 날수, 프리랜서·자영업 소득 */
const ECON = {
  days: { boom: 1.1, normal: 1, recession: 0.85, crisis: 0.7 },
  freelance: { boom: 1.1, normal: 1, recession: 0.85, crisis: 0.7 },
  self: { boom: 1.15, normal: 1, recession: 0.75, crisis: 0.5 },
} as const;

/** 구직급여 하루치 (2026년 원): 하한은 최저임금 80% × 8시간, 상한은 2026년 기사 기준 68,100원 (추정, 공식 고시 원문 미대조) */
const BENEFIT_FLOOR = 66_048;
const BENEFIT_CAP = 68_100;

// ── 기본 읽기 ────────────────────────────────────────────

/** 일하는 방식 기록. 없으면 만든다 (쓰기 전용: 읽기만 할 때는 career.work?.… 로 읽는다) */
export function workOf(ch: Character): WorkState {
  return (ch.career.work ??= {});
}

/** 이 직업의 표준 고용 형태 (employment의 첫 항목. 없으면 정규직, 자영업 자리 표시는 자영업) */
export function standardType(job: JobDef): EmploymentType {
  const first = job.employment ? (Object.keys(job.employment)[0] as EmploymentType | undefined) : undefined;
  return first ?? (job.id === 'self_employed' ? 'self' : 'regular');
}

/** 지금 일자리의 고용 형태. 옛 저장처럼 기록이 없으면 직업의 표준 형태로 읽는다 */
export function currentType(state: GameState): EmploymentType | undefined {
  const c = state.ch.career;
  if (!c.jobId) return undefined;
  if (c.business) return 'self';
  const job = JOB_BY_ID.get(c.jobId);
  return c.work?.type ?? (job ? standardType(job) : 'regular');
}

/** 고용 형태별 주당 시간: 시간제로 뽑으면 줄고, 시간제가 표준인 일을 다른 형태로 하면 전일제가 된다 */
export function hoursFor(job: JobDef, type: EmploymentType): number {
  const h = job.hours ?? FULL_HOURS;
  const std = standardType(job);
  if (type === 'parttime') return std === 'parttime' ? h : Math.min(h, PART_HOURS);
  return std === 'parttime' ? Math.max(h, FULL_HOURS) : h;
}

export function currentHours(state: GameState): number {
  const c = state.ch.career;
  if (!c.jobId) return 0;
  const job = JOB_BY_ID.get(c.jobId);
  if (!job) return FULL_HOURS;
  return c.work?.hours ?? hoursFor(job, currentType(state) ?? standardType(job));
}

function typeRate(job: JobDef, type: EmploymentType): number {
  // 시간제의 시간당 임금은 전일제보다 조금 낮다 (고용형태별근로실태조사의 격차를 뭉뚱그린 근사)
  if (type === 'parttime') return (hoursFor(job, 'parttime') / FULL_HOURS) * 0.95;
  return TYPE_PAY[type];
}

/** 같은 직업이라도 고용 형태에 따라 받는 몫 (표준 형태 = 1) */
export function payFactor(job: JobDef, type: EmploymentType): number {
  const std = standardType(job);
  return type === std ? 1 : typeRate(job, type) / typeRate(job, std);
}

/** 계약 기간 (년). 기간의 정함이 없으면 0 */
export function contractTerm(job: JobDef, type: EmploymentType): number {
  if (type === 'contract' || type === 'dispatch') return job.contractYears ?? 2;
  if (type === 'parttime') return 1;
  return 0;
}

export function isInsured(type: EmploymentType): boolean {
  return INSURED_TYPES.has(type);
}

export function hasSeverance(type: EmploymentType): boolean {
  return SEVERANCE_TYPES.has(type);
}

/** 개업·장비 자금이 드는 형태인가 (자영업, 장비를 가진 프리랜서·지입) */
function needsCapital(job: JobDef, type: EmploymentType): boolean {
  return Boolean(job.capital) && (type === 'self' || type === 'freelance');
}

/** 이 사람이 이 일을 이 형태로 시작할 형편이 되는가 */
function typeFeasible(state: GameState, job: JobDef, type: EmploymentType): boolean {
  const ch = state.ch;
  // 무급 가족종사: 함께 일할 부모가 살아 있어야 한다
  if (type === 'family') return ch.age <= 60 && alive(ch, 'mother', 'father').length > 0;
  // 개업 자금: 30%는 현금으로 있어야 한다 (나머지는 사업 대출)
  if (needsCapital(job, type)) return ch.res.cash >= job.capital! * state.world.economy.priceIndex * 0.3;
  return true;
}

/** 이 직업을 시작할 수 있는 형태가 하나라도 있는가 (offerFor의 난수 없이 빠르게 본다) */
export function canStart(state: GameState, job: JobDef): boolean {
  const mix = job.employment;
  if (!mix) return true;
  for (const t in mix) {
    if ((mix[t as EmploymentType] ?? 0) > 0 && typeFeasible(state, job, t as EmploymentType)) return true;
  }
  return false;
}

export interface Offer {
  type: EmploymentType;
  hours: number;
  /** 시작할 때 낼 개업·장비 자금 (그해 명목 원) */
  capital: number;
  /** 첫해 연봉 (그해 명목 원) */
  salary: number;
}

/** 올해 이 직업이 내게 내미는 조건. 같은 해·같은 직업이면 늘 같다. 할 수 있는 형태가 없으면 null */
export function offerFor(state: GameState, job: JobDef): Offer | null {
  const mix = Object.entries(job.employment ?? { [standardType(job)]: 1 }).filter(
    ([t, w]) => (w ?? 0) > 0 && typeFeasible(state, job, t as EmploymentType),
  ) as [EmploymentType, number][];
  if (mix.length === 0) return null;
  const rng = rngFor(state.seed, 'work-offer', state.ch.age, job.id);
  const type = rng.weighted(mix, ([, w]) => w)![0];
  const pi = state.world.economy.priceIndex;
  return {
    type,
    hours: hoursFor(job, type),
    capital: needsCapital(job, type) ? Math.round(job.capital! * pi) : 0,
    salary: Math.round(jobSalary(job, 0, pi, 1) * payFactor(job, type)),
  };
}

// ── 경력·자격 읽기 ───────────────────────────────────────

/** 분야별 경력 햇수 (career.history로 센다. 지금 일도 포함) */
export function fieldExperience(ch: Character, field: string | undefined): number {
  if (!field) return 0;
  let years = 0;
  for (const h of ch.career.history) {
    const job = JOB_BY_ID.get(h.jobId);
    if (!job || (job.expField ?? job.field) !== field) continue;
    years += Math.max(0, (h.toAge ?? ch.age) - h.fromAge);
  }
  return years;
}

/** 가장 최근에 그만둔 일의 분야 */
export function lastField(ch: Character): string {
  const h = ch.career.history;
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].toAge !== undefined) return JOB_BY_ID.get(h[i].jobId)?.field ?? 'none';
  }
  return 'none';
}

/** 효력 있는 면허·자격 */
export function hasLicense(ch: Character, id: string): boolean {
  const r = ch.career.work?.licenses?.[id];
  return Boolean(r && r.passed !== undefined && !r.lapsed);
}

export function isTrained(ch: Character, track: string | undefined): boolean {
  return Boolean(track && ch.career.work?.trained?.includes(track));
}

/** 학력 조건: 모자라도 그 분야 직업훈련을 마쳤으면 된다 */
export function degreeOk(ch: Character, job: JobDef): boolean {
  return DEGREE_RANK[ch.edu.degree] >= DEGREE_RANK[job.minDegree] || isTrained(ch, job.training);
}

/** 임용 자격(나이·학력·면허·결격, career.ts appointChecks) 밖의 선발 기준: 고교 유형, 경력, 작품 */
export function extraRequirementsOk(ch: Character, job: JobDef): boolean {
  if (job.highTypes && !(ch.edu.highType && job.highTypes.includes(ch.edu.highType))) return false;
  if (job.minExp && fieldExperience(ch, job.expField ?? job.field) < job.minExp) return false;
  if (job.portfolio && !ch.talents.some((t) => t.key === job.portfolio && t.discovered)) return false;
  return true;
}

export interface Requirement {
  label: string;
  ok: boolean;
}

/**
 * 화면에 보여 줄 지원 조건과 지금 충족 여부 (meetsJob과 같은 규칙). 앞쪽은 모든 진입 경로가 보는 임용 자격
 * (나이·학력·면허·결격, career.ts appointChecks), 뒤쪽은 공고의 선발 기준이다
 */
export function jobRequirements(state: GameState, job: JobDef, scope?: Scope): Requirement[] {
  const ch = state.ch;
  const out: Requirement[] = appointChecks(state, job).map(({ label, ok }) => ({ label, ok }));
  if (job.minTier) {
    const t = ch.edu.univ?.tier;
    out.push({ label: `${TIER_LABEL[job.minTier]} 이상 대학`, ok: Boolean(t && ch.edu.degree === 'university' && TIER_RANK[t] >= TIER_RANK[job.minTier]) });
  }
  if (job.highTypes) out.push({ label: job.highTypes.map((h) => HIGH_TYPE_LABEL[h]).join('·'), ok: Boolean(ch.edu.highType && job.highTypes.includes(ch.edu.highType)) });
  if (job.minExp) {
    const f = job.expField ?? job.field;
    out.push({ label: `${FIELD_BY_ID.get(f ?? '')?.label ?? '같은 분야'} 경력 ${job.minExp}년`, ok: fieldExperience(ch, f) >= job.minExp });
  }
  if (job.portfolio) out.push({ label: `${TALENT_LABEL[job.portfolio]} 실적(재능 발견)`, ok: ch.talents.some((t) => t.key === job.portfolio && t.discovered) });
  if (job.req) out.push({ label: describeReq(job.req), ok: evaluate(job.req, scope ?? reqScope(state)) });
  return out;
}

/** 조건식 req를 사람이 읽는 말로: 'stats.intelligence >= 60' → '지능 60 이상' */
const REQ_WORDS: Record<string, string> = {
  'stats.intelligence': '지능',
  'stats.stamina': '체력',
  'stats.sociability': '사교성',
  'stats.looks': '외모',
  'stats.health': '건강',
  'stats.happiness': '행복',
};
export function describeReq(req: string): string {
  return req
    .split(/\s*(\|\||&&)\s*/)
    .map((part) => {
      if (part === '&&') return '·';
      if (part === '||') return ' 또는 ';
      const m = /^([a-z.]+)\s*(>=|>|<=|<)\s*(\d+)$/.exec(part.trim());
      if (!m || !REQ_WORDS[m[1]]) return '기타 조건';
      const op = m[2] === '>=' ? '이상' : m[2] === '>' ? '초과' : m[2] === '<=' ? '이하' : '미만';
      return `${REQ_WORDS[m[1]]} ${m[3]} ${op}`;
    })
    .join('');
}

// 조건식(req)용 범위: career.ts의 buildScope를 직접 부르면 순환이 생겨 여기서는 필요한 값만 만든다
function reqScope(state: GameState): Scope {
  const ch = state.ch;
  return { stats: { ...ch.stats }, hidden: { ...ch.hidden }, personality: { ...ch.personality }, age: ch.age };
}

// ── 일을 시작하고 그만둘 때 ───────────────────────────────

function log(state: GameState, title: string, text: string, tone: Tone = 'neutral', impact = 5): void {
  const entry: LogEntry = { year: state.year, age: state.ch.age, kind: 'event', title, text, tone, impact };
  state.log.push(entry);
}

/**
 * takeJob 끝에서 부른다: 그해 조건(offerFor)대로 형태·시간·계약을 정한다. 사건이 정한 채용처럼
 * 조건을 못 고르면 표준 형태로 시작한다. 면허·훈련·원장·체불 기록은 사람에게 남는다
 */
export function startWork(state: GameState, job: JobDef): void {
  const ch = state.ch;
  const w = workOf(ch);
  const type = offerFor(state, job)?.type ?? standardType(job);
  const term = contractTerm(job, type);
  w.type = type;
  w.hours = hoursFor(job, type);
  if (term > 0) w.contractUntil = ch.age + term;
  else delete w.contractUntil;
  w.renewals = 0;
  delete w.ending;
  delete w.standing;
  delete w.capital;
  delete w.injury;
  ch.career.salary = Math.round(ch.career.salary * payFactor(job, type));
  delete ch.flags.work_referral;
  // 부업을 본업으로 삼았거나, 겸직이 금지된 일을 시작하면 부업은 접는다
  if (w.side && (w.side.jobId === job.id || job.noSide)) {
    const side = JOB_BY_ID.get(w.side.jobId)?.title ?? '부업';
    if (w.side.jobId !== job.id) log(state, '부업 정리', `${job.title} 일은 겸직이 금지돼 있어 ${josa(side, '을/를')} 그만뒀다.`);
    delete w.side;
  }
}

/**
 * 개업·장비 자금을 낸다: 모아 둔 돈의 80%까지(최소 자금의 30%) 현금으로, 나머지는 사업 대출.
 * applyForJob이 자영업·지입으로 붙었을 때 부른다
 */
export function payCapital(state: GameState, amount: number): { cash: number; loan: number } {
  const r = state.ch.res;
  const have = Math.max(0, r.cash);
  const cash = Math.min(have, amount, Math.max(amount * 0.3, have * 0.8));
  const loan = amount - cash;
  r.cash -= cash;
  r.debt += loan;
  workOf(state.ch).capital = Math.round(amount / state.world.economy.priceIndex);
  return { cash, loan };
}

/** 그만둔 까닭을 상태로 짐작한다 (사건의 loseJob처럼 까닭을 따로 넘기지 않은 경우) */
function inferExit(state: GameState, job: JobDef | undefined, extraMonths: number): ExitReason {
  const ch = state.ch;
  const w = ch.career.work;
  if (ch.flags.work_deactivated) return 'deactivated';
  if (ch.flags.work_closed) return 'closed';
  if (w?.ending) return 'contract_end';
  if (job && ch.age >= job.retireAge) return 'retire';
  // 위로금을 얹어 내보냈다면 사업주가 먼저 꺼낸 이직이다 (희망퇴직·권고사직)
  if (extraMonths > 0) return 'layoff';
  if (w?.injury && ch.age - w.injury.age <= 1) return 'injury';
  if (w?.arrears && ch.age - w.arrears.since <= 1) return 'arrears';
  return 'quit';
}

/**
 * leaveJob이 일자리를 비우기 직전에 부른다: 그만둔 까닭·임금·가입 기간을 남기고(구직급여·경력 복귀),
 * 개업 자금의 일부를 돌려받고, 그 일자리에 묶인 계약 기록을 지운다
 */
export function endWork(state: GameState, extraMonths: number, reason?: ExitReason): ExitReason {
  const ch = state.ch;
  const c = ch.career;
  const job = c.jobId ? JOB_BY_ID.get(c.jobId) : undefined;
  const w = workOf(ch);
  const type = currentType(state) ?? 'regular';
  const pi = state.world.economy.priceIndex;
  const why = reason ?? inferExit(state, job, extraMonths);
  w.exit = {
    age: ch.age,
    reason: why,
    jobId: c.jobId ?? 'none',
    type,
    wage2026: Math.round(c.salary / pi),
    insuredYears: isInsured(type) ? c.years : 0,
  };
  if (w.capital) {
    // 보증금·집기·장비를 정리해 일부를 돌려받는다
    const back = Math.round(w.capital * 0.25 * pi);
    ch.res.cash += back;
    log(state, '정리', `가게와 장비를 정리하고 ${formatWon(back)}을 돌려받았다.`);
  }
  delete w.type;
  delete w.hours;
  delete w.contractUntil;
  delete w.renewals;
  delete w.ending;
  delete w.standing;
  delete w.capital;
  delete ch.flags.work_deactivated;
  delete ch.flags.work_closed;
  return why;
}

// ── 시간 ─────────────────────────────────────────────────

/** 부업이 쓰는 시간 포인트 */
export function sidePoints(state: GameState): number {
  return state.ch.career.work?.side ? 1 : 0;
}

/**
 * 일하는 사람의 한 해 시간 포인트 (activities.ts). 주 25시간 이하면 3, 52시간 이상이면 1,
 * 그 사이는 2. 부업이 있으면 한 칸 줄어든다 (최소 1)
 */
export function workTimePoints(state: GameState): number {
  const h = currentHours(state);
  const base = h <= 25 ? 3 : h >= 52 ? 1 : 2;
  return Math.max(1, base - sidePoints(state));
}

// ── 연말: 본업 소득 ──────────────────────────────────────

export interface WorkIncome {
  /** 본업 세전 소득 (그해 명목 원, 적자면 음수) */
  gross: number;
  /** 일용직이 일한 날 */
  days?: number;
}

function lognormal(rng: Rng, sigma: number): number {
  return Math.exp(rng.normal(-(sigma * sigma) / 2, sigma));
}

/**
 * 고용 형태에 따른 올해 본업 소득. base는 연봉 곡선(형태 몫 반영)과 직업 고유 변동을 거친 금액이다.
 * 일용직 일감 날수, 플랫폼·프리랜서·자영업의 출렁임, 가족종사의 몫, 업무상 부상으로 쉰 달, 체불을 반영한다
 */
export function workGross(state: GameState, job: JobDef, base: number): WorkIncome {
  const ch = state.ch;
  const type = currentType(state) ?? standardType(job);
  const phase = state.world.economy.phase;
  const rng = rngFor(state.seed, 'work-income', ch.age);
  let gross = base;
  let days: number | undefined;
  switch (type) {
    case 'daily': {
      let mean = 200 * ECON.days[phase];
      if (ch.flags.work_crew) mean += 25;
      if (ch.stats.health < 40) mean *= 0.8;
      if (ch.age >= 60) mean *= 0.9;
      if (job.schedule?.includes('seasonal')) mean *= 0.85;
      if (state.world.pandemic > 0) mean *= 0.85;
      days = Math.max(40, Math.min(270, Math.round(rng.normal(mean, 30))));
      gross = (base * days) / DAILY_BASE_DAYS;
      break;
    }
    case 'platform':
      if (!job.volatility) gross = base * lognormal(rng, 0.3);
      break;
    case 'freelance':
      if (!job.volatility) {
        gross = base * lognormal(rng, 0.4) * ECON.freelance[phase];
        // 일감이 끊기는 해
        if (rng.chance(0.07)) gross *= 0.35;
      }
      break;
    case 'self': {
      if (!job.volatility) {
        let mean: number = ECON.self[phase];
        if (state.world.pandemic > 0 && job.customer) mean *= 0.7;
        gross = base * (mean + rng.normal(0, 0.35));
      }
      break;
    }
    case 'family':
      break;
    default:
      break;
  }
  gross -= injuryLoss(state, gross, type, rng);
  gross -= newArrears(state, gross, type, rng);
  return { gross: Math.round(gross), days };
}

/** 업무상 부상으로 쉰 달만큼 줄어드는 소득. 산재 승인이면 휴업급여 70%, 공상이면 회사가 임금을 준다 */
function injuryLoss(state: GameState, gross: number, type: EmploymentType, rng: Rng): number {
  const ch = state.ch;
  const f = ch.flags.work_injured;
  if (!f || f.since !== ch.age || gross <= 0) return 0;
  const w = workOf(ch);
  let cover: 'claim' | 'company' | 'self' = ch.flags.work_injury_claim ? 'claim' : ch.flags.work_injury_company ? 'company' : 'self';
  if (cover === 'claim' && !INJURY_COVER_TYPES.has(type)) cover = 'self';
  if (cover === 'company' && !EMPLOYEE_TYPES.has(type)) cover = 'self';
  const months = cover === 'self' && ch.flags.work_back_soon ? 0.5 : 1 + rng.int(0, 3);
  // 업무상 사고의 산재 승인률은 높지만 불승인도 있다 (근로복지공단 승인률을 뭉뚱그린 게임 값)
  if (cover === 'claim' && rng.chance(0.08)) {
    cover = 'self';
    log(state, '산재 불승인', '근로복지공단이 업무와의 관련성을 인정하지 않았다. 쉰 기간의 임금은 받지 못했다.', 'tragedy', 10);
  } else if (cover === 'claim') {
    log(state, '산재 승인', `요양 ${Math.round(months)}개월. 치료비와 휴업급여(평균임금의 70%)가 나왔다.`, 'recovery', 6);
  }
  w.injury = { age: ch.age, months, cover };
  const keep = cover === 'claim' ? 0.7 : cover === 'company' ? 1 : 0;
  return gross * (months / 12) * (1 - keep);
}

/** 새로 생긴 임금 체불: 1~3개월치를 못 받고 받을 돈(채권)으로 남긴다 */
function newArrears(state: GameState, gross: number, type: EmploymentType, rng: Rng): number {
  const ch = state.ch;
  const f = ch.flags.work_arrears;
  const w = workOf(ch);
  if (!f || f.since !== ch.age || w.arrears || !EMPLOYEE_TYPES.has(type) || gross <= 0) return 0;
  const months = 1 + rng.int(0, 2);
  const owed = (gross * months) / 12;
  w.arrears = { amount: Math.round(owed / state.world.economy.priceIndex), since: ch.age };
  return owed;
}

// ── 연말: 계약·의사 표시·부업·실직 ───────────────────────

/** 계약 판정의 기본 확률 [만료, 정규직 전환, 갱신] */
function contractOdds(type: EmploymentType, job: JobDef, renewals: number): [number, number, number] {
  if (job.contractYears === 1 && type === 'contract') return [0.7, 0, 0.3];
  switch (type) {
    case 'contract':
      // 기간제법: 2년을 넘기면 무기계약으로 본다. 그래서 두 번째 판정에는 '갱신'이 없다
      return renewals === 0 ? [0.45, 0.3, 0.25] : [0.6, 0.4, 0];
    case 'dispatch':
      // 파견법: 2년이 지나면 직접고용 의무. 실제로는 다른 업체·다른 자리로 옮기는 경우가 많다
      return [0.4, 0.15, 0.45];
    case 'parttime':
      return [0.15, 0.05, 0.8];
    default:
      return [0, 0, 1];
  }
}

function settleContract(state: GameState, job: JobDef): void {
  const ch = state.ch;
  const w = workOf(ch);
  // 만료 통보를 받고 한 해가 지나도록 다른 길(구제·소속 변경)이 정해지지 않았으면 계약은 그대로 끝난다
  if (w.ending && w.contractUntil !== undefined && ch.age >= w.contractUntil) {
    leaveJob(state, 0, 'contract_end');
    log(state, '계약 만료', `${josa(job.title, '이/가')} 계약 기간을 끝으로 끝났다.`, 'neutral', 8);
    return;
  }
  if (w.contractUntil === undefined || w.ending || ch.age + 1 < w.contractUntil) return;
  const type = currentType(state) ?? standardType(job);
  const renewals = w.renewals ?? 0;
  const [end0, conv0, renew0] = contractOdds(type, job, renewals);
  let m: number = { boom: 0.8, normal: 1, recession: 1.35, crisis: 1.8 }[state.world.economy.phase];
  m *= 0.7 + 0.3 * job.layoffRisk;
  const standing = w.standing ?? 0;
  if (standing > 0) m *= 0.6;
  if (standing < 0) m *= 1.6;
  if (ch.personality.conscientiousness >= 65) m *= 0.85;
  if (ch.personality.conscientiousness <= 35) m *= 1.15;
  if (ch.state.stress >= 80) m *= 1.15;
  if (ch.age >= 55) m *= 1.15;
  const end = end0 * m;
  const conv = conv0 / m;
  const total = end + conv + renew0;
  const rng = rngFor(state.seed, 'work-contract', ch.age, job.id, renewals);
  const u = rng.next() * total;
  delete w.standing;
  if (u < end) {
    w.ending = true;
    log(state, '재계약 불가', `${job.title} 계약이 이번 기간으로 끝난다는 통보를 받았다.`, 'drama', 12);
  } else if (u < end + conv) {
    const before = payFactor(job, type);
    w.type = 'regular';
    w.hours = hoursFor(job, 'regular');
    delete w.contractUntil;
    w.renewals = 0;
    ch.career.salary = Math.round((ch.career.salary / before) * payFactor(job, 'regular'));
    log(state, '정규직 전환', `${type === 'dispatch' ? '직접 고용' : '정규직(무기계약) 전환'}이 결정됐다. 계약 만료일을 세지 않아도 된다.`, 'positive', 15);
  } else {
    const term = contractTerm(job, type) || 1;
    w.contractUntil = ch.age + 1 + term;
    w.renewals = renewals + 1;
    log(state, '계약 연장', `${job.title} 계약을 ${term}년 더 연장했다.`, 'neutral', 4);
  }
}

/** 일터 태그(work_*)가 하나라도 있는가 */
function hasWorkFlag(f: Character['flags']): boolean {
  for (const id in f) if (id.startsWith('work_')) return true;
  return false;
}

/** 사건 카드가 붙인 의사 표시 태그를 연말에 실제 상태로 옮긴다 */
function resolveIntents(state: GameState, job: JobDef | undefined): number {
  const ch = state.ch;
  const f = ch.flags;
  // 의사 표시 태그도, 만료 통보도, 받을 임금도 없으면 할 일이 없다 (아이들과 대부분의 해. 일 기록도 만들지 않는다)
  if (!hasWorkFlag(f) && !ch.career.work?.ending && !ch.career.work?.arrears) return 0;
  const w = workOf(ch);
  const pi = state.world.economy.priceIndex;
  const rng = rngFor(state.seed, 'work-intent', ch.age);
  let paid = 0;

  // 계약 만료 카드에서 고른 길
  if (job && w.ending && f.work_contract_saved) {
    const type = currentType(state) ?? standardType(job);
    const term = contractTerm(job, type) || 1;
    delete w.ending;
    w.contractUntil = ch.age + term;
    w.renewals = (w.renewals ?? 0) + 1;
    log(state, '구제 인정', `갱신 거절이 부당하다는 판정으로 ${josa(job.title, '으로/로')} 계속 일한다.`, 'recovery', 12);
  }
  if (job && w.ending && f.work_to_dispatch) {
    const before = payFactor(job, currentType(state) ?? standardType(job));
    w.type = 'dispatch';
    w.hours = hoursFor(job, 'dispatch');
    delete w.ending;
    w.contractUntil = ch.age + contractTerm(job, 'dispatch');
    w.renewals = 0;
    ch.career.salary = Math.round((ch.career.salary / before) * payFactor(job, 'dispatch'));
    log(state, '소속 변경', '같은 자리에서 용역 업체 소속으로 일하게 됐다. 월급 명세서의 회사 이름이 바뀌었다.', 'neutral', 6);
  }
  delete f.work_contract_saved;
  delete f.work_to_dispatch;

  // 평가
  if (f.work_good_review) w.standing = (w.standing ?? 0) + 1;
  if (f.work_bad_review) w.standing = (w.standing ?? 0) - 1;
  delete f.work_good_review;
  delete f.work_bad_review;

  // 플랫폼 단가 인하
  if (f.work_rate_cut && ch.career.jobId) ch.career.raise *= 0.92;
  delete f.work_rate_cut;

  // 가족 가게에서 월급을 받기로 했다
  if (f.work_family_paid && job && currentType(state) === 'family') {
    const before = payFactor(job, 'family');
    w.type = 'regular';
    ch.career.salary = Math.round((ch.career.salary / before) * payFactor(job, 'regular'));
    log(state, '월급', '가게 일을 정식으로 하고 월급을 받기로 했다. 4대 보험도 들었다.', 'positive', 6);
  }
  delete f.work_family_paid;

  // 고객 폭언 신고
  if (f.work_abuse_report) {
    const changes: Change[] = [];
    if (rng.chance(0.5)) {
      changeAttr(state, 'stress', -5, changes);
      log(state, '보호 조치', '회사가 그 고객의 응대를 막고 휴게 시간을 줬다. 녹음 파일이 증거가 됐다.', 'recovery', 5);
    } else {
      changeAttr(state, 'stress', 3, changes);
      log(state, '형식적인 답', '회사는 사과문 한 장을 붙이고 끝냈다.', 'neutral', 4);
    }
  }
  delete f.work_abuse_report;

  // 부업 정리
  if (f.work_side_quit && w.side) {
    log(state, '부업 정리', `${JOB_BY_ID.get(w.side.jobId)?.title ?? '부업'}을 그만뒀다.`);
    delete w.side;
  }
  delete f.work_side_quit;

  // 직업훈련·자격 공부를 마친다
  for (const [track, def] of Object.entries(TRAINING_TRACKS)) {
    if (!f[`work_train_${track}`]) continue;
    delete f[`work_train_${track}`];
    finishTraining(state, track, def);
  }
  for (const id of Object.keys(f)) {
    if (!id.startsWith('work_study_')) continue;
    delete f[id];
    // 사건에서 등록한 공부도 응시 조건(나이·학력·선행 면허·한 해 한 번)은 행동과 같다
    const def = LICENSE_BY_ID.get(id.slice('work_study_'.length));
    if (def && !licenseBlock(state, def)) attemptLicense(state, def, 'intent');
  }
  if (f.work_renew) {
    delete f.work_renew;
    paid -= renewLicenses(state);
  }

  // 체불 카드에서 바로 그만뒀다면 마지막 임금으로 못 받은 돈을 남긴다 (계속 다니면 workGross가 이미 남겼다)
  if (f.work_arrears && f.work_arrears.since === ch.age && !w.arrears && w.exit?.age === ch.age) {
    const months = 1 + rng.int(0, 2);
    w.arrears = { amount: Math.round((w.exit.wage2026 * months) / 12), since: ch.age };
  }
  // 체불 임금: 진정했으면 회수를 시도하고, 아니면 사업주가 늦게라도 줄 때를 기다린다. 3년이면 시효
  if (w.arrears) {
    const years = ch.age - w.arrears.since;
    const claimed = Boolean(f.work_wage_claim);
    const p = claimed ? (years === 0 ? 0.55 : 0.4) : 0.25;
    if (rng.chance(p)) {
      // 사업주가 끝내 못 주면 대지급금(간이 최대 1,000만 원)으로 받는다
      const amount = claimed && rng.chance(0.3) ? Math.min(w.arrears.amount, 10_000_000) : w.arrears.amount;
      const won = Math.round(amount * pi);
      paid += won;
      log(state, '체불 임금', `${claimed ? '진정 끝에' : '늦게나마'} 못 받았던 임금 ${formatWon(won)}을 받았다.`, 'recovery', 8);
      delete w.arrears;
    } else if (years >= 3) {
      log(state, '시효', '받지 못한 임금은 끝내 받지 못했다. 임금 채권의 시효 3년이 지났다.', 'tragedy', 6);
      delete w.arrears;
    }
  }
  if (!w.arrears) {
    delete f.work_arrears;
    delete f.work_wage_claim;
  }

  // 지인 추천은 한 번의 구직 기간(다음 해 행동)까지만 유효하다
  if (f.work_referral && f.work_referral.since < ch.age) delete f.work_referral;
  delete f.work_back_soon;
  return paid;
}

function finishTraining(state: GameState, track: string, def: (typeof TRAINING_TRACKS)[string]): void {
  const ch = state.ch;
  const w = workOf(ch);
  if (!(w.trained ??= []).includes(track)) w.trained.push(track);
  log(state, '훈련 수료', `${def.label}을 마쳤다.`, 'positive', 6);
  // 과정 끝의 시험: 아직 없는 면허 중 앞의 것부터 (대형 면허는 1종 보통이 먼저)
  for (const id of def.license ?? []) {
    if (hasLicense(ch, id)) continue;
    const lic = LICENSE_BY_ID.get(id);
    if (lic && !licenseBlock(state, lic, true)) {
      attemptLicense(state, lic, 'training');
      break;
    }
  }
}

/** 부업 소득과 피로 */
function settleSide(state: GameState): number {
  const ch = state.ch;
  const side = ch.career.work?.side;
  if (!side) return 0;
  const w = workOf(ch);
  const job = JOB_BY_ID.get(side.jobId);
  if (!job) {
    delete w.side;
    return 0;
  }
  const pi = state.world.economy.priceIndex;
  const rng = rngFor(state.seed, 'work-side', ch.age);
  const years = Math.max(0, ch.age - side.since);
  let gross = jobSalary(job, years, pi, 1) * payFactor(job, side.type) * (side.hours / Math.max(1, hoursFor(job, side.type)));
  if (side.type === 'platform' || side.type === 'freelance' || side.type === 'self') gross *= lognormal(rng, 0.35);
  const changes: Change[] = [];
  const total = currentHours(state) + side.hours;
  changeAttr(state, 'stress', total > 60 ? 4 : 2, changes);
  changeAttr(state, 'happiness', -1, changes);
  if (total > 60) changeAttr(state, 'health', -1, changes);
  // 부업 소득은 사업·기타소득으로 3.3% 떼고, 건강보험료 등을 뭉뚱그려 8%
  return Math.round(gross * 0.92);
}

/** 근무 형태가 몸과 관계에 남기는 것: 야간은 건강, 교대는 스트레스, 재택은 여유, 출장은 배우자와의 거리 */
function scheduleWear(state: GameState, job: JobDef): void {
  const sched = job.schedule ?? [];
  const changes: Change[] = [];
  if (sched.includes('night')) {
    changeAttr(state, 'health', -0.4, changes);
    changeAttr(state, 'stress', 1, changes);
  } else if (sched.includes('shift')) {
    changeAttr(state, 'stress', 1, changes);
  }
  if (sched.includes('remote')) changeAttr(state, 'stress', -1, changes);
  if (sched.includes('travel')) changeCloseness(state.ch, 'spouse', -2);
}

/** 가족종사: 일한 값의 일부가 가업(부모 재산)에 쌓인다. 부모가 모두 떠나면 가업을 잇는다 */
function settleFamilyWork(state: GameState, job: JobDef): void {
  const ch = state.ch;
  if (currentType(state) !== 'family') return;
  if (alive(ch, 'mother', 'father').length === 0) {
    const w = workOf(ch);
    const before = payFactor(job, 'family');
    w.type = 'self';
    ch.career.salary = Math.round((ch.career.salary / before) * payFactor(job, 'self'));
    log(state, '가업', `부모님이 하던 ${josa(job.title.replace(/ 일손.*$/, ''), '을/를')} 이어받았다. 이제 내 이름으로 꾸린다.`, 'drama', 12);
    return;
  }
  const base2026 = jobSalary(job, ch.career.years, 1, 1);
  ch.family.estate += Math.round(base2026 * (1 - TYPE_PAY.family) * 0.3);
}

/**
 * 재직 중에 결격 사유가 생기면 당연퇴직한다 (국가공무원법 69조, 공공기관 인사규정의 준용은 추정 규칙).
 * 판결 직후 처리(justice.ts)는 records.ts의 결격 직업만 보므로, publicBar 직업도 같은 해 연말에 여기서 정리한다
 */
function dismissIfBarred(state: GameState, job: JobDef): boolean {
  if (!jobBarred(state.ch, job)) return false;
  leaveJob(state, 0, 'dismissed');
  log(state, '당연퇴직', `판결로 결격 사유가 생겨 ${josa(job.title, '을/를')} 더는 할 수 없게 됐다. 결격 기간이 끝나면 다시 지원할 수 있다.`, 'tragedy', 12);
  return true;
}

/** 정년이 없는 형태(자영업·프리랜서·플랫폼·일용·가족종사)는 그 직업의 은퇴 나이에 스스로 일을 접는다 */
function selfRetire(state: GameState, job: JobDef): void {
  const ch = state.ch;
  const type = currentType(state);
  if (!type || LAYOFF_TYPES.has(type) || ORG_TYPES.has(type)) return;
  if (ch.age + 1 < job.retireAge && ch.stats.health >= 20) return;
  const title = ch.career.title;
  leaveJob(state, 0, ch.stats.health < 20 ? 'quit' : 'retire');
  log(state, '일을 접다', `${josa(title ?? '일', '을/를')} 내려놓았다. ${ch.stats.health < 20 ? '몸이 더는 버티지 못했다.' : '이제 쉴 나이다.'}`, 'neutral', 8);
}

/** 구직급여: 비자발적으로 그만둔 고용보험 가입자가 실직 상태로 해를 넘기면 한 번 (소정급여일수 × 하루치) */
function jobSeekerBenefit(state: GameState): number {
  const ch = state.ch;
  const w = ch.career.work;
  const exit = w?.exit;
  if (!w || !exit || ch.career.jobId || w.benefitFor === exit.age) return 0;
  if (ch.age - exit.age > 1 || !INVOLUNTARY.has(exit.reason) || !isInsured(exit.type) || exit.insuredYears < 1) return 0;
  if (exit.age >= 66 || ch.military.status === 'serving' || (ch.legal.prisonUntil !== undefined && ch.age < ch.legal.prisonUntil)) return 0;
  const daily = Math.max(BENEFIT_FLOOR, Math.min(BENEFIT_CAP, (exit.wage2026 / 365) * 0.6));
  const won = Math.round(daily * benefitDays(exit.age, exit.insuredYears) * state.world.economy.priceIndex);
  w.benefitFor = exit.age;
  log(state, '구직급여', `고용센터에 구직 신청을 하고 구직급여 ${formatWon(won)}을 받았다.`, 'recovery', 6);
  return won;
}

/** 소정급여일수 (고용보험법 별표 1): 50세 미만 120~240일, 50세 이상 120~270일 */
export function benefitDays(age: number, insuredYears: number): number {
  const tier = insuredYears < 1 ? 0 : insuredYears < 3 ? 1 : insuredYears < 5 ? 2 : insuredYears < 10 ? 3 : 4;
  return (age < 50 ? [120, 150, 180, 210, 240] : [120, 180, 210, 240, 270])[tier];
}

/** 갱신 기한을 넘긴 면허는 1년 유예 뒤 효력을 잃고, 그 면허가 필요한 일은 계속할 수 없다 */
function lapseLicenses(state: GameState, job: JobDef | undefined): void {
  const ch = state.ch;
  const lic = ch.career.work?.licenses;
  if (!lic) return;
  for (const [id, r] of Object.entries(lic)) {
    if (r.passed === undefined || r.lapsed || r.renewAt === undefined || ch.age < r.renewAt + 1) continue;
    r.lapsed = true;
    const name = LICENSE_BY_ID.get(id)?.name ?? id;
    log(state, '면허 효력 정지', `${name} 갱신 기한을 1년 넘겼다. 다시 갱신하기 전까지는 쓸 수 없다.`, 'tragedy', 10);
    if (job?.licenses?.includes(id) && ch.career.jobId === job.id) {
      leaveJob(state, 0, 'dismissed');
      log(state, '업무 정지', `면허가 없으니 ${josa(job.title, '을/를')} 계속할 수 없었다.`, 'tragedy', 12);
    }
  }
}

/**
 * 연말 일터 정리 (career.ts의 yearlyEarnings가 본업 소득을 계산한 뒤 부른다).
 * 의사 표시 태그 처리 → 계약 판정 → 부업 → 근무 형태의 영향 → 가업 → 스스로 은퇴 → 면허 → 구직급여 → 원장.
 * 본업 밖에서 들어온 돈(부업·구직급여·체불 회수, 세후 명목 원)을 돌려준다
 */
export function workYearEnd(state: GameState, main: WorkIncome): number {
  const ch = state.ch;
  const pi = state.world.economy.priceIndex;
  let job = ch.career.jobId && !ch.career.business ? JOB_BY_ID.get(ch.career.jobId) : undefined;
  const type = currentType(state);
  const jobIdAtYear = ch.career.jobId;
  let benefit = resolveIntents(state, job);
  if (job && ch.career.jobId === job.id && !dismissIfBarred(state, job)) {
    settleContract(state, job);
    scheduleWear(state, job);
    settleFamilyWork(state, job);
    selfRetire(state, job);
  }
  job = ch.career.jobId ? JOB_BY_ID.get(ch.career.jobId) : undefined;
  lapseLicenses(state, job);
  const side = settleSide(state);
  benefit += jobSeekerBenefit(state);
  record(state, {
    age: ch.age,
    jobId: jobIdAtYear,
    type,
    gross: Math.round(main.gross / pi),
    side: side ? Math.round(side / pi) : undefined,
    benefit: benefit ? Math.round(benefit / pi) : undefined,
    days: main.days,
  });
  return side + benefit;
}

function record(state: GameState, year: WorkYear): void {
  if (!year.jobId && !year.side && !year.benefit) return;
  const w = workOf(state.ch);
  const ledger = (w.ledger ??= []);
  const clean = Object.fromEntries(Object.entries(year).filter(([, v]) => v !== undefined)) as unknown as WorkYear;
  ledger.push(clean);
  if (ledger.length > LEDGER_MAX) ledger.splice(0, ledger.length - LEDGER_MAX);
}

// ── 면허·자격 ────────────────────────────────────────────

function licenseRecord(ch: Character, id: string): LicenseRecord {
  const all = (workOf(ch).licenses ??= {});
  return (all[id] ??= { tries: 0 });
}

/** 응시할 수 없는 까닭. 없으면 null. training이면 과정이 응시 자격을 대신한다 (학력 조건 제외) */
export function licenseBlock(state: GameState, def: LicenseDef, training = false): string | null {
  const ch = state.ch;
  const r = ch.career.work?.licenses?.[def.id];
  if (r?.passed !== undefined && !r.lapsed) return '이미 있다.';
  if (ch.age < def.minAge) return `${def.minAge}세부터 응시할 수 있다.`;
  if (!training && def.minDegree && DEGREE_RANK[ch.edu.degree] < DEGREE_RANK[def.minDegree]) return `${DEGREE_LABEL[def.minDegree]} 이상만 응시할 수 있다.`;
  for (const need of def.needs ?? []) {
    if (!hasLicense(ch, need)) return `${LICENSE_BY_ID.get(need)?.name ?? need}이 먼저 있어야 한다.`;
  }
  if (def.exp && fieldExperience(ch, def.exp.field) < def.exp.years) {
    return `${FIELD_BY_ID.get(def.exp.field)?.label ?? def.exp.field} 경력 ${def.exp.years}년이 필요하다.`;
  }
  if (def.req && !evaluate(def.req, reqScope(state))) return `조건이 안 된다 (${describeReq(def.req)}).`;
  if (r?.lastTry === ch.age && !r.lapsed) return '올해 시험은 이미 봤다. 내년에 다시 볼 수 있다.';
  return null;
}

/** 이번 응시의 합격 가능성: 기본 합격률 × 지능 × 앞선 응시에서 쌓인 공부 */
export function licensePassChance(state: GameState, def: LicenseDef): number {
  const ch = state.ch;
  const tries = ch.career.work?.licenses?.[def.id]?.tries ?? 0;
  const smart = 0.55 + ch.stats.intelligence / 110;
  const learned = 1 + (def.learn ?? 0.1) * Math.min(tries, 4);
  return Math.max(0.02, Math.min(0.97, def.pass * smart * learned));
}

/** 갱신 주기: 65세부터 5년, 75세부터 3년 (도로교통법 적성검사) */
function renewYears(def: LicenseDef, age: number): number | undefined {
  if (!def.renew) return undefined;
  return age >= 75 ? Math.min(def.renew, 3) : age >= 65 ? Math.min(def.renew, 5) : def.renew;
}

/** 시험을 본다. 떨어져도 기록이 남고 다음 응시가 조금 쉬워진다 */
function attemptLicense(state: GameState, def: LicenseDef, label: string): boolean {
  const ch = state.ch;
  const r = licenseRecord(ch, def.id);
  // 효력을 잃은 면허는 시험 없이 갱신 절차로 되살린다 (renewLicenses)
  const p = licensePassChance(state, def);
  const rng = rngFor(state.seed, 'work-license', ch.age, def.id, r.tries, label);
  r.tries += 1;
  r.lastTry = ch.age;
  if (rng.chance(p)) {
    r.passed = ch.age;
    delete r.lapsed;
    const every = renewYears(def, ch.age);
    if (every) r.renewAt = ch.age + every;
    else delete r.renewAt;
    log(state, '합격', `${def.name} ${def.course ? '과정을 마치고 시험에 붙었다' : '시험에 붙었다'}.`, 'positive', 8);
    return true;
  }
  log(state, '불합격', `${def.name} 시험에 떨어졌다. ${r.tries}번째 응시였다. 다음에 다시 볼 수 있다.`, 'neutral', 4);
  return false;
}

/** 갱신할 때가 된(또는 효력을 잃은) 면허를 모두 갱신한다. 낸 돈(명목)을 돌려준다 */
export function renewLicenses(state: GameState): number {
  const ch = state.ch;
  const lic = ch.career.work?.licenses;
  if (!lic) return 0;
  let cost = 0;
  for (const [id, r] of Object.entries(lic)) {
    const def = LICENSE_BY_ID.get(id);
    if (!def || r.passed === undefined || r.renewAt === undefined || ch.age + 1 < r.renewAt) continue;
    r.renewAt = ch.age + (renewYears(def, ch.age) ?? def.renew ?? 10);
    delete r.lapsed;
    cost += Math.round(50_000 * state.world.economy.priceIndex);
  }
  if (cost > 0) {
    ch.res.cash -= cost;
    log(state, '면허 갱신', `적성검사를 받고 면허를 갱신했다. ${formatWon(cost)}.`, 'neutral', 2);
  }
  return cost;
}

/** 갱신이 다가온(1년 안) 면허가 있는가 */
export function licenseDue(ch: Character): boolean {
  return Object.values(ch.career.work?.licenses ?? {}).some((r) => r.passed !== undefined && r.renewAt !== undefined && ch.age + 1 >= r.renewAt);
}

// ── 플레이어 행동: 면허 공부, 직업훈련, 부업 ─────────────────

function fail(text: string): ActionResult {
  return { ok: false, text };
}

/** 자격증·면허 공부와 응시 (시간 포인트와 돈을 쓴다). 떨어지면 다음 해에 다시 볼 수 있다 */
export function studyLicense(state: GameState, id: string): ActionResult {
  const def = LICENSE_BY_ID.get(id);
  const ch = state.ch;
  if (!def || state.phase !== 'action' || !ch.alive) return fail('지금은 할 수 없다.');
  const r = ch.career.work?.licenses?.[id];
  // 갱신만 하면 되는 면허
  if (r?.passed !== undefined && r.renewAt !== undefined && ch.age + 1 >= r.renewAt) {
    const cost = renewLicenses(state);
    return { ok: true, text: `${def.name}을 갱신했다.`, changes: [{ text: `현금 −${formatWon(cost)}`, sign: 'bad' }] };
  }
  const why = licenseBlock(state, def);
  if (why) return fail(why);
  if (state.points.left < def.points) return fail('올해는 공부할 시간이 없다.');
  const cost = Math.round(def.cost * state.world.economy.priceIndex);
  const adult = ch.age >= 19;
  if (adult && ch.res.cash < cost) return fail(`돈이 모자란다 (${formatWon(cost)}).`);
  if (!adult && (ch.family.type === 'facility' || ch.family.wealth <= 1)) return fail('수강료를 댈 형편이 안 된다.');
  state.points.left -= def.points;
  state.actions[`license_${id}`] = (state.actions[`license_${id}`] ?? 0) + 1;
  const changes: Change[] = [];
  if (adult) {
    ch.res.cash -= cost;
    changes.push({ text: `현금 −${formatWon(cost)}`, sign: 'bad' });
  }
  changeAttr(state, 'stress', 3, changes);
  const passed = attemptLicense(state, def, 'study');
  if (passed) changes.push({ text: `자격: ${def.name}`, sign: 'good' });
  const tries = ch.career.work!.licenses![id].tries;
  return {
    ok: passed,
    text: passed ? `${def.name} 합격.` : `${def.name} 불합격 (${tries}번째). 내년에 다시 볼 수 있다.`,
    changes,
  };
}

/** 직업훈련 (국민내일배움카드). 과정은 연말에 끝나고 시험이 따르는 과정은 그때 응시한다 */
export function startTraining(state: GameState, track: string): ActionResult {
  const def = TRAINING_TRACKS[track];
  const ch = state.ch;
  if (!def || state.phase !== 'action' || !ch.alive) return fail('지금은 할 수 없다.');
  if (ch.age < 19 || ch.age > 64) return fail('국민내일배움카드는 19~64세가 쓸 수 있다.');
  if (ch.flags[`work_train_${track}`]) return fail('이미 듣고 있는 과정이다.');
  if (isTrained(ch, track) && !(def.license ?? []).some((id) => !hasLicense(ch, id))) return fail('이미 마친 과정이다.');
  if (state.points.left < def.points) return fail('올해는 과정을 들을 시간이 없다.');
  const cost = Math.round(def.cost * state.world.economy.priceIndex);
  if (ch.res.cash < cost) return fail(`자부담금이 모자란다 (${formatWon(cost)}).`);
  state.points.left -= def.points;
  ch.res.cash -= cost;
  const changes: Change[] = [{ text: `현금 −${formatWon(cost)}`, sign: 'bad' }];
  addFlag(state, `work_train_${track}`, changes);
  changeAttr(state, 'stress', 2, changes);
  return { ok: true, text: `${def.label}에 등록했다. 연말에 과정을 마친다.`, changes };
}

/** 부업으로 할 수 없는 까닭. 없으면 null */
export function sideJobBlock(state: GameState, job: JobDef): string | null {
  const ch = state.ch;
  const c = ch.career;
  if (ch.age < 19) return '부업은 성인이 되어야 한다. 학생 때는 알바를 하면 된다.';
  if (!job.side) return '부업으로 할 수 있는 일이 아니다.';
  if (c.work?.side) return '부업은 하나만 할 수 있다.';
  const student = ch.edu.status === 'university' && !ch.edu.onLeave;
  if (!c.jobId && !student) return '본업이 없으면 본업으로 지원하면 된다.';
  if (c.jobId === job.id) return '지금 하는 일과 같은 일이다.';
  const main = c.jobId ? JOB_BY_ID.get(c.jobId) : undefined;
  if (main?.noSide) return `${josa(main.title, '은/는')} 겸직이 금지돼 있다 (국가공무원법 64조 등).`;
  if (!meetsJob(state, job)) return '자격 조건이 안 된다.';
  const mainHours = c.jobId ? currentHours(state) : PART_HOURS;
  const sideHours = Math.min(SIDE_HOURS, hoursFor(job, sideType(job)));
  if (mainHours + sideHours > MAX_WEEK_HOURS) return `본업 주 ${mainHours}시간에 더하면 주 ${MAX_WEEK_HOURS}시간을 넘는다.`;
  if (main && schedulesClash(main.schedule ?? [], job.schedule ?? [])) return '본업 근무 시간과 겹친다 (교대·야간·출장).';
  if (ch.stats.health < 35) return '몸이 버티지 못한다.';
  return null;
}

/** 본업과 부업의 근무 시간이 겹치는가: 야간끼리, 교대와 야간·교대, 출장과 고정된 일정 */
export function schedulesClash(main: readonly WorkSchedule[], side: readonly WorkSchedule[]): boolean {
  if (side.includes('remote')) return false;
  const has = (s: readonly WorkSchedule[], x: WorkSchedule) => s.includes(x);
  if (has(main, 'night') && (has(side, 'night') || has(side, 'shift'))) return true;
  if (has(main, 'shift') && (has(side, 'night') || has(side, 'shift'))) return true;
  if (has(main, 'travel') && !has(side, 'irregular')) return true;
  return false;
}

/** 부업으로 할 때의 형태: 시간제·플랫폼·프리랜서·일용·자영업 중 이 직업이 가진 것 */
function sideType(job: JobDef): EmploymentType {
  const types = Object.keys(job.employment ?? {}) as EmploymentType[];
  return types.find((t) => t === 'platform' || t === 'freelance' || t === 'parttime' || t === 'daily' || t === 'self') ?? standardType(job);
}

/** 부업을 시작한다: 올해 시간 한 칸, 해마다 피로. 소득은 연말에 */
export function takeSideJob(state: GameState, jobId: string): ActionResult {
  const job = JOB_BY_ID.get(jobId);
  const ch = state.ch;
  if (!job || state.phase !== 'action' || !ch.alive) return fail('지금은 할 수 없다.');
  const why = sideJobBlock(state, job);
  if (why) return fail(why);
  if (state.points.left < 1) return fail('올해는 부업을 시작할 시간이 없다.');
  const type = sideType(job);
  state.points.left -= 1;
  workOf(ch).side = { jobId, type, hours: Math.min(SIDE_HOURS, hoursFor(job, type)), since: ch.age };
  log(state, '부업', `${josa(job.title, '을/를')} 부업으로 시작했다. 주 ${Math.min(SIDE_HOURS, hoursFor(job, type))}시간.`, 'neutral', 5);
  return { ok: true, text: `${josa(job.title, '을/를')} 부업으로 시작했다.`, changes: [{ text: `부업: ${job.title} (${TYPE_LABEL[type]})`, sign: 'info' }] };
}

export function quitSideJob(state: GameState): ActionResult {
  const ch = state.ch;
  const side = ch.career.work?.side;
  if (!side || state.phase !== 'action') return fail('그만둘 부업이 없다.');
  const title = JOB_BY_ID.get(side.jobId)?.title ?? '부업';
  delete ch.career.work!.side;
  log(state, '부업 정리', `${josa(title, '을/를')} 그만뒀다.`);
  return { ok: true, text: `${josa(title, '을/를')} 그만뒀다.` };
}

// ── 조건식이 읽는 값 (scope.ts의 job.*) ───────────────────

const NO_SCHEDULE: readonly WorkSchedule[] = [];

/** 효력 있는 면허·자격 수 */
function licenseCount(w: WorkState | undefined): number {
  let n = 0;
  for (const id in w?.licenses ?? {}) {
    const r = w!.licenses![id];
    if (r.passed !== undefined && !r.lapsed) n++;
  }
  return n;
}

/**
 * 조건식의 job.* 전체 (scope.ts). 일이 없으면 모두 0·false·'none' (검증 도구가 키를 알아야 하므로 늘 같은 키).
 * 조건식 범위는 해마다 수없이 만들어지므로 한 개의 객체 리터럴로 만든다 (다른 객체를 펼쳐 넣으면 느리다).
 * 앞의 열 개는 직업 확장 전부터 있던 값이고, 희망퇴직(layoffRisk)은 정규직·계약직, 정년퇴직 카드(atRetireAge)는
 * 조직에 속한 일만 대상이다 (자영업·프리랜서는 그 직업의 은퇴 나이에 스스로 접는다: selfRetire)
 */
export function jobScope(state: GameState): Record<string, unknown> {
  const ch = state.ch;
  const c = ch.career;
  const w = c.work;
  const job = c.jobId ? JOB_BY_ID.get(c.jobId) : undefined;
  const type = currentType(state);
  const sched = job?.schedule ?? NO_SCHEDULE;
  const org = Boolean(type && ORG_TYPES.has(type));
  const employee = Boolean(type && EMPLOYEE_TYPES.has(type));
  const unemployed = ch.flags.unemployed;
  return {
    id: c.jobId ?? 'none',
    employed: Boolean(c.jobId),
    salary: c.salary,
    years: c.years,
    business: Boolean(c.business),
    retired: c.retired,
    layoffRisk: job && type && LAYOFF_TYPES.has(type) ? job.layoffRisk : 0,
    stress: job ? job.stress : 0,
    retireAge: job ? job.retireAge : 0,
    atRetireAge: Boolean(job && !c.business && ch.age >= job.retireAge && org),
    type: type ?? 'none',
    field: job?.field ?? 'none',
    hours: currentHours(state),
    shift: sched.includes('shift'),
    night: sched.includes('night'),
    remote: sched.includes('remote'),
    outdoor: sched.includes('field'),
    travel: sched.includes('travel'),
    seasonal: sched.includes('seasonal'),
    injury: job?.injury ?? 0,
    injuryCover: Boolean(type && INJURY_COVER_TYPES.has(type)),
    employee,
    customer: Boolean(job?.customer),
    arrearsRisk: job && employee ? job.arrears ?? 1 : 0,
    automation: job?.automation ?? 0,
    org,
    ladder: Boolean(job && (type === 'regular' || type === 'contract') && !job.flat),
    contract: Boolean(c.jobId && w?.contractUntil !== undefined),
    contractEnding: Boolean(c.jobId && w?.ending),
    renewals: w?.renewals ?? 0,
    canDispatch: Boolean(job?.employment?.dispatch) && type !== 'dispatch',
    hasSide: Boolean(w?.side),
    seeking: Boolean(unemployed),
    joblessYears: unemployed ? ch.age - unemployed.since : 0,
    lastField: c.history.length > 0 ? lastField(ch) : 'none',
    injured: Boolean(w?.injury && ch.age - w.injury.age <= 1),
    arrearsOwed: Boolean(w?.arrears),
    licenses: w ? licenseCount(w) : 0,
    driver: w ? hasLicense(ch, 'driver_1') : false,
    forklift: w ? hasLicense(ch, 'forklift') : false,
    licenseDue: w ? licenseDue(ch) : false,
    expYears: job ? fieldExperience(ch, job.expField ?? job.field) : 0,
  };
}

/** 구조조정 사건(job.layoffRisk)의 대상이 되는 형태인가 */
export function layoffExposed(state: GameState): boolean {
  const type = currentType(state);
  return Boolean(type && LAYOFF_TYPES.has(type));
}

/** 정년퇴직 카드(job.atRetireAge)가 어울리는 형태인가: 조직에 속한 일 */
export function orgRetirement(state: GameState): boolean {
  const type = currentType(state);
  return Boolean(type && ORG_TYPES.has(type));
}

/** 소득 원장 (화면·시뮬레이터) */
export function ledgerOf(ch: Character): readonly WorkYear[] {
  return ch.career.work?.ledger ?? [];
}

/** 구직급여를 받을 수 있는 이직인가 (화면 설명용) */
export function benefitEligible(exit: WorkState['exit']): boolean {
  return Boolean(exit && INVOLUNTARY.has(exit.reason) && isInsured(exit.type) && exit.insuredYears >= 1);
}
