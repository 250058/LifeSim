// 영양분 섭취 (밥상 풀). data/catalog/nutrition.json 의 표를 사건으로 펼친다.
//
//   1. 음식(foods) × 먹는 상황(situations): 음식의 tags와 상황의 tags가 하나라도 겹치면 한 장면 (only·not으로 좁힌다).
//      본문 = 상황 장면(<F> 자리에 음식 이름) + 음식의 영양 정보 한 줄. 선택지는 음식 것 + 상황의 exit.
//      값은 상황의 pay 배수를 받는다 (급식·회식·명절처럼 남이 내면 0).
//   2. 영양소(nutrients): 생애 단계별 결핍·과잉 장면. 선택지를 안 쓰면 영양소의 low/high 기본 선택지를 쓴다.
//   3. 영양제(supplements) × 권유 상황(supplementSituations): <S> 자리에 영양제 이름.
//   4. 손으로 쓴 장면(scenes): 식단, 식품 안전·알레르기, 생애 단계, 마음(섭식장애), 밥상 문화.
//   follow는 다른 사건이 later로 부르는 뒷이야기 (추첨되지 않는다).

import type { EventDef, TagDef } from '../schema';
import type { Sex, Tone } from '../types';
import { josa } from '../format';
import { and, choice, makeEvent, overlap, type ChoiceRow, type Fx } from './build';

type Modifier = { if: string; x: number };
/** 표의 선택지. fixed면 상황의 값 배수를 받지 않는다 */
type Row = ChoiceRow & { fixed?: boolean };

interface Situation {
  id: string;
  name: string;
  tags: string[];
  age?: [number, number];
  if?: string;
  /** 이 나이대 자녀가 있어야 한다 ({자녀}도 이 나이대에서 고른다) */
  childAge?: [number, number];
  /** 음식이 놓인 장면. <F>는 음식 이름이고, 바로 뒤에 '이/가' 같은 조사 짝을 붙이면 받침에 맞춘다 */
  lead: string;
  /** 마실 것일 때의 장면 (없으면 lead) */
  drink?: string;
  /** 값을 치르는 배수. 0이면 남이 낸다 (급식·회식·명절), 2면 두 사람 몫 */
  pay?: number;
  fx?: Fx;
  exit?: Row;
  w?: number;
  modifiers?: Modifier[];
}

interface Food {
  id: string;
  name: string;
  title?: string;
  drink?: boolean;
  tags: string[];
  age?: [number, number];
  if?: string;
  notFlags?: string[];
  only?: string[];
  not?: string[];
  w?: number;
  modifiers?: Modifier[];
  /** 영양 정보 문장. 여러 개면 상황마다 돌아가며 쓴다 */
  lines: string[];
  choices: Row[];
}

interface NutrientScene {
  id: string;
  age: [number, number];
  sex?: Sex;
  if?: string;
  flags?: string[];
  notFlags?: string[];
  childAge?: [number, number];
  /** 기본 선택지 묶음: low(결핍), high(과잉) */
  kind?: 'low' | 'high';
  title: string;
  zoom?: string;
  text: string;
  tone?: Tone;
  choices?: ChoiceRow[];
  w?: number;
  modifiers?: Modifier[];
}

interface Nutrient {
  id: string;
  name: string;
  low?: ChoiceRow[];
  high?: ChoiceRow[];
  scenes: NutrientScene[];
}

interface SupplementSituation {
  id: string;
  name: string;
  age?: [number, number];
  if?: string;
  /** <S>는 영양제 이름 */
  lead: string;
  /** 값 배수 (홈쇼핑 묶음 판매는 3) */
  pay?: number;
  fx?: Fx;
  exit?: Row;
  w?: number;
}

interface Supplement {
  id: string;
  name: string;
  title?: string;
  /** 어울리는 권유 상황 id */
  only: string[];
  age?: [number, number];
  sex?: Sex;
  if?: string;
  notFlags?: string[];
  /** 자녀 몫으로 사는 영양제 */
  childAge?: [number, number];
  w?: number;
  modifiers?: Modifier[];
  lines: string[];
  choices: Row[];
}

