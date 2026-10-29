// 자녀로 이어하기(heir.ts)의 경계 검사: 나이·혼인 시점·가족 관계·돈의 단위
// (검토 R-006: 미성년 배우자와 미래의 혼인, R-007: 평균 소득·연금의 물가 중복)

import { describe, expect, it, vi } from 'vitest';
import { retire } from '../src/engine/career';
import { choose, endTurn, newGame, proceed } from '../src/engine/game';
import { continueAsChild, heirOptions, inheritanceTax } from '../src/engine/heir';
import { haveChild, makeNpc } from '../src/engine/relations';
import { Rng, rngFor } from '../src/engine/rng';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import { annualIncome, buildScope } from '../src/engine/scope';
import { simulateLife } from '../src/engine/sim';
import type { GameState, Npc, Sex } from '../src/engine/types';

const ADULT = 19;
const PRICE_INDEXES = [1, 3, 10];

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** 항상 첫 선택지를 고르며 죽을 때까지 산다 */
function liveToDeath(state: GameState): void {
  for (let guard = 0; guard < 20_000 && state.phase !== 'dead'; guard++) {
    if (state.phase === 'action') endTurn(state);
    else if (state.card && state.card.choices.length > 0 && !state.card.result) choose(state, 0);
    else proceed(state);
  }
}

function die(p: GameState): void {
  p.ch.alive = false;
  p.phase = 'dead';
  p.ch.death = { age: p.ch.age, year: p.year, cause: '검사' };
}

/**
 * 검토 보고서 부록과 같은 판: 30세에 낳은 kidAge세 자녀 하나를 남기고 부모가 죽었다.
 * keepFamily면 부모의 부모(newGame이 만든 엄마·아빠)를 남겨 둔다 (후계자에게는 조부모).
 */
function fixture(seed: string, kidAge: number, opts: { pi?: number; keepFamily?: boolean } = {}) {
  const p = newGame({ seed, mode: 'reality', birthYear: 2026 });
  p.ch.age = kidAge + 30;
  p.year = p.ch.birthYear + p.ch.age;
  p.world.year = p.year;
  p.world.economy.priceIndex = opts.pi ?? 1;
  p.ch.npcs = opts.keepFamily ? p.ch.npcs.filter((n) => n.role === 'mother' || n.role === 'father') : [];
  const child = haveChild(p, rngFor(seed, 'child'));
  child.birthYear = p.year - kidAge;
  die(p);
  return { p, child };
}

interface Marriage {
  /** 혼인한 때 부모의 나이 */
  since: number;
  role: 'spouse' | 'ex';
  /** 세상을 떠난 때 부모의 나이 */
  diedAt?: number;
  missing?: boolean;
}

/** 부모의 혼인·출산 기록을 직접 꾸민 판. 나이는 모두 부모의 나이다 */
function lifeFixture(seed: string, life: { sex: Sex; age: number; marriages: Marriage[]; kidsBornAt: number[]; grandparentAlive?: boolean }, pi = 1) {
  const p = newGame({ seed, mode: 'reality', birthYear: 2026 });
  const ch = p.ch;
  ch.sex = life.sex;
  ch.age = life.age;
  p.year = ch.birthYear + life.age;
  p.world.year = p.year;
  p.world.economy.priceIndex = pi;
  ch.npcs = [];
  const rng = new Rng(`${seed}|fixture`);
  const otherSex: Sex = life.sex === 'M' ? 'F' : 'M';
  const spouses = life.marriages.map((m) => {
    const n = makeNpc(p, rng, m.role, otherSex, ch.birthYear + 2, { since: m.since, closeness: 66 });
    if (m.diedAt !== undefined) {
      n.alive = false;
      n.deathYear = ch.birthYear + m.diedAt;
    }
    if (m.missing) n.missing = true;
    ch.npcs.push(n);
    return n;
  });
  const kids = life.kidsBornAt.map((at, i) => {
    const n = makeNpc(p, rng, 'child', i % 2 ? 'F' : 'M', ch.birthYear + at, { surname: ch.surname, closeness: 77, health: 83 });
    ch.npcs.push(n);
    return n;
  });
  if (life.grandparentAlive !== undefined) {
    const g = makeNpc(p, rng, 'mother', 'F', ch.birthYear - 30, { closeness: 70 });
    g.alive = life.grandparentAlive;
    if (!g.alive) g.deathYear = ch.birthYear + 20;
    ch.npcs.push(g);
  }
  die(p);
  return { p, spouses, kids };
}

