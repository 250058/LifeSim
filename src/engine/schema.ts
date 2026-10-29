// /data 아래 JSON 파일들의 형식.

import type {
  AttrKey,
  Branch,
  Degree,
  HighType,
  Mode,
  NpcRole,
  SchoolStatus,
  Sex,
  StageId,
  TalentKey,
  Tone,
  UnivTier,
} from './types';

/** 고정값 또는 [최소, 최대] 범위의 정수 */
export type Range = number | [number, number];

export type EventType = 'milestone' | 'random' | 'chain_start' | 'chain' | 'consequence' | 'npc' | 'world';

export interface TriggerDef {
  /** [최소, 최대] 나이 (포함) */
  age?: [number, number];
  sex?: Sex;
  stage?: StageId[];
  /** 전부 있어야 함 */
  flags?: string[];
  /** 하나 이상 있어야 함 */
  anyFlags?: string[];
  /** 하나도 없어야 함 */
  notFlags?: string[];
  modes?: Mode[];
  if?: string;
}

export interface WeightDef {
  /** p₀: 실제 통계에서 온 연간 기본 확률 */
  base: number;
  /** 인구학적 사건(출산·결혼 등)은 모드 배수를 받지 않는다 */
  noMode?: boolean;
  /** 나이별 배수. 사이 나이는 선형 보간, 범위 밖은 끝값 */
  ageCurve?: Record<string, number>;
  modifiers?: { if: string; x: number }[];
}

export interface LimitDef {
  oncePerLife?: boolean;
  /** 다시 일어나기까지 최소 햇수 */
  cooldown?: number;
  max?: number;
}

export type NextRef = string | { event: string; w: number }[];

export type Action =
  | { type: 'discoverTalent'; talent?: TalentKey }
  | { type: 'addSibling' }
  | { type: 'addFriend' }
  | { type: 'loseFriend' }
  | { type: 'startPartner' }
  | { type: 'breakUp' }
  | { type: 'marry' }
  | { type: 'haveChild' }
  | { type: 'divorce' }
  | { type: 'parentsDivorce'; with?: 'mother' | 'father' }
  | { type: 'parentsMarriage'; delta: number }
  | { type: 'moveRegion'; region?: string }
  | { type: 'enroll'; school: SchoolStatus; highType?: HighType }
  | { type: 'computeCsat' }
  /** early면 수시로 붙은 대학, 아니면 카드의 {합격대학} 또는 수능 등급에 맞는 대학 */
  | { type: 'enterUniversity'; early?: boolean }
  /** 카드의 {합격대학}을 수시 합격으로 기록 */
  | { type: 'earlyAdmit' }
  /** 검정고시 합격: 고졸 학력 */
  | { type: 'passGed' }
  | { type: 'graduate' }
  | { type: 'getJob'; job: string }
  | { type: 'loseJob'; severanceMonths?: number }
  | { type: 'promote'; pct: number }
  | { type: 'retire' }
  | { type: 'militaryExam' }
  /** inYears 뒤 입영 (기본 1년) */
  | { type: 'enlist'; branch?: Branch; inYears?: number }
  | { type: 'startService' }
  | { type: 'discharge' }
  /** crime이 'ctx'면 카드 ctx.crime을 쓴다 */
  | { type: 'prosecute'; crime: string; lenient?: boolean }
  | { type: 'release' }
  | { type: 'gamble'; stakePct: number; winChance: number; winMult: number }
  | { type: 'startBusiness'; capitalPct: number; name?: string }
  | { type: 'closeBusiness'; recoverPct: number }
  | { type: 'parentHealth'; delta: number }
  | { type: 'npcCloseness'; role: NpcRole | 'parents'; delta: number }
  | { type: 'leaveHome' }
  /** 이번 카드에서 잃은 돈(ctx.lastLoss)의 일부를 돌려받는다 */
  | { type: 'refundPct'; pct: number }
  /** ctx.inheritance (상속 총액)의 비율만큼 받는다. limited면 한정승인: 빚은 넘어오지 않는다 */
  | { type: 'inherit'; share: number; limited?: boolean }
  | { type: 'grade'; delta: number }
  /** 개인회생(일부)·파산(전부): 빚의 pct를 탕감 */
  | { type: 'debtRelief'; pct: number }
  | { type: 'buyHome'; downPct: number };

