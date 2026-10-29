// 피임 상태가 실제 확률을 바꾼다 (검토 R-013)
//
// - 같은 노출(같은 시드·나이·행동 횟수)에서 방법만 다르면 모텔·해피타임이 거는 카드가 달라진다
//   (부부: 임신 카드, 연인: 임신 걱정 카드와 그 결과)
// - adult.json pregnancy 사건의 보정이 contraception.ts의 배수와 모든 태그 조합에서 같다
// - 걱정 카드의 두 줄 비율이 노출 때의 방법을 따른다. 결과가 없는 문맥(옛 저장·콘돔 파손)은 기본 65:35
// - 임신 준비·딩크의 기존 효과는 그대로다
// - 기간이 지나면 기록이 사라지고 확률이 돌아온다. 저장·재개 뒤에도 같은 결과가 나온다
// - 남성 주인공에게 상대가 쓰는 방법은 기록한 그 사람에게만 해당한다 (검토 R-020)
// - 같은 방법을 다시 고르면 기간을 새로 잡고, 임신 준비·출산 뒤에는 예전 방법이 저절로 돌아오지 않는다
// - 정관수술을 피임 습관으로 남기던 옛 저장을 바로잡는다
// - 콘돔이 찢어진 날 넘어간 경로도 여성 나이의 가임력을 따른다

import { describe, expect, it } from 'vitest';
import { DATING_SCARE_CHANCE, MARRIED_PREGNANCY_CHANCE, performActivity } from '../src/engine/activities';
import {
  CHILDFREE_RISK,
  CONCEIVED_CTX,
  CONTRA_CTX,
  CONTRA_METHODS,
  contraceptionMethod,
  fecundity,
  METHOD_INFO,
  methodRisk,
  pregnancyRisk,
  SCARE_POSITIVE_SHARE,
  scareChance,
  scarePositiveShare,
  TRYING_BOOST,
  undecidedScareShare,
  type ContraMethod,
} from '../src/engine/contraception';
import { getEvent, TAG_BY_ID } from '../src/engine/data';
import { addFlag } from '../src/engine/effects';
import { eventProbability, presentCard } from '../src/engine/eventEngine';
import { choose, doActivity, endTurn, newGame, proceed } from '../src/engine/game';
import { breakUp, divorce, haveChild, marry, startPartner } from '../src/engine/relations';
import { rngFor } from '../src/engine/rng';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import type { NextRef } from '../src/engine/schema';
import type { GameState, Sex } from '../src/engine/types';

/** 피임 상태를 뜻하는 태그 전부 (딩크·임신 준비 포함) */
const STATE_FLAGS = ['rom_safe', 'rom_pill_use', 'rom_larc', 'med_vasectomy', 'rom_trying', 'rom_childfree'];

const METHOD_FLAG: Record<Exclude<ContraMethod, 'none'>, string> = {
  condom: 'rom_safe',
  pill: 'rom_pill_use',
  longActing: 'rom_larc',
  permanent: 'med_vasectomy',
};

interface CoupleOpts {
  sex?: Sex;
  married?: boolean;
  age?: number;
  /** 짝의 나이 (기본: 나와 같다) */
  mateAge?: number;
}

/** 시험용 성인 커플. 나이·성별을 바로 정하고 돈과 시간을 넉넉히 준다 */
function couple(seed: string, opts: CoupleOpts = {}): GameState {
  const s = newGame({ seed, mode: 'reality', birthYear: 2026 });
  const age = opts.age ?? 30;
  s.ch.sex = opts.sex ?? 'F';
  s.ch.age = age;
  s.year = 2026 + age;
  s.world.year = s.year;
  s.ch.res.cash = 50_000_000;
  s.points = { max: 6, left: 6 };
  s.ch.npcs = s.ch.npcs.filter((n) => !['partner', 'spouse', 'child', 'ex'].includes(n.role));
  const mate = startPartner(s, rngFor(seed, 'mate'));
  mate.birthYear = s.year - (opts.mateAge ?? age);
  if (opts.married) marry(s);
  return s;
}

function withMethod(s: GameState, m: ContraMethod): GameState {
  const c = structuredClone(s);
  if (m !== 'none') addFlag(c, METHOD_FLAG[m], []);
  return c;
}

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** 위험이 큰 것부터 (none → permanent) */
const BY_RISK: ContraMethod[] = ['none', 'condom', 'pill', 'longActing', 'permanent'];