const ageOf = (s: GameState, n: Npc) => s.year - n.birthYear;
/** 사건 조건식이 읽는 가족 값 (scope.ts의 family) */
const familyScope = (s: GameState) =>
  buildScope(s).family as { married: boolean; marriedYears: number; children: number; parentsAlive: number };
const byId = (s: GameState, id: string) => s.ch.npcs.find((n) => n.id === id);

/** 후계자 판이 지켜야 할 불변 조건 (나이·혼인 시점·자격·알려진 사실) */
function expectConsistentHeir(next: GameState, prev: GameState, child: Npc): void {
  const ch = next.ch;
  const age = prev.year - child.birthYear;
  const label = `${prev.seed} ${age}세`;
  // 알려진 사실은 그대로
  expect(ch.age, label).toBe(age);
  expect(next.year, label).toBe(prev.year);
  expect(ch.surname + ch.given, label).toBe(child.name);
  expect(ch.sex, label).toBe(child.sex);
  expect(ch.birthYear, label).toBe(child.birthYear);
  expect(ch.stats.health, label).toBe(Math.round(child.health));
  const lost = ch.npcs.find((n) => n.id === `p${prev.serial}`);
  expect(lost?.name, label).toBe(prev.ch.surname + prev.ch.given);
  expect(lost?.alive, label).toBe(false);
  expect(lost?.closeness, label).toBe(child.closeness);
  // 음수 나이 없음, 인물 ID는 겹치지 않는다
  for (const n of ch.npcs) expect(ageOf(next, n), `${label} ${n.role} ${n.name}`).toBeGreaterThanOrEqual(0);
  expect(new Set(ch.npcs.map((n) => n.id)).size, label).toBe(ch.npcs.length);

  const fam = familyScope(next);
  const spouses = ch.npcs.filter((n) => n.role === 'spouse');
  if (age < ADULT) {
    expect(ch.npcs.filter((n) => ['spouse', 'partner', 'ex', 'child'].includes(n.role)), label).toEqual([]);
    expect(fam.married, label).toBe(false);
    expect(ch.family.livesWithParents, label).toBe(ch.family.type !== 'facility');
  } else {
    expect(ch.family.livesWithParents, label).toBe(false);
  }
  // 혼인: 성년부터 지금 사이에 했고, 상대도 그때 성년이었다
  for (const s of spouses) {
    expect(s.since, label).toBeDefined();
    expect(s.since!, label).toBeGreaterThanOrEqual(ADULT);
    expect(s.since!, label).toBeLessThanOrEqual(age);
    expect(ch.birthYear + s.since! - s.birthYear, `${label} 혼인 때 상대 나이`).toBeGreaterThanOrEqual(ADULT);
    expect(ageOf(next, s), label).toBeGreaterThanOrEqual(ADULT);
  }
  expect(spouses.length, label).toBeLessThanOrEqual(1);
  expect(fam.married, label).toBe(spouses.some((s) => s.alive));
  expect(fam.marriedYears, label).toBeGreaterThanOrEqual(0);
  // 아이: 결혼한 뒤, 올해까지, 어머니가 44세 이하일 때 태어났다
  const kids = ch.npcs.filter((n) => n.role === 'child');
  if (kids.length > 0) {
    const s = spouses[0];
    expect(s, label).toBeDefined();
    const wedding = ch.birthYear + s.since!;
    const motherBirth = ch.sex === 'F' ? ch.birthYear : s.birthYear;
    for (const k of kids) {
      expect(k.birthYear, label).toBeGreaterThan(wedding);
      expect(k.birthYear, label).toBeLessThanOrEqual(next.year);
      expect(k.birthYear - motherBirth, label).toBeLessThanOrEqual(44);
    }
  }
  expect(fam.children, label).toBe(kids.filter((k) => k.alive).length);
  // 학교: 시작이 지금보다 늦거나, 졸업할 수 없는 나이에 졸업한 기록이 없다
  const univ = ch.edu.univ;
  if (univ) expect(univ.startAge, label).toBeLessThanOrEqual(age);
  if (ch.edu.degree === 'university') expect(age, label).toBeGreaterThanOrEqual(univ!.startAge + univ!.years);
  if (ch.edu.degree === 'college') expect(age, label).toBeGreaterThanOrEqual(21);
}

