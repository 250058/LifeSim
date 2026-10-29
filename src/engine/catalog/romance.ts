// 연애·사랑·관계. data/catalog/romance.json의 표를 사건으로 펼친다.
//
//   places × phases  데이트 장소마다 관계 단계(썸·연애 초기·오래된 연애·신혼·오래된 부부·황혼)별 장면
//   issues           관계 문제(연락·질투·시댁·외도 …)를 연애 중·결혼 생활별로
//   anniversaries    결혼기념일 (1주년 지혼식 … 60주년 회혼식)
//   events           손으로 쓴 사건: 고백·결혼 준비·모텔과 숙소·둘만의 시간·위기와 신고
//
// 모든 사건은 성인 전용(adult)이다. 짝이 나오는 사건은 나와 상대가 모두 만 19세 이상일 때만 열린다
// (family.partnerAdult). 둘만의 시간은 암시로만 쓰고(불을 껐다), 성범죄는 피해 신고와 지원으로만 나온다.
// 이 규칙은 표를 펼칠 때 검사해서, 어긋나면 바로 오류를 낸다.
//
// 술: 장면은 주인공이 이미 마셨다고 쓰지 않는다. 마시는 선택지는 substances.ts에 사용으로 남기고(fx.do),
// 같은 카드에 마시지 않는 선택지를 함께 둔다. 데이트에서 짝과 함께 마시는 선택지는 family.partnerAdult 아래에만
// 둔다: 썸 단계의 {상대}는 이름만 있는 사람이라 나이를 확인할 수 없다.

import type { Action, ChoiceDef, Effects, EventDef, NextRef, OutcomeDef, TagDef } from '../schema';
import type { Sex, Tone } from '../types';
import { conceivedIf, fecundity, STOP_AT_BIRTH, STOP_WHEN_TRYING, undecidedScareShare } from '../contraception';
import { josa } from '../format';
import { addFx, and, makeEvent, overlap, toEffects, type Fx } from './build';

/** 사건에 나오는 사람: 혼자(상대를 찾는 중), 연인, 배우자, 둘 중 누구든, 상관없음 */
type Who = 'single' | 'dating' | 'married' | 'couple' | 'any';

type Act = 'startPartner' | 'breakUp' | 'marry' | 'haveChild' | 'divorce' | 'addFriend' | 'leaveHome' | 'moveRegion';

/** 선택지 한 줄. check가 있으면 result가 성공, fail이 실패 결과다 */
interface Row {
  text: string;
  result: string;
  if?: string;
  fx?: Fx;
  /** 연인·배우자 친밀도 */
  close?: number;
  /** 부모 친밀도 */
  parents?: number;
  do?: Act[];
  /** 현금 비율 (-0.1 = 가진 현금의 10%를 쓴다) */
  pct?: number;
  next?: NextRef;
  /** 판정: ["sociability", 50] 또는 여러 능력치 평균 ["sociability,looks", 48] */
  check?: [string, number];
  fail?: string;
  failFx?: Fx;
  failClose?: number;
  failParents?: number;
  failDo?: Act[];
  failPct?: number;
  failNext?: NextRef;
  /** 데이트 장면: 이 단계에서만 보인다 / 이 단계에서는 빠진다 */
  only?: string[];
  not?: string[];
  /**
   * 데이트 장면: 단계별 한마디 뒤(맨 끝)에 붙인다. 나중에 더한 선택지라 앞 선택지의 번호가 그대로다
   * (진행 중이던 저장 카드의 선택이 다른 선택지로 바뀌지 않는다)
   */
  tail?: boolean;
  /**
   * 임신 결과가 걸린 선택지: next 가운데 임신 쪽 사건. 노출 때 엔진이 피임 방법으로 임신 여부를 정해 두었으면
   * (ctx.conceived) 그 결과를 따르고, 없으면 next의 가중치를 쓴다. 펼칠 때 셋으로 나누고 화면에는 하나만 보인다
   */
  pregnancy?: string;
  /**
   * 판정에 실패하면 피임 없이 노출된 한 번이다 (예: 콘돔이 찢어졌는데 넘어간다). failNext는 임신 걱정 카드여야 한다.
   * 펼칠 때 여성 나이 구간마다 선택지를 나누고, 걱정 카드와 바로 '한 줄' 카드 사이의 가중치를 그 나이의 가임력으로 정한다
   * (contraception.ts undecidedScareShare). 화면에는 구간 하나만 보인다
   */
  scareByAge?: boolean;
}

