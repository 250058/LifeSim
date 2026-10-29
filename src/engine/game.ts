// 핵심 게임 루프. 한 판은 1년 단위로 진행되고 매년 같은 6단계가 반복된다.
//
//   1 연초: 나이 +1, 관문(마일스톤) 확인
//   2 세계 갱신: 경제·정치·안보, 세계 사건
//   3 자유 행동: 시간 포인트로 활동 선택          ← 플레이어 차례 (phase 'action')
//   4 랜덤 사건: 일어난 사건은 모두 처리          ← '+1년'을 누르면 시작
//                결정이 필요한 사건만 카드로 띄우고, 작은 사건은 일기 한 줄로 남긴다
//   5 연말 결산: 성장·노화, 돈, 관계, 건강
//   6 사망 판정: 아니오 → 1로 / 예 → 인생 요약
//
// 엔진 함수는 상태를 직접 바꾼다 (시뮬레이터가 1만 명을 빠르게 돌릴 수 있도록).
// 화면은 바꾸기 전에 상태를 복사한다.

import { performActivity, timePointsFor, type ActivityResult } from './activities';
import { birthStory, createCharacter, type NewGameOptions } from './character';
import { hireChance, jobOpenings, leaveJob, takeJob, yearlyEarnings } from './career';
import { ACTIVITY_BY_ID, JOB_BY_ID, REGION_BY_ID } from './data';
import { directorYearEnd, initDirector } from './director';
import { addFlag, changeAttr, killCharacter, removeFlag } from './effects';
import { chooseOption, dismissCard, drawYearEvents, milestonesFor, presentCard } from './eventEngine';
import { ELITE_HIGH, formatWon, josa, signedWon } from './format';
import { agingDeltas, deathProbability, pickCause, yearlyHealthDelta } from './health';
import { alive, npcYear } from './relations';
import { rngFor, type Rng } from './rng';
import { annualIncome, homePrice, inPrison, mortgageLimit } from './scope';
import { SAVE_VERSION } from './save';
import { substanceYearEnd } from './substances';
import { buildSummary } from './summary';
import type { Change, GameState, HighType, PendingCard } from './types';
import { initWorld, updateWorld } from './world';

export function newGame(opts: NewGameOptions): GameState {
  const state = {
    v: SAVE_VERSION,
    seed: opts.seed,
    mode: opts.mode,
    startYear: opts.birthYear,
    year: opts.birthYear,
    world: initWorld(opts.birthYear),
    director: initDirector(),
    phase: 'action',
    step: 'yearStart',
    queue: [],
    scheduled: [],
    points: { max: 0, left: 0 },
    actions: {},
    log: [],
    counts: {},
    lastAge: {},
    serial: 0,
  } as unknown as GameState;
  createCharacter(state, opts);
  state.log.push({ year: state.year, age: 0, kind: 'birth', text: birthStory(state), impact: 0 });
  const max = timePointsFor(state);
  state.points = { max, left: max };
  syncDerivedFlags(state);
  return state;
}

// ── 플레이어 행동 ────────────────────────────────────────

/** '+1년' 버튼: 4단계 랜덤 사건으로 넘어간다 */
export function endTurn(state: GameState): void {
  if (state.phase !== 'action' || !state.ch.alive) return;
  state.queue.push(...drawYearEvents(state));
  state.step = 'yearEvents';
  advance(state);
}

export function choose(state: GameState, displayIndex: number): void {
  if (state.phase !== 'event' || !state.card || state.card.result) return;
  chooseOption(state, displayIndex);
}

/** 결과를 확인하고 카드를 넘긴다 */
export function proceed(state: GameState): void {
  if (state.phase !== 'event' || !state.card) return;
  if ((state.card.choices.length > 0) && !state.card.result) return;
  dismissCard(state);
  advance(state);
}

export function doActivity(state: GameState, id: string): ActivityResult | null {
  const result = performActivity(state, id);
  if (result?.queuedCard) advance(state);
  return result;
}

export interface ActionResult {
  ok: boolean;
  text: string;
  changes?: Change[];
}