export interface Effects {
  stats?: Partial<Record<AttrKey, Range>>;
  money?: {
    cash?: Range;
    /** 현금의 비율 (-0.5 = 절반 잃음) */
    cashPct?: number;
    debt?: Range;
    stocksPct?: number;
    coinsPct?: number;
    realEstatePct?: number;
    network?: Range;
  };
  addFlags?: string[];
  removeFlags?: string[];
  /** n년 뒤 이어지는 사건 */
  later?: { event: string; inYears: number }[];
  /** 디렉터 긴장도 추가분 */
  tension?: number;
  /** 사망 (원인) */
  death?: string;
  do?: Action[];
}

export interface CheckDef {
  stat?: string;
  /** 여러 능력치 평균으로 판정 */
  stats?: string[];
  dc: number;
}

export interface OutcomeDef {
  text?: string;
  next?: NextRef;
  effects?: Effects;
}

export interface ChoiceDef {
  text: string;
  /** 이 조건이 참일 때만 선택지가 보인다 */
  if?: string;
  check?: CheckDef;
  effects?: Effects;
  result?: string;
  next?: NextRef;
  onSuccess?: OutcomeDef;
  onFail?: OutcomeDef;
}

export interface EventDef {
  id: string;
  type: EventType;
  arc?: string;
  /** 참고한 실제 사건과 출처 */
  motif?: string;
  title: string;
  text: string;
  /** 확대 모드 표시 (예: '수능 당일 · 08:40') */
  zoom?: string;
  tone?: Tone;
  /** 디렉터 긴장도에 더하는 충격량 0~100 */
  impact?: number;
  /** 조용한 해를 채울 때 쓰는 일상 사건 (디렉터가 드라마·막장 모드에서 고른다) */
  filler?: boolean;
  trigger?: TriggerDef;
  weight?: WeightDef;
  limit?: LimitDef;
  /** 같은 해 관문끼리의 순서 */
  order?: number;
  /** 사건이 일어나는 순간 적용 */
  effects?: Effects;
  choices?: ChoiceDef[];
  /** 선택지가 없는 카드를 넘긴 뒤 이어지는 사건 */
  next?: NextRef;
}

export interface TagDef {
  id: string;
  name: string;
  desc?: string;
  visible: boolean;
  /** n년 뒤 자동으로 사라짐 */
  duration?: number;
  /** 묘비명 조각 (예: '교실에서도') */
  epitaph?: string;
  priority?: number;
  achievement?: boolean;
  sign?: 'good' | 'bad' | 'info';
}

export interface JobDef {
  id: string;
  title: string;
  category: string;
  minAge: number;
  maxAge?: number;
  minDegree: Degree;
  minTier?: UnivTier;
  req?: string;
  /** [초봉, 25년 차 연봉] (2026년 원) */
  salary: [number, number];
  /** 연봉 변동 폭 (유튜버처럼 들쭉날쭉한 직업) */
  volatility?: number;
  stress: number;
  layoffRisk: number;
  retireAge: number;
  hire: number;
  /** 구직 목록에 나오는가 */
  listed: boolean;
  epitaph?: string;
  desc?: string;
}

export interface RegionDef {
  id: string;
  name: string;
  short: string;
  births2024: number;
  costIndex: number;
  homePrice: number;
  metro: boolean;
}

export interface NamesData {
  surnames: [string, number][];
  given: Record<string, { M: string[]; F: string[] }>;
}

export interface ModeDef {
  label: string;
  desc: string;
  /** [평생 확률, 배수] 점들. log(확률) 기준 선형 보간 */
  curve: [number, number][];
  /** 디렉터가 조용한 해를 일상 사건으로 채우는가 */
  filler: boolean;
}

export interface WorldData {
  modes: Record<Mode, ModeDef>;
  parties: string[];
  universities: Record<UnivTier, string[]>;
  /** 과학기술원·예술대·체육대 (가상 이름) */
  specialUniversities: { science: string[]; arts: string[]; sports: string[] };
  news: Record<string, string[]>;
  causesOfDeath: { maxAge: number; causes: [string, number][] }[];
  cancerTypes: string[];
}

export interface ActivityDef {
  id: string;
  name: string;
  desc: string;
  group: 'growth' | 'social' | 'money' | 'life' | 'risk';
  points: number;
  /** 성인이 직접 내는 비용 (원) */
  cost?: number;
  age: [number, number];
  if?: string;
  effects?: Effects;
  discover?: { talent: TalentKey; chance: number }[];
  /** 특수 처리 (엔진 코드) */
  special?:
    | 'friend'
    | 'dating'
    | 'date'
    | 'parttime'
    | 'theft'
    | 'gamble'
    | 'counsel'
    | 'checkup'
    | 'family'
    | 'certificate'
    | 'drink';
  log?: string;
}
