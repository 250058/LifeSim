// 의료 사건사고 (병원 풀): data/catalog/medical.json 의 표를 사건으로 펼친다.
//
//   conditions  병 하나 = 증상(무작위) → 진단(연속) → 참으면 이듬해 악화(연속).
//               who로 환자를 바꾼다: 나(기본)·자녀(childAge)·부모·배우자
//   chronic     만성 질환 태그가 붙은 사람에게 오는 관리 장면(care)과, 잘 관리하던 사람의 고비(slip)
//   injuries    상황 × 다친 곳. 둘의 tags가 하나라도 겹치면 한 장면 (only·not으로 좁힌다)
//   incidents   의료 제도 속 사건(오진, 응급실 뺑뺑이, 간병비…) × 환자 변형
//   checkups    검진 장소 × 검진 소견 (그해 건강검진을 받았으면 더 잘 나온다)
//   outbreaks   장소 × 유행 감염병
//   events      한 장씩 쓴 사건 (마음 건강 위기, 성 건강, 보험·백신 같은 제도 이야기)
//
// 표 쓰는 법
// - 선택지의 next: 'dx'처럼 짧게 쓰면 같은 묶음의 연속 사건 id(med_<묶음>_dx)가 된다. med_로 시작하면 그대로 쓴다.
// - worse: n 은 n년 뒤 같은 묶음의 악화 장면(worse)을 예약한다. 판정이 있는 선택지면 실패했을 때만.
// - 문장의 [환자]는 환자 변형마다 나·{부모}·{자녀}·{배우자}로 바뀐다 ([환자]이/가 → 내가 / {부모}이/가).
//   남이 환자인 장면의 health는 내 건강이 아니다. 부모면 부모의 건강(parentHealth)으로 옮기고, 배우자·자녀면 뺀다.
// - 감염병 선택지의 [병원]은 장소마다 가는 곳(의무대, 현지 병원…)으로 바뀐다.
// - 미성년자는 병원비를 내지 않는다. 돈이 오가는 선택지는 만 19세 이상용과 미만용(보호자가 낸다)으로 나뉜다.
// - 장소를 따로 정하지 않은 사건은 수감 중이거나 복무 중인 사람에게 나오지 않는다 (where: military·prison·any).

import type { Action, ChoiceDef, Effects, EventDef, TagDef } from '../schema';
import type { Sex, Tone } from '../types';
import { josa } from '../format';
import { addFx, and, choice, makeEvent, overlap, type ChoiceRow, type Fx } from './build';

type Who = 'self' | 'parent' | 'child' | 'spouse';
type Where = 'civil' | 'military' | 'prison' | 'any';

/** 표에 쓰는 선택지 */
interface Row extends ChoiceRow {
  /** n년 뒤 같은 묶음의 악화 장면 (판정이 있으면 실패했을 때만) */
  worse?: number;
  /** 성공(또는 판정 없음)일 때의 행동 */
  do?: Action[];
  /** 판정 실패일 때의 행동 */
  failDo?: Action[];
}

/** 카드 한 장 */
interface Scene {
  title: string;
  zoom?: string;
  text: string;
  tone?: Tone;
  impact?: number;
  /** 만성 질환 장면별 가중치 (없으면 질환의 w) */
  w?: number;
  choices: Row[];
}

/** 추첨 조건과 가중치 (무작위 사건 공통) */
interface Draw {
  age?: [number, number];
  sex?: Sex;
  if?: string;
  flags?: string[];
  notFlags?: string[];
  childAge?: [number, number];
  where?: Where;
  /** 풀 안 상대 가중치 */
  w?: number;
  ageCurve?: Record<string, number>;
  mods?: { if: string; x: number }[];
  once?: boolean;
  cooldown?: number;
  group?: string;
  motif?: string;
  tone?: Tone;
  impact?: number;
  adult?: boolean;
}

interface Condition extends Draw {
  id: string;
  name: string;
  who?: Who;
  sx: Scene;
  dx: Scene;
  worse?: Scene;
  more?: Record<string, Scene>;
}

