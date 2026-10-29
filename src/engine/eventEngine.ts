// 이벤트 엔진: 조건 평가, 확률 계산, 추첨, 카드 만들기, 선택 처리.
//
//   P = p₀ × A(나이) × Πmᵢ × W × D × M
//
// p₀ 실제 통계의 기본 확률, A 나이 곡선, m 능력치·태그·지역·형편 보정(세계 보정 W 포함),
// D 디렉터 보정, M 모드 배수. 모든 사건은 확률 바닥값을 가져 절대 0이 되지 않는다.

import { evaluate } from './conditions';
import { EVENTS, getEvent } from './data';
import { addImpact, countRange, directorFactor, updatePace } from './director';
import { applyEffects } from './effects';
import { stageOf } from './format';
import { rngFor, type Rng } from './rng';
import { buildScope } from './scope';
import type { CheckDef, EventDef, NextRef } from './schema';
import { generateCtx, render } from './text';
import type { ActiveCard, Change, GameState, LogEntry, PendingCard } from './types';
import { modeMultiplier } from './world';
import { POOL_IDS, poolWeights, poolYearChance } from './pools';
import { alive } from './relations';

/** 확률 바닥값: 현실에서 10만 분의 1인 사건도 언젠가는 일어난다 */
export const P_FLOOR = 1e-6;
export const P_CAP = 0.95;

/** 매년 추첨 대상이 되는 종류. 마일스톤은 조건만 맞으면 일어나고, chain은 앞 사건이 부른다 */
const DRAWN_TYPES = new Set(['random', 'chain_start', 'consequence', 'npc', 'world']);
/** 디렉터의 연간 개수 제한을 받지 않는 종류 (행동의 대가, 세계 사건) */
const UNCAPPED_TYPES = new Set(['consequence', 'world']);
/** 조용한 해를 채울 때 쓰는 일상 사건의 최대 충격량 */
const FILLER_MAX_IMPACT = 12;

