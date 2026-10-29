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
  SubstanceAct,
  SubstanceId,
  TalentKey,
  Tone,
  UnivTier,
} from './types';

/** 고정값 또는 [최소, 최대] 범위의 정수 */
export type Range = number | [number, number];

export type EventType = 'milestone' | 'random' | 'chain_start' | 'chain' | 'consequence' | 'npc' | 'world';

/**
 * 생활 사건 풀. 수천 개의 작은 사건(병원, 몸, 밥상, 연애, 육아)을 하나하나 굴리지 않고
 * 해마다 풀에서 한 장만 뽑는다. 사건 수가 늘어도 한 해에 나오는 카드 수는 그대로다.
 */
export type PoolId = 'medical' | 'physiology' | 'nutrition' | 'romance' | 'parenting';

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
  /** 이 나이대([최소, 최대])의 자녀가 살아 있어야 한다. {자녀}도 이 나이대에서 고른다 */
  childAge?: [number, number];
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
  /** 피난길에 가족 한 명과 헤어진다 (이산가족) */
  | { type: 'separateFamily' }
  /** 헤어진 가족을 다시 만난다 */
  | { type: 'reunite' }
  /** 범죄 피해·목격·지원 사건 (crime.ts): open 장면으로 사건을 연다, respond 대응, advance 기관 단계. inst는 그 대응이 연락하는 기관 id */
  | { type: 'crime'; op: 'open' | 'respond' | 'advance'; scene?: string; act?: string; step?: string; inst?: string }
  /** 스타일을 바꾼다 (다른 스타일 태그는 지운다) */
  | { type: 'setStyle'; style: 'basic' | 'trendy' | 'luxury' | 'comfort' }
  | { type: 'buyHome'; downPct: number }
  /**
   * 술·담배·약물 기록 (substances.ts). use는 만 19세 이상만 처리되고 미성년자는 노출로만 남는다.
   * substance가 'ctx'면 카드 ctx.substance를 쓴다. 치료 마침·중단·버티기는 생략하면 해당하는 물질 전부
   */
  | { type: 'substance'; substance?: SubstanceId | 'ctx'; act: SubstanceAct; amount?: number; product?: 'cigarette' | 'ecig' };

/**
 * 치료 한 단계. 기간이 있는 치료 태그(TagDef.stopped가 있는 태그)는 add/remove 대신 이것으로 다룬다.
 *   start    시작한다. 이미 하는 중이면 기한만 새로 잡는다
 *   continue 이어 간다. 기한을 지금부터 다시 잡는다 (until = 지금 나이 + duration)
 *   reduce   줄여 가다 끊는다. 올해 연말 결산까지만 하고 그 뒤에는 '중단 후' 태그가 남는다
 *   stop     그만둔다. 치료 중 태그를 지우고 '중단 후' 태그를 남긴다 (판정의 성공·실패 양쪽에 쓴다)
 *   resume   그만뒀던 치료를 다시 시작한다. '중단 후' 태그를 지운다
 */
export type TreatAct = 'start' | 'continue' | 'reduce' | 'stop' | 'resume';

export interface TreatStep {
  tag: string;
  act: TreatAct;
}

/**
 * 상태가 실제로 바뀔 때만 주는 능력치 (만성 질환을 관리하기 시작할 때의 회복 같은 것).
 * from 태그가 있다가 이번 효과로 사라지고, to가 있으면 그 태그가 없다가 새로 생겼을 때만 적용한다.
 * 같은 카드를 되풀이해도 상태가 그대로면 쌓이지 않는다.
 */
export interface TransitionReward {
  from: string;
  to?: string;
  stats: Partial<Record<AttrKey, Range>>;
}

export interface Effects {
  stats?: Partial<Record<AttrKey, Range>>;
  money?: {
    cash?: Range;
    /** 2026년 원 기준 금액. 그해 물가를 곱해 적용한다 (병원비·식비처럼 시대와 함께 오르는 돈) */
    cash2026?: Range;
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
  /** 치료 단계 (시작·유지·감량·중단·재개) */
  treat?: TreatStep[];
  /** 상태가 실제로 바뀔 때만 적용하는 능력치 */
  transition?: TransitionReward;
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
  /** 생활 사건 풀. 있으면 개별로 굴리지 않고 풀 추첨으로만 나온다 */
  pool?: PoolId;
  /** 성인 전용 (연애·성). 플레이어가 만 19세 이상일 때만 나온다 */
  adult?: boolean;
  /** 같은 묶음(예: 같은 생리 현상의 여러 장면)은 몇 해 안에 다시 뽑히지 않는다 */
  group?: string;
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
  /**
   * n년 뒤 자동으로 사라짐. 붙은 나이 + n이 until이고, 태그는 until 나이의 연말 결산까지 남는다
   * (그해 연초에 오는 예약 사건까지는 유효하다)
   */
  duration?: number;
  /**
   * 치료 태그: 그만두면 남는 '중단 후' 태그. 중단 뒤 경과 사건은 이 태그를 원인으로 쓴다.
   * 이 필드가 있는 태그는 사건이 add/remove 대신 treat로 다룬다
   */
  stopped?: string;
  /** 계속 받아야 하는 치료: 유지를 고르지 않은 채 기한이 지나면 중단으로 본다 (없으면 정해진 기간을 마친 것) */
  ongoing?: boolean;
  /** 치료 이름: 시작·유지·중단을 알릴 때 쓴다 (없으면 태그 이름. 예: '결핵 치료 중' 태그 → '결핵 치료') */
  treatment?: string;
  /** 묘비명 조각 (예: '교실에서도') */
  epitaph?: string;
  priority?: number;
  achievement?: boolean;
  sign?: 'good' | 'bad' | 'info';
  /** 이 태그가 있으면 해마다 건강이 이만큼 변한다 (만성 질환은 음수) */
  healthPerYear?: number;
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
  /** front: 전방, coastal: 태풍, quake: 지진, wildfire: 산불, lowland: 저지대 침수 */
  risks: string[];
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
    | 'substance'
    | 'shopping'
    | 'diet'
    | 'foodie'
    | 'motel'
    | 'intimacy';
  /** special 'substance': 술·담배·약물 행동 (substances.ts) */
  substance?: { id: SubstanceId; act: SubstanceAct; product?: 'cigarette' | 'ecig'; context?: 'social' | 'alone' };
  /** 성인 전용: 본인이 만 19세 이상일 때만 보인다 (술·담배 등) */
  adult?: boolean;
  /** 커플 활동: 연인·배우자도 만 19세 이상이어야 한다 (family.partnerAdult). adult와 함께 쓴다 */
  couple?: boolean;
  log?: string;
}
