// 범죄 피해·목격·지원 사건표(data/catalog/crime.json)를 엔진 사건으로 펼친다 (U-002).
//
//  - 장면(scenes) 한 줄 = 범주 × 맥락 × 역할 하나. 해마다 실제 통계에서 온 연간 확률로 따로 굴린다
//    (생활 풀이 아니다). 드라마·막장 배수는 기존 모드 규칙(world.ts modeMultiplier)이 그대로 준다.
//  - 단계(steps) 한 줄 = 사건 뒤에 이어지는 수사·검찰·재판·조직 조사·진정·민사·보호조치·재발·회복 카드.
//    엔진(src/engine/crime.ts)이 사건 번호(ctx.caseId)를 붙여 예약하고, 결과 문장은 ctx.결과에 채운다.
//  - 아동·청소년 보호 장면(minor): 성인 전용 표시(adult)를 붙이지 않는다. 대신 털어놓기·보호자·학교·신고·지원·
//    회복만 고르는 장면이고 (MINOR_SAFE_ACTS), 성적 행동 선택지와 행위 묘사는 없다. 검사는 crime.ts가 한다.
//
// 이 파일은 표를 펼치기만 한다. 엔진 모듈을 가져오지 않는다 (data.ts → catalog → 엔진으로 도는 순환을 막는다).
// 법 규정에서 온 값(공소시효·고소기간·반의사불벌·보호조치)과 게임 추정값(검거·처분·선고 비율)은 아래 표에 함께 두고
// 주석으로 구분한다.

import type { ChoiceDef, EventDef } from '../schema';
import type { Sex, Tone } from '../types';
import { and, toEffects, type Fx } from './build';

export const CRIME_CATEGORIES = [
  'random_violence',
  'assault',
  'threat',
  'robbery',
  'theft',
  'vandalism',
  'trespass',
  'domestic',
  'dating',
  'stalking',
  'sexual_assault',
  'sexual_harassment',
  'spycam',
  'distribution',
  'deepfake',
  'sextortion',
  'fraud',
  'extortion',
  'cyber_harassment',
  'grooming',
] as const;
export type CrimeCategory = (typeof CRIME_CATEGORIES)[number];

/** 주인공의 자리: 피해자, 목격자, 피해를 입은 가족·친구를 돕는 사람 */
export const CRIME_ROLES = ['victim', 'witness', 'supporter'] as const;
export type CrimeRole = (typeof CRIME_ROLES)[number];

/** 가해자가 누구인가. partner·spouse·parent·ex는 가능하면 기존 NPC와 같은 사람으로 묶는다 */
export const OFFENDER_KINDS = [
  'stranger',
  'acquaintance',
  'superior',
  'coworker',
  'customer',
  'professor',
  'partner',
  'ex',
  'spouse',
  'parent',
  'neighbor',
  'online',
  'peer',
  'unknown',
] as const;
export type OffenderKind = (typeof OFFENDER_KINDS)[number];

/** 피해자가 누구인가. 피해자 역할이면 self, 목격이면 대개 stranger, 지원 역할이면 기존 NPC */
export const VICTIM_KINDS = ['self', 'stranger', 'friend', 'sibling', 'child', 'parent', 'partner'] as const;
export type VictimKind = (typeof VICTIM_KINDS)[number];

/** 사건을 맡는 조직: 직장(고충·인사), 학교(학교폭력 사안), 대학(인권센터), 플랫폼(신고·차단) */
export type OrgKind = 'work' | 'school' | 'univ' | 'platform';

