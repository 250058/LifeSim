// 범죄 피해·목격·지원 사건 (Codex U-002)
//
// - 발생 → 대응 선택 → 기관 처리 → 오래 남는 상태 (같은 사건 번호로 이어진다)
// - 신고하지 않은 사건도 남고, 공소시효 안이면 몇 년 뒤에도 신고할 수 있다 (친고죄 고소기간·시효가 지나면 안 된다)
// - 지원 역할: 피해자(NPC)가 스스로 정하고, 그 사람이 떠나면 사건도 이유와 함께 닫힌다
// - 성인 대상 성범죄·성희롱 장면은 성인에게만 (데이터·처리 단계·실제 진행 모두)
// - 아동·청소년 피해(성범죄 피해 포함)는 보호 장면으로: 털어놓기·보호자·학교·지원 기관·신고·회복, 사건·보호자·기관 id가 남는다.
//   성적 행동 선택지와 행위 묘사는 없다 (데이터 검사 + 실제 카드 문장 검사). 플레이어는 어느 나이에도 성범죄를 저지르지 않는다
// - 피해자는 피해 때문에 도덕성·평판을 잃지 않고, 회복은 지원·시간에 따라 언젠가 끝난다
// - 같은 시드·선택이면 같은 결과, 저장·불러오기를 사이에 둬도 같다. 옛 저장도 불러온다
//
// CRIME_RATES=1 npx vitest run tests/crime.test.ts 로 현실 모드 발생률 표를 함께 본다 (기본은 건너뛴다)

import { describe, expect, it } from 'vitest';
import { activityViews } from '../src/engine/activities';
import { jobOpenings, takeJob } from '../src/engine/career';
import { CATEGORY, CRIME_ACTS, MINOR_SAFE_ACTS, PRESSING_ACTS, stepEventId, type SceneRow } from '../src/engine/catalog/crime';
import {
  canCivil,
  canGuardianReport,
  canReport,
  CRIME_ADULT_AGE,
  CRIME_SCENES,
  crimeDataProblems,
  crimeScope,
  explicitWordsIn,
  findCase,
  institutionsOf,
  minorOutcomeKeys,
  readLedger,
  recoveryAt,
  sceneAllowed,
  type CrimeCase,
} from '../src/engine/crime';
import { CRIMES } from '../src/engine/justice';
import { EVENT_FILES, EVENTS, getEvent } from '../src/engine/data';
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
  if (age >= 19) {
    s.ch.edu.status = 'graduated';
    // 공통 임용 자격(R-018)을 통과하도록 고졸 학력을 둔다
    s.ch.edu.degree = 'high';
  }
  else if (age >= 7) s.ch.edu.status = age >= 16 ? 'high' : age >= 13 ? 'middle' : 'elementary';
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
  if (scene.if?.includes('family.livesWithParents') && !scene.if.includes('!family.livesWithParents')) ch.family.livesWithParents = true;
  if (scene.victim === 'child' && scene.childAge) {
    const k = addFriend(state, rngFor('prepare', scene.id, 'child'));
    k.role = 'child';
    k.birthYear = state.year - Math.round((scene.childAge[0] + scene.childAge[1]) / 2);
  }
}

