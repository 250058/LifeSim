// 범죄 피해·목격·지원 사건 (Codex U-002)
//
// - 발생 → 대응 선택 → 기관 처리 → 오래 남는 상태 (같은 사건 번호로 이어진다)
// - 신고하지 않은 사건도 남고, 공소시효 안이면 몇 년 뒤에도 신고할 수 있다 (친고죄 고소기간·시효가 지나면 안 된다)
// - 지원 역할: 피해자(NPC)가 스스로 정하고, 그 사람이 떠나면 사건도 이유와 함께 닫힌다
// - 미성년자에게는 성범죄·성희롱 사건이 생기지 않는다 (데이터·처리 단계·실제 진행 모두)
// - 피해자는 피해 때문에 도덕성·평판을 잃지 않고, 회복은 지원·시간에 따라 언젠가 끝난다
// - 같은 시드·선택이면 같은 결과, 저장·불러오기를 사이에 둬도 같다. 옛 저장도 불러온다
//
// CRIME_RATES=1 npx vitest run tests/crime.test.ts 로 현실 모드 발생률 표를 함께 본다 (기본은 건너뛴다)

import { describe, expect, it } from 'vitest';
import { activityViews } from '../src/engine/activities';
import { jobOpenings, takeJob } from '../src/engine/career';
import { CATEGORY, CRIME_ACTS, PRESSING_ACTS, stepEventId, type SceneRow } from '../src/engine/catalog/crime';
import {
  canReport,
  CRIME_ADULT_AGE,
  CRIME_SCENES,
  crimeScope,
  findCase,
  readLedger,
  recoveryAt,
  sceneAllowed,
  type CrimeCase,
} from '../src/engine/crime';
import { EVENT_FILES, getEvent } from '../src/engine/data';
import { applyEffects } from '../src/engine/effects';
import { chooseOption, dismissCard, eventProbability, limitOk, presentCard, triggerOk } from '../src/engine/eventEngine';
import { applyForJob, buyHome, buyStocks, choose, doActivity, endTurn, homePrice, newGame, proceed, repayDebt } from '../src/engine/game';
import { addFriend } from '../src/engine/relations';
import { Rng, rngFor } from '../src/engine/rng';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import type { Action, ChoiceDef, Effects, EventDef } from '../src/engine/schema';
import { buildScope } from '../src/engine/scope';
import { refusalChoice, SCAM_REFUSE_RATE } from '../src/engine/sim';
import type { ActiveCard, GameState } from '../src/engine/types';
import { validateData } from '../src/engine/validate';
import crimeJson from '../data/catalog/crime.json';

const SCENE_EVENTS: EventDef[] = EVENT_FILES['catalog/crime.json'].filter((e) => e.type === 'random');
const STEP_EVENTS: EventDef[] = EVENT_FILES['catalog/crime.json'].filter((e) => e.type === 'chain');
const OUTCOMES = (crimeJson as unknown as { outcomes: Record<string, string[]> }).outcomes;

// ── 도구 ─────────────────────────────────────────────────

