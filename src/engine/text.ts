// 사건 문장 채우기. {지인}, {부모}, {대학} 같은 자리표시자를 실제 이름과 값으로 바꾸고
// 바로 뒤의 조사를 받침에 맞게 고친다: '{지인}이/가' → '김민지가', '{지인}이 ' → '박지훈이 '
// 사건이 가리키는 사람(대상 인물)도 여기서 정한다. 아래 '대상 인물' 참고.

import { admissionName, susiTier } from './career';
import { REGION_BY_ID, WORLD } from './data';
import { formatWon, HIGH_TYPE_LABEL, josa, JOSA_PATTERN, SINGLE_TO_PAIR } from './format';
import { homePrice } from './scope';
import { alive, guardianLabel, partnerOf, randomGiven, randomSurname, roleLabel, spouseOf } from './relations';
import type { Action, Effects, EventDef } from './schema';
import type { Rng } from './rng';
import type { Character, GameState, Npc, Sex, TalentKey } from './types';

const PLACEHOLDER = /\{([^{}]+)\}/g;

/** 사건 하나에 쓰인 모든 자리표시자 */
export function placeholdersOf(ev: EventDef): string[] {
  const texts: string[] = [ev.title, ev.text, ev.zoom ?? ''];
  for (const c of ev.choices ?? []) {
    texts.push(c.text, c.result ?? '', c.onSuccess?.text ?? '', c.onFail?.text ?? '');
  }
  const keys = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(PLACEHOLDER)) keys.add(m[1]);
  return [...keys].sort();
}

/** 사건 하나의 모든 효과: 사건 자체, 선택지, 판정 성공·실패 */
export function effectsOf(ev: EventDef): Effects[] {
  const out: Effects[] = ev.effects ? [ev.effects] : [];
  for (const c of ev.choices ?? []) {
    for (const fx of [c.effects, c.onSuccess?.effects, c.onFail?.effects]) if (fx) out.push(fx);
  }
  return out;
}

// ── 대상 인물 ────────────────────────────────────────────
// 사건이 가리키는 사람은 문장이 아니라 사건 정의로 정한다 (R-011).
//   자녀  trigger.childAge가 있거나, 자녀 친밀도를 바꾸거나, 문장에 {자녀}가 있으면
//   부모  {부모} 또는 부모 건강(parentHealth)       형제  {형제} 또는 형제 친밀도
//   친구  {친구} 또는 친구 친밀도                   연인·배우자  {연인}·{배우자} 또는 그 친밀도
// 카드가 처음 뜰 때 역할마다 딱 한 사람을 ctx에 묶는다 (childId와 {자녀} 이름 등). 문장에 이름이 있든 없든
// 같은 사람이다. 역할마다 난수 줄기를 따로 써서 문장을 고치거나 다른 역할이 늘어도 뽑히는 사람이 그대로다.
//
// 자녀·형제·친구 친밀도는 언제나 묶인 한 사람에게만 적용한다. 묶을 사람이 없으면 그 효과가 있는
// 선택지는 보이지 않고, 사건 자체의 효과라면 사건이 일어나지 않는다 ('그 역할 모두'로 번지지 않는다).
// 사건 데이터에서 여러 사람에게 한꺼번에 적용하는 표기는 부모 둘 다를 뜻하는 role 'parents'뿐이다.
// 모든 자녀·모든 형제를 뜻하는 사건 표기는 아직 없다 (가족 모두에게 적용하는 일은 지금 활동 '가족과 시간',
// activities.ts special 'family'뿐이다). 사건에 필요해지면 'parents'처럼 복수 역할을 schema·effects에 더하고,
// 그 전까지 검증기가 모르는 역할(예: 'children')과 한 사람을 고를 규칙이 없는 역할(조부모·전 배우자)을 막는다.
//
// 연속·예약 사건은 묶인 사람을 물려받고 다시 고르지 않는다. 뜨기 직전에 그 사람이 살아 있는지, 아직 그
// 역할인지, 사건의 자녀 나이대에 드는지 다시 본다 (R-012). 어긋나면 다른 사람으로 바꾸지 않고 취소한다.
// 죽은 사람을 부르는 사건(부고·추모)은 역할 대신 고인(ctx.npcId, {고인})을 쓰므로 이 재검사를 받지 않는다.
//
// 옛 저장 (고치기 전 엔진이 만든 ctx):
//   - 대상 없이 띄운 채 저장된 카드는 선택할 때 같은 난수 줄기로 묶고, 그래도 없으면 그 효과를 뺀다 (chooseOption).
//   - 연인·배우자 예약은 이름만 있다. 그 이름이 지금 연인·배우자가 아니면 취소한다 (legacyLoss).

