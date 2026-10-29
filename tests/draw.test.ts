// 사건 추첨 검사: 발생과 표시의 분리(R-001), 0 확률(R-004), 생활 사건 풀의 정확한 가중 추첨과 조용한 해.
// 시험용 사건은 EVENTS에 잠깐 넣었다가 테스트가 끝나면 뺀다.
//
// presentCard는 감싸 둔다(vi.mock): 실제 게임 루프(endTurn·choose·proceed)가 사건을 하나 일으킬 때마다
// 그 직전·직후 상태를 감시 함수가 볼 수 있다. 감시 함수를 걸지 않으면 원래 함수와 똑같이 동작한다.

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluate } from '../src/engine/conditions';
import { EVENTS, EVENT_BY_ID } from '../src/engine/data';
import {
  ageFactor,
  drawPool,
  drawYearEvents,
  eventProbability,
  limitOk,
  P_FLOOR,
  poolCandidates,
  presentCard,
  recordsAsDiary,
  resetEventIndex,
  triggerOk,
} from '../src/engine/eventEngine';
import { choose, doActivity, endTurn, newGame, proceed } from '../src/engine/game';
import { POOL_FULL_WEIGHT, POOL_IDS, poolWeights, poolYearChance } from '../src/engine/pools';
import { Rng } from '../src/engine/rng';
import { loadGame, saveGame } from '../src/engine/save';
import { buildScope } from '../src/engine/scope';
import type { ChoiceDef, EventDef, PoolId } from '../src/engine/schema';
import { simulateLife } from '../src/engine/sim';
import type { GameState, LogEntry, Mode, PendingCard, Phase } from '../src/engine/types';
import { GameScreen } from '../src/ui/GameScreen';

/** presentCard 한 번의 기록 */
interface Presented {
  ev: EventDef;
  /** 살아 있고 조건·제한이 맞았다: 일어나야 하는 사건 */
  eligible: boolean;
  /** 카드로 멈췄다 */
  shown: boolean;
  serialUp: number;
  countUp: number;
  logAdded: number;
  lastLog?: LogEntry;
  card?: { eventId: string; choices: number; hasResult: boolean };
  phase: Phase;
  /** 일으킨 직후 살아 있는가 */
  aliveAfter: boolean;
  /** 감시 함수 안에서만 쓴다 (인생이 끝나면 마지막 상태가 된다) */
  state: GameState;
}

const watch = vi.hoisted(() => ({ onPresent: undefined as undefined | ((p: Presented) => void) }));

vi.mock('../src/engine/eventEngine', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/engine/eventEngine')>();
  const { EVENT_BY_ID: byId } = await import('../src/engine/data');
  const { buildScope: scopeOf } = await import('../src/engine/scope');
  return {
    ...real,
    presentCard(state: GameState, pending: PendingCard): boolean {
      const hook = watch.onPresent;
      if (!hook) return real.presentCard(state, pending);
      const ev = byId.get(pending.eventId)!;
      const eligible = state.ch.alive && real.triggerOk(ev, scopeOf(state, pending.ctx), state) && real.limitOk(ev, state);
      const before = { serial: state.serial, log: state.log.length, count: state.counts[ev.id] ?? 0 };
      const shown = real.presentCard(state, pending);
      const card = state.card;
      hook({
        ev,
        eligible,
        shown,
        serialUp: state.serial - before.serial,
        countUp: (state.counts[ev.id] ?? 0) - before.count,
        logAdded: state.log.length - before.log,
        lastLog: state.log[state.log.length - 1],
        card: card ? { eventId: card.eventId, choices: card.choices.length, hasResult: card.result !== undefined } : undefined,
        phase: state.phase,
        aliveAfter: state.ch.alive,
        state,
      });
      return shown;
    },
  };
});

const added: EventDef[] = [];

/** 시험용 사건을 넣는다. front면 EVENTS 맨 앞에 (추첨 순서상 실제 사건보다 먼저 굴린다) */
function addEvents(evs: EventDef[], front = false): void {
  for (const ev of evs) {
    if (front) EVENTS.unshift(ev);
    else EVENTS.push(ev);
    EVENT_BY_ID.set(ev.id, ev);
    added.push(ev);
  }
  resetEventIndex();
}

afterEach(() => {
  watch.onPresent = undefined;
  for (const ev of added.splice(0)) {
    EVENTS.splice(EVENTS.indexOf(ev), 1);
    EVENT_BY_ID.delete(ev.id);
  }
  resetEventIndex();
});

const TWO_CHOICES: ChoiceDef[] = [
  { text: '그렇게 한다', result: '그렇게 했다.' },
  { text: '그냥 둔다', result: '그냥 뒀다.' },
];

/** 시험용 일반 사건: draw_test 태그가 있을 때만 후보가 된다 */
function testEvent(id: string, extra: Partial<EventDef> = {}): EventDef {
  return {
    id,
    type: 'random',
    title: `시험 ${id}`,
    text: '시험용 사건.',
    tone: 'neutral',
    impact: 5,
    trigger: { flags: ['draw_test'] },
    weight: { base: 0.95, noMode: true },
    limit: { oncePerLife: true },
    choices: TWO_CHOICES,
    ...extra,
  } as EventDef;
}

/** 시험용 풀 사건 */
function poolEvent(id: string, pool: PoolId, extra: Partial<EventDef> = {}): EventDef {
  return {
    id,
    type: 'random',
    pool,
    group: id,
    title: `풀 시험 ${id}`,
    text: '시험용 생활 사건.',
    tone: 'neutral',
    impact: 3,
    trigger: { age: [3, 100] },
    weight: { base: 0.5, noMode: true },
    limit: { oncePerLife: true },
    choices: TWO_CHOICES,
    ...extra,
  } as EventDef;
}

/** 30세 여성. 시드마다 다른 사람이 태어난다 */
function adult(seed: string, mode: Mode = 'reality'): GameState {
  const s = newGame({ seed, mode, birthYear: 2026 });
  s.ch.sex = 'F';
  s.ch.age = 30;
  s.year = 2056;
  s.world.year = s.year;
  s.ch.flags.draw_test = { since: 30 };
  return s;
}

