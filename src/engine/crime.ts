// 범죄 피해·목격·지원 사건 (Codex U-002)
//
//   발생(장면 카드) → 대응 선택 → 기관 처리 → 오래 남는 영향과 회복
//
// 한 사건은 사건 번호(caseId)로, 사람은 참여자 번호(personId)로 이어진다. 가족·연인·배우자처럼 이미 있는
// 사람이면 NPC id를 함께 적는다. 단계마다 상태를 따로 둔다:
//   신고(없음·즉시·지연) / 경찰 수사 / 검찰 처분(기소·약식·기소유예·불기소·공소권 없음·소년부) / 재판 / 판결
//   / 조직 처리(직장 고충·학교·대학 인권센터)와 징계 / 행정 진정(고용노동부·노동위원회·국가인권위원회)
//   / 민사 손해배상 / 보호조치(스토킹 잠정조치·가정폭력 임시조치·신변보호) / 상담·치료 / 회복
//
// 원칙
//  - 신고·대면을 강요하지 않는다. 피하기·도움 요청·상담·기록·조직 내 제기·이동·미루기가 모두 길이다.
//    신고하지 않은 사건도 있었던 사실과 회복이 남고, 공소시효 안이면 몇 년 뒤에도 신고할 수 있다.
//  - 기관은 느리거나(수사 지연) 틀리거나(증거 부족 불송치·2차 피해) 도움이 될 수 있다.
//  - 피해 때문에 도덕성·평판이 깎이지 않는다. 회복은 지원·상담·시간에 따라 달라지고 평생 고정되지 않는다.
//  - 성범죄·성희롱은 본인이 만 19세 이상일 때만 생긴다 (피해·목격·지원 모두, 지원 대상도 성인).
//    미성년자에게는 절도·온라인 사기·온라인 괴롭힘·갈취와 폭력 목격만 생기고 보호·신고 경로가 붙는다.
//    플레이어가 성범죄를 저지르는 선택지는 없다. 서술은 행위를 묘사하지 않고 대응과 그 뒤를 다룬다.
//
// 난수는 'crime' 이름표의 줄기만 쓴다 (사건마다, 단계마다 따로). 기록은 ch.crime 한 곳에 있고
// 옛 저장에는 없다 (읽을 때 빈 기록으로 본다).

import crimeJson from '../../data/catalog/crime.json';
import {
  CATEGORY,
  CRIME_ACTS,
  CRIME_STEPS,
  stepEventId,
  type CrimeAct,
  type CrimeCatalog,
  type CrimeCategory,
  type CrimeRole,
  type CrimeStep,
  type OffenderKind,
  type SceneRow,
  type VictimKind,
} from './catalog/crime';
import { leaveJob } from './career';
import { changeAttr, removeFlag, type EffectContext } from './effects';
import { formatWon, signedWon } from './format';
import { payOrBorrow } from './justice';
import { alive, familySupport, npcAge, partnerOf, roleLabel, spouseOf } from './relations';
import { rngFor, type Rng } from './rng';
import type { Action } from './schema';
import { render } from './text';
import type { Change, Character, GameState, Npc } from './types';

const CATALOG = crimeJson as unknown as CrimeCatalog;
export const CRIME_SCENES: readonly SceneRow[] = CATALOG.scenes;
const SCENE_BY_ID = new Map(CATALOG.scenes.map((s) => [s.id, s]));

/** 성범죄·성희롱 사건과 성인 대상 지원이 열리는 나이 */
export const CRIME_ADULT_AGE = 19;
/** 회복도가 이만큼 오르면 '일상으로 돌아왔다'로 본다 */
const RECOVERED = 85;
/** 이 아래에서 시작한 피해는 '사건 후유증' 태그를 붙인다 */
const AFTERMATH_BELOW = 60;
const AFTERMATH_TAG = 'crime_aftermath';
/** 이 아래에서 시작한 사건만 회복 기록을 남긴다 */
const NOTABLE_BELOW = 70;
const PROTECTED_TAG = 'protective_order';

// ── 기록 ─────────────────────────────────────────────────

export type ReportState = 'none' | 'immediate' | 'delayed';
export type PoliceState = 'none' | 'investigating' | 'referred' | 'no_suspect' | 'not_sent';
export type ProsecutionState = 'none' | 'indicted' | 'summary' | 'deferred' | 'dropped' | 'no_right' | 'juvenile';
export type VerdictState = 'none' | 'prison' | 'suspended' | 'fine' | 'acquitted' | 'dismissed';
export type InternalState = 'none' | 'raised' | 'action' | 'no_action' | 'retaliation' | 'ended';

/** 사건에 나오는 사람. 같은 사람은 여러 사건에서 같은 id다 */
export interface CrimePerson {
  id: string;
  /** 화면 호칭 (예: '같은 팀 과장', '처음 보는 남자', NPC면 이름) */
  label: string;
  kind: OffenderKind | VictimKind;
  /** 기존 NPC와 같은 사람이면 그 id */
  npcId?: string;
  /** 직장에서 만난 사람이면 그때의 직업 (직장을 옮기면 더 마주치지 않는다) */
  jobId?: string;
  /** 미성년 가해자 (소년부 송치) */
  minor?: boolean;
}

export interface CaseLogEntry {
  age: number;
  step: string;
  note: string;
}

export interface CrimeCase {
  id: string;
  scene: string;
  cat: CrimeCategory;
  ctx: string;
  role: CrimeRole;
  age: number;
  year: number;
  offender: string;
  /** 'self' 또는 참여자 id */
  victim: string;
  /** 피해 정도 0~3 */
  harm: number;
  /** 금전 피해 (그해 명목 원) */
  loss: number;
  /** 주인공이 다쳤다 (목격하다 다친 경우 포함) */
  hurt?: boolean;
  /** 직장 사건이면 그때의 직업 */
  jobId?: string;
  /** 증거 0~3 (기록·캡처·진단서·CCTV·목격 진술) */
  evidence: number;
  /** 받은 지원 (가족·친구·상담 기관) */
  support: number;
  report: ReportState;
  reportAge?: number;
  reportedBy?: 'self' | 'victim' | 'bystander';
  police: PoliceState;
  /** 가해자를 특정했다 */
  identified?: boolean;
  policeDelayed?: boolean;
  prosecution: ProsecutionState;
  trial: 'none' | 'ongoing' | 'done';
  verdict: VerdictState;
  internal: InternalState;
  internalAge?: number;
  discipline: 'none' | 'disciplined' | 'not_disciplined';
  admin: 'none' | 'filed' | 'ordered' | 'dismissed';
  adminKind?: 'labor' | 'nhrck' | 'commission';
  civil: 'none' | 'filed' | 'won' | 'settled' | 'lost';
  protection: 'none' | 'granted' | 'denied' | 'violated' | 'ended';
  protectionKind?: string;
  care: 'none' | 'active' | 'done';
  /** 회복도 = base + rate × (나이 − at), 100까지. first는 사건 직후 값, k는 개인차 */
  rec: { base: number; at: number; rate: number; first: number; k: number };
  recovered?: number;
  distanced?: boolean;
  settled?: boolean;
  settleOffer?: boolean;
  testified?: boolean;
  /** 무죄 판결에 대한 항소심이 열려 있다 */
  appealTrial?: boolean;
  appeals: number;
  repeats: number;
  /** 바로 앞 재발 판정에서 다시 일이 생겼는가 (재발 카드의 선택지가 읽는다) */
  repeatNow?: boolean;
  revisits: number;
  /** 지원 역할: 피해자에게 보탠 힘 (신고·상담으로 이어질 가능성) */
  nudge?: number;
  closed?: { age: number; why: string };
  log: CaseLogEntry[];
}

export interface CrimeLedger {
  cases: CrimeCase[];
  people: CrimePerson[];
}

const EMPTY: Readonly<CrimeLedger> = Object.freeze({ cases: [], people: [] });

/** 읽기용: 기록이 없으면(사건이 없었거나 옛 저장) 빈 기록. 상태를 바꾸지 않는다 */
export function readLedger(ch: Character): Readonly<CrimeLedger> {
  return ch.crime ?? EMPTY;
}

function ledgerOf(ch: Character): CrimeLedger {
  ch.crime ??= { cases: [], people: [] };
  ch.crime.cases ??= [];
  ch.crime.people ??= [];
  return ch.crime;
}

export function findCase(ch: Character, id: string | undefined): CrimeCase | undefined {
  if (!id) return undefined;
  return readLedger(ch).cases.find((c) => c.id === id);
}

function personOf(ch: Character, id: string): CrimePerson | undefined {
  return readLedger(ch).people.find((p) => p.id === id);
}

function sceneOf(c: CrimeCase): SceneRow | undefined {
  return SCENE_BY_ID.get(c.scene);
}

export function sceneById(id: string): SceneRow | undefined {
  return SCENE_BY_ID.get(id);
}

// ── 법과 기한 (읽기 전용 판정) ───────────────────────────

/** 공소시효 (년). 가벼운 폭행은 5년, 과학적 증거가 있는 성폭력은 10년 늘어난다 (성폭력처벌법 21조 2항) */
export function limitationOf(c: CrimeCase): number {
  const rule = CATEGORY[c.cat];
  let years = sceneOf(c)?.limitation ?? rule.limitation;
  if (c.cat === 'assault' && c.harm <= 1) years = 5;
  if (c.cat === 'sexual_assault' && c.evidence >= 2) years += 10;
  return years;
}

/** 형사 절차가 있는 사건인가 (성희롱은 온라인 성적 메시지만 통신매체이용음란죄) */
export function criminalTrack(c: CrimeCase): boolean {
  const rule = CATEGORY[c.cat];
  return rule.criminal === 'yes' || CATALOG.contexts[c.ctx]?.online === true;
}

/** 친고죄 고소기간이 걸리는가 (모욕 수준의 가벼운 온라인 괴롭힘: 범인을 안 날부터 6개월) */
function complaintWindowYears(c: CrimeCase): number | undefined {
  const months = CATEGORY[c.cat].complaintMonths;
  if (months === undefined || c.harm > 1) return undefined;
  return months / 12;
}

interface OffenderStatus {
  /** 누군지 안다 (이름·관계를 알거나 경찰이 특정했다) */
  known: boolean;
  /** 살아 있다 (모르는 사람은 살아 있다고 본다) */
  alive: boolean;
  /** 관계가 끝났다 (헤어짐·연락 끊김·이혼·퇴사) */
  ended: boolean;
}

const ANONYMOUS: readonly string[] = ['stranger', 'unknown', 'online'];

