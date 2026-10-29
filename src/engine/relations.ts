// NPC와 관계. 부모·형제·친구·연인·배우자·자녀 모두 같은 규칙으로 나이 들고 죽는다.

import { NAMES } from './data';
import { npcDeathProbability, pickCauseByAge } from './health';
import type { Rng } from './rng';
import type { Character, GameState, Npc, NpcRole, PendingCard, Sex } from './types';

export function decadeKey(year: number): string {
  const keys = Object.keys(NAMES.given)
    .map(Number)
    .sort((a, b) => a - b);
  let pick = keys[0];
  for (const k of keys) if (year >= k) pick = k;
  return String(pick);
}

export function randomSurname(rng: Rng): string {
  return rng.weighted(NAMES.surnames, ([, w]) => w)?.[0] ?? '김';
}

export function randomGiven(rng: Rng, sex: Sex, birthYear: number): string {
  const pool = NAMES.given[decadeKey(birthYear)][sex];
  return rng.pick(pool);
}

export function npcAge(npc: Npc, year: number): number {
  return year - npc.birthYear;
}

export function newNpcId(state: GameState): string {
  state.serial += 1;
  return `n${state.serial}`;
}

export function makeNpc(
  state: GameState,
  rng: Rng,
  role: NpcRole,
  sex: Sex,
  birthYear: number,
  opts: Partial<Npc> & { surname?: string } = {},
): Npc {
  const surname = opts.surname ?? randomSurname(rng);
  const { surname: _ignored, ...rest } = opts;
  void _ignored;
  return {
    id: newNpcId(state),
    name: surname + randomGiven(rng, sex, birthYear),
    sex,
    birthYear,
    role,
    alive: true,
    closeness: 60,
    health: 85,
    ...rest,
  };
}

// ── 조회 ─────────────────────────────────────────────────

export function alive(ch: Character, ...roles: NpcRole[]): Npc[] {
  return ch.npcs.filter((n) => n.alive && roles.includes(n.role));
}

export function parentsOf(ch: Character): Npc[] {
  return alive(ch, 'mother', 'father');
}

export function partnerOf(ch: Character): Npc | undefined {
  return alive(ch, 'partner')[0];
}

export function spouseOf(ch: Character): Npc | undefined {
  return alive(ch, 'spouse')[0];
}

export function roleLabel(npc: Npc, ch: Character): string {
  switch (npc.role) {
    case 'mother':
      return '엄마';
    case 'father':
      return '아빠';
    case 'grandparent':
      return npc.sex === 'F' ? '할머니' : '할아버지';
    case 'sibling': {
      const older = npc.birthYear < ch.birthYear;
      if (npc.twin) return '쌍둥이';
      if (!older) return npc.sex === 'M' ? '남동생' : '여동생';
      if (ch.sex === 'M') return npc.sex === 'M' ? '형' : '누나';
      return npc.sex === 'M' ? '오빠' : '언니';
    }
    case 'friend':
      return '친구';
    case 'partner':
      return '연인';
    case 'spouse':
      return npc.sex === 'M' ? '남편' : '아내';
    case 'ex':
      return '전 배우자';
    case 'child':
      return npc.sex === 'M' ? '아들' : '딸';
  }
}

/** 보호자 호칭: 엄마 → 아빠 → 할머니 → 보육원 선생님 */
export function guardianLabel(ch: Character): string {
  if (ch.family.type === 'facility') return '보육원 선생님';
  const [mother] = alive(ch, 'mother');
  const [father] = alive(ch, 'father');
  if (ch.family.type === 'grandparents') return '할머니';
  if (mother && (ch.family.livesWithParents || !father)) return '엄마';
  if (father) return '아빠';
  if (mother) return '엄마';
  return '할머니';
}

