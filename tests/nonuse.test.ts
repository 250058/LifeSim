// 마시지 않을 자유 (검토 R-014, R-008의 영양 부분, 개정 계획 '반복 가능한 관리와 지출의 인과')
//
// - 술·담배·약물을 쓰는 선택지가 있는 카드에는 같은 사람이 고를 수 있는 비사용 선택지가 늘 있다 (전체 사건 검사)
// - 카드가 뜨는 것만으로는 아무도 쓰지 않는다. 사용 선택지는 만 19세부터: 18세는 막히고 19세에 열린다
// - 마시지 않고 넘어가면 저장·불러오기 뒤에도 음주 기록·숙취·해장 카드가 없다
// - 마시기를 고르면 substances.ts에 고른 만큼 한 번만 남는다
// - 해장·숙취 카드와 마셨다고 전제하는 문장은 그해 실제로 마셨을 때만 열린다

import { describe, expect, it } from 'vitest';
import nutrition from '../data/catalog/nutrition.json';
import { takeJob } from '../src/engine/career';
import { EVENTS, EVENT_FILES, getEvent } from '../src/engine/data';
import { presentCard, triggerOk } from '../src/engine/eventEngine';
import { choose, doActivity, endTurn, newGame, proceed } from '../src/engine/game';
import { haveChild, startPartner } from '../src/engine/relations';
import { rngFor } from '../src/engine/rng';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import type { ChoiceDef, Effects, EventDef } from '../src/engine/schema';
import { buildScope } from '../src/engine/scope';
import { isQuitting, readRecord } from '../src/engine/substances';
import type { GameState } from '../src/engine/types';

/** 본인의 사용을 뜻하는 태그 (validate.ts와 같다) */
const USE_TAGS = ['smoker', 'vaper', 'heavy_drinker', 'drug_use'];

/** 효과가 일으키는 사용량: 사용 행동의 양을 더한다 (사용 태그는 1로 센다) */
function usesIn(fx: Effects | undefined): number {
  if (!fx) return 0;
  let n = (fx.addFlags ?? []).filter((f) => USE_TAGS.includes(f)).length;
  for (const a of fx.do ?? []) if (a.type === 'substance' && a.act === 'use') n += a.amount ?? 1;
  return n;
}

function choiceUses(c: ChoiceDef): boolean {
  return usesIn(c.effects) + usesIn(c.onSuccess?.effects) + usesIn(c.onFail?.effects) > 0;
}

/** 판정이 있으면 성공·실패 어느 쪽이든 쓰는 양 (둘이 같게 썼다) */
function useAmount(c: ChoiceDef): number {
  return usesIn(c.effects) + Math.max(usesIn(c.onSuccess?.effects), usesIn(c.onFail?.effects));
}

const FILE_OF = new Map<string, string>();
for (const [file, list] of Object.entries(EVENT_FILES)) for (const ev of list) FILE_OF.set(ev.id, file);

/** 사용 선택지가 하나라도 있는 카드 */
const USE_CARDS = EVENTS.filter((ev) => (ev.choices ?? []).some(choiceUses));
/** 술 음식 × 상황 카드 (밥상 풀) */
const ALCOHOL_FOOD_CARDS = USE_CARDS.filter((ev) => ev.id.startsWith('nut_food_'));
/** 그해 마셨을 때만 열리는 해장·숙취 카드 */
const HANGOVER_CARDS = EVENTS.filter((ev) =>
  /^nut_food_.+_haejang$|^nut_food_hangover_drink_|^phys_hangover_|^phys_first_hangover$|^sub_next_morning$/.test(ev.id),
);

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** 나이를 바로 정한 시험용 인물 (사용 이력 없음) */
function personAt(seed: string, age: number): GameState {
  const s = newGame({ seed, mode: 'reality', birthYear: 2026 });
  s.ch.age = age;
  s.year = 2026 + age;
  s.world.year = s.year;
  s.ch.res.cash = 50_000_000;
  s.points = { max: 6, left: 6 };
  return s;
}