/** 선택지가 사건에 하는 일 */
export const CRIME_ACTS = [
  // 피해자의 대응. 신고·대면을 강제하지 않도록 장면마다 다른 길을 함께 둔다
  'avoid', 'help', 'report', 'counsel', 'record', 'internal', 'transfer', 'move', 'quit', 'postpone', 'confront',
  'block', 'takedown', 'pay', 'refuse',
  // 목격자 (depose 참고인 진술, decline 진술 거절: 참고인은 출석 의무가 없다)
  'intervene', 'hurt', 'film', 'comfort', 'leave', 'depose', 'decline',
  // 지원하는 사람 (guardian_report: 미성년 자녀의 보호자로서 신고. 형사소송법 225조 법정대리인의 고소권)
  'listen', 'accompany', 'advise', 'respect', 'guardian_report',
  // 아동·청소년: 믿을 만한 선생님에게 말한다 (학교 종사자는 신고 의무자다)
  'teacher',
  // 기관 단계의 선택
  'object', 'appeal', 'testify', 'statement', 'settle', 'absent', 'civil', 'labor', 'nhrck', 'commission',
  'accept', 'close', 'violation', 'safety', 'care', 'wait',
] as const;
export type CrimeAct = (typeof CRIME_ACTS)[number];

/** 신고·대면처럼 플레이어에게 강요하면 안 되는 대응. 장면마다 이것 말고 고를 길이 둘 이상 있어야 한다 */
export const PRESSING_ACTS: readonly CrimeAct[] = ['report', 'confront', 'guardian_report'];

/**
 * 아동·청소년 보호 장면에서 고를 수 있는 대응: 털어놓기·보호자·선생님·상담·신고·기록·차단·삭제 지원·미루기·피하기,
 * 그리고 곁에서 돕는 사람의 대응. 돈을 보내거나 요구에 응하는 길, 대면·촬영·퇴사·이사 같은 성인의 길은 없다.
 */
export const MINOR_SAFE_ACTS: readonly CrimeAct[] = [
  'help', 'teacher', 'counsel', 'report', 'record', 'block', 'takedown', 'postpone', 'avoid', 'internal',
  'listen', 'accompany', 'advise', 'respect', 'guardian_report',
];

export const CRIME_STEPS = [
  'police',
  'prosecution',
  'trial',
  'verdict',
  'internal',
  'admin',
  'civil',
  'protect',
  'repeat',
  'revisit',
  'witness',
  'support',
  'news',
  'recovered',
] as const;
export type CrimeStep = (typeof CRIME_STEPS)[number];

export function stepEventId(step: CrimeStep): string {
  return `crime_${step}`;
}

/** 범주 규칙. 법에서 온 값과 게임 추정값을 나눠 적는다 */
export interface CategoryRule {
  /** {혐의}에 쓰는 이름 */
  label: string;
  /**
   * 성범죄·성희롱. 일반 장면은 본인이 만 19세 이상일 때만 생긴다 (피해·목격·지원 모두, 지원 대상도 성인).
   * 아동·청소년의 피해는 보호 장면(SceneRow.minor)으로만 다룬다: 털어놓기·보호·신고·지원·회복이고 성적 행동 선택지는 없다
   */
  sexual: boolean;
  /** 미성년 주인공에게 열리는 일반 장면의 역할 (비성적 범죄의 피해·목격). 보호 장면은 이 표와 따로 연다 */
  minorRoles: readonly CrimeRole[];
  /**
   * 피해자가 미성년이면 공소시효가 성년(만 19세)이 된 날부터 흐른다: 성폭력처벌법 21조 1항, 아청법 20조 1항,
   * 아동학대처벌법 34조 1항(가정폭력 범주의 아동학대)
   */
  minorClock?: boolean;
  /** 13세 미만 피해자면 공소시효가 없다: 강간·강제추행 등 (성폭력처벌법 21조 3항) */
  noLimitUnder13?: boolean;
  /** 형사 절차: yes 범죄, online 온라인에서만 범죄(통신매체이용음란), no 형사 처벌 대상이 아님 */
  criminal: 'yes' | 'online';
  /** 공소시효 (년). 형사소송법 249조: 법정형 장기 10년 이상 10년, 10년 미만 7년, 5년 미만 5년 */
  limitation: number;
  /** 친고죄 고소기간 (개월, 형사소송법 230조). 가벼운 사건(harm ≤ 1)에만 적용 */
  complaintMonths?: number;
  /** 반의사불벌죄: 피해자가 처벌을 원하지 않으면 공소권 없음 (가벼운 사건) */
  waivable?: boolean;
  /** 보호조치: stalking 스토킹처벌법 긴급응급조치·잠정조치, domestic 가정폭력처벌법 임시조치·피해자보호명령, safety 신변보호 */
  protection?: 'stalking' | 'domestic' | 'safety';
  /** 같은 사람이 다시 다가올 수 있는 사건 (재발 판정) */
  ongoing?: boolean;
  /** 추정: 모르는 가해자를 경찰이 특정할 확률 */
  identify: number;
  /** 추정: 피해의 무게 0~3 (회복 출발점과 충격) */
  weight: number;
  /** 추정: 검찰 처분 비율 [구공판 기소, 약식기소(벌금), 기소유예, 불기소] */
  disposal: [number, number, number, number];
  /** 추정: 유죄 판결 중 [실형, 집행유예, 벌금] */
  sentence: [number, number, number];
  /** 추정: 1심 무죄율 */
  acquittal: number;
}