function offenderStatus(state: GameState, c: CrimeCase): OffenderStatus {
  const ch = state.ch;
  const p = personOf(ch, c.offender);
  if (!p) return { known: false, alive: true, ended: true };
  const known = !ANONYMOUS.includes(p.kind) || Boolean(c.identified);
  if (p.npcId) {
    const npc = ch.npcs.find((n) => n.id === p.npcId);
    if (!npc) return { known, alive: true, ended: true };
    const ended = npc.missing === true || (p.kind === 'spouse' && npc.role !== 'spouse') || (p.kind === 'partner' && npc.role !== 'partner' && npc.role !== 'spouse');
    return { known, alive: npc.alive, ended };
  }
  if (p.jobId) return { known, alive: true, ended: ch.career.jobId !== p.jobId };
  return { known, alive: true, ended: false };
}

function victimNpc(state: GameState, c: CrimeCase): Npc | undefined {
  if (c.victim === 'self') return undefined;
  const p = personOf(state.ch, c.victim);
  return p?.npcId ? state.ch.npcs.find((n) => n.id === p.npcId) : undefined;
}

function yearsSince(state: GameState, c: CrimeCase): number {
  return state.ch.age - c.age;
}

/** 지금 신고할 수 있는가: 아직 신고 전, 형사 절차가 있는 사건, 공소시효·고소기간 안, 가해자가 살아 있다 */
export function canReport(state: GameState, c: CrimeCase): boolean {
  if (c.report !== 'none' || c.role === 'supporter' || !criminalTrack(c)) return false;
  const years = yearsSince(state, c);
  if (years > limitationOf(c)) return false;
  const window = complaintWindowYears(c);
  if (window !== undefined && years >= 1) return false;
  return offenderStatus(state, c).alive;
}

/** 민사 손해배상: 가해자를 알고, 안 날부터 3년·사건부터 10년 안 (민법 766조) */
export function canCivil(state: GameState, c: CrimeCase): boolean {
  if (c.civil !== 'none' || c.role !== 'victim') return false;
  const off = offenderStatus(state, c);
  if (!off.known) return false;
  const since = yearsSince(state, c);
  const knewAt = c.identified && c.reportAge !== undefined ? c.reportAge : c.age;
  return since <= 10 && state.ch.age - knewAt <= 3;
}

function orgOf(c: CrimeCase): string | undefined {
  return CATALOG.contexts[c.ctx]?.org;
}

/** 조직에 문제를 제기할 수 있는가: 아직 그 직장·학교·대학에 있다 */
function canInternal(state: GameState, c: CrimeCase): boolean {
  if (c.internal !== 'none' || c.role === 'supporter') return false;
  const ch = state.ch;
  switch (orgOf(c)) {
    case 'work':
      return Boolean(ch.career.jobId) && ch.career.jobId === c.jobId;
    case 'school':
      return ch.age < 19 && ['elementary', 'middle', 'high'].includes(ch.edu.status);
    case 'univ':
      return ch.edu.status === 'university';
  }
  return false;
}

/** 고용노동부 진정: 직장 안의 성희롱·괴롭힘. 사업주 조치 의무 위반의 과태료 제척기간 5년 (질서위반행위규제법 19조) */
function canLabor(state: GameState, c: CrimeCase): boolean {
  return c.role === 'victim' && orgOf(c) === 'work' && c.admin === 'none' && yearsSince(state, c) <= 5;
}

/** 국가인권위원회 진정: 성희롱은 차별행위, 사건부터 1년 안 (국가인권위원회법 32조) */
function canNhrck(state: GameState, c: CrimeCase): boolean {
  return c.role === 'victim' && c.cat === 'sexual_harassment' && c.admin === 'none' && yearsSince(state, c) < 1;
}

/** 노동위원회 시정 신청: 신고 뒤 불리한 처우를 받은 날부터 6개월 (남녀고용평등법 26조) */
function canCommission(state: GameState, c: CrimeCase): boolean {
  return c.internal === 'retaliation' && c.admin === 'none' && c.internalAge === state.ch.age;
}

/** 보호조치를 청할 수 있는가. 가정폭력은 집 안의 목격자(자녀)도 보호 대상이다 */
function canProtect(state: GameState, c: CrimeCase): boolean {
  if (!CATEGORY[c.cat].protection || c.protection === 'granted') return false;
  if (c.role === 'witness' && c.cat !== 'domestic') return false;
  return offenderStatus(state, c).alive;
}

// ── 회복 ─────────────────────────────────────────────────

/** 지금의 회복도 0~100 */
export function recoveryAt(c: CrimeCase, age: number): number {
  return Math.max(0, Math.min(100, Math.round(c.rec.base + c.rec.rate * Math.max(0, age - c.rec.at))));
}

/** 가해자가 아직 가까이 있고 막아 줄 것이 없는가 */
function threatOngoing(state: GameState, c: CrimeCase): boolean {
  if (!CATEGORY[c.cat].ongoing) return false;
  const off = offenderStatus(state, c);
  return off.alive && !off.ended && !c.distanced && c.protection !== 'granted';
}

/** 회복 속도 (년당). 지원·상담·가족의 지지가 빠르게 하고, 위협이 이어지면 느려진다. 아무리 느려도 3은 된다 */
function recoveryRate(state: GameState, c: CrimeCase): number {
  const ch = state.ch;
  let r = 5 + 3 * Math.min(3, c.support) + (c.care === 'active' ? 6 : c.care === 'done' ? 3 : 0);
  if (c.role !== 'supporter') r += familySupport(ch) / 25 + (ch.hidden.mental - 50) / 25;
  if (threatOngoing(state, c)) r -= 3;
  return Math.max(3, Math.round(r * c.rec.k * 10) / 10);
}

/** 이 사건 때문에 회복이 끝나는 나이 (이미 끝났으면 undefined) */
function recoveredAge(c: CrimeCase): number | undefined {
  if (c.recovered !== undefined || c.rec.base >= RECOVERED) return undefined;
  return c.rec.at + Math.max(1, Math.ceil((RECOVERED - c.rec.base) / c.rec.rate));
}

/** 회복 곡선을 지금 시점에서 다시 잡는다 (지원·상담·위협이 바뀌었을 때, 재발로 delta만큼 떨어졌을 때) */
function rebase(s: Session, delta = 0): void {
  const { state, c } = s;
  const age = state.ch.age;
  c.rec.base = Math.max(5, Math.min(100, recoveryAt(c, age) + delta));
  c.rec.at = age;
  c.rec.rate = recoveryRate(state, c);
  if (c.recovered !== undefined && c.rec.base < RECOVERED) c.recovered = undefined;
  // 회복 예정 카드는 사건마다 하나만: 예전 예정은 지우고 새 예정을 넣는다
  dropScheduled(s, 'recovered');
  const at = recoveredAge(c);
  // 가벼운 일(처음 회복도가 높았던 사건)은 따로 '일상으로 돌아왔다' 기록을 남기지 않는다
  if (at !== undefined && c.rec.first < NOTABLE_BELOW) schedule(s, 'recovered', at - age);
  syncAftermathTag(state);
}

/** '사건 후유증' 태그: 무거운 피해에서 아직 회복 중인 사건이 있으면, 가장 늦게 끝날 나이까지 */
function syncAftermathTag(state: GameState): void {
  const ch = state.ch;
  let until: number | undefined;
  for (const c of readLedger(ch).cases) {
    if (c.role === 'supporter' || c.rec.first >= AFTERMATH_BELOW) continue;
    const at = recoveredAge(c);
    if (at !== undefined && at > ch.age) until = Math.max(until ?? 0, at);
  }
  if (until === undefined) {
    removeFlag(state, AFTERMATH_TAG, []);
    return;
  }
  ch.flags[AFTERMATH_TAG] = { since: ch.flags[AFTERMATH_TAG]?.since ?? ch.age, until };
}

function syncProtectedTag(state: GameState): void {
  const on = readLedger(state.ch).cases.some((c) => c.protection === 'granted' && !c.closed);
  if (on && !state.ch.flags[PROTECTED_TAG]) state.ch.flags[PROTECTED_TAG] = { since: state.ch.age };
  if (!on) removeFlag(state, PROTECTED_TAG, []);
}

// ── 진행 도구 ────────────────────────────────────────────

interface Session {
  state: GameState;
  c: CrimeCase;
  ctx: Record<string, string>;
  rng: Rng;
  changes: Change[];
}

function note(s: Session, step: string, text: string): void {
  s.c.log.push({ age: s.state.ch.age, step, note: text });
}

/** 결과 문장 고르기: '키.장면'이 있으면 그것, 피해자는 '키.범주' → '키', 목격·지원은 '키.역할' → '키.범주' → '키' 순서 */
function template(s: Session, key: string): string | undefined {
  const general = s.c.role === 'victim' ? [`${key}.${s.c.cat}`, key] : [`${key}.${s.c.role}`, `${key}.${s.c.cat}`, key];
  const keys = [`${key}.${s.c.scene}`, ...general];
  for (const k of keys) {
    const list = CATALOG.outcomes[k];
    if (list && list.length > 0) return s.rng.pick(list);
  }
  return undefined;
}

/** 결과 문장을 {결과}에 덧붙인다 */
function say(s: Session, key: string, extra: Record<string, string> = {}): void {
  const t = template(s, key);
  if (!t) return;
  const text = render(t, s.state, { ...s.ctx, ...extra });
  s.ctx.결과 = s.ctx.결과 ? `${s.ctx.결과} ${text}` : text;
}

/** 이어지는 카드에 넘기는 값: 사건 번호와 호칭만 (다른 카드의 값이 섞이지 않게 새로 만든다) */
function followCtx(s: Session): Record<string, string> {
  const ch = s.state.ch;
  const out: Record<string, string> = { caseId: s.c.id, 혐의: CATEGORY[s.c.cat].label };
  const off = personOf(ch, s.c.offender);
  if (off) out.상대 = off.label;
  const vic = s.c.victim === 'self' ? undefined : personOf(ch, s.c.victim);
  if (vic) out.지인 = vic.label;
  return out;
}

/** n년 뒤 단계 카드를 예약한다 (같은 사건·단계·해에 이미 있으면 다시 넣지 않는다) */
function schedule(s: Session, step: CrimeStep, inYears: number): void {
  const eventId = stepEventId(step);
  const atAge = s.state.ch.age + Math.max(1, Math.round(inYears));
  const dup = s.state.scheduled.some((x) => x.eventId === eventId && x.atAge === atAge && x.ctx.caseId === s.c.id);
  if (!dup) s.state.scheduled.push({ eventId, atAge, ctx: followCtx(s) });
}