interface Phase {
  id: string;
  name: string;
  who: Who;
  age: [number, number];
  if?: string;
  /** 함께 있는 사람 자리표시자 ({상대}, {연인}, {배우자}, {짝}) */
  with: string;
  w?: number;
  /** 장소 선택지에 더하는 친밀도 */
  close?: number;
  /** 첫 문장. [장소]는 장소 이름으로 바뀐다 */
  opens: string[];
  /** 장소와 상관없이 이 단계에서 할 수 있는 말 (장소마다 하나씩 돌아가며 붙는다) */
  choices: Row[];
}

interface Place {
  id: string;
  /** 장소 이름 (확대 표시, [장소]) */
  name: string;
  title: string;
  phases: string[];
  age?: [number, number];
  if?: string;
  /** 2026년 원 기준 데이트 비용 (모든 선택지에 붙는다) */
  cost?: number;
  w?: number;
  /** false면 단계별 한마디를 붙이지 않는다 (장소 선택지만으로 충분할 때) */
  own?: boolean;
  /** 단계별 첫 문장을 이 장소에 맞게 바꿔 쓴다 */
  opens?: Record<string, string>;
  scene: string;
  choices: Row[];
}

interface Variant {
  key: string;
  who: Who;
  title?: string;
  zoom?: string;
  age: [number, number];
  sex?: Sex;
  if?: string;
  flags?: string[];
  notFlags?: string[];
  childAge?: [number, number];
  w?: number;
  ageCurve?: Record<string, number>;
  mods?: { if: string; x: number }[];
  tone?: Tone;
  impact?: number;
  text: string;
  choices: Row[];
}

interface Issue {
  id: string;
  name: string;
  tone?: Tone;
  variants: Variant[];
}

interface Anniversary {
  years: number;
  /** 기념식 이름 (지혼식, 은혼식 …) */
  name: string;
  meaning: string;
  scene: string;
  w?: number;
}

interface Hand {
  id: string;
  title: string;
  text: string;
  who: Who;
  age: [number, number];
  zoom?: string;
  sex?: Sex;
  if?: string;
  flags?: string[];
  notFlags?: string[];
  childAge?: [number, number];
  w?: number;
  ageCurve?: Record<string, number>;
  mods?: { if: string; x: number }[];
  group?: string;
  tone?: Tone;
  impact?: number;
  type?: 'chain';
  once?: boolean;
  cooldown?: number;
  /** 감옥·복무 중 제외 조건을 붙이지 않는다 (복무 중 사건, 엔진이 부르는 사건) */
  free?: boolean;
  motif?: string;
  fx?: Fx;
  choices?: Row[];
  /** 선택지 없는 카드를 넘긴 뒤 이어지는 사건 */
  next?: string;
}

export interface RomanceCatalog {
  tags?: TagDef[];
  phases: Phase[];
  places: Place[];
  issues: Issue[];
  anniversaries: { choices: Row[]; list: Anniversary[] };
  events: Hand[];
}

const POOL = 'romance' as const;

/** 누구와의 사건인가 → 기본 조건. 짝이 나오면 반드시 둘 다 성인 */
const WHO_IF: Record<Who, string | undefined> = {
  single: '!family.hasPartner && !family.married',
  dating: 'family.hasPartner && !family.married && family.partnerAdult',
  married: 'family.married && family.partnerAdult',
  couple: 'family.partnerAdult',
  any: undefined,
};