/** 카드의 상황 조건(직장·연인·대학·자녀)을 갖춘 인물 */
function personFor(ev: EventDef, age: number, seed: string): GameState {
  const s = personAt(seed, age);
  const cond = ev.trigger?.if ?? '';
  // 직장 조건: takeJob은 임용 자격(중소기업 사무직은 고졸 이상)을 보므로 학력을 갖춘다 (R-018)
  if (cond.includes('job.employed')) s.ch.edu.degree = 'high';
  if (cond.includes('job.employed')) takeJob(s, 'sme_office');
  if (cond.includes('family.partnerAdult')) startPartner(s, rngFor(seed, 'partner'));
  if (cond.includes("edu.status == 'university'")) s.ch.edu.status = 'university';
  if (cond.includes('family.children > 0')) haveChild(s, rngFor(seed, 'child'));
  return s;
}

/** 시험할 나이: 카드의 나이 조건 안에서 되도록 30세 (만 19세 아래로는 내려가지 않는다) */
function ageFor(ev: EventDef): number {
  const [lo, hi] = ev.trigger?.age ?? [19, 100];
  return Math.min(hi, Math.max(lo, 19, 30));
}

/** 화면에 뜬 카드에서 사용을 일으키지 않는 첫 선택지 (없으면 -1) */
function nonUseIndex(state: GameState): number {
  const ev = getEvent(state.card!.eventId);
  return state.card!.choices.findIndex((c) => !choiceUses(ev.choices![c.index]));
}

/** 대기 중인 카드를 모두 넘긴다 (사용하지 않는 선택지로) */
function drain(state: GameState): void {
  for (let guard = 0; guard < 200 && state.phase === 'event'; guard++) {
    if (state.card && state.card.choices.length > 0 && !state.card.result) choose(state, Math.max(0, nonUseIndex(state)));
    else proceed(state);
  }
}

/** 한 해를 넘긴다 (사용하지 않는 선택지로) */
function nextYear(state: GameState): void {
  drain(state);
  const age = state.ch.age;
  for (let guard = 0; guard < 200 && state.phase !== 'dead' && (state.phase !== 'action' || state.ch.age === age); guard++) {
    if (state.phase === 'action') endTurn(state);
    else drain(state);
  }
}

/** 지금 열리는 해장·숙취 카드 */
function hangoverOpen(state: GameState): string[] {
  const scope = buildScope(state);
  return HANGOVER_CARDS.filter((ev) => triggerOk(ev, scope, state)).map((ev) => ev.id);
}

function usedThisYear(state: GameState): boolean {
  return (buildScope(state).substance as { alcohol: { usedThisYear: boolean } }).alcohol.usedThisYear;
}

