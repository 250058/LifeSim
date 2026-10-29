// 반복 가능한 관리와 지출의 인과 (개정 계획 '반복 가능한 관리와 지출의 인과', 검토 R-015·R-016·R-017)
//
// R-015 치료 에피소드: 시작·유지·감량·중단·재개가 상태로 갈린다. 유지는 기한을 새로 잡고, 중단은 판정의
//       성공·실패 양쪽에서 치료 중 태그를 지우고 '중단 후' 태그를 남긴다. 연말 기한 경계를 지킨다
// R-016 미성년자의 지출: 실제로 줄어든 내 현금과 보호자 부담(성인은 빚)을 나눠 기록·표시한다
// R-017 만성 질환: 첫 진단은 한 번, 관리·재발 카드는 쿨다운으로 되풀이된다. 오래 남는 수치의 오름은
//       '관리 안 됨 → 관리 중'으로 실제로 바뀔 때만 준다 (반복으로 건강을 쌓을 수 없다)

import { describe, expect, it } from 'vitest';
import medicalJson from '../data/catalog/medical.json';
import nutritionJson from '../data/catalog/nutrition.json';
import { LASTING_STATS } from '../src/engine/catalog/medical';
import { EVENTS, TAG_BY_ID, getEvent } from '../src/engine/data';
import { applyEffects, applyTreatment, expireFlags, pay, paymentText } from '../src/engine/effects';
import { limitOk, poolCandidates, presentCard, triggerOk } from '../src/engine/eventEngine';
import { choose, endTurn, newGame, proceed } from '../src/engine/game';
import { rngFor } from '../src/engine/rng';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import type { ChoiceDef, Effects, EventDef, TagDef, TreatAct } from '../src/engine/schema';
import { buildScope } from '../src/engine/scope';
import type { Change, GameState } from '../src/engine/types';

// ── 도구 ─────────────────────────────────────────────────

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** 저장했다가 불러온다 (JSON을 거치므로 복제이기도 하다) */
function roundtrip(state: GameState): GameState {
  const storage = memoryStorage();
  expect(saveGame(state, storage)).toBe(true);
  const loaded = loadGame(storage);
  expect(loaded).not.toBeNull();
  return loaded!;
}

/** 나이를 바로 정한 시험용 인물. 물가는 2026년 기준 */
function personAt(seed: string, age: number, cash = 50_000_000): GameState {
  const s = newGame({ seed, mode: 'reality', birthYear: 2026 });
  s.ch.age = age;
  s.year = 2026 + age;
  s.world.year = s.year;
  s.world.economy.priceIndex = 1;
  s.ch.res.cash = cash;
  s.ch.res.debt = 0;
  return s;
}

/** 나이만 n년 옮긴다 (그사이의 사건 없이 같은 상태에서 갈라 보기) */
function ageBy(state: GameState, years: number): void {
  state.ch.age += years;
  state.year += years;
  state.world.year = state.year;
}

/** 카드를 띄우고 문구로 선택지를 고른 뒤 넘긴다. 결과 카드를 돌려준다 */
function play(state: GameState, eventId: string, choiceText: string): NonNullable<GameState['card']> {
  expect(presentCard(state, { eventId, ctx: {} }), `${eventId} 카드가 떠야 한다`).toBe(true);
  return pick(state, choiceText);
}

/** 화면에 뜬 카드에서 문구로 고른다 */
function pick(state: GameState, choiceText: string): NonNullable<GameState['card']> {
  const card = state.card!;
  const i = card.choices.findIndex((c) => c.text === choiceText);
  expect(i, `${card.eventId}: '${choiceText}' 선택지가 보여야 한다 (${card.choices.map((c) => c.text).join(' / ')})`).toBeGreaterThanOrEqual(0);
  choose(state, i);
  const done = state.card!;
  proceed(state);
  return done;
}

function choiceByText(ev: EventDef, text: string): ChoiceDef {
  const c = ev.choices!.find((x) => x.text === text);
  if (!c) throw new Error(`${ev.id}: 선택지 없음 ${text}`);
  return c;
}

/**
 * 해를 넘기며 대기 카드를 처리한다 (다른 카드는 첫 선택지). 목표 카드가 뜨면 멈추고 true,
 * 목표 없이 다음 해 자유 행동에 닿으면 false
 */
function playUntil(state: GameState, eventId: string): boolean {
  const age = state.ch.age;
  for (let guard = 0; guard < 500 && state.phase !== 'dead'; guard++) {
    if (state.phase === 'event' && state.card?.eventId === eventId && !state.card.result) return true;
    if (state.phase === 'action') {
      if (state.ch.age > age) return false;
      endTurn(state);
      continue;
    }
    if (state.card && state.card.choices.length > 0 && !state.card.result) choose(state, 0);
    else proceed(state);
  }
  return false;
}