/** 같은 해 바로 다음 카드로 (예: 경찰 송치 → 검찰 처분) */
function queueNow(s: Session, step: CrimeStep): void {
  s.state.queue.unshift({ eventId: stepEventId(step), ctx: followCtx(s) });
}

/** 지출: 가진 돈 안에서만 낸다 (피해 때문에 빚이 생기게 하지 않는다). 실제로 빠진 돈을 돌려준다 */
function lose(s: Session, amount: number, label: string): number {
  const r = s.state.ch.res;
  const paid = Math.min(Math.max(0, r.cash), Math.max(0, Math.round(amount)));
  r.cash -= paid;
  if (paid > 0) s.changes.push({ text: `${label} ${signedWon(-paid)}`, sign: 'bad' });
  return paid;
}

/** 성인이 고른 비용(이사·변호사): 모자라면 빚이 된다. 미성년자는 가진 돈까지만 */
function spend(s: Session, amount2026: number, label: string): void {
  const amount = Math.round((amount2026 * s.state.world.economy.priceIndex) / 10_000) * 10_000;
  if (amount <= 0) return;
  if (s.state.ch.age < CRIME_ADULT_AGE) {
    lose(s, amount, label);
    return;
  }
  const r = s.state.ch.res;
  const before = r.cash - r.debt;
  payOrBorrow(s.state, amount);
  s.changes.push({ text: `${label} ${signedWon(r.cash - r.debt - before)}`, sign: 'bad' });
}

function gain(s: Session, amount: number, label: string): void {
  const n = Math.round(amount / 10_000) * 10_000;
  if (n <= 0) return;
  s.state.ch.res.cash += n;
  s.changes.push({ text: `${label} ${signedWon(n)}`, sign: 'good' });
}

function won2026(s: Session, x: number): number {
  return Math.round((x * s.state.world.economy.priceIndex) / 10_000) * 10_000;
}

// ── 사람 묶기 ────────────────────────────────────────────

const DEFAULT_WHO: Partial<Record<OffenderKind, string[]>> = {
  stranger: ['처음 보는 사람'],
  acquaintance: ['아는 사람'],
  superior: ['팀장', '과장', '부장', '실장'],
  coworker: ['같은 팀 선배', '옆 팀 동료', '입사 동기'],
  customer: ['손님'],
  professor: ['지도 교수'],
  ex: ['전 연인'],
  neighbor: ['이웃'],
  online: ['익명 계정'],
  peer: ['동네 선배들'],
  unknown: ['누군가'],
};

function newPersonId(state: GameState, suffix: string): string {
  return `p${state.serial}${suffix}`;
}

function linkedPerson(led: CrimeLedger, npc: Npc, kind: OffenderKind | VictimKind, label: string): CrimePerson {
  const found = led.people.find((p) => p.npcId === npc.id);
  if (found) {
    found.label = label;
    return found;
  }
  const p: CrimePerson = { id: `p${npc.id}`, label, kind, npcId: npc.id };
  led.people.push(p);
  return p;
}

/** 가해자를 정한다. 연인·배우자·부모·전 배우자는 기존 NPC, 직장 사람은 같은 직장이면 다시 같은 사람일 수 있다 */
function bindOffender(state: GameState, scene: SceneRow, ctx: Record<string, string>, rng: Rng): CrimePerson | undefined {
  const ch = state.ch;
  const led = ledgerOf(ch);
  const kind = scene.offender;
  if (kind === 'partner' || kind === 'spouse') {
    const npc = kind === 'spouse' ? spouseOf(ch) : (partnerOf(ch) ?? spouseOf(ch));
    return npc ? linkedPerson(led, npc, kind, npc.name) : undefined;
  }
  if (kind === 'parent') {
    // 다른 쪽 부모가 피해자다 (ctx.parentId가 정해져 있으면 그쪽이 피해자)
    const parents = alive(ch, 'mother', 'father');
    const victimId = ctx.parentId;
    const candidates = parents.filter((n) => n.id !== victimId);
    // 2022 가정폭력 실태조사: 배우자 신체 폭력 피해 여 1.3%, 남 1.0% → 가해 쪽 비율로 고른다
    const npc = rng.weighted(candidates, (n) => (n.role === 'father' ? 1.3 : 1.0));
    return npc ? linkedPerson(led, npc, 'parent', roleLabel(npc, ch)) : undefined;
  }
  if (kind === 'ex' && scene.role !== 'supporter') {
    // 막 이혼한 경우에만 전 배우자 NPC와 같은 사람이다. 연애가 끝난 경우 그 사람은 NPC 목록에 남지 않는다
    const divorced = ch.flags.divorced?.since;
    const broke = ch.flags.rom_heartbroken?.since;
    if (divorced !== undefined && (broke === undefined || divorced >= broke)) {
      const exNpc = ch.npcs.filter((n) => n.role === 'ex' && n.alive).sort((a, b) => (b.since ?? 0) - (a.since ?? 0))[0];
      if (exNpc) return linkedPerson(led, exNpc, 'ex', exNpc.name);
    }
  }
  // 내 직장 사람 (지원 역할의 직장 사건은 피해자의 직장이라 내 직업과 묶지 않는다)
  const myWork = (kind === 'superior' || kind === 'coworker' || kind === 'customer') && scene.role !== 'supporter' && Boolean(ch.career.jobId);
  if (myWork) {
    // 같은 직장의 같은 사람이 다시 가해자일 수 있다 (반복 사건은 같은 사람 id로 이어진다)
    const same = led.people.filter((p) => p.kind === kind && p.jobId === ch.career.jobId);
    if (same.length > 0 && rng.chance(0.5)) return rng.pick(same);
  }
  const labels = scene.who?.length ? scene.who : (DEFAULT_WHO[kind] ?? ['누군가']);
  const p: CrimePerson = { id: newPersonId(state, 'o'), label: rng.pick(labels), kind };
  if (myWork) p.jobId = ch.career.jobId;
  if (scene.minorOffender) p.minor = true;
  led.people.push(p);
  return p;
}

/** 피해자를 정한다. 지원 역할은 카드가 고른 NPC (성범죄면 성인만), 목격은 모르는 사람 */
function bindVictim(state: GameState, scene: SceneRow, ctx: Record<string, string>, offender: CrimePerson): string | undefined {
  const ch = state.ch;
  const led = ledgerOf(ch);
  const kind: VictimKind = scene.victim ?? (scene.role === 'victim' ? 'self' : 'stranger');
  if (kind === 'self') return 'self';
  if (kind === 'stranger') {
    const label = scene.whom?.length ? scene.whom[state.serial % scene.whom.length] : '낯선 사람';
    const p: CrimePerson = { id: newPersonId(state, 'v'), label, kind: 'stranger' };
    led.people.push(p);
    return p.id;
  }
  let npc: Npc | undefined;
  if (kind === 'friend') npc = ch.npcs.find((n) => n.id === ctx.friendId && n.alive);
  else if (kind === 'sibling') npc = ch.npcs.find((n) => n.id === ctx.siblingId && n.alive);
  else if (kind === 'child') npc = ch.npcs.find((n) => n.id === ctx.childId && n.alive);
  else if (kind === 'partner') npc = partnerOf(ch) ?? spouseOf(ch);
  else if (kind === 'parent') {
    const parents = alive(ch, 'mother', 'father').filter((n) => n.id !== offender.npcId);
    npc = parents.find((n) => n.id === ctx.parentId) ?? parents[0];
  }
  if (!npc || npc.id === offender.npcId) return undefined;
  // 성범죄·성희롱의 지원 대상은 성인만 (아동·청소년 성범죄는 이 묶음에서 다루지 않는다)
  if (CATEGORY[scene.cat].sexual && npcAge(npc, state.year) < CRIME_ADULT_AGE) return undefined;
  const label = kind === 'parent' || kind === 'sibling' ? roleLabel(npc, ch) : npc.name;
  return linkedPerson(led, npc, kind, label).id;
}

// ── 사건 열기 ────────────────────────────────────────────

/** 이 나이에 이 장면이 생길 수 있는가: 성범죄·성희롱은 성인만, 미성년자는 허용된 역할만 */
export function sceneAllowed(age: number, scene: SceneRow): boolean {
  const rule = CATEGORY[scene.cat];
  if (rule.sexual && age < CRIME_ADULT_AGE) return false;
  if (age < CRIME_ADULT_AGE && !rule.minorRoles.includes(scene.role)) return false;
  return true;
}

/** 같은 가해자의 사건이 아직 이어지고 있으면 새 사건 대신 그 사건의 재발로 본다 */
function continuingCase(ch: Character, scene: SceneRow, offender: CrimePerson): CrimeCase | undefined {
  if (ANONYMOUS.includes(offender.kind)) return undefined;
  return readLedger(ch).cases.find(
    (c) => c.offender === offender.id && c.cat === scene.cat && c.role === scene.role && !c.closed && c.recovered === undefined,
  );
}

function firstRecovery(state: GameState, scene: SceneRow, harm: number, rng: Rng): number {
  const w = CATEGORY[scene.cat].weight;
  const mental = (state.ch.hidden.mental - 50) / 5;
  if (scene.role === 'witness') return Math.round(90 - 5 * w + rng.int(-5, 5));
  if (scene.role === 'supporter') return Math.round(80 - 10 * w - 5 * harm + rng.int(-8, 8));
  return Math.max(10, Math.min(95, Math.round(92 - 13 * w - 7 * harm + mental + rng.int(-8, 8))));
}

function newCase(state: GameState, scene: SceneRow, offender: CrimePerson, victim: string, rng: Rng): CrimeCase {
  const ch = state.ch;
  const [hLo, hHi] = scene.harm ?? [1, 1];
  const harm = rng.int(hLo, hHi);
  const first = firstRecovery(state, scene, harm, rng);
  // 몇 해 전 일을 이제 털어놓는 경우: 사건 나이는 그때로 (시효·지연 신고가 그때부터다)
  const ago = scene.ago ? rng.int(scene.ago[0], scene.ago[1]) : 0;
  const c: CrimeCase = {
    id: `k${state.serial}`,
    scene: scene.id,
    cat: scene.cat,
    ctx: scene.ctx,
    role: scene.role,
    age: ch.age - ago,
    year: state.year - ago,
    offender: offender.id,
    victim,
    harm,
    loss: 0,
    evidence: 0,
    support: 0,
    report: 'none',
    police: 'none',
    prosecution: 'none',
    trial: 'none',
    verdict: 'none',
    internal: 'none',
    discipline: 'none',
    admin: 'none',
    civil: 'none',
    protection: 'none',
    care: 'none',
    rec: { base: first, at: ch.age, rate: 5, first, k: Math.round(rng.float(0.75, 1.25) * 100) / 100 },
    appeals: 0,
    repeats: 0,
    revisits: 0,
    log: [{ age: ch.age, step: 'occurred', note: ago > 0 ? `${scene.id} (${ago}년 전 일)` : scene.id }],
  };
  if (orgOf(c) === 'work' && c.role !== 'supporter' && ch.career.jobId) c.jobId = ch.career.jobId;
  return c;
}