/** 카드의 화면 문장 전부 (제목·본문·선택지·결과) */
function cardTexts(card: ActiveCard): string[] {
  return [card.title, card.text, card.zoom ?? '', ...card.choices.map((c) => c.text), card.result?.text ?? ''];
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

  it('사건표 규칙 검사(crime.ts)가 통과한다: 신고 강요 없음, 성인 장면·보호 장면의 나이·대응·표현', () => {
    expect(crimeDataProblems()).toEqual([]);
    // 검사기가 실제로 잡아내는지: 표현 검사 낱말
    expect(explicitWordsIn('성관계를 요구했다')).toEqual(['성관계']);
    expect(explicitWordsIn('선생님이 끝까지 들어 주셨다')).toEqual([]);
  });

  it('성인 대상 성범죄·성희롱 장면은 성인 전용이고, 미성년자에게 열리는 일반 장면은 비성적 범죄의 허용된 역할뿐이다', () => {
    for (const s of CRIME_SCENES.filter((x) => !x.minor)) {
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

  it('아동·청소년 보호 장면: 성인 전용 표시로 지우지 않고, 나이·대응이 보호 경로뿐이다', () => {
    const minorScenes = CRIME_SCENES.filter((x) => x.minor);
    // 피해자 본인·미성년 친구 돕기·보호자인 주인공, 성범죄 피해와 아동학대가 모두 있다
    expect(minorScenes.map((x) => x.minor).sort()).toEqual(expect.arrayContaining(['guardian', 'self']));
    expect(minorScenes.some((x) => CATEGORY[x.cat].sexual && x.role === 'victim')).toBe(true);
    expect(minorScenes.some((x) => x.cat === 'domestic' && x.role === 'victim')).toBe(true);
    expect(minorScenes.some((x) => x.role === 'supporter' && x.victim === 'friend')).toBe(true);
    for (const s of minorScenes) {
      const ev = getEvent(s.id);
      expect(ev.adult, s.id).toBeFalsy();
      if (s.minor === 'self') expect(s.age[1], s.id).toBeLessThan(CRIME_ADULT_AGE);
      if (s.minor === 'guardian') {
        expect(s.age[0], s.id).toBeGreaterThanOrEqual(CRIME_ADULT_AGE);
        expect(s.childAge![1], s.id).toBeLessThan(CRIME_ADULT_AGE);
      }
      for (const c of ev.choices ?? []) {
        for (const a of choiceActs(c)) expect(MINOR_SAFE_ACTS as readonly string[], `${s.id}: ${a}`).toContain(a);
        // 사용·성인 활동 효과가 없다 (돈을 보내거나 관계를 시작·끝내는 효과 포함)
        const fx = [c.effects, c.onSuccess?.effects, c.onFail?.effects];
        for (const f of fx) for (const a of f?.do ?? []) expect(a.type, `${s.id}: ${a.type}`).toBe('crime');
      }
    }
  });

  it('플레이어는 어느 나이에도 성범죄를 저지르지 않는다: 처벌받는 죄에 성범죄가 없고, 대응은 피해·목격·지원·보호뿐이다', () => {
    const sexualWords = ['성폭력', '추행', '강간', '촬영', '성희롱', '음란', '성착취', '그루밍', '허위영상'];
    for (const [id, def] of Object.entries(CRIMES)) {
      for (const w of sexualWords) expect(def.name.includes(w), `${id}: ${def.name}`).toBe(false);
    }
    for (const ev of EVENTS) {
      const all = [ev.effects, ...(ev.choices ?? []).flatMap((c) => [c.effects, c.onSuccess?.effects, c.onFail?.effects])];
      for (const fx of all) for (const a of fx?.do ?? []) if (a.type === 'prosecute') expect(CRIMES[a.crime] ?? a.crime === 'ctx', ev.id).toBeTruthy();
    }
    // 범죄 행동은 피해자·목격자·돕는 사람·보호자의 대응뿐: 가해 쪽 행동 id가 없다
    for (const act of CRIME_ACTS) expect(['offend', 'assault', 'harass', 'film_victim'].includes(act)).toBe(false);
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
      // 아동·청소년 보호 경로
      'teacher', 'teacher.school', 'teacher.reported', 'guardian.report', 'guardian.care', 'guardian.dismissed', 'guardian_report',
      'guardian_report.unavailable', 'support.guardian', 'report.filed.child', 'report.delayed.minor', 'postpone.child', 'witness.call.child',
      'testify.child', 'statement.child', 'civil.filed.child', 'help.minor',
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

  it('아는 사람 가해: 이미 아는 성인 친구(NPC)로 묶이기도 하고, 사이가 끊기면 관계 종료, 숨지면 공소권 없음', () => {
    // 같은 장면도 시드에 따라 친구 NPC이거나 새 참여자다 (장면의 friendOffender 확률). 둘 다 나오는지 본다
    const bound: GameState[] = [];
    let anonymous = 0;
    for (let i = 0; i < 40 && (bound.length === 0 || anonymous === 0); i++) {
      const s = personAt(`FLOW-FRIEND-${i}`, 35);
      const f = addFriend(s, rngFor('t', 'friend', i));
      f.birthYear = s.ch.birthYear;
      f.closeness = 60;
      const c = open(s, 'crime_fraud_loan');
      const p = readLedger(s.ch).people.find((x) => x.id === c.offender)!;
      if (p.npcId === f.id) bound.push(s);
      else anonymous++;
    }
    expect(bound.length).toBeGreaterThan(0);
    expect(anonymous).toBeGreaterThan(0);
    const s = bound[0];
    const c = readLedger(s.ch).cases[0];
    const friend = s.ch.npcs.find((n) => n.id === readLedger(s.ch).people.find((p) => p.id === c.offender)!.npcId)!;
    // 피해자는 그 친구와 멀어진다 (피해자의 도덕성·평판은 그대로)
    expect(friend.closeness).toBeLessThan(60);
    expect(s.card!.text).toContain(friend.name);
    const view = () => (crimeScope(s, { caseId: c.id }) as { case: Record<string, unknown> }).case;
    expect(view().offenderKnown).toBe(true);
    friend.closeness = 5;
    expect(view().relationEnded).toBe(true);
    friend.closeness = 30;
    respond(s, 'report');
    expect(c.report).toBe('immediate');
    friend.alive = false;
    crimeYear(s, []);
    expect(c.prosecution).toBe('no_right');
    expect(c.log.some((l) => l.step === 'recheck')).toBe(true);
    // 미성년자·보호 장면·성범죄 장면에는 친구를 가해자로 묶지 않는다 (검사 규칙)
    for (const scene of CRIME_SCENES.filter((x) => x.friendOffender !== undefined)) {
      expect(scene.minor).toBeUndefined();
      expect(CATEGORY[scene.cat].sexual).toBe(false);
      expect(scene.age[0]).toBeGreaterThanOrEqual(CRIME_ADULT_AGE);
    }
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

  it('성인 성범죄 지원 대상은 성인뿐: 미성년 친구에게는 사건이 열리지 않는다', () => {
    const s = personAt('SUPPORT-3', 30);
    const f = addFriend(s, rngFor('t', 'f4'));
    f.birthYear = s.year - 17;
    const ev = getEvent('crime_sa_support_friend');
    expect(triggerOk(ev, buildScope(s), s)).toBe(false);
    s.phase = 'event';
    presentCard(s, { eventId: 'crime_sa_support_friend', ctx: { 친구: f.name, friendId: f.id } });
    expect(readLedger(s.ch).cases.length).toBe(0);
    // 성인 친구가 있으면 그 친구로 묶어 연다 (카드 문장과 기록이 같은 사람)
    const adult = addFriend(s, rngFor('t', 'f5'));
    adult.birthYear = s.ch.birthYear;
    dismissCard(s);
    s.phase = 'event';
    expect(triggerOk(ev, buildScope(s), s)).toBe(true);
    presentCard(s, { eventId: 'crime_sa_support_friend', ctx: { 친구: f.name, friendId: f.id } });
    const c = findCase(s.ch, s.card!.ctx.caseId)!;
    expect(readLedger(s.ch).people.find((p) => p.id === c.victim)?.npcId).toBe(adult.id);
    expect(s.card!.ctx.friendId).toBe(adult.id);
    expect(s.card!.title).toContain(adult.name);
  });

  it('보호자인 주인공: 미성년 자녀의 피해를 듣고, 보호자로서 신고할 수 있다. 자녀가 성년이 되면 본인이 정한다', () => {
    const s = personAt('GUARDIAN-1', 40);
    const scene = CRIME_SCENES.find((x) => x.id === 'crime_minor_support_child')!;
    prepare(s, scene);
    const c = open(s, scene.id);
    const kid = readLedger(s.ch).people.find((p) => p.id === c.victim)!;
    expect(kid.npcId).toBeDefined();
    expect(c.role).toBe('supporter');
    expect(c.minor).toBe(true);
    expect(c.guardian).toBe('self');
    expect(canGuardianReport(s, c)).toBe(true);
    // 보호자가 이끄는 길: 해바라기센터에 같이 가면 아이의 상담·치료가 시작되고 기관 id가 남는다
    respond(s, 'accompany');
    expect(c.care).toBe('active');
    expect(institutionsOf(c)).toContain('sunflower');
    expect(c.report).toBe('none');
    // 1년 뒤 소식 카드에서 보호자로서 신고한다
    crimeYear(s, ['guardian_report']);
    expect(c.report).not.toBe('none');
    expect(c.reportedBy).toBe('guardian');
    expect(institutionsOf(c)).toContain('police');
    // 자녀가 성년이 된 뒤에는 보호자 신고가 없다
    const t = personAt('GUARDIAN-2', 40);
    prepare(t, scene);
    const c2 = open(t, scene.id);
    respond(t, 'listen');
    const kidNpc = t.ch.npcs.find((n) => n.id === readLedger(t.ch).people.find((p) => p.id === c2.victim)!.npcId)!;
    kidNpc.birthYear = t.year - 19;
    expect(canGuardianReport(t, c2)).toBe(false);
  });
});

// ── 아동·청소년 보호 ────────────────────────────────────

/** 보호 장면을 연다: 장면에 맞는 나이·조건을 갖춘 시험 인물 */
function minorStart(seed: string, sceneId: string, age?: number): { s: GameState; scene: SceneRow } {
  const scene = CRIME_SCENES.find((x) => x.id === sceneId)!;
  const s = personAt(seed, age ?? (scene.minor === 'guardian' ? 40 : Math.min(scene.age[1], Math.max(scene.age[0], 14))));
  s.ch.sex = 'F';
  s.ch.family.livesWithParents = true;
  prepare(s, scene);
  if (scene.victim === 'friend' && scene.minor) {
    const f = addFriend(s, rngFor('t', seed, 'minor-friend'));
    f.birthYear = s.year - s.ch.age;
  }
  return { s, scene };
}

/** 대기열을 비우며 뜬 카드의 화면 문장을 모은다 (고른 대응은 prefer 순서, 없으면 신고·대면이 아닌 첫 선택지) */
function drainTexts(state: GameState, prefer: string[], out: string[], acts: string[]): void {
  for (let guard = 0; guard < 100; guard++) {
    if (state.card) {
      const before = state.card.choices.length;
      const ev = getEvent(state.card.eventId);
      if (state.ch.age < CRIME_ADULT_AGE) for (const c of state.card.choices) acts.push(...choiceActs(ev.choices![c.index]));
      if (before > 0) answer(state, prefer);
      out.push(...cardTexts(state.card));
      dismissCard(state);
      continue;
    }
    const next = state.queue.shift();
    if (!next) break;
    const logBefore = state.log.length;
    presentCard(state, next);
    for (const l of state.log.slice(logBefore)) out.push(l.title ?? '', l.text);
  }
  state.phase = 'action';
}

describe('아동·청소년: 일반 성범죄 장면은 막고, 피해는 보호 장면으로 다룬다', () => {
  it('처리 단계: 성인 대상 성범죄 장면은 16세에게 열리지 않고, 보호 장면은 나이가 맞을 때만 열린다', () => {
    for (const scene of CRIME_SCENES.filter((x) => CATEGORY[x.cat].sexual && !x.minor)) {
      expect(sceneAllowed(16, scene), scene.id).toBe(false);
      const s = personAt(`MINOR-${scene.id}`, 16);
      applyEffects(s, { do: [{ type: 'crime', op: 'open', scene: scene.id }] }, { ctx: {}, rng: new Rng('x'), changes: [] });
      expect(readLedger(s.ch).cases.length, scene.id).toBe(0);
      // 이벤트 자체도 미성년자에게는 조건이 맞지 않는다
      expect(triggerOk(getEvent(scene.id), buildScope(s), s), scene.id).toBe(false);
    }
    for (const scene of CRIME_SCENES.filter((x) => x.minor === 'self')) {
      expect(sceneAllowed(14, scene), scene.id).toBe(true);
      expect(sceneAllowed(25, scene), scene.id).toBe(false);
      const s = personAt(`ADULT-${scene.id}`, 25);
      applyEffects(s, { do: [{ type: 'crime', op: 'open', scene: scene.id }] }, { ctx: {}, rng: new Rng('x'), changes: [] });
      expect(readLedger(s.ch).cases.length, scene.id).toBe(0);
    }
    for (const scene of CRIME_SCENES.filter((x) => x.minor === 'guardian')) {
      expect(sceneAllowed(40, scene), scene.id).toBe(true);
      expect(sceneAllowed(16, scene), scene.id).toBe(false);
    }
  });

  it('실제 진행: 18세까지 살아도 미성년 사건의 성범죄 범주는 보호 장면에서만 생기고, 일반 장면은 허용된 역할뿐이다', () => {
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
          if (c.age >= CRIME_ADULT_AGE) continue;
          const scene = CRIME_SCENES.find((x) => x.id === c.scene)!;
          minorCats.add(`${c.cat}/${c.role}`);
          if (CATEGORY[c.cat].sexual) expect(scene.minor, `${mode} ${c.scene}`).toBe('self');
          else if (!scene.minor) expect(CATEGORY[c.cat].minorRoles, c.scene).toContain(c.role);
          // 피해자 본인의 미성년 사건은 보호 경로 표시가 있다
          if (c.role === 'victim') expect(c.minor, c.scene).toBe(true);
        }
      }
    }
    // 보호·신고 경로가 붙은 미성년 사건이 실제로 생긴다 (도달성)
    expect(minorCats.size).toBeGreaterThan(0);
  });

  it('발생 → 선생님에게 털어놓기 → 학교의 신고·보호자 연락 → 수사·재판 → 회복: 사건·보호자·기관 id로 이어진다', () => {
    const { s } = minorStart('MINOR-FLOW-1', 'crime_minor_known_adult', 13);
    const c = open(s, 'crime_minor_known_adult');
    expect(c.minor).toBe(true);
    expect(c.clockFrom).toBe(CRIME_ADULT_AGE);
    expect(c.civilFrom).toBe(CRIME_ADULT_AGE);
    expect(c.noLimit).toBeUndefined();
    respond(s, 'teacher');
    // 선생님은 신고 의무자: 학교가 신고하고 보호자에게 알린다
    expect(c.report).toBe('immediate');
    expect(c.reportedBy).toBe('school');
    expect(institutionsOf(c).slice(0, 2)).toEqual(['school', 'police']);
    const guardian = readLedger(s.ch).people.find((p) => p.id === c.guardian)!;
    expect(guardian.kind).toBe('guardian');
    const parent = s.ch.npcs.find((n) => n.id === guardian.npcId)!;
    expect(['mother', 'father']).toContain(parent.role);
    expect(c.log.find((l) => l.step === 'guardian')?.by).toBe(guardian.id);
    // 같은 사건 번호로 기관 단계가 이어진다
    for (let i = 0; i < 6; i++) crimeYear(s, ['statement', 'accept']);
    expect(c.log.filter((l) => l.inst === 'police').length).toBeGreaterThan(1);
    expect(['referred', 'no_suspect', 'not_sent']).toContain(c.police);
    if (c.police === 'referred') expect(c.prosecution).not.toBe('none');
    if (c.prosecution === 'indicted') expect(institutionsOf(c)).toContain('court');
    // 평생 고정된 파국이 아니다
    expect(recoveryAt(c, c.age + 30)).toBeGreaterThanOrEqual(85);
  });

  it('보호자에게 털어놓기: 보호자(부모 NPC)가 묶이고, 함께 지원 기관을 찾거나 상담부터 하거나 대수롭지 않게 넘긴다', () => {
    const paths = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const { s } = minorStart(`MINOR-HELP-${i}`, 'crime_minor_known_adult', 14);
      const c = open(s, 'crime_minor_known_adult');
      respond(s, 'help');
      const guardian = readLedger(s.ch).people.find((p) => p.id === c.guardian);
      expect(guardian?.npcId, `${i}`).toBeDefined();
      const by = c.log.filter((l) => l.by === c.guardian).map((l) => l.step);
      if (c.report !== 'none') {
        expect(c.reportedBy).toBe('guardian');
        expect(institutionsOf(c)).toEqual(expect.arrayContaining(['sunflower', 'police']));
        paths.add('report');
      } else if (by.includes('care')) paths.add('care');
      else {
        expect(by).toContain('guardian');
        paths.add('dismissed');
        // 믿어 주지 않은 경우에도 다시 돌아보는 카드가 있다 (다른 어른에게 말할 수 있다)
        expect(scheduledFor(s, c).some((x) => x.startsWith(stepEventId('revisit')))).toBe(true);
      }
    }
    expect(paths.has('report')).toBe(true);
    expect(paths.size).toBeGreaterThanOrEqual(2);
  });

  it('말하지 않은 아이: 다시 돌아볼 때 선생님에게 말할 수 있고, 어른이 된 뒤에도 늦은 신고가 된다 (시효는 성년부터, 13세 미만은 시효 없음)', () => {
    const { s } = minorStart('MINOR-LATE-1', 'crime_minor_known_adult', 12);
    const c = open(s, 'crime_minor_known_adult');
    expect(c.noLimit).toBe(true);
    respond(s, 'postpone');
    expect(c.report).toBe('none');
    let told = false;
    for (let i = 0; i < 3 && !told; i++) {
      crimeYear(s, ['teacher']);
      told = c.report !== 'none';
    }
    expect(told).toBe(true);
    expect(c.reportedBy).toBe('school');
    expect(c.report).toBe('delayed');
    // 15세 피해: 시효는 19세부터 10년 (과학적 증거가 있으면 20년)
    const { s: t } = minorStart('MINOR-LATE-2', 'crime_minor_known_adult', 15);
    const c2 = open(t, 'crime_minor_known_adult');
    respond(t, 'postpone');
    expect(c2.noLimit).toBeUndefined();
    t.ch.age = 29;
    expect(canReport(t, c2)).toBe(true);
    t.ch.age = 30;
    expect(canReport(t, c2)).toBe(false);
    c2.evidence = 2;
    expect(canReport(t, c2)).toBe(true);
    // 성인이 되어 직접 늦은 신고: 접수되고, 시효가 성년부터라는 안내가 붙는다
    t.ch.age = 27;
    t.year = 2000 + 27;
    t.world.year = t.year;
    const ctx: Record<string, string> = { caseId: c2.id };
    applyEffects(t, { do: [{ type: 'crime', op: 'respond', act: 'report' }] }, { ctx, rng: new Rng('late'), changes: [] });
    expect(c2.report).toBe('delayed');
    expect(c2.reportAge).toBe(27);
    expect(ctx.결과).toContain('성년');
    // 13세 미만 피해는 시효가 없다
    s.ch.age = 70;
    c.report = 'none';
    expect(canReport(s, c)).toBe(true);
    // 성적 침해의 민사 시효도 성년부터 (민법 766조 3항)
    const { s: u } = minorStart('MINOR-LATE-3', 'crime_minor_known_adult', 15);
    const c3 = open(u, 'crime_minor_known_adult');
    respond(u, 'postpone');
    u.ch.age = 21;
    expect(canCivil(u, c3)).toBe(true);
    u.ch.age = 23;
    expect(canCivil(u, c3)).toBe(false);
  });

  it('어릴 때 상담만 받은 일: 어른이 된 뒤 한 번 더 돌아보는 카드에서 처음으로 신고할 수 있다', () => {
    const { s } = minorStart('MINOR-ADULT-REVISIT', 'crime_minor_known_adult', 14);
    const c = open(s, 'crime_minor_known_adult');
    respond(s, 'counsel');
    expect(institutionsOf(c)).toEqual(['youth1388']);
    // 미성년인 동안: 기록만 남기며 돌아본다
    while (s.ch.age < CRIME_ADULT_AGE) crimeYear(s, ['record']);
    expect(c.report).toBe('none');
    expect(c.adultRevisit).toBe(true);
    expect(scheduledFor(s, c)).toContain(`${stepEventId('revisit')}@${CRIME_ADULT_AGE + 1}`);
    crimeYear(s, ['report']);
    expect(c.report).toBe('delayed');
    expect(c.reportAge).toBe(CRIME_ADULT_AGE + 1);
    expect(c.reportedBy).toBe('self');
  });

  it('아동학대: 학교의 신고 의무, 가해 부모와 다른 보호자, 보호조치, 가해 부모 사망 뒤 재검사, 집을 떠나면 위협이 끝난다', () => {
    const { s } = minorStart('MINOR-ABUSE-1', 'crime_child_abuse', 11);
    const parents = s.ch.npcs.filter((n) => n.role === 'mother' || n.role === 'father');
    expect(parents.length).toBe(2);
    const closenessBefore = new Map(parents.map((n) => [n.id, n.closeness]));
    const c = open(s, 'crime_child_abuse');
    expect(c.minor).toBe(true);
    expect(c.clockFrom).toBe(CRIME_ADULT_AGE);
    const offender = readLedger(s.ch).people.find((p) => p.id === c.offender)!;
    const offenderNpc = s.ch.npcs.find((n) => n.id === offender.npcId)!;
    expect(offenderNpc.closeness).toBeLessThan(closenessBefore.get(offenderNpc.id)!);
    expect(s.card!.ctx.혐의).toBe('아동학대');
    respond(s, 'teacher');
    expect(c.reportedBy).toBe('school');
    expect(institutionsOf(c)).toEqual(expect.arrayContaining(['school', 'child_protection']));
    // 보호자는 가해자가 아닌 다른 부모
    const guardian = readLedger(s.ch).people.find((p) => p.id === c.guardian)!;
    expect(guardian.npcId).toBeDefined();
    expect(guardian.npcId).not.toBe(offenderNpc.id);
    expect(['granted', 'denied']).toContain(c.protection);
    // 미성년자가 함께 사는 부모를 상대로 민사 소송을 내는 길은 없다
    expect(canCivil(s, c)).toBe(false);
    // 가해 부모가 사건 도중 숨지면 형사 절차는 공소권 없음으로 끝난다 (다른 사람으로 바꾸지 않는다)
    offenderNpc.alive = false;
    crimeYear(s, ['accept']);
    expect(c.prosecution).toBe('no_right');
    expect(c.log.some((l) => l.step === 'recheck')).toBe(true);
    expect(readLedger(s.ch).people.find((p) => p.id === c.offender)!.npcId).toBe(offenderNpc.id);
    // 다른 집: 집을 떠나면(같이 살지 않으면) 위협이 이어지지 않는다
    const { s: t } = minorStart('MINOR-ABUSE-2', 'crime_child_abuse', 12);
    const c2 = open(t, 'crime_child_abuse');
    respond(t, 'postpone');
    const before = (crimeScope(t, { caseId: c2.id }) as { case: Record<string, unknown> }).case;
    expect(before.relationEnded).toBe(false);
    t.ch.family.livesWithParents = false;
    const after = (crimeScope(t, { caseId: c2.id }) as { case: Record<string, unknown> }).case;
    expect(after.relationEnded).toBe(true);
  });

  it('미성년 친구를 돕는 청소년: 함께 상담 선생님을 찾으면 학교가 신고하고, 친구(NPC)가 피해자로 남는다', () => {
    const { s } = minorStart('MINOR-FRIEND-1', 'crime_minor_support_friend', 15);
    const ev = getEvent('crime_minor_support_friend');
    expect(triggerOk(ev, buildScope(s), s)).toBe(true);
    const c = open(s, 'crime_minor_support_friend');
    const victim = readLedger(s.ch).people.find((p) => p.id === c.victim)!;
    const friend = s.ch.npcs.find((n) => n.id === victim.npcId)!;
    expect(friend.role).toBe('friend');
    expect(s.year - friend.birthYear).toBeLessThan(CRIME_ADULT_AGE);
    expect(c.minor).toBe(true);
    respond(s, 'accompany');
    expect(c.report).toBe('immediate');
    expect(c.reportedBy).toBe('school');
    expect(institutionsOf(c)).toEqual(['school', 'police']);
    crimeYear(s, ['listen']);
    expect(c.log.some((l) => l.step === 'police')).toBe(true);
  });

  it('보호 경로의 실제 카드 문장: 모든 보호 장면의 모든 선택지와 이어지는 단계 카드에 성적 행동 선택지·행위 묘사가 없다', () => {
    const texts: string[] = [];
    const acts: string[] = [];
    for (const scene of CRIME_SCENES.filter((x) => x.minor)) {
      const n = getEvent(scene.id).choices!.length;
      for (let i = 0; i < n; i++) {
        for (const prefer of [['teacher', 'statement', 'accept'], ['help', 'guardian_report', 'postpone']]) {
          const { s } = minorStart(`SCAN-${scene.id}-${i}-${prefer[0]}`, scene.id);
          s.phase = 'event';
          expect(presentCard(s, { eventId: scene.id, ctx: {} }), scene.id).toBe(true);
          const shown = s.card!.choices.findIndex((c) => c.index === i);
          if (shown < 0) continue;
          chooseOption(s, shown);
          texts.push(...cardTexts(s.card!));
          dismissCard(s);
          drainTexts(s, prefer, texts, acts);
          for (let y = 0; y < 8; y++) {
            s.ch.age += 1;
            s.year += 1;
            s.world.year = s.year;
            const due = s.scheduled.filter((x) => x.atAge <= s.ch.age && x.eventId.startsWith('crime_'));
            s.scheduled = s.scheduled.filter((x) => !due.includes(x));
            s.queue.push(...due.map((d) => ({ eventId: d.eventId, ctx: d.ctx })));
            drainTexts(s, prefer, texts, acts);
          }
        }
      }
    }
    expect(texts.length).toBeGreaterThan(100);
    const bad = texts.flatMap((t) => explicitWordsIn(t).map((w) => `${w}: ${t}`));
    expect(bad).toEqual([]);
    // 미성년인 동안 뜬 카드의 선택지: 돈을 보내기·대면·합의·퇴사·이사·촬영 같은 길이 없다
    for (const a of acts) expect(['pay', 'confront', 'settle', 'quit', 'move', 'film', 'transfer', 'refuse'], a).not.toContain(a);
    // 데이터 쪽 결과 문장(보호 경로 키)도 같은 검사를 통과한다
    for (const k of minorOutcomeKeys()) for (const t of OUTCOMES[k]) expect(explicitWordsIn(t), k).toEqual([]);
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

  it('보호 경로도 같은 시드·선택이면 같고, 저장·불러오기 뒤에도 보호자·기관 id와 이어지는 단계가 같다', () => {
    const run = (seed: string) => {
      const { s } = minorStart(seed, 'crime_minor_known_adult', 13);
      open(s, 'crime_minor_known_adult');
      respond(s, 'help');
      for (let i = 0; i < 5; i++) crimeYear(s, ['statement', 'teacher', 'accept']);
      return s;
    };
    const a = run('MINOR-DET');
    const b = run('MINOR-DET');
    expect(JSON.stringify(a.ch.crime)).toBe(JSON.stringify(b.ch.crime));
    expect(JSON.stringify(a.scheduled)).toBe(JSON.stringify(b.scheduled));
    // 저장·불러오기
    const { s: base } = minorStart('MINOR-SAVE', 'crime_child_abuse', 11);
    const c = open(base, 'crime_child_abuse');
    respond(base, 'teacher');
    base.phase = 'action';
    const storage = memoryStorage();
    expect(saveGame(base, storage)).toBe(true);
    const loaded = loadGame(storage)!;
    const lc = findCase(loaded.ch, c.id)!;
    expect(lc.guardian).toBe(c.guardian);
    expect(lc.minor).toBe(true);
    expect(institutionsOf(lc)).toEqual(institutionsOf(c));
    expect(readLedger(loaded.ch).people).toEqual(readLedger(base.ch).people);
    const direct = structuredClone(base);
    for (let i = 0; i < 5; i++) {
      crimeYear(direct, ['statement', 'accept']);
      crimeYear(loaded, ['statement', 'accept']);
    }
    expect(JSON.stringify(loaded.ch.crime)).toBe(JSON.stringify(direct.ch.crime));
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
    const catOf = new Map(CRIME_SCENES.map((x) => [x.id, x.cat]));
    let expected = 0;
    let observed = 0;
    const expectedBy: Record<string, number> = {};
    // 분모: 살아 있던 해 (성인·미성년, 성별)
    const years = { F: { adult: 0, minor: 0 }, M: { adult: 0, minor: 0 } };
    const lives: GameState[] = [];
    for (let i = 0; i < N; i++) {
      const s = newGame({ seed: `CHECK-${i}`, mode: 'reality', birthYear: 2026 });
      const bot = new Rng(`bot|CHECK-${i}`);
      for (let guard = 0; guard < 20_000 && s.phase !== 'dead'; guard++) {
        if (s.phase === 'action') {
          const scope = buildScope(s);
          for (const ev of events) {
            if (!limitOk(ev, s) || !triggerOk(ev, scope, s)) continue;
            const P = eventProbability(ev, s, scope).P;
            expected += P;
            const cat = catOf.get(ev.id)!;
            expectedBy[cat] = (expectedBy[cat] ?? 0) + P;
          }
          years[s.ch.sex][s.ch.age >= CRIME_ADULT_AGE ? 'adult' : 'minor'] += 1;
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
    console.log(`장면 발생: 기대 ΣP ${expected.toFixed(1)}, 관측 ${observed} (z=${z.toFixed(2)}), ${N}명`);
    console.log(`분모(살아 있던 해): 여 성인 ${years.F.adult}·미성년 ${years.F.minor}, 남 성인 ${years.M.adult}·미성년 ${years.M.minor}`);
    const all = lives.flatMap((x) => readLedger(x.ch).cases.map((c) => ({ c, sex: x.ch.sex })));
    const adultYears = years.F.adult + years.M.adult;
    const minorYears = years.F.minor + years.M.minor;
    const per1000 = (n: number, d: number) => (d > 0 ? ((1000 * n) / d).toFixed(2) : '-');
    console.log('범주 | 피해 사건 성인(여/남) /1천 성인-년 | 미성년 /1천 미성년-년 | 신고 비율 | 평생 피해 경험 여/남 | 기대 ΣP·관측(전 역할)');
    for (const cat of Object.keys(CATEGORY)) {
      const v = all.filter((x) => x.c.cat === cat && x.c.role === 'victim');
      const adultF = v.filter((x) => !x.c.minor && x.sex === 'F').length;
      const adultM = v.filter((x) => !x.c.minor && x.sex === 'M').length;
      const minor = v.filter((x) => x.c.minor).length;
      const reported = v.filter((x) => x.c.report !== 'none').length;
      const ever = (sex: 'F' | 'M') => {
        const ls = lives.filter((x) => x.ch.sex === sex);
        return `${ls.filter((x) => readLedger(x.ch).cases.some((c) => c.cat === cat && c.role === 'victim')).length}/${ls.length}`;
      };
      const obsAll = all.filter((x) => x.c.cat === cat).length;
      console.log(
        `${cat} | ${per1000(adultF, years.F.adult)}/${per1000(adultM, years.M.adult)} (${adultF + adultM}건) | ${per1000(minor, minorYears)} (${minor}건) | ` +
          `${reported}/${v.length} | ${ever('F')} ${ever('M')} | ${(expectedBy[cat] ?? 0).toFixed(1)}·${obsAll}`,
      );
    }
    // 전국범죄피해조사 비교: 성인의 폭력 피해(성폭력·폭행·강도·이상동기·협박) 건수 / 성인-년
    const violent = all.filter((x) => x.c.role === 'victim' && !x.c.minor && ['sexual_assault', 'assault', 'robbery', 'random_violence', 'threat'].includes(x.c.cat));
    console.log(`성인 폭력 피해 ${violent.length}건 / ${adultYears} 성인-년 = ${((100 * violent.length) / adultYears).toFixed(3)}%/년 (kcvs2020 0.88%)`);
    const violentReported = violent.filter((x) => x.c.report !== 'none').length;
    console.log(`  그중 신고 ${violentReported}/${violent.length} (kcvs2020 폭력 신고율 18.95%)`);
    const property = all.filter((x) => x.c.role === 'victim' && ['theft', 'fraud', 'vandalism', 'extortion', 'trespass'].includes(x.c.cat));
    console.log(`재산 피해 신고 ${property.filter((x) => x.c.report !== 'none').length}/${property.length} (kcvs2020 재산 신고율 20.44%)`);
    const roles = ['victim', 'witness', 'supporter'].map((r) => `${r} ${lives.filter((x) => readLedger(x.ch).cases.some((c) => c.role === r)).length}/${N}`);
    console.log(`평생 한 번이라도: ${roles.join(', ')}; 미성년 피해 ${lives.filter((x) => readLedger(x.ch).cases.some((c) => c.minor && c.role === 'victim')).length}/${N}`);
    // 의미 있게 다른 경로: 같은 사건 번호에 쌓인 상태의 조합 (이름·문장·시드만 다른 것은 같은 경로)
    const path = (c: CrimeCase) =>
      [c.cat, c.role, c.minor ? 'minor' : 'adult', c.report, c.reportedBy ?? '-', c.police, c.prosecution, c.verdict, c.internal, c.admin, c.civil, c.protection, c.care, c.recovered !== undefined ? 'rec' : 'open'].join('|');
    const paths = new Set(all.map((x) => path(x.c)));
    const outcomeOnly = new Set(all.map((x) => path(x.c).split('|').slice(3).join('|')));
    console.log(`관측 사건 ${all.length}건, 서로 다른 경로 ${paths.size}개 (범주·역할 빼고 기관·회복 상태 조합 ${outcomeOnly.size}개)`);
    expect(Math.abs(z)).toBeLessThan(4);
  });
});
