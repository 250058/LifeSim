// 이벤트 엔진: 조건 평가, 확률 계산, 추첨, 사건 일으키기(카드 또는 일기), 선택 처리.
//
//   P = p₀ × A(나이) × Πmᵢ × W × D × M
//
// p₀ 실제 통계의 기본 확률, A 나이 곡선, m 능력치·태그·지역·형편 보정(세계 보정 W 포함),
// D 디렉터 보정, M 모드 배수. 인수 중 하나라도 0이면 불가능한 조건이라 P = 0이다.
// 바닥값(1e-6)은 양수인 희귀 확률에만 쓴다 (R-004).
//
// 발생과 표시를 나눈다 (R-001):
//  - 확률대로 일어난 사건은 개수 상한 때문에 지우지 않는다. 모두 대기열에 들어가 효과가 적용되고 기록된다.
//  - 결정이 필요한 사건(보이는 선택지가 있다)은 카드로 올리고 플레이어를 기다린다. 엔진이 대신 고르지 않는다.
//  - 결정할 것이 없는 작은 사건은 카드 없이 효과를 적용하고 일기 한 줄로 남긴다 (recordsAsDiary).
//  - 디렉터는 확률 배수 D와 조용한 해를 일상 사건으로 채우는 최소 개수로만 완급을 조절한다.

import { evaluate, type Scope } from './conditions';
import { EVENTS, getEvent } from './data';
import { addImpact, BIG_IMPACT, directorFactor, fillerMinimum, updatePace } from './director';
import { applyEffects } from './effects';
import { STAGES, stageOf } from './format';
import { rngFor, type Rng } from './rng';
import { buildScope } from './scope';
import type { CheckDef, EventDef, NextRef, PoolId } from './schema';
import { generateCtx, render, targetProblem, targetsReady } from './text';
import type { ActiveCard, Change, GameState, LogEntry, PendingCard, Sex } from './types';
import { modeMultiplier } from './world';
import { POOL_FULL_WEIGHT, POOL_IDS, poolWeights, poolYearChance } from './pools';
import { alive } from './relations';

/** 확률 바닥값: 현실에서 10만 분의 1인 사건도 언젠가는 일어난다 (가능한 사건에만) */
export const P_FLOOR = 1e-6;
export const P_CAP = 0.95;

/** 매년 추첨 대상이 되는 종류. 마일스톤은 조건만 맞으면 일어나고, chain은 앞 사건이 부른다 */
const DRAWN_TYPES = new Set(['random', 'chain_start', 'consequence', 'npc', 'world']);
/** 그해 먼저 처리하는 종류 (행동의 대가, 세계 사건) */
const FIRST_TYPES = new Set(['consequence', 'world']);
/** 조용한 해를 채울 때 쓰는 일상 사건의 최대 충격량 */
const FILLER_MAX_IMPACT = 12;

// ── 사건 색인 ────────────────────────────────────────────
// 해마다 사건 수천 개를 전부 훑지 않도록 종류별로 나눠 둔다.

/** 풀 사건 하나 (색인을 만들 때 한 번 만든다) */
interface PoolEntry {
  ev: EventDef;
  base: number;
  curve?: Record<string, number>;
  /** 보정 배수 (없으면 비워 둔다) */
  mods?: { if: string; x: number }[];
  /** 같은 묶음 쿨다운을 찾는 열쇠 ('@묶음') */
  groupKey?: string;
}

/**
 * 풀 하나의 색인. 나이 조건·성인·생애 단계 경계(cuts)로 나이를 구간으로 나누면
 * 한 구간 안에서는 나이·성별로 정해지는 후보가 같다. 구간·성별마다 후보 목록을 한 번만 만든다.
 */
interface PoolTable {
  entries: PoolEntry[];
  /** 후보가 바뀔 수 있는 나이들 (오름차순) */
  cuts: number[];
  buckets: Map<string, PoolEntry[]>;
}

interface EventIndex {
  /** 만들 때의 사건 수. 테스트·도구가 EVENTS를 바꾸면 다시 만든다 */
  size: number;
  /** 해마다 하나하나 굴리는 사건 (풀 밖) */
  drawn: EventDef[];
  /** 관문 (같은 해 순서대로) */
  milestones: EventDef[];
  /** 풀별 추첨 사건 */
  pools: Map<string, PoolTable>;
}

let index: EventIndex | null = null;

