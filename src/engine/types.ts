// 게임 전체가 공유하는 타입. 게임 상태는 전부 JSON으로 직렬화할 수 있어야 한다
// (새로고침 저장, 시드 재현, 시뮬레이터).

export type Sex = 'M' | 'F';
export type Mode = 'reality' | 'drama' | 'makjang';
export type StageId =
  | 'infant'
  | 'elementary'
  | 'middle'
  | 'high'
  | 'youth'
  | 'adult'
  | 'midlife'
  | 'senior';

export const STAT_KEYS = ['health', 'stamina', 'intelligence', 'looks', 'sociability', 'happiness'] as const;
export type StatKey = (typeof STAT_KEYS)[number];

export const HIDDEN_KEYS = ['morality', 'mental', 'luck'] as const;
export type HiddenKey = (typeof HIDDEN_KEYS)[number];

export const STATE_KEYS = ['stress', 'reputation'] as const;
export type StateKey = (typeof STATE_KEYS)[number];

/** 사건 효과로 바꿀 수 있는 0~100 수치 전부 */
export type AttrKey = StatKey | HiddenKey | StateKey;

export const PERSONALITY_KEYS = [
  'extraversion',
  'conscientiousness',
  'openness',
  'agreeableness',
  'neuroticism',
] as const;
export type PersonalityKey = (typeof PERSONALITY_KEYS)[number];

export const TALENT_KEYS = ['music', 'sports', 'math', 'language', 'art', 'leadership', 'craft'] as const;
export type TalentKey = (typeof TALENT_KEYS)[number];

export type Tone = 'tragedy' | 'drama' | 'positive' | 'neutral' | 'recovery';

export interface Talent {
  key: TalentKey;
  discovered: boolean;
}

/** 태그(특성)와 내부 플래그. 나이 기준으로 언제 붙었는지, 언제 사라지는지 */
export interface FlagInfo {
  since: number;
  until?: number;
  /** 누구의 기록인가 (인물 ID). 남성 주인공에게 상대가 쓰는 피임 방법만 남긴다 (contraception.ts). 옛 저장에는 없다 */
  owner?: string;
}

export interface Resources {
  cash: number;
  debt: number;
  stocks: number;
  coins: number;
  realEstate: number;
  /** 인맥 0~100 */
  network: number;
}

export type NpcRole =
  | 'mother'
  | 'father'
  | 'grandparent'
  | 'sibling'
  | 'friend'
  | 'partner'
  | 'spouse'
  | 'ex'
  | 'child';

export interface Npc {
  id: string;
  name: string;
  sex: Sex;
  birthYear: number;
  role: NpcRole;
  alive: boolean;
  deathYear?: number;
  deathCause?: string;
  /** 친밀도 0~100 */
  closeness: number;
  health: number;
  job?: string;
  education?: string;
  twin?: boolean;
  /** 연인·배우자가 된 때의 내 나이 */
  since?: number;
  /** 전쟁 통에 헤어져 생사를 모른다 */
  missing?: boolean;
  /**
   * 자녀 기록: 이 아이를 함께 낳은 사람(그때의 배우자, 없으면 연인)의 인물 ID. null이면 그런 사람이 없었다.
   * 이 기록을 남기기 전의 저장에 있던 아이에게는 없다 (자녀로 이어할 때 혼인 시점으로 짐작한다)
   */
  otherParentId?: string | null;
}

export type FamilyType = 'two_parent' | 'single_parent' | 'grandparents' | 'facility';
export type ParentingStyle = 'authoritative' | 'authoritarian' | 'permissive' | 'neglectful';

export interface Family {
  type: FamilyType;
  /** 소득 1~5분위, 6 = 재벌가 */
  wealth: number;
  parentsMarried: boolean;
  /** 부모 부부 관계 0~100 */
  marriageQuality: number;
  parentingStyle: ParentingStyle;
  /** 부모가 물려줄 재산(숨김). 사건으로 드러난다 */
  estate: number;
  /** 부모의 숨은 빚 */
  hiddenDebt: number;
  livesWithParents: boolean;
}

export type SchoolStatus =
  | 'none'
  | 'kindergarten'
  | 'elementary'
  | 'middle'
  | 'high'
  | 'university'
  | 'graduated'
  | 'dropout';

/**
 * 고등학교 유형: 일반고, 외고·국제고, 자사고, 영재학교, 과학고, 예술고, 체육고,
 * 특성화고, 마이스터고, 대안학교
 */
export type HighType =
  | 'general'
  | 'foreign'
  | 'autonomous'
  | 'gifted'
  | 'science'
  | 'arts'
  | 'sports'
  | 'vocational'
  | 'meister'
  | 'alternative';