export type TargetRole = 'child' | 'parent' | 'sibling' | 'friend' | 'partner' | 'spouse';

/** 역할마다 ctx에 남기는 id 키와 이름 자리표시자 */
export const TARGET_SLOTS: Record<TargetRole, { id: string; name: string }> = {
  child: { id: 'childId', name: '자녀' },
  parent: { id: 'parentId', name: '부모' },
  sibling: { id: 'siblingId', name: '형제' },
  friend: { id: 'friendId', name: '친구' },
  partner: { id: 'partnerId', name: '연인' },
  spouse: { id: 'spouseId', name: '배우자' },
};

const TARGET_ORDER: TargetRole[] = ['child', 'parent', 'sibling', 'friend', 'partner', 'spouse'];

/** 이름 자리표시자 → 역할 */
const PLACEHOLDER_ROLE = new Map<string, TargetRole>(TARGET_ORDER.map((r) => [TARGET_SLOTS[r].name, r]));

/** 친밀도 역할 → 묶을 역할. parents·mother·father는 묶지 않는다 (부모 둘 다, 또는 원래 한 사람) */
const CLOSENESS_ROLE: Record<string, TargetRole | undefined> = {
  child: 'child',
  sibling: 'sibling',
  friend: 'friend',
  partner: 'partner',
  spouse: 'spouse',
};

/** 여러 명일 수 있는 역할: 묶이지 않은 채 효과가 적용되면 그 역할 전원이 바뀐다 */
const ONE_OF_MANY = new Set<TargetRole>(['child', 'sibling', 'friend']);

const rolesCache = new WeakMap<EventDef, TargetRole[]>();

/** 사건이 가리키는 사람의 역할들 (자녀 나이 조건·효과·자리표시자로 정해진다) */
export function targetRolesOf(ev: EventDef): TargetRole[] {
  const cached = rolesCache.get(ev);
  if (cached) return cached;
  const found = new Set<TargetRole>();
  if (ev.trigger?.childAge) found.add('child');
  for (const key of placeholdersOf(ev)) {
    const role = PLACEHOLDER_ROLE.get(key);
    if (role) found.add(role);
  }
  for (const fx of effectsOf(ev)) {
    for (const a of fx.do ?? []) {
      if (a.type === 'parentHealth') found.add('parent');
      const role = a.type === 'npcCloseness' ? CLOSENESS_ROLE[a.role] : undefined;
      if (role) found.add(role);
    }
  }
  const roles = TARGET_ORDER.filter((r) => found.has(r));
  rolesCache.set(ev, roles);
  return roles;
}

function inRange(age: number, range: [number, number] | undefined): boolean {
  return !range || (age >= range[0] && age <= range[1]);
}

/** 이 사건의 대상이 될 수 있는 사람들. 자녀는 사건의 자녀 나이대 안에서 */
function candidates(state: GameState, ev: EventDef, role: TargetRole): Npc[] {
  const ch = state.ch;
  switch (role) {
    case 'child':
      return alive(ch, 'child').filter((k) => inRange(state.year - k.birthYear, ev.trigger?.childAge));
    case 'parent':
      return alive(ch, 'mother', 'father');
    case 'sibling':
      return alive(ch, 'sibling');
    case 'friend':
      return alive(ch, 'friend');
    case 'partner':
      return alive(ch, 'partner');
    case 'spouse':
      return alive(ch, 'spouse');
  }
}

function pickTarget(state: GameState, ev: EventDef, role: TargetRole, rngOf: (role: TargetRole) => Rng): Npc | undefined {
  const list = candidates(state, ev, role);
  if (list.length === 0) return undefined;
  // 부모는 나이가 더 많은 쪽 (병환·피싱 사건의 당사자). 연인·배우자는 한 사람뿐이다
  if (role === 'parent') return list.reduce((a, b) => (a.birthYear <= b.birthYear ? a : b));
  if (list.length === 1 || role === 'partner' || role === 'spouse') return list[0];
  return rngOf(role).pick(list);
}

/** 문장에 들어갈 이름: 부모·형제는 호칭(엄마, 누나), 나머지는 이름 */
function targetName(npc: Npc, role: TargetRole, ch: Character): string {
  return role === 'parent' || role === 'sibling' ? roleLabel(npc, ch) : npc.name;
}

