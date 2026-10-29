// 성인기의 술·담배·약물 (개정 계획 '성인기의 술 담배와 약물', 검토 R-008·R-009)
//
// - 성인이 돼도 고르지 않으면 사용 이력·숙취·후속 사건이 없다
// - 직접 고른 사용만 이력이 되고, 첫 사용은 한 번만 기록된다
// - 저장·불러오기를 사이에 두어도 같은 선택이 두 번 적용되지 않는다
// - 미성년자는 메뉴·사건 선택지·처리 단계 어디에서도 자기 사용을 할 수 없다
// - 거절은 기록되고, 끊기·재발·다시 도움 요청이 이어진다

import { describe, expect, it } from 'vitest';
import { activityViews } from '../src/engine/activities';
import { jobOpenings, takeJob } from '../src/engine/career';
import { ACTIVITIES, EVENT_FILES, getEvent } from '../src/engine/data';
import { applyEffects } from '../src/engine/effects';
import { presentCard, triggerOk } from '../src/engine/eventEngine';
import { applyForJob, choose, doActivity, endTurn, newGame, proceed } from '../src/engine/game';
import { rngFor } from '../src/engine/rng';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import type { ActivityDef, ChoiceDef, Effects, EventDef } from '../src/engine/schema';
import { buildScope } from '../src/engine/scope';
import { isQuitting, readRecord, reconcileSubstanceFlags, substanceHealthDelta } from '../src/engine/substances';
import type { GameState, SubstanceId } from '../src/engine/types';
import { SUBSTANCE_IDS } from '../src/engine/types';
import { validateData } from '../src/engine/validate';

const USE_TAGS = ['smoker', 'vaper', 'heavy_drinker', 'drug_use'];
/** 술·담배·약물을 실제로 썼을 때만 일어날 수 있는 사건 */
const AFTER_USE = [
  'sub_next_morning',
  'sub_smoking_area',
  'sub_smoke_smell',
  'sub_quit_craving',
  'sub_sober_craving',
  'sub_family_worry',
  'sub_relapse',
  'sub_drug_arrest',
  'sub_drug_emergency',
  'sub_treatment_program',
  'phys_first_hangover',
];

function causesUse(fx: Effects | undefined): boolean {
  if (!fx) return false;
  if ((fx.addFlags ?? []).some((f) => USE_TAGS.includes(f))) return true;
  return (fx.do ?? []).some((a) => a.type === 'substance' && a.act === 'use');
}

function choiceUses(c: ChoiceDef): boolean {
  return causesUse(c.effects) || causesUse(c.onSuccess?.effects) || causesUse(c.onFail?.effects);
}

/** 화면에 뜬 카드에서 사용을 일으키지 않는 첫 선택지 */
function chooseWithoutUse(state: GameState): void {
  const card = state.card!;
  const ev = getEvent(card.eventId);
  const i = card.choices.findIndex((c) => !choiceUses(ev.choices![c.index]));
  choose(state, i >= 0 ? i : 0);
}

/** 대기 중인 카드를 모두 넘긴다 (사용하지 않는 선택지로) */
function drain(state: GameState): void {
  for (let guard = 0; guard < 200 && state.phase === 'event'; guard++) {
    if (state.card && state.card.choices.length > 0 && !state.card.result) chooseWithoutUse(state);
    else proceed(state);
  }
}

/** 한 해를 넘긴다 */
function nextYear(state: GameState): void {
  drain(state);
  const age = state.ch.age;
  if (state.phase === 'action') endTurn(state);
  for (let guard = 0; guard < 200 && state.phase !== 'dead' && (state.phase !== 'action' || state.ch.age === age); guard++) {
    if (state.phase === 'action') endTurn(state);
    else drain(state);
  }
}