describe('자녀로 이어하기: 나이와 혼인 시점 (R-006)', () => {
  it('검토 재현: 10세 후계자에게 배우자도 미래의 혼인도 없다', () => {
    const { p, child } = fixture('REVIEW-HEIR-6', 10);
    const next = continueAsChild(p, child.id)!;
    expect(next.ch.age).toBe(10);
    expect(next.ch.npcs.filter((n) => n.role === 'spouse')).toEqual([]);
    expect(familyScope(next).married).toBe(false);
    expectConsistentHeir(next, p, child);
  });

  it('0·10·18·19·25·26·65세 등 경계 나이에서 음수 나이·미성년 혼인·미래 혼인이 없다', () => {
    const ages = [0, 1, 2, 10, 18, 19, 20, 21, 22, 25, 26, 27, 40, 60, 64, 65, 80];
    const married: Record<number, number> = {};
    for (const age of ages) {
      married[age] = 0;
      for (let i = 0; i < 120; i++) {
        const { p, child } = fixture(`HEIR-B-${age}-${i}`, age, { keepFamily: age < ADULT && i % 2 === 1 });
        const next = continueAsChild(p, child.id)!;
        expectConsistentHeir(next, p, child);
        if (familyScope(next).married) married[age]++;
      }
    }
    for (const age of ages.filter((a) => a < ADULT)) expect(married[age], `${age}세`).toBe(0);
    for (const age of [27, 40, 65, 80]) expect(married[age], `${age}세`).toBeGreaterThan(0);
  });

  it('19세에 결혼한 후계자의 상대도 혼인할 때 19세 이상이다 (상대의 경계 나이)', () => {
    const found: GameState[] = [];
    for (let i = 0; i < 3000 && found.length < 12; i++) {
      const { p, child } = fixture(`HEIR-19-${i}`, ADULT);
      const next = continueAsChild(p, child.id)!;
      expectConsistentHeir(next, p, child);
      if (familyScope(next).married) found.push(next);
    }
    expect(found.length).toBeGreaterThan(0);
    const atWedding = found.map((s) => {
      const spouse = s.ch.npcs.find((n) => n.role === 'spouse')!;
      expect(spouse.since).toBe(ADULT);
      return s.ch.birthYear + spouse.since! - spouse.birthYear;
    });
    expect(Math.min(...atWedding)).toBeGreaterThanOrEqual(ADULT);
    // 상대가 더 어리게 뽑혀도 성년 경계에서 멈춘다
    expect(atWedding).toContain(ADULT);
  });

  it('정수 추첨 범위가 뒤집히지 않는다', () => {
    const cases = [0, 10, 18, 19, 20, 25, 26, 65].flatMap((age) => Array.from({ length: 40 }, (_, i) => fixture(`HEIR-INT-${age}-${i}`, age)));
    const calls: [number, number][] = [];
    const original = Rng.prototype.int;
    const spy = vi.spyOn(Rng.prototype, 'int').mockImplementation(function (this: Rng, min: number, max: number) {
      calls.push([min, max]);
      return original.call(this, min, max);
    });
    try {
      for (const { p, child } of cases) continueAsChild(p, child.id);
    } finally {
      spy.mockRestore();
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(([min, max]) => min > max)).toEqual([]);
  });

  it('미성년 후계자는 조부모가 있으면 조부모가, 없으면 보육원이 맡는다', () => {
    const withGrandma = fixture('HEIR-GUARD', 8, { keepFamily: true });
    const a = continueAsChild(withGrandma.p, withGrandma.child.id)!;
    expect(a.ch.family.type).toBe('grandparents');
    expect(a.ch.family.livesWithParents).toBe(true);
    expect(a.ch.npcs.filter((n) => n.role === 'grandparent' && n.alive).length).toBeGreaterThan(0);
    const alone = fixture('HEIR-GUARD', 8);
    const b = continueAsChild(alone.p, alone.child.id)!;
    expect(b.ch.family.type).toBe('facility');
    expect(b.ch.flags.raised_in_facility).toBeDefined();
  });

  it('갓난 후계자에게는 친구도 아이도 없다', () => {
    const { p, child } = fixture('HEIR-BABY', 0);
    const next = continueAsChild(p, child.id)!;
    expect(next.ch.npcs.filter((n) => n.role === 'friend')).toEqual([]);
    expect(next.ch.edu.status).toBe('none');
  });
});