/** 갓 태어난 아기 (0세): 생활 사건 풀의 후보가 아주 적은 나이 */
function baby(seed: string): GameState {
  const s = newGame({ seed, mode: 'reality', birthYear: 2026 });
  s.ch.flags.draw_test = { since: 0 };
  return s;
}

/** 같은 사람으로 난수 시드만 바꾼다 (추첨 함수는 상태를 바꾸지 않으므로 그대로 다시 쓴다) */
function reseed(s: GameState, seed: string): GameState {
  s.seed = seed;
  return s;
}

/** 한 해를 넘긴다: 카드가 뜨면 플레이어처럼 첫 선택지를 고른다. 뜬 카드의 사건 id 목록 */
function playYear(s: GameState): string[] {
  const shown: string[] = [];
  endTurn(s);
  for (let guard = 0; guard < 100 && s.phase === 'event'; guard++) {
    const card = s.card!;
    shown.push(card.eventId);
    if (card.choices.length > 0 && !card.result) choose(s, 0);
    proceed(s);
  }
  return shown;
}

/** 이항 비율의 허용 오차 (표준오차의 k배) */
function tolerance(p: number, n: number, k = 4.5): number {
  return k * Math.sqrt((p * (1 - p)) / n);
}

/** 이 상태에서 한 사건이 그해 풀 카드로 뽑힐 확률 (계산값): c × (풀 비율) × w / max(W, 꽉 찬 기준) */
function expectedShare(s: GameState, id: string): number {
  const w = poolWeights(s);
  const wTotal = POOL_IDS.reduce((sum, p) => sum + Math.max(0, w[p]), 0);
  let share = 0;
  for (const p of POOL_IDS) {
    if (!(w[p] > 0)) continue;
    const cands = poolCandidates(s, p);
    const total = cands.reduce((sum, c) => sum + c.w, 0);
    const mine = cands.find((c) => c.ev.id === id);
    if (mine) share += (w[p] / wTotal) * (mine.w / Math.max(total, POOL_FULL_WEIGHT));
  }
  return poolYearChance(s.mode) * share;
}

/** 한 풀의 조건 맞는 후보 가중치 합 */
function poolTotal(s: GameState, pool: PoolId): number {
  return poolCandidates(s, pool).reduce((sum, c) => sum + c.w, 0);
}

/** 그해 풀 장면이 하나라도 나올 확률 (계산값): c × Σ (풀 비율 × min(1, W / 꽉 찬 기준)) */
function expectedCardChance(s: GameState): number {
  const w = poolWeights(s);
  const wTotal = POOL_IDS.reduce((sum, p) => sum + Math.max(0, w[p]), 0);
  let filled = 0;
  for (const p of POOL_IDS) if (w[p] > 0) filled += (w[p] / wTotal) * Math.min(1, poolTotal(s, p) / POOL_FULL_WEIGHT);
  return poolYearChance(s.mode) * filled;
}

// ── 실제 게임 루프를 도는 간단한 봇 ──────────────────────

const BOT_ACTS = ['study', 'exercise', 'rest', 'friends'];

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

type Step = 'activity' | 'turn' | 'choose' | 'proceed';

interface PlayOptions {
  /** 엔진을 부르기 전마다 저장했다가 불러온 상태로 이어 간다 */
  roundtrip?: boolean;
  beforeTurn?: (s: GameState) => void;
  after?: (s: GameState, step: Step) => void;
}

/** 해마다 활동을 조금 하고 카드는 아무 선택지나 고르는 봇으로 한 인생을 끝까지 산다 */
function playLife(seed: string, mode: Mode, opts: PlayOptions = {}): GameState {
  let s = newGame({ seed, mode, birthYear: 2026 });
  const bot = new Rng(`bot|${seed}`);
  const storage = new MemoryStorage();
  for (let guard = 0; guard < 20_000 && s.phase !== 'dead'; guard++) {
    if (opts.roundtrip) {
      expect(saveGame(s, storage)).toBe(true);
      s = loadGame(storage)!;
    }
    if (s.phase === 'action') {
      if (s.points.left > 0 && bot.chance(0.5)) {
        doActivity(s, bot.pick(BOT_ACTS));
        opts.after?.(s, 'activity');
      } else {
        opts.beforeTurn?.(s);
        endTurn(s);
        opts.after?.(s, 'turn');
      }
    } else if (s.phase === 'event') {
      const card = s.card!;
      if (card.choices.length > 0 && !card.result) {
        choose(s, bot.int(0, card.choices.length - 1));
        opts.after?.(s, 'choose');
      } else {
        proceed(s);
        opts.after?.(s, 'proceed');
      }
    }
  }
  expect(s.phase, seed).toBe('dead');
  return s;
}

/**
 * 일기·카드 경로를 모두 지나가게 하는 시험 사건들 (실제 사건과 함께 섞여 일어난다):
 * 작은 사건(일기), 일기 → 일기 → 결정 카드 사슬, n년 뒤 일기, 선택지가 모두 숨은 사건, 풀의 일기, 큰 사건(선택지 없는 카드)
 */
function probeEvents(): EventDef[] {
  const mark = { addFlags: ['draw_probe_mark'] };
  const drawn = (id: string, extra: Partial<EventDef>): EventDef =>
    ({
      id,
      type: 'random',
      title: `탐침 ${id}`,
      text: '작은 일이 있었다.',
      tone: 'neutral',
      impact: 4,
      weight: { base: 0.3, noMode: true },
      limit: { cooldown: 1 },
      effects: mark,
      ...extra,
    }) as EventDef;
  const chained = (id: string, extra: Partial<EventDef>): EventDef =>
    ({ id, type: 'chain', title: `탐침 ${id}`, text: '이어진 일.', tone: 'neutral', impact: 3, effects: mark, ...extra }) as EventDef;
  return [
    drawn('draw_probe_quiet', {}),
    drawn('draw_probe_chain', { next: 'draw_probe_link' }),
    chained('draw_probe_link', { next: 'draw_probe_decide' }),
    chained('draw_probe_decide', { choices: TWO_CHOICES }),
    drawn('draw_probe_later', { effects: { ...mark, later: [{ event: 'draw_probe_after', inYears: 1 }] } }),
    chained('draw_probe_after', {}),
    drawn('draw_probe_hidden', { choices: [{ text: '숨은 선택', if: 'age > 500' }], next: 'draw_probe_after' }),
    drawn('draw_probe_pool', { pool: 'physiology', weight: { base: 1, noMode: true, modifiers: [{ if: 'age >= 0', x: 50 }] } }),
    drawn('draw_probe_big', { impact: 25, tone: 'drama', weight: { base: 0.1, noMode: true }, effects: undefined }),
  ];
}