/** 가족의 지지: 부모와의 친밀도 + 양육 방식. 판정에 쓴다 */
export function familySupport(ch: Character): number {
  if (ch.family.type === 'facility') return 30;
  const ps = parentsOf(ch);
  if (ps.length === 0) return ch.family.type === 'grandparents' ? 45 : 20;
  const avg = ps.reduce((s, p) => s + p.closeness, 0) / ps.length;
  const bonus = { authoritative: 25, permissive: 15, authoritarian: 5, neglectful: -15 }[ch.family.parentingStyle];
  return Math.max(0, Math.min(100, avg * 0.6 + bonus));
}

// ── 변화 ─────────────────────────────────────────────────

export function addFriend(state: GameState, rng: Rng, name?: string): Npc {
  const ch = state.ch;
  const sex: Sex = rng.chance(0.6) ? ch.sex : ch.sex === 'M' ? 'F' : 'M';
  const npc = makeNpc(state, rng, 'friend', sex, ch.birthYear + rng.int(-1, 1), { closeness: 55 });
  if (name) npc.name = name;
  ch.npcs.push(npc);
  return npc;
}

export function loseFriend(state: GameState, rng: Rng, id?: string): Npc | undefined {
  const fs = alive(state.ch, 'friend');
  if (fs.length === 0) return undefined;
  const target = (id && fs.find((f) => f.id === id)) || rng.pick(fs);
  state.ch.npcs = state.ch.npcs.filter((n) => n.id !== target.id);
  return target;
}

export function startPartner(state: GameState, rng: Rng, name?: string): Npc {
  const ch = state.ch;
  const sex: Sex = ch.sex === 'M' ? 'F' : 'M';
  const birthYear = ch.birthYear + Math.round(rng.normal(sex === 'F' ? 1.5 : -1.5, 3));
  const npc = makeNpc(state, rng, 'partner', sex, Math.min(birthYear, state.year - 19), {
    closeness: 70,
    since: ch.age,
  });
  if (name) npc.name = name;
  ch.npcs.push(npc);
  return npc;
}

export function breakUp(state: GameState): Npc | undefined {
  const p = partnerOf(state.ch);
  if (p) state.ch.npcs = state.ch.npcs.filter((n) => n.id !== p.id);
  return p;
}

export function marry(state: GameState): Npc | undefined {
  const p = partnerOf(state.ch);
  if (!p) return undefined;
  p.role = 'spouse';
  p.since = state.ch.age;
  p.closeness = Math.max(p.closeness, 70);
  state.ch.family.livesWithParents = false;
  return p;
}

export function divorce(state: GameState): Npc | undefined {
  const s = spouseOf(state.ch);
  if (!s) return undefined;
  s.role = 'ex';
  s.closeness = Math.min(s.closeness, 20);
  // 재산 분할: 순자산의 절반
  const r = state.ch.res;
  r.cash = Math.round(r.cash * 0.5);
  r.stocks = Math.round(r.stocks * 0.5);
  r.coins = Math.round(r.coins * 0.5);
  r.realEstate = Math.round(r.realEstate * 0.5);
  return s;
}

export function haveChild(state: GameState, rng: Rng): Npc {
  const ch = state.ch;
  const spouse = spouseOf(ch);
  const father = ch.sex === 'M' ? ch.surname : spouse ? spouse.name.slice(0, 1) : ch.surname;
  const sex: Sex = rng.chance(105 / 205) ? 'M' : 'F';
  const npc = makeNpc(state, rng, 'child', sex, state.year, { surname: father, closeness: 85, health: 88 });
  ch.npcs.push(npc);
  return npc;
}

export function addSibling(state: GameState, rng: Rng): Npc {
  const ch = state.ch;
  const sex: Sex = rng.chance(105 / 205) ? 'M' : 'F';
  const npc = makeNpc(state, rng, 'sibling', sex, state.year, { surname: ch.surname, closeness: 65, health: 88 });
  ch.npcs.push(npc);
  return npc;
}

export function parentsDivorce(state: GameState, withParent: 'mother' | 'father' = 'mother'): void {
  const ch = state.ch;
  ch.family.parentsMarried = false;
  ch.family.type = 'single_parent';
  const other = withParent === 'mother' ? 'father' : 'mother';
  for (const p of alive(ch, other)) p.closeness = Math.max(0, p.closeness - 20);
  ch.family.estate = Math.round(ch.family.estate * 0.55);
  ch.flags.parents_divorced = { since: ch.age };
}

