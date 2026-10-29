// 성인기의 술·담배·약물 (개정 계획 '성인기의 술 담배와 약물', 검토 R-008·R-009)
//
// - 성인이 돼도 고르지 않으면 사용 이력·숙취·후속 사건이 없다
// - 직접 고른 사용만 이력이 되고, 첫 사용은 한 번만 기록된다
// - 저장·불러오기를 사이에 두어도 같은 선택이 두 번 적용되지 않는다
// - 미성년자는 메뉴·사건 선택지·처리 단계 어디에서도 자기 사용을 할 수 없다
// - 거절은 기록되고, 끊기·재발·다시 도움 요청이 이어진다
// - 재검증(적대적 검토): 한두 번 써 보고 끊은 사람에게 고르지 않은 재발이 없다, 치료 중에 다시 쓴 뒤에도
//   도움을 다시 청할 수 있고 '치료 중'에 갇히지 않는다, 빈 병 앞의 줄이기 약속이 상태로 남는다,
//   다른 사건이 바꾼 흡연자·술꾼 태그를 그 자리에서 같은 뜻으로 읽는다, 금연·금주 유지 태그가 늦지 않는다,
//   약물 판결이 records.ts의 전과 정의와 같다, 약물 문구에 실제 이름·구하는 법이 없다

import { describe, expect, it } from 'vitest';
import { activityViews } from '../src/engine/activities';
import { jobOpenings, takeJob } from '../src/engine/career';
import { ACTIVITIES, EVENT_FILES, EVENTS, getEvent, TAGS } from '../src/engine/data';
import { applyEffects } from '../src/engine/effects';
import { presentCard, triggerOk } from '../src/engine/eventEngine';
import { applyForJob, choose, doActivity, endTurn, newGame, proceed } from '../src/engine/game';
import { CONVICTION_KINDS, convictionCount, hasCriminalRecord, sentenceRecords, type SentenceKind } from '../src/engine/records';
import { startPartner } from '../src/engine/relations';
import { rngFor } from '../src/engine/rng';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import type { ActivityDef, ChoiceDef, Effects, EventDef } from '../src/engine/schema';
import { buildScope } from '../src/engine/scope';
import { isQuitting, isRecovered, readRecord, reconcileSubstanceFlags, substanceHealthDelta, substanceYearEnd } from '../src/engine/substances';
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

// ── 재검증: 적대적 검토에서 찾은 문제 ───────────────────────

const fx = (seed: string) => ({ ctx: {} as Record<string, string>, rng: rngFor(seed, 'test-fx'), changes: [] });
const tobaccoScope = (s: GameState) => (buildScope(s).substance as Record<string, Record<string, unknown>>).tobacco;
const alcoholScope = (s: GameState) => (buildScope(s).substance as Record<string, Record<string, unknown>>).alcohol;

/** 3년 동안 해마다 담배를 두 번씩 골라 의존이 깊어진 사람 */
function heavySmoker(seed: string, age: number): GameState {
  const s = personAt(seed, age);
  for (let y = 0; y < 3; y++) {
    doActivity(s, 'smoke');
    doActivity(s, 'smoke');
    nextYear(s);
    s.ch.res.cash = 50_000_000;
  }
  return s;
}

/** 금연클리닉에 다니다가 갈망 카드에서 '딱 한 대만'을 고른 사람: 치료는 진행 중인데 다시 피우고 있다 */
function slipDuringTreatment(seed: string): GameState {
  const s = heavySmoker(seed, 30);
  expect(doActivity(s, 'smoking_clinic')).not.toBeNull();
  expect(presentCard(s, { eventId: 'sub_quit_craving', ctx: {} })).toBe(true);
  choose(s, s.card!.choices.findIndex((c) => c.text.includes('한 대만')));
  proceed(s);
  drain(s);
  const t = readRecord(s.ch, 'tobacco');
  expect(t.treatment).toBe('active');
  expect(isQuitting(t)).toBe(false);
  return s;
}

