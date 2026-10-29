// 술·담배·약물: 성인이 직접 고르는 사용과 그 뒤에 남는 이력.
//
// 성인이 되는 것은 선택지를 여는 조건일 뿐이다. 사용 이력은 플레이어가 고른 행동(활동·사건 선택지)에서만
// 생긴다. 권유를 받거나 옆에 있었던 것은 노출(offers)로만 남는다. 만 19세 미만의 사용은 메뉴·선택지뿐
// 아니라 이 파일의 처리 단계에서도 막는다.
//
//   사용 → 의존이 쌓인다 (사람마다 속도가 다르다) → 문턱을 넘으면 고르지 않아도 습관이 이어진다
//   줄이기·끊기 → 갈망과 금단 → 의존이 그 문턱 위에 남아 있는 동안만 해마다 재발 판정 → 재발해도 다시 도움을 청할 수 있다
//     (한두 번 써 보고 끊은 사람은 고르지 않으면 다시 쓰지 않는다. 그 뒤의 재발은 권유·갈망 사건에서 직접 고른다)
//   치료·상담 → 의존과 갈망이 빨리 줄고 재발이 준다. 치료 중에 다시 썼다면 도움을 다시 청해 처음부터 다시 하거나,
//     다시 끊지 않은 채 그해가 끝나면 치료가 흐지부지된다 (쓰는 채로 '치료 중'에 갇히지 않는다)
//
// 불법 약물은 실제 이름 없이 하나로 추상화한다. 구하는 법·용량 같은 내용은 다루지 않는다.
// 수치는 출처를 적은 것 말고는 게임 보정값(추정)이다.

import { leaveJob } from './career';
import { REGION_BY_ID } from './data';
import { addFlag, changeAttr, removeFlag, type EffectContext } from './effects';
import { formatWon, josa } from './format';
import { payOrBorrow } from './justice';
import { changeCloseness, familySupport, partnerOf, spouseOf } from './relations';
import { rngFor, type Rng } from './rng';
import type { Action, ActivityDef } from './schema';
import { inPrison } from './scope';
import type { Change, Character, GameState, PendingCard, SubstanceAct, SubstanceId, SubstanceRecord, UseBand } from './types';
import { SUBSTANCE_IDS } from './types';

/** 만 19세 미만에게는 술·담배를 팔 수 없다 (청소년보호법). 본인의 사용 선택도 이 나이부터 열린다 */
export const ADULT_AGE = 19;

interface Rule {
  /** 문장에 쓰는 이름 */
  label: string;
  /** 한 번 쓸 때 바로 쌓이는 의존 */
  perUse: number;
  /** 그 빈도로 1년을 쓰면 의존이 다가가는 값 (개인차를 곱한다) */
  target: [number, number, number, number];
  /** 의존이 목표로 다가가는 속도 */
  build: number;
  /** 의존 구간: [고르지 않아도 습관이 이어지는 문턱, 자주, 과다] */
  bands: [number, number, number];
  /** 습관 빈도별 1년 비용 (2026년 원) */
  yearCost: [number, number, number, number];
  /** 사용 빈도별 연간 건강 변화 */
  health: [number, number, number, number];
  /** 의존이 습관 문턱을 넘을 때 알림 */
  hooked: string;
  /** 연말 지출 기록 이름 */
  spend: string;
}

const RULES: Record<SubstanceId, Rule> = {
  alcohol: {
    label: '술',
    perUse: 1,
    target: [0, 15, 50, 85],
    build: 0.25,
    bands: [35, 55, 75],
    // 가끔(월 1~2회)·자주(주 1회 이상)·과음. 술자리 한 번 3~5만 원으로 어림
    yearCost: [0, 600_000, 1_800_000, 3_600_000],
    // 과음 −0.8은 기존 '술꾼' 보정을 그대로 쓴다. 자주 −0.3은 추정
    health: [0, 0, -0.3, -0.8],
    hooked: '술 생각이 잦아졌다',
    spend: '술값',
  },
  tobacco: {
    label: '담배',
    perUse: 3,
    target: [0, 40, 70, 90],
    build: 0.35,
    bands: [25, 45, 75],
    // 한 갑 4,500원 (2015년 인상 이후): 가끔 / 매일 반 갑 / 하루 한 갑
    yearCost: [0, 200_000, 820_000, 1_640_000],
    // 매일 흡연 −1.2는 기존 '흡연자' 보정. 가끔 −0.4, 하루 한 갑 이상 −1.6은 추정
    health: [0, -0.4, -1.2, -1.6],
    hooked: '담배가 습관이 됐다',
    spend: '담배값',
  },
  drug: {
    label: '약물',
    perUse: 6,
    target: [0, 40, 70, 90],
    build: 0.4,
    bands: [30, 50, 75],
    yearCost: [0, 2_000_000, 8_000_000, 20_000_000],
    health: [0, -1, -2.5, -4],
    hooked: '약 생각이 머리를 떠나지 않는다',
    spend: '약물에 쓴 돈',
  },
};

/** 전자담배가 덜 해롭다는 근거는 아직 불확실하다. 게임에서는 건강 영향 0.7배, 비용 0.8배 (추정) */
const ECIG_HEALTH = 0.7;
const ECIG_COST = 0.8;
/** 끊은 뒤 해마다 의존이 줄어드는 비율. 치료 중이면 더 빨리 준다 */
const RECOVER_RATE = 0.25;
const TREATMENT_RECOVER = 0.2;
/** 쓰는 중에 의존이 목표보다 높으면 내려가는 속도 */
const EASE_RATE = 0.2;
/** 혼자 마시면 의존이 더 빨리 쌓인다 (추정) */
const ALONE_FACTOR = 1.5;
/** 끊은 지 이만큼 지나고 갈망이 낮으면 '끊어 냈다'로 본다 */
const RECOVERED_YEARS = 2;
const RECOVERED_CRAVING = 10;

