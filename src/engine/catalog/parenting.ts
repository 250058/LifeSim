// 육아: 아이가 태어나 어른이 되고, 손주를 안을 때까지 부모 쪽에서 본 장면들.
//
//   scenes             손으로 쓴 장면. stage(자녀 나이대 이름)나 childAge로 언제 나올지 정한다
//   places × incidents 외출 장면. 장소와 아이가 벌이는 일의 tags가 하나라도 겹치면 한 장면이 된다
//
// 문장 속 [엄마|아빠]처럼 대괄호로 쓴 부분은 플레이어 성별(여|남)에 맞춰 고른다.
// 성별을 정하지 않은 장면에 대괄호가 있으면 여자용·남자용 사건 두 개로 나눈다.
// 선택지의 close·spouse·parents는 자녀·배우자·내 부모와의 친밀도 변화다.
//
// 술·담배: 내가 마시는 선택지는 do의 substance 행동으로 substances.ts에 남기고, 같은 장면에 마시지 않는
// 선택지를 함께 둔다 (마시지 않는 선택지의 결과가 마셨다고 쓰지 않는다). 자녀와 함께 마시는 장면은 자녀가
// 만 19세 이상인 나이대(childAge)에만 쓴다.

import type { Action, ChoiceDef, Effects, EventDef, TagDef } from '../schema';
import type { Sex, Tone } from '../types';
import { josa } from '../format';
import { and, choice, makeEvent, overlap, type ChoiceRow, type Fx } from './build';

interface Row extends ChoiceRow {
  /** 자녀와의 친밀도 (판정이 있으면 성공했을 때) */
  close?: number;
  /** 판정에 실패했을 때 자녀와의 친밀도 */
  failClose?: number;
  /** 배우자와의 친밀도 */
  spouse?: number;
  /** 내 부모와의 친밀도 (아이를 봐 주는 할머니·할아버지) */
  parents?: number;
  /** 그 밖의 행동 (퇴사, 이사 등) */
  do?: Action[];
}

interface Scene {
  id: string;
  /** stages의 이름. childAge를 따로 쓰면 그쪽이 앞선다 */
  stage?: string;
  childAge?: [number, number];
  group: string;
  title: string;
  zoom?: string;
  text: string;
  choices: Row[];
  w?: number;
  tone?: Tone;
  impact?: number;
  /** 플레이어(부모) 나이 */
  age?: [number, number];
  sex?: Sex;
  if?: string;
  flags?: string[];
  notFlags?: string[];
  modifiers?: { if: string; x: number }[];
  once?: boolean;
  cooldown?: number;
  motif?: string;
  /** chain이면 다른 장면의 next·later로만 나온다 */
  type?: 'chain';
  /** false면 공통 조건(수감·복무 중 제외)을 붙이지 않는다. 교도소 접견 같은 장면 */
  base?: boolean;
}

interface Place {
  id: string;
  name: string;
  tags: string[];
  childAge?: [number, number];
  if?: string;
  lead: string;
  /** 아이가 소란을 피울 때 주변 반응 */
  stare?: string;
  /** 이 장소에서만 고를 수 있는 선택지 */
  exit?: Row;
  fx?: Fx;
}

interface Incident {
  id: string;
  name: string;
  tags: string[];
  childAge: [number, number];
  /** 이 일이 어느 장소에서든 일어날 가중치의 합 */
  w?: number;
  /** 소란스러워서 주변이 쳐다보는가 */
  loud?: boolean;
  only?: string[];
  not?: string[];
  tone?: Tone;
  scene: string;
  choices: Row[];
}

export interface ParentingCatalog {
  tags?: TagDef[];
  /** 자녀 나이대 이름 → [최소, 최대] */
  stages: Record<string, [number, number]>;
  scenes: Scene[];
  places: Place[];
  incidents: Incident[];
  /**
   * 아들 전용 장면(입영·면회·전역). 엔진이 {자녀}를 성별로 고르지 못해 지금은 펼치지 않는다.
   * trigger에 자녀 성별 조건이 생기면 scenes처럼 펼치고 그 조건을 붙인다.
   */
  sonOnly?: Scene[];
}

/** 모든 육아 장면의 공통 조건: 수감·복무 중에는 아이 곁에 없다 */
const BASE_IF = '!legal.inPrison && !military.serving';

/** 부모 나이를 따로 정하지 않으면 자녀보다 적어도 18살은 많다 */
function parentAge(childAge: [number, number], age?: [number, number]): [number, number] {
  return age ?? [18 + childAge[0], 120];
}

const SEX_MARK = /\[([^[\]|]*)\|([^[\]|]*)\]/g;

function hasMark(s: Scene): boolean {
  const texts = [s.title, s.zoom ?? '', s.text, ...s.choices.flatMap((c) => [c.text, c.result, c.fail ?? ''])];
  return texts.some((t) => new RegExp(SEX_MARK.source).test(t));
}