describe('방법·기간 표', () => {
  it('위험 배수는 일반 사용 첫해 실패율 ÷ 85%이고, 센 방법일수록 작으며 0이 아니다', () => {
    expect(methodRisk('none')).toBe(1);
    expect(methodRisk('condom')).toBeCloseTo(0.13 / 0.85, 10);
    expect(methodRisk('pill')).toBeCloseTo(0.07 / 0.85, 10);
    expect(methodRisk('longActing')).toBeCloseTo(0.004 / 0.85, 10);
    expect(methodRisk('permanent')).toBeCloseTo(0.0015 / 0.85, 10);
    for (let i = 1; i < BY_RISK.length; i++) {
      expect(methodRisk(BY_RISK[i])).toBeLessThan(methodRisk(BY_RISK[i - 1]));
      expect(methodRisk(BY_RISK[i])).toBeGreaterThan(0);
    }
  });

  it('습관은 3년, 피임약은 2년, 장치는 5년 뒤 끝나고 정관수술은 끝나지 않는다', () => {
    expect(METHOD_INFO.condom.kind).toBe('habit');
    expect(METHOD_INFO.pill.kind).toBe('current');
    expect(METHOD_INFO.longActing.kind).toBe('current');
    expect(METHOD_INFO.permanent.kind).toBe('permanent');
    expect(TAG_BY_ID.get('rom_safe')?.duration).toBe(3);
    expect(TAG_BY_ID.get('rom_pill_use')?.duration).toBe(2);
    expect(TAG_BY_ID.get('rom_larc')?.duration).toBe(5);
    expect(TAG_BY_ID.get('med_vasectomy')).toBeDefined();
    expect(TAG_BY_ID.get('med_vasectomy')?.duration).toBeUndefined();
    // 표의 모든 방법은 실제 태그로 기록된다
    for (const m of CONTRA_METHODS) {
      const flag = METHOD_INFO[m].flag;
      if (m === 'none') expect(flag).toBeUndefined();
      else expect(TAG_BY_ID.has(flag!), m).toBe(true);
    }
  });

  it('가임력은 30세 이하 1, 40세 0.25 (월 20% → 5%), 나이가 들수록 준다', () => {
    expect(fecundity(22)).toBe(1);
    expect(fecundity(30)).toBe(1);
    expect(fecundity(40)).toBeCloseTo(0.25, 10);
    expect(fecundity(44)).toBeCloseTo(0.06, 10);
    for (let a = 30; a < 44; a++) expect(fecundity(a + 1)).toBeLessThan(fecundity(a));
  });
});

describe('어느 방법이 적용되는가', () => {
  it('둘 이상 기록돼 있으면 가장 센 방법 하나', () => {
    const s = couple('PICK', { sex: 'M', married: true });
    expect(contraceptionMethod(s)).toBe('none');
    addFlag(s, 'rom_safe', []);
    expect(contraceptionMethod(s)).toBe('condom');
    addFlag(s, 'rom_pill_use', []);
    expect(contraceptionMethod(s)).toBe('pill');
    addFlag(s, 'rom_larc', []);
    expect(contraceptionMethod(s)).toBe('longActing');
    addFlag(s, 'med_vasectomy', []);
    expect(contraceptionMethod(s)).toBe('permanent');
  });

  it('임신 준비 중이면 되돌릴 수 있는 방법은 멈추고, 정관수술은 그대로다', () => {
    const s = couple('TRYING', { sex: 'M', married: true });
    addFlag(s, 'rom_pill_use', []);
    addFlag(s, 'rom_trying', []);
    expect(contraceptionMethod(s)).toBe('none');
    expect(pregnancyRisk(s)).toBeCloseTo(TRYING_BOOST, 10);
    addFlag(s, 'med_vasectomy', []);
    expect(contraceptionMethod(s)).toBe('permanent');
    expect(pregnancyRisk(s)).toBeCloseTo(methodRisk('permanent') * TRYING_BOOST, 10);
  });

  it('정관수술은 남성 주인공 본인만, 피임약·장치는 남성 주인공에게 지금 짝의 것만', () => {
    const woman = couple('HOLDER-F', { sex: 'F' });
    addFlag(woman, 'med_vasectomy', []);
    expect(contraceptionMethod(woman)).toBe('none');

    // 남성 주인공: 지금 연인과 사귀기 전에 기록된 피임약은 다른 사람의 것이다
    const man = couple('HOLDER-M', { sex: 'M' });
    const partner = man.ch.npcs.find((n) => n.role === 'partner')!;
    man.ch.flags.rom_pill_use = { since: partner.since! - 1, until: partner.since! + 1 };
    expect(contraceptionMethod(man)).toBe('none');
    man.ch.flags.rom_pill_use = { since: partner.since!, until: partner.since! + 2 };
    expect(contraceptionMethod(man)).toBe('pill');

    // 여성 주인공의 약은 본인 것: 짝이 바뀌어도 남는다
    const her = couple('HOLDER-F2', { sex: 'F' });
    her.ch.flags.rom_pill_use = { since: her.ch.age - 1, until: her.ch.age + 1 };
    expect(contraceptionMethod(her)).toBe('pill');

    // 주인을 남기지 않은 옛 기록: 배우자도 혼인 뒤 기록만 센다 (새 짝에게 예전 사람의 방법을 붙이지 않는다)
    const husband = couple('HOLDER-M2', { sex: 'M', married: true });
    husband.ch.flags.rom_larc = { since: husband.ch.age - 2, until: husband.ch.age + 3 };
    expect(contraceptionMethod(husband)).toBe('none');
    husband.ch.flags.rom_larc = { since: husband.ch.age, until: husband.ch.age + 5 };
    expect(contraceptionMethod(husband)).toBe('longActing');
  });

  it('딩크와 임신 준비의 기존 배수는 그대로다 (0.1, 1.5, 함께면 0.15)', () => {
    const s = couple('KEEP', { sex: 'F', married: true });
    addFlag(s, 'rom_childfree', []);
    expect(pregnancyRisk(s)).toBeCloseTo(CHILDFREE_RISK, 10);
    addFlag(s, 'rom_trying', []);
    expect(pregnancyRisk(s)).toBeCloseTo(CHILDFREE_RISK * TRYING_BOOST, 10);
    delete s.ch.flags.rom_childfree;
    expect(pregnancyRisk(s)).toBeCloseTo(TRYING_BOOST, 10);
    // 딩크에 더 센 방법이 기록되면 그 방법, 약한 방법이면 0.1
    const t = couple('KEEP2', { sex: 'F', married: true });
    addFlag(t, 'rom_childfree', []);
    addFlag(t, 'rom_safe', []);
    expect(pregnancyRisk(t)).toBeCloseTo(CHILDFREE_RISK, 10);
    addFlag(t, 'rom_pill_use', []);
    expect(pregnancyRisk(t)).toBeCloseTo(methodRisk('pill'), 10);
  });
});