describe('자녀로 이어하기: 부모의 실제 가족 관계 (R-006)', () => {
  it('사별한 부모: 먼저 떠난 친부모는 고인으로 남고, 조부모가 없으면 보육원', () => {
    const { p, spouses, kids } = lifeFixture('HEIR-WIDOW', { sex: 'M', age: 60, marriages: [{ since: 28, role: 'spouse', diedAt: 50 }], kidsBornAt: [30, 45] });
    const next = continueAsChild(p, kids[1].id)!;
    expectConsistentHeir(next, p, kids[1]);
    const mother = byId(next, spouses[0].id)!;
    expect(mother.role).toBe('mother');
    expect(mother.alive).toBe(false);
    expect(next.ch.npcs.filter((n) => (n.role === 'mother' || n.role === 'father') && n.alive)).toEqual([]);
    expect(next.ch.family.type).toBe('facility');
    expect(next.ch.family.estate).toBe(0);
    expect(byId(next, kids[0].id)?.role).toBe('sibling');
  });

  it('사별한 부모: 살아 계신 조부모가 미성년 후계자를 맡는다', () => {
    const { p, kids } = lifeFixture('HEIR-WIDOW-G', { sex: 'F', age: 50, marriages: [{ since: 30, role: 'spouse', diedAt: 40 }], kidsBornAt: [36], grandparentAlive: true });
    const next = continueAsChild(p, kids[0].id)!;
    expect(next.ch.family.type).toBe('grandparents');
    expect(next.log[0].text).toContain('할머니');
  });

  it('이혼한 부모: 살아 있는 전 배우자가 친부모로서 미성년 후계자를 맡는다', () => {
    const { p, spouses, kids } = lifeFixture('HEIR-DIVORCE', { sex: 'F', age: 45, marriages: [{ since: 25, role: 'ex' }], kidsBornAt: [33] });
    const next = continueAsChild(p, kids[0].id)!;
    expectConsistentHeir(next, p, kids[0]);
    const father = byId(next, spouses[0].id)!;
    expect(father.role).toBe('father');
    expect(father.alive).toBe(true);
    expect(father.since).toBeUndefined();
    expect(next.ch.family.type).toBe('single_parent');
    expect(next.ch.family.livesWithParents).toBe(true);
    // 전 배우자는 고인의 재산을 상속받지 않으므로 나중에 물려줄 몫도 이 판에서 생기지 않는다
    expect(next.ch.family.estate).toBe(0);
  });

  it('이혼 뒤 재혼한 부모: 재혼 상대는 먼저 태어난 자녀의 친부모가 아니다', () => {
    const life = { sex: 'F' as Sex, age: 50, marriages: [{ since: 25, role: 'ex' as const }, { since: 40, role: 'spouse' as const }], kidsBornAt: [30, 42] };
    const { p, spouses, kids } = lifeFixture('HEIR-REMARRY', life);
    p.ch.res.cash = 3_000_000_000;
    const [ex, step] = spouses;

    // 첫 결혼에서 태어난 20세 자녀: 아빠는 전 배우자, 재혼 상대는 새아버지
    const elder = continueAsChild(p, kids[0].id)!;
    expectConsistentHeir(elder, p, kids[0]);
    expect(byId(elder, ex.id)?.role).toBe('father');
    expect(byId(elder, step.id)).toBeUndefined();
    expect(elder.ch.npcs.filter((n) => (n.role === 'father' || n.role === 'mother') && n.alive).map((n) => n.id)).toEqual([ex.id]);
    expect(elder.log[0].text).toContain(`새아버지 ${step.name}`);
    expect(elder.ch.family.estate).toBe(0);
    expect(byId(elder, kids[1].id)?.role).toBe('sibling');

    // 재혼 뒤 태어난 8세 자녀: 재혼 상대가 친아버지이고 보호자다
    const younger = continueAsChild(p, kids[1].id)!;
    expectConsistentHeir(younger, p, kids[1]);
    expect(byId(younger, step.id)?.role).toBe('father');
    expect(byId(younger, ex.id)).toBeUndefined();
    expect(younger.ch.family.type).toBe('single_parent');
    expect(younger.ch.family.livesWithParents).toBe(true);
    expect(younger.ch.family.estate).toBeGreaterThan(0);
    expect(younger.log[0].text).not.toContain('새아버지');
    expect(byId(younger, kids[0].id)?.role).toBe('sibling');
  });

  it('사별 뒤 재혼한 부모: 먼저 떠난 친어머니와 새어머니를 구분한다', () => {
    const life = { sex: 'M' as Sex, age: 55, marriages: [{ since: 26, role: 'spouse' as const, diedAt: 35 }, { since: 38, role: 'spouse' as const }], kidsBornAt: [30, 40] };
    const { p, spouses, kids } = lifeFixture('HEIR-REWED', life);
    const [first, second] = spouses;

    const elder = continueAsChild(p, kids[0].id)!;
    expectConsistentHeir(elder, p, kids[0]);
    expect(byId(elder, first.id)?.role).toBe('mother');
    expect(byId(elder, first.id)?.alive).toBe(false);
    expect(byId(elder, second.id)).toBeUndefined();
    expect(elder.log[0].text).toContain(`새어머니 ${second.name}`);
    expect(elder.ch.npcs.filter((n) => (n.role === 'mother' || n.role === 'father') && n.alive)).toEqual([]);

    const younger = continueAsChild(p, kids[1].id)!;
    expectConsistentHeir(younger, p, kids[1]);
    expect(byId(younger, second.id)?.role).toBe('mother');
    expect(byId(younger, second.id)?.alive).toBe(true);
    expect(byId(younger, first.id)).toBeUndefined();
    expect(younger.ch.family.type).toBe('single_parent');
  });

  it('생사를 모르는 친부모는 기록으로 남지만 보호자가 되지 않는다', () => {
    const { p, spouses, kids } = lifeFixture('HEIR-MISSING', { sex: 'M', age: 40, marriages: [{ since: 25, role: 'spouse', missing: true }], kidsBornAt: [30] });
    const next = continueAsChild(p, kids[0].id)!;
    const mother = byId(next, spouses[0].id)!;
    expect(mother.role).toBe('mother');
    expect(mother.missing).toBe(true);
    expect(next.ch.family.type).toBe('facility');
    expect(familyScope(next).parentsAlive).toBe(0);
  });

  it('형제자매는 부모의 다른 자녀 그대로다 (세상을 떠난 형제 포함)', () => {
    const { p, kids } = lifeFixture('HEIR-SIBS', { sex: 'F', age: 70, marriages: [{ since: 27, role: 'spouse' }], kidsBornAt: [29, 31, 35] });
    kids[1].alive = false;
    kids[1].deathYear = p.year - 5;
    const next = continueAsChild(p, kids[2].id)!;
    const sibs = next.ch.npcs.filter((n) => n.role === 'sibling');
    expect(sibs.map((n) => n.id).sort()).toEqual([kids[0].id, kids[1].id].sort());
    expect(byId(next, kids[1].id)?.alive).toBe(false);
    expect(byId(next, kids[0].id)?.birthYear).toBe(kids[0].birthYear);
  });

  it('이어 한 판은 저장했다 불러와도 같다', () => {
    const storage = memoryStorage();
    const { p, kids } = lifeFixture('HEIR-SAVE', { sex: 'M', age: 62, marriages: [{ since: 30, role: 'spouse' }], kidsBornAt: [33] });
    const next = continueAsChild(p, kids[0].id)!;
    expect(saveGame(next, storage)).toBe(true);
    expect(loadGame(storage)).toEqual(next);
  });

  it('여러 대를 이어 살아도 불변 조건이 지켜지고, 저장·불러오기 뒤 같은 인생이 나온다', () => {
    let fourth = 0;
    for (let i = 0; i < 40 && fourth < 2; i++) {
      let prev = simulateLife(`HEIR-${i}`);
      for (let gen = 2; gen <= 4; gen++) {
        const options = heirOptions(prev);
        if (options.length === 0) break;
        const child = options[0].npc;
        const next = continueAsChild(prev, child.id)!;
        expectConsistentHeir(next, prev, child);
        expect(next.lineage?.generation).toBe(gen);
        const storage = memoryStorage();
        saveGame(next, storage);
        const loaded = loadGame(storage)!;
        liveToDeath(next);
        liveToDeath(loaded);
        expect(JSON.stringify(loaded)).toBe(JSON.stringify(next));
        if (gen === 4) fourth++;
        prev = next;
      }
    }
    expect(fourth).toBeGreaterThan(0);
  });
});