export function applyForJob(state: GameState, jobId: string): ActionResult {
  const ch = state.ch;
  const job = JOB_BY_ID.get(jobId);
  if (!job || state.phase !== 'action') return { ok: false, text: '지원할 수 없다.' };
  if (ch.career.appliedThisYear.includes(jobId)) return { ok: false, text: '올해는 이미 지원했다.' };
  if (!jobOpenings(state).some((o) => o.job.id === jobId)) return { ok: false, text: '지원 자격이 안 된다.' };
  ch.career.appliedThisYear.push(jobId);
  const rng = rngFor(state.seed, 'apply', ch.age, jobId);
  if (rng.chance(hireChance(state, job))) {
    if (ch.edu.status === 'university' && !ch.edu.onLeave) {
      // 졸업 전 취업: 학교는 그만둔다
      ch.edu.status = 'dropout';
    }
    takeJob(state, jobId);
    state.log.push({ year: state.year, age: ch.age, kind: 'event', title: '합격', text: `${josa(job.title, '으로/로')} 일하게 됐다. 연봉 ${formatWon(ch.career.salary)}.`, tone: 'positive', impact: 15 });
    return { ok: true, text: `합격. ${josa(job.title, '으로/로')} 출근한다.`, changes: [{ text: `직업: ${job.title}`, sign: 'good' }] };
  }
  return { ok: false, text: `${job.title} 불합격. 다음에 다시 지원할 수 있다.` };
}

export function quitJob(state: GameState): ActionResult {
  const c = state.ch.career;
  if (!c.jobId || c.business || state.phase !== 'action') return { ok: false, text: '그만둘 일이 없다.' };
  const title = c.title;
  const pay = leaveJob(state, 0);
  state.log.push({ year: state.year, age: state.ch.age, kind: 'event', title: '퇴사', text: `${josa(title ?? '일', '을/를')} 그만뒀다. 퇴직금 ${formatWon(pay)}.`, tone: 'neutral', impact: 10 });
  return { ok: true, text: `사표를 냈다. 퇴직금 ${formatWon(pay)}.` };
}

export function prepareCsat(state: GameState): ActionResult {
  const ch = state.ch;
  if (ch.age < 18 || ch.edu.status === 'university' || ch.flags.retake) return { ok: false, text: '지금은 할 수 없다.' };
  addFlag(state, 'retake', []);
  return { ok: true, text: '내년 수능에 다시 응시한다. 학원 등록을 마쳤다.' };
}

export function buyStocks(state: GameState, pct = 0.5): ActionResult {
  const r = state.ch.res;
  const amount = Math.round(Math.max(0, r.cash) * pct);
  if (amount < 100_000 || state.ch.age < 19) return { ok: false, text: '투자할 돈이 없다.' };
  r.cash -= amount;
  r.stocks += amount;
  return { ok: true, text: `주식 ${formatWon(amount)}어치를 샀다.` };
}

export function sellStocks(state: GameState): ActionResult {
  const r = state.ch.res;
  const amount = r.stocks + r.coins;
  if (amount <= 0) return { ok: false, text: '팔 주식이 없다.' };
  r.cash += amount;
  r.stocks = 0;
  r.coins = 0;
  return { ok: true, text: `전부 팔았다. ${formatWon(amount)}.` };
}

export function repayDebt(state: GameState): ActionResult {
  const r = state.ch.res;
  const amount = Math.min(Math.max(0, r.cash), r.debt);
  if (amount <= 0) return { ok: false, text: r.debt > 0 ? '갚을 돈이 없다.' : '빚이 없다.' };
  r.cash -= amount;
  r.debt -= amount;
  if (r.debt <= 0) removeFlag(state, 'credit_default', []);
  return { ok: true, text: `빚 ${formatWon(amount)}을 갚았다.` };
}

export { homePrice };

export function buyHome(state: GameState): ActionResult {
  const ch = state.ch;
  const price = homePrice(state);
  if (ch.age < 25 || ch.flags.homeowner) return { ok: false, text: '지금은 집을 살 수 없다.' };
  // 계약금 30%와 소득 대비 대출 한도 중 더 많이 드는 쪽만큼 현금이 있어야 한다
  const maxLoan = Math.min(mortgageLimit(state), Math.round(price * 0.7));
  const needCash = price - maxLoan;
  if (ch.res.cash < needCash) {
    if (annualIncome(state) <= 0) return { ok: false, text: `소득이 없으면 주택담보대출이 나오지 않는다. 집값 ${formatWon(price)}을 현금으로 내야 한다.` };
    return { ok: false, text: `대출은 ${formatWon(maxLoan)}까지 나온다. 현금 ${formatWon(needCash)}이 필요하다.` };
  }
  const loan = Math.max(0, price - Math.min(ch.res.cash, price));
  ch.res.cash -= price - loan;
  ch.res.debt += loan;
  ch.res.realEstate += price;
  const changes: Change[] = [];
  addFlag(state, 'homeowner', changes);
  ch.family.livesWithParents = false;
  state.log.push({ year: state.year, age: ch.age, kind: 'event', title: '내 집 마련', text: `${REGION_BY_ID.get(ch.region)?.short ?? ''}에 ${formatWon(price)}짜리 집을 샀다. 대출 ${formatWon(loan)}.`, tone: 'positive', impact: 20 });
  return { ok: true, text: `등기를 마쳤다. 대출 ${formatWon(loan)}.`, changes };
}