describe('pregnancy 사건의 가중치 (adult.json)', () => {
  const ev = getEvent('pregnancy');

  it('모든 태그 조합·성별에서 보정 배수가 contraception.ts의 배수와 같다', () => {
    for (const sex of ['M', 'F'] as Sex[]) {
      const base = couple(`JSON-${sex}`, { sex, married: true });
      const m0 = eventProbability(ev, base).m;
      expect(pregnancyRisk(base)).toBe(1);
      for (let mask = 0; mask < 1 << STATE_FLAGS.length; mask++) {
        const s = structuredClone(base);
        STATE_FLAGS.forEach((f, i) => {
          if (mask & (1 << i)) addFlag(s, f, []);
        });
        const ratio = eventProbability(ev, s).m / m0;
        const want = pregnancyRisk(s);
        expect(Math.abs(ratio / want - 1), `${sex} ${STATE_FLAGS.filter((_, i) => mask & (1 << i)).join('+')}`).toBeLessThan(1e-3);
      }
    }
  });

  it('같은 부부·같은 나이에서 방법마다 확률이 다르다 (검토 R-013의 0.144 재현 상태)', () => {
    const s = couple('REVIEW-CONTRACEPTION', { sex: 'M', married: true });
    const P = BY_RISK.map((m) => eventProbability(ev, withMethod(s, m)).P);
    for (let i = 1; i < P.length; i++) expect(P[i]).toBeLessThan(P[i - 1]);
    expect(P[1] / P[0]).toBeCloseTo(methodRisk('condom'), 3);
    expect(P[4]).toBeGreaterThan(0);
  });
});

describe('모텔·해피타임: 같은 노출, 다른 방법', () => {
  const SEEDS = 3000;

  it('부부: 방법이 셀수록 임신 카드가 덜 걸리고, 같은 난수에서 결과가 단조롭다', () => {
    const counts = Object.fromEntries(BY_RISK.map((m) => [m, 0])) as Record<ContraMethod, number>;
    for (let i = 0; i < SEEDS; i++) {
      const base = couple(`SAFE-M-${i}`, { sex: 'M', married: true });
      const queued = BY_RISK.map((m) => {
        const s = withMethod(base, m);
        performActivity(s, 'happytime');
        return s.queue.some((q) => q.eventId === 'pregnancy');
      });
      queued.forEach((q, k) => {
        if (q) counts[BY_RISK[k]] += 1;
        // 센 방법에서 걸렸으면 약한 방법에서도 걸린다 (같은 난수, 더 큰 확률)
        if (q) for (let j = 0; j < k; j++) expect(queued[j]).toBe(true);
      });
    }
    const expected = (m: ContraMethod) => SEEDS * MARRIED_PREGNANCY_CHANCE * methodRisk(m);
    expect(counts.none).toBeGreaterThan(expected('none') * 0.75);
    expect(counts.none).toBeLessThan(expected('none') * 1.25);
    expect(counts.condom).toBeGreaterThan(expected('condom') * 0.4);
    expect(counts.condom).toBeLessThan(expected('condom') * 1.6);
    expect(counts.condom).toBeLessThan(counts.none / 3);
    expect(counts.pill).toBeLessThan(counts.condom);
    expect(counts.longActing).toBeLessThanOrEqual(5);
    expect(counts.permanent).toBeLessThanOrEqual(counts.longActing);
  });

  it('연인: 걱정 카드가 덜 걸리고, 걸린 카드 중 실제 임신의 비율도 방법을 따른다', () => {
    const scares = Object.fromEntries(BY_RISK.map((m) => [m, 0])) as Record<ContraMethod, number>;
    const pregnant = { ...scares };
    for (let i = 0; i < SEEDS; i++) {
      const base = couple(`SAFE-D-${i}`, { sex: 'M' });
      const out = BY_RISK.map((m) => {
        const s = withMethod(base, m);
        performActivity(s, 'happytime');
        const card = s.queue.find((q) => q.eventId === 'rom_pregnancy_scare');
        if (card) {
          // 노출 때의 방법과 결과가 카드 문맥에 남는다
          expect(card.ctx[CONTRA_CTX]).toBe(m);
          expect(['yes', 'no']).toContain(card.ctx[CONCEIVED_CTX]);
        }
        return { scare: Boolean(card), yes: card?.ctx[CONCEIVED_CTX] === 'yes' };
      });
      out.forEach((o, k) => {
        if (o.scare) scares[BY_RISK[k]] += 1;
        if (o.yes) pregnant[BY_RISK[k]] += 1;
        for (let j = 0; j < k; j++) {
          if (o.scare) expect(out[j].scare).toBe(true);
          if (o.yes) expect(out[j].yes).toBe(true);
        }
      });
    }
    expect(scares.none).toBeGreaterThan(SEEDS * DATING_SCARE_CHANCE * 0.75);
    expect(scares.none).toBeLessThan(SEEDS * DATING_SCARE_CHANCE * 1.25);
    expect(scares.condom).toBeLessThan(scares.none);
    expect(scares.permanent).toBeLessThanOrEqual(scares.longActing);
    // 걱정 중 두 줄: 방법 없음 약 35%, 콘돔 약 8%, 장기 피임 거의 0
    expect(pregnant.none / scares.none).toBeGreaterThan(0.2);
    expect(pregnant.none / scares.none).toBeLessThan(0.5);
    expect(pregnant.condom).toBeLessThan(pregnant.none / 3);
    expect(pregnant.longActing).toBeLessThanOrEqual(2);
    expect(scarePositiveShare('none')).toBeCloseTo(SCARE_POSITIVE_SHARE, 10);
    expect(scarePositiveShare('condom')).toBeLessThan(0.1);
    expect(scareChance(DATING_SCARE_CHANCE, 'none')).toBeCloseTo(DATING_SCARE_CHANCE, 10);
  });

  it('검토 재현 상태(REVIEW-SAFE-0..499)에서 피임 습관이 있으면 대기열이 달라진다', () => {
    let without = 0;
    let withSafe = 0;
    for (let i = 0; i < 500; i++) {
      const a = couple(`REVIEW-SAFE-${i}`, { sex: 'M' });
      const b = withMethod(a, 'condom');
      performActivity(a, 'happytime');
      performActivity(b, 'happytime');
      without += a.queue.length;
      withSafe += b.queue.length;
    }
    expect(withSafe).toBeLessThan(without);
  });

  it('모텔 데이트도 같은 규칙을 쓰고, 여성 나이가 많으면 덜 걸린다', () => {
    let young = 0;
    let older = 0;
    let safe = 0;
    for (let i = 0; i < 2000; i++) {
      const a = couple(`MOTEL-${i}`, { sex: 'M', married: true, mateAge: 30 });
      const b = structuredClone(a);
      b.ch.npcs.find((n) => n.role === 'spouse')!.birthYear = b.year - 42;
      const c = withMethod(a, 'condom');
      for (const s of [a, b, c]) performActivity(s, 'motel');
      young += a.queue.length;
      older += b.queue.length;
      safe += c.queue.length;
    }
    expect(older).toBeLessThan(young / 3);
    expect(safe).toBeLessThan(young / 3);
  });
});