describe('끊은 뒤의 재발은 의존이 남아 있을 때만', () => {
  it('한 번 써 보고 끊은 사람은 그 뒤로 고르지 않으면 다시 쓰지 않는다', () => {
    // 예전에는 의존 1 남짓인데도 해마다 재발을 굴려 200명 중 155명(술)·148명(담배)이 고르지 않은 사용과 재발 카드를 겪었다
    for (const [id, use, quit] of [
      ['alcohol', 'drinking', 'quit_drinking'],
      ['tobacco', 'smoke', 'quit_smoking'],
    ] as const) {
      for (let i = 0; i < 12; i++) {
        const s = personAt(`TRIED-ONCE-${id}-${i}`, 25);
        expect(doActivity(s, use)).not.toBeNull();
        expect(doActivity(s, quit)).not.toBeNull();
        const uses = readRecord(s.ch, id).uses;
        for (let y = 0; y < 30 && s.phase !== 'dead'; y++) {
          nextYear(s);
          expect(readRecord(s.ch, id).habit, `${id} ${i} ${s.ch.age}세`).toBe(0);
        }
        const r = readRecord(s.ch, id);
        expect(r.uses, `${id} ${i}`).toBe(uses);
        expect(r.relapses, `${id} ${i}`).toBe(0);
        expect(s.counts.sub_relapse ?? 0, `${id} ${i}`).toBe(0);
      }
    }
  });

  it('의존이 깊었던 사람은 끊은 뒤에도 고르지 않은 재발을 겪을 수 있다', () => {
    let relapsed = 0;
    for (let i = 0; i < 12; i++) {
      const s = heavySmoker(`DEP-QUIT-${i}`, 25);
      expect(doActivity(s, 'quit_smoking')).not.toBeNull();
      for (let y = 0; y < 6 && s.phase !== 'dead'; y++) nextYear(s);
      if ((s.counts.sub_relapse ?? 0) > 0) {
        relapsed++;
        expect(readRecord(s.ch, 'tobacco').relapses).toBeGreaterThan(0);
      }
    }
    expect(relapsed).toBeGreaterThan(0);
  });
});

describe('치료 중에 다시 쓴 뒤', () => {
  it('다시 도움을 청하면 끊기와 치료를 처음부터 다시 시작한다 (재발 카드·메뉴)', () => {
    const s = slipDuringTreatment('TREAT-SLIP');
    // 다시 피우는 중이면 메뉴에서도 금연클리닉에 다시 갈 수 있다 (예전에는 '치료 중'이라 숨었다)
    expect(activityViews(s).map((v) => v.def.id)).toContain('smoking_clinic');
    expect(presentCard(s, { eventId: 'sub_relapse', ctx: { substance: 'tobacco', 물질: '담배' } })).toBe(true);
    choose(s, s.card!.choices.findIndex((c) => c.text.includes('도움')));
    // 예전에는 이미 치료 중이라 아무 일도 없었고 계속 피우는 상태로 남았다
    const t = readRecord(s.ch, 'tobacco');
    expect(t.treatment).toBe('active');
    expect(isQuitting(t)).toBe(true);
    expect(t.treatmentStarts).toBe(2);
    expect(t.treatmentSince).toBe(s.ch.age);
    expect(s.card!.result!.changes.map((c) => c.text)).toContain('금연클리닉 다시 시작');
    expect(s.ch.flags.quitting_smoking).toBeDefined();
    expect(s.ch.flags.smoker).toBeUndefined();
    // 끊는 중에 치료도 받고 있으면 메뉴에 다시 뜨지 않는다
    expect(activityViews(s).map((v) => v.def.id)).not.toContain('smoking_clinic');

    const menu = slipDuringTreatment('TREAT-SLIP-MENU');
    expect(doActivity(menu, 'smoking_clinic')).not.toBeNull();
    expect(isQuitting(readRecord(menu.ch, 'tobacco'))).toBe(true);
    expect(readRecord(menu.ch, 'tobacco').treatmentStarts).toBe(2);
  });

  it('다시 끊지 않은 채 해가 끝나면 치료가 흐지부지되고 메뉴가 다시 열린다', () => {
    const s = slipDuringTreatment('TREAT-LAPSE');
    substanceYearEnd(s);
    const t = readRecord(s.ch, 'tobacco');
    expect(t.treatment).toBe('none');
    expect(s.log.some((l) => l.title === '금연클리닉' && l.text.includes('발길을 끊었다'))).toBe(true);
    expect(activityViews(s).map((v) => v.def.id)).toContain('smoking_clinic');
  });

  it('치료를 마치면 쓰는 채로 마침이 남지 않고, 재발 카드에서 그냥 두면 치료도 그만둔다', () => {
    const done = slipDuringTreatment('TREAT-COMPLETE');
    applyEffects(done, { do: [{ type: 'substance', act: 'completeTreatment' }] }, fx('TREAT-COMPLETE'));
    let t = readRecord(done.ch, 'tobacco');
    expect(t.treatment).toBe('completed');
    expect(isQuitting(t)).toBe(true);

    const left = slipDuringTreatment('TREAT-LEAVE');
    expect(presentCard(left, { eventId: 'sub_relapse', ctx: { substance: 'tobacco', 물질: '담배' } })).toBe(true);
    choose(left, left.card!.choices.findIndex((c) => c.text.includes('그냥 둔다')));
    t = readRecord(left.ch, 'tobacco');
    expect(t.treatment).toBe('none');
    expect(isQuitting(t)).toBe(false);
    expect(left.card!.result!.changes.map((c) => c.text)).toContain('금연클리닉을 그만뒀다');
  });
});