interface Chronic extends Draw {
  /** 관리가 안 되는 상태의 태그 */
  tag: string;
  /** 잘 관리하는 상태의 태그 */
  ok?: string;
  name: string;
  care: Scene[];
  slip?: Scene[];
}

interface Situation extends Draw {
  id: string;
  name: string;
  tags: string[];
  lead: string;
  exit?: Row;
  fx?: Fx;
}

interface Injury extends Draw {
  id: string;
  name: string;
  tags: string[];
  only?: string[];
  not?: string[];
  scene: string;
  choices: Row[];
  worse?: Scene;
  more?: Record<string, Scene>;
}

interface Variant extends Draw {
  who: Who;
  /** 같은 환자 변형이 둘 이상일 때 id 구분 */
  key?: string;
  text: string;
  title?: string;
  zoom?: string;
  choices?: Row[];
}

interface Incident extends Draw {
  id: string;
  title: string;
  zoom?: string;
  variants: Variant[];
  choices: Row[];
  chain?: Record<string, Scene>;
}

interface Site extends Draw {
  id: string;
  name: string;
  tags?: string[];
  lead: string;
  /** 감염병 선택지의 [병원] */
  clinic?: string;
  /** 병원비가 들지 않는 곳 (군 의무대, 교도소 의무과) */
  free?: boolean;
  exit?: Row;
  fx?: Fx;
}

interface Finding extends Draw {
  id: string;
  name: string;
  title?: string;
  tags?: string[];
  only?: string[];
  not?: string[];
  scene: string;
  choices: Row[];
  worse?: Scene;
  chain?: Record<string, Scene>;
}

interface Special extends Draw {
  id: string;
  title: string;
  zoom?: string;
  text: string;
  choices: Row[];
  chain?: Record<string, Scene>;
}

export interface MedicalCatalog {
  tags?: TagDef[];
  /** 분류별 가중치 배수 (풀 안에서 분류끼리의 비중을 맞춘다) */
  scale?: Partial<Record<'conditions' | 'chronic' | 'injuries' | 'incidents' | 'checkups' | 'outbreaks' | 'events', number>>;
  conditions?: Condition[];
  chronic?: Chronic[];
  injuries?: { situations: Situation[]; injuries: Injury[] };
  incidents?: Incident[];
  checkups?: { sites: Site[]; findings: Finding[] };
  outbreaks?: { sites: Site[]; diseases: Finding[] };
  events?: Special[];
}

// ── 조건 ────────────────────────────────────────────────

const ADULT = 'age >= 19';
const MINOR = 'age < 19';
const ALL_AGES: [number, number] = [0, 110];

/** 환자 변형별 기본 나이 (플레이어 나이) */
const WHO_AGE: Record<Who, [number, number]> = {
  self: ALL_AGES,
  parent: [19, 80],
  child: [20, 70],
  spouse: [22, 95],
};

function whereIf(where: Where | undefined, age: [number, number]): string | undefined {
  switch (where ?? 'civil') {
    case 'military':
      return 'military.serving';
    case 'prison':
      return 'legal.inPrison';
    case 'any':
      return undefined;
    default:
      if (age[1] < 14) return undefined;
      return age[1] >= 18 ? '!legal.inPrison && !military.serving' : '!legal.inPrison';
  }
}

function whoIf(who: Who): string | undefined {
  if (who === 'parent') return 'family.parentsAlive > 0';
  if (who === 'spouse') return 'family.married';
  return undefined;
}

/** 무작위 사건의 나이·조건 */
function gate(d: Draw, who: Who = 'self'): { age: [number, number]; if?: string } {
  const age = overlap(d.age, WHO_AGE[who]);
  if (!age) throw new Error(`나이 범위가 비었다: ${JSON.stringify(d.age)} (${who})`);
  if (who === 'child' && !d.childAge) throw new Error('자녀가 환자인 사건에는 childAge가 있어야 한다');
  return { age, if: and(whereIf(d.where, age), whoIf(who), d.if) };
}