/** 나이를 바로 정한 시험용 인물. 돈과 시간을 넉넉히 준다 */
function personAt(seed: string, age: number): GameState {
  const s = newGame({ seed, mode: 'reality', birthYear: 2026 });
  s.ch.age = age;
  s.year = 2026 + age;
  s.world.year = s.year;
  s.ch.res.cash = 50_000_000;
  s.points = { max: 6, left: 6 };
  return s;
}

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** 사용을 한 번도 고르지 않는 인생. 일은 구해서 회식·흡연 권유를 만나게 한다 */
function liveWithoutUse(seed: string): { state: GameState; tagsSeen: Set<string> } {
  const state = newGame({ seed, mode: 'reality', birthYear: 2026 });
  const tagsSeen = new Set<string>();
  for (let guard = 0; guard < 20_000 && state.phase !== 'dead'; guard++) {
    for (const f of USE_TAGS) if (state.ch.flags[f]) tagsSeen.add(f);
    if (state.phase === 'action') {
      const ch = state.ch;
      if (ch.age >= 19 && !ch.career.jobId && ch.edu.status !== 'university' && ch.military.status !== 'serving') {
        const best = jobOpenings(state).sort((a, b) => b.chance - a.chance)[0];
        if (best) applyForJob(state, best.job.id);
      }
      endTurn(state);
    } else if (state.card && state.card.choices.length > 0 && !state.card.result) {
      chooseWithoutUse(state);
    } else {
      proceed(state);
    }
  }
  return { state, tagsSeen };
}

describe('고르지 않으면 쓰지 않는다 (R-008)', () => {
  it('평생 사용을 고르지 않은 성인에게는 사용 이력·숙취·후속 사건이 없다', () => {
    let offers = 0;
    let refusals = 0;
    let adults = 0;
    for (let i = 0; i < 16; i++) {
      const { state, tagsSeen } = liveWithoutUse(`NEVER-USE-${i}`);
      if (state.ch.age >= 19) adults++;
      for (const id of SUBSTANCE_IDS) {
        const r = readRecord(state.ch, id);
        expect(r.ever, `${i} ${id}`).toBe(false);
        expect(r.uses, `${i} ${id}`).toBe(0);
        expect(r.firstAge, `${i} ${id}`).toBeUndefined();
        offers += r.offers;
        refusals += r.refusals;
      }
      expect([...tagsSeen], `${i}`).toEqual([]);
      for (const [id, n] of Object.entries(state.counts)) {
        if (AFTER_USE.includes(id) || id.startsWith('phys_hangover_')) expect(n, `${i} ${id}`).toBe(0);
      }
    }
    expect(adults).toBeGreaterThan(10);
    // 권유는 왔고, 거절은 기록됐다
    expect(offers).toBeGreaterThan(0);
    expect(refusals).toBeGreaterThan(0);
  });

  it('숙취 사건은 그해 실제로 마셨을 때만 열리고, 금주 다짐은 다음 음주를 정하지 않는다', () => {
    const s = personAt('HANGOVER', 24);
    const first = getEvent('phys_first_hangover');
    const hangover = getEvent('phys_hangover_bus');
    expect(triggerOk(first, buildScope(s), s)).toBe(false);
    expect(doActivity(s, 'drinking')).not.toBeNull();
    expect(triggerOk(first, buildScope(s), s)).toBe(true);

    // 다짐: 결과 문장이 다음 음주를 확정하지 않고, 금주 상태로 남는다
    const pledge = first.choices!.find((c) => c.text.includes('다시는'))!;
    expect(pledge.result).not.toMatch(/개강|일주일/);
    expect(presentCard(s, { eventId: 'phys_first_hangover', ctx: {} })).toBe(true);
    choose(s, s.card!.choices.findIndex((c) => c.text.includes('다시는')));
    proceed(s);
    reconcileSubstanceFlags(s);
    expect(isQuitting(readRecord(s.ch, 'alcohol'))).toBe(true);
    expect(s.ch.flags.quitting_drinking).toBeDefined();

    // 이듬해 마시지 않으면 숙취 사건 후보가 아니다
    nextYear(s);
    expect(readRecord(s.ch, 'alcohol').usesThisYear).toBe(0);
    expect(triggerOk(hangover, buildScope(s), s)).toBe(false);

    // 회식에서 첫 잔만 받은 정도로는 숙취가 없다
    const sip = personAt('HANGOVER-SIP', 30);
    takeJob(sip, 'sme_office');
    expect(presentCard(sip, { eventId: 'sub_hoesik', ctx: {} })).toBe(true);
    choose(sip, sip.card!.choices.findIndex((c) => c.text.includes('첫 잔만')));
    expect(readRecord(sip.ch, 'alcohol').ever).toBe(true);
    expect(triggerOk(first, buildScope(sip), sip)).toBe(false);
    expect(triggerOk(hangover, buildScope(sip), sip)).toBe(false);
  });
});