describe('자녀로 이어하기: 돈의 단위 (R-007)', () => {
  it('65세 후계자: 물가지수 1·3·10에서 실질 평균 연봉과 실질 연금이 같고 지급할 때만 물가를 곱한다', () => {
    const heirs = PRICE_INDEXES.map((pi) => {
      const { p, child } = fixture('REVIEW-PENSION', 65, { pi });
      return continueAsChild(p, child.id)!;
    });
    const base = heirs[0].ch.career;
    expect(base.retired).toBe(true);
    expect(base.pension).toBeGreaterThan(0);
    // 평균 연봉은 2026년 원 (2,500만~6,000만 원 구간에서 뽑는다)
    expect(base.avgSalary).toBeGreaterThanOrEqual(25_000_000);
    expect(base.avgSalary).toBeLessThanOrEqual(60_000_000);
    heirs.forEach((h, i) => {
      expect(h.ch.career.avgSalary).toBe(base.avgSalary);
      expect(h.ch.career.pension).toBe(base.pension);
      expect(annualIncome(h)).toBe(Math.round(base.pension * PRICE_INDEXES[i]));
    });
  });

  it('일하는 후계자: 연봉은 그해 명목액, 평균 연봉은 2026년 원', () => {
    let heirs: GameState[] = [];
    for (let i = 0; i < 50 && heirs.length === 0; i++) {
      const made = PRICE_INDEXES.map((pi) => {
        const { p, child } = fixture(`HEIR-WORK-${i}`, 40, { pi });
        return continueAsChild(p, child.id)!;
      });
      if (made[0].ch.career.jobId) heirs = made;
    }
    expect(heirs.length).toBe(PRICE_INDEXES.length);
    const base = heirs[0].ch.career;
    expect(base.avgSalary).toBeGreaterThan(0);
    expect(base.avgSalary).toBeLessThan(base.salary);
    heirs.forEach((h, i) => {
      const c = h.ch.career;
      expect(c.jobId).toBe(base.jobId);
      expect(c.avgSalary).toBe(base.avgSalary);
      expect(Math.abs(c.salary / PRICE_INDEXES[i] - base.salary)).toBeLessThan(1);
    });
  });

  it('60~64세 후계자도 65세에 받는 실질 연금이 물가지수와 상관없다', () => {
    const heirs = PRICE_INDEXES.map((pi) => {
      const { p, child } = fixture('HEIR-PENSION-62', 62, { pi });
      return continueAsChild(p, child.id)!;
    });
    const paid = heirs.map((h) => {
      h.ch.age = 65; // pension_day 사건이 부르는 retire()
      return retire(h);
    });
    const base = heirs[0].ch.career;
    expect(base.pension).toBeGreaterThan(0);
    heirs.forEach((h, i) => {
      expect(h.ch.career.avgSalary).toBe(base.avgSalary);
      expect(h.ch.career.pension).toBe(base.pension);
      expect(paid[i]).toBe(Math.round(base.pension * PRICE_INDEXES[i]));
    });
  });

  it('상속: 같은 실질 재산이면 물가지수와 상관없이 실질 상속분과 남은 부모의 몫이 같다', () => {
    const results = PRICE_INDEXES.map((pi) => {
      const life = { sex: 'M' as Sex, age: 70, marriages: [{ since: 28, role: 'spouse' as const }], kidsBornAt: [30, 33] };
      const { p, kids } = lifeFixture('HEIR-ESTATE', life, pi);
      const gross = 3_000_000_000 * pi;
      p.ch.res.cash = gross;
      const next = continueAsChild(p, kids[0].id)!;
      // 일괄공제 + 배우자공제 10억(2026년 원), 법정상속분: 배우자 1.5, 자녀 두 명 각 1
      const tax = inheritanceTax(gross - 1_000_000_000 * pi, pi);
      expect(next.ch.res.cash).toBe(Math.round((gross - tax) / 3.5));
      expect(next.ch.family.estate).toBe(Math.round(Math.round(((gross - tax) * 1.5) / 3.5) / pi));
      return { cash: next.ch.res.cash / pi, tax: tax / pi, estate: next.ch.family.estate, wealth: next.ch.family.wealth };
    });
    for (const r of results) {
      expect(Math.abs(r.cash - results[0].cash)).toBeLessThan(1);
      expect(Math.abs(r.tax - results[0].tax)).toBeLessThan(1);
      expect(Math.abs(r.estate - results[0].estate)).toBeLessThanOrEqual(1);
      expect(r.wealth).toBe(results[0].wealth);
    }
  });
});