const NO_MINOR: readonly CrimeRole[] = [];

export const CATEGORY: Record<CrimeCategory, CategoryRule> = {
  // 이상동기 폭행: 특수상해·살인미수 등 중대 범죄. 공소시효는 10년으로 단순화 (살인미수는 더 길다)
  random_violence: {
    label: '이상동기 폭행', sexual: false, minorRoles: ['witness'], criminal: 'yes', limitation: 10,
    identify: 0.98, weight: 3, disposal: [0.95, 0, 0, 0.05], sentence: [0.9, 0.1, 0], acquittal: 0.02,
  },
  // 폭행(형법 260조, 2년 이하, 반의사불벌, 공소시효 5년)·상해(257조, 7년 이하, 공소시효 7년)
  assault: {
    label: '폭행·상해', sexual: false, minorRoles: ['witness'], criminal: 'yes', limitation: 7, waivable: true,
    identify: 0.75, weight: 2, disposal: [0.2, 0.35, 0.2, 0.25], sentence: [0.15, 0.35, 0.5], acquittal: 0.04,
  },
  // 협박(283조, 3년 이하, 반의사불벌, 공소시효 5년)
  threat: {
    label: '협박', sexual: false, minorRoles: NO_MINOR, criminal: 'yes', limitation: 5, waivable: true, ongoing: true,
    identify: 0.8, weight: 1, disposal: [0.15, 0.35, 0.2, 0.3], sentence: [0.1, 0.4, 0.5], acquittal: 0.05,
  },
  // 강도(333조, 3년 이상 유기징역 → 공소시효 10년)
  robbery: {
    label: '강도', sexual: false, minorRoles: NO_MINOR, criminal: 'yes', limitation: 10,
    identify: 0.9, weight: 2, disposal: [0.85, 0, 0.05, 0.1], sentence: [0.65, 0.35, 0], acquittal: 0.03,
  },
  // 절도(329조, 6년 이하 → 공소시효 7년)
  theft: {
    label: '절도', sexual: false, minorRoles: ['victim', 'witness'], criminal: 'yes', limitation: 7,
    identify: 0.45, weight: 0, disposal: [0.15, 0.4, 0.25, 0.2], sentence: [0.15, 0.3, 0.55], acquittal: 0.03,
  },
  // 재물손괴(366조, 3년 이하 → 5년)
  vandalism: {
    label: '재물손괴', sexual: false, minorRoles: NO_MINOR, criminal: 'yes', limitation: 5,
    identify: 0.5, weight: 0, disposal: [0.1, 0.45, 0.2, 0.25], sentence: [0.05, 0.15, 0.8], acquittal: 0.03,
  },
  // 주거침입(319조, 3년 이하 → 5년)
  trespass: {
    label: '주거침입', sexual: false, minorRoles: NO_MINOR, criminal: 'yes', limitation: 5,
    identify: 0.6, weight: 1, disposal: [0.2, 0.35, 0.2, 0.25], sentence: [0.15, 0.4, 0.45], acquittal: 0.04,
  },
  // 가정폭력: 폭행·상해 + 가정폭력처벌법(임시조치 29조, 가정보호사건, 피해자보호명령 55조의2)
  domestic: {
    label: '가정폭력', sexual: false, minorRoles: ['witness'], criminal: 'yes', limitation: 7, protection: 'domestic', ongoing: true, minorClock: true,
    identify: 1, weight: 2, disposal: [0.15, 0.15, 0.35, 0.35], sentence: [0.15, 0.45, 0.4], acquittal: 0.04,
  },
  // 교제폭력: 별도 법이 없어 폭행·상해·협박 등으로 처리, 신변보호(스마트워치)·스토킹 잠정조치를 함께 쓴다
  dating: {
    label: '교제폭력', sexual: false, minorRoles: NO_MINOR, criminal: 'yes', limitation: 7, waivable: true, protection: 'safety', ongoing: true,
    identify: 1, weight: 2, disposal: [0.25, 0.25, 0.2, 0.3], sentence: [0.2, 0.45, 0.35], acquittal: 0.04,
  },
  // 스토킹처벌법(2021.10 시행): 3년 이하(공소시효 5년), 2023.7 반의사불벌 조항 폐지, 긴급응급조치·잠정조치
  stalking: {
    label: '스토킹', sexual: false, minorRoles: NO_MINOR, criminal: 'yes', limitation: 5, protection: 'stalking', ongoing: true,
    identify: 0.85, weight: 2, disposal: [0.45, 0.2, 0.1, 0.25], sentence: [0.25, 0.5, 0.25], acquittal: 0.04,
  },
  // 강간(297조)·강제추행(298조): 공소시효 10년 (성폭력처벌법 21조: DNA 등 과학적 증거가 있으면 10년 연장),
  // 친고죄 폐지(2013). 공중밀집장소추행(11조)·업무상 위력 추행(10조)은 3년 이하라 장면에서 5년으로 덮어쓴다
  sexual_assault: {
    label: '성폭력·성추행', sexual: true, minorRoles: NO_MINOR, criminal: 'yes', limitation: 10, minorClock: true, noLimitUnder13: true,
    identify: 0.6, weight: 3, disposal: [0.45, 0.1, 0.05, 0.4], sentence: [0.35, 0.45, 0.2], acquittal: 0.06,
  },
  // 성희롱 자체는 형사 범죄가 아니다. 온라인의 성적 메시지는 통신매체이용음란(성폭력처벌법 13조, 2년 이하 → 5년).
  // 직장 내 성희롱은 남녀고용평등법(사업주 조치 의무 14조, 고객 성희롱 14조의2)·징계·민사로 따로 다룬다
  sexual_harassment: {
    label: '성희롱', sexual: true, minorRoles: NO_MINOR, criminal: 'online', limitation: 5, ongoing: true, minorClock: true,
    identify: 0.6, weight: 1, disposal: [0.2, 0.4, 0.15, 0.25], sentence: [0.05, 0.25, 0.7], acquittal: 0.05,
  },
  // 카메라등이용촬영(성폭력처벌법 14조 1항, 7년 이하 → 7년)
  spycam: {
    label: '불법촬영', sexual: true, minorRoles: NO_MINOR, criminal: 'yes', limitation: 7, minorClock: true,
    identify: 0.6, weight: 2, disposal: [0.6, 0.15, 0.05, 0.2], sentence: [0.3, 0.5, 0.2], acquittal: 0.03,
  },
  // 촬영물 반포(14조 2항, 7년 이하)
  distribution: {
    label: '촬영물 유포', sexual: true, minorRoles: NO_MINOR, criminal: 'yes', limitation: 7, ongoing: true, minorClock: true,
    identify: 0.6, weight: 3, disposal: [0.7, 0.05, 0, 0.25], sentence: [0.45, 0.45, 0.1], acquittal: 0.03,
  },
  // 허위영상물 편집·반포(14조의2, 7년 이하. 2024 개정으로 소지·시청도 처벌)
  deepfake: {
    label: '허위영상물(합성물)', sexual: true, minorRoles: NO_MINOR, criminal: 'yes', limitation: 7, minorClock: true,
    identify: 0.45, weight: 2, disposal: [0.6, 0.1, 0.05, 0.25], sentence: [0.35, 0.5, 0.15], acquittal: 0.03,
  },
  // 촬영물 등을 이용한 협박(14조의3, 1년 이상 유기징역 → 10년)
  sextortion: {
    label: '촬영물 이용 협박', sexual: true, minorRoles: NO_MINOR, criminal: 'yes', limitation: 10, ongoing: true, minorClock: true,
    identify: 0.3, weight: 2, disposal: [0.8, 0, 0, 0.2], sentence: [0.6, 0.4, 0], acquittal: 0.03,
  },
  // 사기(347조, 10년 이하 → 10년)
  fraud: {
    label: '사기', sexual: false, minorRoles: ['victim'], criminal: 'yes', limitation: 10,
    identify: 0.55, weight: 0, disposal: [0.4, 0.25, 0.1, 0.25], sentence: [0.35, 0.35, 0.3], acquittal: 0.05,
  },
  // 공갈(350조, 10년 이하 → 10년)
  extortion: {
    label: '공갈', sexual: false, minorRoles: ['victim'], criminal: 'yes', limitation: 10, ongoing: true,
    identify: 0.7, weight: 1, disposal: [0.35, 0.2, 0.2, 0.25], sentence: [0.3, 0.45, 0.25], acquittal: 0.04,
  },
  // 정보통신망법 명예훼손(70조: 사실 3년·허위 7년 이하, 반의사불벌)·모욕(형법 311조, 친고죄: 범인을 안 날부터 6개월 안에 고소)
  cyber_harassment: {
    label: '온라인 괴롭힘', sexual: false, minorRoles: ['victim', 'witness'], criminal: 'yes', limitation: 5, complaintMonths: 6,
    waivable: true, ongoing: true,
    identify: 0.5, weight: 1, disposal: [0.05, 0.6, 0.15, 0.2], sentence: [0.02, 0.08, 0.9], acquittal: 0.05,
  },
  // 온라인 그루밍: 19세 이상이 성적 착취를 목적으로 아동·청소년에게 정보통신망으로 대화·유인 (아청법 15조의2, 2021.9 시행,
  // 3년 이하 → 공소시효 5년, 피해자가 성년이 된 날부터). 피해자는 아동·청소년뿐이라 보호 장면에만 쓴다
  grooming: {
    label: '온라인 그루밍', sexual: true, minorRoles: NO_MINOR, criminal: 'yes', limitation: 5, ongoing: true, minorClock: true,
    identify: 0.55, weight: 2, disposal: [0.6, 0.15, 0.05, 0.2], sentence: [0.3, 0.5, 0.2], acquittal: 0.04,
  },
};