/**
 * 역할마다 한 사람을 묶는다. 이미 정해졌으면(앞 사건에서 물려받았거나 '조카'처럼 명단 밖 사람으로 정해졌으면)
 * 다시 고르지 않는다: 이어지는 이야기의 주인공이 다른 사람으로 바뀌지 않는다.
 */
export function bindTargets(state: GameState, ev: EventDef, ctx: Record<string, string>, rngOf: (role: TargetRole) => Rng): void {
  for (const role of targetRolesOf(ev)) {
    const slot = TARGET_SLOTS[role];
    if (ctx[slot.id] !== undefined || ctx[slot.name] !== undefined) continue;
    const npc = pickTarget(state, ev, role, rngOf);
    if (!npc) continue;
    ctx[slot.id] = npc.id;
    ctx[slot.name] = targetName(npc, role, state.ch);
  }
}

/**
 * 한 사람 대상 효과(자녀·형제·친구 친밀도)의 대상이 묶였는가. 묶이지 않은 채 적용하면
 * 효과가 그 역할 전원에게 번지므로, 아니면 false (그 선택지·사건을 쓰지 않는다).
 */
export function targetsReady(ctx: Record<string, string>, ...fxs: (Effects | undefined)[]): boolean {
  return fxs.every((fx) => unboundActions(ctx, fx).size === 0);
}

/** 효과 안에서 대상이 묶이지 않은 한 사람 대상 행동들 */
function unboundActions(ctx: Record<string, string>, fx: Effects | undefined): Set<Action> {
  const out = new Set<Action>();
  let newFriend = false;
  for (const a of fx?.do ?? []) {
    // 새 친구를 사귀는 행동은 그 친구를 ctx에 묶는다
    if (a.type === 'addFriend') newFriend = true;
    const role = a.type === 'npcCloseness' ? CLOSENESS_ROLE[a.role] : undefined;
    if (!role || !ONE_OF_MANY.has(role) || ctx[TARGET_SLOTS[role].id] !== undefined) continue;
    if (role === 'friend' && newFriend) continue;
    out.add(a);
  }
  return out;
}

/**
 * 묶이지 않은 한 사람 대상 효과를 뺀 효과 (다 묶였으면 그대로). 고치기 전 엔진이 대상 없이 띄운 채
 * 저장한 카드에서, 묶을 사람이 끝내 없을 때 '그 역할 모두'로 번지지 않게 하는 마지막 안전장치다.
 */
export function onlyBound(ctx: Record<string, string>, fx: Effects | undefined): Effects | undefined {
  const unbound = unboundActions(ctx, fx);
  if (!fx || unbound.size === 0) return fx;
  return { ...fx, do: fx.do!.filter((a) => !unbound.has(a)) };
}

/** 묶인 사람이 아직 그 역할인가. 연인이 그사이 배우자가 됐으면 같은 사람이다 */
const ROLE_OK: Record<TargetRole, (n: Npc) => boolean> = {
  child: (n) => n.role === 'child',
  parent: (n) => n.role === 'mother' || n.role === 'father',
  sibling: (n) => n.role === 'sibling',
  friend: (n) => n.role === 'friend',
  partner: (n) => n.role === 'partner' || n.role === 'spouse',
  spouse: (n) => n.role === 'spouse',
};

/** 물려받은 대상을 잃은 까닭. reason은 일기에 남길 한 문장, died는 그 사람이 세상을 떠났는지 */
export interface TargetLoss {
  name: string;
  reason: string;
  died: boolean;
}

/** 묶인 사람 한 명이 이 사건의 대상이 될 수 없는 까닭 */
function lostReason(state: GameState, ev: EventDef, role: TargetRole, npc: Npc | undefined, name: string): TargetLoss | undefined {
  const loss = (reason: string, died = false): TargetLoss => ({ name, reason, died });
  // 명단에서 빠진 사람: 헤어진 연인, 연락이 끊긴 친구
  if (!npc) {
    if (role === 'partner') return loss(`${josa(name, '와/과')} 헤어졌다.`);
    return loss(role === 'spouse' ? `${josa(name, '은/는')} 이제 곁에 없다.` : `${josa(name, '와/과')} 연락이 끊겼다.`);
  }
  if (!npc.alive) return loss(`${josa(name, '이/가')} 세상을 떠났다.`, true);
  if (npc.missing) return loss(`${josa(name, '와/과')} 연락이 닿지 않는다.`);
  if (!ROLE_OK[role](npc)) return loss(npc.role === 'ex' ? `${josa(name, '와/과')} 헤어졌다.` : `${josa(name, '은/는')} 이제 곁에 없다.`);
  // 자녀는 사건의 자녀 나이대에 아직 드는가
  const range = role === 'child' ? ev.trigger?.childAge : undefined;
  if (!range) return undefined;
  const age = state.year - npc.birthYear;
  if (age > range[1]) return loss(`${josa(name, '은/는')} 그새 ${age}살이 됐다.`);
  if (age < range[0]) return loss(`${josa(name, '은/는')} 아직 ${age}살이다.`);
  return undefined;
}