const WHO_ZOOM: Record<Who, string | undefined> = {
  single: undefined,
  dating: '연애 중',
  married: '결혼 생활',
  couple: undefined,
  any: undefined,
};

/** 감옥에 있거나 복무 중이면 일어나지 않는다 */
const AT_LARGE = '!legal.inPrison && !military.serving';

/** 관계가 끝나거나 바뀌면 정리하는 숨은 표시 */
const AFTER_BREAKUP = ['rom_engaged', 'rom_cohabiting', 'rom_gomsin', 'rom_long_distance', 'rom_wedding_talk'];
const AFTER_MARRY = ['rom_engaged', 'rom_cohabiting', 'rom_wedding_talk', 'rom_long_distance'];

// ── 조건식 줄임말 ─────────────────────────────────────────

/** 짝이 나보다 gap살 이상 어리다 (식에 뺄셈이 없어 5년 구간으로 나눠 쓴다) */
function youngerBy(gap: number): string {
  const parts: string[] = [];
  for (let lo = 19 + gap; lo <= 95; lo += 5) parts.push(`(age >= ${lo} && age <= ${lo + 4} && family.partnerAge <= ${lo - gap})`);
  return `(${parts.join(' || ')})`;
}

/** 짝이 나보다 gap살 이상 많다 */
function olderBy(gap: number): string {
  const parts: string[] = [];
  for (let lo = 19; lo <= 80; lo += 5) parts.push(`(age >= ${lo} && age <= ${lo + 4} && family.partnerAge >= ${lo + 4 + gap})`);
  return `(${parts.join(' || ')})`;
}

/** 여성 쪽 나이 (임신 가능성 판단용) */
const WOMAN_UNDER = (n: number) => `((sex == 'F' && age <= ${n}) || (sex == 'M' && family.partnerAge <= ${n}))`;

/** 여성 쪽 나이가 lo~hi (끝이 없으면 그쪽은 열려 있다) */
function womanAgeIn(lo: number | undefined, hi: number | undefined): string {
  const range = (v: string) => [lo !== undefined ? `${v} >= ${lo}` : '', hi !== undefined ? `${v} <= ${hi}` : ''].filter(Boolean).join(' && ');
  return `((sex == 'F' && ${range('age')}) || (sex == 'M' && ${range('family.partnerAge')}))`;
}

/**
 * 지금 술을 마시는 사람 (substances.ts: 올해 마셨거나 습관이 남았고, 끊는 중이 아니다).
 * '술부터 줄인다'처럼 마신다고 전제하는 선택지는 이 조건 아래에만 둔다 (검토 R-008)
 */
const DRINKING = '(substance.alcohol.current && !substance.alcohol.quitting)';

const MACROS: Record<string, string> = {
  '@연하5': youngerBy(5),
  '@연상5': olderBy(5),
  '@가임': WOMAN_UNDER(45),
  '@비가임': `!${WOMAN_UNDER(45)}`,
  '@음주중': DRINKING,
  '@비음주': `!${DRINKING}`,
};

function macro(expr: string | undefined): string | undefined {
  if (!expr) return expr;
  return expr.replace(/@[가-힣A-Za-z0-9]+/g, (m) => {
    const v = MACROS[m];
    if (!v) throw new Error(`romance.json: 모르는 줄임말 ${m}`);
    return v;
  });
}

// ── 선택지 ────────────────────────────────────────────────