/** 사건 직후의 피해: 돈(가진 만큼만), 다친 몸과 치료비, 마음. 도덕성·평판은 건드리지 않는다 */
function immediateHarm(s: Session, scene: SceneRow): void {
  const { state, c, rng } = s;
  const w = CATEGORY[c.cat].weight;
  if (scene.loss && c.role === 'victim') {
    const amount = won2026(s, rng.int(scene.loss[0], scene.loss[1]));
    c.loss = amount;
    lose(s, amount, '피해액');
  }
  if (scene.hurt && c.role === 'victim') {
    c.hurt = true;
    changeAttr(state, 'health', -rng.int(scene.hurt[0], scene.hurt[1]), s.changes);
    lose(s, won2026(s, rng.int(10, 60) * 10_000), '치료비');
  }
  if (c.role === 'victim') {
    changeAttr(state, 'stress', 3 + 3 * w + 2 * c.harm, s.changes);
    changeAttr(state, 'happiness', -(1 + 2 * w + c.harm), s.changes);
    if (w + c.harm >= 2) changeAttr(state, 'mental', -(w + c.harm), s.changes);
  } else {
    changeAttr(state, 'stress', 2 + w, s.changes);
  }
}

/** 장면 카드가 뜨는 순간: 사건 기록을 만들고 이어질 단계를 예약한다 */
function openFromScene(state: GameState, sceneId: string | undefined, ec: EffectContext): void {
  const scene = sceneId ? SCENE_BY_ID.get(sceneId) : undefined;
  ec.ctx.결과 = '';
  if (!scene || !sceneAllowed(state.ch.age, scene)) return;
  const rng = rngFor(state.seed, 'crime', 'open', scene.id, state.ch.age, state.serial);
  const offender = bindOffender(state, scene, ec.ctx, rng);
  if (!offender) return;
  const ongoing = continuingCase(state.ch, scene, offender);
  if (ongoing) {
    const s: Session = { state, c: ongoing, ctx: ec.ctx, rng, changes: ec.changes };
    setCardCtx(s);
    repeatIncident(s);
    return;
  }
  const victim = bindVictim(state, scene, ec.ctx, offender);
  if (!victim) return;
  const c = newCase(state, scene, offender, victim, rng);
  ledgerOf(state.ch).cases.push(c);
  const s: Session = { state, c, ctx: ec.ctx, rng, changes: ec.changes };
  setCardCtx(s);
  immediateHarm(s, scene);
  rebase(s);
  if (scene.autoReport) {
    c.report = 'immediate';
    c.reportAge = state.ch.age;
    c.reportedBy = 'bystander';
    c.police = 'investigating';
    note(s, 'report', '현장 신고 (주변 사람)');
    schedule(s, c.role === 'victim' ? 'police' : 'witness', 1);
  }
  if (CATEGORY[c.cat].ongoing && c.role === 'victim') rollRepeat(s);
  if (c.role === 'supporter') schedule(s, 'support', 1);
}

/** 이 카드에서 쓸 호칭: {상대} 가해자, {혐의} 범주, {지인} 지원·목격하는 피해자 */
function setCardCtx(s: Session): void {
  const f = followCtx(s);
  s.ctx.caseId = f.caseId;
  s.ctx.혐의 = f.혐의;
  if (f.상대) s.ctx.상대 = f.상대;
  if (f.지인) s.ctx.지인 = f.지인;
}

// ── 대응 ─────────────────────────────────────────────────

type Handler = (s: Session) => void;

/** 신고하지 않은 사건은 시효 안에서 다시 꺼낼 수 있게 몇 해 뒤 돌아본다 */
function scheduleRevisit(s: Session, years: number, postponed = false): void {
  const { state, c } = s;
  if (c.role !== 'victim' || c.report !== 'none' || c.closed) return;
  // 앞으로 돌아볼 날은 하나만. 스스로 미룬 경우가 아니면 두 번까지만 돌아본다
  const id = stepEventId('revisit');
  if (state.scheduled.some((x) => x.eventId === id && x.ctx.caseId === c.id && x.atAge > state.ch.age)) return;
  if (c.revisits >= (postponed ? 6 : 2)) return;
  // 가벼운 재산 피해(무게+피해 정도 2 미만)는 스스로 미룬 경우가 아니면 다시 돌아보지 않는다
  if (!postponed && CATEGORY[c.cat].weight + c.harm < 2) return;
  // 그때 가서도 할 수 있는 일이 있을 때만 (신고·민사·노동청 진정, 상담은 한 번)
  const future = state.ch.age + years - c.age;
  const reportable = criminalTrack(c) && future <= limitationOf(c) && complaintWindowYears(c) === undefined;
  const civil = future <= 10;
  const labor = orgOf(c) === 'work' && c.admin === 'none' && future <= 5;
  if (reportable || civil || labor || (c.care === 'none' && c.revisits === 0)) schedule(s, 'revisit', years);
}

/** 신고: 시효·고소기간 안이면 접수되고 1년 뒤 수사 결과가 온다. 보호조치가 있는 범죄는 바로 판단한다 */
function doReport(s: Session): void {
  const { state, c } = s;
  if (!canReport(state, c)) {
    const why = !criminalTrack(c)
      ? 'not_crime'
      : !offenderStatus(state, c).alive
        ? 'dead'
        : complaintWindowYears(c) !== undefined && yearsSince(state, c) >= 1
          ? 'window'
          : 'expired';
    say(s, `report.${why}`);
    note(s, 'report', `신고하지 못함 (${why})`);
    return;
  }
  c.report = state.ch.age === c.age ? 'immediate' : 'delayed';
  c.reportAge = state.ch.age;
  c.reportedBy = 'self';
  c.police = 'investigating';
  note(s, 'report', c.report === 'immediate' ? '신고' : `지연 신고 (${state.ch.age - c.age}년 뒤)`);
  say(s, c.report === 'delayed' ? 'report.delayed' : 'report.filed');
  if (canProtect(state, c)) decideProtection(s);
  changeAttr(state, 'stress', 3, s.changes);
  schedule(s, c.role === 'witness' ? 'witness' : 'police', 1);
}

/** 보호조치: 스토킹 긴급응급조치→잠정조치, 가정폭력 임시조치, 교제폭력 등 신변보호 (승인 비율은 추정) */
function decideProtection(s: Session): void {
  const { state, c, rng } = s;
  const kind = CATEGORY[c.cat].protection;
  if (!kind) return;
  // 법무부 자료: 스토킹 긴급응급조치 승인율 95.8~98.4%. 신청까지 가는 비율과 다른 범죄는 추정
  const p = kind === 'stalking' ? 0.85 : kind === 'domestic' ? 0.7 : 0.75;
  const granted = rng.chance(Math.min(0.97, p + 0.04 * c.evidence));
  c.protection = granted ? 'granted' : 'denied';
  c.protectionKind = kind;
  note(s, 'protection', granted ? `보호조치 (${kind})` : '보호조치 기각');
  say(s, `protect.${granted ? 'granted' : 'denied'}.${kind}`);
  if (granted) {
    schedule(s, 'protect', 1);
    rebase(s);
  }
  syncProtectedTag(state);
}

function helperFor(state: GameState, c: CrimeCase): Npc | undefined {
  const ch = state.ch;
  const offenderNpc = personOf(ch, c.offender)?.npcId;
  const order = [...alive(ch, 'spouse', 'partner'), ...alive(ch, 'mother', 'father'), ...alive(ch, 'friend'), ...alive(ch, 'sibling')];
  return order.find((n) => n.id !== offenderNpc && npcAge(n, state.year) >= 12);
}