/** 묶을 연인·배우자가 없을 때 대신 쓰는 이름 (예전 엔진도 같았다). 명단의 누구도 가리키지 않는다 */
const STAND_IN_NAME: Partial<Record<TargetRole, string>> = { partner: '그 사람', spouse: '배우자' };

/**
 * 옛 저장의 연인·배우자 예약: id가 생기기 전에는 {연인}·{배우자} 이름만 남겼다. 그 이름이 지금 연인·배우자가
 * 아니면 그 사람이 아니다 (사별·이별 뒤 새 사람에게 옮겨 가지 않는다). 대신 쓴 이름('그 사람')은 보지 않는다.
 */
function legacyLoss(state: GameState, ev: EventDef, role: TargetRole, name: string | undefined): TargetLoss | undefined {
  if ((role !== 'partner' && role !== 'spouse') || name === undefined || name === STAND_IN_NAME[role]) return undefined;
  const ch = state.ch;
  const current = role === 'partner' ? [partnerOf(ch), spouseOf(ch)] : [spouseOf(ch)];
  if (current.some((n) => n?.name === name)) return undefined;
  const known = ch.npcs.find((n) => n.name === name && (n.role === 'partner' || n.role === 'spouse' || n.role === 'ex'));
  return lostReason(state, ev, role, known, name);
}

/**
 * 물려받은 대상이 아직 이 사건의 대상이 될 수 있는지 다시 본다 (R-012). 안 되면 그 까닭, 되면 undefined.
 * 사건이 가리키지 않는 역할의 id는 보지 않는다 (예: 친구가 등장한 진료 뒤 '내 병이 깊어졌다'는 친구와 무관하다).
 */
export function targetProblem(state: GameState, ev: EventDef, ctx: Record<string, string>): TargetLoss | undefined {
  for (const role of targetRolesOf(ev)) {
    const slot = TARGET_SLOTS[role];
    const id = ctx[slot.id];
    const npc = id === undefined ? undefined : state.ch.npcs.find((n) => n.id === id);
    const loss =
      id === undefined
        ? legacyLoss(state, ev, role, ctx[slot.name])
        : lostReason(state, ev, role, npc, ctx[slot.name] ?? npc?.name ?? '그 사람');
    if (loss) return loss;
  }
  return undefined;
}

/**
 * 취소된 사건의 일기 한 줄. 세상을 떠난 사람이면 죽음을 새 소식처럼 다시 알리지 않고, 일어났을 장면의
 * 제목도 꺼내지 않는다. 같은 사람 때문에 그해 여러 일이 취소돼도 이 줄은 같으므로 한 번만 남긴다 (eventEngine).
 */
export function cancelledLine(loss: TargetLoss, title: string): string {
  if (loss.died) return `떠난 ${loss.name}의 몫으로 남아 있던 일들은 이제 오지 않는다.`;
  return `${loss.reason} 예정됐던 일(${title})은 없던 일이 됐다.`;
}

export const TALENT_LABEL: Record<TalentKey, string> = {
  music: '음악',
  sports: '운동',
  math: '수학',
  language: '언어',
  art: '미술',
  leadership: '리더십',
  craft: '손재주',
};

const TALENT_SCENE: Record<TalentKey, string> = {
  music: '음악 시간에 리코더를 불자 선생님이 잠깐 멈추라고 했다. "너 어디서 배웠니?"',
  sports: '체육 시간 오래달리기에서 반 아이들을 한 바퀴 차이로 따돌렸다. 체육 선생님이 이름을 물었다.',
  math: '수학 경시대회 문제를 혼자 다 풀었다. 담임이 시험지를 두 번 들여다봤다.',
  language: '원어민 선생님이 내 발음을 듣고 눈이 동그래졌다. 영어 동화책 한 권을 하루 만에 외웠다.',
  art: '미술 시간에 그린 그림이 교내 복도에 걸렸다. 교장 선생님이 한참 서서 봤다.',
  leadership: '모둠 활동에서 다들 자연스럽게 내 말을 따랐다. 싸우던 두 아이도 내가 말리자 멈췄다.',
  craft: '고장 난 라디오를 혼자 뜯어서 고쳐 놓았다. 아빠가 공구함을 통째로 물려줬다.',
};

