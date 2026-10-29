// 말로만 마시던 장면 정리 (검토 R-008·R-014의 나머지, R-016의 활동비 표시)
//
// - 연애·의료·육아·중년 사건에서 술·담배를 말하는 문장은 다음 가운데 하나여야 한다:
//   실제 물질 상태를 조건으로 두었다 / 그 선택지가 substances.ts에 사용·거절·끊기·치료를 남긴다 /
//   마시지 않는 대안을 말한다 / 모든 선택지가 응답을 기록하는 권유 장면이다 / 그런 장면에서만 이어진다 /
//   아래 ALLOWED에 이유를 적은 맥락(다른 사람의 음주·흡연, 의사의 설명)이다
// - 사용 선택지 옆에는 늘 비사용 선택지가 있고, 검증기(validate.ts)도 같은 규칙으로 새 데이터를 막는다
// - 만 19세 미만은 어떤 경로로도 쓰지 않는다
// - 고등학생 도박 빚(gambling_spiral)은 미성년자 지출 규칙(pay)을 따라 개인 빚이 생기지 않는다
// - 성인의 활동비는 실제로 줄어든 현금(과 생긴 빚)으로 표시된다

import { describe, expect, it } from 'vitest';
import { activityViews, performActivity } from '../src/engine/activities';
import { evaluate } from '../src/engine/conditions';
import { EVENTS, EVENT_FILES, getEvent } from '../src/engine/data';
import { applyEffects } from '../src/engine/effects';
import { presentCard } from '../src/engine/eventEngine';
import { formatWon } from '../src/engine/format';
import { choose, doActivity, newGame, proceed } from '../src/engine/game';
import { haveChild, marry, startPartner } from '../src/engine/relations';
import { rngFor } from '../src/engine/rng';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import type { Action, ChoiceDef, Effects, EventDef } from '../src/engine/schema';
import { buildScope } from '../src/engine/scope';
import { isQuitting, readRecord } from '../src/engine/substances';
import type { GameState } from '../src/engine/types';
import { nonUseIssues, validateData } from '../src/engine/validate';

// ── 데이터 훑기 ──────────────────────────────────────────

/** 이번에 정리한 파일 */
const OWNED = ['catalog/romance.json', 'catalog/medical.json', 'catalog/parenting.json', 'events/midlife.json'];

/** 술·담배를 말하는 낱말. 수술·미술·입술·술래잡기의 '술'은 앞뒤 글자로 뺀다 */
const WORDS =
  /(?<![가-힣])술(?!래)|소주|맥주|막걸리|와인|양주|위스키|담배|흡연|금연|금주|단주|해장|숙취|취기|취해|취한|만취|건배|술 한잔|폭탄주|소맥|칵테일|하이볼|담뱃|음주|주량|과음|반주로|니코틴/;
/** 실제 물질 상태를 읽는 조건 */
const GATE = /substance\.(alcohol|tobacco)|flags\.(smoker|vaper|heavy_drinker|quitting_smoking|quitting_drinking|ex_smoker|sober)/;
const GATE_FLAGS = ['smoker', 'vaper', 'heavy_drinker', 'quitting_smoking', 'quitting_drinking', 'ex_smoker', 'sober'];
/** 마시지 않는 쪽을 말하는 문장 */
const NONUSE = /술 대신|사이다|탄산수|식혜|마시지 않|안 마시/;

/**
 * 주인공이 마시거나 피웠다고 쓰지 않는, 이유가 있는 맥락. 줄이 낡으면(더는 걸리는 문장이 없으면) 아래 시험이 알려 준다
 */
const ALLOWED: Record<string, string> = {
  // 다른 사람의 음주·흡연
  rom_issue_friend_dating: '연인이 친구와 마신 술',
  rom_issue_lie_dating: '연인의 술자리 사진',
  rom_issue_drink_dating: '연인의 술버릇',
  rom_issue_drink_married: '배우자의 술버릇',
  rom_issue_smoke_dating: '연인의 흡연',
  rom_drunk_night: '만취한 연인을 데리러 감',
  rom_office_crush: '회식의 건배사 (주인공이 마셨다고 쓰지 않는다)',
  med_p_angina_dx: '부모의 금연',
  med_s_gout: '배우자의 맥주',
  med_s_gout_dx: '배우자에게 한 의사의 조언과 배우자의 맥주',
  med_inc_er_violence_self: '응급실의 취객',
  par_cigarettes_found: '자녀의 담배를 발견한 부모의 대응 (주인공 사용 아님, 예방·상담 경로)',
  // 의사의 설명·조언 (마신다고 전제하지 않는다)
  med_gerd_dx: '늦은 식사·술·커피를 줄이라는 생활 조언',
  med_pancreatitis_dx: '흔한 원인(술·담석) 설명',
  med_prostatitis_dx: '원인 설명',
  med_gout_dx: '맥주·내장 고기를 줄이라는 조언',
  med_copd_dx: "'피운다면' 끊으라는 조건부 조언",
  med_male_menopause_dx: '술 줄이기를 포함한 생활 조언',
  med_tremor_dx: '술에 기대면 위험하다는 설명',
  med_care_fatty_liver_1: '술을 안 마셔도 지방간이 생긴다는 설명',
};

const FILE_OF = new Map<string, string>();
for (const [file, list] of Object.entries(EVENT_FILES)) for (const ev of list) FILE_OF.set(ev.id, file);
const owned = (ev: EventDef) => OWNED.includes(FILE_OF.get(ev.id) ?? '');