export function changeCloseness(ch: Character, role: NpcRole | 'parents', delta: number, id?: string): void {
  for (const n of ch.npcs) {
    if (!n.alive) continue;
    if (id ? n.id === id : role === 'parents' ? n.role === 'mother' || n.role === 'father' : n.role === role) {
      n.closeness = Math.max(0, Math.min(100, n.closeness + delta));
    }
  }
}

// ── 해마다 ───────────────────────────────────────────────

const MOURNED: NpcRole[] = ['mother', 'father', 'grandparent', 'sibling', 'spouse', 'child'];

/**
 * NPC 1년: 노화, 사망, 관계 변화. 가까운 사람이 죽으면 다음 해 첫머리에 보여 줄 부고 카드를 돌려준다.
 */
export function npcYear(state: GameState, rng: Rng): PendingCard[] {
  const ch = state.ch;
  const cards: PendingCard[] = [];
  for (const n of ch.npcs) {
    if (!n.alive) continue;
    const age = npcAge(n, state.year);
    // 건강은 플레이어와 같은 기준점으로 돌아간다 (단순화)
    n.health += (healthTargetNpc(age) - n.health) * 0.2 + rng.normal(0, 3);
    n.health = Math.max(0, Math.min(100, n.health));
    if (rng.chance(npcDeathProbability(age, n.sex, n.health))) {
      n.alive = false;
      n.deathYear = state.year;
      n.deathCause = pickCauseByAge(age, n.sex, rng);
      if (n.role === 'spouse') ch.flags.widowed = { since: ch.age };
      if (MOURNED.includes(n.role)) {
        // 가까웠던 만큼 슬프다
        const grief = Math.round(5 + n.closeness / 6 + (n.role === 'child' ? 15 : n.role === 'spouse' ? 8 : 0));
        ch.stats.happiness = Math.max(0, ch.stats.happiness - grief);
        ch.state.stress = Math.min(100, ch.state.stress + Math.round(grief / 2));
        cards.push({
          eventId: 'npc_death',
          ctx: {
            고인: n.name,
            고인관계: roleLabel(n, ch),
            향년: String(age),
            사인: n.deathCause,
            npcId: n.id,
            closeness: String(Math.round(n.closeness)),
          },
        });
      }
      continue;
    }
    // 관계 변화: 친구는 만나지 않으면 멀어지고, 연인·배우자는 기준점 근처를 오르내린다
    if (n.role === 'friend') n.closeness -= 2;
    else if (n.role === 'partner') n.closeness += (62 - n.closeness) * 0.1 + rng.normal(0, 6);
    else if (n.role === 'spouse') n.closeness += (65 - n.closeness) * 0.1 + rng.normal(ch.state.stress > 70 ? -4 : 0, 4);
    else n.closeness += rng.normal(0, 2);
    n.closeness = Math.max(0, Math.min(100, n.closeness));
  }
  // 멀어진 친구는 연락이 끊긴다
  ch.npcs = ch.npcs.filter((n) => !(n.role === 'friend' && n.closeness < 10));
  // 학교에 다니면 친구는 저절로 생긴다
  const enrolled = ['elementary', 'middle', 'high', 'university'].includes(ch.edu.status);
  if (enrolled && alive(ch, 'friend').length < 2 && rng.chance(0.5)) addFriend(state, rng);
  // 오래 사귀어도 결혼하지 않으면 헤어지기도 한다
  const p = partnerOf(ch);
  if (p && (p.closeness < 30 || rng.chance(0.12))) breakUp(state);
  return cards;
}

function healthTargetNpc(age: number): number {
  if (age <= 30) return 88;
  if (age <= 50) return 88 - (age - 30) * 0.4;
  if (age <= 70) return 80 - (age - 50) * 0.7;
  if (age <= 85) return 66 - (age - 70) * 1.2;
  return Math.max(20, 48 - (age - 85) * 1.2);
}