const HANDLERS: Partial<Record<CrimeAct, Handler>> = {
  report: doReport,
  avoid(s) {
    s.c.distanced = true;
    note(s, 'avoid', '거리 두기');
    say(s, 'avoid');
    rebase(s);
    scheduleRevisit(s, 2);
  },
  help(s) {
    const { state, c } = s;
    const npc = helperFor(state, c);
    c.support += 1;
    if (npc) {
      npc.closeness = Math.min(100, npc.closeness + 4);
      say(s, 'help', { 지인: npc.role === 'friend' || npc.role === 'partner' || npc.role === 'spouse' ? npc.name : roleLabel(npc, state.ch) });
    } else {
      say(s, state.ch.age < CRIME_ADULT_AGE ? 'help.alone.minor' : 'help.alone');
    }
    note(s, 'help', npc ? `도움 요청 (${npc.id})` : '도움 요청 (상담 전화)');
    if (state.ch.age < CRIME_ADULT_AGE && npc && (npc.role === 'mother' || npc.role === 'father')) guardianStep(s, roleLabel(npc, state.ch));
    rebase(s);
    scheduleRevisit(s, 2);
  },
  counsel(s) {
    s.c.care = 'active';
    s.c.support += 1;
    note(s, 'care', '상담 시작');
    say(s, s.state.ch.age < CRIME_ADULT_AGE ? 'counsel.minor' : 'counsel');
    rebase(s);
    scheduleRevisit(s, 3);
  },
  care(s) {
    HANDLERS.counsel!(s);
  },
  record(s) {
    s.c.evidence = Math.min(3, s.c.evidence + 1);
    note(s, 'evidence', `증거 ${s.c.evidence}`);
    say(s, 'record');
    scheduleRevisit(s, 1);
  },
  internal(s) {
    const { state, c } = s;
    if (!canInternal(state, c)) {
      say(s, 'internal.unavailable');
      return;
    }
    c.internal = 'raised';
    c.internalAge = state.ch.age;
    note(s, 'internal', `조직에 제기 (${orgOf(c)})`);
    say(s, `internal.raised.${orgOf(c)}`);
    schedule(s, 'internal', 1);
    scheduleRevisit(s, 2);
  },
  transfer(s) {
    // 남녀고용평등법 14조 4항·근로기준법 76조의3 4항: 피해 근로자가 요청하면 근무 장소 변경 등 (수락 비율은 추정)
    const ok = s.rng.chance(0.75);
    if (ok) s.c.distanced = true;
    note(s, 'transfer', ok ? '근무지 변경' : '근무지 변경 거절');
    say(s, ok ? 'transfer.ok' : 'transfer.refused');
    rebase(s);
    scheduleRevisit(s, 2);
  },
  move(s) {
    s.c.distanced = true;
    note(s, 'move', '이사');
    say(s, 'move');
    rebase(s);
    scheduleRevisit(s, 2);
  },
  quit(s) {
    const { state, c } = s;
    if (state.ch.career.jobId && !state.ch.career.business) leaveJob(state, 0);
    c.distanced = true;
    if (c.internal === 'raised') c.internal = 'ended';
    note(s, 'quit', '퇴사');
    say(s, 'quit');
    rebase(s);
  },
  postpone(s) {
    note(s, 'postpone', '미룸');
    say(s, 'postpone');
    scheduleRevisit(s, s.rng.int(1, 2), true);
  },
  confront(s) {
    const roll = s.rng.next();
    if (roll < 0.45) {
      s.c.distanced = true;
      say(s, 'confront.stopped');
    } else if (roll < 0.8) {
      say(s, 'confront.nothing');
    } else {
      changeAttr(s.state, 'stress', 6, s.changes);
      say(s, 'confront.worse');
    }
    note(s, 'confront', roll < 0.45 ? '항의 → 멈춤' : roll < 0.8 ? '항의 → 변화 없음' : '항의 → 악화');
    rebase(s);
    scheduleRevisit(s, 2);
  },
  block(s) {
    s.c.distanced = true;
    const banned = s.rng.chance(0.5);
    note(s, 'block', banned ? '차단·플랫폼 신고 (계정 정지)' : '차단·플랫폼 신고');
    say(s, banned ? 'block.banned' : 'block');
    rebase(s);
    scheduleRevisit(s, 2);
  },
  takedown(s) {
    s.c.care = 'active';
    s.c.support += 1;
    s.c.evidence = Math.min(3, s.c.evidence + 1);
    const removed = s.rng.chance(0.7);
    note(s, 'takedown', removed ? '삭제 지원 (삭제됨)' : '삭제 지원 (진행 중)');
    say(s, removed ? 'takedown.removed' : 'takedown.pending');
    rebase(s);
    scheduleRevisit(s, 2);
  },
  pay(s) {
    const { state, c, rng } = s;
    const amount = state.ch.age < CRIME_ADULT_AGE ? won2026(s, rng.int(1, 5) * 10_000) : won2026(s, rng.int(50, 300) * 10_000);
    c.loss += lose(s, amount, '건넨 돈');
    note(s, 'pay', '요구에 응함');
    say(s, 'pay');
    // 요구에 응하면 요구가 이어지는 경우가 많다 (재발 위험이 커진다)
    rollRepeat(s, 2, 1.5);
    scheduleRevisit(s, 1);
  },
  refuse(s) {
    s.c.distanced = true;
    note(s, 'refuse', '요구 거절');
    say(s, 'refuse');
    rebase(s);
    scheduleRevisit(s, 1);
  },
  intervene(s) {
    s.c.support += 1;
    s.c.evidence = Math.min(3, s.c.evidence + 1);
    note(s, 'intervene', '피해자를 도움');
    say(s, 'intervene');
  },
  hurt(s) {
    const { c, rng } = s;
    c.hurt = true;
    c.rec.first = Math.min(c.rec.first, 45);
    c.rec.base = Math.min(c.rec.base, 45);
    lose(s, won2026(s, rng.int(20, 80) * 10_000), '치료비');
    note(s, 'hurt', '돕다가 다침');
    say(s, 'hurt');
    rebase(s);
  },
  film(s) {
    s.c.evidence = Math.min(3, s.c.evidence + 1);
    note(s, 'evidence', '영상·기록');
    say(s, 'film');
  },
  comfort(s) {
    s.c.support += 1;
    note(s, 'comfort', '피해자 곁에 있음');
    say(s, 'comfort');
  },
  leave(s) {
    note(s, 'leave', '자리를 떠남');
    say(s, 'leave');
  },
  depose(s) {
    s.c.evidence = Math.min(3, s.c.evidence + 1);
    s.c.testified = true;
    changeAttr(s.state, 'stress', 2, s.changes);
    note(s, 'witness', '참고인 진술');
    say(s, 'depose');
  },
  decline(s) {
    note(s, 'witness', '진술 거절');
    say(s, 'decline');
  },
  listen(s) {
    supporterAct(s, 1, 0.1, 5, 'listen');
  },
  accompany(s) {
    supporterAct(s, 2, 0.35, 8, 'accompany');
  },
  advise(s) {
    supporterAct(s, 1, 0.2, 3, 'advise');
  },
  respect(s) {
    supporterAct(s, 1, 0.05, 4, 'respect');
  },
  object(s) {
    // 불송치 결정 이의신청 (형사소송법 245조의7): 검사에게 사건이 넘어간다. 결과는 추정 비율
    const { c, rng } = s;
    c.appeals += 1;
    const ok = rng.chance(0.3 + 0.05 * c.evidence);
    note(s, 'object', ok ? '이의신청 → 검찰 송치' : '이의신청 → 유지');
    if (ok) {
      c.police = 'referred';
      say(s, 'object.ok');
      queueNow(s, 'prosecution');
    } else {
      say(s, 'object.no');
    }
  },
  appeal(s) {
    const { c, rng } = s;
    c.appeals += 1;
    if (c.verdict === 'acquitted') {
      // 무죄 판결: 검사에게 항소 의견을 낸다. 항소심 선고는 1년 뒤
      c.trial = 'ongoing';
      c.appealTrial = true;
      note(s, 'appeal', '항소 의견');
      say(s, 'appeal.verdict');
      schedule(s, 'verdict', 1);
      return;
    }
    // 불기소·기소유예: 검찰 항고 (받아들여지는 비율은 추정)
    const ok = rng.chance(0.15 + 0.05 * c.evidence);
    note(s, 'appeal', ok ? '항고 → 재기수사·기소' : '항고 기각');
    if (ok) {
      c.prosecution = 'indicted';
      c.trial = 'ongoing';
      say(s, 'appeal.ok');
      schedule(s, 'trial', 1);
    } else {
      say(s, 'appeal.no');
    }
  },
  testify(s) {
    s.c.testified = true;
    s.c.evidence = Math.min(3, s.c.evidence + 1);
    changeAttr(s.state, 'stress', 4, s.changes);
    note(s, 'trial', '증언');
    say(s, 'testify');
    queueNow(s, 'verdict');
  },
  statement(s) {
    note(s, 'trial', '피해자 의견서');
    say(s, 'statement');
    queueNow(s, 'verdict');
  },
  settle(s) {
    const { c } = s;
    c.settled = true;
    gain(s, settlementAmount(s), '합의금');
    if (c.civil === 'none') c.civil = 'settled';
    note(s, 'trial', '합의');
    say(s, 'settle');
    queueNow(s, 'verdict');
  },
  absent(s) {
    note(s, 'trial', '불출석');
    say(s, 'absent');
    if (s.c.trial === 'ongoing') queueNow(s, 'verdict');
  },
  civil(s) {
    const { state, c } = s;
    if (!canCivil(state, c)) {
      say(s, 'civil.unavailable');
      return;
    }
    c.civil = 'filed';
    // 소득이 낮으면 대한법률구조공단 (거의 무료), 아니면 변호사 비용
    spend(s, state.ch.family.wealth <= 2 || state.ch.res.cash < 3_000_000 ? 300_000 : 3_300_000, '소송 비용');
    note(s, 'civil', '민사 소송 제기');
    say(s, 'civil.filed');
    schedule(s, 'civil', s.rng.int(1, 2));
  },
  labor(s) {
    fileAdmin(s, 'labor');
  },
  nhrck(s) {
    fileAdmin(s, 'nhrck');
  },
  commission(s) {
    fileAdmin(s, 'commission');
  },
  accept(s) {
    note(s, 'accept', '받아들임');
    say(s, 'accept');
  },
  close(s) {
    s.c.closed = { age: s.state.ch.age, why: '스스로 내려놓음' };
    note(s, 'close', '내려놓음');
    say(s, 'close');
    syncProtectedTag(s.state);
  },
  violation(s) {
    const { c } = s;
    // 잠정조치·임시조치 위반은 그 자체로 처벌 대상이다. 위반 신고 → 다시 조치 (유치 포함)
    c.protection = 'granted';
    c.evidence = Math.min(3, c.evidence + 1);
    if (c.report === 'none') {
      c.report = 'delayed';
      c.reportAge = s.state.ch.age;
      c.police = 'investigating';
      schedule(s, 'police', 1);
    }
    note(s, 'protection', '위반 신고');
    say(s, 'violation');
    schedule(s, 'protect', 1);
    syncProtectedTag(s.state);
  },
  safety(s) {
    const ok = s.rng.chance(0.85);
    s.c.protection = ok ? 'granted' : 'denied';
    s.c.protectionKind ??= 'safety';
    note(s, 'protection', ok ? '신변보호' : '신변보호 거절');
    say(s, ok ? 'safety.ok' : 'safety.no');
    if (ok) schedule(s, 'protect', 1);
    rebase(s);
    syncProtectedTag(s.state);
  },
  wait(s) {
    note(s, 'wait', '기다림');
    say(s, 'wait');
  },
};

/** 미성년자가 보호자에게 말하면 보호자가 학교나 경찰에 알리기도 한다 (아이가 원하지 않으면 강요하지 않는 보호자도 있다) */
function guardianStep(s: Session, guardian: string): void {
  const { state, c, rng } = s;
  if (!rng.chance(0.5)) return;
  if (canInternal(state, c)) {
    c.internal = 'raised';
    c.internalAge = state.ch.age;
    note(s, 'internal', '보호자가 학교에 알림');
    say(s, 'guardian.school', { 지인: guardian });
    schedule(s, 'internal', 1);
  } else if (canReport(state, c)) {
    c.report = 'immediate';
    c.reportAge = state.ch.age;
    c.reportedBy = 'victim';
    c.police = 'investigating';
    note(s, 'report', '보호자와 함께 신고');
    say(s, 'guardian.police', { 지인: guardian });
    schedule(s, c.role === 'witness' ? 'witness' : 'police', 1);
  }
}