function substanceActs(fx: Effects | undefined): Extract<Action, { type: 'substance' }>[] {
  return (fx?.do ?? []).filter((a): a is Extract<Action, { type: 'substance' }> => a.type === 'substance');
}
function choiceActs(c: ChoiceDef) {
  return [...substanceActs(c.effects), ...substanceActs(c.onSuccess?.effects), ...substanceActs(c.onFail?.effects)];
}
const records = (c: ChoiceDef) => choiceActs(c).length > 0;
const usesIn = (c: ChoiceDef) => choiceActs(c).some((a) => a.act === 'use');

function eventGated(ev: EventDef): boolean {
  const t = ev.trigger;
  return GATE.test(t?.if ?? '') || [...(t?.flags ?? []), ...(t?.anyFlags ?? [])].some((f) => GATE_FLAGS.includes(f));
}

/** 선택지의 문장 전부 */
function choiceText(c: ChoiceDef): string {
  return [c.text, c.result ?? '', c.onSuccess?.text ?? '', c.onFail?.text ?? ''].join(' / ');
}

/** 연속 사건 가운데 술·담배 상태를 본 장면(조건 또는 기록한 선택지)에서만 이어지는 것 */
function inheritedGates(events: EventDef[]): Set<string> {
  const incoming = new Map<string, boolean[]>();
  const link = (to: string, gated: boolean) => incoming.set(to, [...(incoming.get(to) ?? []), gated]);
  const nexts = (n: ChoiceDef['next']) => (!n ? [] : typeof n === 'string' ? [n] : n.map((x) => x.event));
  const laters = (fx: Effects | undefined) => (fx?.later ?? []).map((l) => l.event);
  const gated = new Set(events.filter(eventGated).map((ev) => ev.id));
  for (let round = 0; round < 5; round++) {
    incoming.clear();
    for (const ev of events) {
      const evOk = gated.has(ev.id);
      for (const to of [...nexts(ev.next), ...laters(ev.effects)]) link(to, evOk);
      for (const c of ev.choices ?? []) {
        const ok = evOk || GATE.test(c.if ?? '') || records(c);
        for (const to of [c.next, c.onSuccess?.next, c.onFail?.next].flatMap(nexts)) link(to, ok);
        for (const to of [c.effects, c.onSuccess?.effects, c.onFail?.effects].flatMap(laters)) link(to, ok);
      }
    }
    for (const ev of events) {
      const ins = incoming.get(ev.id);
      if (ev.type === 'chain' && ins && ins.length > 0 && ins.every(Boolean)) gated.add(ev.id);
    }
  }
  return gated;
}

/** 이유 없이 술·담배를 말하는 문장 (사건 › 위치) */
function unexplained(events: EventDef[]): { offenders: string[]; allowedHits: Set<string> } {
  const gated = inheritedGates(EVENTS);
  const offenders: string[] = [];
  const allowedHits = new Set<string>();
  const flag = (ev: EventDef, where: string, text: string) => {
    if (ALLOWED[ev.id]) allowedHits.add(ev.id);
    else offenders.push(`${FILE_OF.get(ev.id)} ${ev.id} › ${where}: ${text}`);
  };
  for (const ev of events) {
    if (gated.has(ev.id)) continue;
    const choices = ev.choices ?? [];
    const body = `${ev.title} ${ev.zoom ?? ''} ${ev.text}`;
    // 권유 장면: 모든 선택지가 마시기·거절을 기록한다
    const offer = choices.length > 0 && choices.every(records);
    if (WORDS.test(body) && !offer) flag(ev, '본문', ev.text);
    choices.forEach((c, i) => {
      const said = choiceText(c);
      if (!WORDS.test(said) || GATE.test(c.if ?? '') || records(c) || NONUSE.test(said)) return;
      flag(ev, `선택지 ${i + 1}`, said);
    });
  }
  return { offenders, allowedHits };
}

/** 이번에 고친 사건 (이전 작업이 찾은 목록) */
const ROMANCE_FIXED = [
  ...EVENTS.filter((ev) => /^rom_date_(pocha|baseball|hiking|market|finedining)_/.test(ev.id)).map((ev) => ev.id),
  'rom_issue_inlaws_m2',
  'rom_heartbreak',
  'rom_honsu',
  'rom_baby_plan',
  'rom_christmas_eve',
  'rom_ex_spouse_news',
];
const MEDICAL_FIXED = [
  'med_insomnia',
  'med_male_menopause',
  'med_tremor_dx',
  'med_pancreatitis',
  'med_pancreatitis_dx',
  'med_bph_worse',
  'med_slip_gout_1',
  'med_slip_ibd_1',
  'med_care_migraine_1',
  'med_care_gout_1',
  'med_gout_dx',
  'med_care_fatty_liver_1',
  'med_care_hbv_1',
  'med_chk_fatty_liver_company',
  'med_chk_fatty_liver_national',
  'med_chk_fatty_liver_t40',
  'med_chk_fatty_liver_premium',
  'med_tia_dx',
  'med_angina_worse',
  'med_care_copd_1',
  'med_chk_lung_nodule_national',
  'med_chk_lung_nodule_t66',
  'med_chk_lung_nodule_result',
  'med_quit_smoking',
];
const OTHER_FIXED = ['par_first_drink_together_f', 'par_first_drink_together_m', 'par_ex_new_partner_f', 'par_ex_new_partner_m', 'checkup_red'];