export type Degree = 'none' | 'elementary' | 'middle' | 'high' | 'college' | 'university';
export type UnivTier = 'S' | 'A' | 'B' | 'C' | 'D';

export interface Education {
  status: SchoolStatus;
  highType?: HighType;
  /** 내신 0~100 */
  grade: number;
  /** 올해 공부 횟수 */
  studyThisYear: number;
  /** 고등학교 3년간 누적 공부 */
  highStudy: number;
  csat?: { percentile: number; grade: number; age: number; tier: UnivTier | null };
  /** 수시·실기·특기자로 미리 붙은 대학 (수능 최저를 맞추면 등록할 수 있다) */
  earlyAdmit?: { name: string; tier: UnivTier };
  degree: Degree;
  univ?: { name: string; tier: UnivTier; startAge: number; years: number };
  /** 휴학 중 (입대 등) */
  onLeave?: boolean;
}

export interface Career {
  jobId?: string;
  title?: string;
  /** 연봉 (원, 그해 물가 기준) */
  salary: number;
  years: number;
  totalYears: number;
  /** 연금 계산용 평균 연봉 */
  avgSalary: number;
  /** 승진 등으로 오른 배수 */
  raise: number;
  retired: boolean;
  /** 연금 (연간) */
  pension: number;
  business?: { name: string; capital: number; years: number };
  history: { jobId: string; title: string; fromAge: number; toAge?: number }[];
  /** 올해 지원한 일자리 */
  appliedThisYear: string[];
  /**
   * 일하는 방식: 고용 형태·계약·부업·면허·실직 기록·소득 원장 (work.ts).
   * 옛 저장에는 없다. 읽을 때는 직업의 표준 형태로 보고, 모르는 과거(계약 만료일 등)는 만들어 넣지 않는다
   */
  work?: WorkState;
}