describe('직접 고른 사용', () => {
  it('사용 이력은 고른 만큼만 쌓이고 첫 사용 나이는 한 번만 기록된다', () => {
    const s = personAt('USE-ONCE', 25);
    const cash = s.ch.res.cash;
    expect(doActivity(s, 'drinking')).not.toBeNull();
    let a = readRecord(s.ch, 'alcohol');
    expect(a.ever).toBe(true);
    expect(a.uses).toBe(1);
    expect(a.firstAge).toBe(25);
    expect(s.ch.res.cash).toBe(cash - 300_000);
    expect(doActivity(s, 'drinking')).not.toBeNull();
    a = readRecord(s.ch, 'alcohol');
    expect(a.uses).toBe(2);
    expect(a.firstAge).toBe(25);
    expect(s.ch.res.cash).toBe(cash - 600_000);
    // 다른 물질은 그대로
    expect(readRecord(s.ch, 'tobacco').ever).toBe(false);
    expect(readRecord(s.ch, 'drug').ever).toBe(false);
  });

  it('독신 성인도 술·담배 활동을 할 수 있고, 커플 활동만 상대 조건을 따로 본다', () => {
    const s = personAt('SINGLE-ADULT', 25);
    const ids = activityViews(s).map((v) => v.def.id);
    expect(ids).toEqual(expect.arrayContaining(['drinking', 'drink_alone', 'smoke', 'vape']));
    expect(ids).not.toContain('motel');
    expect(ids).not.toContain('happytime');
    // 아직 쓰지 않았으니 줄이기·끊기·치료·약물 재사용은 보이지 않는다
    for (const id of ['drink_less', 'quit_drinking', 'quit_smoking', 'smoke_less', 'smoking_clinic', 'drug_use', 'addiction_treatment']) {
      expect(ids).not.toContain(id);
    }
  });

  it('담배를 거듭 고르면 의존이 쌓여 습관이 되고, 끊기·재발·다시 도움 요청이 이어진다', () => {
    const s = personAt('SMOKE-PATH', 22);
    for (let year = 0; year < 3; year++) {
      doActivity(s, 'smoke');
      doActivity(s, 'smoke');
      nextYear(s);
      s.ch.res.cash = 50_000_000;
    }
    let t = readRecord(s.ch, 'tobacco');
    expect(t.habit).toBeGreaterThanOrEqual(1);
    expect(t.dependence).toBeGreaterThanOrEqual(25);
    const ids = () => activityViews(s).map((v) => v.def.id);
    expect(ids()).toContain('quit_smoking');

    expect(doActivity(s, 'quit_smoking')).not.toBeNull();
    t = readRecord(s.ch, 'tobacco');
    expect(isQuitting(t)).toBe(true);
    expect(t.quitAttempts).toBe(1);
    expect(t.craving).toBeGreaterThan(0);
    expect(s.ch.flags.quitting_smoking).toBeDefined();
    expect(s.ch.flags.smoker).toBeUndefined();

    // 갈망을 못 이기고 다시 피운다 → 재발로 남는다
    expect(presentCard(s, { eventId: 'sub_quit_craving', ctx: {} })).toBe(true);
    choose(s, s.card!.choices.findIndex((c) => c.text.includes('한 대만')));
    proceed(s);
    t = readRecord(s.ch, 'tobacco');
    expect(isQuitting(t)).toBe(false);
    expect(t.relapses).toBe(1);

    // 재발 카드에서 다시 도움을 청한다
    drain(s);
    expect(presentCard(s, { eventId: 'sub_relapse', ctx: { substance: 'tobacco', 물질: '담배' } })).toBe(true);
    expect(s.card!.text).toContain('담배를');
    choose(s, 0);
    t = readRecord(s.ch, 'tobacco');
    expect(t.treatment).toBe('active');
    expect(t.treatmentStarts).toBe(1);
    expect(isQuitting(t)).toBe(true);
  });

  it('매일 피우면 기존 흡연자 보정(건강 −1.2)과 같고, 끊으면 붙지 않는다', () => {
    const s = personAt('HEALTH', 40);
    s.ch.flags.smoker = { since: 20 };
    expect(substanceHealthDelta(s.ch)).toBeCloseTo(-1.2, 6);
    reconcileSubstanceFlags(s);
    expect(substanceHealthDelta(s.ch)).toBeCloseTo(-1.2, 6);
    delete s.ch.flags.smoker;
    reconcileSubstanceFlags(s);
    expect(substanceHealthDelta(s.ch)).toBe(0);
  });
});