// ── 시험용 인물 ──────────────────────────────────────────

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** 나이를 바로 정한 인물 (술·담배 이력 없음) */
function personAt(seed: string, age: number, sex: 'M' | 'F' = 'M'): GameState {
  const s = newGame({ seed, mode: 'reality', birthYear: 2026 });
  s.ch.age = age;
  s.ch.sex = sex;
  s.year = 2026 + age;
  s.world.year = s.year;
  s.ch.res.cash = 50_000_000;
  s.ch.res.debt = 0;
  s.points = { max: 6, left: 6 };
  return s;
}

function withPartner(s: GameState): GameState {
  startPartner(s, rngFor(s.seed, 'partner'));
  return s;
}

function married(s: GameState): GameState {
  withPartner(s);
  marry(s);
  return s;
}

/** 술을 한 번 마셔 본 사람 (활동 메뉴의 술자리) */
function drinker(s: GameState): GameState {
  expect(doActivity(s, 'drinking')).not.toBeNull();
  return s;
}

/** 화면에 뜬 선택지의 사건 정의 */
function shownDefs(s: GameState): ChoiceDef[] {
  const ev = getEvent(s.card!.eventId);
  return s.card!.choices.map((c) => ev.choices![c.index]);
}

function shownIndex(s: GameState, text: string): number {
  return s.card!.choices.findIndex((c) => c.text.includes(text));
}

// ── 시험 ─────────────────────────────────────────────────

describe('술·담배를 말하는 문장에는 실제 상태가 있다 (R-008·R-014 나머지)', () => {
  it('연애·의료·육아·중년 사건: 써 본 적 없는 사람에게 열리는 문장이 이유 없이 마셨다·피웠다고 쓰지 않는다', () => {
    const { offenders, allowedHits } = unexplained(EVENTS.filter(owned));
    expect(offenders).toEqual([]);
    // 허용 목록은 실제로 걸리는 사건만 둔다 (낡은 줄이 남지 않게)
    expect(Object.keys(ALLOWED).filter((id) => !allowedHits.has(id))).toEqual([]);
  });

  it('이번에 고친 사건이 모두 있고(연애 31·의료 24·육아 4·중년 1), 허용 목록이 아니라 조건·기록으로 설명된다', () => {
    expect(ROMANCE_FIXED).toHaveLength(31);
    expect(MEDICAL_FIXED).toHaveLength(24);
    const all = [...ROMANCE_FIXED, ...MEDICAL_FIXED, ...OTHER_FIXED];
    for (const id of all) expect(() => getEvent(id), id).not.toThrow();
    // 의사의 설명이 본문에 남은 네 사건만 허용 목록에 있다
    expect(all.filter((id) => ALLOWED[id]).sort()).toEqual(
      ['med_care_fatty_liver_1', 'med_gout_dx', 'med_pancreatitis_dx', 'med_tremor_dx'].sort(),
    );
    const fixed = EVENTS.filter((ev) => all.includes(ev.id));
    expect(unexplained(fixed).offenders).toEqual([]);
    // 예전 문장이 그대로 남지 않았다
    const OLD =
      /술자리 다음 날|맥주를 마신 밤|술을 한잔한 밤|잠 부족과 와인|매운 음식과 술|소주 한 병을 시켰다|치킨과 맥주|파전과 막걸리|편의점 앞에서 맥주|벌써 네 잔째|그날 밤 혼자 술을 마셨다|술자리에서 다시 피웠다|술자리가 세 번|석 달 만에 다시 손을 댔다/;
    for (const ev of fixed) {
      const texts = [ev.title, ev.text, ...(ev.choices ?? []).map(choiceText)];
      expect(texts.filter((t) => OLD.test(t)), ev.id).toEqual([]);
    }
  });

  it('마신다고 전제하는 선택지(술을 끊는다·줄인다·끊지 못한다)는 지금 마시는 사람에게만 보이고, 고르면 기록된다', () => {
    const GATED = inheritedGates(EVENTS);
    const PRESUMES = /(?<![가-힣])(술|맥주|담배)[^/]*(끊|줄인|줄이)|담배를 쓰레기통/;
    const checked: string[] = [];
    for (const ev of EVENTS.filter(owned)) {
      for (const c of ev.choices ?? []) {
        if (!PRESUMES.test(c.text)) continue;
        // 다른 사람에게 권하는 선택지(…끊게 한다)와, 술자리에서도 사이다를 마셨다는 비사용 결과는 뺀다
        if (/게 한다|자고 한다|말한다|달라고 한다/.test(c.text) || NONUSE.test(choiceText(c))) continue;
        expect(GATE.test(c.if ?? '') || GATED.has(ev.id), `${ev.id} › ${c.text}`).toBe(true);
        expect(records(c), `${ev.id} › ${c.text}`).toBe(true);
        checked.push(`${ev.id} › ${c.text}`);
      }
    }
    expect(checked.length).toBeGreaterThanOrEqual(18);
  });
});