const ENLIST_PLACE: Record<string, string> = {
  army: '논산 육군훈련소',
  navy: '진해 해군교육사령부',
  airforce: '진주 공군교육사령부',
  marines: '포항 해병대교육훈련단',
  social: '사회복무요원 기초군사훈련',
};

function personName(state: GameState, rng: Rng, sex: Sex, birthYear: number): string {
  void state;
  return randomSurname(rng) + randomGiven(rng, sex, birthYear);
}

function nagging(state: GameState): string {
  const ch = state.ch;
  if (ch.age < 19 || ch.edu.status === 'university') return '공부는 잘하니? 반에서 몇 등 하니?';
  if (!ch.career.jobId) return '취직은 했니? 요즘 뭐 하고 지내니?';
  if (!spouseOf(ch)) return '결혼은 언제 하니? 만나는 사람은 있고?';
  const kids = alive(ch, 'child').length;
  if (kids === 0) return '애는 언제 가질 거니? 더 늦으면 힘들다.';
  if (kids === 1) return '둘째는? 애 혼자 크면 외로워.';
  return '애들 학원은 어디 보내니? 요즘 영어유치원 다들 보내던데.';
}

/**
 * 카드가 처음 나올 때 한 번 만드는 값들. 같은 카드 안에서는 같은 사람을 가리켜야 하므로
 * ctx에 저장한다. 이미 있으면 건드리지 않는다 (연속 사건이 같은 지인을 이어받는다).
 * 대상 인물(자녀·부모·형제·친구·연인·배우자)을 먼저 묶고, 묶을 사람이 없을 때만 아래에서 대신할 이름을 쓴다.
 * targetRng는 역할마다 따로 쓰는 난수 줄기다 (없으면 카드 난수).
 */
export function generateCtx(
  state: GameState,
  ev: EventDef,
  ctx: Record<string, string>,
  rng: Rng,
  targetRng: (role: TargetRole) => Rng = () => rng,
): void {
  const ch = state.ch;
  bindTargets(state, ev, ctx, targetRng);
  for (const key of placeholdersOf(ev)) {
    if (ctx[key] !== undefined) continue;
    switch (key) {
      case '지인':
        ctx[key] = personName(state, rng, rng.chance(0.6) ? ch.sex : ch.sex === 'M' ? 'F' : 'M', ch.birthYear + rng.int(-4, 2));
        break;
      case '상대':
        ctx[key] = personName(state, rng, ch.sex === 'M' ? 'F' : 'M', ch.birthYear + rng.int(-3, 3));
        break;
      // 대상 인물인데 묶을 사람이 없을 때: 명단에 없는 사람으로 대신한다 (아래 연인·배우자·자녀도 같다)
      case '친구':
        ctx[key] = personName(state, rng, ch.sex, ch.birthYear);
        break;
      case '부모':
        ctx[key] = guardianLabel(ch);
        break;
      case '형제':
        ctx[key] = '사촌';
        break;
      case '재능':
      case '재능장면': {
        // 둘은 항상 함께 정해진다
        if (ctx.talent !== undefined) break;
        const hidden = ch.talents.filter((t) => !t.discovered);
        const t = hidden.length > 0 ? rng.pick(hidden) : ch.talents[0];
        ctx.talent = t ? t.key : '';
        ctx.재능 = t ? TALENT_LABEL[t.key] : '';
        ctx.재능장면 = t ? TALENT_SCENE[t.key] : '';
        break;
      }
      case '암종': {
        const types = WORLD.cancerTypes.filter((c) =>
          ch.sex === 'M' ? c !== '유방암' : c !== '전립선암',
        );
        ctx[key] = rng.pick(types);
        break;
      }
      case '병기': {
        const early = Boolean(ch.flags.checked_up);
        ctx[key] = rng.weighted(['1기', '2기', '3기', '4기'], (s) =>
          s === '1기' ? (early ? 5 : 2) : s === '2기' ? 3 : s === '3기' ? 2 : early ? 0.5 : 1.5,
        )!;
        break;
      }
      case '정당':
        ctx[key] = state.world.politics.ruling ?? rng.pick(WORLD.parties);
        break;
      case '연인':
        ctx[key] = STAND_IN_NAME.partner!;
        break;
      case '배우자':
        ctx[key] = STAND_IN_NAME.spouse!;
        break;
      case '잔소리':
        ctx[key] = nagging(state);
        break;
      case '자녀':
        // 사건의 자녀 나이대에 맞는 아이가 없을 때
        ctx[key] = '조카';
        break;
      case '합격대학':
        ctx[key] = admissionName(state, rng);
        break;
      // 특별 전형: 이름과 등급을 함께 정해 두면 enterUniversity·earlyAdmit가 그대로 쓴다
      case '과기원':
        ctx[key] = ctx.합격대학 = rng.pick(WORLD.specialUniversities.science);
        ctx.합격등급 = 'S';
        break;
      case '예대':
        ctx[key] = ctx.합격대학 = rng.pick(WORLD.specialUniversities.arts);
        ctx.합격등급 = 'A';
        break;
      case '체대':
        ctx[key] = ctx.합격대학 = rng.pick(WORLD.specialUniversities.sports);
        ctx.합격등급 = 'B';
        break;
      case '수시목표': {
        const tier = susiTier(state);
        ctx[key] = ctx.합격대학 = rng.pick(WORLD.universities[tier]);
        ctx.합격등급 = tier;
        break;
      }
      case '집값': {
        const price = homePrice(state);
        ctx.homePrice = String(price);
        ctx[key] = formatWon(price);
        break;
      }
      case '분양가': {
        const price = Math.round(homePrice(state) * 0.85);
        ctx.homePrice = String(price);
        ctx[key] = formatWon(price);
        break;
      }
    }
  }
}