/** 지원 역할의 선택: 피해자의 회복을 돕고, 신고·상담으로 이어질 힘을 보탠다 (결정은 피해자가 한다) */
function supporterAct(s: Session, support: number, nudge: number, closeness: number, key: string): void {
  const { state, c } = s;
  c.support += support;
  c.nudge = (c.nudge ?? 0) + nudge;
  const npc = victimNpc(state, c);
  if (npc) npc.closeness = Math.min(100, npc.closeness + closeness);
  note(s, 'support', key);
  say(s, key);
  rebase(s);
}

function fileAdmin(s: Session, kind: 'labor' | 'nhrck' | 'commission'): void {
  const { state, c } = s;
  const ok = kind === 'labor' ? canLabor(state, c) : kind === 'nhrck' ? canNhrck(state, c) : canCommission(state, c);
  if (!ok) {
    say(s, 'admin.unavailable');
    return;
  }
  c.admin = 'filed';
  c.adminKind = kind;
  note(s, 'admin', `진정 (${kind})`);
  say(s, `admin.filed.${kind}`);
  schedule(s, 'admin', 1);
}

/** 형사 합의금 (2026년 원, 추정 범위) */
function settlementAmount(s: Session): number {
  const { c, rng } = s;
  const base: Partial<Record<CrimeCategory, [number, number]>> = {
    assault: [200, 800],
    threat: [100, 300],
    dating: [300, 1000],
    domestic: [200, 600],
    stalking: [300, 1000],
    sexual_assault: [500, 3000],
    sexual_harassment: [200, 800],
    spycam: [500, 2000],
    distribution: [1000, 3000],
    deepfake: [500, 2000],
    sextortion: [300, 1000],
    cyber_harassment: [50, 300],
    trespass: [100, 300],
    vandalism: [50, 200],
  };
  const [lo, hi] = base[c.cat] ?? [100, 500];
  return won2026(s, rng.int(lo, hi) * 10_000) + Math.round(c.loss * rng.float(0.5, 1));
}

// ── 같은 사람이 다시 ─────────────────────────────────────

const REPEAT_RISK: Partial<Record<CrimeCategory, number>> = {
  stalking: 0.45,
  dating: 0.35,
  domestic: 0.4,
  threat: 0.25,
  sexual_harassment: 0.25,
  cyber_harassment: 0.3,
  extortion: 0.4,
  distribution: 0.2,
  sextortion: 0.35,
};

/** 지금의 재발 위험 (연간). 보호조치·거리 두기·관계 종료·처벌이 낮추고, 가해자가 숨지면 0 */
function repeatRisk(state: GameState, c: CrimeCase): number {
  let p = REPEAT_RISK[c.cat] ?? 0;
  const off = offenderStatus(state, c);
  if (!off.alive || c.closed) return 0;
  if (off.ended) p *= c.cat === 'stalking' || c.cat === 'dating' ? 0.5 : 0.1;
  if (c.protection === 'granted') p *= 0.3;
  if (c.internal === 'action') p *= c.discipline === 'disciplined' ? 0.3 : 0.5;
  if (c.distanced) p *= 0.5;
  if (c.verdict === 'prison') p *= 0.3;
  return p;
}

/** 앞으로 몇 해 안에 다시 일이 생길 해를 미리 정해 둔다. 그해가 되면 그사이 바뀐 보호·거리·관계를 다시 본다 */
function rollRepeat(s: Session, years = 3, factor = 1): void {
  const { state, c, rng } = s;
  if (c.repeats >= 4) return;
  const p = Math.min(0.9, repeatRisk(state, c) * factor);
  for (let k = 1; k <= years; k++) {
    if (rng.chance(p)) {
      schedule(s, 'repeat', k);
      return;
    }
  }
}

function repeatIncident(s: Session): void {
  const { state, c, rng } = s;
  c.repeats += 1;
  c.repeatNow = true;
  c.harm = Math.min(3, c.harm + (rng.chance(0.3) ? 1 : 0));
  if (c.protection === 'granted') c.protection = 'violated';
  changeAttr(state, 'stress', 6, s.changes);
  changeAttr(state, 'happiness', -3, s.changes);
  note(s, 'repeat', `다시 일어남 (${c.repeats}번째)`);
  say(s, c.protection === 'violated' ? 'repeat.violated' : 'repeat.again');
  rebase(s, -12);
  rollRepeat(s);
}

// ── 기관 단계 ────────────────────────────────────────────

/** 가해자가 숨졌으면 형사 절차는 공소권 없음으로 끝난다 (민사는 상속인을 상대로 남을 수 있다) */
function offenderDied(s: Session): boolean {
  const { state, c } = s;
  if (offenderStatus(state, c).alive) return false;
  if (c.prosecution === 'none' || c.prosecution === 'indicted') {
    c.prosecution = 'no_right';
    if (c.police === 'investigating') c.police = 'not_sent';
    if (c.trial === 'ongoing') c.trial = 'done';
    note(s, 'recheck', '가해자 사망 → 공소권 없음');
    say(s, 'recheck.dead');
  }
  if (c.protection === 'granted') c.protection = 'ended';
  syncProtectedTag(state);
  return true;
}

function policeStep(s: Session): void {
  const { state, c, rng } = s;
  if (c.police !== 'investigating' && c.police !== 'no_suspect') return;
  if (offenderDied(s)) return;
  if (!c.policeDelayed && rng.chance(0.2)) {
    // 수사가 길어진다 (인력·증거 분석·관할 이송)
    c.policeDelayed = true;
    note(s, 'police', '수사 지연');
    say(s, 'police.delay');
    schedule(s, 'police', 1);
    return;
  }
  const person = personOf(state.ch, c.offender);
  if (!c.identified) {
    const anonymous = person ? ANONYMOUS.includes(person.kind) : true;
    const p = anonymous ? Math.min(0.98, CATEGORY[c.cat].identify * (1 + 0.15 * c.evidence)) : 1;
    c.identified = rng.chance(p);
  }
  if (!c.identified) {
    const again = c.police === 'no_suspect';
    c.police = 'no_suspect';
    note(s, 'police', '피의자 특정 못 함 (수사중지)');
    say(s, again ? 'police.still_unknown' : 'police.no_suspect');
    // 다른 사건으로 뒤늦게 잡히기도 한다 (추정, 한 번만)
    if (!again && rng.chance(0.12)) schedule(s, c.role === 'victim' ? 'police' : 'news', rng.int(1, 3));
    return;
  }
  const p = 0.55 + 0.12 * c.evidence + 0.05 * c.harm + (c.hurt ? 0.1 : 0) + (c.repeats > 0 ? 0.1 : 0);
  if (rng.chance(Math.min(0.95, p))) {
    c.police = 'referred';
    note(s, 'police', '검찰 송치');
    say(s, 'police.referred');
    queueNow(s, 'prosecution');
  } else {
    c.police = 'not_sent';
    note(s, 'police', '불송치 (증거 불충분)');
    say(s, 'police.not_sent');
  }
}

function prosecutionStep(s: Session): void {
  const { state, c, rng } = s;
  if (c.police !== 'referred' || c.prosecution !== 'none') return;
  if (offenderDied(s)) return;
  const rule = CATEGORY[c.cat];
  if (rule.waivable && c.harm <= 1 && c.settled) {
    c.prosecution = 'no_right';
    note(s, 'prosecution', '처벌불원 → 공소권 없음');
    say(s, 'prosecution.waived');
    return;
  }
  if (personOf(state.ch, c.offender)?.minor) {
    c.prosecution = 'juvenile';
    note(s, 'prosecution', '소년부 송치');
    say(s, 'prosecution.juvenile');
    return;
  }
  const [ind, sum, def, drop] = rule.disposal;
  const heavy = c.harm >= 2 ? 1.6 : 1;
  const weights = [ind * heavy * (1 + 0.1 * c.repeats), sum, def / heavy, drop * Math.max(0.3, 1 - 0.2 * c.evidence)];
  const pick = rng.weighted([0, 1, 2, 3], (i) => weights[i]);
  if (pick === 0) {
    c.prosecution = 'indicted';
    c.trial = 'ongoing';
    note(s, 'prosecution', '기소');
    say(s, 'prosecution.indicted');
    schedule(s, 'trial', 1);
  } else if (pick === 1) {
    c.prosecution = 'summary';
    c.verdict = 'fine';
    c.trial = 'done';
    note(s, 'prosecution', '약식기소 (벌금)');
    say(s, 'prosecution.summary', { 벌금: formatWon(won2026(s, rng.int(10, 50) * 100_000)) });
  } else if (pick === 2) {
    c.prosecution = 'deferred';
    note(s, 'prosecution', '기소유예');
    say(s, 'prosecution.deferred');
  } else {
    c.prosecution = 'dropped';
    note(s, 'prosecution', '불기소 (혐의 없음)');
    say(s, 'prosecution.dropped');
  }
}

function trialStep(s: Session): void {
  const { c, rng } = s;
  if (c.trial !== 'ongoing') return;
  if (offenderDied(s)) return;
  c.settleOffer = c.cat !== 'random_violence' && !c.settled && rng.chance(0.5);
  note(s, 'trial', c.settleOffer ? '재판 (합의 제안)' : '재판');
  say(s, c.settleOffer ? 'trial.offer' : 'trial.open');
}

/** 선고: 무죄율·형 종류는 범주별 추정 비율. 증거·증언·피해 정도·반복·합의가 움직인다 */
function verdictStep(s: Session): void {
  const { c, rng } = s;
  if (c.trial !== 'ongoing') return;
  if (offenderDied(s)) return;
  const rule = CATEGORY[c.cat];
  const appeal = c.appealTrial === true;
  c.trial = 'done';
  c.appealTrial = false;
  if (rule.waivable && c.harm <= 1 && c.settled && !appeal) {
    c.verdict = 'dismissed';
    note(s, 'verdict', '공소기각 (처벌불원)');
    pronounce(s, 'verdict.dismissed');
    return;
  }
  let acquit = rule.acquittal * (c.evidence >= 2 ? 0.6 : c.evidence === 0 ? 1.8 : 1) * (c.testified ? 0.7 : 1);
  if (appeal) acquit = 0.8;
  if (rng.chance(acquit)) {
    c.verdict = 'acquitted';
    note(s, 'verdict', appeal ? '항소 기각 (무죄 유지)' : '무죄');
    pronounce(s, appeal ? 'verdict.appeal_lost' : 'verdict.acquitted');
    rebase(s, -5);
    return;
  }
  const [pr, su, fi] = rule.sentence;
  const heavy = (c.harm >= 2 ? 1.5 : 1) * (1 + 0.3 * c.repeats);
  const light = c.settled ? 0.6 : 1;
  const kind = rng.weighted(['prison', 'suspended', 'fine'] as const, (k) => (k === 'prison' ? pr * heavy * light : k === 'suspended' ? su : fi / heavy));
  c.verdict = kind ?? 'suspended';
  note(s, 'verdict', `유죄 (${c.verdict})`);
  pronounce(s, `verdict.${c.verdict}`, sentenceWords(s));
  // 배상명령·피해 회복 (소송촉진법 25조): 돈 피해가 있는 사건 (비율은 추정)
  if (c.loss > 0 && rng.chance(0.4)) gain(s, c.loss * rng.float(0.3, 1), '배상명령');
  rebase(s, 5);
}