describe('걱정 카드의 두 줄 (rom_pregnancy_scare)', () => {
  const ev = getEvent('rom_pregnancy_scare');

  /** 걱정 카드를 띄우고 첫 선택지를 고른 뒤 이어질 사건 */
  function nextAfter(s: GameState, ctx: Record<string, string>): { next: NextRef | undefined; resolved?: string } {
    expect(presentCard(s, { eventId: 'rom_pregnancy_scare', ctx })).toBe(true);
    const shown = s.card!.choices;
    expect(shown.length).toBe(2);
    const def = ev.choices![shown[0].index];
    choose(s, 0);
    return { next: def.next, resolved: s.card!.result?.next };
  }

  it('노출 때 정한 결과를 따르고, 결과가 없으면 기본 가중치 65:35를 쓴다', () => {
    const yes = nextAfter(couple('SCARE-YES', { sex: 'F' }), { [CONTRA_CTX]: 'condom', [CONCEIVED_CTX]: 'yes' });
    expect(yes.resolved).toBe('rom_pregnancy_positive');
    const no = nextAfter(couple('SCARE-NO', { sex: 'F' }), { [CONTRA_CTX]: 'none', [CONCEIVED_CTX]: 'no' });
    expect(no.resolved).toBe('rom_pregnancy_negative');
    const unknown = nextAfter(couple('SCARE-OLD', { sex: 'F' }), {});
    expect(unknown.next).toEqual([
      { event: 'rom_pregnancy_negative', w: 65 },
      { event: 'rom_pregnancy_positive', w: 35 },
    ]);
    expect(35 / (65 + 35)).toBeCloseTo(SCARE_POSITIVE_SHARE, 10);
  });

  it('옛 저장에 떠 있던 카드의 선택지 번호는 예전과 같은 선택지를 가리킨다', () => {
    // 원래 네 선택지는 그 자리에 그대로 (결과가 정해지지 않은 경우 = 예전 동작), 결과별 선택지는 뒤에
    const scare = ev.choices!;
    expect(scare.slice(0, 4).map((c) => c.text)).toEqual(['같이 결과를 기다린다', '혼자 확인하고 싶다고 말한다', '같이 결과를 기다린다', '병원부터 가 본다']);
    for (const c of scare.slice(0, 2)) {
      expect(c.next).toEqual([
        { event: 'rom_pregnancy_negative', w: 65 },
        { event: 'rom_pregnancy_positive', w: 35 },
      ]);
    }
    const pill = getEvent('rom_pill').choices!;
    expect(pill.slice(0, 3).map((c) => c.text)).toEqual(['피임약을 먹기 시작한다', '다른 피임법도 상담받는다', '{연인}에게도 책임을 나누자고 말한다']);
  });

  it('선택지는 검증 한도(8개) 안이고, 결과마다 보이는 선택지는 둘이다', () => {
    expect(ev.choices!.length).toBeLessThanOrEqual(8);
    for (const conceived of ['yes', 'no', undefined]) {
      const s = couple(`SCARE-SHOWN-${conceived}`, { sex: 'M' });
      presentCard(s, { eventId: 'rom_pregnancy_scare', ctx: conceived ? { [CONCEIVED_CTX]: conceived } : {} });
      expect(s.card!.choices.map((c) => c.text)).toEqual(['같이 결과를 기다린다', '혼자 확인하고 싶다고 말한다']);
    }
  });

  it('활동에서 시작한 걱정이 화면 흐름을 따라 같은 결과 카드로 이어진다', () => {
    let checked = 0;
    for (let i = 0; i < 400 && checked < 5; i++) {
      const s = couple(`SCARE-FLOW-${i}`, { sex: 'F' });
      doActivity(s, 'happytime');
      if (s.card?.eventId !== 'rom_pregnancy_scare') continue;
      const want = s.card.ctx[CONCEIVED_CTX] === 'yes' ? 'rom_pregnancy_positive' : 'rom_pregnancy_negative';
      choose(s, 1);
      proceed(s);
      expect(s.card?.eventId).toBe(want);
      checked++;
    }
    expect(checked).toBe(5);
  });
});