// ── 표의 모양 ────────────────────────────────────────────

export interface ContextRow {
  label: string;
  org?: OrgKind;
  online?: boolean;
}

export interface ResponseRow {
  text: string;
  result: string;
}

/** 장면의 선택지: 대응 id 하나 또는 문구·조건·판정을 바꾼 대응 */
export interface SceneChoice {
  act: CrimeAct;
  /** 이 선택지가 연락하는 기관 (crime.json institutions의 id). 없으면 엔진이 범주로 정한다 */
  inst?: string;
  text?: string;
  result?: string;
  if?: string;
  fx?: Fx;
  /** 판정 (예: ["stamina", 55]). 실패하면 failAct·fail·failFx */
  check?: [string, number];
  failAct?: CrimeAct;
  fail?: string;
  failFx?: Fx;
}

export interface SceneRow {
  id: string;
  cat: CrimeCategory;
  ctx: string;
  role: CrimeRole;
  offender: OffenderKind;
  /** 피해자 (기본: 피해자 역할이면 self, 아니면 stranger) */
  victim?: VictimKind;
  /** 가해자 호칭 후보 (없으면 종류별 기본값) */
  who?: string[];
  /** 목격 장면의 피해자 호칭 후보 (없으면 '낯선 사람') */
  whom?: string[];
  /** 지원 역할에서 피해자가 몇 해 전 일을 이제 털어놓는 경우 [최소, 최대] 년 전 (공소시효는 그때부터 센다) */
  ago?: [number, number];
  /** 가해자가 미성년인가 (소년부 송치) */
  minorOffender?: boolean;
  /**
   * 아는 사람(acquaintance)이 가해자인 피해 장면에서, 그 사람이 이미 아는 성인 친구(NPC)일 확률.
   * 없으면 늘 새 참여자다. 성인 피해자 장면에서만 쓰고 보호 장면·성범죄 장면에는 쓰지 않는다 (검사 규칙)
   */
  friendOffender?: number;
  age: [number, number];
  sex?: Sex;
  if?: string;
  /** 지원 역할에서 자녀 나이대 (성범죄면 성인 자녀만) */
  childAge?: [number, number];
  /** 현실 모드의 연간 확률 (그 조건에 있는 사람 1인당) */
  base: number;
  ageCurve?: Record<string, number>;
  mods?: { if: string; x: number }[];
  /** 기본 확률의 근거 (출처 키와 계산) */
  src: string;
  cooldown?: number;
  /** 피해 정도 0~3 (최소, 최대) */
  harm?: [number, number];
  /** 금전 피해 (2026년 원) */
  loss?: [number, number];
  /** 건강 손상 */
  hurt?: [number, number];
  /** 공소시효 덮어쓰기 (장면의 죄명이 범주 기본과 다를 때) */
  limitation?: number;
  /** 목격자·주변 사람의 신고로 사건 직후 경찰이 이미 알고 있다 */
  autoReport?: boolean;
  /** 이 사건은 다른 파일에 있다 (예: disaster.json random_attack). 표는 사건 정보만 준다 */
  external?: boolean;
  /**
   * 아동·청소년 보호 장면. 'self' 주인공이 미성년 피해자이거나 미성년 친구를 돕는다 (본인 만 19세 미만),
   * 'guardian' 주인공이 미성년 자녀의 보호자다 (본인 성인, 피해자는 미성년 자녀). 성인 전용 표시를 붙이지 않고
   * MINOR_SAFE_ACTS만 쓴다. 행위를 묘사하지 않는다
   */
  minor?: 'self' | 'guardian';
  /** {혐의}에 쓰는 이름 (범주 이름과 다를 때. 예: 가정폭력 범주의 아동학대) */
  label?: string;
  title: string;
  text: string;
  zoom?: string;
  tone?: Tone;
  impact?: number;
  choices: (CrimeAct | SceneChoice)[];
}