describe('비사용 선택은 늘 있다 (검증기 규칙)', () => {
  it('전체 사건이 검증기의 비사용 규칙을 통과하고, 데이터 검증 오류가 없다', () => {
    expect(nonUseIssues(EVENTS)).toEqual([]);
    expect(validateData().filter((i) => i.level === 'error')).toEqual([]);
  });

  const use: Action = { type: 'substance', substance: 'alcohol', act: 'use', amount: 0.5 };
  const card = (choices: ChoiceDef[], effects?: Effects): EventDef => ({
    id: 'test_card',
    type: 'random',
    title: '시험',
    text: '시험 장면',
    ...(effects ? { effects } : {}),
    choices,
  });
  const drink = (extra: Partial<ChoiceDef> = {}): ChoiceDef => ({ text: '마신다', result: '마셨다', effects: { do: [use] }, ...extra });
  const pass = (extra: Partial<ChoiceDef> = {}): ChoiceDef => ({ text: '사양한다', result: '사이다를 마셨다', ...extra });

  it('새 데이터: 사용 선택지만 있는 카드, 조건이 어긋난 비사용 선택지, 뜨기만 해도 쓰게 하는 카드는 오류다', () => {
    expect(nonUseIssues([card([drink()])])).toHaveLength(1);
    expect(nonUseIssues([card([drink({ if: 'family.partnerAdult' }), pass({ if: 'family.married' })])])).toHaveLength(1);
    // 판정 실패 쪽에서만 써도 사용 선택지다
    const failUse: ChoiceDef = { text: '참아 본다', check: { stat: 'mental', dc: 50 }, onSuccess: { text: '참았다' }, onFail: { text: '마셨다', effects: { do: [use] } } };
    expect(nonUseIssues([card([failUse])])).toHaveLength(1);
    expect(nonUseIssues([card([pass()], { do: [use] })])).toHaveLength(1);
    // 사용 태그를 직접 붙이는 것도 사용이다
    expect(nonUseIssues([card([{ text: '피운다', result: '피웠다', effects: { addFlags: ['smoker'] } }])])).toHaveLength(1);
  });

  it('새 데이터: 비사용 선택지가 조건 없이, 같은 조건으로, 또는 사용 선택지의 조건에 포함된 조건으로 함께 보이면 통과한다', () => {
    expect(nonUseIssues([card([drink(), pass()])])).toEqual([]);
    expect(nonUseIssues([card([drink({ if: 'substance.adult' }), pass({ if: 'substance.adult' })])])).toEqual([]);
    // 의료 표처럼 나이로 나뉜 선택지: 사용 쪽 조건 (substance.adult) && (age >= 19) 이 비사용 쪽 age >= 19 를 품는다
    expect(nonUseIssues([card([drink({ if: '(substance.adult) && (age >= 19)' }), pass({ if: 'age >= 19' })])])).toEqual([]);
    // 거꾸로는 안 된다: 비사용 쪽 조건이 더 좁다
    expect(nonUseIssues([card([drink({ if: 'age >= 19' }), pass({ if: '(age >= 19) && flags.smoker' })])])).toHaveLength(1);
    // '!(a && b)'는 하나의 조각이다
    expect(nonUseIssues([card([drink({ if: 'x.y && z.w' }), pass({ if: '!(x.y && z.w)' })])])).toHaveLength(1);
  });

  it('고친 사건의 사용 선택지 옆에는 실제로 고를 수 있는 비사용 선택지가 같은 화면에 뜬다', () => {
    for (const id of ['rom_date_pocha_early', 'rom_date_baseball_early', 'rom_date_market_early', 'rom_date_finedining_early']) {
      const t = withPartner(personAt(`SHOWN-${id}`, 30));
      expect(presentCard(t, { eventId: id, ctx: {} }), id).toBe(true);
      const defs = shownDefs(t);
      expect(defs.some(usesIn), id).toBe(true);
      expect(defs.some((c) => !usesIn(c)), id).toBe(true);
      // 카드가 뜨는 것만으로는 아무 기록도 생기지 않는다
      expect(t.ch.substances, id).toBeUndefined();
    }
  });
});