/** 렌더링 시점에 상태에서 바로 계산하는 값 */
function dynamicValue(state: GameState, key: string): string | undefined {
  const ch = state.ch;
  switch (key) {
    case '이름':
      return ch.given;
    case '성명':
      return ch.surname + ch.given;
    case '지역':
      return REGION_BY_ID.get(ch.region)?.short ?? ch.region;
    case '고향':
      return REGION_BY_ID.get(ch.birthRegion)?.short ?? ch.birthRegion;
    case '연도':
      return String(state.year);
    case '나이':
      return String(ch.age);
    case '보호자':
      return guardianLabel(ch);
    case '최저시급':
      return state.world.economy.minWage.toLocaleString('ko-KR');
    case '내신':
      return `상위 ${Math.max(1, Math.round(100 - ch.edu.grade))}%`;
    case '대학':
      return ch.edu.univ?.name ?? '대학';
    case '직장':
      return ch.career.title ?? '회사';
    case '입영지':
      return ENLIST_PLACE[ch.military.branch ?? 'army'];
    case '신체등급':
      return String(ch.military.grade ?? 1);
    case '연금':
      return formatWon(Math.round((ch.career.pension * state.world.economy.priceIndex) / 12 / 1000) * 1000);
    case '빚':
      return formatWon(Math.round(ch.res.debt / 10_000) * 10_000);
    case '조부모':
      return ch.sex === 'F' ? '할머니' : '할아버지';
    case '수시대학':
      return ch.edu.earlyAdmit?.name ?? '대학';
    case '학교':
      return ch.edu.highType ? HIGH_TYPE_LABEL[ch.edu.highType] : '학교';
    case '수능백분위':
      return ch.edu.csat ? String(Math.round(ch.edu.csat.percentile)) : '';
    case '연인':
      return partnerOf(ch)?.name;
    case '짝':
      // 연인이든 배우자든 지금 곁에 있는 사람
      return partnerOf(ch)?.name ?? spouseOf(ch)?.name ?? '그 사람';
    case '배우자':
      return spouseOf(ch)?.name;
  }
  return undefined;
}

/** 자리표시자 치환 + 조사 교정 */
export function render(template: string, state: GameState, ctx: Record<string, string>): string {
  const re = new RegExp(`\\{([^{}]+)\\}(?:(${JOSA_PATTERN})|([이가을를은는과와])(?=[\\s.,!?'"…)\\]]|$))?`, 'g');
  return template.replace(re, (_m, key: string, pair?: string, single?: string) => {
    const value = ctx[key] ?? dynamicValue(state, key) ?? '';
    if (pair) return josa(value, pair);
    if (single) return josa(value, SINGLE_TO_PAIR[single]);
    return value;
  });
}