describe('비사용 선택은 늘 있다 (R-014)', () => {
  it('전체 사건: 사용 선택지가 있는 카드에는 같은 사람이 고를 수 있는 비사용 선택지가 있다', () => {
    const offenders: string[] = [];
    for (const ev of USE_CARDS) {
      const choices = ev.choices!;
      const free = choices.filter((c) => !choiceUses(c));
      for (const u of choices.filter(choiceUses)) {
        // 조건이 없거나 사용 선택지와 같은 조건이면 그 선택지를 볼 수 있는 사람은 비사용 선택지도 본다
        if (!free.some((n) => !n.if || n.if === u.if)) offenders.push(`${FILE_OF.get(ev.id)} ${ev.id} › ${u.text}`);
      }
    }
    expect(offenders).toEqual([]);
    // 검사가 비어 있지 않다: 밥상 풀의 술 카드, 손으로 쓴 술 장면, 술·담배·약물 사건, 참전 후유증
    expect(ALCOHOL_FOOD_CARDS.length).toBeGreaterThanOrEqual(31);
    expect(USE_CARDS.length).toBeGreaterThanOrEqual(41);
    for (const file of ['catalog/nutrition.json', 'events/substances.json', 'arcs/war.json']) {
      expect(USE_CARDS.some((ev) => FILE_OF.get(ev.id) === file), file).toBe(true);
    }
  });

  it('카드가 뜨는 것만으로 쓰게 하는 사건은 없고, 사용 선택지는 만 19세부터만 열린다', () => {
    expect(EVENTS.filter((ev) => usesIn(ev.effects) > 0).map((ev) => ev.id)).toEqual([]);
    for (const ev of USE_CARDS) {
      const adultCard = Boolean(ev.adult) || (ev.trigger?.age?.[0] ?? 0) >= 19;
      if (adultCard) continue;
      for (const u of ev.choices!.filter(choiceUses)) expect(u.if ?? '', `${ev.id} › ${u.text}`).toContain('substance.adult');
    }
    for (const ev of ALCOHOL_FOOD_CARDS) {
      expect(ev.adult, ev.id).toBe(true);
      expect(ev.trigger!.age![0], ev.id).toBeGreaterThanOrEqual(19);
    }
  });

  it('밥상 풀의 모든 술 카드: 18세에는 막히고, 19세(또는 카드 나이)에는 마시기·안 마시기가 함께 열리며 안 마시고 넘어갈 수 있다', () => {
    for (const ev of ALCOHOL_FOOD_CARDS) {
      const minor = personFor(ev, 18, `MINOR-${ev.id}`);
      expect(triggerOk(ev, buildScope(minor), minor), `18세 ${ev.id}`).toBe(false);
      expect(presentCard(minor, { eventId: ev.id, ctx: {} }), `18세 ${ev.id}`).toBe(false);

      const age = Math.max(19, ev.trigger!.age![0]);
      const s = personFor(ev, age, `OPEN-${ev.id}`);
      expect(presentCard(s, { eventId: ev.id, ctx: {} }), `${age}세 ${ev.id}`).toBe(true);
      const shown = s.card!.choices.map((c) => ev.choices![c.index]);
      expect(shown.some(choiceUses), ev.id).toBe(true);
      expect(shown.some((c) => !choiceUses(c)), ev.id).toBe(true);
      // 고르기 전에는 넘어가지 않고, 안 마시는 선택으로는 넘어간다
      proceed(s);
      expect(s.card?.eventId).toBe(ev.id);
      choose(s, nonUseIndex(s));
      proceed(s);
      expect(s.card?.eventId, ev.id).not.toBe(ev.id);
      const a = readRecord(s.ch, 'alcohol');
      expect([a.ever, a.uses, a.usesThisYear], ev.id).toEqual([false, 0, 0]);
    }
  });

  it('미성년자도 보는 장면의 사용 선택지(폭염의 맥주)는 18세에는 숨고 19세에 보인다', () => {
    const beer = (s: GameState) => s.card!.choices.some((c) => c.text.includes('맥주'));
    const teen = personAt('HEAT-18', 18);
    expect(presentCard(teen, { eventId: 'nut_water_heatwave', ctx: {} })).toBe(true);
    expect(beer(teen)).toBe(false);
    const adult = personAt('HEAT-19', 19);
    expect(presentCard(adult, { eventId: 'nut_water_heatwave', ctx: {} })).toBe(true);
    expect(beer(adult)).toBe(true);
    // 고르지 않으면 쓰지 않는다
    choose(adult, nonUseIndex(adult));
    expect(readRecord(adult.ch, 'alcohol').ever).toBe(false);
  });

  it('표에 안 마시는 선택지가 없던 술은 맨 끝에 붙어, 앞 선택지의 순서는 그대로다', () => {
    const foods = (nutrition as unknown as { foods: { id: string; alcohol?: boolean; choices: { text: string; use?: number }[] }[] }).foods;
    const alcohol = foods.filter((f) => f.alcohol);
    expect(alcohol.map((f) => f.id).sort()).toEqual(['beer', 'can_beer', 'cheongju', 'highball', 'makgeolli', 'soju', 'somaek', 'wine']);
    for (const f of alcohol) {
      for (const ev of ALCOHOL_FOOD_CARDS.filter((e) => e.group === `nut_food_${f.id}`)) {
        expect(ev.choices!.slice(0, f.choices.length).map((c) => c.text), ev.id).toEqual(f.choices.map((r) => r.text));
      }
    }
    // R-014가 짚은 카드: 막걸리·와인·하이볼은 세 번째에 안 마시는 선택지가 생겼다. 회식 소맥은 출구 뒤 네 번째
    expect(getEvent('nut_food_makgeolli_hiking').choices![2].text).toBe('잔은 사양하고 시원한 물을 마신다');
    expect(getEvent('nut_food_wine_buffet').choices![2].text).toBe('와인 대신 탄산수 잔을 든다');
    expect(getEvent('nut_food_somaek_hoesik').choices!.map((c) => c.text)).toEqual([
      '회오리를 돌려 원샷한다',
      '맥주만 따라 달라고 한다',
      '2차는 빠지고 막차를 탄다',
      '술 대신 사이다를 따라 달라고 한다',
    ]);
  });
});