// ── 문장 ────────────────────────────────────────────────

const SELF_FORMS: Record<string, string> = {
  '이/가': '내가',
  '은/는': '나는',
  '을/를': '나를',
  '와/과': '나와',
  '과/와': '나와',
  의: '내',
  에게: '나에게',
  도: '나도',
  '': '나',
};
const WHO_NAME: Record<Exclude<Who, 'self'>, string> = { parent: '{부모}', child: '{자녀}', spouse: '{배우자}' };
const PATIENT = /\[환자\](이\/가|은\/는|을\/를|와\/과|과\/와|의|에게|도)?/g;

function patient(text: string, who: Who): string {
  return text.replace(PATIENT, (_m, p: string | undefined) => (who === 'self' ? SELF_FORMS[p ?? ''] : WHO_NAME[who] + (p ?? '')));
}

function patientRow(r: Row, who: Who): Row {
  return {
    ...r,
    text: patient(r.text, who),
    result: patient(r.result, who),
    ...(r.fail ? { fail: patient(r.fail, who) } : {}),
  };
}

/** 다른 사람이 환자면 건강 변화는 내 몫이 아니다. 부모라면 부모의 건강으로 옮긴다 (NPC 건강은 해마다 크게 되돌아가므로 두 배) */
function patientHealth(r: Row, who: Who): Row {
  if (who === 'self') return r;
  const split = (fx: Fx | undefined): [Fx | undefined, number] => {
    if (!fx?.health) return [fx, 0];
    const rest: Fx = { ...fx };
    delete rest.health;
    return [rest, fx.health];
  };
  const [fx, h] = split(r.fx);
  const [failFx, fh] = split(r.failFx);
  const out: Row = { ...r, fx, failFx };
  if (who === 'parent') {
    if (h) out.do = [...(r.do ?? []), { type: 'parentHealth', delta: h * 2 }];
    if (fh) out.failDo = [...(r.failDo ?? []), { type: 'parentHealth', delta: fh * 2 }];
  }
  return out;
}

function patientScene(s: Scene, who: Who): Scene {
  return {
    ...s,
    title: patient(s.title, who),
    text: patient(s.text, who),
    ...(s.zoom ? { zoom: patient(s.zoom, who) } : {}),
    choices: s.choices.map((r) => patientHealth(patientRow(r, who), who)),
  };
}

function clinicRow(r: Row, clinic: string): Row {
  const sub = (t: string) => t.replaceAll('[병원]', clinic);
  return { ...r, text: sub(r.text), result: sub(r.result), ...(r.fail ? { fail: sub(r.fail) } : {}) };
}

// ── 돈 ──────────────────────────────────────────────────

// 병원비만이 아니라 안경·보습제 같은 물건값에도 어울리게 쓴다
const PAID = '계산은 {보호자}이/가 했다.';

function hasMoney(fx: Fx | undefined): boolean {
  return Boolean(fx && (fx.cost || fx.gain));
}

function noMoney(fx: Fx | undefined): Fx | undefined {
  if (!fx) return fx;
  const out: Fx = { ...fx };
  delete out.cost;
  delete out.gain;
  return out;
}

/** 미성년자용 선택지: 돈은 보호자가 낸다. 문장에 보호자가 이미 나오면 덧붙이지 않는다 */
function minorRow(r: Row): Row {
  const paid = (text: string, fx: Fx | undefined) =>
    fx?.cost && fx.cost >= 30_000 && !`${r.text} ${text}`.includes('{보호자}') ? `${text} ${PAID}` : text;
  const out: Row = { ...r, fx: noMoney(r.fx), failFx: noMoney(r.failFx), result: paid(r.result, r.fx) };
  if (r.fail !== undefined) out.fail = paid(r.fail, r.failFx);
  else if (r.check && r.failFx?.cost && !(r.fx?.cost && r.fx.cost >= 30_000)) out.fail = paid(r.result, r.failFx);
  return out;
}

function stripMoney(r: Row): Row {
  return { ...r, fx: noMoney(r.fx), failFx: noMoney(r.failFx) };
}