describe('저장과 재개', () => {
  it('저장했다 불러와도 기록이 같고, 같은 선택과 연말 결산이 두 번 적용되지 않는다', () => {
    const storage = memoryStorage();
    const s = personAt('SUB-SAVE', 30);
    takeJob(s, 'sme_office');
    doActivity(s, 'smoke');
    doActivity(s, 'smoke');
    expect(presentCard(s, { eventId: 'sub_hoesik', ctx: {} })).toBe(true);

    // 선택 전에 저장
    expect(saveGame(s, storage)).toBe(true);
    const loaded = loadGame(storage)!;
    expect(loaded).toEqual(s);
    choose(s, 0);
    choose(loaded, 0);
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(s));
    expect(readRecord(s.ch, 'alcohol').uses).toBe(1);
    expect(readRecord(s.ch, 'alcohol').usesThisYear).toBe(0.5);

    // 결과가 붙은 카드를 저장·불러온 뒤 다시 골라도 아무 일도 없다
    saveGame(loaded, storage);
    const again = loadGame(storage)!;
    const cash = again.ch.res.cash;
    choose(again, 0);
    choose(again, 1);
    expect(readRecord(again.ch, 'alcohol').uses).toBe(1);
    expect(again.ch.res.cash).toBe(cash);
    expect(JSON.stringify(again)).toBe(JSON.stringify(loaded));

    // 연말 결산: 각자 한 번씩, 결과가 같다
    nextYear(s);
    nextYear(again);
    expect(JSON.stringify(again)).toBe(JSON.stringify(s));
    expect(readRecord(s.ch, 'alcohol').usesThisYear).toBe(0);
    expect(readRecord(s.ch, 'tobacco').usesThisYear).toBe(0);
  });

  it('기록이 없는 옛 저장도 불러오고, 기록은 빈 것으로 읽힌다', () => {
    const storage = memoryStorage();
    const s = personAt('OLD-SAVE', 30);
    expect(s.ch.substances).toBeUndefined();
    saveGame(s, storage);
    const loaded = loadGame(storage)!;
    expect(loaded.ch.substances).toBeUndefined();
    expect(readRecord(loaded.ch, 'alcohol').ever).toBe(false);
    expect((buildScope(loaded).substance as { alcohol: { current: boolean } }).alcohol.current).toBe(false);
    // 일부 값이 빠진 기록은 빈 값만 채운다
    doActivity(s, 'drinking');
    const partial = JSON.parse(JSON.stringify(s));
    delete partial.ch.substances.alcohol.refusals;
    delete partial.ch.substances.drug;
    storage.setItem('lifesim.save.v1', JSON.stringify(partial));
    const fixed = loadGame(storage)!;
    expect(fixed.ch.substances!.alcohol.refusals).toBe(0);
    expect(fixed.ch.substances!.alcohol.uses).toBe(1);
    expect(fixed.ch.substances!.drug.ever).toBe(false);
  });
});