/** 사용을 뜻하는 태그와 그 빈도. 다른 사건 데이터가 이 태그를 직접 붙이거나 뗄 수 있다 */
const USE_FLAGS: [string, SubstanceId, UseBand, ('cigarette' | 'ecig')?][] = [
  ['smoker', 'tobacco', 2, 'cigarette'],
  ['vaper', 'tobacco', 2, 'ecig'],
  ['heavy_drinker', 'alcohol', 3],
  ['drug_use', 'drug', 1],
];
/** 끊는 중을 뜻하는 태그 (숙취 다음 날의 금주 다짐처럼 사건이 붙인다) */
const QUIT_FLAGS: [string, SubstanceId][] = [
  ['quitting_smoking', 'tobacco'],
  ['quitting_drinking', 'alcohol'],
  ['drug_recovery', 'drug'],
];
/** 모형이 정하는 태그 전부 */
const OWN_FLAGS: Record<SubstanceId, string[]> = {
  tobacco: ['smoker', 'vaper', 'quitting_smoking', 'ex_smoker'],
  alcohol: ['heavy_drinker', 'quitting_drinking', 'sober'],
  drug: ['drug_use', 'drug_recovery'],
};

const FIRST_USE_TEXT: Record<SubstanceId, string> = {
  alcohol: '처음 제대로 마신 술은 생각보다 쓰고, 생각보다 금방 취했다.',
  tobacco: '첫 모금에 기침이 멈추지 않았다. 머리가 핑 돌았다.',
  drug: '몇 시간 동안 모든 게 가볍게 느껴졌다. 다음 날, 몸과 기분이 바닥까지 꺼졌다.',
};
/** 약물을 쓴 뒤 [보통, 급성 이상 반응] */
const DRUG_AFTER_TEXT: [string, string] = [FIRST_USE_TEXT.drug, '심장이 터질 듯 뛰었다. 그다음은 기억나지 않는다.'];
/** 줄이기 [성공, 실패] */
const CUT_TEXT: Record<SubstanceId, [string, string]> = {
  alcohol: ['일주일에 한 번, 두 병까지로 정했다. 올해는 지켜졌다.', '정한 날보다 두 번 더 마셨다. 줄이는 게 끊는 것보다 어렵다.'],
  tobacco: ['하루 반 갑으로 줄였다. 아침 첫 담배만은 아직 못 끊었다.', '줄이려다 오히려 더 피웠다.'],
  drug: ['횟수를 줄였다. 그래도 끊은 건 아니다.', '줄이겠다는 다짐은 일주일을 못 갔다.'],
};
const TREAT_LABEL: Record<SubstanceId, string> = { alcohol: '알코올 상담', tobacco: '금연클리닉', drug: '중독 치료' };

// ── 기록 ─────────────────────────────────────────────────

function emptyRecord(sensitivity = 1): SubstanceRecord {
  return {
    ever: false,
    uses: 0,
    usesThisYear: 0,
    habit: 0,
    dependence: 0,
    craving: 0,
    sensitivity,
    quitAttempts: 0,
    treatment: 'none',
    treatmentStarts: 0,
    relapses: 0,
    offers: 0,
    refusals: 0,
  };
}

const EMPTY: Readonly<SubstanceRecord> = Object.freeze(emptyRecord());

/** 읽기용: 기록이 없으면(권유·사용이 없었거나 옛 저장) 빈 기록. 상태를 바꾸지 않는다 */
export function readRecord(ch: Character, id: SubstanceId): Readonly<SubstanceRecord> {
  return ch.substances?.[id] ?? EMPTY;
}

/** 의존이 쌓이는 속도의 개인차 0.5~1.8 (체질·성격, 추정). 같은 시드면 같다 */
function sensitivityFor(state: GameState, id: SubstanceId): number {
  const rng = rngFor(state.seed, 'substance', 'sensitivity', id);
  const x = 0.6 + rng.next() * 0.9 + (state.ch.personality.neuroticism - 50) / 250;
  return Math.round(Math.max(0.5, Math.min(1.8, x)) * 100) / 100;
}

/** 기록을 바꿀 때마다 올린다. 조건식 값(substanceScope)의 캐시를 버리는 데 쓴다 */
let revision = 0;

/** 쓰기용: 처음 쓰면 세 물질 기록을 함께 만든다 */
function recordOf(state: GameState, id: SubstanceId): SubstanceRecord {
  const ch = state.ch;
  revision++;
  if (!ch.substances) {
    ch.substances = {
      alcohol: emptyRecord(sensitivityFor(state, 'alcohol')),
      tobacco: emptyRecord(sensitivityFor(state, 'tobacco')),
      drug: emptyRecord(sensitivityFor(state, 'drug')),
    };
  }
  return ch.substances[id];
}

/** 불러온 저장: 기록이 있으면 빠진 값만 기본값으로 채운다. 기록이 없으면 그대로 둔다 (과거 선택을 지어내지 않는다) */
export function normalizeSubstances(state: GameState): void {
  const subs = state.ch.substances as Partial<Record<SubstanceId, Partial<SubstanceRecord>>> | undefined;
  if (!subs) return;
  revision++;
  for (const id of SUBSTANCE_IDS) {
    const r = subs[id];
    if (!r) {
      subs[id] = emptyRecord(sensitivityFor(state, id));
      continue;
    }
    const base = emptyRecord() as unknown as Record<string, unknown>;
    for (const key of Object.keys(base)) {
      if ((r as Record<string, unknown>)[key] === undefined) (r as Record<string, unknown>)[key] = base[key];
    }
  }
}

export function isSubstanceId(x: unknown): x is SubstanceId {
  return typeof x === 'string' && (SUBSTANCE_IDS as readonly string[]).includes(x);
}

// ── 파생 값 ──────────────────────────────────────────────

/** 올해의 사용 빈도: 몸에 밴 습관 + 올해 직접 고른 사용 */
export function effectiveBand(r: Readonly<SubstanceRecord>): UseBand {
  return Math.min(3, Math.floor(r.habit + r.usesThisYear + 1e-9)) as UseBand;
}

/** 올해 썼거나 습관이 남아 있다 */
export function isCurrent(r: Readonly<SubstanceRecord>): boolean {
  return r.habit > 0 || r.usesThisYear > 0;
}

export function isQuitting(r: Readonly<SubstanceRecord>): boolean {
  return r.abstinentSince !== undefined;
}