/** 돈이 오가는 선택지를 나이에 맞게 나눈다 */
function moneySafe(rows: Row[], age: [number, number]): Row[] {
  if (age[0] >= 19) return rows;
  const out: Row[] = [];
  for (const r of rows) {
    if (!hasMoney(r.fx) && !hasMoney(r.failFx)) out.push(r);
    else if (age[1] < 19) out.push(minorRow(r));
    else out.push({ ...r, if: and(r.if, ADULT) }, { ...minorRow(r), if: and(r.if, MINOR) });
  }
  return out;
}

// ── 선택지 ──────────────────────────────────────────────

type Ref = (key: string) => string;

function refFor(base: string): Ref {
  return (key) => (key.startsWith('med_') ? key : `${base}_${key}`);
}

function laterTo(fx: Fx | undefined, event: string, inYears: number): Fx {
  return { ...(fx ?? {}), later: [...(fx?.later ?? []), { event, inYears }] };
}

/** 짧은 참조(next, worse, later)를 실제 사건 id로 */
function resolve(r: Row, ref: Ref, worseRef: Ref): Row {
  const out: Row = { ...r };
  if (r.next) out.next = ref(r.next);
  const fixLater = (fx: Fx | undefined) =>
    fx?.later ? { ...fx, later: fx.later.map((l) => ({ ...l, event: ref(l.event) })) } : fx;
  out.fx = fixLater(r.fx);
  out.failFx = fixLater(r.failFx);
  if (r.worse) {
    const target = worseRef('worse');
    if (r.check) out.failFx = laterTo(out.failFx, target, r.worse);
    else out.fx = laterTo(out.fx, target, r.worse);
  }
  delete out.worse;
  return out;
}

function withDo(def: ChoiceDef, act: Action[] | undefined, failAct: Action[] | undefined): ChoiceDef {
  const add = (fx: Effects | undefined, list: Action[]): Effects => ({ ...(fx ?? {}), do: [...(fx?.do ?? []), ...list] });
  if (act?.length) {
    if (def.check && def.onSuccess) def.onSuccess = { ...def.onSuccess, effects: add(def.onSuccess.effects, act) };
    else def.effects = add(def.effects, act);
  }
  if (failAct?.length && def.check && def.onFail) def.onFail = { ...def.onFail, effects: add(def.onFail.effects, failAct) };
  return def;
}

interface BuildOpts {
  ref: Ref;
  /** worse를 찾을 묶음 (기본은 ref와 같다) */
  worseRef?: Ref;
  age: [number, number];
  /** 모든 선택지에 더하는 효과 (상황 보정) */
  fx?: Fx;
  /** 병원비가 들지 않는다 */
  free?: boolean;
}

function buildChoices(rows: Row[], o: BuildOpts): ChoiceDef[] {
  const folded = rows.map((r) => {
    let row: Row = r;
    if (o.fx) row = { ...row, fx: addFx(row.fx, o.fx), ...(row.check ? { failFx: addFx(row.failFx, o.fx) } : {}) };
    if (o.free) row = stripMoney(row);
    return row;
  });
  return moneySafe(folded, o.age).map((r) =>
    withDo(choice(resolve(r, o.ref, o.worseRef ?? o.ref)), r.do, r.failDo),
  );
}

// ── 사건 만들기 ──────────────────────────────────────────

interface Ctx {
  out: EventDef[];
  ids: Set<string>;
  /** 연속 사건 id → 그 사건을 부르는 쪽이 정한 나이·조건 */
  pending: { ref: string; from: string }[];
}

function push(ctx: Ctx, ev: EventDef): void {
  if (ctx.ids.has(ev.id)) throw new Error(`병원 사건 id가 겹친다: ${ev.id}`);
  ctx.ids.add(ev.id);
  ctx.out.push(ev);
  for (const c of ev.choices ?? []) {
    for (const n of [c.next, c.onSuccess?.next, c.onFail?.next]) if (typeof n === 'string') ctx.pending.push({ ref: n, from: ev.id });
    for (const fx of [c.effects, c.onSuccess?.effects, c.onFail?.effects]) {
      for (const l of fx?.later ?? []) ctx.pending.push({ ref: l.event, from: ev.id });
    }
  }
}