describe('카드의 선택이 방법을 기록한다', () => {
  /** 카드를 띄우고 글자로 선택지를 고른다 */
  function pick(s: GameState, eventId: string, text: string): void {
    expect(presentCard(s, { eventId, ctx: {} })).toBe(true);
    const i = s.card!.choices.findIndex((c) => c.text === text);
    expect(i, `${eventId}: ${text}`).toBeGreaterThanOrEqual(0);
    choose(s, i);
  }

  it('피임약·장치·콘돔·정관수술 선택이 각자의 방법이 되고 확률을 바꾼다', () => {
    const pill = couple('CARD-PILL', { sex: 'F' });
    pick(pill, 'rom_pill', '피임약을 먹기 시작한다');
    expect(contraceptionMethod(pill)).toBe('pill');

    const larc = couple('CARD-LARC', { sex: 'F' });
    pick(larc, 'rom_pill', '자궁 내 장치를 하기로 한다');
    expect(contraceptionMethod(larc)).toBe('longActing');

    const stop = couple('CARD-STOP', { sex: 'M' });
    addFlag(stop, 'rom_pill_use', []);
    pick(stop, 'rom_pill_partner', '피임은 내가 챙기겠다고 말한다');
    expect(stop.ch.flags.rom_pill_use).toBeUndefined();
    expect(contraceptionMethod(stop)).toBe('condom');

    const vas = couple('CARD-VAS', { sex: 'M', married: true });
    for (const k of [1, 2]) haveChild(vas, rngFor('CARD-VAS', 'kid', k)).birthYear = vas.year - 2 * k;
    pick(vas, 'rom_vasectomy', '수술을 받는다');
    expect(contraceptionMethod(vas)).toBe('permanent');
    expect(vas.ch.flags.rom_safe).toBeUndefined();
    // 이미 수술했으면 '이제 내 차례' 카드는 다시 오지 않는다
    expect(presentCard(structuredClone(vas), { eventId: 'rom_vasectomy', ctx: {} })).toBe(false);

    const plan = couple('CARD-PLAN', { sex: 'F', married: true });
    haveChild(plan, rngFor('CARD-PLAN', 'baby'));
    const before = eventProbability(getEvent('pregnancy'), plan).P;
    pick(plan, 'rom_family_planning', '자궁 내 장치를 하기로 한다');
    expect(contraceptionMethod(plan)).toBe('longActing');
    expect(eventProbability(getEvent('pregnancy'), plan).P).toBeLessThan(before / 100);
  });
});

describe('기간 만료', () => {
  /** 한 해를 넘긴다: 카드는 첫 선택지로 처리한다 */
  function nextYear(s: GameState): void {
    const age = s.ch.age;
    for (let guard = 0; guard < 400 && s.phase !== 'dead' && s.ch.age === age; guard++) {
      if (s.phase === 'action') endTurn(s);
      else if (s.card && s.card.choices.length > 0 && !s.card.result) choose(s, 0);
      else proceed(s);
    }
  }

  it('태그 기간이 끝나면 방법이 사라지고 위험 배수가 1로 돌아온다. 정관수술은 남는다', () => {
    const s = couple('EXPIRE', { sex: 'M', married: true });
    const start = s.ch.age;
    addFlag(s, 'rom_safe', []);
    addFlag(s, 'rom_pill_use', []);
    addFlag(s, 'rom_larc', []);
    expect(s.ch.flags.rom_safe.until).toBe(start + 3);
    expect(s.ch.flags.rom_pill_use.until).toBe(start + 2);
    expect(s.ch.flags.rom_larc.until).toBe(start + 5);
    const own = (f: string) => s.ch.flags[f]?.since === start;
    const seen: Record<number, string[]> = {};
    for (let y = 0; y < 6 && s.phase !== 'dead'; y++) {
      seen[s.ch.age - start] = ['rom_safe', 'rom_pill_use', 'rom_larc'].filter(own);
      nextYear(s);
    }
    // 넣은 해부터 duration번째 해까지 남고, 그해 연말에 사라진다
    expect(seen[0]).toEqual(['rom_safe', 'rom_pill_use', 'rom_larc']);
    expect(seen[2]).toEqual(['rom_safe', 'rom_pill_use', 'rom_larc']);
    expect(seen[3]).toEqual(['rom_safe', 'rom_larc']);
    expect(seen[4]).toEqual(['rom_larc']);
    expect(seen[5]).toEqual(['rom_larc']);
    expect(own('rom_larc')).toBe(false);

    // 올해 연말에 끝나는 습관: 한 해가 지나면 방법 없음, 확률은 기록이 없던 것과 같다
    const after = couple('EXPIRE-2', { sex: 'M', married: true });
    after.ch.flags.rom_safe = { since: after.ch.age - 3, until: after.ch.age };
    expect(contraceptionMethod(after)).toBe('condom');
    nextYear(after);
    for (const f of STATE_FLAGS) expect(after.ch.flags[f], f).toBeUndefined();
    expect(contraceptionMethod(after)).toBe('none');
    expect(pregnancyRisk(after)).toBe(1);
    const renewed = structuredClone(after);
    addFlag(renewed, 'rom_safe', []);
    const ev = getEvent('pregnancy');
    expect(eventProbability(ev, renewed).m / eventProbability(ev, after).m).toBeCloseTo(methodRisk('condom'), 3);

    const vas = couple('EXPIRE-VAS', { sex: 'M', married: true });
    addFlag(vas, 'med_vasectomy', []);
    for (let y = 0; y < 3; y++) nextYear(vas);
    expect(vas.ch.flags.med_vasectomy).toBeDefined();
  });
});