function quitYears(r: Readonly<SubstanceRecord>, age: number): number {
  return r.abstinentSince === undefined ? 0 : age - r.abstinentSince;
}

/** 끊은 지 2년이 넘고 갈망이 거의 없다 */
export function isRecovered(r: Readonly<SubstanceRecord>, age: number): boolean {
  return isQuitting(r) && quitYears(r, age) >= RECOVERED_YEARS && r.craving < RECOVERED_CRAVING;
}

/** 의존이 정하는 습관 빈도. 문턱 아래면 0: 고르지 않으면 쓰지 않는다 */
function dependenceBand(r: Readonly<SubstanceRecord>, id: SubstanceId): UseBand {
  const [hook, often, heavy] = RULES[id].bands;
  if (r.dependence >= heavy) return 3;
  if (r.dependence >= often) return 2;
  if (r.dependence >= hook) return 1;
  return 0;
}

function clamp100(x: number): number {
  return Math.max(0, Math.min(100, Math.round(x * 10) / 10));
}

// ── 태그 ─────────────────────────────────────────────────

/** 기록에서 정해지는 태그 */
function flagsFor(r: Readonly<SubstanceRecord>, id: SubstanceId, age: number): string[] {
  if (!r.ever) return [];
  if (isQuitting(r)) {
    if (id === 'tobacco') return [isRecovered(r, age) ? 'ex_smoker' : 'quitting_smoking'];
    if (id === 'alcohol') return [isRecovered(r, age) ? 'sober' : 'quitting_drinking'];
    return ['drug_recovery'];
  }
  return useFlagsFor(r, id, true);
}

/**
 * 사용 태그. 흡연자('매일 피운다')·술꾼('과음이 습관이 됐다') 태그는 오랜 흡연·음주를 전제한 사건
 * (폐 CT 검진, 알코올 사용 장애의 떨리는 손, 오래 마신 사람의 비타민 결핍…)과 질병 가중치가 읽는다.
 * 그래서 올해 고른 사용만으로는 붙지 않고, 몸에 밴 습관(의존이 문턱을 넘어 여러 해 이어진 사용)이 있고
 * 올해 빈도가 태그의 빈도에 이를 때만 붙는다. 예전에는 술자리 활동 세 번(의존 2 남짓)에 바로 술꾼이 됐다.
 * 올해의 건강 변화와 '빈 병' 같은 올해 장면은 태그가 아니라 기록의 올해 빈도(band)를 읽는다.
 * needHabit=false는 예전 규칙(올해 빈도만)이다: 옛 저장에 그 규칙으로 붙은 태그를 알아보는 데만 쓴다
 */
function useFlagsFor(r: Readonly<SubstanceRecord>, id: SubstanceId, needHabit: boolean): string[] {
  if (id === 'drug') return isCurrent(r) ? ['drug_use'] : [];
  if (needHabit && r.habit === 0) return [];
  const band = effectiveBand(r);
  if (id === 'tobacco') return band >= 2 ? [r.product === 'ecig' ? 'vaper' : 'smoker'] : [];
  return band >= 3 ? ['heavy_drinker'] : [];
}

/**
 * 예전 규칙(올해 고른 사용만으로 붙던 태그)으로 설명되는 사용 태그. 습관 이력으로 옮기지 않고 기록에 맞춰 뗀다.
 * 옮기면 한 해 몇 번 고른 사용이 의존 80의 과음 습관으로 부풀었다. 예전에도 이 경우는 옮기지 않았다
 */
function legacyFlag(r: Readonly<SubstanceRecord>, id: SubstanceId, flag: string): boolean {
  return r.ever && !isQuitting(r) && useFlagsFor(r, id, false).includes(flag);
}

/** 끊는 중·끊어 냄 태그 (사용 태그를 뺀 모형의 태그) */
const QUIT_STATE_FLAGS: Record<SubstanceId, string[]> = {
  tobacco: OWN_FLAGS.tobacco.filter((f) => !USE_FLAGS.some(([u]) => u === f)),
  alcohol: OWN_FLAGS.alcohol.filter((f) => !USE_FLAGS.some(([u]) => u === f)),
  drug: OWN_FLAGS.drug.filter((f) => !USE_FLAGS.some(([u]) => u === f)),
};

/**
 * 써 본 적 없는 물질의 끊는 중·끊어 냄 태그를 뗀다. 옛 저장(R-008 이전)에는 술을 마신 적 없는 사람에게
 * '금주 중'이 붙어 있었다. 기록은 끊는 중이 아니라고 읽으므로 태그만 어긋나 있었다. 조용히 뗀다 (알림 없음)
 */
function dropUnusedQuitFlags(state: GameState): void {
  for (const id of SUBSTANCE_IDS) {
    if (readRecord(state.ch, id).ever) continue;
    for (const f of QUIT_STATE_FLAGS[id]) if (state.ch.flags[f]) removeFlag(state, f, []);
  }
}

/**
 * 기록과 태그를 맞춘다. 흡연자·술꾼 태그는 다른 사건과 건강 계산이 읽는다.
 * 써 본 적 없는 물질의 사용 태그(아직 옮기지 않은 미성년자의 옛 태그)는 건드리지 않는다. 끊는 중 태그는 뗀다.
 * age는 끊은 햇수를 셀 나이다. 연말에는 다음 해 나이로 센다 (substanceYearEnd)
 */
function syncFlags(state: GameState, changes: Change[], age = state.ch.age): void {
  const ch = state.ch;
  dropUnusedQuitFlags(state);
  for (const id of SUBSTANCE_IDS) {
    const r = readRecord(ch, id);
    if (!r.ever) continue;
    const want = flagsFor(r, id, age);
    for (const f of OWN_FLAGS[id]) {
      if (want.includes(f)) addFlag(state, f, changes);
      else removeFlag(state, f, changes);
    }
  }
}

/** 사용 태그와 끊는 중 태그가 붙어 있는지 비트로 (조건식 캐시가 태그 변화를 알아채는 데 쓴다) */
const WATCHED_FLAGS: string[] = [...USE_FLAGS.map(([flag]) => flag), ...QUIT_FLAGS.map(([flag]) => flag)];