export function sellHome(state: GameState): ActionResult {
  const ch = state.ch;
  if (!ch.flags.homeowner || ch.res.realEstate <= 0) return { ok: false, text: '팔 집이 없다.' };
  const value = ch.res.realEstate;
  ch.res.cash += value;
  ch.res.realEstate = 0;
  removeFlag(state, 'homeowner', []);
  return { ok: true, text: `집을 ${formatWon(value)}에 팔았다.` };
}

/** 관계 탭: 한 사람과 시간을 보낸다 (1포인트) */
export function spendTime(state: GameState, npcId: string): ActionResult {
  const ch = state.ch;
  const npc = ch.npcs.find((n) => n.id === npcId && n.alive);
  if (!npc || state.phase !== 'action' || state.points.left < 1) return { ok: false, text: '시간이 없다.' };
  state.points.left -= 1;
  state.actions.together = (state.actions.together ?? 0) + 1;
  const rng = rngFor(state.seed, 'together', ch.age, npcId, state.actions.together);
  const gain = rng.int(6, 12);
  npc.closeness = Math.min(100, npc.closeness + gain);
  const changes: Change[] = [{ text: `${npc.name} 친밀도 +${gain}`, sign: 'good' }];
  changeAttr(state, 'happiness', 2, changes);
  changeAttr(state, 'stress', -3, changes);
  return { ok: true, text: `${josa(npc.name, '와/과')} 시간을 보냈다.`, changes };
}

// ── 진행 ─────────────────────────────────────────────────

/**
 * 대기열을 처리한다. 사건을 차례로 일으키다가 결정이 필요한 카드가 뜨면 멈추고 플레이어를 기다린다.
 * 카드 없이 기록만 남는 사건은 그대로 다음으로 넘어간다. 대기열이 비면 다음 단계로
 */
function advance(state: GameState): void {
  // 무한 루프 방지: 한 번에 처리할 수 있는 해는 넉넉히 200년
  for (let guard = 0; guard < 200; guard++) {
    if (!state.ch.alive) return die(state);
    while (state.queue.length > 0) {
      const next = state.queue.shift()!;
      if (presentCard(state, next)) return;
    }
    if (!state.ch.alive) return die(state);
    if (state.step === 'yearStart') {
      state.phase = 'action';
      return;
    }
    // 4단계 끝 → 5, 6, 다음 해 1, 2
    const pending = finishYear(state);
    if (!state.ch.alive) return die(state);
    startYear(state, pending);
  }
}

function finishYear(state: GameState): PendingCard[] {
  const rng = rngFor(state.seed, 'yearend', state.ch.age);
  const pending = settleYear(state, rng);
  // 6단계: 사망 판정
  const deathRng = rngFor(state.seed, 'death', state.ch.age);
  if (state.ch.alive && deathRng.chance(deathProbability(state.ch) + warHazard(state))) {
    killCharacter(state, state.world.war.active && deathRng.chance(0.4) ? '전쟁 중 사망' : pickCause(state.ch, deathRng));
  }
  return pending;
}

/** 전쟁 중 민간인 피해. 전방 지역이 더 위험하다 */
function warHazard(state: GameState): number {
  if (!state.world.war.active) return 0;
  const region = REGION_BY_ID.get(state.ch.region);
  return region?.risks.includes('front') ? 0.006 : 0.002;
}

function startYear(state: GameState, pending: PendingCard[]): void {
  const ch = state.ch;
  state.year += 1;
  ch.age += 1;
  state.log.push(...updateWorld(state, rngFor(state.seed, 'world', state.year)));
  const max = timePointsFor(state);
  state.points = { max, left: max };
  state.actions = {};
  ch.career.appliedThisYear = [];
  syncDerivedFlags(state);
  const due = state.scheduled.filter((s) => s.atAge <= ch.age);
  state.scheduled = state.scheduled.filter((s) => s.atAge > ch.age);
  state.queue = [
    ...pending,
    ...milestonesFor(state),
    ...due.map((s) => ({ eventId: s.eventId, ctx: s.ctx })),
  ];
  state.step = 'yearStart';
}