function eventIndex(): EventIndex {
  if (index && index.size === EVENTS.length) return index;
  const drawn: EventDef[] = [];
  const pools = new Map<string, PoolTable>();
  for (const ev of EVENTS) {
    if (!DRAWN_TYPES.has(ev.type) || !ev.weight) continue;
    if (!ev.pool) {
      drawn.push(ev);
      continue;
    }
    let table = pools.get(ev.pool);
    if (!table) {
      table = { entries: [], cuts: [], buckets: new Map() };
      pools.set(ev.pool, table);
    }
    const w = ev.weight;
    table.entries.push({
      ev,
      base: w.base,
      curve: w.ageCurve,
      mods: w.modifiers?.length ? w.modifiers : undefined,
      groupKey: ev.group ? `@${ev.group}` : undefined,
    });
  }
  for (const table of pools.values()) table.cuts = ageCuts(table.entries);
  const milestones = EVENTS.filter((ev) => ev.type === 'milestone').sort((a, b) => (a.order ?? 10) - (b.order ?? 10));
  index = { size: EVENTS.length, drawn, milestones, pools };
  return index;
}

/** 나이·성인(19세)·생애 단계 조건이 바뀌는 나이들 */
function ageCuts(entries: PoolEntry[]): number[] {
  const cuts = new Set<number>([0, 19, ...STAGES.map((s) => s.from)]);
  for (const { ev } of entries) {
    const age = ev.trigger?.age;
    if (age) {
      cuts.add(age[0]);
      cuts.add(age[1] + 1);
    }
  }
  return [...cuts].sort((a, b) => a - b);
}

/** 이 나이가 속한 구간의 시작 (cuts 중 나이 이하에서 가장 큰 값) */
function segmentOf(cuts: number[], age: number): number {
  let lo = 0;
  let hi = cuts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cuts[mid] <= age) lo = mid;
    else hi = mid - 1;
  }
  return cuts[lo];
}

/** 테스트·도구가 EVENTS를 고친 뒤 색인을 버린다 (사건 수가 바뀌면 저절로 다시 만든다) */
export function resetEventIndex(): void {
  index = null;
}

/** 나이 곡선의 점들 (곡선마다 한 번만 정렬한다) */
const curvePoints = new WeakMap<Record<string, number>, [number, number][]>();