interface DrawnOpts {
  id: string;
  d: Draw;
  scene: Scene;
  who?: Who;
  /** 가중치 배수 (분류·상황) */
  x: number;
  group: string;
  ref: Ref;
  worseRef?: Ref;
  fx?: Fx;
  free?: boolean;
  extra?: Row[];
  extraIf?: string;
  extraFlags?: string[];
  mods?: { if: string; x: number }[];
  tone: Tone;
  impact: number;
}

function drawnEvent(ctx: Ctx, o: DrawnOpts): { age: [number, number]; if?: string } {
  const g = gate(o.d, o.who);
  const cond = and(g.if, o.extraIf);
  const rows = [...o.scene.choices];
  const choices = buildChoices(rows, { ref: o.ref, worseRef: o.worseRef, age: g.age, fx: o.fx, free: o.free });
  if (o.extra?.length) choices.push(...buildChoices(o.extra, { ref: o.ref, worseRef: o.worseRef, age: g.age, free: o.free }));
  const mods = [...(o.d.mods ?? []), ...(o.mods ?? [])];
  // 풀 안에서는 가중치의 비율만 의미가 있다. 보정을 모두 받아도 1.5를 넘지 않게 눌러 둔다 (검증기 기준)
  const boost = Math.max(1, ...Object.values(o.d.ageCurve ?? {})) * mods.reduce((p, m) => p * Math.max(1, m.x), 1);
  const w = Math.min((o.d.w ?? 0.5) * o.x, 1.5 / boost);
  push(
    ctx,
    makeEvent({
      id: o.id,
      pool: 'medical',
      title: o.scene.title,
      zoom: o.scene.zoom,
      text: o.scene.text,
      tone: o.scene.tone ?? o.d.tone ?? o.tone,
      impact: o.scene.impact ?? o.d.impact ?? o.impact,
      age: g.age,
      sex: o.d.sex,
      if: cond,
      flags: [...(o.d.flags ?? []), ...(o.extraFlags ?? [])],
      notFlags: o.d.notFlags,
      childAge: o.d.childAge,
      w,
      ageCurve: o.d.ageCurve,
      modifiers: mods.length ? mods : undefined,
      once: o.d.once,
      cooldown: o.d.cooldown,
      group: o.group,
      motif: o.d.motif,
      adult: o.d.adult,
      choices,
    }),
  );
  return { age: g.age, if: cond };
}

interface ChainOpts {
  id: string;
  scene: Scene;
  /** 부른 사건의 나이 범위 (연속 사건은 몇 해 뒤에 올 수 있어 조금 넓힌다) */
  age: [number, number];
  if?: string;
  childAge?: [number, number];
  sex?: Sex;
  group: string;
  ref: Ref;
  worseRef?: Ref;
  free?: boolean;
  adult?: boolean;
  tone: Tone;
  impact: number;
}

function chainEvent(ctx: Ctx, o: ChainOpts): void {
  const age: [number, number] = [o.age[0], Math.min(120, o.age[1] + 3)];
  const childAge: [number, number] | undefined = o.childAge ? [o.childAge[0], o.childAge[1] + 3] : undefined;
  push(
    ctx,
    makeEvent({
      id: o.id,
      type: 'chain',
      pool: 'medical',
      title: o.scene.title,
      zoom: o.scene.zoom,
      text: o.scene.text,
      tone: o.scene.tone ?? o.tone,
      impact: o.scene.impact ?? o.impact,
      age,
      sex: o.sex,
      if: o.if,
      childAge,
      group: o.group,
      adult: o.adult,
      choices: buildChoices(o.scene.choices, { ref: o.ref, worseRef: o.worseRef, age, free: o.free }),
    }),
  );
}

// ── 분류별 펼치기 ────────────────────────────────────────