describe('안 마시고 넘어간 뒤 (저장·재개)', () => {
  /** R-014가 짚은 8장 + 같은 문제가 있던 소맥(MT)·소주(실패하면 마시던 거절) 카드 */
  const CARDS = [
    'nut_food_makgeolli_travel',
    'nut_food_makgeolli_rainy',
    'nut_food_makgeolli_senior',
    'nut_food_makgeolli_hiking',
    'nut_food_makgeolli_festival',
    'nut_food_wine_date',
    'nut_food_wine_buffet',
    'nut_food_highball_date',
    'nut_food_somaek_mt',
    'nut_food_soju_camping',
    'nut_food_soju_travel',
    'nut_food_soju_rainy',
    'nut_food_soju_park',
    'nut_food_soju_funeral',
    'nut_food_soju_mt',
  ];

  it('비사용 경로 → 저장·불러오기 → 음주 기록·숙취·해장 카드가 없고, 이듬해에도 없다', () => {
    for (const id of CARDS) {
      const ev = getEvent(id);
      const s = personFor(ev, ageFor(ev), `NONUSE-${id}`);
      expect(presentCard(s, { eventId: id, ctx: {} }), id).toBe(true);
      const i = nonUseIndex(s);
      expect(i, id).toBeGreaterThanOrEqual(0);
      choose(s, i);
      // 판정이 있는 거절(소주)도 성공·실패 모두 마시지 않는다
      expect(s.card!.result!.text, id).not.toMatch(/다섯 잔/);
      proceed(s);

      const storage = memoryStorage();
      expect(saveGame(s, storage)).toBe(true);
      const loaded = loadGame(storage)!;
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(s));
      for (const st of [s, loaded]) {
        const a = readRecord(st.ch, 'alcohol');
        expect([a.ever, a.uses, a.usesThisYear, a.firstAge], id).toEqual([false, 0, 0, undefined]);
        // 거절은 거절로 남는다 (권유를 받은 것은 노출(offers)이지 사용이 아니다)
        expect(a.refusals, id).toBe(1);
        expect(usedThisYear(st), id).toBe(false);
        expect(hangoverOpen(st), id).toEqual([]);
        expect(st.ch.flags.heavy_drinker, id).toBeUndefined();
      }
      nextYear(loaded);
      expect(readRecord(loaded.ch, 'alcohol').ever, id).toBe(false);
      for (const ev2 of HANGOVER_CARDS) expect(loaded.counts[ev2.id] ?? 0, `${id} → ${ev2.id}`).toBe(0);
    }
  });

  it('기록이 없는 옛 저장에서 술 카드를 안 마시고 넘겨도 사용 이력은 생기지 않는다', () => {
    const storage = memoryStorage();
    const old = personFor(getEvent('nut_food_wine_buffet'), 40, 'OLD-SAVE-WINE');
    expect(old.ch.substances).toBeUndefined();
    expect(presentCard(old, { eventId: 'nut_food_wine_buffet', ctx: {} })).toBe(true);
    saveGame(old, storage);
    const loaded = loadGame(storage)!;
    expect(loaded.ch.substances).toBeUndefined();
    choose(loaded, nonUseIndex(loaded));
    proceed(loaded);
    const a = readRecord(loaded.ch, 'alcohol');
    expect([a.ever, a.uses]).toEqual([false, 0]);
    expect(hangoverOpen(loaded)).toEqual([]);
  });
});