describe('발생과 표시의 분리 (R-001)', () => {
  it('독립 사건 4개가 같은 해에 모두 일어나면 4개 모두 상태와 기록에 남는다', () => {
    const four = [0, 1, 2, 3].map((i) =>
      testEvent(`draw_four_${i}`, { effects: { addFlags: [`draw_four_done_${i}`] } }),
    );
    addEvents(four);
    let allFour = 0;
    let firedTotal = 0;
    const seeds = 60;
    for (let i = 0; i < seeds; i++) {
      const s = adult(`FOUR-${i}`);
      // 같은 상태의 복사본으로 이번 해에 무엇이 일어날지 미리 본다 (추첨은 시드와 상태로만 정해진다)
      const fired = drawYearEvents(structuredClone(s))
        .map((p) => p.eventId)
        .filter((id) => id.startsWith('draw_four_'));
      firedTotal += fired.length;
      if (fired.length === 4) allFour++;
      const shown = playYear(s);
      // 그해 다른 사건으로 죽었다면 남은 사건은 일어나지 않는 게 맞다
      if (!s.ch.alive) continue;
      for (const ev of four) {
        const i4 = ev.id.slice(-1);
        const happened = fired.includes(ev.id);
        // 일어난 사건은 효과·횟수·기록이 모두 남고, 결정이 필요하니 카드로 떴다
        expect(Boolean(s.ch.flags[`draw_four_done_${i4}`]), ev.id).toBe(happened);
        expect(s.counts[ev.id] ?? 0, ev.id).toBe(happened ? 1 : 0);
        expect(shown.includes(ev.id), ev.id).toBe(happened);
        expect(s.log.some((e) => e.title === ev.title), ev.id).toBe(happened);
      }
    }
    // 예전에는 연간 상한(현실 모드 3개) 때문에 4개가 함께 남는 해가 없었다
    expect(allFour).toBeGreaterThan(seeds / 2);
    expect(firedTotal / seeds).toBeGreaterThan(3.5);
  });

  it('같은 조건의 사건 10개(각 0.95)는 해마다 평균 9.5개 일어난다', () => {
    addEvents(Array.from({ length: 10 }, (_, i) => testEvent(`draw_ten_${i}`)));
    let total = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      total += drawYearEvents(adult(`TEN-${i}`)).filter((p) => p.eventId.startsWith('draw_ten_')).length;
    }
    expect(Math.abs(total / n - 9.5)).toBeLessThan(0.15);
  });

  it('무관한 사건을 더해도 기존 사건의 발생률이 그대로다', () => {
    addEvents([testEvent('draw_target', { weight: { base: 0.3, noMode: true } })]);
    const n = 2000;
    const modes: Mode[] = ['reality', 'drama'];
    const rate = (mode: Mode) => {
      let hits = 0;
      for (let i = 0; i < n; i++) {
        if (drawYearEvents(adult(`RATE-${i}`, mode)).some((p) => p.eventId === 'draw_target')) hits++;
      }
      return hits / n;
    };
    const before = modes.map(rate);
    // 같은 사람에게 늘 일어날 법한 사건 10개를 더한다 (예전에는 상한 3개를 나눠 가져 0.08 안팎으로 떨어졌다)
    addEvents(Array.from({ length: 10 }, (_, i) => testEvent(`draw_noise_${i}`)));
    const after = modes.map(rate);
    for (const [i, mode] of modes.entries()) {
      expect(Math.abs(before[i] - 0.3), mode).toBeLessThan(tolerance(0.3, n));
      expect(Math.abs(after[i] - 0.3), mode).toBeLessThan(tolerance(0.3, n));
    }
  });

  it('조건이 맞지 않는 사건을 더해도 같은 시드의 추첨 결과가 그대로다', () => {
    const seeds = Array.from({ length: 150 }, (_, i) => `SAME-${i}`);
    const before = seeds.map((seed) => JSON.stringify(drawYearEvents(adult(seed))));
    addEvents(
      Array.from({ length: 500 }, (_, i) =>
        testEvent(`draw_ineligible_${i}`, {
          trigger: i % 2 === 0 ? { flags: ['draw_never'] } : { age: [90, 99] },
        }),
      ),
    );
    const after = seeds.map((seed) => JSON.stringify(drawYearEvents(adult(seed))));
    expect(after).toEqual(before);
  });

  it('결정할 것이 없는 작은 사건은 카드 없이 일기로 남고, 큰 사건과 결정할 사건은 카드로 기다린다', () => {
    addEvents([
      testEvent('draw_quiet', {
        title: '조용한 사건',
        choices: undefined,
        effects: { stats: { happiness: 3 }, addFlags: ['draw_quiet_done'] },
      }),
      testEvent('draw_loud', { title: '큰 사건', impact: 30, tone: 'drama', choices: undefined }),
      testEvent('draw_decide', { title: '고를 사건' }),
    ]);
    const s = adult('DIARY');
    s.ch.stats.happiness = 50;

    expect(presentCard(s, { eventId: 'draw_quiet', ctx: {} })).toBe(false);
    expect(s.card).toBeUndefined();
    expect(s.ch.flags.draw_quiet_done).toBeTruthy();
    expect(s.counts.draw_quiet).toBe(1);
    const diary = s.log[s.log.length - 1];
    expect(diary.title).toBe('조용한 사건');
    expect(diary.text).toContain('행복 +3');

    expect(presentCard(s, { eventId: 'draw_loud', ctx: {} })).toBe(true);
    expect(s.card?.eventId).toBe('draw_loud');
    expect(s.card?.choices).toEqual([]);
    proceed(s);
    expect(s.card).toBeUndefined();

    expect(presentCard(s, { eventId: 'draw_decide', ctx: {} })).toBe(true);
    expect(s.card?.eventId).toBe('draw_decide');
    // 엔진은 대신 고르지 않는다: 선택 전에는 넘길 수 없다
    proceed(s);
    expect(s.card?.eventId).toBe('draw_decide');
    expect(s.card?.result).toBeUndefined();
    choose(s, 1);
    expect(s.card?.result?.choice).toBe('그냥 둔다');
  });

  it('카드 기준: 선택지·충격량·비극·사망·연출 장면', () => {
    const base = testEvent('draw_rule', { choices: undefined, impact: 19 });
    expect(recordsAsDiary(base, 0)).toBe(true);
    expect(recordsAsDiary(base, 2)).toBe(false);
    expect(recordsAsDiary({ ...base, impact: 20 }, 0)).toBe(false);
    expect(recordsAsDiary({ ...base, tone: 'tragedy' }, 0)).toBe(false);
    expect(recordsAsDiary({ ...base, effects: { death: '사고' } }, 0)).toBe(false);
    expect(recordsAsDiary({ ...base, zoom: '12월 · 성적 발표' }, 0)).toBe(false);
  });

  it('작은 자동 사건이 일어난 해에도 게임은 같은 시드로 같은 인생을 산다', () => {
    const a = simulateLife('DRAW-SAME', { mode: 'reality' });
    const b = simulateLife('DRAW-SAME', { mode: 'reality' });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('실제 게임 루프에서 일어난 사건은 빠짐없이 효과·기록이 남고, 선택은 플레이어만 한다', () => {
    addEvents(probeEvents());
    const seen: Presented[] = [];
    let marks = 0;
    watch.onPresent = (p) => {
      seen.push(p);
      // 일기 탐침은 일어날 때마다 표식 태그를 남긴다: 효과가 실제로 적용됐는지 보고 다음을 위해 지운다
      if (p.eligible && p.ev.effects?.addFlags?.includes('draw_probe_mark')) {
        expect(p.state.ch.flags.draw_probe_mark, p.ev.id).toBeTruthy();
        delete p.state.ch.flags.draw_probe_mark;
        marks++;
      }
    };
    let undelivered = 0;
    for (let i = 0; i < 16; i++) {
      let drawn: string[] = [];
      let from = 0;
      playLife(`LOOP-${i}`, i % 2 ? 'drama' : 'reality', {
        beforeTurn: (s) => {
          // 이번 해에 추첨될 사건을 복사본으로 미리 본다 (실제 endTurn도 같은 시드·상태로 같은 결과를 낸다)
          drawn = drawYearEvents(structuredClone(s)).map((p) => p.eventId);
          from = seen.length;
        },
        after: (s, step) => {
          // 멈춘 단계: 카드가 있을 때만 사건 단계이고, 그 밖에는 대기열이 비어 있다 (화면이 멈추지 않는다)
          expect(s.phase === 'event', step).toBe(s.card !== undefined);
          if (s.phase !== 'event') expect(s.queue, step).toEqual([]);
          // 엔진은 대신 고르지 않는다: 선택지가 있는 카드는 플레이어가 고르기 전까지 결과가 없다
          if (s.card && step !== 'choose' && s.card.choices.length > 0) expect(s.card.result, step).toBeUndefined();
          // 한 해가 끝나 다시 행동 단계가 되면, 그해 추첨된 사건은 모두 일으키기(presentCard)까지 갔다
          if (s.phase === 'action' && drawn.length > 0 && step !== 'activity') {
            const reached = new Set(seen.slice(from).map((p) => p.ev.id));
            undelivered += drawn.filter((id) => !reached.has(id)).length;
            drawn = [];
          }
        },
      });
    }
    expect(undelivered).toBe(0);

    for (const p of seen) {
      const where = p.ev.id;
      if (!p.eligible) {
        // 그사이 조건이 깨졌거나 이미 죽었다: 아무것도 바뀌지 않는다
        expect([p.serialUp, p.countUp, p.logAdded], where).toEqual([0, 0, 0]);
        continue;
      }
      // 일어난 사건은 횟수가 하나 오르고 일련번호를 받는다 (새 인물이 생기면 인물 번호도 같은 일련번호를 쓴다)
      expect(p.countUp, where).toBe(1);
      expect(p.serialUp, where).toBeGreaterThanOrEqual(1);
      if (p.shown) {
        expect(p.card?.eventId, where).toBe(p.ev.id);
        expect(p.phase, where).toBe('event');
        expect(p.card?.hasResult, where).toBe(false);
        // 선택지 없는 카드는 뜰 때 기록하고, 선택지 있는 카드는 고를 때 기록한다
        if (p.card!.choices === 0) expect(p.logAdded, where).toBeGreaterThanOrEqual(1);
      } else {
        // 카드 없이 지나간 사건: 결정할 것이 없던 작은 사건이고 일기 한 줄을 남겼다
        expect(p.card, where).toBeUndefined();
        expect(recordsAsDiary(p.ev, 0), where).toBe(true);
        expect(p.logAdded, where).toBeGreaterThanOrEqual(1);
        expect(p.lastLog?.kind, where).toBe(p.ev.type === 'milestone' ? 'milestone' : 'event');
        expect(p.lastLog?.impact, where).toBe(p.ev.impact ?? 0);
      }
    }
    // 탐침이 모든 경로를 실제로 지나갔다
    const diaryOf = (id: string) => seen.filter((p) => p.ev.id === id && p.eligible && !p.shown).length;
    expect(diaryOf('draw_probe_quiet')).toBeGreaterThan(100);
    expect(diaryOf('draw_probe_link')).toBeGreaterThan(50);
    expect(diaryOf('draw_probe_after')).toBeGreaterThan(50);
    expect(diaryOf('draw_probe_hidden')).toBeGreaterThan(50);
    expect(diaryOf('draw_probe_pool')).toBeGreaterThan(10);
    expect(seen.filter((p) => p.ev.id === 'draw_probe_big' && p.shown).length).toBeGreaterThan(10);
    expect(marks).toBeGreaterThan(500);
    // 일기 → 일기 → 결정 카드: 사슬은 바로 이어지고 마지막 결정은 카드로 기다린다
    let chains = 0;
    for (let j = 0; j + 2 < seen.length; j++) {
      if (seen[j].ev.id !== 'draw_probe_chain' || !seen[j].eligible || !seen[j].aliveAfter) continue;
      chains++;
      expect(seen[j + 1].ev.id).toBe('draw_probe_link');
      expect(seen[j + 2].ev.id).toBe('draw_probe_decide');
      expect(seen[j + 2].shown).toBe(true);
    }
    expect(chains).toBeGreaterThan(50);
    // 실제 사건 카드도 많이 지나갔다 (탐침만 본 게 아니다)
    expect(seen.filter((p) => p.shown && !p.ev.id.startsWith('draw_probe_') && p.card!.choices > 0).length).toBeGreaterThan(500);
  });

  it('카드 없이 지나간 사건은 화면의 인생 기록에 한 줄로 보이고, 결정할 사건은 카드로 떠서 기다린다', () => {
    addEvents([
      testEvent('draw_ui_quiet', {
        title: '조용한 장면',
        text: '창밖에 첫눈이 왔다.',
        choices: undefined,
        effects: { stats: { happiness: 2 } },
      }),
      testEvent('draw_ui_decide', { title: '고를 장면' }),
    ]);
    // 두 사건이 함께 일어나는 시드를 고른다
    let seed = '';
    for (let i = 0; i < 50 && !seed; i++) {
      const ids = drawYearEvents(adult(`UI-${i}`)).map((p) => p.eventId);
      if (ids.includes('draw_ui_quiet') && ids.includes('draw_ui_decide')) seed = `UI-${i}`;
    }
    const s = adult(seed);
    s.ch.stats.happiness = 50;
    const render = () => renderToString(createElement(GameScreen, { game: s }));
    const nextLocked = (html: string) => /class="tab next"[^>]*disabled/.test(html);
    expect(nextLocked(render())).toBe(false);

    endTurn(s);
    // 그해 다른 실제 사건 카드가 먼저 뜨면 첫 선택지로 넘긴다
    for (let guard = 0; guard < 50 && s.phase === 'event' && s.card!.eventId !== 'draw_ui_decide'; guard++) {
      if (s.card!.choices.length > 0) choose(s, 0);
      proceed(s);
    }
    expect(s.card?.eventId).toBe('draw_ui_decide');
    let html = render();
    // 일기 한 줄: 제목과 본문, 바뀐 수치
    expect(html).toContain('조용한 장면');
    expect(html).toContain('창밖에 첫눈이 왔다. (행복 +2)');
    // 결정할 사건은 카드(대화상자)로 떠 있고 선택지 두 개가 보인다. 그동안 +1년은 잠긴다
    expect(html).toContain('role="dialog"');
    expect(html).toContain('고를 장면');
    expect((html.match(/class="choice"/g) ?? []).length).toBe(2);
    expect(nextLocked(html)).toBe(true);

    choose(s, 0);
    html = render();
    expect(html).toContain('계속');
    proceed(s);
    for (let guard = 0; guard < 50 && s.phase === 'event'; guard++) {
      if (s.card!.choices.length > 0 && !s.card!.result) choose(s, 0);
      proceed(s);
    }
    // 카드를 모두 넘기면 다음 해의 행동 단계로 돌아온다: 대화상자가 닫히고 +1년이 다시 열린다
    expect(s.phase).toBe('action');
    html = render();
    expect(html).not.toContain('role="dialog"');
    expect(nextLocked(html)).toBe(false);
    expect(html).toContain('조용한 장면');
  });
});

describe('0 확률 (R-004)', () => {
  it('인수 하나가 0이면 P = 0이고, 양수인 희귀 확률만 바닥값을 받는다', () => {
    const byModifier = testEvent('draw_zero_mod', { weight: { base: 0.5, modifiers: [{ if: 'age >= 0', x: 0 }] } });
    const byCurve = testEvent('draw_zero_curve', { weight: { base: 0.5, ageCurve: { '0': 0, '100': 0 } } });
    const tiny = testEvent('draw_tiny', { weight: { base: 1e-9, noMode: true } });
    addEvents([byModifier, byCurve, tiny]);
    for (const mode of ['reality', 'drama', 'makjang'] as Mode[]) {
      const s = adult('ZERO', mode);
      expect(eventProbability(byModifier, s).P, mode).toBe(0);
      expect(eventProbability(byCurve, s).P, mode).toBe(0);
      expect(eventProbability(tiny, s).P, mode).toBe(P_FLOOR);
    }
    for (let i = 0; i < 1500; i++) {
      const ids = drawYearEvents(adult(`ZERO-${i}`, i % 2 ? 'drama' : 'makjang')).map((p) => p.eventId);
      expect(ids).not.toContain('draw_zero_mod');
      expect(ids).not.toContain('draw_zero_curve');
    }
  });

  it('확률 0인 사건은 주사위도 굴리지 않아, 실제 사건보다 앞에 더해도 같은 시드의 결과가 그대로다', () => {
    const seeds = Array.from({ length: 150 }, (_, i) => `INERT-${i}`);
    const before = seeds.map((seed) => JSON.stringify(drawYearEvents(adult(seed, 'drama'))));
    // 조건은 맞지만(태그 있음) 보정 ×0·나이 곡선 0이라 불가능한 사건 40개를 추첨 순서 맨 앞에 끼운다
    const impossible = Array.from({ length: 40 }, (_, i) =>
      testEvent(`draw_inert_${i}`, {
        filler: true,
        impact: 3,
        weight: i % 2 ? { base: 0.5, modifiers: [{ if: 'flags.draw_test', x: 0 }] } : { base: 0.5, ageCurve: { '0': 0, '120': 0 } },
      }),
    );
    addEvents(impossible, true);
    for (const ev of impossible.slice(0, 2)) expect(eventProbability(ev, adult('INERT')).P).toBe(0);
    const after = seeds.map((seed) => JSON.stringify(drawYearEvents(adult(seed, 'drama'))));
    // 예전에는 이 사건들도 주사위를 하나씩 써서 뒤에 오는 모든 사건의 결과가 바뀌었다
    expect(after).toEqual(before);
  });

  it('드라마 모드의 빈 해 채우기에도 확률 0인 일상 사건은 들어가지 않는다', () => {
    addEvents([
      testEvent('draw_zero_filler', {
        filler: true,
        impact: 3,
        choices: undefined,
        weight: { base: 0.5, modifiers: [{ if: 'flags.draw_test', x: 0 }] },
      }),
    ]);
    for (let i = 0; i < 600; i++) {
      const s = adult(`FILL-${i}`, i % 2 ? 'drama' : 'makjang');
      // 평온한 해가 길어 격동: 그해 사건이 2개보다 적으면 일상 사건으로 채운다
      s.director.calmYears = 5;
      expect(drawYearEvents(s).map((p) => p.eventId)).not.toContain('draw_zero_filler');
    }
  });

  it('가중치가 0인 풀 사건은 후보에서 빠지고 뽑히지 않는다', () => {
    addEvents([
      poolEvent('draw_pool_zero', 'physiology', {
        trigger: { age: [3, 100], flags: ['draw_test'] },
        weight: { base: 1, noMode: true, modifiers: [{ if: 'age >= 0', x: 0 }] },
      }),
    ]);
    const s = adult('POOL-ZERO');
    expect(poolCandidates(s, 'physiology').some((c) => c.ev.id === 'draw_pool_zero')).toBe(false);
    for (let i = 0; i < 1000; i++) expect(drawPool(adult(`POOL-ZERO-${i}`))?.id).not.toBe('draw_pool_zero');
  });

  it('풀의 하나뿐인 후보가 가중치 0이면 그 자리는 조용한 해이고, 다른 풀로 넘어가지 않는다', () => {
    const s = baby('ONLY-ZERO');
    const n = 3000;
    const seeds = Array.from({ length: n }, (_, i) => `ONLY-ZERO-${i}`);
    const before = seeds.map((seed) => drawPool(reseed(s, seed))?.id ?? '-');
    addEvents([
      poolEvent('draw_only_zero', 'physiology', {
        trigger: { age: [0, 2], flags: ['draw_test'] },
        weight: { base: 1, noMode: true, modifiers: [{ if: 'flags.draw_test', x: 0 }] },
      }),
    ]);
    expect(poolTotal(s, 'physiology')).toBe(0);
    const after = seeds.map((seed) => drawPool(reseed(s, seed))?.id ?? '-');
    expect(after).not.toContain('draw_only_zero');
    expect(after).toEqual(before);
    // 몸 풀의 몫은 다른 풀로 가지 않는다: 장면이 나오는 비율은 c × Σ(풀 비율 × min(1, W / 20))이고 몸 풀은 0이다
    // (예전에는 몸 풀 몫이 병원·밥상으로 넘어가 거의 해마다 c만큼 장면이 나왔다)
    const expected = expectedCardChance(s);
    const shown = after.filter((id) => id !== '-').length / n;
    expect(Math.abs(shown - expected)).toBeLessThan(tolerance(expected, n));
    expect(shown).toBeLessThan(poolYearChance('reality') / 3);
  });
});

describe('생활 사건 풀의 정확한 가중 추첨', () => {
  it('나이·성별 색인으로 고른 후보와 가중치는 풀 사건 전체를 하나하나 따진 결과와 같다', () => {
    const pools: PoolId[] = ['physiology', 'nutrition', 'romance', 'parenting', 'medical'];
    for (const age of [0, 2, 3, 6, 7, 12, 13, 15, 16, 18, 19, 20, 29, 30, 49, 50, 64, 65, 80, 100, 110]) {
      for (const sex of ['M', 'F'] as const) {
        const s = newGame({ seed: `INDEX-${age}-${sex}`, mode: 'reality', birthYear: 2026 });
        s.ch.sex = sex;
        s.ch.age = age;
        s.year = 2026 + age;
        const scope = buildScope(s);
        for (const pool of pools) {
          const brute = EVENTS.filter((ev) => ev.pool === pool && ev.weight && ev.type !== 'chain' && ev.type !== 'milestone')
            .filter((ev) => limitOk(ev, s) && triggerOk(ev, scope, s))
            .map((ev) => {
              const w = ev.weight!;
              let x = w.base * ageFactor(w.ageCurve, age);
              for (const m of w.modifiers ?? []) if (evaluate(m.if, scope)) x *= m.x;
              return { id: ev.id, w: x };
            })
            .filter((c) => c.w > 0);
          const indexed = poolCandidates(s, pool, scope).map((c) => ({ id: c.ev.id, w: c.w }));
          expect(indexed, `${pool} ${sex} ${age}`).toEqual(brute);
        }
      }
    }
  });

  it('조건이 맞지 않는 풀 후보를 아무리 더해도 유효 사건이 뽑힐 확률은 그대로다', () => {
    addEvents([
      poolEvent('draw_pool_target', 'nutrition', {
        trigger: { age: [3, 100], flags: ['draw_test'] },
        weight: { base: 1, noMode: true, modifiers: [{ if: 'flags.draw_test', x: 200 }] },
      }),
    ]);
    const n = 3000;
    const seeds = Array.from({ length: n }, (_, i) => `POOL-SAME-${i}`);
    const person = adult('POOL-SAME');
    const expected = expectedShare(person, 'draw_pool_target');
    expect(expected).toBeGreaterThan(0.05);
    const draw = () => seeds.map((seed) => drawPool(reseed(person, seed))?.id ?? '-');
    const before = draw();
    const hitsBefore = before.filter((id) => id === 'draw_pool_target').length / n;
    expect(Math.abs(hitsBefore - expected)).toBeLessThan(tolerance(expected, n));

    // 나이·성별·태그·조건식·가중치 0 때문에 이 사람에게는 나올 수 없는 후보 2,000개 (모든 풀에 고루)
    const pools: PoolId[] = ['physiology', 'nutrition', 'romance', 'parenting', 'medical'];
    addEvents(
      Array.from({ length: 2000 }, (_, i) => {
        const why = i % 5;
        return poolEvent(`draw_pool_noise_${i}`, pools[i % pools.length], {
          trigger:
            why === 0 ? { age: [80, 100] } : why === 1 ? { age: [3, 100], sex: 'M' } : why === 2 ? { age: [3, 100], flags: ['draw_never'] } : { age: [3, 100], if: 'age > 200' },
          weight: why === 4 ? { base: 1, noMode: true, ageCurve: { '0': 0, '120': 0 } } : { base: 1, noMode: true },
        });
      }),
    );
    expect(EVENTS.filter((e) => e.pool).length).toBeGreaterThan(5000);
    const after = draw();
    // 정확한 가중 추첨이라 같은 시드면 같은 사건이 나온다 (분포는 당연히 같다)
    expect(after).toEqual(before);
    const hitsAfter = after.filter((id) => id === 'draw_pool_target').length / n;
    expect(Math.abs(hitsAfter - expected)).toBeLessThan(tolerance(expected, n));
  });

  it('1보다 큰 상대 가중치도 자르지 않고 그대로 따른다', () => {
    addEvents([
      // 가중치 200 (보정 ×200), 100 (보정 ×100), 200 (나이 곡선 ×400) → 2 : 1 : 2
      poolEvent('draw_w_a', 'physiology', {
        trigger: { age: [3, 100], flags: ['draw_test'] },
        weight: { base: 1, noMode: true, modifiers: [{ if: 'flags.draw_test', x: 200 }] },
      }),
      poolEvent('draw_w_b', 'physiology', {
        trigger: { age: [3, 100], flags: ['draw_test'] },
        weight: { base: 1, noMode: true, modifiers: [{ if: 'flags.draw_test', x: 100 }] },
      }),
      poolEvent('draw_w_c', 'physiology', {
        trigger: { age: [3, 100], flags: ['draw_test'] },
        weight: { base: 0.5, noMode: true, ageCurve: { '0': 400, '120': 400 } },
      }),
    ]);
    const s = adult('WEIGHTS');
    const cands = poolCandidates(s, 'physiology');
    const weightOf = (id: string) => cands.find((c) => c.ev.id === id)?.w;
    expect(weightOf('draw_w_a')).toBeCloseTo(200, 9);
    expect(weightOf('draw_w_b')).toBeCloseTo(100, 9);
    expect(weightOf('draw_w_c')).toBeCloseTo(200, 9);

    const n = 6000;
    const hits: Record<string, number> = { draw_w_a: 0, draw_w_b: 0, draw_w_c: 0 };
    for (let i = 0; i < n; i++) {
      const id = drawPool(reseed(s, `WEIGHTS-${i}`))?.id;
      if (id && id in hits) hits[id]++;
    }
    const total = hits.draw_w_a + hits.draw_w_b + hits.draw_w_c;
    // 세 사건이 함께 뽑힌 비율도 계산값과 맞는다
    const expected = ['draw_w_a', 'draw_w_b', 'draw_w_c'].reduce((sum, id) => sum + expectedShare(s, id), 0);
    expect(Math.abs(total / n - expected)).toBeLessThan(tolerance(expected, n));
    // 셋 사이의 비율은 2 : 1 : 2 (1에서 잘랐다면 1 : 1 : 0.5)
    for (const [id, p] of [
      ['draw_w_a', 0.4],
      ['draw_w_b', 0.2],
      ['draw_w_c', 0.4],
    ] as const) {
      expect(Math.abs(hits[id] / total - p), id).toBeLessThan(tolerance(p, total));
    }
  });

  it('풀 카드는 그해 일반 사건이 몇 개 일어났는지와 무관하다', () => {
    const seeds = Array.from({ length: 300 }, (_, i) => `POOL-FREE-${i}`);
    const poolOf = (seed: string) => drawYearEvents(adult(seed)).find((p) => EVENT_BY_ID.get(p.eventId)?.pool)?.eventId ?? '-';
    const before = seeds.map(poolOf);
    expect(before.filter((id) => id !== '-').length).toBeGreaterThan(100);
    addEvents(Array.from({ length: 10 }, (_, i) => testEvent(`draw_busy_${i}`)));
    expect(seeds.map(poolOf)).toEqual(before);
  });

  it('풀 사건이 4,000개를 넘어도 한 인생을 사는 속도가 크게 늘지 않는다', () => {
    const lives = 30;
    const timeLives = (prefix: string) => {
      const t0 = performance.now();
      for (let i = 0; i < lives; i++) simulateLife(`${prefix}-${i}`, { mode: 'reality' });
      return (performance.now() - t0) / lives;
    };
    timeLives('SPEED-WARM');
    const plain = timeLives('SPEED');
    // 대부분의 성인에게 열리는 생활 사건 1,000개를 더한다 (데이터가 아니라 시험 안에서만)
    const pools: PoolId[] = ['physiology', 'nutrition'];
    addEvents(
      Array.from({ length: 1000 }, (_, i) =>
        poolEvent(`draw_bulk_${i}`, pools[i % 2], {
          group: `draw_bulk_${i % 40}`,
          trigger: { age: [5, 100], if: i % 3 === 0 ? '!legal.inPrison && !military.serving' : i % 3 === 1 ? 'job.employed' : undefined },
        }),
      ),
    );
    expect(EVENTS.filter((e) => e.pool).length).toBeGreaterThan(4000);
    const bulk = timeLives('SPEED');
    console.log(`한 인생 평균: 풀 그대로 ${plain.toFixed(1)}ms, 풀 +1,000개 ${bulk.toFixed(1)}ms`);
    expect(bulk).toBeLessThan(plain * 2 + 20);
    expect(bulk).toBeLessThan(300);
  });
});

describe('후보가 적은 풀의 조용한 해 (풀이 꽉 차기 전의 절대 비율)', () => {
  it('후보가 적은 풀에서는 가중치가 절대 비율 w/20이 되고 남는 몫은 조용한 해다', () => {
    const quietEvent = (id: string, x: number) =>
      poolEvent(id, 'physiology', {
        trigger: { age: [0, 2], flags: ['draw_test'] },
        weight: { base: 1, noMode: true, modifiers: [{ if: 'flags.draw_test', x }] },
      });
    const s = baby('QUIET');
    const real = poolTotal(s, 'physiology');
    expect(real, '0세 몸 풀의 실제 후보가 늘었다면 이 시험의 가중치를 다시 고른다').toBeLessThan(POOL_FULL_WEIGHT - 14);
    const n = 4000;
    const seeds = Array.from({ length: n }, (_, i) => `QUIET-${i}`);
    const draw = () => seeds.map((seed) => drawPool(reseed(s, seed))?.id ?? '-');
    const rate = (ids: string[], id: string) => ids.filter((x) => x === id).length / n;
    const w = poolWeights(s);
    const share = w.physiology / POOL_IDS.reduce((sum, p) => sum + w[p], 0);

    addEvents([quietEvent('draw_q_a', 8)]);
    const one = draw();
    const expectedA = poolYearChance('reality') * share * (8 / POOL_FULL_WEIGHT);
    expect(expectedShare(s, 'draw_q_a')).toBeCloseTo(expectedA, 12);
    expect(Math.abs(rate(one, 'draw_q_a') - expectedA)).toBeLessThan(tolerance(expectedA, n));
    // 예전(w / W)이었다면 하나뿐인 이 사건이 몸 풀 자리를 모두 차지해 두 배 넘게 나왔다
    expect(rate(one, 'draw_q_a')).toBeLessThan(poolYearChance('reality') * share * 0.6);

    // 같은 풀에 사건을 더해도 꽉 차기 전에는 먼저 있던 사건이 뽑히는 시드가 그대로다
    addEvents([quietEvent('draw_q_b', 6)]);
    const two = draw();
    for (let i = 0; i < n; i++) if (one[i] === 'draw_q_a') expect(two[i]).toBe('draw_q_a');
    expect(rate(two, 'draw_q_a')).toBe(rate(one, 'draw_q_a'));
    const expectedB = expectedShare(s, 'draw_q_b');
    expect(Math.abs(rate(two, 'draw_q_b') - expectedB)).toBeLessThan(tolerance(expectedB, n));

    // 꽉 차면(합 ≥ 20) 그때부터는 상대 비율로 자리를 나눠 갖는다: a의 몫은 8 / (8 + 6 + 10 + 실제 후보)
    addEvents([quietEvent('draw_q_c', 10)]);
    expect(poolTotal(s, 'physiology')).toBeGreaterThanOrEqual(POOL_FULL_WEIGHT);
    const three = draw();
    const crowdedA = poolYearChance('reality') * share * (8 / poolTotal(s, 'physiology'));
    expect(expectedShare(s, 'draw_q_a')).toBeCloseTo(crowdedA, 12);
    expect(Math.abs(rate(three, 'draw_q_a') - crowdedA)).toBeLessThan(tolerance(crowdedA, n));
    // 꽉 찬 풀에는 조용한 몫이 없다: 몸 풀 자리는 세 사건 중 하나가 된다
    const phys = three.filter((id) => id.startsWith('draw_q_') || EVENT_BY_ID.get(id)?.pool === 'physiology').length / n;
    const expectedPhys = poolYearChance('reality') * share;
    expect(Math.abs(phys - expectedPhys)).toBeLessThan(tolerance(expectedPhys, n));
  });

  it('한 풀의 콘텐츠는 다른 풀 사건의 빈도를 바꾸지 않는다 (후보가 없던 풀도 몫을 넘기지 않는다)', () => {
    const s = baby('OTHER');
    const n = 3000;
    const seeds = Array.from({ length: n }, (_, i) => `OTHER-${i}`);
    const draw = () => seeds.map((seed) => drawPool(reseed(s, seed))?.id ?? '-');
    const before = draw();
    expect(before.filter((id) => id !== '-').length).toBeGreaterThan(20);
    // 0세에게 열리는 몸 풀 사건 하나 (지금 데이터에는 0세 몸 풀 후보가 없다)
    addEvents([poolEvent('draw_other_phys', 'physiology', { trigger: { age: [0, 2] }, weight: { base: 1, noMode: true } })]);
    const after = draw();
    // 다른 풀(병원·밥상)에서 나온 장면은 시드마다 그대로이고, 새 장면은 조용했던 해에만 들어간다
    for (let i = 0; i < n; i++) {
      if (before[i] !== '-') expect(after[i], seeds[i]).toBe(before[i]);
      if (after[i] === 'draw_other_phys') expect(before[i], seeds[i]).toBe('-');
    }
    expect(after.filter((id) => id === 'draw_other_phys').length).toBeGreaterThan(0);
  });

  it('갓난아기의 드문 병은 후보가 적다는 이유로 자주 나오지 않는다', () => {
    // 장중첩증(가중치 0.08): 예전에는 0세에 해마다 1.3%, 인생의 2~3%에서 나왔다
    const id = 'med_intussusception';
    expect(EVENT_BY_ID.get(id)?.pool).toBe('medical');
    // 실제 추첨으로 센다: 0세 아기 20,000명의 그해 풀 장면
    const n = 20_000;
    const s = newGame({ seed: 'INFANT', mode: 'reality', birthYear: 2026 });
    const expected = expectedShare(s, id);
    let hits = 0;
    for (let i = 0; i < n; i++) if (drawPool(reseed(s, `INFANT-${i}`))?.id === id) hits++;
    expect(Math.abs(hits / n - expected)).toBeLessThan(tolerance(expected, n));
    expect(hits / n).toBeLessThan(0.0025);
    // 0~3세 합계도 계산값으로 0.6% 아래다
    let lifetime = 0;
    for (let age = 0; age <= 3; age++) {
      const t = newGame({ seed: `INFANT-AGE-${age}`, mode: 'reality', birthYear: 2026 });
      t.ch.age = age;
      t.year = 2026 + age;
      lifetime += expectedShare(t, id);
    }
    expect(lifetime).toBeLessThan(0.006);
    // 같은 가중치가 나이에 따라 수십 배 달라지지 않는다: 성인(병원 풀이 꽉 찬 나이)의 같은 가중치 사건과 비교
    const grown = adult('INFANT-ADULT');
    const w = poolWeights(grown);
    const adultScale = (poolYearChance('reality') * w.medical) / POOL_IDS.reduce((sum, p) => sum + w[p], 0);
    const adultSame = adultScale * (0.08 / Math.max(poolTotal(grown, 'medical'), POOL_FULL_WEIGHT));
    expect(hits / n / adultSame).toBeLessThan(15);
  });
});

describe('저장·불러오기와 결정성', () => {
  it('엔진을 부를 때마다 저장했다 불러와도 같은 시드·같은 선택이면 같은 인생이다 (일기 사건 포함)', () => {
    addEvents(probeEvents());
    for (const [i, mode] of [
      [0, 'reality'],
      [1, 'drama'],
      [2, 'reality'],
      [3, 'makjang'],
    ] as const) {
      const plain = playLife(`SAVE-${i}`, mode);
      const saved = playLife(`SAVE-${i}`, mode, { roundtrip: true });
      expect(plain.counts.draw_probe_quiet ?? 0).toBeGreaterThan(0);
      // toEqual은 키 순서와 undefined 값을 따지지 않는다 (JSON은 undefined 키를 버린다)
      expect(saved).toEqual(plain);
    }
  });
});