function effectsOf(
  fx: Fx | undefined,
  close: number | undefined,
  parents: number | undefined,
  acts: Act[] | undefined,
  pct: number | undefined,
): Effects | undefined {
  let f = fx;
  // 이별·이혼은 이별 후유증을, 결혼은 예비부부 표시 정리를 함께 한다
  if (acts?.includes('breakUp')) f = addFx(f, { add: ['rom_heartbroken'], remove: AFTER_BREAKUP });
  if (acts?.includes('divorce')) f = addFx(f, { add: ['rom_heartbroken'] });
  if (acts?.includes('marry')) f = addFx(f, { remove: AFTER_MARRY });
  // 피임 (contraception.ts): 아이가 태어나면 피임약·장치 기록이 끝나고, 임신 준비를 고르면 되돌릴 수 있는 방법을 그만둔다.
  // 임신 준비가 끝나도 예전 방법이 저절로 돌아오지 않는다 (다시 쓰려면 다시 고른다)
  if (acts?.includes('haveChild')) f = addFx(f, { remove: [...STOP_AT_BIRTH] });
  if (f?.add?.includes('rom_trying')) f = addFx(f, { remove: [...STOP_WHEN_TRYING] });
  const out: Effects = toEffects(f) ?? {};
  if (pct) out.money = { ...(out.money ?? {}), cashPct: pct };
  // 행동이 먼저다: 사귀기 시작한 뒤에 친밀도가 붙고, 헤어진 뒤의 친밀도는 아무에게도 가지 않는다.
  // 표의 fx.do(술 마시기·거절 같은 엔진 행동)는 그 뒤에 그대로 붙인다 (친밀도가 있다고 지워지지 않는다)
  const list: Action[] = (acts ?? []).map((type) => ({ type }) as Action);
  if (close) list.push({ type: 'npcCloseness', role: 'partner', delta: close }, { type: 'npcCloseness', role: 'spouse', delta: close });
  if (parents) list.push({ type: 'npcCloseness', role: 'parents', delta: parents });
  if (list.length) out.do = [...list, ...(out.do ?? [])];
  return Object.keys(out).length ? out : undefined;
}

/**
 * 임신 결과가 걸린 선택지(row.pregnancy)를 셋으로 나눈다 (검토 R-013): 노출 때 임신이었다 → 임신 쪽 사건,
 * 아니었다 → 나머지 사건, 정해 둔 결과가 없다 → 원래 가중치. 확률은 contraception.ts가 피임 방법으로 정한다.
 * 원래 자리에는 '결과가 없을 때'의 선택지를 두고 결과별 선택지는 뒤에 붙인다: 옛 저장에 떠 있던 카드의
 * 선택지 번호가 예전과 같은 선택지(기본 가중치)를 가리킨다.
 */
function splitByConception(rows: Row[], where: string): Row[] {
  const decided: Row[] = [];
  const inPlace = rows.map((r) => {
    if (!r.pregnancy) return r;
    const next = r.next;
    const rest = Array.isArray(next) ? next.filter((n) => n.event !== r.pregnancy) : [];
    if (!Array.isArray(next) || rest.length === next.length || rest.length === 0) {
      throw new Error(`romance.json › ${where}: pregnancy(${r.pregnancy})는 next 가중치 목록의 한 사건이어야 한다`);
    }
    const base = { ...r, pregnancy: undefined };
    decided.push(
      { ...base, if: and(r.if, conceivedIf('yes')), next: r.pregnancy },
      { ...base, if: and(r.if, conceivedIf('no')), next: rest.length === 1 ? rest[0].event : rest },
    );
    return { ...base, if: and(r.if, conceivedIf('unknown')) };
  });
  return [...inPlace, ...decided];
}

/** 결과를 정하지 못한 노출이 이어지는 걱정 카드와, 걱정 없이 바로 이어지는 '한 줄' 카드 */
const SCARE_EVENT = 'rom_pregnancy_scare';
const NEGATIVE_EVENT = 'rom_pregnancy_negative';

/**
 * scareByAge 선택지의 여성 나이 구간. 구간의 가임력은 그 안 나이(19~45세)의 평균이다.
 * 45세를 넘으면 걱정 카드가 '임신 아님' 선택지만 보여 주므로 마지막 구간이 끝이다.
 */