describe('연애 장면의 술 (실제 기록)', () => {
  it('포장마차: 안 마시는 선택지로는 기록이 없고, 마시면 고른 만큼 한 번 기록되며 저장·불러오기 뒤에도 같다', () => {
    const dry = withPartner(personAt('POCHA-DRY', 30));
    expect(presentCard(dry, { eventId: 'rom_date_pocha_early', ctx: {} })).toBe(true);
    expect(dry.card!.text).not.toMatch(WORDS);
    choose(dry, shownIndex(dry, '어묵 국물'));
    proceed(dry);
    expect(readRecord(dry.ch, 'alcohol').ever).toBe(false);

    const wet = withPartner(personAt('POCHA-WET', 30));
    expect(presentCard(wet, { eventId: 'rom_date_pocha_early', ctx: {} })).toBe(true);
    choose(wet, shownIndex(wet, '끝까지 간다'));
    const a = readRecord(wet.ch, 'alcohol');
    expect([a.ever, a.uses, a.usesThisYear, a.firstAge]).toEqual([true, 1, 1, 30]);
    const storage = memoryStorage();
    saveGame(wet, storage);
    const loaded = loadGame(storage)!;
    choose(loaded, 0);
    expect(readRecord(loaded.ch, 'alcohol').uses).toBe(1);
    // 그해에는 마셨다고 전제하는 해장 장면의 조건이 참이다
    expect((buildScope(loaded).substance as { alcohol: { usedThisYear: boolean } }).alcohol.usedThisYear).toBe(true);
  });

  it('썸 단계(이름만 있는 {상대})의 데이트에는 함께 마시는 선택지가 뜨지 않는다', () => {
    const somes = EVENTS.filter((ev) => /^rom_date_.+_some$/.test(ev.id));
    expect(somes.length).toBeGreaterThan(20);
    for (const ev of somes) {
      for (const c of (ev.choices ?? []).filter(usesIn)) expect(c.if ?? '', `${ev.id} › ${c.text}`).toContain('family.partnerAdult');
    }
    const s = personAt('POCHA-SOME', 25);
    expect(presentCard(s, { eventId: 'rom_date_pocha_some', ctx: {} })).toBe(true);
    expect(shownDefs(s).some(usesIn)).toBe(false);
  });

  it('처가의 술잔: 받아 마시면 기록되고, 사양하면 거절로 남는다. 짝 친밀도도 그대로 오른다', () => {
    const yes = married(personAt('INLAWS-YES', 35, 'M'));
    expect(presentCard(yes, { eventId: 'rom_issue_inlaws_m2', ctx: {} })).toBe(true);
    expect(yes.card!.text).not.toMatch(/네 잔째|벌써/);
    choose(yes, shownIndex(yes, '끝까지 받아 마신다'));
    expect(readRecord(yes.ch, 'alcohol').uses).toBe(1);
    const no = married(personAt('INLAWS-NO', 35, 'M'));
    const before = no.ch.npcs.find((n) => n.role === 'spouse')!.closeness;
    expect(presentCard(no, { eventId: 'rom_issue_inlaws_m2', ctx: {} })).toBe(true);
    choose(no, shownIndex(no, '구조를 요청한다'));
    const a = readRecord(no.ch, 'alcohol');
    expect([a.ever, a.refusals]).toEqual([false, 1]);
    expect(no.ch.npcs.find((n) => n.role === 'spouse')!.closeness).toBe(before + 3);
  });

  it('아이 준비: 마시는 사람은 금주를 고를 수 있고 기록되며, 안 마시는 사람에게는 금주 대신 생활 습관 선택지가 뜬다', () => {
    const d = drinker(married(personAt('BABY-DRINKER', 30, 'F')));
    expect(presentCard(d, { eventId: 'rom_baby_plan', ctx: {} })).toBe(true);
    choose(d, shownIndex(d, '술과 커피부터 줄인다'));
    expect(isQuitting(readRecord(d.ch, 'alcohol'))).toBe(true);
    const n = married(personAt('BABY-SOBER', 30, 'F'));
    expect(presentCard(n, { eventId: 'rom_baby_plan', ctx: {} })).toBe(true);
    expect(n.card!.choices.some((c) => c.text.includes('술'))).toBe(false);
    expect(shownIndex(n, '커피부터 줄이고')).toBeGreaterThanOrEqual(0);
  });
});