/** 고용 형태: 정규직, 계약직(기간제), 파견·용역, 일용직, 시간제, 플랫폼 노동, 프리랜서, 자영업, 무급 가족종사 */
export const EMPLOYMENT_TYPES = ['regular', 'contract', 'dispatch', 'daily', 'parttime', 'platform', 'freelance', 'self', 'family'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** 근무 형태: 주간, 교대, 야간, 재택, 현장(야외), 출장·이동, 계절, 불규칙 */
export const WORK_SCHEDULES = ['day', 'shift', 'night', 'remote', 'field', 'travel', 'seasonal', 'irregular'] as const;
export type WorkSchedule = (typeof WORK_SCHEDULES)[number];

/**
 * 일을 그만둔 까닭. 구직급여(비자발적 이직)를 가린다.
 * 사직, 권고사직·해고, 계약 만료, 징계·결격, 업무상 부상, 임금 체불, 폐업, 플랫폼 계정 정지, 정년·은퇴
 */
export type ExitReason = 'quit' | 'layoff' | 'contract_end' | 'dismissed' | 'injury' | 'arrears' | 'closed' | 'deactivated' | 'retire';

/** 면허·자격 하나의 기록. 떨어져도 남고, 다시 응시할 수 있다 */
export interface LicenseRecord {
  /** 응시 횟수 */
  tries: number;
  /** 마지막으로 응시한 나이 (한 해 한 번) */
  lastTry?: number;
  /** 합격한 나이 */
  passed?: number;
  /** 갱신(적성검사)해야 하는 나이 */
  renewAt?: number;
  /** 갱신 기한을 넘겨 효력을 잃었다 */
  lapsed?: boolean;
}

/** 소득 원장 한 해: 금액은 모두 2026년 원 (물가를 나눈 실질액) */
export interface WorkYear {
  age: number;
  jobId?: string;
  type?: EmploymentType;
  /** 본업 세전 소득 (적자면 음수) */
  gross: number;
  /** 부업 세전 소득 */
  side?: number;
  /** 구직급여·휴업급여·체불 회수처럼 일 밖에서 들어온 돈 */
  benefit?: number;
  /** 일용직이 실제로 일한 날 */
  days?: number;
}

export interface WorkState {
  /** 지금 일자리의 고용 형태 */
  type?: EmploymentType;
  /** 주당 근로시간 */
  hours?: number;
  /** 계약이 끝나는 나이 (계약직·파견·시간제). 없으면 기간의 정함이 없다 */
  contractUntil?: number;
  /** 같은 일자리에서 계약을 갱신한 횟수 */
  renewals?: number;
  /** 사업주가 재계약하지 않기로 했다 (다음 해 첫머리에 만료 카드) */
  ending?: boolean;
  /** 지난 평가·사건이 남긴 평판: +는 좋은 평, −는 나쁜 평. 계약 판정에 쓰고 비운다 */
  standing?: number;
  /** 개업·장비에 들인 돈 (2026년 원). 접을 때 일부를 돌려받는다 */
  capital?: number;
  /** 받지 못한 임금 (2026년 원). 진정하면 회수를 시도하고 3년이 지나면 시효로 사라진다 */
  arrears?: { amount: number; since: number };
  /** 업무상 부상: 다친 나이, 쉰 달 수, 처리 방식 */
  injury?: { age: number; months: number; cover: 'claim' | 'company' | 'self' };
  /** 부업 하나 */
  side?: { jobId: string; type: EmploymentType; hours: number; since: number };
  /** 면허·자격 (data/jobs.json licenses의 id) */
  licenses?: Record<string, LicenseRecord>;
  /** 직업훈련을 마친 분야 (care·it·trade·office·drive) */
  trained?: string[];
  /** 마지막으로 일을 그만둔 기록 (구직급여·경력 복귀) */
  exit?: { age: number; reason: ExitReason; jobId: string; type: EmploymentType; wage2026: number; insuredYears: number };
  /** 구직급여를 받은 실직 (exit.age). 같은 실직에 두 번 주지 않는다 */
  benefitFor?: number;
  /** 연도별 소득 원장 (최근 100년) */
  ledger?: WorkYear[];
}

export type MilitaryStatus = 'none' | 'pending' | 'serving' | 'done' | 'exempt';
export type Branch = 'army' | 'navy' | 'airforce' | 'marines' | 'social';

export interface Military {
  status: MilitaryStatus;
  /** 신체등급 1~7 */
  grade?: number;
  branch?: Branch;
  enlistAge?: number;
  dischargeAge?: number;
  /** 부대 분위기 (숨김). 낮으면 부조리 확률이 오른다 */
  unitMood?: number;
}

export interface Legal {
  convictions: number;
  prisonUntil?: number;
  probationUntil?: number;
}

/** 술·담배·불법 약물 (약물은 실제 이름 없이 하나로 추상화한다) */
export const SUBSTANCE_IDS = ['alcohol', 'tobacco', 'drug'] as const;
export type SubstanceId = (typeof SUBSTANCE_IDS)[number];

/** 사용 빈도: 0 안 함, 1 가끔, 2 자주(매일 흡연·주 1회 이상 음주), 3 과다(과음·하루 한 갑 이상) */
export type UseBand = 0 | 1 | 2 | 3;

/** 사건 선택지·활동이 물질 기록에 하는 일 */
export const SUBSTANCE_ACTS = ['offered', 'use', 'refuse', 'cutDown', 'quit', 'treat', 'completeTreatment', 'dropTreatment', 'resist'] as const;
export type SubstanceAct = (typeof SUBSTANCE_ACTS)[number];

/** 물질 하나의 이력. 권유·노출은 사용이 아니다: 직접 고른 사용만 ever·uses에 남는다 */
export interface SubstanceRecord {
  ever: boolean;
  /** 처음·마지막으로 쓴 나이 (옛 저장에서 옮겨 와 모르면 없음) */
  firstAge?: number;
  lastAge?: number;
  /** 평생 사용 횟수 (활동 한 번·사건 선택 한 번) */
  uses: number;
  /** 올해 직접 고른 사용량 (활동 1, 사건 속 한 자리 0.5). 연말에 0으로 */
  usesThisYear: number;
  /** 몸에 밴 습관: 고르지 않아도 이어지는 빈도 */
  habit: UseBand;
  /** 의존 0~100 */
  dependence: number;
  /** 갈망·금단 0~100 */
  craving: number;
  /** 의존이 쌓이는 속도의 개인차 (기록을 만들 때 시드로 정한다) */
  sensitivity: number;
  /** 끊기 시작한 나이. 다시 쓰면 지운다 */
  abstinentSince?: number;
  quitAttempts: number;
  /** 줄이기를 시작한 나이 (그해만 유효) */
  cutDownAge?: number;
  treatment: 'none' | 'active' | 'completed';
  treatmentSince?: number;
  treatmentStarts: number;
  relapses: number;
  /** 권유·노출 횟수와 거절 횟수 */
  offers: number;
  refusals: number;
  lastRefusalAge?: number;
  /** 담배 종류 */
  product?: 'cigarette' | 'ecig';
}

export type Substances = Record<SubstanceId, SubstanceRecord>;

export interface Character {
  surname: string;
  given: string;
  sex: Sex;
  birthYear: number;
  birthRegion: string;
  region: string;
  age: number;
  alive: boolean;
  death?: { age: number; year: number; cause: string };
  stats: Record<StatKey, number>;
  hidden: Record<HiddenKey, number>;
  state: Record<StateKey, number>;
  personality: Record<PersonalityKey, number>;
  talents: Talent[];
  /** 선천 특성 (희귀) */
  traits: string[];
  flags: Record<string, FlagInfo>;
  res: Resources;
  family: Family;
  npcs: Npc[];
  edu: Education;
  career: Career;
  military: Military;
  legal: Legal;
  /** 범죄 피해·목격·지원 사건 기록 (crime.ts). 사건이 없었거나 옛 저장이면 없다 (읽을 때 빈 기록으로 본다) */
  crime?: import('./crime').CrimeLedger;
  /** 술·담배·약물 기록. 한 번도 권유·사용이 없었거나 옛 저장이면 없다 (읽을 때 빈 기록으로 본다) */
  substances?: Substances;
  /** 하루 사슬(빨래·다음 날 일정)과 빌린 옷 같은 의무·인물 기억. 옛 저장에는 없다 (daily.ts readDaily가 빈 기록으로 본다) */
  daily?: import('./daily').DailyState;
}

export type EconomyPhase = 'boom' | 'normal' | 'recession' | 'crisis';

export interface WorldState {
  year: number;
  economy: {
    phase: EconomyPhase;
    growth: number;
    unemployment: number;
    interest: number;
    inflation: number;
    /** 2026년 = 1 */
    priceIndex: number;
    stockIndex: number;
    housingIndex: number;
    minWage: number;
  };
  politics: {
    ruling: string | null;
    approval: number;
    lastPresidential: number;
  };
  /** 남북 긴장도 0~100 */
  tension: number;
  /** 전면전 상태. 끝나면 outcome에 결과가 남는다 */
  war: { active: boolean; yearsLeft: number; startYear?: number; outcome?: 'armistice' | 'unification' };
  /** 통일 이후 */
  unified: boolean;
  automation: number;
  pandemic: number;
  /** 올해의 뉴스 플래그 (예: scamCompound) */
  news: Record<string, boolean>;
}

export interface DirectorState {
  tension: number;
  calmYears: number;
  pace: 'calm' | 'normal' | 'turbulent';
  /** 올해 가장 컸던 사건의 충격량 */
  yearPeak: number;
}

export type LogKind = 'birth' | 'event' | 'milestone' | 'news' | 'year' | 'death' | 'system';

export interface LogEntry {
  year: number;
  age: number;
  kind: LogKind;
  title?: string;
  text: string;
  tone?: Tone;
  impact?: number;
}

export interface Change {
  text: string;
  /** good: 이득, bad: 손해, info: 중립 */
  sign: 'good' | 'bad' | 'info';
}

export interface PendingCard {
  eventId: string;
  ctx: Record<string, string>;
}

export interface CardChoice {
  index: number;
  text: string;
  check?: string;
}

export interface ActiveCard {
  eventId: string;
  serial: number;
  title: string;
  text: string;
  zoom?: string;
  tone: Tone;
  arcLabel?: string;
  /** 생활 사건 풀 (화면 표시용) */
  pool?: string;
  ctx: Record<string, string>;
  choices: CardChoice[];
  /** 사건이 일어나며 바로 적용된 변화 */
  intro: Change[];
  result?: {
    choice: string;
    text: string;
    success?: boolean;
    changes: Change[];
    next?: string;
  };
}

export interface Scheduled {
  eventId: string;
  atAge: number;
  ctx: Record<string, string>;
}

export interface LifeSummary {
  name: string;
  sex: Sex;
  region: string;
  birthYear: number;
  deathYear: number;
  age: number;
  cause: string;
  epitaph: string;
  achievements: string[];
  tags: string[];
  netWorth: number;
  highlights: LogEntry[];
  job?: string;
  degree: string;
  spouse?: string;
  children: number;
  seed: string;
  mode: Mode;
}

export type Phase = 'action' | 'event' | 'dead';

export interface GameState {
  v: number;
  seed: string;
  mode: Mode;
  startYear: number;
  year: number;
  ch: Character;
  world: WorldState;
  director: DirectorState;
  phase: Phase;
  /** 대기열이 비었을 때 어디로 가는가: 연초 관문이면 자유 행동, 연중 사건이면 연말 결산 */
  step: 'yearStart' | 'yearEvents';
  queue: PendingCard[];
  card?: ActiveCard;
  scheduled: Scheduled[];
  points: { max: number; left: number };
  actions: Record<string, number>;
  log: LogEntry[];
  counts: Record<string, number>;
  lastAge: Record<string, number>;
  serial: number;
  summary?: LifeSummary;
  /** 자녀로 이어 사는 판: 몇 대째인지, 누구의 자녀인지 */
  lineage?: { generation: number; parentName: string; rootSeed: string };
}