function pointsOf(curve: Record<string, number>): [number, number][] {
  let pts = curvePoints.get(curve);
  if (!pts) {
    pts = Object.entries(curve)
      .map(([k, v]) => [Number(k), v] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    curvePoints.set(curve, pts);
  }
  return pts;
}

export function ageFactor(curve: Record<string, number> | undefined, age: number): number {
  if (!curve) return 1;
  const pts = pointsOf(curve);
  if (pts.length === 0) return 1;
  if (age <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x0, y0] = pts[i - 1];
    if (age <= x1) return y0 + ((y1 - y0) * (age - x0)) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}

/**
 * 같은 상태에서 되풀이되는 판정을 한 번만 계산해 둔다. 풀 사건은 수천 개지만
 * 서로 다른 조건식은 백여 개뿐이라 풀 추첨 한 번 동안 결과를 재사용한다.
 */
interface Memo {
  cond: Map<string, boolean>;
  kidAges: number[];
}

function makeMemo(state: GameState): Memo {
  return { cond: new Map(), kidAges: kidAges(state) };
}

function kidAges(state: GameState): number[] {
  return alive(state.ch, 'child').map((k) => state.year - k.birthYear);
}

function condOk(src: string, scope: Scope, memo?: Memo): boolean {
  if (!memo) return evaluate(src, scope);
  let v = memo.cond.get(src);
  if (v === undefined) {
    v = evaluate(src, scope);
    memo.cond.set(src, v);
  }
  return v;
}

/** 나이·성별만으로 정해지는 조건 (풀 후보를 나이·성별 칸으로 나눌 때도 쓴다) */
function staticTriggerOk(ev: EventDef, age: number, sex: Sex): boolean {
  if (ev.adult && age < 19) return false;
  const t = ev.trigger;
  if (!t) return true;
  if (t.age && (age < t.age[0] || age > t.age[1])) return false;
  if (t.sex && sex !== t.sex) return false;
  if (t.stage && !t.stage.includes(stageOf(age))) return false;
  return true;
}

/**
 * 자녀 나이 조건. 카드가 이미 자녀를 묶었으면(이어받은 사건) 바로 그 아이가 살아서 그 나이대여야 한다.
 * 다른 형제가 조건을 채운다고 통과시키지 않는다 (R-012). 아직 안 묶였으면 살아 있는 자녀 누구든 그 나이대면 된다
 */
function childAgeOk([lo, hi]: [number, number], scope: Scope, state: GameState, memo?: Memo): boolean {
  const id = (scope.ctx as Record<string, string> | undefined)?.childId;
  if (id !== undefined) {
    const k = state.ch.npcs.find((n) => n.id === id);
    const age = k ? state.year - k.birthYear : -1;
    return Boolean(k?.alive && !k.missing) && age >= lo && age <= hi;
  }
  return (memo?.kidAges ?? kidAges(state)).some((a) => a >= lo && a <= hi);
}

/** 그때그때 상태로 정해지는 조건: 자녀 나이, 모드, 태그, 조건식 */
function stateTriggerOk(ev: EventDef, scope: Scope, state: GameState, memo?: Memo): boolean {
  const t = ev.trigger;
  if (!t) return true;
  const flags = state.ch.flags;
  if (t.childAge && !childAgeOk(t.childAge, scope, state, memo)) return false;
  if (t.modes && !t.modes.includes(state.mode)) return false;
  if (t.flags && !t.flags.every((f) => flags[f])) return false;
  if (t.anyFlags && !t.anyFlags.some((f) => flags[f])) return false;
  if (t.notFlags && t.notFlags.some((f) => flags[f])) return false;
  if (t.if && !condOk(t.if, scope, memo)) return false;
  return true;
}

export function triggerOk(ev: EventDef, scope: Scope, state: GameState): boolean {
  return staticTriggerOk(ev, state.ch.age, state.ch.sex) && stateTriggerOk(ev, scope, state);
}

export function limitOk(ev: EventDef, state: GameState): boolean {
  const l = ev.limit;
  if (!l) return true;
  const n = state.counts[ev.id] ?? 0;
  if (l.oncePerLife && n > 0) return false;
  if (l.max !== undefined && n >= l.max) return false;
  if (l.cooldown !== undefined) {
    const last = state.lastAge[ev.id];
    if (last !== undefined && state.ch.age - last < l.cooldown) return false;
  }
  return true;
}

export interface Probability {
  p0: number;
  A: number;
  m: number;
  D: number;
  M: number;
  P: number;
}

/** 사건이 일어날 수 있는 햇수 (나이 조건 기준, 85세까지) */
export function eligibleYears(ev: EventDef): number {
  const [lo, hi] = ev.trigger?.age ?? [0, 85];
  return Math.max(1, Math.min(hi, 85) - lo + 1);
}

export function eventProbability(ev: EventDef, state: GameState, scope = buildScope(state)): Probability {
  const w = ev.weight;
  if (!w) return { p0: 0, A: 0, m: 0, D: 0, M: 0, P: 0 };
  const p0 = w.base;
  const A = ageFactor(w.ageCurve, state.ch.age);
  let m = 1;
  for (const mod of w.modifiers ?? []) if (evaluate(mod.if, scope)) m *= mod.x;
  const D = directorFactor(state, ev);
  const M = w.noMode ? 1 : modeMultiplier(state.mode, p0, eligibleYears(ev));
  // 인수 하나가 0이면 '희귀'가 아니라 '불가능'이다. 바닥값으로 끌어올리지 않는다
  const impossible = !(p0 > 0 && A > 0 && m > 0 && D > 0 && M > 0);
  const P = impossible ? 0 : Math.min(P_CAP, Math.max(P_FLOOR, p0 * A * m * D * M));
  return { p0, A, m, D, M, P };
}

/** 가중치 비례로 n개를 겹치지 않게 뽑는다 */
function pickWeighted<T extends { P: number }>(items: T[], n: number, rng: Rng): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) {
    const chosen = rng.weighted(pool, (x) => x.P);
    if (!chosen) break;
    out.push(chosen);
    pool.splice(pool.indexOf(chosen), 1);
  }
  return out;
}

/**
 * 4단계 사건 추첨: 조건 맞는 후보를 하나하나 확률대로 굴린다. 일어난 사건은 개수와 상관없이
 * 전부 대기열에 들어간다. 조용한 해에는 디렉터가 정한 최소 개수까지 일상 사건으로 채우고,
 * 마지막으로 생활 사건 풀에서 한 장까지 뽑는다.
 */