describe('줄이기 약속', () => {
  it('빈 병 앞의 줄이겠다는 약속은 올해 고른 술뿐이어도 남고, 지키면 다음 해 습관이 생기지 않는다', () => {
    // 예전에는 습관이 0이면 cutDown이 아무것도 하지 않아 약속이 상태에 남지 않았다
    let compared = 0;
    for (let i = 0; i < 24 && compared < 2; i++) {
      const seed = `EMPTY-BOTTLES-${i}`;
      const run = (choice: string) => {
        const s = personAt(seed, 30);
        s.ch.personality.conscientiousness = 90;
        for (const id of ['drinking', 'drinking', 'drink_alone']) doActivity(s, id);
        nextYear(s);
        s.ch.res.cash = 50_000_000;
        startPartner(s, rngFor(seed, 'partner'));
        for (const id of ['drinking', 'drinking', 'drink_alone']) doActivity(s, id);
        if (readRecord(s.ch, 'alcohol').habit !== 0) return undefined;
        expect(presentCard(s, { eventId: 'sub_family_worry', ctx: {} })).toBe(true);
        choose(s, s.card!.choices.findIndex((c) => c.text.includes(choice)));
        const promised = readRecord(s.ch, 'alcohol').cutDownAge === s.ch.age;
        substanceYearEnd(s);
        return { promised, habit: readRecord(s.ch, 'alcohol').habit };
      };
      const kept = run('줄이겠다');
      const refused = run('내 돈으로');
      if (!kept || !refused) continue;
      expect(refused.promised).toBe(false);
      if (kept.promised && refused.habit > 0) {
        expect(kept.habit, seed).toBe(0);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });
});

describe('태그와 기록이 같은 뜻으로 읽힌다', () => {
  it('다른 사건이 흡연자 태그를 떼면 그 자리에서 끊은 사람으로 읽히고 건강 계산도 같다', () => {
    const s = personAt('TAG-REMOVED', 40);
    s.ch.flags.smoker = { since: 20 };
    reconcileSubstanceFlags(s);
    expect(substanceHealthDelta(s.ch)).toBeCloseTo(-1.2, 6);
    expect(triggerOk(getEvent('sub_smoking_area'), buildScope(s), s)).toBe(true);
    // 심장 재활 같은 사건의 선택지가 태그만 뗐다. 기록에는 다음 물질 행동이나 연말에 옮긴다
    applyEffects(s, { removeFlags: ['smoker'] }, fx('TAG-REMOVED'));
    expect(isQuitting(readRecord(s.ch, 'tobacco'))).toBe(false);
    expect(tobaccoScope(s).quitting).toBe(true);
    expect(tobaccoScope(s).current).toBe(false);
    expect(triggerOk(getEvent('sub_smoking_area'), buildScope(s), s)).toBe(false);
    expect(activityViews(s).map((v) => v.def.id)).not.toContain('quit_smoking');
    // 예전에는 그해 연말 건강 계산까지 매일 흡연(−1.2)으로 쳤다
    expect(substanceHealthDelta(s.ch)).toBe(0);
    reconcileSubstanceFlags(s);
    const t = readRecord(s.ch, 'tobacco');
    expect(isQuitting(t)).toBe(true);
    expect(t.quitAttempts).toBe(1);
    expect(s.ch.flags.quitting_smoking).toBeDefined();
    expect(tobaccoScope(s).quitting).toBe(true);
  });

  it('성인에게 붙은 술꾼·금주 중 태그는 그 자리에서 읽히고, 미성년자의 옛 흡연 태그는 사용으로 읽지 않는다', () => {
    const v = personAt('TAG-ADDED', 45);
    // 전쟁 트라우마의 '술로 버틴다'처럼 태그를 붙이는 선택
    applyEffects(v, { addFlags: ['heavy_drinker'] }, fx('TAG-ADDED'));
    expect(alcoholScope(v).ever).toBe(true);
    expect(alcoholScope(v).band).toBe(3);
    expect(substanceHealthDelta(v.ch)).toBeCloseTo(-0.8, 6);
    reconcileSubstanceFlags(v);
    expect(readRecord(v.ch, 'alcohol').habit).toBe(3);
    expect(alcoholScope(v).band).toBe(3);
    // 숙취 다음 날의 금주 다짐
    applyEffects(v, { addFlags: ['quitting_drinking'] }, fx('TAG-ADDED-2'));
    expect(alcoholScope(v).quitting).toBe(true);
    expect(substanceHealthDelta(v.ch)).toBe(0);

    const m = personAt('TAG-MINOR', 16);
    m.ch.flags.smoker = { since: 15 };
    expect(tobaccoScope(m).ever).toBe(false);
    expect(tobaccoScope(m).current).toBe(false);
  });

  it('끊은 지 2년이 되는 해의 첫날에 금연 유지 태그가 이미 붙어 있다', () => {
    // 예전에는 연말에 지금 나이로 끊은 햇수를 세서 '금연 유지'·'금주 유지'가 한 해 늦게 붙었다
    let recoveredSeen = 0;
    for (let i = 0; i < 6; i++) {
      const s = personAt(`EX-SMOKER-${i}`, 30);
      doActivity(s, 'smoke');
      doActivity(s, 'smoke');
      expect(doActivity(s, 'quit_smoking')).not.toBeNull();
      for (let y = 0; y < 4 && s.phase !== 'dead'; y++) {
        nextYear(s);
        const rec = isRecovered(readRecord(s.ch, 'tobacco'), s.ch.age);
        expect(tobaccoScope(s).recovered, `${i} ${s.ch.age}세`).toBe(rec);
        expect(Boolean(s.ch.flags.ex_smoker), `${i} ${s.ch.age}세`).toBe(rec);
        expect(Boolean(s.ch.flags.quitting_smoking), `${i} ${s.ch.age}세`).toBe(!rec);
        if (rec) recoveredSeen++;
      }
    }
    expect(recoveredSeen).toBeGreaterThan(0);
  });
});

describe('돈과 법', () => {
  it('습관의 연간 비용은 연말에 한 번, 물가를 곱해 낸다', () => {
    const s = personAt('HABIT-COST', 40);
    s.ch.flags.smoker = { since: 20 };
    reconcileSubstanceFlags(s);
    s.world.economy.priceIndex = 2;
    const cash = s.ch.res.cash;
    substanceYearEnd(s);
    // 매일 반 갑 = 연 82만 원 (2026년 원) × 물가 2
    expect(cash - s.ch.res.cash).toBe(1_640_000);
    expect(s.log.some((l) => l.kind === 'year' && l.text.includes('담배값'))).toBe(true);
  });

  it('약물 적발 판결은 records.ts의 전과 정의와 같고, 인정하면 치료로 이어진다', () => {
    const kinds = new Set<SentenceKind>();
    for (let i = 0; i < 20; i++) {
      for (const deny of [false, true]) {
        const s = personAt(`DRUG-LAW-${i}`, 30);
        expect(presentCard(s, { eventId: 'sub_drug_offer', ctx: {} })).toBe(true);
        choose(s, s.card!.choices.findIndex((c) => c.text.includes('한 번만')));
        drain(s);
        const before = sentenceRecords(s.ch).length;
        const convBefore = convictionCount(s.ch);
        // 첫 사용에서 이미 적발돼 실형을 받았으면 교정시설 안이라 이 카드는 뜨지 않는다
        if (!presentCard(s, { eventId: 'sub_drug_arrest', ctx: { crime: 'drug_use', 혐의: '마약류 관리법 위반' } })) continue;
        choose(s, s.card!.choices.findIndex((c) => c.text.includes(deny ? '부인' : '인정')));
        const added = sentenceRecords(s.ch).slice(before);
        expect(added.length).toBeLessThanOrEqual(1);
        for (const r of added) {
          expect(r.crime).toBe('drug_use');
          kinds.add(r.kind);
        }
        const conv = added.some((r) => CONVICTION_KINDS.includes(r.kind));
        expect(convictionCount(s.ch)).toBe(convBefore + (conv ? 1 : 0));
        expect(s.ch.legal.convictions).toBe(convictionCount(s.ch));
        expect(hasCriminalRecord(s.ch)).toBe(convictionCount(s.ch) > 0);
        expect(Boolean(s.ch.flags.criminal_record)).toBe(convictionCount(s.ch) > 0);
        if (!deny) expect(readRecord(s.ch, 'drug').treatment).toBe('active');
        if (deny && added.length === 0) expect(s.card!.result!.text).toContain('무혐의');
      }
    }
    // 기소유예(전과 아님)와 유죄 판결이 모두 나온다
    expect(kinds.has('suspended_prosecution')).toBe(true);
    expect([...kinds].some((k) => CONVICTION_KINDS.includes(k))).toBe(true);
  });
});

describe('데이터 경계', () => {
  it('어떤 사건도 선택 없이 사용을 일으키지 않고, 판정 실패로 쓰게 되는 선택지는 끊는 중의 갈망 사건에만 있다', () => {
    for (const ev of EVENTS) {
      expect(causesUse(ev.effects), ev.id).toBe(false);
      (ev.choices ?? []).forEach((c, i) => {
        if (causesUse(c.effects) || !(causesUse(c.onSuccess?.effects) || causesUse(c.onFail?.effects))) return;
        // 참으려다 실패해 쓰게 되는 것은 의존이 남은 사람의 갈망 장면뿐이다
        expect(ev.trigger?.if ?? '', `${ev.id} › ${i + 1}`).toMatch(/quitting/);
        expect(ev.trigger?.if ?? '', `${ev.id} › ${i + 1}`).toMatch(/craving >= \d+/);
      });
    }
  });

  it('술·담배·약물 사건·활동·태그에 실제 약물 이름이나 구하는 법·양이 없다', () => {
    const FORBIDDEN = /필로폰|메스암페타민|히로뽕|대마|마리화나|코카인|헤로인|엑스터시|MDMA|케타민|LSD|펜타닐|프로포폴|졸피뎀|아편|텔레그램|던지기|좌표|[0-9]\s*(그램|mg|g\b)|용량|주사|흡입|투약 방법/;
    const own = new Set(['smoker', 'vaper', 'quitting_smoking', 'ex_smoker', 'heavy_drinker', 'quitting_drinking', 'sober', 'drug_use', 'drug_recovery']);
    const texts = [
      ...EVENT_FILES['events/substances.json'].map((e) => [e.id, JSON.stringify(e)]),
      ...ACTIVITIES.filter((a) => a.special === 'substance').map((a) => [a.id, JSON.stringify(a)]),
      ...TAGS.filter((t) => own.has(t.id)).map((t) => [t.id, JSON.stringify(t)]),
    ];
    expect(texts.length).toBeGreaterThan(30);
    for (const [id, text] of texts) expect(text, id).not.toMatch(FORBIDDEN);
  });
});

describe('저장과 재개 (재발)', () => {
  /** 의존이 깊은 흡연자가 끊은 뒤 연말 재발로 재발 카드가 뜰 때까지 산다 (카드는 고르지 않고 멈춘다) */
  function untilRelapseCard(seed: string): GameState | undefined {
    const s = heavySmoker(seed, 25);
    if (!doActivity(s, 'quit_smoking')) return undefined;
    for (let guard = 0; guard < 3000 && s.phase !== 'dead'; guard++) {
      if (s.card?.eventId === 'sub_relapse' && !s.card.result) return s;
      if (s.phase === 'action') {
        if (s.ch.age > 40) return undefined;
        endTurn(s);
      } else if (s.card && s.card.choices.length > 0 && !s.card.result) chooseWithoutUse(s);
      else proceed(s);
    }
    return undefined;
  }

  it('재발 카드가 떠 있을 때 저장했다 불러와도 재발은 한 번만 적용되고, 같은 선택은 같은 결과다', () => {
    const storage = memoryStorage();
    let tested = 0;
    for (let i = 0; i < 16 && tested === 0; i++) {
      const s = untilRelapseCard(`DEP-QUIT-${i}`);
      if (!s) continue;
      tested++;
      const relapses = readRecord(s.ch, 'tobacco').relapses;
      expect(relapses).toBeGreaterThan(0);
      expect(isQuitting(readRecord(s.ch, 'tobacco'))).toBe(false);
      expect(saveGame(s, storage)).toBe(true);
      const loaded = loadGame(storage)!;
      expect(loaded).toEqual(s);
      choose(s, 0);
      choose(loaded, 0);
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(s));
      expect(readRecord(s.ch, 'tobacco').relapses).toBe(relapses);
      expect(isQuitting(readRecord(s.ch, 'tobacco'))).toBe(true);
      // 결과가 붙은 카드는 다시 골라도 아무 일도 없다
      choose(loaded, 1);
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(s));
      // 같은 시드를 다시 살면 같은 자리에서 같은 재발 카드가 뜬다
      const again = untilRelapseCard(`DEP-QUIT-${i}`)!;
      choose(again, 0);
      expect(JSON.stringify(again)).toBe(JSON.stringify(s));
    }
    expect(tested).toBe(1);
  });
});