describe('마시기를 고르면 (실제 사용 기록)', () => {
  it('밥상 풀의 모든 술 카드: 마시는 선택지마다 고른 양만큼 한 번 기록되고, 술자리 한 번(0.5)부터 그해 숙취 조건이 된다', () => {
    let checked = 0;
    for (const ev of ALCOHOL_FOOD_CARDS) {
      ev.choices!.forEach((c, index) => {
        if (!choiceUses(c)) return;
        const s = personFor(ev, ageFor(ev), `USE-${ev.id}-${index}`);
        expect(presentCard(s, { eventId: ev.id, ctx: {} }), ev.id).toBe(true);
        const shown = s.card!.choices.findIndex((x) => x.index === index);
        if (shown < 0) return;
        choose(s, shown);
        const a = readRecord(s.ch, 'alcohol');
        const amount = useAmount(c);
        expect([a.ever, a.uses, a.usesThisYear, a.firstAge], `${ev.id} › ${c.text}`).toEqual([true, 1, amount, s.ch.age]);
        expect(usedThisYear(s), `${ev.id} › ${c.text}`).toBe(amount >= 0.5);
        checked++;
      });
    }
    // 술 8종 × 상황 = 31장, 마시는 선택지 60개 (음복 청주는 마시는 선택지가 하나)
    expect(checked).toBeGreaterThanOrEqual(60);
  });

  it('마신 선택은 저장·불러오기 뒤 다시 골라도 한 번만 적용되고, 같은 시드·같은 선택이면 결과가 같다', () => {
    const run = () => {
      const ev = getEvent('nut_food_soju_travel');
      const s = personFor(ev, 30, 'USE-ONCE-SOJU');
      expect(presentCard(s, { eventId: ev.id, ctx: {} })).toBe(true);
      const storage = memoryStorage();
      saveGame(s, storage);
      const loaded = loadGame(storage)!;
      choose(s, 0);
      choose(loaded, 0);
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(s));
      // 결과가 붙은 카드를 저장·불러와 다시 골라도 아무 일도 없다
      saveGame(loaded, storage);
      const again = loadGame(storage)!;
      choose(again, 0);
      choose(again, 1);
      expect(JSON.stringify(again)).toBe(JSON.stringify(loaded));
      expect(readRecord(again.ch, 'alcohol').uses).toBe(1);
      expect(readRecord(again.ch, 'alcohol').usesThisYear).toBe(0.5);
      // 그해에는 해장 카드가 열리고, 이듬해 마시지 않으면 다시 닫힌다
      expect(hangoverOpen(again)).toContain('nut_food_seolleongtang_haejang');
      proceed(again);
      nextYear(again);
      expect(readRecord(again.ch, 'alcohol').usesThisYear).toBe(0);
      expect(hangoverOpen(again)).toEqual([]);
      return again;
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe('마셨다고 전제하는 장면 (R-008의 영양 부분)', () => {
  it('해장·숙취 카드는 모두 그해 실제 음주를 조건으로 두고, 마시지 않은 사람에게는 열리지 않는다', () => {
    // 해장 상황 13장 + 편의점 숙취해소 음료 + 생리 현상 숙취 + 첫 숙취 + 회식 다음 날
    expect(HANGOVER_CARDS.filter((ev) => ev.id.endsWith('_haejang')).length).toBe(13);
    expect(HANGOVER_CARDS.length).toBeGreaterThanOrEqual(45);
    for (const ev of HANGOVER_CARDS) expect(ev.trigger?.if ?? '', ev.id).toContain('substance.alcohol.usedThisYear');

    const s = personAt('HAEJANG', 30);
    expect(hangoverOpen(s)).toEqual([]);
    // 권유를 거절만 한 사람도 마찬가지다
    expect(presentCard(s, { eventId: 'nut_food_makgeolli_travel', ctx: {} })).toBe(true);
    choose(s, nonUseIndex(s));
    proceed(s);
    expect(hangoverOpen(s)).toEqual([]);
    // 실제로 마시면 그해에 열린다
    expect(doActivity(s, 'drinking')).not.toBeNull();
    expect(hangoverOpen(s)).toEqual(
      expect.arrayContaining(['nut_food_seolleongtang_haejang', 'nut_food_hangover_drink_store', 'phys_first_hangover']),
    );
    presentCard(s, { eventId: 'nut_food_seolleongtang_haejang', ctx: {} });
    expect(s.card!.text).toContain('어젯밤 마신 술의 대가');
  });

  it('밥상·생리 풀에서 마셨다고 전제하는 문장은 음주 상태를 조건으로 둔다', () => {
    // 지난밤 음주·해장·계속 마심을 사실로 쓰는 표현 (영양 정보 문장은 대상이 아니다)
    const PRESUME = /어젯밤 마신 술|술자리의 대가|숙취해소 음료 쪽으로|해장한다|해장국을 먹|제대로 마신 술|술은 그대로|치맥은 계속|술을 끊으니|소주 세 병|술자리 전에|저녁 삼겹살에 소주/;
    const drinking = (cond: string | undefined) => (cond ?? '').includes('substance.alcohol');
    const offenders: string[] = [];
    for (const ev of EVENTS) {
      if (ev.pool !== 'nutrition' && ev.pool !== 'physiology') continue;
      const gated = drinking(ev.trigger?.if) || (ev.trigger?.flags ?? []).includes('heavy_drinker');
      if (gated) continue;
      if (PRESUME.test(`${ev.title} ${ev.zoom ?? ''} ${ev.text}`)) offenders.push(`${ev.id} (본문)`);
      for (const c of ev.choices ?? []) {
        const said = [c.text, c.result ?? '', c.onSuccess?.text ?? '', c.onFail?.text ?? ''].join(' ');
        if (PRESUME.test(said) && !drinking(c.if)) offenders.push(`${ev.id} › ${c.text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('술 카드의 장면은 주인공이 이미 시켰거나 땄다고 쓰지 않고, 권하거나 놓인 데서 멈춘다', () => {
    const PRESUMED_ORDER = /(을|를) 시켰다|(을|를) 땄다|받아 든 건|간절해졌다|받아 들었다|봉지 안에는/;
    for (const ev of ALCOHOL_FOOD_CARDS) expect(ev.text, ev.id).not.toMatch(PRESUMED_ORDER);
    // 술이 아닌 마실 것은 원래 장면 그대로다
    expect(getEvent('nut_food_cola_camping').text).toContain('콜라를 땄다');
  });

  it('끊기·치료를 고르면 서술만이 아니라 기록에도 남는다 (통풍의 금주, 베타카로틴의 금연클리닉)', () => {
    const gout = getEvent('nut_purine_gout');
    const d = personAt('GOUT-DRINKER', 45);
    d.ch.sex = 'M';
    expect(doActivity(d, 'drinking')).not.toBeNull();
    expect(presentCard(d, { eventId: gout.id, ctx: {} })).toBe(true);
    choose(d, d.card!.choices.findIndex((c) => c.text.includes('술부터 끊고')));
    expect(isQuitting(readRecord(d.ch, 'alcohol'))).toBe(true);
    // 마시지 않는 사람에게는 술을 끊는 선택지가 보이지 않는다
    const n = personAt('GOUT-SOBER', 45);
    n.ch.sex = 'M';
    expect(presentCard(n, { eventId: gout.id, ctx: {} })).toBe(true);
    expect(n.card!.choices.some((c) => c.text.includes('술'))).toBe(false);

    const smoker = personAt('BETA-SMOKER', 45);
    smoker.ch.flags.smoker = { since: 25 };
    expect(presentCard(smoker, { eventId: 'nut_vita_smoker_beta', ctx: {} })).toBe(true);
    choose(smoker, smoker.card!.choices.findIndex((c) => c.text.includes('금연클리닉')));
    const t = readRecord(smoker.ch, 'tobacco');
    expect(t.treatment).toBe('active');
    expect(isQuitting(t)).toBe(true);
    expect(smoker.ch.flags.smoker).toBeUndefined();
  });

  it('첫 술 장면은 아직 마셔 본 적 없는 사람에게만, 마시는 선택은 기록되고 거절도 남는다', () => {
    const first = getEvent('nut_life_first_drink');
    const s = personAt('FIRST-DRINK', 19);
    expect(triggerOk(first, buildScope(s), s)).toBe(true);
    expect(presentCard(s, { eventId: first.id, ctx: {} })).toBe(true);
    choose(s, s.card!.choices.findIndex((c) => c.text.includes('못 마신다')));
    const a = readRecord(s.ch, 'alcohol');
    expect([a.ever, a.refusals]).toEqual([false, 1]);

    const d = personAt('FIRST-DRINK-2', 19);
    expect(doActivity(d, 'drinking')).not.toBeNull();
    expect(triggerOk(first, buildScope(d), d)).toBe(false);
  });
});