function tagBits(ch: Character): number {
  let bits = 0;
  for (let i = 0; i < WATCHED_FLAGS.length; i++) if (ch.flags[WATCHED_FLAGS[i]]) bits |= 1 << i;
  return bits;
}

/**
 * 다른 사건 데이터가 흡연자·술꾼·금주 중 같은 태그를 직접 붙이거나 뗀 경우(옛 사건·옛 저장)를 기록에 옮긴다.
 * 붙은 사용 태그는 성인에게만 사용으로 옮긴다. 미성년자에게 붙은 옛 태그는 성인이 될 때까지 그대로 둔다.
 * read는 지금 기록, write는 바꿀 기록을 준다. 기록만 바꾸고 끊기를 시작한 물질을 돌려준다 (금단은 부르는 쪽이 준다)
 */
function applyTags(ch: Character, read: (id: SubstanceId) => Readonly<SubstanceRecord>, write: (id: SubstanceId) => SubstanceRecord): SubstanceId[] {
  const quit: SubstanceId[] = [];
  for (const [flag, id, band, product] of USE_FLAGS) {
    const r = read(id);
    const want = flagsFor(r, id, ch.age).includes(flag);
    if (ch.flags[flag] && !want && ch.age >= ADULT_AGE && !legacyFlag(r, id, flag)) importRecord(write(id), id, band, ch.age, product);
    else if (!ch.flags[flag] && want && quitRecord(write(id), ch.age)) quit.push(id);
  }
  for (const [flag, id] of QUIT_FLAGS) {
    const r = read(id);
    if (ch.flags[flag] && r.ever && !isQuitting(r) && quitRecord(write(id), ch.age)) quit.push(id);
  }
  return quit;
}

/** 태그 변화를 기록에 옮기고 태그를 기록에 맞춘다. 물질 행동과 연말 결산이 먼저 부른다 */
export function reconcileSubstanceFlags(state: GameState): void {
  const ch = state.ch;
  if (!ch.substances && !USE_FLAGS.some(([flag]) => ch.flags[flag])) {
    dropUnusedQuitFlags(state);
    return;
  }
  const quit = applyTags(ch, (id) => readRecord(ch, id), (id) => recordOf(state, id));
  for (const id of quit) withdrawal(state, readRecord(ch, id), []);
  syncFlags(state, []);
}

/**
 * 읽기용 기록: 다른 사건이 태그를 붙이거나 뗐는데 아직 기록에 옮기지 않았으면(다음 물질 행동이나 연말에 옮긴다)
 * 옮긴 뒤의 모습으로 읽는다. 상태는 바꾸지 않는다. 예: 심장 재활 사건에서 담배를 끊기로 하면 그 자리부터
 * 흡연 관련 사건·메뉴·건강 계산이 끊은 사람으로 본다 (예전에는 그해 연말까지 흡연자로 읽혔다)
 */
function viewRecords(ch: Character): Record<SubstanceId, Readonly<SubstanceRecord>> {
  const views: Partial<Record<SubstanceId, SubstanceRecord>> = {};
  const read = (id: SubstanceId) => views[id] ?? readRecord(ch, id);
  applyTags(ch, read, (id) => (views[id] ??= { ...readRecord(ch, id) }));
  return { alcohol: read('alcohol'), tobacco: read('tobacco'), drug: read('drug') };
}

/** 사건이 붙인 사용 태그를 기록으로 옮긴다 (기록만). 처음 쓴 나이처럼 모르는 값은 비워 둔다 */
function importRecord(r: SubstanceRecord, id: SubstanceId, band: UseBand, age: number, product?: 'cigarette' | 'ecig'): void {
  r.ever = true;
  r.uses += 1;
  r.lastAge = age;
  delete r.abstinentSince;
  r.habit = Math.max(r.habit, band) as UseBand;
  r.dependence = Math.max(r.dependence, RULES[id].bands[Math.max(1, band) - 1] + 5);
  if (product) r.product = product;
}

// ── 행동 ─────────────────────────────────────────────────

export interface SubstanceOutcome {
  /** 활동 결과 문장 (없으면 활동의 기본 문장) */
  text?: string;
  /** 응급실·검거 카드를 대기열에 넣었다 */
  queued?: boolean;
}

interface UseOptions {
  /** 활동 한 번 = 1, 사건 속 술자리 한 번 = 0.5 */
  amount?: number;
  product?: 'cigarette' | 'ecig';
  context?: 'social' | 'alone';
}

/** 직접 사용. 미성년자는 처리 단계에서 막고 권유받은 노출로만 남긴다 */
function useSubstance(state: GameState, id: SubstanceId, rng: Rng, changes: Change[], opts: UseOptions): SubstanceOutcome {
  const ch = state.ch;
  if (ch.age < ADULT_AGE) {
    recordOf(state, id).offers += 1;
    return {};
  }
  const r = recordOf(state, id);
  const rule = RULES[id];
  const amount = opts.amount ?? 1;
  const first = !r.ever;
  const wasQuitting = isQuitting(r);
  const hookedBefore = dependenceBand(r, id) > 0;
  r.ever = true;
  if (first) r.firstAge = ch.age;
  r.lastAge = ch.age;
  r.uses += 1;
  r.usesThisYear = Math.round((r.usesThisYear + amount) * 100) / 100;
  if (opts.product) r.product = opts.product;
  else if (id === 'tobacco' && !r.product) r.product = 'cigarette';
  const factor = opts.context === 'alone' ? ALONE_FACTOR : 1;
  r.dependence = clamp100(r.dependence + rule.perUse * amount * r.sensitivity * factor);
  let text = first ? FIRST_USE_TEXT[id] : undefined;
  if (wasQuitting) {
    // 끊었다가 다시: 의존이 남아 있으면 재발이다. 다시 도움을 청하는 길은 열려 있다
    delete r.abstinentSince;
    if (r.dependence >= 20) r.relapses += 1;
    r.habit = dependenceBand(r, id);
    r.craving = 0;
    text = `${josa(rule.label, '을/를')} 끊고 세던 날짜가 오늘로 끝났다.`;
  }
  if (!hookedBefore && dependenceBand(r, id) > 0) changes.push({ text: rule.hooked, sign: 'bad' });
  let queued = false;
  if (id === 'drug') {
    const after = drugAftermath(state, r, rng);
    queued = after.queued;
    text = after.text;
  }
  syncFlags(state, changes);
  return { text, queued };
}

