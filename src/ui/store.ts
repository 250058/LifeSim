// 화면 상태 (Zustand). 엔진 함수는 상태를 직접 바꾸므로 여기서 복사본을 만들어 넘긴다.
// 행동 하나가 끝날 때마다 브라우저 저장소에 저장한다. 저장소가 막혀 있어도 게임은 돈다.

import { create } from 'zustand';
import { newGame } from '../engine/game';
import { continueAsChild } from '../engine/heir';
import { randomSeed } from '../engine/rng';
import { addToGraveyard, clearSave, loadGame, loadGraveyard, saveGame } from '../engine/save';
import type { Change, GameState, LifeSummary, Mode } from '../engine/types';

export type Sheet = 'activity' | 'relations' | 'assets' | 'career' | 'profile';

/** 새 인생의 기본 모드 (개정 계획: 현실). 드라마·막장은 고를 수 있고, 저장된 인생의 모드는 그대로 둔다 */
export const DEFAULT_MODE: Mode = 'reality';

export interface Notice {
  id: number;
  text: string;
  changes?: Change[];
  ok?: boolean;
}

interface Store {
  game: GameState | null;
  screen: 'title' | 'game';
  graves: LifeSummary[];
  sheet: Sheet | null;
  notice: Notice | null;
  adult: boolean;
  /** 새 인생. 모드를 고르지 않으면 DEFAULT_MODE */
  start(opts: { seed?: string | null; mode?: Mode; birthYear?: number }): void;
  /** 죽은 사람의 자녀로 이어 살기 */
  continueAs(childId: string): void;
  /** 저장된 인생으로 돌아가기 */
  resume(): void;
  toTitle(): void;
  setAdult(v: boolean): void;
  /** 엔진 함수를 복사본에 실행하고 저장한다 */
  act<T>(fn: (s: GameState) => T): T | undefined;
  openSheet(s: Sheet | null): void;
  notify(n: Omit<Notice, 'id'>): void;
  /** 다른 탭·업데이트에서 넘겨받은 상태 */
  restore(game: GameState | null): void;
}

const ADULT_KEY = 'lifesim.adult.v1';

function readAdult(): boolean {
  try {
    return localStorage.getItem(ADULT_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAdult(v: boolean): void {
  try {
    if (v) localStorage.setItem(ADULT_KEY, '1');
    else localStorage.removeItem(ADULT_KEY);
  } catch {
    // 저장소가 막혀 있으면 매번 확인한다
  }
}

let noticeId = 0;

const saved = loadGame();

export const useGame = create<Store>((set, get) => ({
  game: saved,
  // 새로고침하면 하던 인생으로 바로 돌아간다
  screen: saved ? 'game' : 'title',
  graves: loadGraveyard(),
  sheet: null,
  notice: null,
  adult: readAdult() || saved !== null,

  start({ seed, mode = DEFAULT_MODE, birthYear }) {
    // 기본값은 올해 출생. 같은 시드로 다시 태어날 때는 그 해를 그대로 쓴다
    const game = newGame({ seed: seed || randomSeed(), mode, birthYear: birthYear ?? new Date().getFullYear() });
    saveGame(game);
    set({ game, screen: 'game', sheet: null, notice: null });
  },

  continueAs(childId) {
    const prev = get().game;
    if (!prev) return;
    const game = continueAsChild(prev, childId);
    if (!game) return;
    saveGame(game);
    set({ game, screen: 'game', sheet: null, notice: null });
  },

  resume() {
    const game = get().game ?? loadGame();
    if (game) set({ game, screen: 'game', sheet: null });
  },

  toTitle() {
    set({ screen: 'title', sheet: null, notice: null, graves: loadGraveyard() });
  },

  setAdult(v) {
    writeAdult(v);
    set({ adult: v });
  },

  act(fn) {
    const current = get().game;
    if (!current) return undefined;
    const next = structuredClone(current);
    const result = fn(next);
    if (next.phase === 'dead' && next.summary && current.phase !== 'dead') {
      addToGraveyard(next.summary);
      set({ graves: loadGraveyard(), sheet: null });
    }
    saveGame(next);
    set({ game: next });
    return result;
  },

  openSheet(sheet) {
    // 시트를 바꾸면 지난 결과 알림은 지운다
    set({ sheet, notice: null });
  },

  notify(n) {
    noticeId += 1;
    set({ notice: { ...n, id: noticeId } });
  },

  restore(game) {
    if (!game) return;
    saveGame(game);
    set({ game, screen: 'game' });
  },
}));

/** 죽은 인생을 지우고 제목 화면으로 */
export function abandonLife(): void {
  clearSave();
  useGame.setState({ game: null, screen: 'title', sheet: null, notice: null, graves: loadGraveyard() });
}