/** 효과 묶음 전부 (사건 효과, 선택지, 판정 성공·실패) */
function effectsOf(ev: EventDef): { where: string; fx: Effects }[] {
  const out: { where: string; fx: Effects }[] = [];
  if (ev.effects) out.push({ where: ev.id, fx: ev.effects });
  (ev.choices ?? []).forEach((c, i) => {
    if (c.effects) out.push({ where: `${ev.id}#${i}`, fx: c.effects });
    if (c.onSuccess?.effects) out.push({ where: `${ev.id}#${i}성공`, fx: c.onSuccess.effects });
    if (c.onFail?.effects) out.push({ where: `${ev.id}#${i}실패`, fx: c.onFail.effects });
  });
  return out;
}

function hasStep(fx: Effects | undefined, tag: string, act: TreatAct): boolean {
  return (fx?.treat ?? []).some((t) => t.tag === tag && t.act === act);
}

const catalogTags = (json: unknown): TagDef[] => (json as { tags: TagDef[] }).tags;
const MEDICAL_TAGS = catalogTags(medicalJson);
const NUTRITION_TAGS = catalogTags(nutritionJson);

// ── R-015 치료 에피소드 ───────────────────────────────────

/** 영양·의료 목록의 기간 태그 가운데 치료(치료 중 상태가 있고 이어 가거나 그만둘 수 있는 것) */
const TREATMENTS = ['nut_glp1', 'nut_ed_recovery', 'med_tb'];
/** 나머지 기간 태그와 치료로 다루지 않는 이유 */
const NOT_TREATMENT: Record<string, string> = {
  nut_salty: '식습관',
  nut_sweet_tooth: '식습관',
  nut_caffeine: '섭취 습관·의존 (치료가 아님)',
  nut_dieting: '스스로 하는 식단 (처방 치료가 아님)',
  nut_anemia: '몸 상태',
  nut_vitd_low: '몸 상태',
  nut_bone_thin: '몸 상태',
  nut_blood_sugar: '몸 상태',
  nut_uric_high: '몸 상태',
  nut_malnourished: '몸 상태',
  nut_pill_collector: '영양제 구매 습관 (복용 중인 치료 상태가 아니다)',
  nut_allergy_milk: '몸 상태',
  nut_ed: '질환 상태 (치료는 nut_ed_recovery)',
  nut_cook: '생활 습관',
  nut_ed_recovery_stopped: '치료 중단 후 태그',
  nut_glp1_stopped: '치료 중단 후 태그',
  med_thyroid_ca: '산정특례 등록 기간 (제도 자격. 추적 검사는 만성 관리 카드)',
  med_flu_shot: '그해 예방접종 기록 (해마다 다시 맞는 사건)',
  med_tb_stopped: '치료 중단 후 태그',
};