describe('미성년자 (R-009)', () => {
  it('미성년자에게는 술·담배·약물 사용 활동이 보이지 않고 실행해도 처리되지 않는다', () => {
    const s = personAt('MINOR', 15);
    const ids = activityViews(s).map((v) => v.def.id);
    for (const id of ['drinking', 'drink_alone', 'smoke', 'vape', 'drug_use']) expect(ids).not.toContain(id);
    expect(doActivity(s, 'smoke')).toBeNull();
    expect(doActivity(s, 'drinking')).toBeNull();
    // 처리 단계: 사건 효과가 사용을 시켜도 노출로만 남는다
    applyEffects(s, { do: [{ type: 'substance', substance: 'tobacco', act: 'use' }] }, { ctx: {}, rng: rngFor('MINOR-FX'), changes: [] });
    const t = readRecord(s.ch, 'tobacco');
    expect(t.ever).toBe(false);
    expect(t.uses).toBe(0);
    expect(t.offers).toBe(1);
    expect(s.ch.flags.smoker).toBeUndefined();
  });

  it('중학생 담배 권유는 남아 있지만 어떤 선택도 흡연 이력을 남기지 않는다', () => {
    const ev = getEvent('first_cigarette');
    expect(ev.choices!.some((c) => choiceUses(c))).toBe(false);
    for (let i = 0; i < ev.choices!.length; i++) {
      for (const seed of ['A', 'B', 'C', 'D']) {
        const s = personAt(`CIG-${seed}`, 13);
        expect(presentCard(s, { eventId: 'first_cigarette', ctx: {} })).toBe(true);
        choose(s, i);
        const t = readRecord(s.ch, 'tobacco');
        expect(t.ever).toBe(false);
        expect(t.uses).toBe(0);
        expect(t.offers).toBeGreaterThanOrEqual(1);
        expect(s.ch.flags.smoker).toBeUndefined();
        // 웃으며 거절·자리 뜨기는 늘 거절로 남는다
        if (i !== 1) expect(t.refusals).toBe(1);
      }
    }
  });

  it('검증기는 미성년자도 고를 수 있는 사용 선택지와 성인 표시 없는 커플 활동을 오류로 잡는다', () => {
    const list = EVENT_FILES['events/middle.json'];
    const fake = {
      id: 'test_minor_use',
      type: 'random',
      title: '시험',
      text: '시험',
      trigger: { age: [13, 18] },
      weight: { base: 0.01 },
      choices: [
        { text: '쓴다', result: '썼다', effects: { do: [{ type: 'substance', substance: 'tobacco', act: 'use' }] } },
        { text: '안 쓴다', result: '안 썼다' },
      ],
    } as EventDef;
    const fakeActivity = { id: 'test_couple', name: '시험', desc: '시험', group: 'social', points: 1, age: [19, 200], couple: true } as ActivityDef;
    list.push(fake);
    ACTIVITIES.push(fakeActivity);
    try {
      const errors = validateData().filter((e) => e.level === 'error');
      expect(errors.some((e) => e.where.includes('test_minor_use'))).toBe(true);
      expect(errors.some((e) => e.where.includes('test_couple'))).toBe(true);
    } finally {
      list.pop();
      ACTIVITIES.pop();
    }
    expect(validateData().filter((e) => e.level === 'error')).toEqual([]);
  });
});