export interface StepChoice {
  act: CrimeAct;
  text: string;
  inst?: string;
  result?: string;
  if?: string;
  fx?: Fx;
}

export interface StepRow {
  step: CrimeStep;
  title: string;
  text: string;
  zoom?: string;
  tone?: Tone;
  impact?: number;
  /** 사건이 아직 이어질 때만 (기본: 사건이 있으면) */
  if?: string;
  choices?: StepChoice[];
}

/** 사건을 맡거나 돕는 기관. 사건 기록(log)에 이 id가 남는다 */
export interface InstitutionRow {
  label: string;
  /** 하는 일과 근거 법 */
  about: string;
}

export interface CrimeCatalog {
  about?: string;
  sources: Record<string, string>;
  institutions: Record<string, InstitutionRow>;
  contexts: Record<string, ContextRow>;
  responses: Record<string, ResponseRow>;
  scenes: SceneRow[];
  steps: StepRow[];
  /** 결과 문장. '단계.결과' 또는 '단계.결과.범주'·'단계.결과.역할' 키, 값은 고를 문장 목록 */
  outcomes: Record<string, string[]>;
}

// ── 펼치기 ───────────────────────────────────────────────

/** 갇혀 있거나 복무 중이면 바깥 사건이 생기지 않는다 (군 가혹행위는 따로 있다) */
const FREE = '!legal.inPrison && !military.serving';