/** 불법 약물을 쓴 뒤: 급성 이상 반응(응급실)과 적발. 한 번 썼다고 반드시 일어나지는 않는다 (확률은 추정) */
function drugAftermath(state: GameState, r: SubstanceRecord, rng: Rng): { queued: boolean; text: string } {
  const ch = state.ch;
  let queued = false;
  // 의존이 깊거나, 같은 해 술과 겹치거나, 건강이 나쁘면 위험이 커진다
  let p = 0.04 * (1 + r.dependence / 100);
  if (isCurrent(readRecord(ch, 'alcohol'))) p *= 1.5;
  if (ch.stats.health < 50) p *= 1.5;
  const emergency = rng.chance(p);
  if (emergency) {
    state.queue.push({ eventId: 'sub_drug_emergency', ctx: {} });
    queued = true;
  }
  if (rng.chance(drugDetection(r))) {
    state.queue.push(arrestCard());
    queued = true;
  }
  return { queued, text: DRUG_AFTER_TEXT[emergency ? 1 : 0] };
}

/** 적발 확률. 치료를 받는 중이면 수사보다 치료로 이어지는 일이 많다 (게임 가정) */
function drugDetection(r: Readonly<SubstanceRecord>): number {
  const p = 0.05 + 0.02 * r.habit;
  return r.treatment === 'active' ? p * 0.3 : p;
}

/** 마약류 관리에 관한 법률 위반: 기존 사법 흐름(prosecute)으로 판결한다 */
function arrestCard(): PendingCard {
  return { eventId: 'sub_drug_arrest', ctx: { crime: 'drug_use', 혐의: '마약류 관리법 위반' } };
}

function refuse(state: GameState, id: SubstanceId): void {
  const r = recordOf(state, id);
  r.refusals += 1;
  r.lastRefusalAge = state.ch.age;
  if (r.offers < r.refusals) r.offers = r.refusals;
}

/**
 * 줄이기: 의존이 깊을수록 어렵고 성실할수록 지킨다. 지키면 몸에 밴 습관이 한 단계 줄고(있다면)
 * 다음 해 습관이 그보다 늘지 않는다. 올해 쓴 것이 모두 직접 고른 사용이라 습관이 0이어도 약속은 남는다
 * (빈 병 앞에서 '줄이겠다'고 한 약속이 아무 상태도 남기지 않던 문제). 지키지 못하면 아무것도 바뀌지 않는다
 */
function cutDown(state: GameState, id: SubstanceId, rng: Rng, changes: Change[]): string | undefined {
  const ch = state.ch;
  const r = recordOf(state, id);
  if (isQuitting(r) || effectiveBand(r) === 0) return undefined;
  const p = 0.75 - r.dependence / 150 + (ch.personality.conscientiousness - 50) / 200;
  if (!rng.chance(Math.max(0.15, Math.min(0.9, p)))) return CUT_TEXT[id][1];
  r.cutDownAge = ch.age;
  if (r.habit > 0) r.habit = (r.habit - 1) as UseBand;
  r.craving = clamp100(r.craving + r.dependence * 0.2);
  syncFlags(state, changes);
  return CUT_TEXT[id][0];
}

/** 끊기 시작. 의존이 깊으면 금단이 온다 */
function startQuit(state: GameState, id: SubstanceId, changes: Change[]): void {
  const r = recordOf(state, id);
  if (quitRecord(r, state.ch.age)) withdrawal(state, r, changes);
}

/** 끊기 시작 (기록만). 써 본 적 없거나 이미 끊는 중이면 아무것도 바꾸지 않고 false */
function quitRecord(r: SubstanceRecord, age: number): boolean {
  if (!r.ever || isQuitting(r)) return false;
  r.abstinentSince = age;
  r.quitAttempts += 1;
  r.habit = 0;
  delete r.cutDownAge;
  r.craving = clamp100(Math.max(r.craving, r.dependence * 0.9));
  return true;
}

/** 금단: 의존이 깊을수록 스트레스가 오르고 기분이 가라앉는다 */
function withdrawal(state: GameState, r: Readonly<SubstanceRecord>, changes: Change[]): void {
  if (r.dependence < 25) return;
  changes.push({ text: '금단 증상', sign: 'bad' });
  changeAttr(state, 'stress', Math.round(r.dependence * 0.12), changes);
  changeAttr(state, 'happiness', -Math.round(r.dependence * 0.04), changes);
}

/**
 * 치료·상담을 시작한다. 쓰고 있었다면 끊기도 함께 시작한다.
 * 치료 중에 다시 썼다가 도움을 다시 청하면(재발 카드·적발·응급실·메뉴) 끊기와 치료 기간을 처음부터 다시 시작한다.
 * 예전에는 이미 치료 중이면 아무 일도 없어서 '다시 도움을 요청한다'를 골라도 계속 쓰는 상태로 남았다
 */
function treat(state: GameState, id: SubstanceId, changes: Change[]): void {
  const r = recordOf(state, id);
  if (!r.ever) return;
  const again = r.treatment === 'active';
  if (again && isQuitting(r)) return;
  r.treatment = 'active';
  r.treatmentSince = state.ch.age;
  r.treatmentStarts += 1;
  startQuit(state, id, changes);
  r.craving = clamp100(r.craving * 0.6);
  changes.push({ text: `${TREAT_LABEL[id]} ${again ? '다시 시작' : '시작'}`, sign: 'good' });
}

/** 치료 과정을 마쳤다. 그사이 다시 쓰고 있었다면 마치면서 끊기를 다시 시작한다 (쓰는 채로 '마침'이 남지 않는다) */
function completeTreatment(state: GameState, id: SubstanceId, changes: Change[]): void {
  const r = recordOf(state, id);
  if (r.treatment !== 'active') return;
  startQuit(state, id, changes);
  r.treatment = 'completed';
  r.dependence = clamp100(r.dependence * 0.6);
  r.craving = clamp100(r.craving * 0.5);
  changes.push({ text: `${TREAT_LABEL[id]} 과정을 마쳤다`, sign: 'good' });
}