export function ageFactor(curve: Record<string, number> | undefined, age: number): number {
  if (!curve) return 1;
  const pts = Object.entries(curve)
    .map(([k, v]) => [Number(k), v] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (pts.length === 0) return 1;
  if (age <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x0, y0] = pts[i - 1];
    if (age <= x1) return y0 + ((y1 - y0) * (age - x0)) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}

export function triggerOk(ev: EventDef, scope: ReturnType<typeof buildScope>, state: GameState): boolean {
  const t = ev.trigger;
  if (!t) return true;
  const ch = state.ch;
  if (t.age && (ch.age < t.age[0] || ch.age > t.age[1])) return false;
  if (t.sex && ch.sex !== t.sex) return false;
  if (ev.adult && ch.age < 19) return false;
  if (t.childAge) {
    const [lo, hi] = t.childAge;
    if (!alive(ch, 'child').some((k) => state.year - k.birthYear >= lo && state.year - k.birthYear <= hi)) return false;
  }
  if (t.stage && !t.stage.includes(stageOf(ch.age))) return false;
  if (t.modes && !t.modes.includes(state.mode)) return false;
  if (t.flags && !t.flags.every((f) => ch.flags[f])) return false;
  if (t.anyFlags && !t.anyFlags.some((f) => ch.flags[f])) return false;
  if (t.notFlags && t.notFlags.some((f) => ch.flags[f])) return false;
  if (t.if && !evaluate(t.if, scope)) return false;
  return true;
}

export function limitOk(ev: EventDef, state: GameState): boolean {
  const l = ev.limit;
  if (!l) return true;
  const n = state.counts[ev.id] ?? 0;
  if (l.oncePerLife && n > 0) return false;
  if (l.max !== undefined && n >= l.max) return false;
  const last = state.lastAge[ev.id];
  if (l.cooldown !== undefined && last !== undefined && state.ch.age - last < l.cooldown) return false;
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
  const P = Math.min(P_CAP, Math.max(P_FLOOR, p0 * A * m * D * M));
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

/** 4단계 랜덤 사건: 조건 맞는 후보를 모아 확률대로 굴리고, 디렉터가 정한 개수만큼 고른다 */
export function drawYearEvents(state: GameState): PendingCard[] {
  updatePace(state);
  const scope = buildScope(state);
  const rng = rngFor(state.seed, 'events', state.ch.age);
  const fired: { ev: EventDef; P: number }[] = [];
  const missed: { ev: EventDef; P: number }[] = [];
  for (const ev of EVENTS) {
    if (!DRAWN_TYPES.has(ev.type) || !ev.weight || ev.pool) continue;
    if (!limitOk(ev, state) || !triggerOk(ev, scope, state)) continue;
    const { P } = eventProbability(ev, state, scope);
    if (rng.next() < P) fired.push({ ev, P });
    else missed.push({ ev, P });
  }
  const uncapped = fired.filter((f) => UNCAPPED_TYPES.has(f.ev.type));
  let capped = fired.filter((f) => !UNCAPPED_TYPES.has(f.ev.type));
  const [min, max] = countRange(state);
  if (capped.length > max) capped = pickWeighted(capped, max, rng);
  const total = capped.length + uncapped.length;
  if (total < min) {
    // 일상 사건으로만 채운다. 출산·결혼 같은 인구학적 사건은 실제 확률을 지킨다
    const fillers = missed.filter((m) => m.ev.filler && (m.ev.impact ?? 0) <= FILLER_MAX_IMPACT);
    capped.push(...pickWeighted(fillers, min - total, rng));
  }
  // 생활 사건 풀: 디렉터가 고르고 남은 자리가 있으면 한 장 (난수 스트림을 따로 써서 위 추첨에 영향이 없다)
  if (capped.length < max) {
    const pooled = drawPool(state, scope);
    if (pooled) capped.push({ ev: pooled, P: 0 });
  }
  return [...uncapped, ...capped].map((f) => ({ eventId: f.ev.id, ctx: {} }));
}

/** 같은 묶음의 생활 사건이 다시 나오기까지 최소 햇수 */
const GROUP_COOLDOWN = 6;

/** 풀별 사건과 누적 기본 가중치 (모듈을 처음 쓸 때 한 번 만든다) */
interface PoolTable {
  events: EventDef[];
  cumulative: number[];
}
let poolIndex: Map<string, PoolTable> | null = null;

function poolTable(pool: string): PoolTable {
  if (!poolIndex) {
    poolIndex = new Map();
    for (const ev of EVENTS) {
      if (!ev.pool || !DRAWN_TYPES.has(ev.type) || !ev.weight) continue;
      const t = poolIndex.get(ev.pool) ?? { events: [], cumulative: [] };
      const prev = t.cumulative.length ? t.cumulative[t.cumulative.length - 1] : 0;
      t.events.push(ev);
      t.cumulative.push(prev + ev.weight.base);
      poolIndex.set(ev.pool, t);
    }
  }
  return poolIndex.get(pool) ?? { events: [], cumulative: [] };
}

export function poolEvents(pool: string): EventDef[] {
  return poolTable(pool).events;
}

/** 풀 하나에서 몇 번 뽑아 보고 조건이 맞는 사건이 없으면 다른 풀로 넘어간다 */
const POOL_TRIES = 80;

/**
 * 풀 추첨. 사건이 수천 개라 전부 조건을 따지면 느리므로 기본 가중치로 하나를 뽑고
 * 조건(나이·태그·제한)이 맞는지 본다. 나이 곡선·보정 배수는 받아들일 확률로 쓴다.
 */
function drawPool(state: GameState, scope: ReturnType<typeof buildScope>): EventDef | null {
  const rng = rngFor(state.seed, 'pool', state.ch.age);
  if (!rng.chance(poolYearChance(state.mode))) return null;
  const weights = poolWeights(state);
  for (let round = 0; round < POOL_IDS.length; round++) {
    const pool = rng.weighted(POOL_IDS, (p) => weights[p]);
    if (!pool) return null;
    const table = poolTable(pool);
    const total = table.cumulative[table.cumulative.length - 1] ?? 0;
    for (let tries = 0; total > 0 && tries < POOL_TRIES; tries++) {
      const ev = table.events[lowerBound(table.cumulative, rng.next() * total)];
      if (ev.group) {
        const last = state.lastAge[`@${ev.group}`];
        if (last !== undefined && state.ch.age - last < GROUP_COOLDOWN) continue;
      }
      if (!limitOk(ev, state) || !triggerOk(ev, scope, state)) continue;
      const w = ev.weight!;
      let x = ageFactor(w.ageCurve, state.ch.age);
      for (const mod of w.modifiers ?? []) if (evaluate(mod.if, scope)) x *= mod.x;
      if (rng.next() < Math.min(1, x)) return ev;
    }
    weights[pool] = 0;
  }
  return null;
}

/** 누적 배열에서 value보다 큰 첫 자리 */
function lowerBound(cumulative: number[], value: number): number {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] > value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 1단계 관문: 조건을 채운 마일스톤은 반드시 일어난다 */
export function milestonesFor(state: GameState): PendingCard[] {
  const scope = buildScope(state);
  return EVENTS.filter((ev) => ev.type === 'milestone' && limitOk(ev, state) && triggerOk(ev, scope, state))
    .sort((a, b) => (a.order ?? 10) - (b.order ?? 10))
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
 * 대기 카드를 화면에 올린다. 그사이 조건이 깨졌으면 건너뛴다(false).
 * 사건 자체의 효과는 이때 적용된다.
 */
export function presentCard(state: GameState, pending: PendingCard): boolean {
  const ev = getEvent(pending.eventId);
  if (!state.ch.alive) return false;
  const scope = buildScope(state, pending.ctx);
  if (!triggerOk(ev, scope, state) || !limitOk(ev, state)) return false;

  state.serial += 1;
  const serial = state.serial;
  const rng = rngFor(state.seed, 'card', serial);
  const ctx: Record<string, string> = { ...pending.ctx };
  generateCtx(state, ev, ctx, rng);

  const intro: Change[] = [];
  applyEffects(state, ev.effects, { ctx, rng, changes: intro });
  state.counts[ev.id] = (state.counts[ev.id] ?? 0) + 1;
  state.lastAge[ev.id] = state.ch.age;
  if (ev.group) state.lastAge[`@${ev.group}`] = state.ch.age;
  addImpact(state, ev.impact ?? 0);

  const after = buildScope(state, ctx);
  const choices = (ev.choices ?? [])
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => !c.if || evaluate(c.if, after))
    .map(({ c, index }) => ({
      index,
      text: render(c.text, state, ctx),
      check: c.check ? checkLabel(c.check) : undefined,
    }));

  const card: ActiveCard = {
    eventId: ev.id,
    serial,
    title: render(ev.title, state, ctx),
    text: render(ev.text, state, ctx),
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
  if (!card.result && (ev.choices ?? []).length === 0) {
    next = resolveNext(ev.next, rngFor(state.seed, 'card', card.serial, 'next'));
  }
  state.card = undefined;
  if (next && state.ch.alive) state.queue.unshift({ eventId: next, ctx: card.ctx });
}