function expandConditions(ctx: Ctx, list: Condition[], x: number): void {
  for (const c of list) {
    const who = c.who ?? 'self';
    const base = `med_${c.id}`;
    const ref = refFor(base);
    const group = c.group ?? c.id;
    const g = drawnEvent(ctx, { id: base, d: c, scene: patientScene(c.sx, who), who, x, group, ref, tone: 'neutral', impact: 5 });
    const chain = (key: string, scene: Scene, tone: Tone, impact: number) =>
      chainEvent(ctx, {
        id: ref(key),
        scene: patientScene(scene, who),
        age: g.age,
        if: g.if,
        childAge: c.childAge,
        sex: c.sex,
        group,
        ref,
        adult: c.adult,
        tone,
        impact,
      });
    chain('dx', c.dx, 'neutral', 6);
    if (c.worse) chain('worse', c.worse, 'drama', 10);
    for (const [key, scene] of Object.entries(c.more ?? {})) chain(key, scene, 'neutral', 6);
  }
}

function tagKey(tag: string): string {
  return tag.replace(/^med_/, '');
}

function expandChronic(ctx: Ctx, list: Chronic[], x: number): void {
  for (const c of list) {
    const key = tagKey(c.tag);
    const group = c.group ?? `care_${key}`;
    const scenes: [string, Scene, string][] = [
      ...c.care.map((s, i): [string, Scene, string] => [`med_care_${key}_${i + 1}`, s, c.tag]),
      ...(c.slip ?? []).map((s, i): [string, Scene, string] => {
        if (!c.ok) throw new Error(`${c.tag}: slip 장면에는 ok 태그가 있어야 한다`);
        return [`med_slip_${key}_${i + 1}`, s, c.ok];
      }),
    ];
    for (const [id, scene, flag] of scenes) {
      const ref = refFor(id);
      // 확대 표시: '고혈압과 사는 법' / '당뇨 관리'
      const zoom = scene.zoom ?? (flag === c.ok ? `${c.name} 관리` : `${josa(c.name, '과/와')} 사는 법`);
      drawnEvent(ctx, {
        id,
        d: { ...c, w: (scene.w ?? c.w ?? 0.6) * (flag === c.ok ? 0.6 : 1) },
        scene: { ...scene, zoom },
        x,
        group,
        ref,
        extraFlags: [flag],
        tone: flag === c.ok ? 'drama' : 'neutral',
        impact: flag === c.ok ? 7 : 5,
      });
    }
  }
}

function pairs<A extends { id: string; tags?: string[]; age?: [number, number] }, B extends { id: string; tags?: string[]; age?: [number, number]; only?: string[]; not?: string[] }>(
  sites: A[],
  items: B[],
): [B, A, [number, number]][] {
  const out: [B, A, [number, number]][] = [];
  for (const item of items) {
    for (const site of sites) {
      if (item.only) {
        if (!item.only.includes(site.id)) continue;
      } else {
        if (item.not?.includes(site.id)) continue;
        if (!(item.tags ?? []).some((t) => (site.tags ?? []).includes(t))) continue;
      }
      const age = overlap(item.age, site.age);
      if (!age) continue;
      out.push([item, site, age]);
    }
  }
  return out;
}

/** 두 조건(상황·항목)을 한 사건의 조건으로 합친다 */
function mergeDraw(item: Draw, site: Draw, age: [number, number]): Draw {
  const sex = item.sex && site.sex && item.sex !== site.sex ? undefined : (item.sex ?? site.sex);
  return {
    ...item,
    age,
    sex,
    if: and(site.if, item.if),
    flags: [...(site.flags ?? []), ...(item.flags ?? [])],
    notFlags: [...(site.notFlags ?? []), ...(item.notFlags ?? [])],
    childAge: item.childAge ?? site.childAge,
    where: site.where ?? item.where,
    mods: [...(site.mods ?? []), ...(item.mods ?? [])],
    ageCurve: item.ageCurve ?? site.ageCurve,
    motif: item.motif ?? site.motif,
    w: (item.w ?? 0.5) * (site.w ?? 1),
  };
}