describe('저장과 재개', () => {
  it('저장했다 불러와도 방법과 확률이 같고, 같은 노출에서 같은 카드가 걸린다', () => {
    for (const m of CONTRA_METHODS) {
      const storage = memoryStorage();
      const s = withMethod(couple(`SAVE-${m}`, { sex: 'M', married: true }), m);
      expect(saveGame(s, storage)).toBe(true);
      const loaded = loadGame(storage)!;
      expect(loaded).toEqual(s);
      expect(contraceptionMethod(loaded)).toBe(m);
      expect(pregnancyRisk(loaded)).toBe(pregnancyRisk(s));
      expect(eventProbability(getEvent('pregnancy'), loaded).P).toBe(eventProbability(getEvent('pregnancy'), s).P);
      performActivity(s, 'happytime');
      performActivity(loaded, 'happytime');
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(s));
    }
  });

  it('걱정 카드가 떠 있을 때 저장해도 결과가 같고 한 번만 적용된다', () => {
    for (const conceived of ['yes', 'no']) {
      const storage = memoryStorage();
      const s = couple(`SAVE-SCARE-${conceived}`, { sex: 'F' });
      presentCard(s, { eventId: 'rom_pregnancy_scare', ctx: { [CONTRA_CTX]: 'pill', [CONCEIVED_CTX]: conceived } });
      saveGame(s, storage);
      const loaded = loadGame(storage)!;
      choose(s, 0);
      choose(loaded, 0);
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(s));
      // 이미 고른 카드를 다시 골라도 바뀌지 않는다
      saveGame(loaded, storage);
      const again = loadGame(storage)!;
      choose(again, 1);
      expect(JSON.stringify(again)).toBe(JSON.stringify(loaded));
      proceed(s);
      proceed(again);
      expect(s.card?.eventId).toBe(conceived === 'yes' ? 'rom_pregnancy_positive' : 'rom_pregnancy_negative');
      expect(JSON.stringify(again)).toBe(JSON.stringify(s));
    }
  });

  it('피임 기록·문맥이 없는 옛 저장도 불러오고, 방법 없음과 기본 가중치로 읽힌다', () => {
    const storage = memoryStorage();
    const s = couple('OLD-SAVE', { sex: 'F' });
    for (const f of STATE_FLAGS) expect(s.ch.flags[f]).toBeUndefined();
    s.queue.push({ eventId: 'rom_pregnancy_scare', ctx: {} });
    saveGame(s, storage);
    const loaded = loadGame(storage)!;
    expect(contraceptionMethod(loaded)).toBe('none');
    expect(pregnancyRisk(loaded)).toBe(1);
    const pending = loaded.queue.shift()!;
    expect(presentCard(loaded, pending)).toBe(true);
    const def = getEvent('rom_pregnancy_scare').choices![loaded.card!.choices[0].index];
    expect(def.next).toEqual([
      { event: 'rom_pregnancy_negative', w: 65 },
      { event: 'rom_pregnancy_positive', w: 35 },
    ]);
  });
});

/** 카드를 띄우고 글자(앞부분)로 선택지를 고른 뒤 카드를 닫는다 */
function pickText(s: GameState, eventId: string, text: string): void {
  expect(presentCard(s, { eventId, ctx: {} }), eventId).toBe(true);
  const i = s.card!.choices.findIndex((c) => c.text.startsWith(text));
  expect(i, `${eventId}: ${text}`).toBeGreaterThanOrEqual(0);
  choose(s, i);
  s.card = undefined;
}

/** 한 해 뒤로 (사건 없이 나이만) */
function ageOneYear(s: GameState): void {
  s.ch.age += 1;
  s.year += 1;
  s.world.year = s.year;
}