export function drawYearEvents(state: GameState): PendingCard[] {
  updatePace(state);
  const scope = buildScope(state);
  const rng = rngFor(state.seed, 'events', state.ch.age);
  const fired: { ev: EventDef; P: number }[] = [];
  const missed: { ev: EventDef; P: number }[] = [];
  for (const ev of eventIndex().drawn) {
    if (!limitOk(ev, state) || !triggerOk(ev, scope, state)) continue;
    const { P } = eventProbability(ev, state, scope);
    // 확률 0인 사건은 주사위도 굴리지 않는다: 불가능한 사건을 더해도 같은 시드의 다른 사건 결과가 그대로다
    if (!(P > 0)) continue;
    if (rng.next() < P) fired.push({ ev, P });
    else missed.push({ ev, P });
  }
  const first = fired.filter((f) => FIRST_TYPES.has(f.ev.type));
  const rest = fired.filter((f) => !FIRST_TYPES.has(f.ev.type));
  const lack = fillerMinimum(state) - fired.length;
  if (lack > 0) {
    // 일상 사건으로만 채운다. 출산·결혼 같은 인구학적 사건은 실제 확률을 지킨다
    const fillers = missed.filter((m) => m.ev.filler && m.P > 0 && (m.ev.impact ?? 0) <= FILLER_MAX_IMPACT);
    rest.push(...pickWeighted(fillers, lack, rng));
  }
  const out = [...first, ...rest].map((f) => ({ eventId: f.ev.id, ctx: {} }));
  // 생활 사건 풀: 위에서 몇 개가 일어났든 따로 한 장까지 (난수 줄기도 따로 써서 서로 영향이 없다)
  const pooled = drawPool(state, scope);
  if (pooled) out.push({ eventId: pooled.id, ctx: {} });
  return out;
}

// ── 생활 사건 풀 ─────────────────────────────────────────
// 풀 사건의 weight.base는 연간 확률이 아니라 풀 안의 상대 가중치다. 풀 카드는 '그해의 작은 장면 한 장'이라는
// 표시·표본 추상화로 둔다: 해마다 poolYearChance 확률로 장면 자리 하나, 자리는 poolWeights 비율로 한 풀에 가고,
// 그 풀에서는 조건이 맞는 사건 전체를 가중치(base × 나이 곡선 × 보정, 1에서 자르지 않음)대로 정확히 뽑는다.
// 다만 가중치 합 W가 POOL_FULL_WEIGHT보다 작으면 남는 몫은 조용한 해다 (pools.ts에 이유를 적었다):
//   P(e) = poolYearChance × (풀 비율) × w_e / max(W, POOL_FULL_WEIGHT)
//  - 조건이 맞지 않는 후보는 몇 개를 더해도 뽑힐 확률이 그대로다 (같은 시드면 같은 사건).
//  - 다른 풀의 콘텐츠는 이 풀 사건의 확률을 바꾸지 않는다 (후보가 없는 풀도 몫을 넘기지 않고 조용한 해).
//  - 같은 풀에 조건이 맞는 사건을 더해도 풀이 꽉 차기 전에는 그대로, 꽉 찬 뒤에는 그 풀의 몫을 나눠 갖는다.
//  - 그해 일반 사건이 몇 개 일어났는지와 무관하다.

/** 같은 묶음의 생활 사건이 다시 나오기까지 최소 햇수 */
const GROUP_COOLDOWN = 6;

export function poolEvents(pool: string): EventDef[] {
  return (eventIndex().pools.get(pool)?.entries ?? []).map((e) => e.ev);
}

/** 나이·성별만으로 정해지는 후보. 태그·조건식·제한·가중치는 해마다 따로 본다 */
function poolBucket(pool: PoolId, sex: Sex, age: number): PoolEntry[] {
  const table = eventIndex().pools.get(pool);
  if (!table) return [];
  const key = `${sex}|${segmentOf(table.cuts, age)}`;
  let bucket = table.buckets.get(key);
  if (!bucket) {
    bucket = table.entries.filter((e) => staticTriggerOk(e.ev, age, sex));
    table.buckets.set(key, bucket);
  }
  return bucket;
}

/** 풀 하나에서 지금 나올 수 있는 사건들과 가중치 (가중치가 0인 사건은 빠진다) */
interface Eligible {
  events: EventDef[];
  weights: number[];
  total: number;
}