function dropTreatment(state: GameState, id: SubstanceId, changes: Change[]): void {
  const r = recordOf(state, id);
  if (r.treatment !== 'active') return;
  r.treatment = 'none';
  changes.push({ text: `${josa(TREAT_LABEL[id], '을/를')} 그만뒀다`, sign: 'bad' });
}

/** 한 번 참아 냈다: 끊는 중이면 갈망이, 쓰는 중이면 의존이 조금 준다 */
function resist(state: GameState, id: SubstanceId): void {
  const r = recordOf(state, id);
  if (isQuitting(r)) r.craving = clamp100(r.craving - 12);
  else r.dependence = clamp100(r.dependence - 1.5);
}

function runSubstance(
  state: GameState,
  id: SubstanceId,
  act: SubstanceAct,
  rng: Rng,
  changes: Change[],
  opts: UseOptions,
): SubstanceOutcome {
  switch (act) {
    case 'offered':
      recordOf(state, id).offers += 1;
      return {};
    case 'use':
      return useSubstance(state, id, rng, changes, opts);
    case 'refuse':
      refuse(state, id);
      return {};
    case 'cutDown':
      return { text: cutDown(state, id, rng, changes) };
    case 'quit':
      startQuit(state, id, changes);
      break;
    case 'treat':
      treat(state, id, changes);
      break;
    case 'completeTreatment':
      completeTreatment(state, id, changes);
      break;
    case 'dropTreatment':
      dropTreatment(state, id, changes);
      break;
    case 'resist':
      resist(state, id);
      break;
  }
  syncFlags(state, changes);
  return {};
}

/** 사건 선택지의 행동 { type: 'substance' }. 사용 결과 문장은 ctx.결과로 넘긴다 */
export function applySubstanceAction(state: GameState, a: Extract<Action, { type: 'substance' }>, ec: EffectContext): void {
  reconcileSubstanceFlags(state);
  for (const id of actionTargets(state, a, ec.ctx)) {
    const out = runSubstance(state, id, a.act, ec.rng, ec.changes, { amount: a.amount, product: a.product });
    if (a.act === 'use' && out.text) ec.ctx.결과 = out.text;
  }
}

/** 물질을 정하지 않은 치료 마침·중단·버티기는 치료 중이거나 끊는 중인 물질 전부에 적용한다 */
function actionTargets(state: GameState, a: Extract<Action, { type: 'substance' }>, ctx: Record<string, string>): SubstanceId[] {
  if (a.substance === 'ctx') return isSubstanceId(ctx.substance) ? [ctx.substance] : [];
  if (a.substance) return [a.substance];
  return SUBSTANCE_IDS.filter((id) => {
    const r = readRecord(state.ch, id);
    return r.treatment === 'active' || (a.act === 'resist' && isQuitting(r));
  });
}

/** 활동 special 'substance'. 성인·조건 검사는 메뉴(activityViews)가 먼저 했고 사용은 여기서도 다시 막는다 */
export function substanceActivity(state: GameState, def: ActivityDef, rng: Rng, changes: Change[]): SubstanceOutcome {
  const s = def.substance;
  if (!s) return {};
  reconcileSubstanceFlags(state);
  return runSubstance(state, s.id, s.act, rng, changes, { product: s.product, context: s.context });
}

// ── 연말 ─────────────────────────────────────────────────

/**
 * 연말 결산 (game.ts settleYear). 습관의 비용, 생활·관계의 결과, 의존·갈망의 변화, 치료, 재발,
 * 다음 해 습관을 정한다. 권유·사용 기록이 없는 사람에게는 아무것도 하지 않는다 (난수도 쓰지 않는다).
 */
export function substanceYearEnd(state: GameState): PendingCard[] {
  const ch = state.ch;
  reconcileSubstanceFlags(state);
  const subs = ch.substances;
  if (!subs) return [];
  revision++;
  const rng = rngFor(state.seed, 'substance', ch.age);
  const pending: PendingCard[] = [];
  const quiet: Change[] = [];
  const prison = inPrison(state);
  const spent: string[] = [];
  let total = 0;
  for (const id of SUBSTANCE_IDS) {
    const r = subs[id];
    if (!r.ever) {
      r.usesThisYear = 0;
      continue;
    }
    // 교정시설에서는 술·담배·약물을 쓸 수 없다: 끊긴다 (스스로 끊은 시도로 세지 않는다)
    if (prison && !isQuitting(r) && isCurrent(r)) {
      r.abstinentSince = ch.age;
      r.habit = 0;
      r.craving = clamp100(Math.max(r.craving, r.dependence * 0.9));
    }
    const band = effectiveBand(r);
    const cost = habitCost(state, r, id);
    if (cost > 0) {
      total += cost;
      spent.push(`${RULES[id].spend} ${formatWon(cost)}`);
    }
    if (band > 0) lifeEffects(state, id, band, rng);
    if (id === 'drug' && r.habit > 0 && rng.chance(drugDetection(r) * 0.6)) pending.push(arrestCard());
    updateDependence(state, r, id, band);
    progressTreatment(state, r, id);
    lapseTreatment(state, r, id);
    const before = r.habit;
    r.habit = isQuitting(r) ? 0 : r.cutDownAge === ch.age ? (Math.min(dependenceBand(r, id), r.habit) as UseBand) : dependenceBand(r, id);
    if (isQuitting(r) && !prison && relapseRisk(r, id) && rng.chance(relapseChance(state, r))) {
      relapse(state, r, id);
      pending.push({ eventId: 'sub_relapse', ctx: { substance: id, 물질: RULES[id].label } });
    } else if (before === 0 && r.habit > 0) {
      state.log.push({ year: state.year, age: ch.age, kind: 'event', title: RULES[id].label, text: `${RULES[id].hooked}. 이제는 고르지 않아도 손이 간다.`, tone: 'drama', impact: 6 });
    }
    delete r.cutDownAge;
    r.usesThisYear = 0;
  }
  if (total > 0) {
    payOrBorrow(state, total);
    state.log.push({ year: state.year, age: ch.age, kind: 'year', text: `${spent.join(', ')}.` });
  }
  // 연말 태그는 다음 해의 상태다: 습관은 다음 해 값이고 끊은 햇수도 다음 해 나이로 센다.
  // 지금 나이로 세면 '금연 유지'·'금주 유지'가 한 해 늦게 붙었다
  syncFlags(state, quiet, ch.age + 1);
  return pending;
}