/** 판결 문장: {판결}과 {결과} 둘 다에 넣는다 (선고 카드는 {결과}, 소식은 {판결}을 덧붙인다) */
function pronounce(s: Session, key: string, words: Record<string, string> = {}): void {
  const t = template(s, key);
  const text = t ? render(t, s.state, { ...s.ctx, ...words }) : '';
  s.ctx.판결 = text;
  s.ctx.결과 = s.ctx.결과 ? `${s.ctx.결과} ${text}` : text;
}

function sentenceWords(s: Session): Record<string, string> {
  const { c, rng } = s;
  const months: Partial<Record<CrimeCategory, [number, number]>> = {
    random_violence: [48, 180],
    robbery: [30, 72],
    sexual_assault: [18, 60],
    distribution: [12, 36],
    sextortion: [18, 48],
    fraud: [8, 36],
  };
  const [lo, hi] = months[c.cat] ?? [6, 18];
  const m = rng.int(lo, hi);
  return {
    형기: m >= 12 && m % 12 === 0 ? `징역 ${m / 12}년` : `징역 ${m}개월`,
    유예: `집행유예 ${rng.int(1, 3)}년`,
    벌금: formatWon(won2026(s, rng.int(3, 30) * 100_000)),
  };
}

/** 조직 처리: 직장(고충·인사)·학교(학교폭력 사안)·대학(인권센터). 2021 성희롱 실태조사: 공식 처리 시 기관 조치 92.6%, 2차 피해 20.7% */
function internalStep(s: Session): void {
  const { state, c, rng } = s;
  if (c.internal !== 'raised') return;
  c.internalAge = state.ch.age;
  if (orgOf(c) === 'work' && c.role !== 'supporter' && state.ch.career.jobId !== c.jobId) {
    c.internal = 'ended';
    note(s, 'internal', '퇴사로 조사 종결');
    say(s, 'internal.ended');
    return;
  }
  const superior = personOf(state.ch, c.offender)?.kind === 'superior';
  const action = 0.62 + 0.08 * c.evidence - (superior ? 0.1 : 0);
  const retaliation = orgOf(c) === 'work' ? Math.max(0.05, 0.16 + (superior ? 0.08 : 0) - 0.03 * c.evidence) : 0.05;
  const roll = rng.next();
  if (roll < action) {
    c.internal = 'action';
    c.distanced = true;
    c.discipline = rng.chance(0.65) ? 'disciplined' : 'not_disciplined';
    note(s, 'internal', c.discipline === 'disciplined' ? '조치 (징계)' : '조치 (분리만)');
    say(s, `internal.action.${c.discipline}`);
    rebase(s, 4);
  } else if (roll < action + retaliation) {
    c.internal = 'retaliation';
    note(s, 'internal', '2차 피해 (불리한 처우)');
    say(s, 'internal.retaliation');
    changeAttr(state, 'stress', 8, s.changes);
    rebase(s, -10);
  } else {
    c.internal = 'no_action';
    note(s, 'internal', '조치 없음');
    say(s, 'internal.no_action');
    rebase(s, -4);
  }
}

function adminStep(s: Session): void {
  const { c, rng } = s;
  if (c.admin !== 'filed') return;
  const kind = c.adminKind ?? 'labor';
  const base = kind === 'labor' ? 0.45 : kind === 'commission' ? 0.5 : 0.35;
  const p = base + 0.1 * c.evidence + (c.internal === 'no_action' || c.internal === 'retaliation' ? 0.15 : 0);
  c.admin = rng.chance(Math.min(0.9, p)) ? 'ordered' : 'dismissed';
  note(s, 'admin', `${kind} → ${c.admin}`);
  say(s, `admin.${c.admin}.${kind}`);
  if (c.admin === 'ordered') rebase(s, 4);
}

/** 민사: 형사 유죄가 있으면 이기기 쉽다. 이겨도 가해자에게 돈이 없으면 못 받기도 한다 (비율은 추정) */
function civilStep(s: Session): void {
  const { c, rng } = s;
  if (c.civil !== 'filed') return;
  const guilty = ['prison', 'suspended', 'fine'].includes(c.verdict);
  const p = 0.4 + 0.12 * c.evidence + (guilty ? 0.35 : 0) - (c.verdict === 'acquitted' ? 0.2 : 0);
  const roll = rng.next();
  if (roll < Math.min(0.92, p)) {
    c.civil = 'won';
    const paid = rng.chance(0.7);
    note(s, 'civil', paid ? '승소 (지급)' : '승소 (집행 불능)');
    say(s, paid ? 'civil.won' : 'civil.unpaid');
    if (paid) gain(s, damages(s), '손해배상');
    rebase(s, 4);
  } else if (roll < Math.min(0.97, p + 0.15)) {
    c.civil = 'settled';
    note(s, 'civil', '조정');
    say(s, 'civil.settled');
    gain(s, damages(s) * 0.6, '조정금');
  } else {
    c.civil = 'lost';
    note(s, 'civil', '패소');
    say(s, 'civil.lost');
    rebase(s, -3);
  }
}

function damages(s: Session): number {
  const { c, rng } = s;
  const solatium: Partial<Record<CrimeCategory, number>> = {
    random_violence: 2000,
    assault: 300,
    robbery: 500,
    sexual_assault: 1500,
    sexual_harassment: 500,
    spycam: 1000,
    distribution: 1500,
    deepfake: 1000,
    sextortion: 800,
    stalking: 700,
    dating: 700,
    domestic: 700,
    threat: 200,
    cyber_harassment: 200,
  };
  const man = (solatium[c.cat] ?? 100) * (1 + c.harm / 2) * rng.float(0.6, 1.3);
  return won2026(s, man * 10_000) + Math.round(c.loss * rng.float(0.5, 1));
}

/** 보호조치 1년 뒤: 지켜졌는지, 기간이 끝났는지. 위반은 다시 신고할 수 있다 */
function protectStep(s: Session): void {
  const { state, c, rng } = s;
  if (c.protection !== 'granted') return;
  const off = offenderStatus(state, c);
  if (!off.alive || off.ended) {
    c.protection = 'ended';
    note(s, 'protection', '종료 (관계 끝·사망)');
    say(s, 'protect.ended');
  } else if (rng.chance(c.cat === 'domestic' ? 0.2 : c.cat === 'stalking' ? 0.15 : 0.1)) {
    c.protection = 'violated';
    c.repeats += 1;
    note(s, 'protection', '위반');
    say(s, 'protect.violated');
    changeAttr(state, 'stress', 6, s.changes);
    rebase(s, -8);
  } else {
    c.protection = 'ended';
    note(s, 'protection', '기간 종료');
    say(s, 'protect.kept');
  }
  syncProtectedTag(state);
}

function repeatStep(s: Session): void {
  const { state, c, rng } = s;
  c.repeatNow = false;
  const base = REPEAT_RISK[c.cat] ?? 0;
  const now = repeatRisk(state, c);
  // 예약할 때보다 위험이 줄었으면 (보호조치·거리·관계 종료) 그만큼 일어나지 않는다
  if (base <= 0 || !rng.chance(now / base)) {
    note(s, 'repeat', '조용함');
    say(s, now > 0 ? 'repeat.quiet' : 'repeat.over');
    return;
  }
  repeatIncident(s);
}

function revisitStep(s: Session): void {
  const { state, c, rng } = s;
  c.revisits += 1;
  const rec = recoveryAt(c, state.ch.age);
  say(s, rec >= 70 ? 'revisit.calm' : rec >= 45 ? 'revisit.middle' : 'revisit.heavy');
  // 같은 사람에게 피해를 입은 사람이 또 있다는 소식 (추정 비율). 지금 신고하면 증거가 된다
  if (canReport(state, c) && !ANONYMOUS.includes(personOf(state.ch, c.offender)?.kind ?? 'unknown') && rng.chance(0.15)) {
    c.evidence = Math.min(3, c.evidence + 1);
    say(s, 'revisit.others');
  }
  if (!canReport(state, c) && criminalTrack(c) && yearsSince(state, c) > limitationOf(c)) say(s, 'revisit.expired');
  note(s, 'revisit', `다시 돌아봄 (${c.revisits}번째)`);
}

/** 목격자: 경찰의 참고인 진술 요청. 출석 의무는 없다 */
function witnessStep(s: Session): void {
  note(s, 'witness', '참고인 진술 요청');
  say(s, 'witness.call');
  schedule(s, 'news', 1);
}

/** 지원 역할: 피해자가 스스로 정한다. 함께 해 준 것이 신고·상담으로 이어질 가능성을 높인다 */
function supportStep(s: Session): void {
  const { state, c, rng } = s;
  const npc = victimNpc(state, c);
  if (!npc || !npc.alive || npc.missing) {
    c.closed = { age: state.ch.age, why: npc && !npc.alive ? '피해자 사망' : '피해자와 연락이 끊김' };
    note(s, 'recheck', c.closed.why);
    say(s, npc && !npc.alive ? 'support.gone' : 'support.lost');
    return;
  }
  if (c.report === 'none' && c.internal === 'none' && !criminalTrack(c)) {
    // 형사 범죄가 아닌 사건(직장 내 성희롱 등)은 피해자가 회사에 알리거나 참는다
    if (orgOf(c) && rng.chance(Math.min(0.9, 0.3 + (c.nudge ?? 0)))) {
      c.internal = 'raised';
      c.internalAge = state.ch.age;
      note(s, 'internal', '피해자가 조직에 신고');
      say(s, 'support.raised');
      schedule(s, 'news', 1);
    } else {
      note(s, 'support', '피해자가 문제 삼지 않기로 함');
      say(s, 'support.not_reported');
    }
  } else if (c.report === 'none' && criminalTrack(c)) {
    const base = CATEGORY[c.cat].sexual ? 0.12 : c.cat === 'fraud' ? 0.5 : 0.3;
    if (rng.chance(Math.min(0.9, base + (c.nudge ?? 0)))) {
      c.report = state.ch.age === c.age ? 'immediate' : 'delayed';
      c.reportAge = state.ch.age;
      c.reportedBy = 'victim';
      c.police = 'investigating';
      note(s, 'report', '피해자가 신고');
      say(s, 'support.reported');
      schedule(s, 'news', 1);
    } else {
      note(s, 'support', '피해자가 신고하지 않기로 함');
      say(s, 'support.not_reported');
    }
  } else {
    say(s, 'support.ongoing');
  }
  if (c.care === 'none' && rng.chance(0.3 + 0.1 * c.support)) {
    c.care = 'active';
    say(s, 'support.care');
  }
  rebase(s);
}