function eligibleInPool(state: GameState, pool: PoolId, scope: Scope): Eligible {
  const age = state.ch.age;
  const memo = makeMemo(state);
  const out: Eligible = { events: [], weights: [], total: 0 };
  const bucket = poolBucket(pool, state.ch.sex, age);
  for (let i = 0; i < bucket.length; i++) {
    const e = bucket[i];
    if (e.groupKey !== undefined) {
      const last = state.lastAge[e.groupKey];
      if (last !== undefined && age - last < GROUP_COOLDOWN) continue;
    }
    if (!limitOk(e.ev, state) || !stateTriggerOk(e.ev, scope, state, memo)) continue;
    // 가중치 = base × 나이 곡선 × 보정. 1에서 자르지 않는다
    let w = e.curve ? e.base * ageFactor(e.curve, age) : e.base;
    if (e.mods) for (const mod of e.mods) if (condOk(mod.if, scope, memo)) w *= mod.x;
    if (!(w > 0)) continue;
    out.events.push(e.ev);
    out.weights.push(w);
    out.total += w;
  }
  return out;
}

/** 검증·테스트용: 풀 하나의 후보와 가중치 */
export function poolCandidates(state: GameState, pool: PoolId, scope = buildScope(state)): { ev: EventDef; w: number }[] {
  const e = eligibleInPool(state, pool, scope);
  return e.events.map((ev, i) => ({ ev, w: e.weights[i] }));
}

/**
 * 풀 추첨 (한 해 한 장까지). 자리를 풀 비율대로 한 풀에 주고, 그 풀의 후보 전체에서 가중치대로 하나를 뽑는다.
 * 후보의 가중치 합이 POOL_FULL_WEIGHT보다 작으면 남는 몫은 조용한 해(null)다. 후보가 없는 풀도 조용한 해이며
 * 다른 풀로 다시 고르지 않는다: 그래야 한 풀의 콘텐츠 양이 다른 풀 사건의 빈도를 바꾸지 않는다.
 */
export function drawPool(state: GameState, scope = buildScope(state)): EventDef | null {
  const rng = rngFor(state.seed, 'pool', state.ch.age);
  if (!rng.chance(poolYearChance(state.mode))) return null;
  const weights = poolWeights(state);
  const pool = rng.weighted(POOL_IDS, (p) => weights[p]);
  if (!pool) return null;
  const e = eligibleInPool(state, pool, scope);
  return pickOrQuiet(e, rng.next());
}

/** 누적 가중치를 따라가며 u × max(합계, 꽉 찬 기준) 자리의 사건을 고른다. 합계를 넘는 자리는 조용한 해 */
function pickOrQuiet(e: Eligible, u: number): EventDef | null {
  const crowded = e.total >= POOL_FULL_WEIGHT;
  let r = u * (crowded ? e.total : POOL_FULL_WEIGHT);
  for (let i = 0; i < e.events.length; i++) {
    r -= e.weights[i];
    if (r < 0) return e.events[i];
  }
  // 꽉 찬 풀에서 반올림 오차로 끝까지 온 경우만 마지막 사건이다
  return crowded ? e.events[e.events.length - 1] : null;
}

/** 1단계 관문: 조건을 채운 마일스톤은 반드시 일어난다 */
export function milestonesFor(state: GameState): PendingCard[] {
  const scope = buildScope(state);
  return eventIndex()
    .milestones.filter((ev) => limitOk(ev, state) && triggerOk(ev, scope, state))
    .map((ev) => ({ eventId: ev.id, ctx: {} }));
}

const CHECK_LABEL: Record<string, string> = {
  health: '건강',
  stamina: '체력',
  intelligence: '지능',
  looks: '외모',
  sociability: '사교성',
  happiness: '행복',
  mental: '멘탈',
  luck: '운',
  morality: '양심',
  reputation: '평판',
  stress: '스트레스',
  'family.support': '가족',
  'edu.grade': '내신',
  'personality.conscientiousness': '성실성',
  'personality.extraversion': '외향성',
};

function checkKeys(check: CheckDef): string[] {
  return check.stats ?? (check.stat ? [check.stat] : []);
}

export function checkLabel(check: CheckDef): string {
  return `${checkKeys(check)
    .map((k) => CHECK_LABEL[k] ?? k)
    .join('·')} 판정`;
}