describe('치료 에피소드: 시작·유지·감량·중단·재개 (R-015)', () => {
  it('영양·의료 목록의 기간 태그는 모두 치료/비치료로 분류되고, 치료 태그에는 중단 후 태그가 있다', () => {
    const durationTags = [...MEDICAL_TAGS, ...NUTRITION_TAGS].filter((t) => t.duration !== undefined).map((t) => t.id);
    expect(durationTags.sort()).toEqual([...TREATMENTS, ...Object.keys(NOT_TREATMENT)].sort());
    const withStopped = [...MEDICAL_TAGS, ...NUTRITION_TAGS].filter((t) => t.stopped).map((t) => t.id);
    expect(withStopped.sort()).toEqual([...TREATMENTS].sort());
    for (const id of TREATMENTS) {
      const tag = TAG_BY_ID.get(id)!;
      expect(TAG_BY_ID.has(tag.stopped!), `${id}의 중단 후 태그`).toBe(true);
      expect(TAG_BY_ID.get(tag.stopped!)!.duration, `${tag.stopped}는 기간이 있다`).toBeGreaterThan(0);
    }
  });

  it('치료 태그는 어디서도 add/remove로 다루지 않고, 시작·중단 경로가 있다', () => {
    const treatmentIds = new Set(TREATMENTS.flatMap((id) => [id, TAG_BY_ID.get(id)!.stopped!]));
    const acts = new Map<string, Set<TreatAct>>();
    for (const ev of EVENTS) {
      for (const { where, fx } of effectsOf(ev)) {
        for (const f of [...(fx.addFlags ?? []), ...(fx.removeFlags ?? [])]) {
          expect(treatmentIds.has(f), `${where}: ${f}는 treat로 다뤄야 한다`).toBe(false);
        }
        for (const step of fx.treat ?? []) {
          expect(TAG_BY_ID.get(step.tag)?.stopped, `${where}: ${step.tag}는 치료 태그여야 한다`).toBeTruthy();
          if (!acts.has(step.tag)) acts.set(step.tag, new Set());
          acts.get(step.tag)!.add(step.act);
        }
      }
    }
    for (const id of TREATMENTS) {
      expect(acts.get(id)?.has('start'), `${id} 시작`).toBe(true);
      expect(acts.get(id)?.has('stop'), `${id} 중단`).toBe(true);
    }
    // 비만 치료 주사는 다섯 단계를 모두 쓴다
    expect([...acts.get('nut_glp1')!].sort()).toEqual(['continue', 'reduce', 'resume', 'start', 'stop']);
  });

  it('그만두기로 한 선택지는 판정의 성공·실패 양쪽에서 치료를 끝낸다', () => {
    let checked = 0;
    for (const ev of EVENTS) {
      for (const c of ev.choices ?? []) {
        if (!c.check) continue;
        for (const step of c.onSuccess?.effects?.treat ?? []) {
          if (step.act !== 'stop') continue;
          checked++;
          expect(hasStep(c.onFail?.effects, step.tag, 'stop'), `${ev.id} '${c.text}': 실패해도 ${step.tag} 중단`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
    // 비만 치료 주사를 끊는 판정: 성공·실패 효과를 각각 적용해 본다
    const stop = choiceByText(getEvent('nut_follow_glp1_year'), '끊고 식단과 운동으로 버틴다');
    for (const out of [stop.onSuccess!, stop.onFail!]) {
      const s = personAt('CARE-GLP1-BRANCH', 31);
      s.ch.flags.nut_glp1 = { since: 30, until: 31 };
      applyEffects(s, out.effects, { ctx: {}, rng: rngFor('t', 1), changes: [] });
      expect(s.ch.flags.nut_glp1).toBeUndefined();
      expect(s.ch.flags.nut_glp1_stopped).toEqual({ since: 31, until: 33 });
      expect(s.scheduled.map((x) => x.eventId)).toEqual(['nut_follow_glp1_after']);
    }
  });

  it('nut_diet_glp1 → nut_follow_glp1_year: 같은 상태에서 유지·감량·중단으로 갈라지면 저장·재개 뒤에도 다르다', () => {
    const s = personAt('CARE-GLP1', 30);
    play(s, 'nut_diet_glp1', '처방받아 시작한다');
    expect(s.ch.flags.nut_glp1).toEqual({ since: 30, until: 31 });
    expect(s.scheduled).toEqual([{ eventId: 'nut_follow_glp1_year', atAge: 31, ctx: {} }]);
    const base = roundtrip(s);
    base.scheduled = [];
    ageBy(base, 1);

    const branch = (choiceText: string) => {
      const b = roundtrip(base);
      const cash = b.ch.res.cash;
      const card = play(b, 'nut_follow_glp1_year', choiceText);
      return { state: roundtrip(b), spent: cash - b.ch.res.cash, card };
    };
    const keep = branch('계속 맞는다');
    const taper = branch('의사와 상의해 천천히 줄여 간다');
    const stop = branch('끊고 식단과 운동으로 버틴다');

    // 유지: 기한을 지금부터 다시 잡는다 (31세 + 1 = 32세 연말까지), 다음 재진 예약
    expect(keep.state.ch.flags.nut_glp1).toEqual({ since: 30, until: 32 });
    expect(keep.state.ch.flags.nut_glp1_stopped).toBeUndefined();
    expect(keep.state.scheduled).toEqual([{ eventId: 'nut_follow_glp1_keep', atAge: 32, ctx: {} }]);
    expect(keep.spent).toBe(4_000_000);
    expect(keep.card.result!.changes.map((c) => c.text)).toContain('비만 치료 주사 유지 (32세까지)');
    // 감량: 올해 연말까지만 (until 31), 끊은 뒤의 경과를 예약
    expect(taper.state.ch.flags.nut_glp1).toEqual({ since: 30, until: 31 });
    expect(taper.state.scheduled).toEqual([{ eventId: 'nut_follow_glp1_after', atAge: 32, ctx: {} }]);
    // 중단: 성공·실패와 상관없이 치료 중 태그가 사라지고 '중단 후' 태그가 남는다
    expect(stop.state.ch.flags.nut_glp1).toBeUndefined();
    expect(stop.state.ch.flags.nut_glp1_stopped).toEqual({ since: 31, until: 33 });
    expect(stop.state.scheduled).toEqual([{ eventId: 'nut_follow_glp1_after', atAge: 32, ctx: {} }]);
    expect(JSON.stringify(stop.state.ch.flags)).not.toBe(JSON.stringify(keep.state.ch.flags));

    // 치료 중에만 오는 사건은 그만둔 쪽에서 빠진다
    for (const id of ['nut_diet_glp1_muscle', 'nut_follow_glp1_year', 'nut_follow_glp1_keep']) {
      const ev = getEvent(id);
      expect(triggerOk(ev, buildScope(keep.state), keep.state), `유지: ${id}`).toBe(true);
      expect(triggerOk(ev, buildScope(stop.state), stop.state), `중단: ${id}`).toBe(false);
    }
    const after = getEvent('nut_follow_glp1_after');
    expect(triggerOk(after, buildScope(stop.state), stop.state)).toBe(true);
    expect(triggerOk(after, buildScope(keep.state), keep.state)).toBe(false);
  });

  it('연말 기한 경계: 유지하면 다음 재진까지 남고, 이어 가지 않으면 끝난 해의 결산에서 중단으로 바뀐다', () => {
    const s = personAt('CARE-GLP1-YEARS', 30);
    play(s, 'nut_diet_glp1', '처방받아 시작한다');
    expect(s.phase).toBe('action');

    // 30세 연말 결산: until 31이라 남는다. 31세 연초에 재진 카드가 뜬다
    expect(playUntil(s, 'nut_follow_glp1_year')).toBe(true);
    expect(s.ch.age).toBe(31);
    expect(s.ch.flags.nut_glp1).toEqual({ since: 30, until: 31 });
    let t = roundtrip(s);
    pick(t, '계속 맞는다');
    expect(t.ch.flags.nut_glp1).toEqual({ since: 30, until: 32 });

    // 31세 결산을 넘겨도 남고 (until 32), 32세 연초에 다음 재진이 뜬다
    t = roundtrip(t);
    expect(playUntil(t, 'nut_follow_glp1_keep')).toBe(true);
    expect(t.ch.age).toBe(32);
    expect(t.ch.flags.nut_glp1).toEqual({ since: 30, until: 32 });
    pick(t, '끊고 식단과 운동으로 버틴다');
    expect(t.ch.flags.nut_glp1).toBeUndefined();
    expect(t.ch.flags.nut_glp1_stopped).toEqual({ since: 32, until: 34 });

    // 그만둔 뒤의 경과 카드 (중단 후 태그가 원인): 다시 시작하면 새 에피소드
    t = roundtrip(t);
    expect(playUntil(t, 'nut_follow_glp1_after')).toBe(true);
    expect(t.ch.age).toBe(33);
    const card = pick(t, '다시 처방받는다');
    expect(card.result!.changes.map((c) => c.text)).toContain('비만 치료 주사 다시 시작');
    expect(t.ch.flags.nut_glp1).toEqual({ since: 33, until: 34 });
    expect(t.ch.flags.nut_glp1_stopped).toBeUndefined();
    expect(t.scheduled.map((x) => [x.eventId, x.atAge])).toEqual([['nut_follow_glp1_keep', 34]]);

    // 재진을 놓치면 (예: 예약이 사라진 옛 저장): 34세 한 해는 아직 치료 중이고, 34세 결산에서 끝나 '중단 후'로 남는다
    t = roundtrip(t);
    t.scheduled = [];
    expect(playUntil(t, 'none')).toBe(false);
    expect(t.ch.age).toBe(34);
    expect(t.ch.flags.nut_glp1).toEqual({ since: 33, until: 34 });
    t = roundtrip(t);
    expect(playUntil(t, 'none')).toBe(false);
    expect(t.ch.age).toBe(35);
    expect(t.ch.flags.nut_glp1).toBeUndefined();
    expect(t.ch.flags.nut_glp1_stopped).toEqual({ since: 34, until: 36 });
  });

  it('연말 정리: 계속 치료는 기한이 지나면 중단, 정해진 기간의 치료는 그냥 마친다', () => {
    const s = personAt('CARE-EXPIRE', 40);
    s.ch.flags.nut_glp1 = { since: 39, until: 41 };
    s.ch.flags.med_tb = { since: 39, until: 40 };
    s.ch.flags.nut_glp1_stopped = { since: 37, until: 40 }; // 예전 중단 기록은 같은 결산에서 끝난다
    expireFlags(s);
    expect(s.ch.flags.nut_glp1).toEqual({ since: 39, until: 41 });
    expect(s.ch.flags.med_tb).toBeUndefined();
    expect(s.ch.flags.med_tb_stopped).toBeUndefined();
    expect(s.ch.flags.nut_glp1_stopped).toBeUndefined();
    ageBy(s, 1);
    expireFlags(s);
    expect(s.ch.flags.nut_glp1).toBeUndefined();
    expect(s.ch.flags.nut_glp1_stopped).toEqual({ since: 41, until: 43 });
  });

  it('감량: 그해 사건까지는 치료 중이고, 연말 결산 뒤 끊은 뒤의 경과로 이어진다', () => {
    const s = personAt('CARE-GLP1-TAPER', 30);
    play(s, 'nut_diet_glp1', '처방받아 시작한다');
    expect(playUntil(s, 'nut_follow_glp1_year')).toBe(true);
    pick(s, '의사와 상의해 천천히 줄여 간다');
    expect(s.ch.flags.nut_glp1).toEqual({ since: 30, until: 31 });
    expect(triggerOk(getEvent('nut_diet_glp1_muscle'), buildScope(s), s)).toBe(true);
    const t = roundtrip(s);
    expect(playUntil(t, 'nut_follow_glp1_after')).toBe(true);
    expect(t.ch.age).toBe(32);
    expect(t.ch.flags.nut_glp1).toBeUndefined();
    expect(t.ch.flags.nut_glp1_stopped).toEqual({ since: 31, until: 33 });
  });

  it('섭식장애 치료: 그만두면 치료 중 카드가 빠지고, 다시 도움을 청하면 중단 기록을 지우고 이어 간다', () => {
    const s = personAt('CARE-ED', 16);
    play(s, 'nut_mind_restriction', '믿을 만한 어른이나 상담 선생님에게 털어놓는다');
    expect(s.ch.flags.nut_ed_recovery).toEqual({ since: 16, until: 19 });
    ageBy(s, 1);
    // 흔들리는 날에 치료진에게 연락하면 지금부터 다시 3년
    play(s, 'nut_mind_wobble', '치료진에게 연락한다');
    expect(s.ch.flags.nut_ed_recovery).toEqual({ since: 16, until: 20 });

    // 치료를 그만두는 선택: 판정 성공·실패 모두 치료 중 태그가 사라진다
    const quit = choiceByText(getEvent('nut_mind_meal_plan'), '이제 혼자 할 수 있다며 치료를 그만둔다');
    for (const [out, relapse] of [
      [quit.onSuccess!, false],
      [quit.onFail!, true],
    ] as const) {
      const b = roundtrip(s);
      applyEffects(b, out.effects, { ctx: {}, rng: rngFor('t', 2), changes: [] });
      const after = roundtrip(b);
      expect(after.ch.flags.nut_ed_recovery).toBeUndefined();
      expect(after.ch.flags.nut_ed_recovery_stopped).toEqual({ since: 17, until: 20 });
      expect(Boolean(after.ch.flags.nut_ed)).toBe(relapse);
      for (const id of ['nut_mind_meal_plan', 'nut_mind_wobble', 'nut_mind_recovered']) {
        expect(triggerOk(getEvent(id), buildScope(after), after), id).toBe(false);
      }
      if (relapse) {
        // 다시 도움을 청하는 길: 가족이 눈치채고 병원에 같이 간다
        ageBy(after, 1);
        const card = play(after, 'nut_mind_family_notice', '같이 병원에 가 보자는 말에 고개를 끄덕인다');
        expect(card.result!.changes.map((c) => c.text)).toContain('섭식장애 치료 다시 시작');
        expect(after.ch.flags.nut_ed).toBeUndefined();
        expect(after.ch.flags.nut_ed_recovery_stopped).toBeUndefined();
        expect(after.ch.flags.nut_ed_recovery).toEqual({ since: 18, until: 21 });
      }
    }
  });

  it('결핵: 약을 일찍 끊으면 치료 중이 아니라 중단으로 남고, 내성 결핵에서 다시 시작한다', () => {
    const s = personAt('CARE-TB', 40);
    const stopped = play(s, 'med_tb_dx', '좋아지자 약을 끊는다');
    expect(stopped.result!.changes.map((c) => c.text)).toContain('결핵 치료 중단');
    expect(s.ch.flags.med_tb).toBeUndefined();
    expect(s.ch.flags.med_tb_stopped).toEqual({ since: 40, until: 42 });
    expect(s.scheduled.map((x) => x.eventId)).toEqual(['med_tb_worse']);
    const t = roundtrip(s);
    t.scheduled = [];
    ageBy(t, 1);
    play(t, 'med_tb_worse', '보건소 복약 관리를 받는다');
    expect(t.ch.flags.med_tb).toEqual({ since: 41, until: 42 });
    expect(t.ch.flags.med_tb_stopped).toBeUndefined();

    // 끝까지 먹으면 치료 중으로 시작하고, 기한이 지나면 중단 기록 없이 끝난다
    const done = personAt('CARE-TB-DONE', 40);
    play(done, 'med_tb_dx', '여섯 달 동안 약을 빠짐없이 먹는다');
    expect(done.ch.flags.med_tb).toEqual({ since: 40, until: 41 });
    ageBy(done, 1);
    expireFlags(done);
    expect(done.ch.flags.med_tb).toBeUndefined();
    expect(done.ch.flags.med_tb_stopped).toBeUndefined();
  });

  it('옛 저장: 새 필드가 없어도 불러오고, 예약된 재진과 섭식장애 치료를 이어 갈 수 있다', () => {
    // 예전 처리로 만든 상태: 중단했는데도 치료 중 태그가 남아 있고, 회복 중과 섭식장애가 겹쳐 있다
    const s = personAt('CARE-OLD', 31);
    s.ch.flags.nut_glp1 = { since: 30, until: 31 };
    s.ch.flags.nut_ed = { since: 25, until: 31 };
    s.ch.flags.nut_ed_recovery = { since: 28, until: 31 };
    s.scheduled = [{ eventId: 'nut_follow_glp1_year', atAge: 31, ctx: {} }];
    const raw = JSON.parse(JSON.stringify(s));
    const storage = memoryStorage();
    storage.setItem('lifesim.save.v1', JSON.stringify(raw));
    const old = loadGame(storage)!;
    expect(old).not.toBeNull();
    play(old, 'nut_follow_glp1_year', '계속 맞는다');
    expect(old.ch.flags.nut_glp1).toEqual({ since: 30, until: 32 });
    play(old, 'nut_mind_secret', '치료를 받겠다고 마음먹는다');
    expect(old.ch.flags.nut_ed).toBeUndefined();
    expect(old.ch.flags.nut_ed_recovery).toEqual({ since: 28, until: 34 });
  });

  it('치료 단계는 치료 태그에만 쓸 수 있다', () => {
    const s = personAt('CARE-BAD', 30);
    expect(() => applyTreatment(s, { tag: 'nut_salty', act: 'stop' }, [])).toThrow();
  });
});

// ── R-016 미성년자의 지출 ─────────────────────────────────

describe('지출: 실제로 낸 내 현금과 보호자·빚으로 넘어간 몫 (R-016)', () => {
  const CASES: { age: number; cash: number; text: string; paid: number; debt: number; guardian: number }[] = [
    { age: 16, cash: 0, text: '보호자 부담 2,000원', paid: 0, debt: 0, guardian: 2000 },
    { age: 16, cash: 1000, text: '현금 −1,000원 (보호자 부담 1,000원)', paid: 1000, debt: 0, guardian: 1000 },
    { age: 16, cash: 5000, text: '현금 −2,000원', paid: 2000, debt: 0, guardian: 0 },
    { age: 18, cash: 0, text: '보호자 부담 2,000원', paid: 0, debt: 0, guardian: 2000 },
    { age: 18, cash: 1000, text: '현금 −1,000원 (보호자 부담 1,000원)', paid: 1000, debt: 0, guardian: 1000 },
    { age: 18, cash: 5000, text: '현금 −2,000원', paid: 2000, debt: 0, guardian: 0 },
    { age: 19, cash: 0, text: '빚 +2,000원', paid: 0, debt: 2000, guardian: 0 },
    { age: 19, cash: 1000, text: '현금 −1,000원 (빚 +1,000원)', paid: 1000, debt: 1000, guardian: 0 },
    { age: 19, cash: 5000, text: '현금 −2,000원', paid: 2000, debt: 0, guardian: 0 },
  ];

  it('컵라면 한 개(2,000원): 잔액 0·부족·충분, 18·19세에서 표시와 실제 변화가 맞는다', () => {
    for (const c of CASES) {
      const s = personAt(`CARE-PAY-${c.age}-${c.cash}`, c.age, c.cash);
      const card = play(s, 'nut_food_cup_ramyeon_store', '국물까지 후루룩 다 마신다');
      const where = `${c.age}세 현금 ${c.cash}`;
      expect(card.result!.changes.filter((x) => /현금|빚|보호자/.test(x.text)).map((x) => x.text), where).toEqual([c.text]);
      expect(c.cash - s.ch.res.cash, where).toBe(c.paid);
      expect(s.ch.res.debt, where).toBe(c.debt);
      // 청구액 = 내 현금 + 새 빚 + 보호자 부담
      expect(c.paid + c.debt + c.guardian, where).toBe(2000);
    }
  });

  it('지급 내역은 청구액과 실제 잔액 변화로 맞아떨어진다', () => {
    for (const age of [10, 18, 19, 40]) {
      for (const cash of [0, 1, 2999, 3000, 3001, 1_000_000]) {
        const s = personAt('CARE-LEDGER', age, cash);
        s.ch.res.debt = 500;
        const p = pay(s, 3000);
        expect(p.total).toBe(3000);
        expect(p.cash + p.debt + p.guardian).toBe(3000);
        expect(cash - s.ch.res.cash).toBe(p.cash);
        expect(s.ch.res.debt - 500).toBe(p.debt);
        if (age < 19) expect(p.debt).toBe(0);
        else expect(p.guardian).toBe(0);
        expect(s.ch.res.cash).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('물가를 곱하지 않는 금액(money.cash)도 같은 규칙으로 나뉜다', () => {
    const s = personAt('CARE-PAY-RAW', 17, 4000);
    const changes: Change[] = [];
    applyEffects(s, { money: { cash: -10_000 } }, { ctx: {}, rng: rngFor('t', 3), changes });
    expect(changes.map((x) => x.text)).toEqual(['현금 −4,000원 (보호자 부담 6,000원)']);
    expect(s.ch.res.cash).toBe(0);
    expect(s.ch.res.debt).toBe(0);
    expect(paymentText({ total: 5000, cash: 0, debt: 0, guardian: 5000 })).toEqual({ text: '보호자 부담 5,000원', sign: 'info' });
  });
});

// ── R-017 만성 질환의 반복 관리 ───────────────────────────

const CARE_IDS = EVENTS.filter((e) => /^med_(care|slip)_/.test(e.id));

interface Chronic {
  tag: string;
  ok?: string;
}
const CHRONIC = (medicalJson as unknown as { chronic: Chronic[] }).chronic;

/** 효과가 주는 오래 남는 수치의 오름 (조건 없이) */
function lastingGains(fx: Effects | undefined): string[] {
  return Object.entries(fx?.stats ?? {})
    .filter(([k, v]) => (LASTING_STATS as readonly string[]).includes(k) && typeof v === 'number' && v > 0)
    .map(([k]) => k);
}

describe('만성 질환: 첫 진단은 한 번, 관리와 재발은 되풀이된다 (R-017)', () => {
  it('관리·재발 카드 69개는 평생 한 번이 아니라 쿨다운으로 다시 열린다. 첫 진단은 그대로 한 번이다', () => {
    expect(CARE_IDS.length).toBe(69);
    expect(CARE_IDS.filter((e) => e.id.startsWith('med_care_')).length).toBe(51);
    for (const ev of CARE_IDS) {
      expect(ev.limit?.oncePerLife, ev.id).toBeFalsy();
      expect(ev.limit?.cooldown, ev.id).toBe(ev.id.startsWith('med_care_') ? 2 : 3);
      // 6년짜리 묶음 쿨다운에 걸리지 않는다 (재발 뒤 재관리를 오래 막지 않게)
      expect(ev.group, ev.id).toBeUndefined();
    }
    for (const id of ['med_hypothyroid', 'med_htn_sx', 'med_tb']) expect(getEvent(id).limit, id).toEqual({ oncePerLife: true });
  });

  it('관리·재발 카드에서 오래 남는 수치의 오름은 관리 시작(상태 변화)에만 붙는다', () => {
    let gated = 0;
    for (const ev of CARE_IDS) {
      const key = ev.trigger!.flags![0];
      const chronic = CHRONIC.find((c) => c.tag === key || c.ok === key)!;
      for (const { where, fx } of effectsOf(ev)) {
        expect(lastingGains(fx), `${where}: 조건 없는 오름`).toEqual([]);
        if (!fx.transition) continue;
        gated++;
        expect(fx.transition.from, where).toBe(chronic.tag);
        expect(fx.removeFlags, where).toContain(chronic.tag);
        if (fx.transition.to) expect(fx.addFlags, where).toContain(fx.transition.to);
      }
    }
    expect(gated).toBeGreaterThan(40);
  });

  it('재발 → 재관리를 되풀이해도 오래 남는 수치가 늘지 않는다 (재발의 대가 ≥ 관리 보상)', () => {
    for (const c of CHRONIC.filter((x) => x.ok)) {
      const gains: Record<string, number> = {};
      for (const ev of CARE_IDS) {
        for (const { fx } of effectsOf(ev)) {
          if (fx.transition?.from !== c.tag) continue;
          for (const [k, v] of Object.entries(fx.transition.stats)) gains[k] = Math.max(gains[k] ?? 0, Number(v));
        }
      }
      // 관리 중이던 사람을 관리 안 됨으로 되돌리는 효과 (게임 전체)
      for (const ev of EVENTS) {
        for (const { where, fx } of effectsOf(ev)) {
          if (!fx.removeFlags?.includes(c.ok!) || !fx.addFlags?.includes(c.tag)) continue;
          for (const [k, gain] of Object.entries(gains)) {
            const loss = -Number(fx.stats?.[k as keyof typeof fx.stats] ?? 0);
            expect(loss, `${where}: ${k} 재발 대가 ${loss} < 관리 보상 ${gain}`).toBeGreaterThanOrEqual(gain);
          }
        }
      }
    }
  });

  it('진단 → 관리 → 재발 → 재관리를 두 번 되풀이하고, 사이사이 저장·재개해도 카드가 다시 열린다', () => {
    let s = personAt('CARE-THYROID', 40);
    s.ch.sex = 'F';
    s.ch.stats.health = 50;
    // 첫 진단: 증상 → 피검사 → 진단에서 약을 자꾸 빼먹는다 (관리 안 됨)
    play(s, 'med_hypothyroid', '내과에서 피검사를 받는다');
    expect(s.card?.eventId).toBe('med_hypothyroid_dx');
    pick(s, '약을 자꾸 빼먹는다');
    expect(Object.keys(s.ch.flags).filter((f) => f.startsWith('med_thyroid'))).toEqual(['med_thyroid']);
    expect(limitOk(getEvent('med_hypothyroid'), s)).toBe(false);

    const thyroidTags = (st: GameState) => Object.keys(st.ch.flags).filter((f) => f.startsWith('med_thyroid')).sort();
    const care = getEvent('med_care_thyroid_1');
    const slip = getEvent('med_slip_thyroid_1');
    for (let round = 1; round <= 3; round++) {
      // 관리: 관리 안 됨 → 관리 중, 건강 +2 (상태가 실제로 바뀔 때만)
      s = roundtrip(s);
      ageBy(s, 2);
      expect(triggerOk(care, buildScope(s), s), `${round}회차 관리 조건`).toBe(true);
      expect(limitOk(care, s), `${round}회차 관리 제한`).toBe(true);
      const h0 = s.ch.stats.health;
      const managed = play(s, 'med_care_thyroid_1', '용량을 조절해 아침 공복에 먹는다');
      expect(thyroidTags(s)).toEqual(['med_thyroid_ok']);
      expect(s.ch.stats.health - h0, `${round}회차 관리 보상`).toBe(2);
      expect(managed.result!.changes.map((c) => c.text)).toContain('건강 +2');
      // 관리 중이면 관리 카드는 오지 않는다
      expect(triggerOk(care, buildScope(s), s)).toBe(false);
      if (round === 3) break;

      // 관리 중의 고비: 다시 챙기면 상태도 건강도 그대로, 그냥 지내면 재발
      s = roundtrip(s);
      ageBy(s, 3);
      expect(limitOk(slip, s), `${round}회차 고비 제한`).toBe(true);
      const keepH = s.ch.stats.health;
      const kept = roundtrip(s);
      play(kept, 'med_slip_thyroid_1', '약 상자를 칫솔 옆에 둔다');
      expect(kept.ch.stats.health).toBe(keepH);
      expect(thyroidTags(kept)).toEqual(['med_thyroid_ok']);
      const h1 = s.ch.stats.health;
      play(s, 'med_slip_thyroid_1', '그냥 지낸다');
      expect(thyroidTags(s)).toEqual(['med_thyroid']);
      expect(s.ch.stats.health - h1, `${round}회차 재발 대가`).toBe(-2);
    }
    expect(s.counts.med_care_thyroid_1).toBe(3);
    expect(s.counts.med_slip_thyroid_1).toBe(2);
  });

  it('쿨다운: 관리를 미룬 뒤 2년, 재발한 뒤에도 묶음 쿨다운 없이 다시 생활 풀 후보가 된다', () => {
    const s = personAt('CARE-COOLDOWN', 40);
    s.ch.sex = 'F';
    s.ch.flags.med_thyroid = { since: 39 };
    const care = getEvent('med_care_thyroid_1');
    play(s, 'med_care_thyroid_1', '피곤한 건 원래 그렇다며 둔다');
    ageBy(s, 1);
    expect(limitOk(care, s)).toBe(false);
    ageBy(s, 1);
    expect(limitOk(care, s)).toBe(true);
    const weight = () => poolCandidates(s, 'medical').find((c) => c.ev.id === care.id)?.w ?? 0;
    const w0 = weight();
    expect(w0).toBeGreaterThan(0);
    // 그해 건강검진을 직접 받았으면 관리 카드가 두 배 잘 나온다
    s.ch.flags.checked_up = { since: s.ch.age, until: s.ch.age + 1 };
    expect(weight()).toBeCloseTo(w0 * 2);
    delete s.ch.flags.checked_up;

    // 관리 → 3년 뒤 재발 → 2년 뒤 다시 후보 (예전에는 같은 묶음 6년 + 평생 한 번에 막혔다)
    play(s, 'med_care_thyroid_1', '용량을 조절해 아침 공복에 먹는다');
    ageBy(s, 3);
    play(s, 'med_slip_thyroid_1', '그냥 지낸다');
    ageBy(s, 2);
    const t = roundtrip(s);
    expect(poolCandidates(t, 'medical').some((c) => c.ev.id === care.id)).toBe(true);
  });

  it('반복해도 건강을 쌓을 수 없다: 이미 관리 중이거나 상태가 그대로면 오름이 없다', () => {
    // 관리 중인데 진단 태그가 다시 붙은 경우 (다른 사건의 재진단): 관리 카드의 보상은 없다
    const s = personAt('CARE-FARM', 50);
    s.ch.stats.health = 50;
    s.ch.flags.med_htn = { since: 49 };
    s.ch.flags.med_htn_ok = { since: 45 };
    play(s, 'med_care_htn_1', '매일 같은 시간에 약을 먹는다');
    expect(s.ch.stats.health).toBe(50);
    expect(s.ch.flags.med_htn).toBeUndefined();
    expect(s.ch.flags.med_htn_ok).toBeDefined();

    // 관리 안 된 채로 관리 카드를 여러 번 만나 미루기만 하면 건강은 오르지 않는다
    const d = personAt('CARE-FARM-DM', 50);
    d.ch.stats.health = 50;
    d.ch.flags.med_dm = { since: 49 };
    for (let i = 0; i < 5; i++) {
      play(d, 'med_care_dm_2', '안과에 간다');
      expect(d.ch.stats.health).toBe(50);
      ageBy(d, 2);
    }
    expect(d.counts.med_care_dm_2).toBe(5);
  });
});