describe('누구의 방법인가 (검토 R-020)', () => {
  const ev = getEvent('pregnancy');

  it('이혼한 배우자의 장치가 새 배우자에게 붙지 않는다: 활동 경로와 pregnancy 사건이 같다', () => {
    // 검토 재현: 남성 주인공이 배우자 A와 산후 상담에서 장치를 고르고, 이혼한 뒤 B와 사귀다 결혼한다
    const s = couple('REVIEW-PARTNER-CONTRA', { sex: 'M', married: true });
    const a = s.ch.npcs.find((n) => n.role === 'spouse')!;
    haveChild(s, rngFor('x', 'kid')).birthYear = s.year;
    pickText(s, 'rom_family_planning', '다음 진료에 같이');
    expect(s.ch.flags.rom_larc.owner).toBe(a.id);
    expect(contraceptionMethod(s)).toBe('longActing');
    divorce(s);
    ageOneYear(s);
    startPartner(s, rngFor('x', 'B')).birthYear = s.year - 30;
    expect(contraceptionMethod(s)).toBe('none');
    marry(s);
    expect(contraceptionMethod(s)).toBe('none');
    expect(pregnancyRisk(s)).toBe(1);
    const control = structuredClone(s);
    delete control.ch.flags.rom_larc;
    expect(eventProbability(ev, s).P).toBe(eventProbability(ev, control).P);
  });

  it('같은 해에 연인이 바뀌어도 예전 연인의 피임약은 새 연인의 것이 아니다', () => {
    const t = couple('SAME-YEAR', { sex: 'M' });
    addFlag(t, 'rom_pill_use', []);
    expect(contraceptionMethod(t)).toBe('pill');
    breakUp(t);
    startPartner(t, rngFor('x', 'B2')).birthYear = t.year - 30;
    expect(contraceptionMethod(t)).toBe('none');
    // 모텔·해피타임도 같은 판단: 같은 노출에서 기록이 없을 때와 같은 카드가 걸린다
    for (let i = 0; i < 200; i++) {
      const a = structuredClone(t);
      a.seed = `SAME-YEAR-${i}`;
      const b = structuredClone(a);
      delete b.ch.flags.rom_pill_use;
      performActivity(a, 'happytime');
      performActivity(b, 'happytime');
      expect(a.queue).toEqual(b.queue);
    }
  });

  it('연인일 때 시작한 약은 그 사람과 결혼해도 이어진다. 여성 주인공의 약은 짝이 바뀌어도 본인 것이다', () => {
    const s = couple('PILL-THEN-MARRY', { sex: 'M' });
    pickText(s, 'rom_pill_partner', '다음 진료에 같이 가자고 한다');
    ageOneYear(s);
    marry(s);
    expect(contraceptionMethod(s)).toBe('pill');
    const none = structuredClone(s);
    delete none.ch.flags.rom_pill_use;
    expect(eventProbability(ev, s).m / eventProbability(ev, none).m).toBeCloseTo(methodRisk('pill'), 3);

    const her = couple('HER-PILL', { sex: 'F' });
    pickText(her, 'rom_pill', '피임약을 먹기 시작한다');
    expect(her.ch.flags.rom_pill_use.owner).toBeUndefined();
    breakUp(her);
    startPartner(her, rngFor('x', 'new')).birthYear = her.year - 30;
    expect(contraceptionMethod(her)).toBe('pill');
  });

  it('주인이 기록된 방법도 저장했다 불러오면 그대로다', () => {
    const storage = memoryStorage();
    const s = couple('OWNER-SAVE', { sex: 'M', married: true });
    addFlag(s, 'rom_larc', []);
    saveGame(s, storage);
    const loaded = loadGame(storage)!;
    expect(loaded.ch.flags.rom_larc).toEqual(s.ch.flags.rom_larc);
    expect(contraceptionMethod(loaded)).toBe('longActing');
  });
});

describe('다시 고르기와 멈춘 방법', () => {
  it('같은 방법을 다시 고르면 기간을 새로 잡는다 (돈을 내고 넣은 장치가 1년 만에 끝나지 않는다)', () => {
    const s = couple('RENEW', { sex: 'F', married: true, age: 34 });
    s.ch.flags.rom_larc = { since: 30, until: 35 };
    haveChild(s, rngFor('x', 'k')).birthYear = s.year;
    pickText(s, 'rom_family_planning', '자궁 내 장치를 하기로 한다');
    expect(s.ch.flags.rom_larc).toEqual({ since: 34, until: 39 });

    const c = couple('RENEW-SAFE', { sex: 'M' });
    c.ch.flags.rom_safe = { since: 28, until: 31 };
    pickText(c, 'rom_condom', '당당하게 계산한다');
    expect(c.ch.flags.rom_safe).toEqual({ since: 30, until: 33 });

    // 피임이 아닌 태그는 예전처럼 처음 붙은 때를 지킨다
    const other = couple('NO-RENEW', { sex: 'F' });
    other.ch.flags.rom_long_distance = { since: 29, until: 31 };
    addFlag(other, 'rom_long_distance', []);
    expect(other.ch.flags.rom_long_distance).toEqual({ since: 29, until: 31 });
  });

  it('임신 준비를 고르면 되돌릴 수 있는 방법을 그만두고, 준비가 끝나도 저절로 돌아오지 않는다', () => {
    const s = couple('PAUSE', { sex: 'F', married: true });
    addFlag(s, 'rom_pill_use', []);
    addFlag(s, 'rom_safe', []);
    pickText(s, 'rom_baby_plan', '임신 전 검사를 함께 받는다');
    expect(s.ch.flags.rom_trying).toBeDefined();
    expect(s.ch.flags.rom_pill_use).toBeUndefined();
    expect(s.ch.flags.rom_safe).toBeUndefined();
    delete s.ch.flags.rom_trying;
    expect(contraceptionMethod(s)).toBe('none');
    // 정관수술은 영구라 그대로다
    const m = couple('PAUSE-VAS', { sex: 'M', married: true });
    addFlag(m, 'med_vasectomy', []);
    pickText(m, 'rom_baby_plan', '임신 전 검사를 함께 받는다');
    expect(contraceptionMethod(m)).toBe('permanent');
  });

  it('아이가 태어나면 피임약·장치 기록이 끝난다 (콘돔 습관은 남는다)', () => {
    const s = couple('BIRTH', { sex: 'F', married: true });
    addFlag(s, 'rom_pill_use', []);
    addFlag(s, 'rom_safe', []);
    expect(presentCard(s, { eventId: 'pregnancy', ctx: {} })).toBe(true);
    choose(s, 0);
    expect(s.ch.npcs.filter((n) => n.role === 'child').length).toBe(1);
    expect(s.ch.flags.rom_pill_use).toBeUndefined();
    expect(s.ch.flags.rom_safe).toBeDefined();

    const r = couple('BIRTH-ROM', { sex: 'M', married: true });
    addFlag(r, 'rom_larc', []);
    pickText(r, 'rom_pregnancy_positive', '');
    expect(r.ch.npcs.filter((n) => n.role === 'child').length).toBe(1);
    expect(r.ch.flags.rom_larc).toBeUndefined();
  });
});