function checkValue(state: GameState, scope: ReturnType<typeof buildScope>, key: string): number {
  const ch = state.ch;
  if (key in ch.stats) return ch.stats[key as keyof typeof ch.stats];
  if (key in ch.hidden) return ch.hidden[key as keyof typeof ch.hidden];
  if (key in ch.state) return ch.state[key as keyof typeof ch.state];
  let cur: unknown = scope;
  for (const part of key.split('.')) cur = (cur as Record<string, unknown> | undefined)?.[part];
  return typeof cur === 'number' ? cur : 50;
}

/** 판정 성공 확률: 능력치가 난이도와 같으면 50%, 10 높으면 70%. 운이 조금 보탠다 */
export function checkChance(state: GameState, check: CheckDef, ctx: Record<string, string>): number {
  const scope = buildScope(state, ctx);
  const keys = checkKeys(check);
  const v = keys.reduce((s, k) => s + checkValue(state, scope, k), 0) / Math.max(1, keys.length);
  const luck = (state.ch.hidden.luck - 50) / 500;
  return Math.min(0.95, Math.max(0.05, 0.5 + (v - check.dc) / 50 + luck));
}

function resolveNext(next: NextRef | undefined, rng: Rng): string | undefined {
  if (!next) return undefined;
  if (typeof next === 'string') return next;
  return rng.weighted(next, (n) => n.w)?.event;
}

function logEntry(state: GameState, ev: EventDef, title: string, text: string): LogEntry {
  return {
    year: state.year,
    age: state.ch.age,
    kind: ev.type === 'milestone' ? 'milestone' : 'event',
    title,
    text,
    tone: ev.tone ?? 'neutral',
    impact: ev.impact ?? 0,
  };
}

/**
 * 카드 없이 일기 한 줄로 남기는 사건: 보이는 선택지가 없고(결정할 것이 없다), 충격량이 '큰 사건'보다 작고,
 * 비극·사망이 아니며, 작가가 장면(zoom)으로 연출하지 않은 것. 나머지는 선택지가 없어도 카드로 보여 준다.
 */
export function recordsAsDiary(ev: EventDef, shownChoices: number): boolean {
  return shownChoices === 0 && (ev.impact ?? 0) < BIG_IMPACT && ev.tone !== 'tragedy' && !ev.effects?.death && !ev.zoom;
}

/** 일기 한 줄에 바뀐 수치를 덧붙인다 (카드가 없으니 변화를 보여 줄 곳이 여기뿐이다) */
function diaryText(text: string, changes: Change[]): string {
  return changes.length > 0 ? `${text} (${changes.map((c) => c.text).join(', ')})` : text;
}

/** 대상이 사라져 없던 일이 된 사건: 왜 일어나지 않았는지 일기에 조용한 한 줄 (효과·횟수는 남기지 않는다) */
function cancelledEntry(state: GameState, ev: EventDef, ctx: Record<string, string>, reason: string): LogEntry {
  return {
    year: state.year,
    age: state.ch.age,
    kind: 'system',
    text: `${reason} 예정됐던 일(${render(ev.title, state, ctx)})은 없던 일이 됐다.`,
  };
}

/**
 * 대기 사건을 일으킨다. 그사이 조건이 깨졌으면 건너뛴다. 사건 자체의 효과는 이때 적용되고 기록된다.
 * 결정이 필요하면 카드로 올리고 true(플레이어를 기다린다). 결정할 것이 없는 작은 사건은
 * 일기 한 줄만 남기고 false(대기열의 다음 사건으로 넘어간다). 건너뛴 사건도 false.
 */