const SCARE_AGE_BANDS: [number | undefined, number | undefined][] = [
  [undefined, 30],
  [31, 35],
  [36, 39],
  [40, 42],
  [43, undefined],
];

/** 구간 평균 가임력 */
function bandFecundity(lo = 19, hi = 45): number {
  let sum = 0;
  for (let a = lo; a <= hi; a++) sum += fecundity(a);
  return sum / (hi - lo + 1);
}

/**
 * 판정에 실패하면 피임 없이 노출되는 선택지(row.scareByAge)를 여성 나이 구간별로 나눈다 (검토 R-013 후속).
 * 실패하면 걱정 카드로 갈 몫 = undecidedScareShare(구간 가임력), 나머지는 바로 '한 줄' 카드다. 걱정 카드는 결과가
 * 정해지지 않은 문맥이라 기본 35%로 두 줄이 나오므로, 늦어진 날짜 중 실제 임신의 비율이 활동 경로의 걱정 카드와 같다.
 * 첫 구간은 원래 자리에 두고 나머지는 뒤에 붙인다 (옛 저장에 떠 있던 카드의 선택지 번호가 그대로다).
 */
function splitByAge(rows: Row[], where: string): Row[] {
  const extra: Row[] = [];
  const inPlace = rows.map((r) => {
    if (!r.scareByAge) return r;
    if (!r.check || r.failNext !== SCARE_EVENT) {
      throw new Error(`romance.json › ${where}: scareByAge 선택지는 판정이 있고 failNext가 ${SCARE_EVENT}여야 한다`);
    }
    const bands = SCARE_AGE_BANDS.map(([lo, hi]): Row => {
      const share = Math.round(undecidedScareShare(bandFecundity(lo, hi)) * 1000);
      const failNext: NextRef = share >= 1000 ? SCARE_EVENT : [{ event: SCARE_EVENT, w: share }, { event: NEGATIVE_EVENT, w: 1000 - share }];
      return { ...r, scareByAge: undefined, if: and(r.if, womanAgeIn(lo, hi)), failNext };
    });
    extra.push(...bands.slice(1));
    return bands[0];
  });
  return [...inPlace, ...extra];
}

function outcome(text: string, fx: Effects | undefined, next: NextRef | undefined): OutcomeDef {
  const o: OutcomeDef = { text };
  if (fx) o.effects = fx;
  if (next) o.next = next;
  return o;
}

/**
 * extra: 데이트 장소 선택지에 붙는 비용과 단계 친밀도. 판정에 실패해도 같이 보낸 시간이라 둘 다 붙는다
 * (단계별 한마디처럼 관계가 걸린 선택지에는 extra.close를 넘기지 않는다).
 */
function toChoice(r: Row, extra: { fx?: Fx; close?: number } = {}): ChoiceDef {
  const ok = effectsOf(addFx(r.fx, extra.fx), (r.close ?? 0) + (extra.close ?? 0), r.parents, r.do, r.pct);
  const base: ChoiceDef = { text: r.text, ...(r.if ? { if: macro(r.if) } : {}) };
  if (r.check) {
    const [key, dc] = r.check;
    const keys = key.split(',').map((k) => k.trim());
    const bad = effectsOf(addFx(r.failFx, extra.fx), (r.failClose ?? 0) + (extra.close ?? 0), r.failParents, r.failDo, r.failPct);
    return {
      ...base,
      check: keys.length > 1 ? { stats: keys, dc } : { stat: keys[0], dc },
      onSuccess: outcome(r.result, ok, r.next),
      onFail: outcome(r.fail ?? r.result, bad, r.failNext),
    };
  }
  return { ...base, result: r.result, ...(ok ? { effects: ok } : {}), ...(r.next ? { next: r.next } : {}) };
}

// ── 문장 채우기 ───────────────────────────────────────────

