// 사건 추첨 검사: 발생과 표시의 분리(R-001), 0 확률(R-004), 생활 사건 풀의 정확한 가중 추첨.
// 시험용 사건은 EVENTS에 잠깐 넣었다가 테스트가 끝나면 뺀다.

import { afterEach, describe, expect, it } from 'vitest';
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
import { choose, endTurn, newGame, proceed } from '../src/engine/game';
import { poolWeights, poolYearChance } from '../src/engine/pools';
import { buildScope } from '../src/engine/scope';
import type { ChoiceDef, EventDef, PoolId } from '../src/engine/schema';
import { simulateLife } from '../src/engine/sim';
import type { GameState, Mode } from '../src/engine/types';

const added: EventDef[] = [];

function addEvents(evs: EventDef[]): void {
  for (const ev of evs) {
    EVENTS.push(ev);
    EVENT_BY_ID.set(ev.id, ev);
    added.push(ev);
  }
  resetEventIndex();
}

afterEach(() => {
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
});

describe('생활 사건 풀의 정확한 가중 추첨', () => {
  /** 이 상태에서 한 사건이 그해 풀 카드로 뽑힐 확률 (계산값) */
  function expectedShare(s: GameState, id: string): number {
    const pools: PoolId[] = ['medical', 'physiology', 'nutrition', 'romance', 'parenting'];
    const w = poolWeights(s);
    const live = pools.filter((p) => w[p] > 0 && poolCandidates(s, p).length > 0);
    const wTotal = live.reduce((sum, p) => sum + w[p], 0);
    let share = 0;
    for (const p of live) {
      const cands = poolCandidates(s, p);
      const total = cands.reduce((sum, c) => sum + c.w, 0);
      const mine = cands.find((c) => c.ev.id === id);
      if (mine) share += (w[p] / wTotal) * (mine.w / total);
    }
    return poolYearChance(s.mode) * share;
  }

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