function crimeDo(op: 'open' | 'respond' | 'advance', key: string, inst?: string): Fx {
  if (op === 'open') return { do: [{ type: 'crime', op, scene: key }] };
  if (op === 'respond') return { do: [inst ? { type: 'crime', op, act: key as CrimeAct, inst } : { type: 'crime', op, act: key as CrimeAct }] };
  return { do: [{ type: 'crime', op, step: key as CrimeStep }] };
}

function withAct(act: CrimeAct, fx: Fx | undefined, inst?: string): Fx {
  const base = crimeDo('respond', act, inst);
  return fx ? { ...fx, do: [...(fx.do ?? []), ...(base.do ?? [])] } : base;
}

/** 결과 문장 끝에 엔진이 채우는 {결과}를 붙인다 (이미 있으면 그대로) */
function withOutcome(text: string | undefined): string {
  const t = (text ?? '').trim();
  if (t.includes('{결과}')) return t;
  return t ? `${t} {결과}` : '{결과}';
}

function sceneChoice(data: CrimeCatalog, entry: CrimeAct | SceneChoice): ChoiceDef {
  const c: SceneChoice = typeof entry === 'string' ? { act: entry } : entry;
  const base = data.responses[c.act];
  const text = c.text ?? base?.text ?? c.act;
  const result = withOutcome(c.result ?? base?.result);
  const out: ChoiceDef = { text };
  if (c.if) out.if = c.if;
  if (c.check) {
    out.check = { stat: c.check[0], dc: c.check[1] };
    out.onSuccess = { text: result, effects: toEffects(withAct(c.act, c.fx, c.inst)) };
    out.onFail = { text: withOutcome(c.fail ?? c.result ?? base?.result), effects: toEffects(withAct(c.failAct ?? c.act, c.failFx ?? c.fx)) };
    return out;
  }
  out.result = result;
  const fx = toEffects(withAct(c.act, c.fx, c.inst));
  if (fx) out.effects = fx;
  return out;
}