/** [장소]·[기념식] 같은 자리와 뒤에 붙은 조사를 채운다. 런타임 자리표시자({연인} 등)는 그대로 둔다 */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\[([^\]]+)\](이\/가|을\/를|은\/는|과\/와|와\/과|으로\/로|로\/으로|이라\/라)?/g, (m, key: string, pair?: string) => {
    const v = vars[key];
    if (v === undefined) return m;
    return pair ? josa(v, pair) : v;
  });
}

/** 데이트 장면의 {with}를 함께 있는 사람 자리표시자로 */
function withWho(r: Row, who: string, vars: Record<string, string>): Row {
  const sw = (s: string | undefined) => (s === undefined ? s : fill(s.replaceAll('{with}', who), vars));
  return { ...r, text: sw(r.text)!, result: sw(r.result)!, fail: sw(r.fail) };
}

// ── 규칙 검사 ─────────────────────────────────────────────

const PARTNER_MARK = /\{(짝|연인|배우자)\}/;
const PARTNER_ACTS = new Set(['breakUp', 'marry', 'haveChild', 'divorce']);

/** 짝이 나오는 사건은 이 셋 중 하나여야 한다. 셋 다 기본 조건에 family.partnerAdult가 &&로 붙는다 */
const WITH_PARTNER = new Set<Who>(['dating', 'married', 'couple']);

function guard(who: Who, ev: EventDef): EventDef {
  const where = `romance.json › ${ev.id}`;
  if (!ev.id.startsWith('rom_')) throw new Error(`${where}: id는 rom_으로 시작해야 한다`);
  if (!ev.adult || !ev.trigger?.age || ev.trigger.age[0] < 19) throw new Error(`${where}: 성인 전용(만 19세 이상)이어야 한다`);
  const body = JSON.stringify(ev);
  const acts = [...body.matchAll(/"type":"([a-zA-Z]+)"/g)].map((m) => m[1]);
  const partnered = PARTNER_MARK.test(body) || acts.some((a) => PARTNER_ACTS.has(a));
  if (partnered && !WITH_PARTNER.has(who)) {
    throw new Error(`${where}: 짝이 나오는 사건은 who가 dating·married·couple이어야 한다 (둘 다 성인 조건)`);
  }
  if (/\{with\}|\[[^\]]+\]/.test(ev.text + ev.title)) throw new Error(`${where}: 채우지 못한 자리가 남았다`);
  return ev;
}

function baseIf(who: Who, free: boolean | undefined, ...more: (string | undefined)[]): string | undefined {
  return and(WHO_IF[who], free ? undefined : AT_LARGE, ...more.map(macro));
}

// ── 펼치기 ────────────────────────────────────────────────