function die(state: GameState): void {
  const ch = state.ch;
  state.queue = [];
  state.card = undefined;
  state.phase = 'dead';
  if (!state.summary) {
    state.log.push({
      year: state.year,
      age: ch.age,
      kind: 'death',
      title: '사망',
      text: `${state.year}년, ${ch.age}세. 사인: ${ch.death?.cause ?? '알 수 없음'}.`,
      tone: 'tragedy',
      impact: 100,
    });
    state.summary = buildSummary(state);
  }
}

/** 파생 태그: 상태에서 바로 정해지는 것들 */
export function syncDerivedFlags(state: GameState): void {
  const ch = state.ch;
  const unemployed =
    ch.age >= 19 &&
    ch.age < 65 &&
    !ch.career.jobId &&
    !ch.career.retired &&
    !['high', 'university'].includes(ch.edu.status) &&
    ch.military.status !== 'serving' &&
    !inPrison(state);
  if (unemployed && !ch.flags.unemployed) ch.flags.unemployed = { since: ch.age };
  if (!unemployed) delete ch.flags.unemployed;
}

// ── 5단계 연말 결산 ──────────────────────────────────────

const ALLOWANCE_FACTOR = [0, 0.5, 0.8, 1, 1.4, 2, 10];

/** 학교 유형별 평소 스트레스 */
const HIGH_STRESS: Record<HighType, number> = {
  general: 45,
  foreign: 55,
  autonomous: 55,
  gifted: 58,
  science: 58,
  arts: 50,
  sports: 50,
  vocational: 35,
  meister: 38,
  alternative: 30,
};

/** 최소 생활비: 1인 가구 연 900만 원(2026)에 지역 물가와 가구원 수를 곱한다 */
function essentialCost(state: GameState): number {
  const ch = state.ch;
  const region = REGION_BY_ID.get(ch.region);
  let household = 1;
  if (alive(ch, 'spouse').length > 0) household += 0.6;
  household += alive(ch, 'child').filter((c) => state.year - c.birthYear < 25).length * 0.45;
  return 9_000_000 * state.world.economy.priceIndex * (region?.costIndex ?? 1) * household;
}

/**
 * 생활비. 사람은 버는 만큼 쓴다: 최소 생활비 + 그 이상 번 돈의 55%.
 * 부모와 사는 학생·청년은 부모가 낸다.
 */
function livingCost(state: GameState, income: number): number {
  const ch = state.ch;
  if (inPrison(state) || ch.military.status === 'serving') return 0;
  if (ch.age < 19 && ch.family.type !== 'facility') return 0;
  if (ch.age < 18) return 0;
  const essential = essentialCost(state);
  if (ch.family.livesWithParents) {
    const student = ch.edu.status === 'university' || ch.flags.retake;
    if (ch.age < 25 || student) return 0;
    return Math.round(essential * 0.3 + Math.max(0, income) * 0.2);
  }
  let cost = essential + 0.55 * Math.max(0, income - essential);
  if (ch.flags.homeowner) cost -= essential * 0.25;
  return Math.round(cost);
}

function tuition(state: GameState): number {
  const ch = state.ch;
  if (ch.edu.status !== 'university' || ch.edu.onLeave) return 0;
  const total = 7_000_000 * state.world.economy.priceIndex;
  const w = ch.family.wealth;
  const scholarship = w <= 2 ? 0.7 : w === 3 ? 0.3 : 0;
  const parents = w >= 4 ? 1 : w === 3 ? 0.5 : 0;
  return Math.round(total * (1 - scholarship) * (1 - parents));
}

