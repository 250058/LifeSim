// 저장: 브라우저 저장소. 시크릿 창처럼 저장소가 막힌 환경에서도 게임은 돌아가야 하므로
// 모든 읽기·쓰기를 try/catch로 감싼다.

import { normalizeSubstances } from './substances';
import type { Character, GameState, LifeSummary, Npc, NpcRole } from './types';

export const SAVE_VERSION = 1;
const SAVE_KEY = 'lifesim.save.v1';
const GRAVE_KEY = 'lifesim.graveyard.v1';
const MAX_GRAVES = 20;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function saveGame(state: GameState, storage = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SAVE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function loadGame(storage = defaultStorage()): GameState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SAVE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as GameState;
    if (state.v !== SAVE_VERSION || !state.ch) return null;
    // 술·담배·약물 기록: 옛 저장에는 없다 (읽을 때 빈 기록으로 본다). 있으면 빠진 값만 채운다
    normalizeSubstances(state);
    // 자녀로 이어 한 판: 고치기 전의 이어하기가 만든 불가능한 가족 기록을 바로잡는다
    repairHeirFamily(state);
    return state;
  } catch {
    return null;
  }
}

// ── 옛 저장 바로잡기 ─────────────────────────────────────

/** 성년 나이 (heir.ts의 ADULT_AGE와 같다) */
const ADULT_AGE = 19;
/** 미성년자에게는 있을 수 없는 관계. 연인은 학창 시절에도 생기므로 남긴다 */
const ADULT_ONLY_ROLES: NpcRole[] = ['spouse', 'ex', 'child'];

/**
 * 2대 이후의 옛 저장 (검토 R-006). 고치기 전의 이어하기는 미성년 후계자에게도 배우자를 붙였고, 혼인 나이를
 * 지금보다 뒤로, 또는 나나 상대가 미성년일 때로 잡기도 했다. 게임 안의 결혼은 둘 다 성년일 때만 하므로 이런 기록은
 * 그 생성기에서만 나온다. 불가능한 기록만 고친다:
 * - 미성년 후계자: 배우자·전 배우자·자녀를 지운다. 그 혼인 때문에 생긴 표시와 따로 산다는 기록도 되돌린다.
 * - 성년 후계자: 혼인 나이를 나와 상대가 모두 성년이 된 때부터 지금(상대가 세상을 떠났으면 그때)까지로 옮긴다.
 *   그런 때가 없으면(상대가 아직 미성년이거나 미성년일 때 세상을 떠났다) 혼인 기록을 지운다.
 * 아이가 혼인 나이보다 먼저 태어난 기록은 고치지 않는다. 혼인신고를 미루고 낳을 수 있고, 친부모는 heir.ts가
 * 짐작한다. 가능한 기록은 건드리지 않으므로 몇 번을 불러도 같다.
 */
function repairHeirFamily(state: GameState): void {
  if ((state.lineage?.generation ?? 1) < 2) return;
  const ch = state.ch;
  const minor = ch.age < ADULT_AGE;
  const kept = ch.npcs.filter((n) => (minor ? !ADULT_ONLY_ROLES.includes(n.role) : fitMarriageAge(ch, n)));
  if (kept.length === ch.npcs.length) return;
  ch.npcs = kept;
  // 지운 혼인에서 나온 표시: 남은 기록에 근거가 없으면 지운다
  if (!kept.some((n) => n.role === 'spouse' && !n.alive)) delete ch.flags.widowed;
  if (!kept.some((n) => n.role === 'ex')) delete ch.flags.divorced;
  if (minor) ch.family.livesWithParents = livesWithGuardian(ch);
}

/** 배우자·전 배우자의 혼인 나이를 가능한 범위로 옮긴다. 그런 범위가 없으면 false (기록을 지운다) */
function fitMarriageAge(ch: Character, n: Npc): boolean {
  if ((n.role !== 'spouse' && n.role !== 'ex') || n.since === undefined) return true;
  const earliest = Math.max(ADULT_AGE, n.birthYear + ADULT_AGE - ch.birthYear);
  const latest = n.alive || n.deathYear === undefined ? ch.age : Math.min(ch.age, n.deathYear - ch.birthYear);
  if (earliest > latest) return false;
  n.since = Math.min(Math.max(n.since, earliest), latest);
  return true;
}

/** 미성년 후계자가 보호자와 사는가: 이어할 때와 같은 값이다. 다만 그 뒤 부모를 모두 잃었으면 따로 산다 (game.ts와 같다) */
function livesWithGuardian(ch: Character): boolean {
  if (ch.family.type === 'facility') return false;
  if (ch.family.type === 'grandparents') return true;
  return ch.npcs.some((n) => (n.role === 'mother' || n.role === 'father') && n.alive && !n.missing);
}

export function clearSave(storage = defaultStorage()): void {
  try {
    storage?.removeItem(SAVE_KEY);
  } catch {
    // 저장소를 못 쓰면 지울 것도 없다
  }
}

export function loadGraveyard(storage = defaultStorage()): LifeSummary[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(GRAVE_KEY);
    return raw ? (JSON.parse(raw) as LifeSummary[]) : [];
  } catch {
    return [];
  }
}

export function addToGraveyard(summary: LifeSummary, storage = defaultStorage()): void {
  if (!storage) return;
  try {
    const list = loadGraveyard(storage).filter((s) => !(s.seed === summary.seed && s.deathYear === summary.deathYear && s.name === summary.name));
    list.unshift(summary);
    storage.setItem(GRAVE_KEY, JSON.stringify(list.slice(0, MAX_GRAVES)));
  } catch {
    // 무시
  }
}