describe('옛 저장: 정관수술을 피임 습관으로 남기던 때', () => {
  /** b2f7384 전 rom_vasectomy를 본 40세 남성의 저장 */
  function oldSave(seed: string, result: string): GameState {
    const s = couple(seed, { sex: 'M', married: true, age: 40 });
    s.counts.rom_vasectomy = 1;
    s.lastAge.rom_vasectomy = 40;
    s.ch.flags.rom_safe = { since: 40, until: 45 };
    s.log.push({ year: s.year, age: 40, kind: 'event', title: '이제 내 차례', text: result });
    return s;
  }

  it('수술을 받은 기록이면 정관수술로 바꾸고, 수술 카드가 다시 오지 않는다', () => {
    const storage = memoryStorage();
    saveGame(oldSave('OLD-VAS', '생각보다 금방 끝났다. 이틀 동안 얼음찜질을 하며 소파에 누워 있었다. 그 이틀 동안 지은은 아주 다정했다.'), storage);
    const loaded = loadGame(storage)!;
    expect(loaded.ch.flags.med_vasectomy).toEqual({ since: 40 });
    expect(loaded.ch.flags.rom_safe).toBeUndefined();
    expect(contraceptionMethod(loaded)).toBe('permanent');
    for (const k of [1, 2]) haveChild(loaded, rngFor('OLD-VAS', 'kid', k)).birthYear = loaded.year - 2 * k;
    expect(presentCard(structuredClone(loaded), { eventId: 'med_vasectomy', ctx: {} })).toBe(false);
    expect(presentCard(structuredClone(loaded), { eventId: 'rom_vasectomy', ctx: {} })).toBe(false);
    // 다시 저장·불러오기를 해도 같다
    saveGame(loaded, storage);
    expect(loadGame(storage)).toEqual(loaded);
  });

  it('콘돔을 고른 기록이면 그대로 둔다', () => {
    const storage = memoryStorage();
    const s = oldSave('OLD-CONDOM', '협탁 서랍을 채워 두었다. 책임은 나눠 지는 거였다.');
    saveGame(s, storage);
    const loaded = loadGame(storage)!;
    expect(loaded).toEqual(s);
    expect(contraceptionMethod(loaded)).toBe('condom');
  });
});

describe('콘돔이 찢어진 날 (rom_emergency_pill)', () => {
  const ev = getEvent('rom_emergency_pill');

  it('사후피임약을 받은 선택지는 앞으로도 콘돔을 챙긴다고 말하고, 그 습관을 남긴다', () => {
    const rows = ev.choices!.filter((c) => c.effects?.addFlags?.includes('rom_safe'));
    expect(rows.length).toBe(2);
    for (const c of rows) expect(c.result).toContain('콘돔');
  });

  /** 여성 쪽 나이에서 '괜찮겠지'가 실패했을 때 실제 임신으로 이어질 확률 (걱정 카드의 기본 두 줄 35%) */
  function failPregnancy(sex: Sex, womanAge: number): number {
    const s = couple(`EMG-${sex}-${womanAge}`, sex === 'F' ? { sex, age: womanAge } : { sex, age: 40, mateAge: womanAge });
    expect(presentCard(s, { eventId: 'rom_emergency_pill', ctx: {} })).toBe(true);
    const shown = s.card!.choices.filter((c) => c.text === '괜찮겠지 하고 넘어간다');
    expect(shown.length).toBe(1);
    const next = ev.choices![shown[0].index].onFail!.next!;
    if (typeof next === 'string') return next === 'rom_pregnancy_scare' ? SCARE_POSITIVE_SHARE : 0;
    expect(next.every((n) => n.event === 'rom_pregnancy_scare' || n.event === 'rom_pregnancy_negative')).toBe(true);
    const total = next.reduce((a, n) => a + n.w, 0);
    const scare = next.find((n) => n.event === 'rom_pregnancy_scare')?.w ?? 0;
    return (scare / total) * SCARE_POSITIVE_SHARE;
  }

  it('실패한 뒤 임신으로 이어질 확률이 여성 나이의 가임력을 따른다 (남녀 주인공 모두)', () => {
    expect(failPregnancy('F', 25)).toBeCloseTo(SCARE_POSITIVE_SHARE, 10);
    for (const sex of ['F', 'M'] as Sex[]) {
      let prev = 1;
      for (const age of [25, 33, 38, 41, 44]) {
        const p = failPregnancy(sex, age);
        expect(p, `${sex} ${age}`).toBeLessThanOrEqual(prev);
        prev = p;
      }
      // 44세: 걱정 카드 중 두 줄의 비율 scarePositiveShare('none', 가임력)에 가깝다 (3% 안팎, 예전에는 35%)
      expect(failPregnancy(sex, 44)).toBeLessThan(0.06);
      expect(Math.abs(failPregnancy(sex, 41) - scarePositiveShare('none', fecundity(41)))).toBeLessThan(0.03);
    }
    expect(undecidedScareShare(1)).toBeCloseTo(1, 10);
  });

  it('선택지는 검증 한도(8개) 안이고, 원래 세 선택지는 그 자리에 있다', () => {
    expect(ev.choices!.length).toBeLessThanOrEqual(8);
    expect(ev.choices!.slice(0, 3).map((c) => c.text)).toEqual([
      '날이 밝자마자 병원에서 사후피임약을 처방받는다',
      '밤새 문 연 응급실을 찾아간다',
      '괜찮겠지 하고 넘어간다',
    ]);
  });
});