/** 나이를 바로 정한 시험용 인물 (현실 모드, 돈 넉넉히) */
function personAt(seed: string, age: number): GameState {
  const s = newGame({ seed, mode: 'reality', birthYear: 2000 });
  s.ch.age = age;
  s.year = 2000 + age;
  s.world.year = s.year;
  s.ch.res.cash = 50_000_000;
  if (age >= 19) s.ch.edu.status = 'graduated';
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

function crimeActs(fx: Effects | undefined): string[] {
  return (fx?.do ?? []).filter((a): a is Extract<Action, { type: 'crime' }> => a.type === 'crime' && a.op === 'respond').map((a) => a.act ?? '');
}

/** 선택지가 하는 대응 (판정이 있으면 성공·실패 양쪽) */
function choiceActs(c: ChoiceDef): string[] {
  return [...crimeActs(c.effects), ...crimeActs(c.onSuccess?.effects), ...crimeActs(c.onFail?.effects)];
}

/** 지금 카드에서 이 대응을 하는 선택지의 화면 번호 (없으면 -1) */
function shownIndex(state: GameState, act: string): number {
  const card = state.card!;
  const ev = getEvent(card.eventId);
  return card.choices.findIndex((c) => choiceActs(ev.choices![c.index]).includes(act));
}

/** 카드 하나를 고르고 넘긴다. 원하는 대응이 없으면 신고·대면이 아닌 첫 선택지 */
function answer(state: GameState, prefer: string[]): string | undefined {
  const card = state.card!;
  if (card.choices.length === 0 || card.result) return undefined;
  for (const act of prefer) {
    const i = shownIndex(state, act);
    if (i >= 0) {
      chooseOption(state, i);
      return act;
    }
  }
  const ev = getEvent(card.eventId);
  const i = card.choices.findIndex((c) => !choiceActs(ev.choices![c.index]).some((a) => (PRESSING_ACTS as readonly string[]).includes(a)));
  chooseOption(state, Math.max(0, i));
  return undefined;
}

/** 대기열을 비운다: 카드가 뜨면 고르고 넘긴다 */
function processQueue(state: GameState, prefer: string[]): void {
  for (let guard = 0; guard < 100; guard++) {
    if (state.card) {
      answer(state, prefer);
      dismissCard(state);
      continue;
    }
    const next = state.queue.shift();
    if (!next) break;
    presentCard(state, next);
  }
  state.phase = 'action';
}

/** 범죄 단계만 1년 진행한다 (다른 무작위 사건 없이 이 사건의 기관 처리만 본다) */
function crimeYear(state: GameState, prefer: string[] = []): void {
  state.ch.age += 1;
  state.year += 1;
  state.world.year = state.year;
  const due = state.scheduled.filter((x) => x.atAge <= state.ch.age && x.eventId.startsWith('crime_'));
  state.scheduled = state.scheduled.filter((x) => !due.includes(x));
  state.queue.push(...due.map((d) => ({ eventId: d.eventId, ctx: d.ctx })));
  processQueue(state, prefer);
}

/** 장면 카드를 바로 띄운다 */
function open(state: GameState, sceneId: string): CrimeCase {
  state.phase = 'event';
  expect(presentCard(state, { eventId: sceneId, ctx: {} })).toBe(true);
  const c = findCase(state.ch, state.card!.ctx.caseId);
  expect(c, `${sceneId}: 사건이 열려야 한다`).toBeDefined();
  return c!;
}

function respond(state: GameState, act: string): void {
  const i = shownIndex(state, act);
  expect(i, `${state.card!.eventId}: '${act}' 선택지가 있어야 한다`).toBeGreaterThanOrEqual(0);
  chooseOption(state, i);
  dismissCard(state);
  processQueue(state, []);
}

function scheduledFor(state: GameState, c: CrimeCase): string[] {
  return state.scheduled.filter((x) => x.ctx.caseId === c.id).map((x) => `${x.eventId}@${x.atAge}`);
}

/** 장면이 열릴 조건을 갖춘다 (직업·연인·친구·자녀·부모·이별) */
function prepare(state: GameState, scene: SceneRow): void {
  const ch = state.ch;
  const rng = rngFor('prepare', scene.id);
  if (scene.if?.includes('job.') && !ch.career.jobId) {
    const job = scene.if.match(/job\.id == '([a-z_]+)'/)?.[1] ?? 'sme_office';
    takeJob(state, job);
  }
  if (scene.if?.includes('!family.livesWithParents')) ch.family.livesWithParents = false;
  if (scene.if?.includes('rom_heartbroken')) ch.flags.rom_heartbroken = { since: ch.age, until: ch.age + 1 };
  if (scene.if?.includes('family.friends') || scene.victim === 'friend') {
    const f = addFriend(state, rng);
    f.birthYear = ch.birthYear;
  }
}

// ── 데이터 계약 ──────────────────────────────────────────

describe('범죄 사건 데이터', () => {
  it('검증 오류가 없다', () => {
    const errors = validateData().filter((i) => i.level === 'error');
    expect(errors).toEqual([]);
  });

  it('장면마다 범주·역할·근거·연간 확률이 있고, 생성된 사건과 1:1이다 (random_attack은 기존 사건을 그대로 쓴다)', () => {
    const ids = new Set(SCENE_EVENTS.map((e) => e.id));
    for (const s of CRIME_SCENES) {
      expect(CATEGORY[s.cat], s.id).toBeDefined();
      expect(s.src.length, `${s.id}: 근거`).toBeGreaterThan(5);
      expect(s.base > 0 && s.base < 0.05, `${s.id}: 연간 확률 ${s.base}`).toBe(true);
      if (s.external) {
        expect(ids.has(s.id)).toBe(false);
        expect(getEvent(s.id).effects?.do?.some((a) => a.type === 'crime' && a.op === 'open' && a.scene === s.id)).toBe(true);
      } else {
        expect(ids.has(s.id), s.id).toBe(true);
      }
    }
    expect(SCENE_EVENTS.length).toBe(CRIME_SCENES.filter((s) => !s.external).length);
    // 묻지마 범죄 카드를 새로 복제하지 않았다
    expect(CRIME_SCENES.filter((s) => s.cat === 'random_violence' && s.role === 'witness').map((s) => s.id)).toEqual(['random_attack']);
  });

  it('19개 범주가 모두 있고, 피해·목격·지원 역할이 함께 있다', () => {
    const cats = new Set(CRIME_SCENES.map((s) => s.cat));
    expect(cats.size).toBe(Object.keys(CATEGORY).length);
    const roles = new Set(CRIME_SCENES.map((s) => s.role));
    expect([...roles].sort()).toEqual(['supporter', 'victim', 'witness']);
  });

  it('신고·대면을 강요하지 않는다: 장면마다 조건 없이 고를 수 있는 다른 길이 둘 이상 있다', () => {
    const all = [...SCENE_EVENTS, getEvent('random_attack')];
    for (const ev of all) {
      const free = (ev.choices ?? []).filter((c) => !c.if && !choiceActs(c).some((a) => (PRESSING_ACTS as readonly string[]).includes(a)));
      expect(free.length, `${ev.id}`).toBeGreaterThanOrEqual(2);
    }
    // 다시 돌아보는 카드에도 미루기·내려놓기가 늘 있다
    const revisit = getEvent(stepEventId('revisit'));
    const always = revisit.choices!.filter((c) => !c.if).flatMap(choiceActs);
    expect(always).toEqual(expect.arrayContaining(['postpone', 'close']));
  });

  it('성범죄·성희롱 장면은 성인 전용이고, 미성년자에게 열리는 장면은 비성적 범죄의 허용된 역할뿐이다', () => {
    for (const s of CRIME_SCENES) {
      const rule = CATEGORY[s.cat];
      const ev = getEvent(s.id);
      if (rule.sexual) {
        expect(s.age[0], s.id).toBeGreaterThanOrEqual(CRIME_ADULT_AGE);
        if (!s.external) expect(ev.adult, s.id).toBe(true);
        // 지원 대상도 성인: 자녀는 성인 자녀만, 친구는 본인이 21세 이상일 때 (친구 나이 ±1)
        if (s.victim === 'child') expect(s.childAge![0], s.id).toBeGreaterThanOrEqual(CRIME_ADULT_AGE);
        if (s.victim === 'friend') expect(s.age[0], s.id).toBeGreaterThanOrEqual(21);
        expect(s.victim === 'sibling' || s.victim === 'parent', s.id).toBe(false);
      }
      if (s.age[0] < CRIME_ADULT_AGE) {
        expect(rule.sexual, s.id).toBe(false);
        expect(rule.minorRoles, s.id).toContain(s.role);
      }
    }
  });

  it('피해자·지원 장면의 선택지는 도덕성·평판을 깎지 않는다 (엔진도 깎지 않는다)', () => {
    const lowers = (fx: Effects | undefined) => {
      const st = fx?.stats ?? {};
      return (typeof st.morality === 'number' && st.morality < 0) || (typeof st.reputation === 'number' && st.reputation < 0);
    };
    for (const ev of [...SCENE_EVENTS, ...STEP_EVENTS]) {
      for (const c of ev.choices ?? []) {
        expect(lowers(c.effects) || lowers(c.onSuccess?.effects) || lowers(c.onFail?.effects), `${ev.id}: ${c.text}`).toBe(false);
      }
    }
  });

  it('엔진이 쓰는 결과 문장 키가 모두 있고, 자리표시자는 엔진이 채우는 것만 쓴다', () => {
    const required = [
      'help', 'help.alone', 'help.alone.minor', 'counsel', 'counsel.minor', 'record', 'report.filed', 'report.delayed',
      'report.expired', 'report.window', 'report.dead', 'report.not_crime', 'protect.granted.stalking', 'protect.denied.stalking',
      'protect.granted.domestic', 'protect.denied.domestic', 'protect.granted.safety', 'protect.denied.safety', 'transfer.ok',
      'transfer.refused', 'move', 'quit', 'postpone', 'confront.stopped', 'confront.nothing', 'confront.worse', 'block', 'block.banned',
      'takedown.removed', 'takedown.pending', 'pay', 'refuse', 'intervene', 'hurt', 'film', 'comfort', 'leave', 'depose', 'decline',
      'listen', 'accompany', 'advise', 'respect', 'object.ok', 'object.no', 'appeal.verdict', 'appeal.ok', 'appeal.no', 'testify',
      'statement', 'settle', 'absent', 'civil.filed', 'civil.unavailable', 'admin.filed.labor', 'admin.filed.nhrck',
      'admin.filed.commission', 'admin.unavailable', 'accept', 'close', 'violation', 'safety.ok', 'safety.no', 'wait',
      'internal.unavailable', 'internal.raised.work', 'internal.raised.school', 'internal.raised.univ', 'guardian.school',
      'guardian.police', 'repeat.again', 'repeat.violated', 'repeat.quiet', 'repeat.over', 'recheck.dead', 'police.delay',
      'police.no_suspect', 'police.still_unknown', 'police.referred', 'police.not_sent', 'prosecution.waived', 'prosecution.juvenile',
      'prosecution.indicted', 'prosecution.summary', 'prosecution.deferred', 'prosecution.dropped', 'trial.offer', 'trial.open',
      'verdict.dismissed', 'verdict.acquitted', 'verdict.appeal_lost', 'verdict.prison', 'verdict.suspended', 'verdict.fine',
      'internal.ended', 'internal.action.disciplined', 'internal.action.not_disciplined', 'internal.retaliation', 'internal.no_action',
      'admin.ordered.labor', 'admin.dismissed.labor', 'admin.ordered.nhrck', 'admin.dismissed.nhrck', 'admin.ordered.commission',
      'admin.dismissed.commission', 'civil.won', 'civil.unpaid', 'civil.settled', 'civil.lost', 'protect.ended', 'protect.violated',
      'protect.kept', 'revisit.calm', 'revisit.middle', 'revisit.heavy', 'revisit.others', 'revisit.expired', 'witness.call',
      'support.gone', 'support.lost', 'support.reported', 'support.not_reported', 'support.ongoing', 'support.care', 'support.raised',
      'recovered',
    ];
    for (const k of required) expect(OUTCOMES[k]?.length, k).toBeGreaterThan(0);
    const allowed = new Set(['상대', '지인', '혐의', '형기', '유예', '벌금', '이름', '보호자']);
    for (const [k, list] of Object.entries(OUTCOMES)) {
      for (const t of list) for (const m of t.matchAll(/\{([^{}]+)\}/g)) expect(allowed.has(m[1]), `${k}: {${m[1]}}`).toBe(true);
    }
  });

  it('crime.* 조건식 값: 빈 사건과 실제 사건의 키가 같다', () => {
    const s = personAt('SCOPE', 30);
    prepare(s, CRIME_SCENES.find((x) => x.id === 'crime_threat_online')!);
    const c = open(s, 'crime_threat_online');
    const blank = (crimeScope(personAt('BLANK', 30)) as { case: Record<string, unknown> }).case;
    const real = (crimeScope(s, { caseId: c.id }) as { case: Record<string, unknown> }).case;
    expect(Object.keys(real).sort()).toEqual(Object.keys(blank).sort());
    expect(real.exists).toBe(true);
    expect(blank.exists).toBe(false);
  });

  it('대응 id는 모두 엔진이 아는 것이다', () => {
    for (const ev of [...SCENE_EVENTS, ...STEP_EVENTS, getEvent('random_attack')]) {
      for (const c of ev.choices ?? []) for (const a of choiceActs(c)) expect(CRIME_ACTS as readonly string[], `${ev.id}`).toContain(a);
    }
  });
});

// ── 발생 → 대응 → 기관 → 장기 ───────────────────────────

describe('사건의 흐름', () => {
  it('스토킹: 신고 → 보호조치 → 수사·검찰·재판 단계 → 오래 남는 회복 (같은 사건 번호)', () => {
    const s = personAt('FLOW-STALK', 27);
    s.ch.flags.rom_heartbroken = { since: 27, until: 28 };
    const c = open(s, 'crime_stalking_ex');
    expect(c.cat).toBe('stalking');
    expect(c.report).toBe('none');
    respond(s, 'report');
    expect(c.report).toBe('immediate');
    expect(c.police).toBe('investigating');
    expect(['granted', 'denied']).toContain(c.protection);
    expect(scheduledFor(s, c)).toContain(`${stepEventId('police')}@28`);
    // 1년 뒤 수사 결과 (지연되면 한 해 더)
    crimeYear(s, ['testify', 'accept']);
    if (c.police === 'investigating') {
      expect(c.policeDelayed).toBe(true);
      crimeYear(s, ['testify', 'accept']);
    }
    expect(['referred', 'no_suspect', 'not_sent']).toContain(c.police);
    if (c.police === 'referred') expect(c.prosecution).not.toBe('none');
    for (let i = 0; i < 4; i++) crimeYear(s, ['testify', 'accept']);
    // 기관 단계는 한 사건 안에서 순서대로 쌓인다
    const steps = c.log.map((l) => l.step);
    expect(steps[0]).toBe('occurred');
    expect(steps.indexOf('report')).toBeLessThan(steps.indexOf('police'));
    if (c.prosecution === 'indicted') expect(['prison', 'suspended', 'fine', 'acquitted', 'dismissed', 'none']).toContain(c.verdict);
    // 평생 고정된 파국이 아니다: 시간이 지나면 회복한다
    expect(recoveryAt(c, c.age + 30)).toBeGreaterThanOrEqual(85);
    expect(new Set(readLedger(s.ch).cases.map((x) => x.id)).size).toBe(readLedger(s.ch).cases.length);
  });

  it('직장 내 성희롱: 형사·조직·행정·민사를 따로 판정한다', () => {
    const s = personAt('FLOW-SH', 30);
    s.ch.sex = 'F';
    takeJob(s, 'sme_office');
    const c = open(s, 'crime_sh_superior');
    // 말로 한 직장 성희롱은 형사 처벌 대상이 아니다 → 신고 대응은 없다
    const view = (crimeScope(s, { caseId: c.id }) as { case: Record<string, unknown> }).case;
    expect(view.criminal).toBe(false);
    expect(view.canReport).toBe(false);
    expect(view.canLabor).toBe(true);
    respond(s, 'internal');
    expect(c.internal).toBe('raised');
    crimeYear(s, ['labor']);
    expect(['action', 'no_action', 'retaliation']).toContain(c.internal);
    if (c.internal === 'action') expect(['disciplined', 'not_disciplined']).toContain(c.discipline);
    else {
      // 회사가 조치하지 않았거나 불리하게 대하면 고용노동부 진정을 따로 낼 수 있다
      expect(c.admin).toBe('filed');
      crimeYear(s, []);
      expect(['ordered', 'dismissed']).toContain(c.admin);
    }
    expect(c.report).toBe('none');
    expect(c.police).toBe('none');
    // 온라인으로 받은 성적 메시지는 통신매체이용음란으로 형사 절차가 있다
    const s2 = personAt('FLOW-SH-ONLINE', 30);
    const c2 = open(s2, 'crime_sh_online');
    expect((crimeScope(s2, { caseId: c2.id }) as { case: Record<string, unknown> }).case.canReport).toBe(true);
  });

  it('가해자(NPC)가 숨지면 형사 절차는 공소권 없음으로 끝난다', () => {
    const s = personAt('FLOW-DEAD', 40);
    const spouse = addFriend(s, rngFor('t', 'spouse'));
    spouse.role = 'spouse';
    spouse.birthYear = s.ch.birthYear;
    const c = open(s, 'crime_dv_spouse');
    expect(readLedger(s.ch).people.find((p) => p.id === c.offender)?.npcId).toBe(spouse.id);
    respond(s, 'report');
    spouse.alive = false;
    crimeYear(s, []);
    expect(c.prosecution).toBe('no_right');
    expect(c.log.some((l) => l.step === 'recheck')).toBe(true);
    expect(['ended', 'none', 'denied']).toContain(c.protection);
  });

  it('막 이혼한 전 배우자는 같은 NPC로 묶이고, 연락이 끊기면(관계 종료) 재발 위험이 줄어든다', () => {
    const s = personAt('FLOW-ENDED', 30);
    s.ch.flags.rom_heartbroken = { since: 30, until: 31 };
    s.ch.flags.divorced = { since: 30 };
    const ex = addFriend(s, rngFor('t', 'ex'));
    ex.role = 'ex';
    const c = open(s, 'crime_stalking_ex');
    expect(readLedger(s.ch).people.find((p) => p.id === c.offender)?.npcId).toBe(ex.id);
    const viewBefore = (crimeScope(s, { caseId: c.id }) as { case: Record<string, unknown> }).case;
    expect(viewBefore.relationEnded).toBe(false);
    s.ch.npcs = s.ch.npcs.filter((n) => n.id !== ex.id);
    const view = (crimeScope(s, { caseId: c.id }) as { case: Record<string, unknown> }).case;
    expect(view.relationEnded).toBe(true);
    // 연애가 끝난 경우(NPC가 남지 않는다)에는 예전 전 배우자를 가해자로 끌어오지 않는다
    const t = personAt('FLOW-ENDED-2', 30);
    t.ch.flags.divorced = { since: 22 };
    t.ch.flags.rom_heartbroken = { since: 30, until: 31 };
    addFriend(t, rngFor('t', 'ex2')).role = 'ex';
    const c2 = open(t, 'crime_stalking_ex');
    expect(readLedger(t.ch).people.find((p) => p.id === c2.offender)?.npcId).toBeUndefined();
  });
});

// ── 미신고와 지연 신고 ───────────────────────────────────

describe('신고하지 않은 사건과 지연 신고', () => {
  it('미루면 사건은 남고, 1~2년 뒤 다시 돌아볼 때 지연 신고를 할 수 있다', () => {
    const s = personAt('LATE-1', 25);
    s.ch.sex = 'F';
    const c = open(s, 'crime_sa_acquaintance');
    respond(s, 'postpone');
    expect(c.report).toBe('none');
    const revisit = scheduledFor(s, c).find((x) => x.startsWith(stepEventId('revisit')));
    expect(revisit).toBeDefined();
    let reported = false;
    for (let i = 0; i < 3 && !reported; i++) {
      crimeYear(s, ['report']);
      reported = c.report !== 'none';
    }
    expect(c.report).toBe('delayed');
    expect(c.reportAge! - c.age).toBeGreaterThanOrEqual(1);
    expect(c.police === 'investigating' || scheduledFor(s, c).some((x) => x.startsWith(stepEventId('police')))).toBe(true);
  });

  it('공소시효 안이면 몇 년 뒤에도 신고할 수 있고, 지나면 못 한다 (성폭력 10년, 과학적 증거가 있으면 20년)', () => {
    const s = personAt('LATE-2', 25);
    s.ch.sex = 'F';
    const c = open(s, 'crime_sa_acquaintance');
    respond(s, 'postpone');
    s.ch.age = 34;
    expect(canReport(s, c)).toBe(true);
    s.ch.age = 36;
    expect(canReport(s, c)).toBe(false);
    c.evidence = 2;
    expect(canReport(s, c)).toBe(true);
  });

  it('모욕 수준의 온라인 괴롭힘은 친고죄 고소기간(6개월)이 지나면 고소할 수 없다', () => {
    const s = personAt('LATE-3', 30);
    const c = open(s, 'crime_cyber_adult');
    respond(s, 'block');
    c.harm = 1;
    expect(canReport(s, c)).toBe(true);
    s.ch.age = 31;
    expect(canReport(s, c)).toBe(false);
    // 명예훼손 수준이면 공소시효(5년) 안에서 가능
    c.harm = 2;
    expect(canReport(s, c)).toBe(true);
  });

  it('신고하지 않아도 있었던 일과 회복 경과는 남는다', () => {
    const s = personAt('LATE-4', 30);
    const c = open(s, 'crime_assault_night');
    respond(s, 'avoid');
    for (let i = 0; i < 3; i++) crimeYear(s, ['close']);
    const again = findCase(s.ch, c.id)!;
    expect(again.report).toBe('none');
    expect(again.log[0].step).toBe('occurred');
    expect(recoveryAt(again, s.ch.age)).toBeGreaterThanOrEqual(again.rec.first);
  });
});

// ── 지원 역할 ────────────────────────────────────────────

describe('가족·친구를 돕는 역할', () => {
  it('피해자는 기존 NPC이고, 스스로 신고 여부를 정한다. 곁에 있어 주면 친밀도가 오른다', () => {
    const s = personAt('SUPPORT-1', 30);
    const f = addFriend(s, rngFor('t', 'f'));
    f.birthYear = s.ch.birthYear;
    const before = f.closeness;
    const c = open(s, 'crime_dating_support_friend');
    const victim = readLedger(s.ch).people.find((p) => p.id === c.victim)!;
    expect(victim.npcId).toBe(f.id);
    expect(c.role).toBe('supporter');
    respond(s, 'accompany');
    expect(f.closeness).toBeGreaterThan(before);
    expect(scheduledFor(s, c)).toContain(`${stepEventId('support')}@31`);
    crimeYear(s, ['listen']);
    expect(c.log.some((l) => l.note === '피해자가 신고' || l.note === '피해자가 신고하지 않기로 함')).toBe(true);
  });

  it('피해자와 연락이 끊기면 지원 사건은 이유를 남기고 닫힌다 (다른 친구로 바꾸지 않는다)', () => {
    const s = personAt('SUPPORT-2', 30);
    const f = addFriend(s, rngFor('t', 'f2'));
    f.birthYear = s.ch.birthYear;
    const other = addFriend(s, rngFor('t', 'f3'));
    other.birthYear = s.ch.birthYear;
    s.ch.npcs = s.ch.npcs.filter((n) => n.id !== other.id);
    s.ch.npcs.push(other);
    const c = open(s, 'crime_stalking_support_friend');
    const victimNpc = readLedger(s.ch).people.find((p) => p.id === c.victim)!.npcId;
    respond(s, 'listen');
    s.ch.npcs = s.ch.npcs.filter((n) => n.id !== victimNpc);
    crimeYear(s, []);
    expect(c.closed?.why).toBe('피해자와 연락이 끊김');
    expect(readLedger(s.ch).people.find((p) => p.id === c.victim)!.npcId).toBe(victimNpc);
  });

  it('성범죄 지원 대상은 성인뿐: 미성년 친구에게는 사건이 열리지 않는다', () => {
    const s = personAt('SUPPORT-3', 30);
    const f = addFriend(s, rngFor('t', 'f4'));
    f.birthYear = s.year - 17;
    s.phase = 'event';
    presentCard(s, { eventId: 'crime_sa_support_friend', ctx: { 친구: f.name, friendId: f.id } });
    expect(readLedger(s.ch).cases.length).toBe(0);
  });
});

// ── 미성년자 보호 ────────────────────────────────────────

describe('미성년자에게는 성범죄·성희롱 사건이 없다', () => {
  it('처리 단계에서도 막는다: 16세에게 성범죄 장면을 열어도 사건이 생기지 않는다', () => {
    for (const scene of CRIME_SCENES.filter((x) => CATEGORY[x.cat].sexual)) {
      expect(sceneAllowed(16, scene), scene.id).toBe(false);
      const s = personAt(`MINOR-${scene.id}`, 16);
      applyEffects(s, { do: [{ type: 'crime', op: 'open', scene: scene.id }] }, { ctx: {}, rng: new Rng('x'), changes: [] });
      expect(readLedger(s.ch).cases.length, scene.id).toBe(0);
      // 이벤트 자체도 미성년자에게는 조건이 맞지 않는다
      expect(triggerOk(getEvent(scene.id), buildScope(s), s), scene.id).toBe(false);
    }
  });

  it('실제 진행: 여러 모드의 인생을 18세까지 살아도 성범죄·성희롱 사건이 없고, 미성년 사건은 허용된 범주뿐이다', () => {
    const minorCats = new Set<string>();
    for (const mode of ['reality', 'drama', 'makjang'] as const) {
      for (let i = 0; i < 60; i++) {
        const s = newGame({ seed: `MINOR-RUN-${mode}-${i}`, mode, birthYear: 2026 });
        for (let guard = 0; guard < 5000 && s.phase !== 'dead' && s.ch.age < 19; guard++) {
          if (s.phase === 'action') endTurn(s);
          else if (s.card && s.card.choices.length > 0 && !s.card.result) choose(s, 0);
          else proceed(s);
        }
        for (const c of readLedger(s.ch).cases) {
          if (c.age < CRIME_ADULT_AGE) {
            minorCats.add(`${c.cat}/${c.role}`);
            expect(CATEGORY[c.cat].sexual, `${mode} ${c.scene}`).toBe(false);
            expect(CATEGORY[c.cat].minorRoles, c.scene).toContain(c.role);
          }
        }
      }
    }
    // 보호·신고 경로가 붙은 미성년 사건이 실제로 생긴다 (도달성)
    expect(minorCats.size).toBeGreaterThan(0);
  });

  it('미성년 피해자가 보호자에게 말하면 보호자가 학교나 경찰에 알릴 수 있다', () => {
    let guardianActed = false;
    for (let i = 0; i < 12 && !guardianActed; i++) {
      const s = personAt(`GUARD-${i}`, 14);
      s.ch.edu.status = 'middle';
      s.ch.family.livesWithParents = true;
      const c = open(s, 'crime_theft_school');
      respond(s, 'help');
      guardianActed = c.internal === 'raised' || c.report !== 'none';
    }
    expect(guardianActed).toBe(true);
  });
});

// ── 피해자의 도덕성·평판, 회복 ──────────────────────────

describe('피해는 도덕성·평판을 깎지 않고, 회복은 언젠가 끝난다', () => {
  it('모든 피해자 장면의 모든 선택지에서 도덕성·평판이 줄지 않는다', () => {
    const victimScenes = CRIME_SCENES.filter((x) => x.role === 'victim' && !x.external);
    const tried = new Set<string>();
    for (const scene of victimScenes) {
      const ev = getEvent(scene.id);
      for (let i = 0; i < (ev.choices ?? []).length; i++) {
        const s = personAt(`MORAL-${scene.id}-${i}`, Math.max(scene.age[0], 30) <= scene.age[1] ? Math.max(scene.age[0], 30) : scene.age[0]);
        s.ch.sex = 'F';
        prepare(s, scene);
        if (scene.if?.includes('family.married')) addFriend(s, rngFor('t', 'sp', i)).role = 'spouse';
        if (scene.if?.includes('partnerAdult')) {
          const m = addFriend(s, rngFor('t', 'pt', i));
          m.role = 'partner';
          m.birthYear = s.ch.birthYear;
        }
        if (scene.ctx === 'school' || scene.age[1] < 19) s.ch.edu.status = 'middle';
        if (scene.if?.includes("edu.status == 'university'")) s.ch.edu.status = 'university';
        const morality = s.ch.hidden.morality;
        const reputation = s.ch.state.reputation;
        s.phase = 'event';
        if (!presentCard(s, { eventId: scene.id, ctx: {} })) continue;
        const shown = s.card!.choices.findIndex((c) => c.index === i);
        if (shown < 0) continue;
        chooseOption(s, shown);
        tried.add(scene.id);
        expect(s.ch.hidden.morality, `${scene.id} #${i}`).toBeGreaterThanOrEqual(morality);
        expect(s.ch.state.reputation, `${scene.id} #${i}`).toBeGreaterThanOrEqual(reputation);
      }
    }
    // 조건을 갖춘 시험 인물에서 모든 피해자 장면이 실제로 열렸다
    expect(victimScenes.filter((x) => !tried.has(x.id)).map((x) => x.id)).toEqual([]);
  });

  it('어떤 피해자 장면도 30년 안에 회복 기준(85)에 닿는다 (지원이 없어도 해마다 3 이상 오른다)', () => {
    let checked = 0;
    const victimScenes = CRIME_SCENES.filter((x) => x.role === 'victim' && !x.external);
    for (const scene of victimScenes) {
      const s = personAt(`REC-${scene.id}`, Math.min(Math.max(scene.age[0], 30), scene.age[1]));
      prepare(s, scene);
      if (scene.if?.includes('family.married')) addFriend(s, rngFor('t', 'sp')).role = 'spouse';
      if (scene.if?.includes('partnerAdult')) {
        const m = addFriend(s, rngFor('t', 'pt'));
        m.role = 'partner';
        m.birthYear = s.ch.birthYear;
      }
      if (scene.ctx === 'school' || scene.age[1] < 19) s.ch.edu.status = 'middle';
      if (scene.if?.includes("edu.status == 'university'")) s.ch.edu.status = 'university';
      s.phase = 'event';
      if (!presentCard(s, { eventId: scene.id, ctx: {} })) continue;
      const c = findCase(s.ch, s.card!.ctx.caseId);
      if (!c) continue;
      expect(c.rec.rate, scene.id).toBeGreaterThanOrEqual(3);
      expect(recoveryAt(c, c.age + 30), scene.id).toBeGreaterThanOrEqual(85);
      checked++;
    }
    expect(checked).toBe(victimScenes.length);
  });

  it('무거운 피해는 회복 중 태그가 붙고, 회복하면 사라진다', () => {
    const s = personAt('AFTER-1', 25);
    s.ch.sex = 'F';
    const c = open(s, 'crime_sa_acquaintance');
    respond(s, 'counsel');
    expect(c.care).toBe('active');
    expect(s.ch.flags.crime_aftermath).toBeDefined();
    const until = s.ch.flags.crime_aftermath!.until!;
    for (let age = s.ch.age; age < until + 1; age++) {
      crimeYear(s, ['postpone']);
      for (const [id, f] of Object.entries(s.ch.flags)) if (f.until !== undefined && s.ch.age >= f.until) delete s.ch.flags[id];
    }
    expect(s.ch.flags.crime_aftermath).toBeUndefined();
    expect(c.recovered).toBeDefined();
  });
});

// ── 재현성과 저장 ────────────────────────────────────────

/** sim.ts와 같은 봇으로 n년 동안 산다 (범죄 단계 포함 실제 게임 루프) */
function live(state: GameState, years: number): void {
  const bot = new Rng(`bot|${state.seed}`);
  const endAge = state.ch.age + years;
  let lastAge = -1;
  for (let guard = 0; guard < 20_000 && state.phase !== 'dead' && state.ch.age < endAge; guard++) {
    if (state.phase === 'action') {
      if (state.ch.age !== lastAge) {
        lastAge = state.ch.age;
        const ch = state.ch;
        if (ch.age >= 19 && !ch.career.jobId && ch.edu.status !== 'university' && ch.military.status !== 'serving') {
          const best = jobOpenings(state).sort((a, b) => b.chance - a.chance)[0];
          if (best) applyForJob(state, best.job.id);
        }
        if (ch.res.debt > 0 && ch.res.cash > 0 && bot.chance(0.7)) repayDebt(state);
        if (ch.age >= 30 && ch.age <= 55 && !ch.flags.homeowner && ch.res.cash > homePrice(state) * 0.4 && bot.chance(0.3)) buyHome(state);
        if (ch.age >= 25 && ch.res.cash > 50_000_000 && bot.chance(0.15)) buyStocks(state, 0.3);
        const views = activityViews(state).filter((v) => v.enabled && v.def.group !== 'risk');
        if (views.length > 0 && state.points.left > 0) doActivity(state, bot.pick(views).def.id);
        if (state.phase !== 'action') continue;
      }
      endTurn(state);
    } else if (state.phase === 'event') {
      const card = state.card!;
      if (card.choices.length > 0 && !card.result) {
        const refuse = refusalChoice(card);
        choose(state, refuse !== undefined && bot.chance(SCAM_REFUSE_RATE) ? refuse : bot.chance(0.4) ? 0 : bot.int(0, card.choices.length - 1));
      } else proceed(state);
    }
  }
}

/** 범죄 사건이 생기기 쉬운 출발점: 드라마 모드의 30세 직장인 */
function crimeHeavyStart(seed: string): GameState {
  const s = newGame({ seed, mode: 'makjang', birthYear: 1996 });
  s.ch.age = 30;
  s.year = 2026;
  s.world.year = 2026;
  s.ch.edu.status = 'graduated';
  s.ch.res.cash = 30_000_000;
  takeJob(s, 'nurse');
  return s;
}

describe('같은 시드·선택이면 같은 사건, 저장·불러오기를 사이에 둬도 같다', () => {
  it('같은 시드로 두 번 살면 사건 기록이 같다', () => {
    const a = crimeHeavyStart('DET-1');
    const b = crimeHeavyStart('DET-1');
    live(a, 25);
    live(b, 25);
    expect(readLedger(a.ch).cases.length).toBeGreaterThan(0);
    expect(JSON.stringify(a.ch.crime)).toBe(JSON.stringify(b.ch.crime));
    expect(JSON.stringify(a.scheduled)).toBe(JSON.stringify(b.scheduled));
  });

  it('사건 도중 저장·불러오기를 해도 이어지는 기관 단계와 결과가 같다', () => {
    const base = personAt('SAVE-1', 27);
    base.ch.flags.rom_heartbroken = { since: 27, until: 28 };
    open(base, 'crime_stalking_ex');
    respond(base, 'report');
    const storage = memoryStorage();
    base.phase = 'action';
    expect(saveGame(base, storage)).toBe(true);
    const loaded = loadGame(storage)!;
    expect(loaded).not.toBeNull();
    const direct = structuredClone(base);
    for (let i = 0; i < 5; i++) {
      crimeYear(direct, ['testify', 'accept']);
      crimeYear(loaded, ['testify', 'accept']);
    }
    expect(JSON.stringify(loaded.ch.crime)).toBe(JSON.stringify(direct.ch.crime));
    expect(JSON.stringify(loaded.scheduled)).toBe(JSON.stringify(direct.scheduled));
  });

  it('실제 게임 루프에서도 저장·불러오기 전후가 같다', () => {
    const a = crimeHeavyStart('DET-2');
    live(a, 8);
    const storage = memoryStorage();
    const mid = structuredClone(a);
    expect(saveGame(a, storage)).toBe(true);
    const b = loadGame(storage)!;
    live(mid, 10);
    live(b, 10);
    expect(JSON.stringify(b.ch.crime)).toBe(JSON.stringify(mid.ch.crime));
  });

  it('옛 저장(crime 기록 없음)도 불러오고, 번호 없는 옛 카드와 사라진 사건의 예약은 조용히 넘어간다', () => {
    const s = personAt('OLD-1', 30);
    const storage = memoryStorage();
    const old = JSON.parse(JSON.stringify(s)) as GameState;
    delete (old.ch as { crime?: unknown }).crime;
    old.scheduled.push({ eventId: stepEventId('police'), atAge: 31, ctx: { caseId: 'k999', 혐의: '절도' } });
    storage.setItem('lifesim.save.v1', JSON.stringify(old));
    const loaded = loadGame(storage)!;
    expect(loaded.ch.crime).toBeUndefined();
    expect((crimeScope(loaded) as { cases: number }).cases).toBe(0);
    // 사라진 사건의 예약 카드는 조건이 맞지 않아 넘어간다
    expect(triggerOk(getEvent(stepEventId('police')), buildScope(loaded, { caseId: 'k999' }), loaded)).toBe(false);
    // 사건 번호 없이 저장된 random_attack 카드: 선택해도 오류 없이 예전처럼 처리된다
    loaded.phase = 'event';
    presentCard(loaded, { eventId: 'random_attack', ctx: {} });
    delete loaded.card!.ctx.caseId;
    loaded.ch.crime = undefined;
    expect(() => chooseOption(loaded, 2)).not.toThrow();
    expect(loaded.card!.result).toBeDefined();
  });
});

// ── 기존 사건과 모드 ─────────────────────────────────────

describe('기존 random_attack과 모드 배수', () => {
  it('random_attack은 이상동기 폭행 목격 사건을 열고, 신고하면 참고인 단계가 이어진다', () => {
    const s = personAt('RA-1', 30);
    s.phase = 'event';
    expect(presentCard(s, { eventId: 'random_attack', ctx: {} })).toBe(true);
    const c = findCase(s.ch, s.card!.ctx.caseId)!;
    expect(c.cat).toBe('random_violence');
    expect(c.role).toBe('witness');
    respond(s, 'report');
    expect(c.report).toBe('immediate');
    expect(scheduledFor(s, c)).toContain(`${stepEventId('witness')}@31`);
    expect(s.ch.flags.ptsd).toBeUndefined();
  });

  it('현실 모드는 통계 그대로(배수 1), 드라마·막장은 기존 모드 규칙으로 드문 사건을 올린다', () => {
    const ev = getEvent('crime_sa_stranger');
    const s = personAt('MODE-1', 30);
    const reality = eventProbability(ev, s);
    expect(reality.M).toBe(1);
    expect(reality.D).toBe(1);
    s.mode = 'drama';
    const drama = eventProbability(ev, s);
    s.mode = 'makjang';
    const makjang = eventProbability(ev, s);
    expect(drama.M).toBeGreaterThan(1);
    expect(makjang.M).toBeGreaterThan(drama.M);
    // 흔한 사건은 모드에 따라 크게 부풀지 않는다
    const common = eventProbability(getEvent('crime_theft_transit'), s);
    expect(common.M).toBeLessThan(makjang.M);
  });

  it('조건이 맞지 않으면 확률은 0이다 (직장 사건은 일하지 않으면 생기지 않는다)', () => {
    const s = personAt('ZERO-1', 30);
    expect(s.ch.career.jobId).toBeUndefined();
    const ev = getEvent('crime_sh_superior');
    expect(limitOk(ev, s) && triggerOk(ev, buildScope(s), s)).toBe(false);
  });
});

// ── 현실 모드 발생률 (선택 실행) ────────────────────────

describe.skipIf(!process.env.CRIME_RATES)('현실 모드 발생률 (CRIME_RATES=1)', () => {
  it('장면별 기대 발생(ΣP)과 실제 발생이 맞고, 범주별 평생 경험을 표로 보여 준다', () => {
    const N = Number(process.env.CRIME_RATES_N ?? 1000);
    const events = CRIME_SCENES.map((x) => getEvent(x.id));
    let expected = 0;
    let observed = 0;
    const lives: GameState[] = [];
    for (let i = 0; i < N; i++) {
      const s = newGame({ seed: `CHECK-${i}`, mode: 'reality', birthYear: 2026 });
      const bot = new Rng(`bot|CHECK-${i}`);
      for (let guard = 0; guard < 20_000 && s.phase !== 'dead'; guard++) {
        if (s.phase === 'action') {
          const scope = buildScope(s);
          for (const ev of events) if (limitOk(ev, s) && triggerOk(ev, scope, s)) expected += eventProbability(ev, s, scope).P;
          endTurn(s);
        } else if (s.card && s.card.choices.length > 0 && !s.card.result) {
          choose(s, bot.chance(0.4) ? 0 : bot.int(0, (s.card as ActiveCard).choices.length - 1));
        } else proceed(s);
      }
      for (const ev of events) observed += s.counts[ev.id] ?? 0;
      s.log = [];
      lives.push(s);
    }
    const z = (observed - expected) / Math.sqrt(expected);
    console.log(`장면 발생: 기대 ${expected.toFixed(1)}, 관측 ${observed} (z=${z.toFixed(2)}), ${N}명`);
    for (const sex of ['F', 'M'] as const) {
      const ls = lives.filter((x) => x.ch.sex === sex);
      const rows = Object.keys(CATEGORY).map((cat) => {
        const n = ls.filter((x) => readLedger(x.ch).cases.some((c) => c.cat === cat && c.role === 'victim')).length;
        return `${cat} ${n}/${ls.length}`;
      });
      console.log(`${sex}: ${rows.join(', ')}`);
    }
    expect(Math.abs(z)).toBeLessThan(4);
  });
});