/** [여|남] 표기를 성별에 맞게 푼다 */
function bySex(text: string, sex: Sex | undefined): string {
  return text.replace(SEX_MARK, (_m, f: string, m: string) => (sex === 'M' ? m : f));
}

function withDo(fx: Effects | undefined, actions: Action[]): Effects | undefined {
  if (actions.length === 0) return fx;
  return { ...(fx ?? {}), do: [...(fx?.do ?? []), ...actions] };
}

function bond(role: 'child' | 'spouse' | 'parents', delta: number | undefined): Action[] {
  return delta ? [{ type: 'npcCloseness', role, delta }] : [];
}

function row(r: Row, sex: Sex | undefined, extraResult = '', extraFx?: Fx): ChoiceDef {
  const c = choice(
    { ...r, text: bySex(r.text, sex), result: bySex(r.result, sex), fail: r.fail === undefined ? undefined : bySex(r.fail, sex) },
    extraResult,
    extraFx,
  );
  const always = [...bond('spouse', r.spouse), ...bond('parents', r.parents), ...(r.do ?? [])];
  if (c.check) {
    if (c.onSuccess) c.onSuccess.effects = withDo(c.onSuccess.effects, bond('child', r.close));
    if (c.onFail) c.onFail.effects = withDo(c.onFail.effects, bond('child', r.failClose));
    if (always.length) c.effects = withDo(c.effects, always);
    return c;
  }
  const effects = withDo(c.effects, [...bond('child', r.close), ...always]);
  return effects ? { ...c, effects } : c;
}

function sceneEvents(s: Scene, stages: Record<string, [number, number]>): EventDef[] {
  const childAge = s.childAge ?? (s.stage ? stages[s.stage] : undefined);
  if (!childAge) throw new Error(`육아 장면 ${s.id}: 자녀 나이대(stage·childAge)가 없다`);
  const variants: (Sex | undefined)[] = s.sex ? [s.sex] : hasMark(s) ? ['F', 'M'] : [undefined];
  return variants.map((sex) =>
    makeEvent({
      id: variants.length > 1 ? `par_${s.id}_${sex === 'F' ? 'f' : 'm'}` : `par_${s.id}`,
      pool: 'parenting',
      type: s.type === 'chain' ? 'chain' : 'random',
      title: bySex(s.title, sex),
      zoom: s.zoom === undefined ? undefined : bySex(s.zoom, sex),
      text: bySex(s.text, sex),
      tone: s.tone,
      impact: s.impact ?? 4,
      age: parentAge(childAge, s.age),
      sex,
      if: and(s.base === false ? undefined : BASE_IF, s.if),
      flags: s.flags,
      notFlags: s.notFlags,
      childAge,
      w: s.w ?? 0.5,
      modifiers: s.modifiers,
      once: s.once,
      cooldown: s.cooldown,
      group: `par_${s.group}`,
      motif: s.motif,
      choices: s.choices.map((r) => row(r, sex)),
    }),
  );
}

function fits(i: Incident, p: Place): boolean {
  if (i.only) return i.only.includes(p.id);
  if (i.not?.includes(p.id)) return false;
  return i.tags.some((t) => p.tags.includes(t));
}

function outingEvents(data: ParentingCatalog): EventDef[] {
  const out: EventDef[] = [];
  for (const inc of data.incidents) {
    const places = data.places
      .map((p) => ({ p, childAge: overlap(inc.childAge, p.childAge) }))
      .filter((x): x is { p: Place; childAge: [number, number] } => fits(inc, x.p) && x.childAge !== null);
    for (const { p, childAge } of places) {
      const choices = inc.choices.map((r) => row(r, undefined, '', p.fx));
      if (p.exit) {
        choices.push(row({ ...p.exit, text: p.exit.text.replace('{장소}', josa(p.name, '을/를')) }, undefined));
      }
      out.push(
        makeEvent({
          id: `par_out_${inc.id}_${p.id}`,
          pool: 'parenting',
          title: inc.name,
          zoom: p.name,
          text: [p.lead, inc.scene, inc.loud ? p.stare : undefined].filter(Boolean).join(' '),
          tone: inc.tone,
          impact: 3,
          age: parentAge(childAge),
          if: and(BASE_IF, p.if),
          childAge,
          // 한 가지 일이 어느 장소에서 벌어지든 합쳐서 inc.w만큼만 뽑히게 나눈다
          w: (inc.w ?? 0.5) / places.length,
          group: `par_out_${inc.id}`,
          choices,
        }),
      );
    }
  }
  return out;
}

export function expandParenting(data: ParentingCatalog): EventDef[] {
  const stages = data.stages ?? {};
  return [...(data.scenes ?? []).flatMap((s) => sceneEvents(s, stages)), ...(data.places && data.incidents ? outingEvents(data) : [])];
}