function sexOk(a: Sex | undefined, b: Sex | undefined): boolean {
  return !(a && b && a !== b);
}

function expandInjuries(ctx: Ctx, data: { situations: Situation[]; injuries: Injury[] }, x: number): void {
  for (const inj of data.injuries) {
    const base = `med_inj_${inj.id}`;
    const ref = refFor(base);
    const group = inj.group ?? `inj_${inj.id}`;
    let span: [number, number] | null = null;
    let anyIf: string | undefined;
    for (const [, sit, age] of pairs(data.situations, [inj])) {
      if (!sexOk(inj.sex, sit.sex)) continue;
      const d = mergeDraw(inj, sit, age);
      const g = drawnEvent(ctx, {
        id: `${base}_${sit.id}`,
        d,
        scene: { title: inj.name, zoom: sit.name, text: `${sit.lead} ${inj.scene}`, choices: inj.choices },
        x,
        group,
        ref,
        fx: sit.fx,
        free: sit.where === 'military' || sit.where === 'prison',
        extra: sit.exit ? [sit.exit] : undefined,
        tone: 'drama',
        impact: 8,
      });
      span = span ? [Math.min(span[0], g.age[0]), Math.max(span[1], g.age[1])] : g.age;
      anyIf = '!legal.inPrison';
    }
    if (!span) throw new Error(`짝이 되는 상황이 없는 부상: ${inj.id}`);
    const chain = (key: string, scene: Scene) =>
      chainEvent(ctx, { id: ref(key), scene, age: span!, if: anyIf, sex: inj.sex, group, ref, tone: 'drama', impact: 8 });
    if (inj.worse) chain('worse', inj.worse);
    for (const [key, scene] of Object.entries(inj.more ?? {})) chain(key, scene);
  }
}

function expandIncidents(ctx: Ctx, list: Incident[], x: number): void {
  for (const inc of list) {
    for (const v of inc.variants) {
      const tag = v.key ?? v.who;
      const base = `med_inc_${inc.id}_${tag}`;
      const ref = refFor(base);
      const d: Draw = {
        ...inc,
        ...v,
        age: overlap(inc.age, v.age) ?? undefined,
        if: and(inc.if, v.if),
        w: (inc.w ?? 0.5) * (v.w ?? 1),
        mods: [...(inc.mods ?? []), ...(v.mods ?? [])],
        group: inc.group ?? `inc_${inc.id}`,
      };
      const scene = patientScene(
        { title: v.title ?? inc.title, zoom: v.zoom ?? inc.zoom, text: v.text, choices: v.choices ?? inc.choices },
        v.who,
      );
      const g = drawnEvent(ctx, {
        id: base,
        d,
        scene,
        who: v.who,
        x,
        group: d.group!,
        ref,
        tone: 'drama',
        impact: 9,
      });
      for (const [key, s] of Object.entries(inc.chain ?? {})) {
        chainEvent(ctx, {
          id: ref(key),
          scene: patientScene(s, v.who),
          age: g.age,
          if: g.if,
          childAge: d.childAge,
          sex: d.sex,
          group: d.group!,
          ref,
          adult: d.adult,
          tone: 'drama',
          impact: 8,
        });
      }
    }
  }
}

interface PairedSet {
  prefix: string;
  sites: Site[];
  items: Finding[];
  x: number;
  mods?: { if: string; x: number }[];
  tone: Tone;
  impact: number;
  /** 사건 제목: 항목 이름 또는 title */
  titled: (f: Finding) => string;
}