describe('의료 장면의 술·담배', () => {
  it('불면증의 술 한잔은 18세에는 숨고 19세에 보이며, 고르면 기록된다', () => {
    const teen = personAt('INSOMNIA-18', 18);
    expect(presentCard(teen, { eventId: 'med_insomnia', ctx: {} })).toBe(true);
    expect(shownIndex(teen, '술')).toBe(-1);
    const adult = personAt('INSOMNIA-19', 19);
    expect(presentCard(adult, { eventId: 'med_insomnia', ctx: {} })).toBe(true);
    choose(adult, shownIndex(adult, '술 한잔'));
    expect(readRecord(adult.ch, 'alcohol').uses).toBe(1);
  });

  it('췌장염: 안 마시는 사람에게는 술자리·해장국 문장이 없고, 마신 사람에게만 해장국·금주·술자리 선택지가 뜬다', () => {
    const sober = personAt('PANC-SOBER', 45);
    expect(presentCard(sober, { eventId: 'med_pancreatitis', ctx: {} })).toBe(true);
    expect(sober.card!.text).not.toMatch(WORDS);
    expect(sober.card!.choices.map((c) => c.text).join(' ')).not.toMatch(WORDS);
    proceed(sober);
    const dx = personAt('PANC-DX-SOBER', 45);
    expect(presentCard(dx, { eventId: 'med_pancreatitis_dx', ctx: {} })).toBe(true);
    expect(dx.card!.choices.map((c) => c.text)).toEqual(['금식 입원하고 원인을 찾는다']);

    const d = drinker(personAt('PANC-DRINKER', 45));
    expect(presentCard(d, { eventId: 'med_pancreatitis', ctx: {} })).toBe(true);
    expect(shownIndex(d, '해장국')).toBeGreaterThanOrEqual(0);
    const dd = drinker(personAt('PANC-DX-DRINKER', 45));
    expect(presentCard(dd, { eventId: 'med_pancreatitis_dx', ctx: {} })).toBe(true);
    expect(dd.card!.choices.map((c) => c.text)).toEqual(['금식 입원하고 술을 끊는다', '퇴원하자마자 술자리에 간다', '금식 입원하고 원인을 찾는다']);
    choose(dd, shownIndex(dd, '술자리에 간다'));
    expect(readRecord(dd.ch, 'alcohol').uses).toBe(2);
  });

  it('담배를 끊었다는 결과는 피우는 사람이 끊기를 고를 때만이고, 끊기·치료는 기록에 남는다', () => {
    const sober = personAt('TIA-NONSMOKER', 60);
    expect(presentCard(sober, { eventId: 'med_tia_dx', ctx: {} })).toBe(true);
    expect(shownIndex(sober, '담배')).toBe(-1);
    choose(sober, 0);
    expect(sober.card!.result!.text).not.toMatch(/담배/);

    const smoker = personAt('TIA-SMOKER', 60);
    smoker.ch.flags.smoker = { since: 25 };
    expect(presentCard(smoker, { eventId: 'med_tia_dx', ctx: {} })).toBe(true);
    // 끊지 않는 선택지도 그대로 고를 수 있다
    expect(shownIndex(smoker, '약을 먹고 혈압을 매일 잰다')).toBe(0);
    choose(smoker, shownIndex(smoker, '담배도 끊는다'));
    expect(isQuitting(readRecord(smoker.ch, 'tobacco'))).toBe(true);
    expect(smoker.ch.flags.smoker).toBeUndefined();

    // 금연클리닉은 서술만이 아니라 치료 기록이다 (판정 성공 쪽)
    for (const id of ['med_quit_smoking', 'med_care_copd_1', 'med_chk_lung_nodule_national']) {
      const ev = getEvent(id);
      const clinic = ev.choices!.find((c) => /금연클리닉|금연 치료|담배를 끊는다|담배부터/.test(choiceText(c)))!;
      expect(choiceActs(clinic).some((a) => a.substance === 'tobacco' && a.act === 'treat'), id).toBe(true);
    }
    // 전자담배로 바꾸면 실제 제품이 바뀐다
    const v = personAt('VAPE-SWITCH', 40);
    v.ch.flags.smoker = { since: 25 };
    expect(presentCard(v, { eventId: 'med_quit_smoking', ctx: {} })).toBe(true);
    choose(v, shownIndex(v, '전자담배로 바꾼다'));
    expect(readRecord(v.ch, 'tobacco').product).toBe('ecig');
    expect(v.ch.flags.vaper).toBeDefined();
    expect(v.ch.flags.smoker).toBeUndefined();
  });

  it('지방간·통풍·B형간염: 술을 끊거나 줄이거나 못 끊는 선택지는 마시는 사람에게만, 안 마시는 사람에게는 식단 선택지가 있다', () => {
    const cases: [string, string, string][] = [
      ['med_care_fatty_liver_1', 'med_fatty_liver', '야식을 끊는다'],
      ['med_care_gout_1', 'med_gout', '내장과 단 음료를 끊는다'],
      ['med_care_hbv_1', 'med_hbv', '정기 검진만 다시 다닌다'],
    ];
    for (const [id, tag, sober] of cases) {
      const n = personAt(`CARE-SOBER-${id}`, 45);
      n.ch.flags[tag] = { since: 40 };
      expect(presentCard(n, { eventId: id, ctx: {} }), id).toBe(true);
      expect(n.card!.choices.map((c) => c.text).join(' '), id).not.toMatch(/술|맥주/);
      expect(shownIndex(n, sober), id).toBeGreaterThanOrEqual(0);
      const d = drinker(personAt(`CARE-DRINKER-${id}`, 45));
      d.ch.flags[tag] = { since: 40 };
      expect(presentCard(d, { eventId: id, ctx: {} }), id).toBe(true);
      expect(d.card!.choices.some((c) => /술|맥주/.test(c.text)), id).toBe(true);
    }
  });

  it('주인공이 아닌 사람이 환자인 의료 장면은 주인공의 술·담배 기록을 바꾸지 않는다', () => {
    const others = EVENTS.filter((ev) => /^med_(p|s|kid)_/.test(ev.id));
    expect(others.length).toBeGreaterThan(50);
    for (const ev of others) for (const c of ev.choices ?? []) expect(records(c), `${ev.id} › ${c.text}`).toBe(false);
  });
});