interface Scene {
  id: string;
  group?: string;
  age: [number, number];
  sex?: Sex;
  if?: string;
  flags?: string[];
  notFlags?: string[];
  childAge?: [number, number];
  title: string;
  zoom?: string;
  text: string;
  tone?: Tone;
  impact?: number;
  w?: number;
  ageCurve?: Record<string, number>;
  modifiers?: Modifier[];
  once?: boolean;
  cooldown?: number;
  choices: ChoiceRow[];
}

export interface NutritionCatalog {
  tags?: TagDef[];
  situations: Situation[];
  foods: Food[];
  nutrients: Nutrient[];
  supplementSituations: SupplementSituation[];
  supplements: Supplement[];
  /** 묶음 이름(diet, safety, life, mind, culture) → 장면 */
  scenes: Record<string, Scene[]>;
  /** later로만 불리는 뒷이야기 */
  follow?: Scene[];
}

/** 묶음별 기본 가중치 (풀 안에서 음식 장면이 다른 장면을 덮지 않게) */
const SECTION_W: Record<string, number> = { diet: 1, safety: 0.6, life: 0.7, mind: 0.5, culture: 0.8 };
const FOOD_W = 0.45;
const NUTRIENT_W = 0.8;
const SUPPLEMENT_W = 0.45;

const SLOT = /<([FS])>(이\/가|을\/를|은\/는|과\/와|와\/과|이랑\/랑|으로\/로|로\/으로|이나\/나|이라\/라|이라고\/라고|이에요\/예요)?/g;

/** <F>·<S> 자리에 이름을 넣고 조사를 받침에 맞춘다 */
function fill(template: string, name: string): string {
  return template.replace(SLOT, (_m, _k: string, pair?: string) => (pair ? josa(name, pair) : name));
}

/** 같은 입력이면 늘 같은 수 (문장 변형 고르기) */
function pickIndex(key: string, n: number): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return n > 0 ? h % n : 0;
}

/** 값을 배수만큼 (100원 단위). 0이면 값을 지운다 */
function scaleCost(fx: Fx | undefined, mul: number): Fx | undefined {
  if (!fx?.cost) return fx;
  const out: Fx = { ...fx };
  const cost = Math.round((fx.cost * mul) / 100) * 100;
  if (cost > 0) out.cost = cost;
  else delete out.cost;
  return out;
}

/** fixed인 선택지(병원 가기, 장보기처럼 그 자리에서 사는 게 아닌 것)는 배수를 받지 않는다. 남이 내는 자리(0)만 예외 */
function scaleRow(row: Row, mul: number): ChoiceRow {
  if (mul === 1 || (row.fixed && mul > 0)) return row;
  return { ...row, fx: scaleCost(row.fx, mul), failFx: scaleCost(row.failFx, mul) };
}

/**
 * 보정 배수를 모두 받아도 가중치가 1.5를 넘지 않게 뒤쪽 보정부터 덜어 낸다
 * (검증기의 확률 상한 경고와 같은 기준)
 */
function capModifiers(base: number, mods: Modifier[]): Modifier[] {
  const out: Modifier[] = [];
  let max = base;
  for (const m of mods) {
    if (m.x > 1 && max * m.x > 1.5) continue;
    if (m.x > 1) max *= m.x;
    out.push(m);
  }
  return out;
}

function fits(f: Food, s: Situation): boolean {
  if (f.only) return f.only.includes(s.id);
  if (f.not?.includes(s.id)) return false;
  return f.tags.some((t) => s.tags.includes(t));
}

function expandFoods(data: NutritionCatalog, out: EventDef[]): void {
  for (const f of data.foods) {
    for (const s of data.situations) {
      if (!fits(f, s)) continue;
      const age = overlap(f.age, s.age);
      if (!age) continue;
      // 용돈이 없는 일곱 살 전부터 열리는 장면은 보호자가 낸다
      const pay = age[0] < 7 ? 0 : (s.pay ?? 1);
      const line = f.lines[pickIndex(s.id, f.lines.length)];
      const lead = fill(f.drink && s.drink ? s.drink : s.lead, f.name);
      const rows = f.choices.map((r) => scaleRow(r, pay));
      const choices = rows.map((r) => choice(r, '', s.fx));
      if (s.exit && choices.filter((c) => !c.if).length < 4) choices.push(choice(scaleRow(s.exit, pay)));
      const base = (f.w ?? FOOD_W) * (s.w ?? 1);
      out.push(
        makeEvent({
          id: `nut_food_${f.id}_${s.id}`,
          pool: 'nutrition',
          title: f.title ?? f.name,
          zoom: s.name,
          text: `${lead} ${fill(line, f.name)}`,
          age,
          if: and(s.if, f.if),
          notFlags: f.notFlags,
          childAge: s.childAge,
          w: base,
          modifiers: capModifiers(Math.min(1, base), [...(f.modifiers ?? []), ...(s.modifiers ?? [])]),
          group: `nut_food_${f.id}`,
          impact: 3,
          choices,
        }),
      );
    }
  }
}

