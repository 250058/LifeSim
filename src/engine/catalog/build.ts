// 사건 목록(catalog) 공용 도구. data/catalog/*.json의 짧은 표를 엔진의 사건(EventDef)으로 펼친다.
// 표에는 장면 문장과 수치만 적고, 사건 모양(종류·풀·제한·선택지 구조)은 여기서 정한다.

import type { Action, ChoiceDef, Effects, EventDef, PoolId, TransitionReward, TreatStep, TriggerDef } from '../schema';
import type { Sex, Tone } from '../types';

/** 표에 쓰는 짧은 효과 표기 */
export interface Fx {
  health?: number;
  stamina?: number;
  intelligence?: number;
  looks?: number;
  sociability?: number;
  happiness?: number;
  stress?: number;
  reputation?: number;
  mental?: number;
  morality?: number;
  /** 2026년 원 기준 지출 (양수로 적는다) */
  cost?: number;
  /** 2026년 원 기준 수입 */
  gain?: number;
  add?: string[];
  remove?: string[];
  /** 치료 단계: 치료 태그는 add/remove 대신 이것으로 시작·유지·감량·중단·재개한다 */
  treat?: TreatStep[];
  /** 상태가 실제로 바뀔 때만 주는 능력치 (예: 관리 안 되던 만성 질환이 관리 중이 될 때) */
  transition?: TransitionReward;
  /** n년 뒤 이어지는 사건 */
  later?: { event: string; inYears: number }[];
  /** 엔진 행동 (예: npcCloseness, haveChild) */
  do?: Action[];
}

const STAT_FIELDS = [
  'health',
  'stamina',
  'intelligence',
  'looks',
  'sociability',
  'happiness',
  'stress',
  'reputation',
  'mental',
  'morality',
] as const;

export function toEffects(f: Fx | undefined): Effects | undefined {
  if (!f) return undefined;
  const out: Effects = {};
  const stats: Effects['stats'] = {};
  for (const k of STAT_FIELDS) if (f[k]) stats[k] = f[k];
  if (Object.keys(stats).length) out.stats = stats;
  const money = (f.gain ?? 0) - (f.cost ?? 0);
  if (money) out.money = { cash2026: money };
  if (f.add?.length) out.addFlags = [...f.add];
  if (f.remove?.length) out.removeFlags = [...f.remove];
  if (f.treat?.length) out.treat = f.treat.map((t) => ({ ...t }));
  if (f.transition) out.transition = { ...f.transition, stats: { ...f.transition.stats } };
  if (f.later?.length) out.later = f.later.map((l) => ({ ...l }));
  if (f.do?.length) out.do = f.do.map((a) => ({ ...a }));
  return Object.keys(out).length ? out : undefined;
}

/** 두 효과를 더한다 (상황 보정 + 현상 효과) */
export function addFx(a: Fx | undefined, b: Fx | undefined): Fx | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: Fx = { ...a };
  for (const k of [...STAT_FIELDS, 'cost', 'gain'] as const) {
    const v = (a[k] ?? 0) + (b[k] ?? 0);
    if (v) out[k] = v;
    else delete out[k];
  }
  out.add = [...(a.add ?? []), ...(b.add ?? [])];
  out.remove = [...(a.remove ?? []), ...(b.remove ?? [])];
  out.treat = [...(a.treat ?? []), ...(b.treat ?? [])];
  out.later = [...(a.later ?? []), ...(b.later ?? [])];
  out.do = [...(a.do ?? []), ...(b.do ?? [])];
  // 상태 변화 보상은 하나만 둘 수 있다 (상황 보정에는 쓰지 않는다)
  if (a.transition && b.transition) throw new Error('상태 변화 보상(transition)을 두 효과에서 함께 쓸 수 없다');
  const transition = a.transition ?? b.transition;
  if (transition) out.transition = transition;
  else delete out.transition;
  return out;
}

/** 두 나이 범위의 겹치는 부분 */
export function overlap(a: [number, number] | undefined, b: [number, number] | undefined): [number, number] | null {
  const lo = Math.max(a?.[0] ?? 0, b?.[0] ?? 0);
  const hi = Math.min(a?.[1] ?? 120, b?.[1] ?? 120);
  return lo <= hi ? [lo, hi] : null;
}