function expandPaired(ctx: Ctx, set: PairedSet): void {
  for (const f of set.items) {
    const base = `med_${set.prefix}_${f.id}`;
    const ref = refFor(base);
    const group = f.group ?? `${set.prefix}_${f.id}`;
    let span: [number, number] | null = null;
    for (const [, site, age] of pairs(set.sites, [f])) {
      if (!sexOk(f.sex, site.sex)) continue;
      const d = mergeDraw(f, site, age);
      const clinic = site.clinic ?? '병원';
      const g = drawnEvent(ctx, {
        id: `${base}_${site.id}`,
        d,
        scene: {
          title: set.titled(f),
          zoom: site.name,
          text: `${site.lead} ${f.scene}`,
          choices: f.choices.map((r) => clinicRow(r, clinic)),
        },
        x: set.x,
        group,
        ref,
        fx: site.fx,
        free: site.free,
        extra: site.exit ? [clinicRow(site.exit, clinic)] : undefined,
        mods: set.mods,
        tone: set.tone,
        impact: set.impact,
      });
      span = span ? [Math.min(span[0], g.age[0]), Math.max(span[1], g.age[1])] : g.age;
    }
    if (!span) throw new Error(`짝이 되는 장소가 없다: ${set.prefix} ${f.id}`);
    const chains: [string, Scene][] = [...(f.worse ? [['worse', f.worse] as [string, Scene]] : []), ...Object.entries(f.chain ?? {})];
    for (const [key, scene] of chains) {
      chainEvent(ctx, {
        id: ref(key),
        scene,
        age: span,
        if: span[1] >= 18 ? '!legal.inPrison' : undefined,
        sex: f.sex,
        group,
        ref,
        tone: key === 'worse' ? 'drama' : 'neutral',
        impact: key === 'worse' ? 9 : 5,
      });
    }
  }
}

function expandEvents(ctx: Ctx, list: Special[], x: number): void {
  for (const s of list) {
    const base = `med_${s.id}`;
    const ref = refFor(base);
    const group = s.group ?? s.id;
    const g = drawnEvent(ctx, {
      id: base,
      d: s,
      scene: { title: s.title, zoom: s.zoom, text: s.text, choices: s.choices },
      x,
      group,
      ref,
      free: s.where === 'military' || s.where === 'prison',
      tone: 'neutral',
      impact: 6,
    });
    for (const [key, scene] of Object.entries(s.chain ?? {})) {
      chainEvent(ctx, {
        id: ref(key),
        scene,
        age: g.age,
        if: g.if,
        childAge: s.childAge,
        sex: s.sex,
        group,
        ref,
        free: s.where === 'military' || s.where === 'prison',
        adult: s.adult,
        tone: 'neutral',
        impact: 6,
      });
    }
  }
}

export function expandMedical(data: MedicalCatalog): EventDef[] {
  const ctx: Ctx = { out: [], ids: new Set(), pending: [] };
  const scale = data.scale ?? {};
  expandConditions(ctx, data.conditions ?? [], scale.conditions ?? 1);
  expandChronic(ctx, data.chronic ?? [], scale.chronic ?? 1);
  if (data.injuries) expandInjuries(ctx, data.injuries, scale.injuries ?? 1);
  expandIncidents(ctx, data.incidents ?? [], scale.incidents ?? 1);
  if (data.checkups) {
    expandPaired(ctx, {
      prefix: 'chk',
      sites: data.checkups.sites,
      items: data.checkups.findings,
      x: scale.checkups ?? 1,
      // 그해 건강검진을 받았으면 소견이 잘 나온다
      mods: [{ if: 'flags.checked_up', x: 2 }],
      tone: 'neutral',
      impact: 5,
      titled: (f) => f.title ?? `검진 소견: ${f.name}`,
    });
  }
  if (data.outbreaks) {
    expandPaired(ctx, {
      prefix: 'out',
      sites: data.outbreaks.sites,
      items: data.outbreaks.diseases,
      x: scale.outbreaks ?? 1,
      tone: 'neutral',
      impact: 5,
      titled: (f) => f.title ?? f.name,
    });
  }
  expandEvents(ctx, data.events ?? [], scale.events ?? 1);
  // 잘못 적은 짧은 참조는 여기서 잡는다 (검증기보다 먼저, 어느 표에서 났는지 알려 준다)
  for (const p of ctx.pending) {
    if (!ctx.ids.has(p.ref)) throw new Error(`${p.from}: 없는 병원 사건으로 이어진다 (${p.ref})`);
  }
  return ctx.out;
}