function sceneEvent(data: CrimeCatalog, s: SceneRow): EventDef {
  const rule = CATEGORY[s.cat];
  const ev: EventDef = {
    id: s.id,
    type: 'random',
    motif: s.src,
    title: s.title,
    text: s.text,
    tone: s.tone ?? (rule.weight >= 2 ? 'tragedy' : 'drama'),
    impact: s.impact ?? 8 + rule.weight * 5,
    trigger: { age: s.age },
    weight: { base: s.base },
    limit: { cooldown: s.cooldown ?? 3 },
    effects: toEffects(crimeDo('open', s.id)),
    choices: s.choices.map((c) => sceneChoice(data, c)),
  };
  if (s.zoom) ev.zoom = s.zoom;
  // 성범죄·성희롱의 일반 장면은 본인이 성인일 때만 (엔진도 한 번 더 막는다). 아동·청소년 보호 장면에는
  // 성인 전용 표시를 붙이지 않는다: 나이는 장면의 age·childAge가 정하고, 사건을 지워 버리지 않는다
  if (rule.sexual && !s.minor) ev.adult = true;
  if (s.sex) ev.trigger!.sex = s.sex;
  if (s.childAge) ev.trigger!.childAge = s.childAge;
  const cond = and(FREE, s.if);
  if (cond) ev.trigger!.if = cond;
  if (s.ageCurve) ev.weight!.ageCurve = s.ageCurve;
  if (s.mods?.length) ev.weight!.modifiers = s.mods.map((m) => ({ ...m }));
  return ev;
}

function stepEvent(s: StepRow): EventDef {
  const ev: EventDef = {
    id: stepEventId(s.step),
    type: 'chain',
    title: s.title,
    text: s.text,
    tone: s.tone ?? 'neutral',
    // 단계 카드는 작은 기록이다. 결정할 것이 없으면 일기 한 줄로 남는다
    impact: s.impact ?? 6,
    trigger: { if: s.if ?? 'crime.case.exists' },
    effects: toEffects(crimeDo('advance', s.step)),
  };
  if (s.zoom) ev.zoom = s.zoom;
  if (s.choices?.length) {
    ev.choices = s.choices.map((c) => {
      const out: ChoiceDef = { text: c.text, result: withOutcome(c.result) };
      if (c.if) out.if = c.if;
      const fx = toEffects(withAct(c.act, c.fx, c.inst));
      if (fx) out.effects = fx;
      return out;
    });
  }
  return ev;
}

export function expandCrime(data: CrimeCatalog): EventDef[] {
  const out: EventDef[] = [];
  for (const s of data.scenes) if (!s.external) out.push(sceneEvent(data, s));
  for (const s of data.steps) out.push(stepEvent(s));
  return out;
}