function expandNutrients(data: NutritionCatalog, out: EventDef[]): void {
  for (const n of data.nutrients) {
    for (const sc of n.scenes) {
      const rows = sc.choices ?? (sc.kind === 'high' ? n.high : n.low) ?? [];
      const base = sc.w ?? NUTRIENT_W;
      out.push(
        makeEvent({
          id: `nut_${n.id}_${sc.id}`,
          pool: 'nutrition',
          title: sc.title,
          zoom: sc.zoom,
          text: sc.text,
          tone: sc.tone,
          age: sc.age,
          sex: sc.sex,
          if: sc.if,
          flags: sc.flags,
          notFlags: sc.notFlags,
          childAge: sc.childAge,
          w: base,
          modifiers: capModifiers(base, sc.modifiers ?? []),
          group: `nut_${n.id}`,
          impact: 5,
          choices: rows.map((r) => choice(r)),
        }),
      );
    }
  }
}

function expandSupplements(data: NutritionCatalog, out: EventDef[]): void {
  const byId = new Map(data.supplementSituations.map((s) => [s.id, s]));
  for (const p of data.supplements) {
    for (const sid of p.only) {
      const s = byId.get(sid);
      if (!s) continue;
      const age = overlap(p.age, s.age);
      if (!age) continue;
      const pay = s.pay ?? 1;
      const line = p.lines[pickIndex(s.id, p.lines.length)];
      const choices = p.choices.map((r) => choice(scaleRow(r, pay), '', s.fx));
      if (s.exit && choices.filter((c) => !c.if).length < 4) choices.push(choice(s.exit));
      const base = (p.w ?? SUPPLEMENT_W) * (s.w ?? 1);
      out.push(
        makeEvent({
          id: `nut_supp_${p.id}_${s.id}`,
          pool: 'nutrition',
          title: p.title ?? p.name,
          zoom: s.name,
          text: `${fill(s.lead, p.name)} ${fill(line, p.name)}`,
          age,
          sex: p.sex,
          if: and(s.if, p.if),
          notFlags: p.notFlags,
          childAge: p.childAge,
          w: base,
          modifiers: capModifiers(Math.min(1, base), p.modifiers ?? []),
          group: `nut_supp_${p.id}`,
          impact: 4,
          choices,
        }),
      );
    }
  }
}

function sceneEvent(section: string, sc: Scene, type: EventDef['type'] = 'random'): EventDef {
  const base = sc.w ?? SECTION_W[section] ?? 0.5;
  return makeEvent({
    id: `nut_${section}_${sc.id}`,
    type,
    pool: 'nutrition',
    title: sc.title,
    zoom: sc.zoom,
    text: sc.text,
    tone: sc.tone,
    age: sc.age,
    sex: sc.sex,
    if: sc.if,
    flags: sc.flags,
    notFlags: sc.notFlags,
    childAge: sc.childAge,
    w: base,
    ageCurve: sc.ageCurve,
    modifiers: capModifiers(base, sc.modifiers ?? []),
    once: sc.once,
    cooldown: sc.cooldown,
    group: `nut_${section}_${sc.group ?? sc.id}`,
    impact: sc.impact ?? 5,
    choices: sc.choices.map((r) => choice(r)),
  });
}

export function expandNutrition(data: NutritionCatalog): EventDef[] {
  const out: EventDef[] = [];
  expandFoods(data, out);
  expandNutrients(data, out);
  expandSupplements(data, out);
  for (const [section, scenes] of Object.entries(data.scenes ?? {})) {
    for (const sc of scenes) out.push(sceneEvent(section, sc));
  }
  for (const sc of data.follow ?? []) out.push(sceneEvent('follow', sc, 'chain'));
  return out;
}