/** 습관으로 이어진 사용의 1년 비용 (직접 고른 활동·사건의 비용은 그때 냈다) */
function habitCost(state: GameState, r: Readonly<SubstanceRecord>, id: SubstanceId): number {
  if (r.habit === 0) return 0;
  const ecig = id === 'tobacco' && r.product === 'ecig' ? ECIG_COST : 1;
  return Math.round((RULES[id].yearCost[r.habit] * ecig * state.world.economy.priceIndex) / 10_000) * 10_000;
}

/** 생활의 결과 (추정 보정): 과음·약물은 평판·가족 관계·일에, 담배 냄새는 함께 사는 사람과의 관계에 남는다 */
function lifeEffects(state: GameState, id: SubstanceId, band: UseBand, rng: Rng): void {
  const ch = state.ch;
  const partner = spouseOf(ch) ? 'spouse' : partnerOf(ch) ? 'partner' : undefined;
  if (id === 'alcohol' && band >= 3) {
    changeAttr(state, 'reputation', -1, []);
    changeCloseness(ch, 'parents', -1);
    if (partner) changeCloseness(ch, partner, -3);
  }
  if (id === 'tobacco' && partner) changeCloseness(ch, partner, -1);
  if (id === 'drug') {
    changeAttr(state, 'reputation', -2 * band, []);
    changeCloseness(ch, 'parents', -3);
    if (partner) changeCloseness(ch, partner, -4);
    if (ch.career.jobId && !ch.career.business && rng.chance(0.06 * band)) {
      const title = ch.career.title;
      leaveJob(state, 0);
      state.log.push({ year: state.year, age: ch.age, kind: 'event', title: '퇴사', text: `약물 문제로 ${josa(title ?? '일', '을/를')} 그만뒀다.`, tone: 'tragedy', impact: 14 });
    }
  }
}

/** 의존과 갈망의 1년 변화 */
function updateDependence(state: GameState, r: SubstanceRecord, id: SubstanceId, band: UseBand): void {
  const treated = r.treatment === 'active';
  if (isQuitting(r)) {
    r.dependence = clamp100(r.dependence * (1 - RECOVER_RATE - (treated ? TREATMENT_RECOVER : 0)) - 2);
    // 갈망은 해마다 줄지만 스트레스가 크면 다시 커진다
    const stress = Math.max(0, state.ch.state.stress - 60) * 0.2;
    r.craving = clamp100(r.craving * (treated ? 0.45 : 0.6) - 3 + stress);
    if (r.craving >= 20) changeAttr(state, 'stress', r.craving * 0.06, []);
    return;
  }
  const rule = RULES[id];
  const target = Math.min(100, rule.target[band] * r.sensitivity);
  if (target > r.dependence) r.dependence = clamp100(r.dependence + (target - r.dependence) * rule.build);
  else r.dependence = clamp100(r.dependence - (r.dependence - target) * EASE_RATE);
  r.craving = clamp100(r.craving * 0.5);
}

/** 치료는 1년을 다니고 그동안 끊고 있었으면 마친 것으로 본다 (중간에 사건에서 마치거나 그만둘 수 있다) */
function progressTreatment(state: GameState, r: SubstanceRecord, id: SubstanceId): void {
  if (r.treatment !== 'active' || r.treatmentSince === undefined) return;
  if (state.ch.age - r.treatmentSince < 1 || !isQuitting(r)) return;
  completeTreatment(state, id, []);
  state.log.push({ year: state.year, age: state.ch.age, kind: 'event', title: TREAT_LABEL[id], text: '1년 과정을 마쳤다. 끝이 아니라 시작이라는 말을 들었다.', tone: 'recovery', impact: 8 });
}

/**
 * 치료 중에 다시 썼고 그해가 끝날 때까지 다시 끊지도, 도움을 다시 청하지도 않았다: 치료가 흐지부지된다.
 * 다음 해에는 메뉴에서 다시 등록할 수 있다. 연말 재발(아래)은 끊고 있던 사람만 겪으므로 여기에 걸리지 않고,
 * 다음 해 재발 카드에서 다시 도움 요청·혼자 끊기·그냥 두기를 고른다
 */
function lapseTreatment(state: GameState, r: SubstanceRecord, id: SubstanceId): void {
  if (r.treatment !== 'active' || isQuitting(r)) return;
  r.treatment = 'none';
  state.log.push({ year: state.year, age: state.ch.age, kind: 'event', title: TREAT_LABEL[id], text: '다시 손을 댄 뒤로 발길을 끊었다. 연락처는 아직 휴대폰에 있다.', tone: 'drama', impact: 4 });
}

/**
 * 고르지 않았는데 다시 쓰게 되는 재발은 의존이 습관 문턱(고르지 않아도 습관이 이어지는 값) 위에 남아 있을 때만 판정한다.
 * 예전에는 한 번 마셔 보고 금주를 고른 사람도 의존 1 남짓으로 해마다 재발을 굴려, 200명 중 155명이 고르지 않은
 * 음주와 재발 카드를 겪었다. 문턱 아래의 재발은 권유·갈망 사건에서 직접 고른다
 */
function relapseRisk(r: Readonly<SubstanceRecord>, id: SubstanceId): boolean {
  return r.dependence >= RULES[id].bands[0];
}

/**
 * 끊은 사람의 다음 1년 재발 확률. 갈망·스트레스가 키우고, 치료(가까운 곳일수록)·주변 지원·
 * 앞선 시도의 경험·성실성이 줄인다 (모두 추정 보정)
 */