/** 조건식들을 && 로 잇는다 */
export function and(...xs: (string | undefined | false)[]): string | undefined {
  const parts = xs.filter((x): x is string => Boolean(x));
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return parts.map((x) => `(${x})`).join(' && ');
}

/** 성별 조건이 서로 맞는가 */
export function sexMatch(a: Sex | undefined, b: Sex | undefined): Sex | undefined | false {
  if (a && b && a !== b) return false;
  return a ?? b;
}

export interface ChoiceRow {
  text: string;
  result: string;
  fx?: Fx;
  if?: string;
  /** 판정 (예: ["stamina", 50]) */
  check?: [string, number];
  fail?: string;
  failFx?: Fx;
  next?: string;
}

export function choice(c: ChoiceRow, extraResult = '', extraFx?: Fx): ChoiceDef {
  const result = [c.result, extraResult].filter(Boolean).join(' ');
  if (c.check) {
    return {
      text: c.text,
      ...(c.if ? { if: c.if } : {}),
      check: { stat: c.check[0], dc: c.check[1] },
      onSuccess: { text: result, effects: toEffects(addFx(c.fx, extraFx)), ...(c.next ? { next: c.next } : {}) },
      onFail: { text: c.fail ?? result, effects: toEffects(addFx(c.failFx, extraFx)) },
    };
  }
  return {
    text: c.text,
    ...(c.if ? { if: c.if } : {}),
    result,
    ...(toEffects(addFx(c.fx, extraFx)) ? { effects: toEffects(addFx(c.fx, extraFx)) } : {}),
    ...(c.next ? { next: c.next } : {}),
  };
}

export interface EventSpec {
  id: string;
  pool: PoolId;
  title: string;
  text: string;
  zoom?: string;
  tone?: Tone;
  impact?: number;
  age?: [number, number];
  sex?: Sex;
  if?: string;
  flags?: string[];
  notFlags?: string[];
  childAge?: [number, number];
  /** 풀 안에서의 상대 가중치 (0~1] */
  w?: number;
  ageCurve?: Record<string, number>;
  modifiers?: { if: string; x: number }[];
  once?: boolean;
  cooldown?: number;
  choices?: ChoiceDef[];
  effects?: Effects;
  type?: EventDef['type'];
  adult?: boolean;
  group?: string;
  motif?: string;
  next?: string;
}

/** 표 한 줄을 사건으로 */
export function makeEvent(s: EventSpec): EventDef {
  const trigger: TriggerDef = {};
  if (s.age) trigger.age = s.age;
  if (s.sex) trigger.sex = s.sex;
  if (s.flags?.length) trigger.flags = s.flags;
  if (s.notFlags?.length) trigger.notFlags = s.notFlags;
  if (s.childAge) trigger.childAge = s.childAge;
  if (s.if) trigger.if = s.if;
  const type = s.type ?? 'random';
  const ev: EventDef = {
    id: s.id,
    type,
    title: s.title,
    text: s.text,
    tone: s.tone ?? 'neutral',
    impact: s.impact ?? 4,
    pool: s.pool,
  };
  if (s.zoom) ev.zoom = s.zoom;
  if (s.motif) ev.motif = s.motif;
  if (s.adult) ev.adult = true;
  if (s.group) ev.group = s.group;
  if (Object.keys(trigger).length) ev.trigger = trigger;
  if (type !== 'chain') {
    ev.weight = { base: Math.min(1, Math.max(0.001, s.w ?? 0.5)), noMode: true };
    if (s.ageCurve) ev.weight.ageCurve = s.ageCurve;
    if (s.modifiers?.length) ev.weight.modifiers = s.modifiers;
    ev.limit = s.once === false ? { cooldown: s.cooldown ?? 6 } : { oncePerLife: true };
  }
  if (s.effects) ev.effects = s.effects;
  if (s.choices?.length) ev.choices = s.choices;
  if (s.next) ev.next = s.next;
  return ev;
}

/** id에 쓸 수 있게 정리 */
export function slug(...parts: string[]): string {
  return parts.join('_').replace(/[^a-z0-9_]/gi, '').toLowerCase();
}