describe('육아·중년 장면', () => {
  it('성인이 된 자녀와의 첫 술잔: 자녀는 19세 이상이고, 나는 마시지 않고 함께 갈 수도 있다', () => {
    for (const id of ['par_first_drink_together_f', 'par_first_drink_together_m']) {
      expect(getEvent(id).trigger!.childAge![0], id).toBeGreaterThanOrEqual(19);
    }
    const s = personAt('FIRST-DRINK-PARENT', 45, 'F');
    const kid = haveChild(s, rngFor(s.seed, 'kid'));
    kid.birthYear = s.year - 19;
    expect(presentCard(s, { eventId: 'par_first_drink_together_f', ctx: {} })).toBe(true);
    // 마셔 본 적 없는 부모에게는 '술 마시는 법부터 가르친다'가 뜨지 않는다
    expect(shownIndex(s, '마시는 법')).toBe(-1);
    choose(s, shownIndex(s, '사이다를 시킨다'));
    const a = readRecord(s.ch, 'alcohol');
    expect([a.ever, a.refusals]).toEqual([false, 1]);

    const t = personAt('FIRST-DRINK-PARENT-2', 45, 'M');
    const kid2 = haveChild(t, rngFor(t.seed, 'kid'));
    kid2.birthYear = t.year - 20;
    expect(presentCard(t, { eventId: 'par_first_drink_together_m', ctx: {} })).toBe(true);
    choose(t, shownIndex(t, '포장마차에 간다'));
    expect(readRecord(t.ch, 'alcohol').uses).toBe(1);
  });

  it('전 배우자의 새 연인 소식: 아무렇지 않은 척해도 술을 마셨다고 쓰지 않는다', () => {
    for (const id of ['par_ex_new_partner_f', 'par_ex_new_partner_m']) {
      for (const c of getEvent(id).choices!) {
        expect(choiceText(c), id).not.toMatch(WORDS);
        expect(records(c), id).toBe(false);
      }
    }
  });

  it('검진 빨간 글씨: 끊는 선택지는 실제로 쓰는 물질에만 뜨고 기록되며, 안 쓰는 사람은 식단·걷기를 고른다', () => {
    const texts = (s: GameState) => s.card!.choices.map((c) => c.text);
    const none = personAt('RED-NONE', 50);
    expect(presentCard(none, { eventId: 'checkup_red', ctx: {} })).toBe(true);
    expect(texts(none)).toEqual(['약으로 관리한다', '다들 이 정도는 있다며 넘긴다', '식단을 바꾸고 매일 걷는다']);
    const d = drinker(personAt('RED-DRINK', 50));
    expect(presentCard(d, { eventId: 'checkup_red', ctx: {} })).toBe(true);
    expect(texts(d)).toContain('술을 끊고 걷는다');
    expect(texts(d).join(' ')).not.toMatch(/담배/);
    const sm = personAt('RED-SMOKE', 50);
    sm.ch.flags.smoker = { since: 25 };
    expect(presentCard(sm, { eventId: 'checkup_red', ctx: {} })).toBe(true);
    expect(texts(sm)).toContain('담배를 끊고 걷는다');
    expect(texts(sm).join(' ')).not.toMatch(/술/);
    const both = drinker(personAt('RED-BOTH', 50));
    both.ch.flags.smoker = { since: 25 };
    expect(presentCard(both, { eventId: 'checkup_red', ctx: {} })).toBe(true);
    expect(texts(both)).toContain('술과 담배를 끊고 걷는다');
    // 성공 쪽이 두 물질을 끊는다 (실패 쪽은 마셨다·피웠다고 쓰지 않는다)
    const ev = getEvent('checkup_red');
    const quitBoth = ev.choices![0];
    expect(substanceActs(quitBoth.onSuccess!.effects).map((a) => `${a.substance}:${a.act}`)).toEqual(['alcohol:quit', 'tobacco:quit']);
    for (const c of ev.choices!) expect(c.onFail?.text ?? '', c.text).not.toMatch(/손을 댔다|마셨다|피웠다/);
  });
});

describe('만 19세 미만은 쓰지 않는다', () => {
  const useChoices = EVENTS.filter(owned).flatMap((ev) => (ev.choices ?? []).filter(usesIn).map((c) => ({ ev, c })));

  it('정리한 파일의 사용 선택지는 모두 19세 이상만 보고, 18세에게 효과를 그대로 적용해도 기록되지 않는다', () => {
    expect(useChoices.length).toBeGreaterThanOrEqual(25);
    for (const { ev, c } of useChoices) {
      const adultCard = Boolean(ev.adult) || (ev.trigger?.age?.[0] ?? 0) >= 19;
      expect(adultCard || (c.if ?? '').includes('substance.adult'), `${ev.id} › ${c.text}`).toBe(true);
      const teen = personAt(`TEEN-${ev.id}`, 18);
      const ec = { ctx: {}, rng: rngFor(teen.seed, 'teen'), changes: [] };
      for (const fx of [c.effects, c.onSuccess?.effects, c.onFail?.effects]) applyEffects(teen, fx, ec);
      for (const id of ['alcohol', 'tobacco', 'drug'] as const) expect(readRecord(teen.ch, id).ever, `${ev.id} › ${c.text}`).toBe(false);
    }
  });

  it('18세 시점의 조건식으로는 정리한 파일의 사용 선택지가 하나도 보이지 않는다', () => {
    const teen = personAt('TEEN-SCOPE', 18);
    withPartner(teen);
    const scope = buildScope(teen);
    for (const { ev, c } of useChoices) {
      const [lo] = ev.trigger?.age ?? [0, 120];
      const visible = lo <= 18 && !ev.adult && (!c.if || evaluate(c.if, scope));
      expect(visible, `${ev.id} › ${c.text}`).toBe(false);
    }
  });
});