export function expandRomance(data: RomanceCatalog): EventDef[] {
  const out: EventDef[] = [];
  const phases = new Map(data.phases.map((p) => [p.id, p]));

  // 1. 데이트: 장소 × 관계 단계
  data.places.forEach((place, pi) => {
    for (const id of place.phases) {
      const ph = phases.get(id);
      if (!ph) throw new Error(`romance.json › ${place.id}: 없는 단계 ${id}`);
      const age = overlap(ph.age, place.age);
      if (!age) continue;
      const k = pi + data.phases.indexOf(ph);
      const vars = { 장소: place.name };
      const rows = place.choices
        .filter((r) => (!r.only || r.only.includes(ph.id)) && !r.not?.includes(ph.id))
        .map((r) => withWho(r, ph.with, vars));
      const cost: Fx | undefined = place.cost ? { cost: place.cost } : undefined;
      const placeChoice = (r: Row) => toChoice(r, { fx: cost, close: ph.close });
      const choices = rows.filter((r) => !r.tail).map(placeChoice);
      if (place.own !== false) choices.push(toChoice(withWho(ph.choices[k % ph.choices.length], ph.with, vars), { fx: cost }));
      choices.push(...rows.filter((r) => r.tail).map(placeChoice));
      const open = fill(place.opens?.[ph.id] ?? ph.opens[k % ph.opens.length], vars);
      out.push(
        guard(
          ph.who,
          makeEvent({
            id: `rom_date_${place.id}_${ph.id}`,
            pool: POOL,
            adult: true,
            title: place.title,
            zoom: `${place.name} · ${ph.name}`,
            text: `${open} ${fill(place.scene.replaceAll('{with}', ph.with), vars)}`,
            tone: 'positive',
            impact: 4,
            age,
            if: baseIf(ph.who, false, ph.if, place.if),
            w: (place.w ?? 0.5) * (ph.w ?? 1),
            group: `rom_date_${place.id}`,
            choices,
          }),
        ),
      );
    }
  });

  // 2. 관계 문제: 문제마다 연애 중·결혼 생활 장면
  for (const issue of data.issues) {
    for (const v of issue.variants) {
      out.push(
        guard(
          v.who,
          makeEvent({
            id: `rom_issue_${issue.id}_${v.key}`,
            pool: POOL,
            adult: true,
            title: v.title ?? issue.name,
            zoom: v.zoom ?? WHO_ZOOM[v.who],
            text: v.text,
            tone: v.tone ?? issue.tone ?? 'drama',
            impact: v.impact ?? 8,
            age: v.age,
            sex: v.sex,
            if: baseIf(v.who, false, v.if),
            flags: v.flags,
            notFlags: v.notFlags,
            childAge: v.childAge,
            w: v.w ?? 0.4,
            ageCurve: v.ageCurve,
            modifiers: v.mods?.map((m) => ({ if: macro(m.if)!, x: m.x })),
            group: `rom_issue_${issue.id}`,
            choices: v.choices.map((r) => toChoice(r)),
          }),
        ),
      );
    }
  }

  // 3. 결혼기념일: 해마다 이름이 다르다 (지혼식, 석혼식, 은혼식, 금혼식 …)
  for (const a of data.anniversaries.list) {
    const vars = { 기념식: a.name };
    out.push(
      guard(
        'married',
        makeEvent({
          id: `rom_anniv_${a.years}`,
          pool: POOL,
          adult: true,
          title: `결혼 ${a.years}주년`,
          zoom: a.name,
          text: `결혼 ${a.years}주년. ${josa(a.name, '은/는')} ${a.meaning} ${a.scene}`,
          tone: 'positive',
          impact: a.years >= 25 ? 10 : 6,
          age: [19 + a.years, 120],
          if: baseIf('married', false, `family.marriedYears == ${a.years}`),
          w: a.w ?? 1,
          group: 'rom_anniv',
          choices: data.anniversaries.choices.map((r) => toChoice({ ...r, text: fill(r.text, vars), result: fill(r.result, vars) })),
        }),
      ),
    );
  }

  // 4. 손으로 쓴 사건
  for (const e of data.events) {
    out.push(
      guard(
        e.who,
        makeEvent({
          id: e.id,
          pool: POOL,
          adult: true,
          type: e.type,
          title: e.title,
          zoom: e.zoom,
          motif: e.motif,
          text: e.text,
          tone: e.tone ?? 'neutral',
          impact: e.impact ?? 6,
          age: e.age,
          sex: e.sex,
          if: baseIf(e.who, e.free, e.if),
          flags: e.flags,
          notFlags: e.notFlags,
          childAge: e.childAge,
          w: e.w ?? 0.5,
          ageCurve: e.ageCurve,
          modifiers: e.mods?.map((m) => ({ if: macro(m.if)!, x: m.x })),
          once: e.once,
          cooldown: e.cooldown,
          group: e.group,
          effects: toEffects(e.fx),
          choices: e.choices && splitByAge(splitByConception(e.choices, e.id), e.id).map((r) => toChoice(r)),
          next: e.next,
        }),
      ),
    );
  }

  return out;
}
