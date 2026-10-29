// 저장: 브라우저 저장소. 시크릿 창처럼 저장소가 막힌 환경에서도 게임은 돌아가야 하므로
// 모든 읽기·쓰기를 try/catch로 감싼다.

import type { GameState, LifeSummary } from './types';

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
    return state;
  } catch {
    return null;
  }
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
