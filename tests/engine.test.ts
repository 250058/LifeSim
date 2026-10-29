// 첫 플레이 버전 완료 기준을 코드로 확인한다 (기획서 '첫 플레이 버전 완료 기준')

import { describe, expect, it } from 'vitest';
import { EVENTS } from '../src/engine/data';
import { drawYearEvents, eventProbability } from '../src/engine/eventEngine';
import { continueAsChild, heirOptions, inheritanceTax } from '../src/engine/heir';
import { formatWon, josa } from '../src/engine/format';
import { choose, endTurn, newGame, proceed } from '../src/engine/game';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import type { EventDef } from '../src/engine/schema';
import { simulateLife } from '../src/engine/sim';
import { render } from '../src/engine/text';
import type { GameState } from '../src/engine/types';
import { eventsPerStage, eventStats, validateData } from '../src/engine/validate';
import { activityViews } from '../src/engine/activities';
import { startPartner } from '../src/engine/relations';
import { Rng } from '../src/engine/rng';

/** 1,000개 이상이어야 하는 생활 사건 풀 (사용자 요청) */
const POOLS_OVER_1000 = ['physiology', 'nutrition'];

/** 항상 첫 선택지를 고르며 n년을 산다 */
function liveYears(state: GameState, years: number): void {
  const target = state.ch.age + years;
  for (let guard = 0; guard < 10_000 && state.phase !== 'dead' && state.ch.age < target; guard++) {
    if (state.phase === 'action') endTurn(state);
    else if (state.card && state.card.choices.length > 0 && !state.card.result) choose(state, 0);
    else proceed(state);
  }
}

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('시드', () => {
  it('같은 시드면 같은 인생이 나온다', () => {
    const a = simulateLife('SAME-SEED');
    const b = simulateLife('SAME-SEED');
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('다른 시드면 다른 인생이 나온다', () => {
    const a = simulateLife('SEED-ONE');
    const b = simulateLife('SEED-TWO');
    expect(JSON.stringify(b.log)).not.toBe(JSON.stringify(a.log));
  });
});

describe('사건 확률 공식', () => {
  // 기획서 계산 예: 0.025 × 0.84 × 2.0 × 1.5 = 6.3%, 드라마 배수 ×3이면 약 19%
  const ev: EventDef = {
    id: 'formula_example',
    type: 'random',
    title: '따돌림',
    text: '',
    trigger: { age: [10, 18] },
    weight: {
      base: 0.025,
      ageCurve: { '14': 0.84 },
      modifiers: [
        { if: 'flags.transferred', x: 2 },
        { if: 'stats.sociability < 40', x: 1.5 },
      ],
    },
  } as EventDef;

  function middleSchooler(mode: 'reality' | 'drama'): GameState {
    const s = newGame({ seed: 'FORMULA', mode, birthYear: 2026 });
    s.ch.age = 14;
    s.ch.stats.sociability = 30;
    s.ch.flags.transferred = { since: 14 };
    return s;
  }

  it('현실 모드에서 약 6.3%', () => {
    const p = eventProbability(ev, middleSchooler('reality'));
    expect(p.A).toBeCloseTo(0.84, 6);
    expect(p.m).toBeCloseTo(3, 6);
    expect(p.P).toBeCloseTo(0.063, 6);
  });

  it('모드 배수 3을 직접 곱하면 약 18.9%', () => {
    const p = eventProbability(ev, middleSchooler('reality'));
    expect(p.p0 * p.A * p.m * p.D * 3).toBeCloseTo(0.189, 6);
  });

  it('드라마 모드 배수는 평생 확률이 흔한 사건일수록 작다', () => {
    const p = eventProbability(ev, middleSchooler('drama'));
    expect(p.M).toBeGreaterThanOrEqual(1);
    expect(p.M).toBeLessThan(3);
  });
});

describe('사건 데이터', () => {
  it('검증 오류가 없다', () => {
    const errors = validateData().filter((i) => i.level === 'error');
    expect(errors).toEqual([]);
  });

  it('사건이 30개 이상이고 생애 단계마다 3개 이상이다', () => {
    expect(EVENTS.length).toBeGreaterThanOrEqual(30);
    for (const [stage, n] of Object.entries(eventsPerStage())) {
      expect(n, stage).toBeGreaterThanOrEqual(3);
    }
  });

  it('사건 id가 겹치지 않는다', () => {
    const ids = EVENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('저장', () => {
  it('저장했다 불러와도 같은 상태이고, 이어서 살아도 같은 인생이다', () => {
    const storage = memoryStorage();
    const original = newGame({ seed: 'SAVE-LOAD', mode: 'drama', birthYear: 2026 });
    liveYears(original, 25);
    expect(saveGame(original, storage)).toBe(true);
    const loaded = loadGame(storage)!;
    expect(loaded).toEqual(original);

    liveYears(original, 20);
    liveYears(loaded, 20);
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(original));
  });

  it('저장소가 망가져 있으면 새로 시작한다', () => {
    const storage = memoryStorage();
    storage.setItem('lifesim.save.v1', '{망가진 JSON');
    expect(loadGame(storage)).toBeNull();
    expect(loadGame(null)).toBeNull();
  });
});

describe('표시', () => {
  it('받침에 맞게 조사를 고른다', () => {
    expect(josa('김민지', '이/가')).toBe('김민지가');
    expect(josa('박지훈', '이/가')).toBe('박지훈이');
    expect(josa('서울', '으로/로')).toBe('서울로');
    expect(josa('부산', '으로/로')).toBe('부산으로');
    expect(josa('폐렴', '으로/로')).toBe('폐렴으로');
  });

  it('자리표시자 뒤의 조사를 고친다', () => {
    const s = newGame({ seed: 'JOSA', mode: 'drama', birthYear: 2026 });
    expect(render('{지인}이/가 웃었다.', s, { 지인: '이수진' })).toBe('이수진이 웃었다.');
    expect(render('{지인}이 웃었다.', s, { 지인: '최유나' })).toBe('최유나가 웃었다.');
    expect(render('{지인}을 만났다.', s, { 지인: '정다은' })).toBe('정다은을 만났다.');
  });

  it('돈을 만·억 단위로 쓴다', () => {
    expect(formatWon(1_370_000_000)).toBe('13억 7,000만 원');
    expect(formatWon(52_000)).toBe('5만 2,000원');
    expect(formatWon(-30_000_000)).toBe('−3,000만 원');
  });
});

describe('수명', () => {
  it('자동으로 산 1,000명의 평균 수명이 기대수명 83.7세의 ±3 안이다', () => {
    let total = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) total += simulateLife(`LIFESPAN-${i}`).ch.age + 0.5;
    const mean = total / n;
    expect(mean).toBeGreaterThan(83.7 - 3);
    expect(mean).toBeLessThan(83.7 + 3);
  });
});

describe('자녀로 이어하기', () => {
  // 자녀를 남기고 죽는 첫 인생을 찾는다 (시드가 같으면 늘 같은 인생)
  const parent = (() => {
    for (let i = 0; i < 80; i++) {
      const s = simulateLife(`HEIR-${i}`);
      if (heirOptions(s).length > 0) return s;
    }
    throw new Error('자녀를 남긴 인생이 없다');
  })();

  it('같은 해, 같은 세계에서 자녀의 나이로 이어 산다', () => {
    const heir = heirOptions(parent)[0];
    const next = continueAsChild(parent, heir.npc.id)!;
    expect(next.year).toBe(parent.year);
    expect(next.ch.age).toBe(heir.age);
    expect(next.ch.surname + next.ch.given).toBe(heir.npc.name);
    expect(next.world.economy.priceIndex).toBe(parent.world.economy.priceIndex);
    expect(next.lineage?.generation).toBe(2);
    expect(next.ch.npcs.some((n) => !n.alive && n.name === parent.ch.surname + parent.ch.given)).toBe(true);
    expect(next.phase).toBe('action');
  });

  it('같은 자녀를 고르면 같은 판이 나오고, 끝까지 살 수 있다', () => {
    const id = heirOptions(parent)[0].npc.id;
    const a = continueAsChild(parent, id)!;
    const b = continueAsChild(parent, id)!;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    liveYears(a, 150);
    expect(a.phase).toBe('dead');
    expect(a.summary?.epitaph).toBeTruthy();
  });

  it('살아 있는 사람으로는 이어 살 수 없다', () => {
    const living = newGame({ seed: 'ALIVE', mode: 'drama', birthYear: 2026 });
    expect(continueAsChild(living, 'n1')).toBeNull();
  });

  it('상속세는 누진세율로 매긴다', () => {
    expect(inheritanceTax(100_000_000, 1)).toBe(10_000_000);
    expect(inheritanceTax(500_000_000, 1)).toBe(90_000_000);
    expect(inheritanceTax(1_000_000_000, 1)).toBe(240_000_000);
  });
});

describe('생활 사건 풀', () => {
  it('생활 사건 풀 중 생리 현상·영양(의료는 합친 뒤 추가)이 각각 1,000개 이상이다', () => {
    const { byPool } = eventStats();
    for (const pool of POOLS_OVER_1000) expect(byPool[pool] ?? 0, pool).toBeGreaterThanOrEqual(1000);
  });

  it('풀 사건은 한 해에 한 장까지만 나온다', () => {
    const s = newGame({ seed: 'POOL-YEARS', mode: 'drama', birthYear: 2026 });
    let years = 0;
    for (let age = 5; age <= 90; age++) {
      s.ch.age = age;
      s.year = 2026 + age;
      const pooled = drawYearEvents(s).filter((p) => EVENTS.find((e) => e.id === p.eventId)?.pool).length;
      expect(pooled).toBeLessThanOrEqual(1);
      years += pooled;
    }
    expect(years).toBeGreaterThan(20);
  });
});

describe('성인 전용', () => {
  it('성인 전용 사건은 모두 만 19세 이상에게만 열린다', () => {
    for (const ev of EVENTS.filter((e) => e.adult)) expect(ev.trigger?.age?.[0] ?? 0, ev.id).toBeGreaterThanOrEqual(19);
  });

  it('모텔·해피타임은 성인 커플에게만 보인다', () => {
    const s = newGame({ seed: 'ADULT-ONLY', mode: 'drama', birthYear: 2026 });
    s.ch.age = 18;
    s.year = 2044;
    const ids = () => activityViews(s).map((v) => v.def.id);
    expect(ids()).not.toContain('happytime');
    s.ch.age = 25;
    s.year = 2051;
    expect(ids()).not.toContain('happytime');
    const partner = startPartner(s, new Rng('p'));
    expect(s.year - partner.birthYear).toBeGreaterThanOrEqual(19);
    expect(ids()).toContain('happytime');
    expect(ids()).toContain('motel');
  });
});