function settleYear(state: GameState, rng: Rng): PendingCard[] {
  const ch = state.ch;
  const noChanges: Change[] = [];
  const pending: PendingCard[] = [];

  // 학업: 내신과 누적 공부
  if (['elementary', 'middle', 'high'].includes(ch.edu.status)) {
    // 내신은 상대평가: 특목고·자사고·영재학교에서는 같은 실력이어도 등급이 낮게 나온다
    const competition = ch.edu.status === 'high' && ch.edu.highType && ELITE_HIGH.includes(ch.edu.highType) ? 12 : 0;
    const target =
      ch.stats.intelligence * 0.6 +
      ch.personality.conscientiousness * 0.25 +
      ch.edu.studyThisYear * 6 -
      competition +
      rng.normal(0, 8);
    ch.edu.grade = Math.max(0, Math.min(100, Math.round(ch.edu.grade * 0.6 + target * 0.4)));
    if (ch.edu.status === 'high') ch.edu.highStudy += ch.edu.studyThisYear;
  }
  ch.edu.studyThisYear = 0;
  if (ch.edu.status === 'high' && ch.age >= 18) {
    ch.edu.status = 'graduated';
    ch.edu.degree = 'high';
  }

  // 성장·노화·건강
  const aging = agingDeltas(ch.age);
  changeAttr(state, 'stamina', aging.stamina, noChanges);
  changeAttr(state, 'looks', aging.looks, noChanges);
  changeAttr(state, 'intelligence', aging.intelligence, noChanges);
  changeAttr(state, 'health', yearlyHealthDelta(ch, rng), noChanges);

  // 행복·스트레스: 성격이 정한 기준점으로 천천히 돌아간다
  const baseHappy = 58 + (ch.personality.extraversion - 50) * 0.1 - (ch.personality.neuroticism - 50) * 0.15;
  let happy = (baseHappy - ch.stats.happiness) * 0.25;
  if (alive(ch, 'spouse').length > 0) happy += 2;
  if (ch.flags.unemployed) happy -= 4;
  if (ch.state.stress > 70) happy -= 4;
  if (alive(ch, 'friend').length === 0 && ch.age >= 7) happy -= 2;
  if (ch.flags.has_pet) happy += 1.5;
  if (ch.flags.ptsd) happy -= 2;
  changeAttr(state, 'happiness', happy + rng.normal(0, 3), noChanges);

  const job = ch.career.jobId ? JOB_BY_ID.get(ch.career.jobId) : undefined;
  const baseStress = inPrison(state)
    ? 65
    : ch.military.status === 'serving'
      ? 55
      : job
        ? job.stress
        : ch.edu.status === 'high'
          ? HIGH_STRESS[ch.edu.highType ?? 'general'] + (ch.age >= 18 ? 15 : 0)
          : ch.edu.status === 'middle'
            ? 35
            : ch.flags.unemployed
              ? 40
              : ch.career.retired
                ? 20
                : 25;
  changeAttr(state, 'stress', (baseStress - ch.state.stress) * 0.35, noChanges);
  changeAttr(state, 'reputation', (5 - ch.state.reputation) * 0.05, noChanges);
  changeAttr(state, 'mental', (50 - ch.hidden.mental) * 0.05, noChanges);
  if (alive(ch, 'friend').length === 0 && ch.age >= 7) changeAttr(state, 'sociability', -0.5, noChanges);

  // 술·담배·약물: 습관 비용, 의존·갈망, 치료, 재발 (기록이 없으면 아무 일도 없다. 난수는 따로 쓴다)
  pending.push(...substanceYearEnd(state));

  // 돈
  const r = ch.res;
  const pi = state.world.economy.priceIndex;
  let income = yearlyEarnings(state, rng);
  if (ch.military.status === 'serving') income += Math.round(12_000_000 * pi);
  if (ch.age >= 7 && ch.age < 19 && ch.family.type !== 'facility') {
    const monthly = ch.age <= 12 ? 20_000 : ch.age <= 15 ? 50_000 : 80_000;
    income += Math.round(monthly * 12 * 0.3 * ALLOWANCE_FACTOR[ch.family.wealth] * pi);
  }
  // 기초생활보장: 소득과 모아 둔 돈이 최소 생활비에 못 미치면 생계급여
  const essential = essentialCost(state);
  let welfare = 0;
  if (
    ch.age >= 19 &&
    !inPrison(state) &&
    ch.military.status !== 'serving' &&
    !ch.family.livesWithParents &&
    income < essential &&
    r.cash + r.stocks < essential
  ) {
    welfare = Math.round(essential - Math.max(0, income));
    income += welfare;
  }
  const expenses = livingCost(state, income) + tuition(state);
  r.cash += income - expenses;
  if (r.debt > 0) {
    const interest = Math.round(r.debt * (state.world.economy.interest + 2.5) / 100);
    if (r.cash >= interest) r.cash -= interest;
    else r.debt += interest;
  }
  if (r.cash < 0) {
    r.debt += -r.cash;
    r.cash = 0;
  }
  const phase = state.world.economy.phase;
  const stockMean = { boom: 0.15, normal: 0.06, recession: -0.1, crisis: -0.3 }[phase];
  r.stocks = Math.max(0, Math.round(r.stocks * (1 + stockMean + rng.normal(0, 0.2))));
  r.coins = Math.max(0, Math.round(r.coins * Math.exp(rng.normal(0.02, 0.7))));
  const housing = { boom: 0.08, normal: 0.03, recession: -0.03, crisis: -0.1 }[phase];
  r.realEstate = Math.max(0, Math.round(r.realEstate * (1 + housing + rng.normal(0, 0.03))));
  r.network = Math.max(0, r.network - 1);

  const unsecured = r.debt - r.realEstate * 0.7;
  if (unsecured > Math.max(30_000_000 * pi, annualIncome(state) * 2) && r.cash < 1_000_000 * pi) {
    addFlag(state, 'credit_default', noChanges);
  } else if (unsecured <= 0) {
    removeFlag(state, 'credit_default', noChanges);
  }
  if (r.debt <= 0) removeFlag(state, 'gambling_debt', noChanges);

  // 관계: NPC 노화와 죽음
  const parentsBefore = alive(ch, 'mother', 'father').length;
  pending.push(...npcYear(state, rng));
  const parentsAfter = alive(ch, 'mother', 'father').length;
  if (parentsAfter < parentsBefore) ch.flags.parent_died_recent = { since: ch.age, until: ch.age + 1 };
  if (parentsBefore > 0 && parentsAfter === 0 && ch.family.type !== 'facility') {
    pending.push(inheritanceCard(state));
    ch.family.livesWithParents = false;
  }

  // 정년퇴직을 이미 겪은 뒤 다시 얻은 일자리는 그 직업의 정년이 되면 조용히 끝난다
  const job2 = ch.career.jobId ? JOB_BY_ID.get(ch.career.jobId) : undefined;
  if (job2 && !ch.career.business && ch.age + 1 >= job2.retireAge && (state.counts.mandatory_retirement ?? 0) > 0) {
    const title = ch.career.title;
    leaveJob(state, 0);
    state.log.push({ year: state.year, age: ch.age, kind: 'event', title: '마지막 근무', text: `나이 때문에 ${title} 일을 그만뒀다.`, tone: 'neutral', impact: 5 });
  }

  // 기한이 지난 태그는 사라진다
  for (const [id, f] of Object.entries(ch.flags)) {
    if (f.until !== undefined && ch.age >= f.until) delete ch.flags[id];
  }

  // 올해 한 일 한 줄 요약: 가장 많이 한 활동 세 가지와 돈
  const acts = Object.entries(state.actions).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const round = (x: number) => Math.round(x / 10_000) * 10_000;
  const moneyLine =
    ch.age >= 19 && (income !== 0 || expenses !== 0)
      ? ` 수입 ${formatWon(round(income))}${welfare > 0 ? '(생계급여 포함)' : ''}, 지출 ${formatWon(round(expenses))}.`
      : '';
  if (acts.length > 0 || moneyLine) {
    const labelled = acts.map(([id, n]) => (n > 1 ? `${ACTIVITY_LABEL(id)} ${n}번` : ACTIVITY_LABEL(id))).join(', ');
    state.log.push({
      year: state.year,
      age: ch.age,
      kind: 'year',
      text: `${labelled ? `${labelled}.` : ''}${moneyLine}`.trim(),
    });
  }

  directorYearEnd(state);
  return pending;
}

function ACTIVITY_LABEL(id: string): string {
  if (id === 'together') return '함께 시간 보내기';
  return ACTIVITY_BY_ID.get(id)?.name ?? id;
}

/** 마지막 부모가 떠나면 상속 카드. 상속세와 숨은 빚을 뗀 내 몫 */
function inheritanceCard(state: GameState): PendingCard {
  const ch = state.ch;
  const pi = state.world.economy.priceIndex;
  const estate = Math.round(ch.family.estate * pi);
  const tax = Math.max(0, estate - 500_000_000 * pi) * 0.35;
  const heirs = alive(ch, 'sibling').length + 1;
  const net = Math.round((estate - tax - ch.family.hiddenDebt) / heirs);
  return { eventId: 'inheritance', ctx: { inheritance: String(net), 상속액: signedWon(net) } };
}