export function presentCard(state: GameState, pending: PendingCard): boolean {
  ((globalThis as any).__cnt ??= {})['eventEngine'] = (((globalThis as any).__cnt['eventEngine']) ?? 0) + 1; // TEMPCOUNT
  const ev = getEvent(pending.eventId);
  if (!state.ch.alive) return false;
  // 물려받은 대상(자녀·부모·형제·친구·연인·배우자)이 그사이 죽었거나 역할·자녀 나이대에서 벗어났으면
  // 다른 사람으로 바꾸지 않고 취소하고, 이유를 일기에 남긴다 (R-012)
  const lost = targetProblem(state, ev, pending.ctx);
  if (lost) {
    state.log.push(cancelledEntry(state, ev, pending.ctx, lost));
    return false;
  }
  const scope = buildScope(state, pending.ctx);
  if (!triggerOk(ev, scope, state) || !limitOk(ev, state)) return false;

  state.serial += 1;
  const serial = state.serial;
  const rng = rngFor(state.seed, 'card', serial);
  const ctx: Record<string, string> = { ...pending.ctx };
  // 대상 인물은 문장이 아니라 사건 정의로 정한다 (R-011). 역할마다 난수 줄기를 따로 쓴다
  generateCtx(state, ev, ctx, rng, (role) => rngFor(state.seed, 'card', serial, 'target', role));
  // 묶을 사람이 없는 한 사람 대상 효과는 '그 역할 모두'로 번지지 않게 아예 쓰지 않는다
  if (!targetsReady(ctx, ev.effects)) return false;

  const intro: Change[] = [];
  applyEffects(state, ev.effects, { ctx, rng, changes: intro });
  state.counts[ev.id] = (state.counts[ev.id] ?? 0) + 1;
  state.lastAge[ev.id] = state.ch.age;
  if (ev.group) state.lastAge[`@${ev.group}`] = state.ch.age;
  addImpact(state, ev.impact ?? 0);

  const after = buildScope(state, ctx);
  const choices = (ev.choices ?? [])
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => (!c.if || evaluate(c.if, after)) && targetsReady(ctx, c.effects, c.onSuccess?.effects, c.onFail?.effects))
    .map(({ c, index }) => ({
      index,
      text: render(c.text, state, ctx),
      check: c.check ? checkLabel(c.check) : undefined,
    }));
  const title = render(ev.title, state, ctx);
  const text = render(ev.text, state, ctx);

  if (recordsAsDiary(ev, choices.length)) {
    state.log.push(logEntry(state, ev, title, diaryText(text, intro)));
    const next = resolveNext(ev.next, rngFor(state.seed, 'card', serial, 'next'));
    if (next && state.ch.alive) state.queue.unshift({ eventId: next, ctx });
    return false;
  }

  const card: ActiveCard = {
    eventId: ev.id,
    serial,
    title,
    text,
    zoom: ev.zoom ? render(ev.zoom, state, ctx) : undefined,
    tone: ev.tone ?? 'neutral',
    arcLabel: ev.arc,
    pool: ev.pool,
    ctx,
    choices,
    intro,
  };
  state.card = card;
  state.phase = 'event';
  if (choices.length === 0) state.log.push(logEntry(state, ev, card.title, card.text));
  return true;
}

/** 선택지를 고른다. 판정·효과를 적용하고 결과를 카드에 붙인다 */
export function chooseOption(state: GameState, displayIndex: number): void {
  const card = state.card;
  if (!card || card.result) return;
  const ev = getEvent(card.eventId);
  const shown = card.choices[displayIndex];
  if (!shown) return;
  const choice = ev.choices![shown.index];
  const rng = rngFor(state.seed, 'card', card.serial, 'choice', shown.index);
  const changes: Change[] = [];
  const ec = { ctx: card.ctx, rng, changes };

  applyEffects(state, choice.effects, ec);
  let text = choice.result ?? '';
  let next = choice.next;
  let success: boolean | undefined;
  if (choice.check) {
    success = rng.chance(checkChance(state, choice.check, card.ctx));
    const out = success ? choice.onSuccess : choice.onFail;
    if (out) {
      applyEffects(state, out.effects, ec);
      if (out.text) text = out.text;
      if (out.next) next = out.next;
    }
  }
  const resultText = render(text, state, card.ctx);
  card.result = {
    choice: shown.text,
    text: resultText,
    success,
    changes,
    next: resolveNext(next, rng),
  };
  state.log.push(logEntry(state, ev, card.title, resultText || `${shown.text}.`));
}

/** 카드를 넘긴다. 이어지는 사건이 있으면 대기열 맨 앞에 넣는다. 다음에 올릴 카드는 game.ts가 정한다 */
export function dismissCard(state: GameState): void {
  const card = state.card;
  if (!card) return;
  const ev = getEvent(card.eventId);
  let next = card.result?.next;
  // 보이는 선택지가 없던 카드(조건 때문에 모두 숨은 경우 포함)는 사건의 next로 이어진다
  if (!card.result && card.choices.length === 0) {
    next = resolveNext(ev.next, rngFor(state.seed, 'card', card.serial, 'next'));
  }
  state.card = undefined;
  if (next && state.ch.alive) state.queue.unshift({ eventId: next, ctx: card.ctx });
}