describe('고등학생 도박 빚 (gambling_spiral): 미성년자 지출 규칙', () => {
  function gambler(seed: string, age: number, cash: number): GameState {
    const s = personAt(seed, age);
    s.ch.res.cash = cash;
    s.ch.family.wealth = 3;
    s.ch.flags.gambling_exposed = { since: age - 1 };
    return s;
  }

  it('16세: 다시 찾으려다 잃은 돈은 내 현금에서 먼저, 모자란 만큼은 보호자가 낸다. 개인 빚·도박 빚 태그는 생기지 않는다', () => {
    const s = gambler('GAMBLE-16', 16, 100_000);
    expect(presentCard(s, { eventId: 'gambling_spiral', ctx: {} })).toBe(true);
    // 미성년자에게는 빚이 생기는 선택지가 아예 뜨지 않는다
    expect(shownDefs(s).some((c) => [c.effects, c.onSuccess?.effects, c.onFail?.effects].some((fx) => (fx?.money?.debt ?? 0) !== 0))).toBe(false);
    choose(s, shownIndex(s, '잃은 만큼만'));
    expect(s.ch.res.debt).toBe(0);
    expect(s.ch.res.cash).toBe(0);
    expect(s.ch.flags.gambling_debt).toBeUndefined();
    expect(s.ch.flags.gambling_addict).toBeDefined();
    expect(s.card!.result!.changes.map((c) => c.text)).toContain(`현금 −${formatWon(100_000)} (보호자 부담 ${formatWon(2_900_000)})`);
  });

  it('미성년자가 볼 수 있는 모든 선택지(판정 성공·실패 양쪽)를 적용해도 빚은 0이다', () => {
    const ev = getEvent('gambling_spiral');
    for (const age of [15, 16, 17, 18]) {
      const probe = gambler(`GAMBLE-PROBE-${age}`, age, 50_000);
      const scope = buildScope(probe);
      const visible = ev.choices!.filter((c) => !c.if || evaluate(c.if, scope));
      expect(visible.length, `${age}세`).toBe(3);
      for (const c of visible) {
        for (const out of [c.effects, c.onSuccess?.effects, c.onFail?.effects]) {
          const s = gambler(`GAMBLE-${age}-${c.text}`, age, 50_000);
          applyEffects(s, out, { ctx: {}, rng: rngFor(s.seed, 'x'), changes: [] });
          expect(s.ch.res.debt, `${age}세 › ${c.text}`).toBe(0);
          expect(s.ch.res.cash, `${age}세 › ${c.text}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
    // 저장된 옛 카드가 가리키던 앞 두 번호는 미성년자용이다 (번호가 성인용으로 바뀌어 빚이 생기지 않게)
    expect(ev.choices!.slice(0, 2).map((c) => c.if)).toEqual(['age < 19', 'age < 19']);
  });

  it('19세(같은 사건이 1년 뒤에 와서 성인이 된 경우): 성인은 예전처럼 빚이 된다', () => {
    const s = gambler('GAMBLE-19', 19, 100_000);
    expect(presentCard(s, { eventId: 'gambling_spiral', ctx: {} })).toBe(true);
    expect(s.card!.choices).toHaveLength(3);
    choose(s, shownIndex(s, '잃은 만큼만'));
    expect(s.ch.res.debt).toBe(3_000_000);
    expect(s.ch.flags.gambling_debt).toBeDefined();
  });
});

describe('성인의 활동비 표시 (R-016과 같은 규칙)', () => {
  /** 돈이 따로 오가지 않는 활동 (특별 처리로 현금이 바뀌는 활동은 뺀다) */
  const PLAIN = (id: string) => {
    const v = activityViews(personAt('VIEW', 30)).find((x) => x.def.id === id);
    return v && !v.def.effects?.money && !['gamble', 'parttime', 'theft', 'diet'].includes(v.def.special ?? '');
  };

  it('30세: 비용이 있는 활동마다 표시된 현금 변화가 실제 잔액 변화와 같다', () => {
    let checked = 0;
    for (const v of activityViews(personAt('ACT-LIST', 30))) {
      if (v.cost <= 0 || !PLAIN(v.def.id)) continue;
      const s = personAt(`ACT-${v.def.id}`, 30);
      const before = s.ch.res.cash;
      const r = performActivity(s, v.def.id);
      if (!r) continue;
      expect(before - s.ch.res.cash, v.def.id).toBe(v.cost);
      expect(s.ch.res.debt, v.def.id).toBe(0);
      expect(r.changes.map((c) => c.text), v.def.id).toContain(`현금 −${formatWon(v.cost)}`);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it('잔액 0·부족·충분: 딱 맞으면 0원이 되고, 모자라면 메뉴에서 막혀 아무것도 바뀌지 않는다', () => {
    const exact = personAt('ACT-EXACT', 30);
    const cost = activityViews(exact).find((v) => v.def.id === 'travel')!.cost;
    exact.ch.res.cash = cost;
    const r = performActivity(exact, 'travel')!;
    expect([exact.ch.res.cash, exact.ch.res.debt]).toEqual([0, 0]);
    expect(r.changes[0].text).toBe(`현금 −${formatWon(cost)}`);

    const short = personAt('ACT-SHORT', 30);
    short.ch.res.cash = cost - 1;
    expect(activityViews(short).find((v) => v.def.id === 'travel')!.enabled).toBe(false);
    expect(performActivity(short, 'travel')).toBeNull();
    expect([short.ch.res.cash, short.ch.res.debt]).toEqual([cost - 1, 0]);

    const broke = personAt('ACT-ZERO', 30);
    broke.ch.res.cash = 0;
    expect(performActivity(broke, 'travel')).toBeNull();
    expect([broke.ch.res.cash, broke.ch.res.debt]).toEqual([0, 0]);
  });

  it('18세는 활동비를 내지 않고(보호자 몫) 현금 표시도 없으며, 19세부터 낸다', () => {
    for (const [age, pays] of [
      [18, false],
      [19, true],
    ] as const) {
      const s = personAt(`ACT-AGE-${age}`, age);
      s.ch.family.wealth = 3;
      const before = s.ch.res.cash;
      const r = performActivity(s, 'grooming')!;
      expect(r, `${age}세`).not.toBeNull();
      expect(r.changes.some((c) => c.text.startsWith('현금 −')), `${age}세`).toBe(pays);
      expect(s.ch.res.cash < before, `${age}세`).toBe(pays);
    }
  });
});