describe('거절과 법적 결과', () => {
  it('회식 권유를 거절하면 거절이 기록되고 사용 이력은 생기지 않는다', () => {
    const s = personAt('REFUSE', 30);
    takeJob(s, 'sme_office');
    expect(presentCard(s, { eventId: 'sub_hoesik', ctx: {} })).toBe(true);
    choose(s, s.card!.choices.findIndex((c) => c.text.includes('거절')));
    const a = readRecord(s.ch, 'alcohol');
    expect(a.offers).toBe(1);
    expect(a.refusals).toBe(1);
    expect(a.lastRefusalAge).toBe(30);
    expect(a.ever).toBe(false);
    // 마시지 않았으니 다음 날 아침 카드도 없다
    proceed(s);
    expect(s.counts.sub_next_morning ?? 0).toBe(0);
  });

  it('불법 약물 적발은 기존 재판 흐름으로 판결하고 치료로 이어진다', () => {
    const s = personAt('DRUG-PATH', 30);
    expect(presentCard(s, { eventId: 'sub_drug_offer', ctx: {} })).toBe(true);
    choose(s, s.card!.choices.findIndex((c) => c.text.includes('한 번만')));
    expect(s.card!.result!.text.length).toBeGreaterThan(0);
    const d = readRecord(s.ch, 'drug');
    expect(d.ever).toBe(true);
    expect(d.offers).toBe(1);
    // 한 번 쓴 뒤에는 다시 쓰기·끊기·치료를 모두 고를 수 있다
    expect(activityViews(s).map((v) => v.def.id)).toEqual(expect.arrayContaining(['drug_use', 'quit_drug', 'addiction_treatment']));
    drain(s);
    expect(presentCard(s, { eventId: 'sub_drug_arrest', ctx: { crime: 'drug_use', 혐의: '마약류 관리법 위반' } })).toBe(true);
    const convictions = s.ch.legal.convictions;
    choose(s, 0);
    expect(s.card!.result!.text).toMatch(/마약류 관리법 위반/);
    expect(s.ch.legal.convictions).toBeGreaterThanOrEqual(convictions);
    expect(readRecord(s.ch, 'drug').treatment).toBe('active');
    expect(isQuitting(readRecord(s.ch, 'drug'))).toBe(true);
  });

  it('옛 사건이 붙인 사용 태그는 성인만 기록으로 옮기고 미성년자의 옛 태그는 그대로 둔다', () => {
    const s = personAt('LEGACY', 40);
    s.ch.flags.heavy_drinker = { since: 30 };
    reconcileSubstanceFlags(s);
    const a = readRecord(s.ch, 'alcohol');
    expect(a.ever).toBe(true);
    expect(a.habit).toBe(3);
    expect(a.firstAge).toBeUndefined();
    const m = personAt('LEGACY-MINOR', 16);
    m.ch.flags.smoker = { since: 15 };
    reconcileSubstanceFlags(m);
    expect(readRecord(m.ch, 'tobacco').ever).toBe(false);
    expect(m.ch.flags.smoker).toBeDefined();
  });
});

describe('재현', () => {
  it('같은 시드·같은 선택이면 술·담배 기록도 같다', () => {
    const run = () => {
      const s = personAt('SAME-SUB', 26);
      takeJob(s, 'sme_office');
      doActivity(s, 'drink_alone');
      doActivity(s, 'smoke');
      for (let i = 0; i < 6; i++) {
        doActivity(s, 'drinking');
        nextYear(s);
        s.ch.res.cash = 50_000_000;
      }
      return s;
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(b.ch.substances)).toBe(JSON.stringify(a.ch.substances));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const ids: SubstanceId[] = ['alcohol', 'tobacco'];
    for (const id of ids) expect(readRecord(a.ch, id).ever).toBe(true);
  });
});