function relapseChance(state: GameState, r: Readonly<SubstanceRecord>): number {
  const ch = state.ch;
  let p = 0.005 + (r.craving / 100) * 0.6;
  if (ch.state.stress > 60) p += (ch.state.stress - 60) / 200;
  if (r.treatment === 'active') p -= REGION_BY_ID.get(ch.region)?.metro ? 0.2 : 0.15;
  else if (r.treatment === 'completed') p -= 0.08;
  p -= Math.min(0.12, Math.max(0, r.quitAttempts - 1) * 0.03);
  p -= (ch.personality.conscientiousness - 50) / 300;
  p -= (familySupport(ch) - 50) / 400;
  const partner = spouseOf(ch) ?? partnerOf(ch);
  if (partner && partner.closeness >= 70) p -= 0.03;
  return Math.max(0.002, Math.min(0.8, p));
}

function relapse(state: GameState, r: SubstanceRecord, id: SubstanceId): void {
  delete r.abstinentSince;
  r.relapses += 1;
  r.uses += 1;
  r.lastAge = state.ch.age;
  r.dependence = clamp100(r.dependence + 10 * r.sensitivity);
  r.craving = 0;
  r.habit = Math.max(1, dependenceBand(r, id)) as UseBand;
}

// ── 다른 모듈이 읽는 값 ──────────────────────────────────

/**
 * 연말 건강 변화 (health.ts). 다른 사건이 바꾼 태그는 옮긴 뒤의 기록으로 읽는다: 올해 사건에서 끊기로 했으면
 * 습관 몫은 빠지고 그해 직접 고른 사용만 남는다. 기록에 옮기지 않는 미성년자의 옛 태그는 태그의 빈도로 본다
 */
export function substanceHealthDelta(ch: Character): number {
  let d = 0;
  const bands = {} as Record<SubstanceId, UseBand>;
  const view = viewRecords(ch);
  for (const id of SUBSTANCE_IDS) {
    const r = view[id];
    let band = effectiveBand(r);
    // 성인의 태그는 위 읽기용 기록에 이미 들어 있다 (태그만 남은 채 끊는 중이면 태그로 다시 올리지 않는다)
    if (ch.age < ADULT_AGE) for (const [flag, fid, b] of USE_FLAGS) if (fid === id && ch.flags[flag]) band = Math.max(band, b) as UseBand;
    bands[id] = band;
    const ecig = id === 'tobacco' && r.product === 'ecig';
    d += RULES[id].health[band] * (ecig ? ECIG_HEALTH : 1);
  }
  // 술과 담배를 함께 자주 하면 위험이 겹친다 (구강·식도암 등, 추정 보정)
  if (bands.alcohol >= 2 && bands.tobacco >= 2) d -= 0.3;
  return d;
}

function recordScope(r: Readonly<SubstanceRecord>, age: number): Record<string, unknown> {
  return {
    ever: r.ever,
    current: isCurrent(r),
    // 올해 제대로 썼다 (술자리 한 번 이상. 첫 잔만 받은 정도는 아니다): 숙취 같은 후속 사건의 조건
    usedThisYear: r.habit > 0 || r.usesThisYear >= 0.5,
    band: effectiveBand(r),
    habit: r.habit,
    uses: r.uses,
    usesThisYear: r.usesThisYear,
    // 처음 한두 번째 사용 (옛 저장에서 옮겨 와 첫 나이를 모르면 아니다)
    novice: r.ever && r.firstAge !== undefined && r.uses <= 2,
    dependence: Math.round(r.dependence),
    craving: Math.round(r.craving),
    quitting: isQuitting(r),
    quitYears: quitYears(r, age),
    recovered: isRecovered(r, age),
    quitAttempts: r.quitAttempts,
    relapses: r.relapses,
    treatment: r.treatment,
    inTreatment: r.treatment === 'active',
    offers: r.offers,
    refusals: r.refusals,
    ecig: r.product === 'ecig',
  };
}

/** 기록이 없는 사람(대부분의 미성년자와 권유를 받은 적 없는 사람)의 값은 하나를 같이 쓴다 */
function blankScope(adult: boolean): Readonly<Record<string, unknown>> {
  const empty = Object.freeze(recordScope(EMPTY, 0));
  return Object.freeze({ adult, alcohol: empty, tobacco: empty, drug: empty, inTreatment: false, dependence: 0 });
}
const BLANK_SCOPE = { minor: blankScope(false), adult: blankScope(true) };

interface ScopeCacheEntry {
  revision: number;
  age: number;
  /** 사용·끊는 중 태그 (다른 사건이 태그만 바꿔도 다시 계산한다) */
  bits: number;
  subs: Character['substances'];
  value: Readonly<Record<string, unknown>>;
}

/** 조건식 값은 해마다 수십 번 읽히므로 기록·나이·태그가 그대로면 지난번 값을 쓴다 (상태에는 남지 않는다) */
const scopeCache = new WeakMap<Character, ScopeCacheEntry>();

/** 조건식 값 (scope.ts의 substance.*). 기록이 없어도 모든 값이 있다. 아직 옮기지 않은 태그 변화도 반영한다 */
export function substanceScope(state: GameState): Readonly<Record<string, unknown>> {
  const ch = state.ch;
  const bits = tagBits(ch);
  if (!ch.substances && bits === 0) return ch.age >= ADULT_AGE ? BLANK_SCOPE.adult : BLANK_SCOPE.minor;
  const hit = scopeCache.get(ch);
  if (hit && hit.revision === revision && hit.age === ch.age && hit.bits === bits && hit.subs === ch.substances) return hit.value;
  const v = viewRecords(ch);
  const value = Object.freeze({
    adult: ch.age >= ADULT_AGE,
    alcohol: recordScope(v.alcohol, ch.age),
    tobacco: recordScope(v.tobacco, ch.age),
    drug: recordScope(v.drug, ch.age),
    inTreatment: SUBSTANCE_IDS.some((id) => v[id].treatment === 'active'),
    dependence: Math.round(Math.max(v.alcohol.dependence, v.tobacco.dependence, v.drug.dependence)),
  });
  scopeCache.set(ch, { revision, age: ch.age, bits, subs: ch.substances, value });
  return value;
}