/** 목격·지원 사건의 형사 절차는 한 번에 소식으로 듣는다 (단계는 따로 기록한다) */
function newsStep(s: Session): void {
  const { c } = s;
  if (c.internal === 'raised' && c.role === 'supporter') internalStep(s);
  if (c.report === 'none') return;
  if (c.police === 'investigating' || c.police === 'no_suspect') {
    c.policeDelayed = true; // 소식으로 듣는 사건은 지연 없이
    policeStep(s);
  }
  // 송치되면 policeStep이 검찰 카드를 바로 다음에 넣는다. 소식에서는 그 자리에서 이어서 처리한다
  dropQueued(s, 'prosecution');
  if (c.police === 'referred' && c.prosecution === 'none') prosecutionStep(s);
  dropScheduled(s, 'trial');
  if (c.trial === 'ongoing') {
    c.testified ||= c.role === 'witness' && c.evidence > 0;
    verdictStep(s);
  }
  const npc = victimNpc(s.state, c);
  if (npc && c.verdict !== 'none' && c.verdict !== 'acquitted') npc.closeness = Math.min(100, npc.closeness + 2);
}

function dropQueued(s: Session, step: CrimeStep): void {
  const id = stepEventId(step);
  s.state.queue = s.state.queue.filter((q) => !(q.eventId === id && q.ctx.caseId === s.c.id));
}

function dropScheduled(s: Session, step: CrimeStep): void {
  const id = stepEventId(step);
  s.state.scheduled = s.state.scheduled.filter((q) => !(q.eventId === id && q.ctx.caseId === s.c.id));
}

function recoveredStep(s: Session): void {
  const { state, c } = s;
  if (c.recovered !== undefined || recoveryAt(c, state.ch.age) < RECOVERED) return;
  c.recovered = state.ch.age;
  if (c.care === 'active') c.care = 'done';
  note(s, 'recovered', '일상으로 돌아옴');
  say(s, 'recovered');
  const npc = victimNpc(state, c);
  if (npc) npc.closeness = Math.min(100, npc.closeness + 3);
  syncAftermathTag(state);
}

const STEP_HANDLERS: Record<CrimeStep, Handler> = {
  police: policeStep,
  prosecution: prosecutionStep,
  trial: trialStep,
  verdict: verdictStep,
  internal: internalStep,
  admin: adminStep,
  civil: civilStep,
  protect: protectStep,
  repeat: repeatStep,
  revisit: revisitStep,
  witness: witnessStep,
  support: supportStep,
  news: newsStep,
  recovered: recoveredStep,
};

// ── 효과 진입점 ──────────────────────────────────────────

export type CrimeAction = Extract<Action, { type: 'crime' }>;

/** 사건 효과의 { type: 'crime' } 행동. ctx.caseId로 사건을 찾는다 (옛 카드처럼 번호가 없으면 아무것도 하지 않는다) */
export function applyCrimeAction(state: GameState, a: CrimeAction, ec: EffectContext): void {
  if (a.op === 'open') {
    openFromScene(state, a.scene, ec);
    return;
  }
  const c = findCase(state.ch, ec.ctx.caseId);
  if (!c) return;
  const key = a.op === 'respond' ? (a.act ?? '') : (a.step ?? '');
  const rng = rngFor(state.seed, 'crime', c.id, a.op, key, c.log.length);
  const s: Session = { state, c, ctx: ec.ctx, rng, changes: ec.changes };
  s.ctx.결과 = '';
  if (a.op === 'respond') {
    HANDLERS[a.act as CrimeAct]?.(s);
    return;
  }
  // 재발 표시는 그 카드에서만 쓴다 (재발 단계가 다시 켠다)
  c.repeatNow = false;
  STEP_HANDLERS[a.step as CrimeStep]?.(s);
}

// ── 조건식 값 (crime.*) ──────────────────────────────────

function caseView(state: GameState, c: CrimeCase): Readonly<Record<string, unknown>> {
  const age = state.ch.age;
  const off = offenderStatus(state, c);
  const rec = recoveryAt(c, age);
  const reportable = canReport(state, c);
  const civil = canCivil(state, c);
  const labor = canLabor(state, c);
  const nhrck = canNhrck(state, c);
  return {
    exists: true,
    open: !c.closed,
    cat: c.cat,
    ctx: c.ctx,
    role: c.role,
    org: orgOf(c) ?? 'none',
    online: CATALOG.contexts[c.ctx]?.online === true,
    sexual: CATEGORY[c.cat].sexual,
    criminal: criminalTrack(c),
    report: c.report,
    reported: c.report !== 'none',
    police: c.police,
    prosecution: c.prosecution,
    verdict: c.verdict,
    internal: c.internal,
    admin: c.admin,
    civil: c.civil,
    protection: c.protection,
    care: c.care,
    years: age - c.age,
    harm: c.harm,
    evidence: c.evidence,
    support: c.support,
    repeats: c.repeats,
    recovery: rec,
    lowRecovery: rec < 50,
    noCare: c.care === 'none',
    canReport: reportable,
    canCivil: civil,
    canInternal: canInternal(state, c),
    canLabor: labor,
    canNhrck: nhrck,
    canCommission: canCommission(state, c),
    canProtect: canProtect(state, c),
    canEvidence: c.evidence < 3,
    notSent: c.police === 'not_sent' && c.appeals === 0,
    dropped: (c.prosecution === 'dropped' || c.prosecution === 'deferred') && c.appeals === 0,
    acquitted: c.verdict === 'acquitted' && c.appeals === 0,
    guilty: ['prison', 'suspended', 'fine'].includes(c.verdict),
    trialOpen: c.trial === 'ongoing',
    settleOffer: c.trial === 'ongoing' && c.settleOffer === true,
    violated: c.protection === 'violated',
    noAction: c.internal === 'no_action',
    retaliation: c.internal === 'retaliation',
    repeatNow: c.repeatNow === true,
    offenderKnown: off.known,
    offenderAlive: off.alive,
    relationEnded: off.ended,
    // 다시 돌아볼 거리가 남은 미신고 사건
    // 상담만 남은 사건은 한 번만 다시 돌아본다 (신고·진정·민사 기한이 남으면 그 기한까지)
    revisitable:
      !c.closed && c.role === 'victim' && c.report === 'none' && (reportable || civil || labor || nhrck || (c.care === 'none' && c.revisits === 0)),
    recoveredNow: c.recovered === undefined && rec >= RECOVERED,
  };
}

const BLANK_CASE: Readonly<Record<string, unknown>> = Object.freeze(
  Object.fromEntries(
    Object.entries(caseViewTemplate()).map(([k, v]) => [k, typeof v === 'number' ? 0 : typeof v === 'string' ? 'none' : false]),
  ),
);

/** 빈 사건의 모양 (검증 도구가 조건식 경로를 확인할 때 쓴다) */
function caseViewTemplate(): Record<string, unknown> {
  const keys: Record<string, unknown> = {};
  for (const k of [
    'exists', 'open', 'online', 'sexual', 'criminal', 'reported', 'lowRecovery', 'noCare', 'canReport', 'canCivil', 'canInternal',
    'canLabor', 'canNhrck', 'canCommission', 'canProtect', 'canEvidence', 'notSent', 'dropped', 'acquitted', 'guilty', 'trialOpen',
    'settleOffer', 'violated', 'noAction', 'retaliation', 'repeatNow', 'offenderKnown', 'offenderAlive', 'relationEnded',
    'revisitable', 'recoveredNow',
  ]) keys[k] = false;
  for (const k of ['cat', 'ctx', 'role', 'org', 'report', 'police', 'prosecution', 'verdict', 'internal', 'admin', 'civil', 'protection', 'care']) keys[k] = '';
  for (const k of ['years', 'harm', 'evidence', 'support', 'repeats', 'recovery']) keys[k] = 0;
  return keys;
}

const BLANK_SCOPE: Readonly<Record<string, unknown>> = Object.freeze({
  cases: 0,
  active: 0,
  victim: false,
  reported: false,
  protected: false,
  case: BLANK_CASE,
});

/** 조건식이 읽는 crime.* 값. ctx.caseId가 있으면 crime.case에 그 사건을 보여 준다 (상태를 바꾸지 않는다) */
export function crimeScope(state: GameState, ctx: Record<string, string> = {}): Readonly<Record<string, unknown>> {
  const led = state.ch.crime;
  if (!led || !Array.isArray(led.cases) || led.cases.length === 0) return BLANK_SCOPE;
  const c = ctx.caseId ? led.cases.find((x) => x.id === ctx.caseId) : undefined;
  return {
    cases: led.cases.length,
    active: led.cases.filter((x) => !x.closed && x.recovered === undefined).length,
    victim: led.cases.some((x) => x.role === 'victim'),
    reported: led.cases.some((x) => x.report !== 'none'),
    protected: led.cases.some((x) => x.protection === 'granted' && !x.closed),
    case: c ? caseView(state, c) : BLANK_CASE,
  };
}

// ── 검증 도구용 ──────────────────────────────────────────

/** 엔진이 예약해서 부르는 단계 사건 (다른 사건이 next·later로 참조하지 않는다) */
export const CRIME_SYSTEM_EVENTS: readonly string[] = CRIME_STEPS.map(stepEventId);

/** { type: 'crime' } 행동의 오류. 없으면 undefined */
export function crimeActionProblem(a: CrimeAction): string | undefined {
  if (a.op === 'open') return a.scene && SCENE_BY_ID.has(a.scene) ? undefined : `없는 범죄 장면: ${a.scene}`;
  if (a.op === 'respond') return a.act && (CRIME_ACTS as readonly string[]).includes(a.act) ? undefined : `없는 범죄 대응: ${a.act}`;
  if (a.op === 'advance') return a.step && (CRIME_STEPS as readonly string[]).includes(a.step) ? undefined : `없는 범죄 단계: ${a.step}`;
  return `없는 범죄 행동: ${(a as { op: string }).op}`;
}

