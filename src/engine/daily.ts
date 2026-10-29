// 하루 사슬: 1년 단위 게임 안에서 '하루'를 확대해 보는 작은 일상 사건의 공통 구조 (검토 F-001).
//
// 첫 사슬은 세탁 지연이다. 덜 마른 빨래·날씨·다음 날 일정(새벽 교대 근무·출근·등교·외출)이 겹친다.
// 기다리기 / 빨래방(돈) / 특정 인물에게 옷 빌리기 / 일정 조정 / 다른 옷 입기 중에서 고르고, 실패하면
// 남은 방법으로 다시 고른다 (daily_laundry_fallback). 고를 때마다 방법이 하나씩 닫히므로 사슬은 반드시 끝난다.
//
// 공통 구조 (F-002~F-005는 DailyChainBase에 자기 사정을 더한 새 kind를 CHAIN_KINDS에, 갚을 일을 OBLIGATION_KINDS에 올린다):
//  - 시각: 사슬은 '첫날 0시부터 센 분'으로 지금(now)과 집을 나서야 하는 때(deadline)를 갖는다.
//    고른 행동마다 시간이 들고(timeUsed), 시간대(slotOf)가 인물의 반응을 바꾼다 (밤·새벽엔 잠들어 있다).
//  - 의무: 나중에 갚을 일(빌린 옷 돌려주기)은 id가 있는 의무로 남고, 생길 때 독촉·정리 사건을 그 id로 예약한다.
//    활동으로 돌려주면 닫히고(예약 카드는 뜨지 않는다), 기한이 지나도록 열려 있으면 독촉 카드가 뜬다.
//    그사이 상대가 떠났으면 '돌려주지 못한 옷'으로 정리된다.
//  - 인물: 부탁 상대는 실제 인물 ID로 묶는다. 상대는 자기 일정(npcSituation: 잠·근무·야근·밤 외출 금지·외박)과
//    자기도 입을 옷·거리, 성향, 지난 기억(제때 돌려받았는지)으로 스스로 수락·거절한다.
//    플레이어가 얼마나 급한지는 판정에 넣지 않는다. 한 사슬에서 부탁은 MAX_ASKS명까지다.
//  - 기억: 빌려줌·거절·반납·늦은 반납·모른 척·약속 미룸·취소를 인물 ID와 나이로 남기고 다음 부탁에 쓴다.
//  - 난수: rngFor(seed, 'daily', 사슬·의무 id, …)만 쓴다. 같은 시드·같은 선택이면 중간에 저장·불러오기를 해도 같다.
//
// 연 단위 루프(game.ts)는 바꾸지 않는다. 사건 카드의 행동(do: { type: 'daily', step })과 활동(chore_*)이
// 이 파일을 부른다. 문장은 data/events/daily.json의 lines에 있다. 저장에는 ch.daily 하나만 더해지고,
// 옛 저장에는 없으므로 읽을 때 빈 기록으로 본다 (readDaily).

import dailyJson from '../../data/events/daily.json';
import { JOB_BY_ID, REGION_BY_ID } from './data';
import { changeAttr, pay, paymentText, type EffectContext } from './effects';
import { formatWon } from './format';
import { alive, npcAge, roleLabel } from './relations';
import { rngFor, type Rng } from './rng';
import type { ActivityDef } from './schema';
import { render } from './text';
import type { Change, Character, GameState, Npc } from './types';

// ── 상태 ─────────────────────────────────────────────────

export type ScheduleKind = 'shift' | 'office' | 'school' | 'outing';
export type OutingKind = 'meetup' | 'date' | 'family' | 'wedding' | 'reunion';
export type SchoolKind = 'elementary' | 'secondary' | 'university';
export const WEATHERS = ['rain', 'humid', 'cold', 'dust', 'clear'] as const;
export type Weather = (typeof WEATHERS)[number];
/** 옷 상태: 젖음 → 눅눅함 → 마름. 빌린 옷·다른 옷을 입으면 그 상태로 끝난다 */
export type ClothesState = 'wet' | 'damp' | 'dry' | 'borrowed' | 'substitute';
export type DailyStage = 'start' | 'fallback' | 'done';
export type DailyOutcome =
  | 'dried'
  | 'laundromat'
  | 'borrowed'
  | 'adjusted'
  | 'late'
  | 'damp'
  | 'substitute'
  | 'skipped'
  | 'cancelled'
  | 'abandoned';
export type TimeSlot = 'morning' | 'day' | 'evening' | 'night' | 'dawn';

/** 사건 카드의 행동 단계 (schema Action { type: 'daily', step }) */
export const DAILY_STEPS = [
  'start',
  'wait',
  'laundromat',
  'borrow',
  'adjust',
  'wear_damp',
  'wear_other',
  'cancel',
  'return',
  'compensate',
  'forget',
  'void',
] as const;
export type DailyStep = (typeof DAILY_STEPS)[number];

export interface DailyItem {
  name: string;
  /** 두께: 마르는 시간 배수 */
  thick: number;
  /** 교복·체육복: 같은 학교 또래에게서만 빌릴 수 있다 */
  uniform?: boolean;
  /** 남녀 구분 없이 입는 옷 (연인·배우자에게도 빌릴 수 있다) */
  unisex?: boolean;
}

export interface DailySchedule {
  kind: ScheduleKind;
  school?: SchoolKind;
  outing?: OutingKind;
  /** 함께하기로 한 사람의 인물 ID (약속·데이트·가족 모임) */
  withId?: string;
  /** 자영업: 출근 대신 가게 문을 연다 (늦출지는 스스로 정한다) */
  business?: boolean;
}

/**
 * 하루 사슬의 공통 부분: 시각·일정·단계·부탁한 사람·돈·시간·지각·결과.
 * 다른 사슬(F-002 교대 변경과 돌봄 공백 등)은 이 필드를 그대로 쓰고 자기 사정만 더한다
 */
export interface DailyChainBase {
  id: string;
  kind: string;
  /** 사슬이 시작된 나이. 그해 안에서만 이어진다 */
  age: number;
  /** 지금 시각: 첫날 0시부터 센 분 (다음 날은 1440분부터) */
  now: number;
  /** 집을 나서야 하는 시각 (같은 기준) */
  deadline: number;
  schedule: DailySchedule;
  stage: DailyStage;
  /** 지금 부탁할 사람 (아직 묻지 않은 사람 중 가장 가까운 사람) */
  helperId?: string;
  /** 이미 부탁한 사람들 (같은 사람에게 두 번 묻지 않는다) */
  asked: string[];
  adjustTried: boolean;
  /** 약속 상대가 미루기를 거절했다 (취소 선택지가 열린다) */
  adjustRefused: boolean;
  /** 내가 낸 돈 (현금 + 새 빚). 보호자 부담은 따로 */
  spent: number;
  guardianPaid: number;
  /** 이 일로 쓴 시간 (분) */
  timeUsed: number;
  /** 늦은 시간 (분) */
  late: number;
  outcome?: DailyOutcome;
  /** 고른 순서 (재현 확인용) */
  steps: DailyStep[];
}

/** 세탁 사슬 (F-001): 공통 부분에 날씨·옷·마르는 시간·빨래방·빌려준 사람을 더한다 */
export interface LaundryChain extends DailyChainBase {
  kind: 'laundry';
  weather: Weather;
  /** 건조기가 있는데도 널어야 했던 사정 (lines.dryer의 번호) */
  dryerNote?: number;
  item: DailyItem;
  clothes: ClothesState;
  /** 지금 상태에서 다 마르기까지 남은 분 (기다릴 때 실제 시간은 이 근처에서 정해진다) */
  dryLeft: number;
  /** 빌려준 사람 */
  lenderId?: string;
  waited: boolean;
  laundromatTried: boolean;
  /** 동네에 24시간 빨래방이 있는가 (사슬을 만들 때 정한다) */
  laundromatNear: boolean;
  /** 빨래방 건조기 값 (원, 그해 물가) */
  laundromatCost: number;
}

/** 지금 있는 사슬 종류. 새 사슬이 생기면 합집합으로 더한다 */
export type DailyChain = LaundryChain;

export type ObligationStatus = 'open' | 'returned' | 'returned_late' | 'compensated' | 'forgotten' | 'void';
/** 의무 종류. 지금은 빌린 옷 돌려주기뿐이다 (F-002의 교대 빚, F-005의 장보기 분담도 같은 틀에 더한다) */
export type ObligationKind = 'return_clothes';

/** 나중에 갚을 일: 누구에게(인물 ID) 무엇을 언제까지 */
export interface DailyObligation {
  id: string;
  chainId: string;
  kind: ObligationKind;
  npcId: string;
  /** 문장에 쓰는 그때의 이름·호칭 */
  who: string;
  /** 갚을 것 (빌린 옷 이름 등) */
  what: string;
  since: number;
  /** 이 나이의 연말까지 돌려주기로 했다. 그다음 해 첫머리에 열려 있으면 독촉 카드 */
  dueAge: number;
  status: ObligationStatus;
  closedAge?: number;
}

export type MemoryKind =
  | 'lent'
  | 'refused'
  | 'returned'
  | 'returned_late'
  | 'compensated'
  | 'forgot'
  | 'postponed'
  | 'declined'
  | 'cancelled'
  | 'void';

/** 인물별 기억 한 줄 */
export interface DailyMemory {
  npcId: string;
  age: number;
  kind: MemoryKind;
  chainId?: string;
}

/** 끝난 사슬 요약 (도달성·반복률 측정과 기억에 쓴다) */
export interface DailyRecord {
  id: string;
  kind: string;
  age: number;
  schedule: ScheduleKind;
  outing?: OutingKind;
  /** 세탁 사슬의 날씨·옷 */
  weather?: Weather;
  item?: string;
  outcome: DailyOutcome;
  helperId?: string;
  spent: number;
  timeUsed: number;
  late: number;
  steps: DailyStep[];
}

export interface DailyLate {
  age: number;
  kind: ScheduleKind;
  minutes: number;
}

export interface DailyState {
  /** 사슬·의무 id 순번 */
  seq: number;
  /** 지금(또는 마지막) 사슬 */
  chain?: DailyChain;
  obligations: DailyObligation[];
  memory: DailyMemory[];
  history: DailyRecord[];
  lates: DailyLate[];
  dryer?: boolean;
  dryerAge?: number;
  /** 빨래를 미리 해 둔 해 (그해 사슬 확률이 준다) */
  preparedAge?: number;
}

const MEMORY_CAP = 60;
const HISTORY_CAP = 40;
const LATES_CAP = 30;
/** 닫힌 의무는 최근 것만 남긴다 */
const CLOSED_CAP = 20;

type Ctx = Record<string, string>;

// ── 문장 ─────────────────────────────────────────────────

interface WeatherDef {
  text: string;
  hours: [number, number];
  w: number;
}

interface Lines {
  weather: Record<Weather, WeatherDef>;
  dryer: string[];
  items: Record<string, DailyItem[]>;
  schedule: Record<string, string>;
  adjust: Record<string, string>;
  say: Record<string, string>;
}

export const DAILY_LINES: Lines = (dailyJson as unknown as { lines: Lines }).lines;

/** lines.say 문장을 자리표시자·조사까지 채워 돌려준다 */
function say(state: GameState, ctx: Ctx, key: string): string {
  const t = DAILY_LINES.say[key];
  return t ? render(t, state, ctx) : '';
}

function joinLines(...parts: string[]): string {
  return parts.filter(Boolean).join(' ');
}

// ── 기록 읽기·만들기 ─────────────────────────────────────

const EMPTY: DailyState = { seq: 0, obligations: [], memory: [], history: [], lates: [] };

/** 읽기 전용: 기록이 없으면(옛 저장·아직 한 번도 없음) 빈 기록. 일부 필드가 빠진 기록은 빈 목록으로 본다 */
export function readDaily(ch: Character): DailyState {
  const d = ch.daily;
  if (!d) return EMPTY;
  if (d.obligations && d.memory && d.history && d.lates) return d;
  return { ...d, seq: d.seq ?? 0, obligations: d.obligations ?? [], memory: d.memory ?? [], history: d.history ?? [], lates: d.lates ?? [] };
}

/** 쓰기 전: 기록을 붙이고, 일부 필드가 빠진 저장이면 채운다 */
export function ensureDaily(ch: Character): DailyState {
  const d = (ch.daily ??= { seq: 0, obligations: [], memory: [], history: [], lates: [] });
  d.seq ??= 0;
  d.obligations ??= [];
  d.memory ??= [];
  d.history ??= [];
  d.lates ??= [];
  return d;
}

function nextId(d: DailyState, prefix: string): string {
  d.seq += 1;
  return `${prefix}${d.seq}`;
}

function chainRng(state: GameState, c: DailyChain, ...labels: (string | number)[]): Rng {
  return rngFor(state.seed, 'daily', c.id, c.age, ...labels);
}

// ── 시각 ─────────────────────────────────────────────────

const DAY = 1440;
/** 사슬이 시작되는 가장 이른·늦은 시각: 전날 저녁 6시부터, 성인은 새벽 1시·미성년자는 밤 10시 반까지 */
const EARLIEST = 18 * 60;
const LATEST_ADULT = DAY + 60;
const LATEST_MINOR = 22 * 60 + 30;
/** 아침에 옷을 확인하는 때: 집을 나서기 45분 전 */
const READY = 45;

export function slotOf(min: number): TimeSlot {
  const h = Math.floor((((min % DAY) + DAY) % DAY) / 60);
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 17) return 'day';
  if (h >= 17 && h < 22) return 'evening';
  if (h >= 22 || h < 2) return 'night';
  return 'dawn';
}

/** 1430 → '밤 11시 50분', 1760 → '새벽 5시 20분' */
export function clockText(min: number): string {
  const m = ((min % DAY) + DAY) % DAY;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const part = h === 0 || h >= 21 ? '밤' : h < 6 ? '새벽' : h < 9 ? '아침' : h < 12 ? '오전' : h < 18 ? '오후' : '저녁';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${part} ${h12}시${mm ? ` ${mm}분` : ''}`;
}

/** 100 → '1시간 40분' */
export function spanText(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}분`;
  return r ? `${h}시간 ${r}분` : `${h}시간`;
}

function round10(x: number): number {
  return Math.max(10, Math.round(x / 10) * 10);
}

function advance(c: DailyChain, minutes: number): void {
  c.now += minutes;
  c.timeUsed += minutes;
}

// ── 사람 ─────────────────────────────────────────────────

/** 살아 있고 연락이 닿는 인물 */
function present(ch: Character, id: string | undefined): Npc | undefined {
  if (!id) return undefined;
  const n = ch.npcs.find((x) => x.id === id);
  return n && n.alive && !n.missing ? n : undefined;
}

/** 문장에 쓰는 이름: 가족은 호칭(엄마·누나), 나머지는 이름 */
function nameOf(npc: Npc, ch: Character): string {
  return ['mother', 'father', 'sibling', 'grandparent'].includes(npc.role) ? roleLabel(npc, ch) : npc.name;
}

/** 한집에 사는가: 배우자, 동거 중인 연인, 부모와 사는 동안의 부모·형제 */
export function livesTogether(state: GameState, npc: Npc): boolean {
  const ch = state.ch;
  switch (npc.role) {
    case 'spouse':
      return true;
    case 'partner':
      return Boolean(ch.flags.rom_cohabiting);
    case 'mother':
    case 'father':
      return ch.family.livesWithParents;
    case 'sibling':
      return ch.family.livesWithParents && npcAge(npc, state.year) < 30;
    default:
      return false;
  }
}

/** 인물의 성향(남에게 선뜻 빌려주는 정도 0.2~0.95). 인생 시드와 인물 ID로 정해지고 바뀌지 않는다 */
export function disposition(state: GameState, npc: Npc): number {
  return rngFor(state.seed, 'daily', 'npc', npc.id).float(0.2, 0.95);
}

export interface MemorySummary {
  lent: number;
  refused: number;
  returned: number;
  late: number;
  forgot: number;
  postponed: number;
  cancelled: number;
}

/** 이 인물과의 기억. recent를 주면 그 햇수 안의 기억만 센다 */
export function memoryOf(state: GameState, npcId: string, recent?: number): MemorySummary {
  const out: MemorySummary = { lent: 0, refused: 0, returned: 0, late: 0, forgot: 0, postponed: 0, cancelled: 0 };
  const age = state.ch.age;
  for (const m of readDaily(state.ch).memory) {
    if (m.npcId !== npcId || (recent !== undefined && age - m.age > recent)) continue;
    if (m.kind === 'lent') out.lent++;
    else if (m.kind === 'refused') out.refused++;
    else if (m.kind === 'returned') out.returned++;
    else if (m.kind === 'returned_late' || m.kind === 'compensated') out.late++;
    else if (m.kind === 'forgot') out.forgot++;
    else if (m.kind === 'postponed') out.postponed++;
    else if (m.kind === 'cancelled') out.cancelled++;
  }
  return out;
}

export function remember(state: GameState, npcId: string, kind: MemoryKind, chainId?: string): void {
  const d = ensureDaily(state.ch);
  d.memory.push({ npcId, age: state.ch.age, kind, chainId });
  if (d.memory.length > MEMORY_CAP) d.memory.splice(0, d.memory.length - MEMORY_CAP);
}

function closeness(npc: Npc, delta: number, ch: Character, changes: Change[]): void {
  const before = npc.closeness;
  npc.closeness = Math.max(0, Math.min(100, before + delta));
  const d = Math.round(npc.closeness - before);
  if (d !== 0) changes.push({ text: `${nameOf(npc, ch)} 친밀도 ${d > 0 ? '+' : '−'}${Math.abs(d)}`, sign: d > 0 ? 'good' : 'bad' });
}

// ── 일정 ─────────────────────────────────────────────────

const SHIFT_JOBS = new Set(['nurse', 'factory', 'care_worker', 'convenience_store', 'chef', 'nco']);
/** 교대 근무가 흔한 일 (직업 이름·인물의 직업 문구로 짐작한다) */
const SHIFT_TITLE = /간호|공장|생산|요양|돌봄|간병|경찰|소방|경비|교도|편의점|조리|요리|응급|기관사|관제|교대/;

/** 지금 직업이 교대 근무인가. 직업 정의에 shift·schedule 정보가 있으면 그것을 따른다 */
function isShiftJob(state: GameState): boolean {
  const id = state.ch.career.jobId;
  // 직업 정의가 근무 형태를 갖게 되면(직업 확장 작업) 그 값을 먼저 본다. 형태를 몰라도 읽을 수 있게 넓게 받는다
  const job = id ? (JOB_BY_ID.get(id) as unknown as { shift?: unknown; schedule?: unknown; title: string } | undefined) : undefined;
  if (!id || !job) return false;
  if (typeof job.shift === 'boolean') return job.shift;
  if (typeof job.schedule === 'string') return /shift|교대/.test(job.schedule);
  return SHIFT_JOBS.has(id) || SHIFT_TITLE.test(job.title);
}

function schoolOf(ch: Character): SchoolKind | undefined {
  if (ch.edu.status === 'elementary') return 'elementary';
  if (ch.edu.status === 'middle' || ch.edu.status === 'high') return 'secondary';
  if (ch.edu.status === 'university' && !ch.edu.onLeave) return 'university';
  return undefined;
}

function closest(list: Npc[]): Npc | undefined {
  return list.reduce<Npc | undefined>((best, n) => (!best || n.closeness > best.closeness ? n : best), undefined);
}

/** 외출 일정 후보 (가중치). 같이 만날 사람은 가장 가까운 사람이다 */
function outings(state: GameState): { s: DailySchedule; w: number }[] {
  const ch = state.ch;
  const adult = ch.age >= 19;
  const out: { s: DailySchedule; w: number }[] = [];
  const friend = closest(alive(ch, 'friend'));
  if (friend) out.push({ s: { kind: 'outing', outing: 'meetup', withId: friend.id }, w: 3 });
  // 데이트는 성인끼리만 (나와 상대 모두 만 19세 이상)
  const mate = alive(ch, 'partner', 'spouse')[0];
  if (adult && mate && npcAge(mate, state.year) >= 19) out.push({ s: { kind: 'outing', outing: 'date', withId: mate.id }, w: 2 });
  const parent = closest(alive(ch, 'mother', 'father'));
  const grownKid = closest(alive(ch, 'child').filter((k) => npcAge(k, state.year) >= 19));
  // 함께 사는 부모와는 '가족 모임'에 따로 가지 않는다
  const kin = parent && !ch.family.livesWithParents ? parent : grownKid;
  if (kin) out.push({ s: { kind: 'outing', outing: 'family', withId: kin.id }, w: 1.5 });
  if (ch.age >= 23 && ch.age <= 70) out.push({ s: { kind: 'outing', outing: 'wedding' }, w: 1 });
  if (ch.age >= 30 || out.length === 0) out.push({ s: { kind: 'outing', outing: 'reunion' }, w: 1 });
  return out;
}

/** 다음 날 일정: 학생은 대개 등교, 직장인은 대개 출근, 나머지는 외출 */
function pickSchedule(state: GameState, rng: Rng): DailySchedule {
  const ch = state.ch;
  const r = rng.next();
  const list = outings(state);
  const outing = rng.weighted(list, (o) => o.w)!.s;
  const school = schoolOf(ch);
  // 학생의 외출은 친구와의 약속뿐이다 (동창 모임·결혼식은 성인의 일정)
  if (school && (r < 0.8 || outing.outing !== 'meetup')) return { kind: 'school', school };
  if (ch.career.jobId && r < 0.75) {
    if (ch.career.business) return { kind: 'office', business: true };
    return { kind: isShiftJob(state) ? 'shift' : 'office' };
  }
  return outing;
}

/** lines.items·schedule·adjust를 찾는 열쇠 */
function scheduleKey(s: DailySchedule): string {
  if (s.kind === 'school') return `school_${s.school ?? 'secondary'}`;
  if (s.kind === 'outing') return s.outing ?? 'reunion';
  if (s.kind === 'office' && s.business) return 'business';
  return s.kind;
}

function itemKey(s: DailySchedule): string {
  if (s.kind === 'school') return `school_${s.school ?? 'secondary'}`;
  if (s.kind === 'outing') return s.outing === 'wedding' ? 'wedding' : 'outing';
  return s.kind;
}

/** 집을 나서야 하는 시각 (다음 날 0시부터 센 분) */
const LEAVE: Record<string, number> = {
  shift: 5 * 60 + 20,
  office: 8 * 60,
  business: 8 * 60 + 30,
  school_elementary: 8 * 60,
  school_secondary: 7 * 60 + 30,
  school_university: 9 * 60,
  meetup: 11 * 60,
  date: 11 * 60 + 30,
  family: 10 * 60,
  wedding: 10 * 60 + 30,
  reunion: 11 * 60,
};

function withName(state: GameState, c: DailyChain): string {
  const npc = present(state.ch, c.schedule.withId);
  return npc ? nameOf(npc, state.ch) : '';
}

// ── 사슬 만들기 ──────────────────────────────────────────

/**
 * 세탁 사슬을 연다: 일정·옷·날씨·마르는 시간·지금 시각·빨래방·부탁할 사람을 정하고 카드 문장 값을 채운다.
 * 끝나지 않은 사슬이 남아 있으면(죽음 등으로 대기열이 비워진 경우) 버려진 사슬로 기록하고 새로 연다.
 */
export function startChain(state: GameState, ctx: Ctx): DailyChain {
  const ch = state.ch;
  const d = ensureDaily(ch);
  if (d.chain && d.chain.stage !== 'done') finish(state, d.chain, 'abandoned');
  const id = nextId(d, 'd');
  const rng = rngFor(state.seed, 'daily', id, ch.age, 'setup');
  const schedule = pickSchedule(state, rng);
  const item = rng.pick(DAILY_LINES.items[itemKey(schedule)]);
  const weather = rng.weighted(WEATHERS, (w) => DAILY_LINES.weather[w].w)!;
  const [lo, hi] = DAILY_LINES.weather[weather].hours;
  const need = round10(rng.float(lo, hi) * 60 * item.thick);
  const deadline = DAY + LEAVE[scheduleKey(schedule)] + rng.int(-2, 2) * 10;
  const gap = round10(need * rng.float(0.55, 0.95));
  const now = Math.min(ch.age < 19 ? LATEST_MINOR : LATEST_ADULT, Math.max(EARLIEST, deadline - gap));
  const metro = Boolean(REGION_BY_ID.get(ch.region)?.metro);
  const near = metro || rng.chance(0.65);
  const pi = state.world.economy.priceIndex;
  const chain: DailyChain = {
    id,
    kind: 'laundry',
    age: ch.age,
    now,
    deadline,
    schedule,
    weather,
    dryerNote: d.dryer ? rng.int(0, DAILY_LINES.dryer.length - 1) : undefined,
    item,
    clothes: 'wet',
    dryLeft: need,
    stage: 'start',
    asked: [],
    waited: false,
    laundromatTried: false,
    adjustTried: false,
    adjustRefused: false,
    laundromatNear: near,
    laundromatCost: Math.round((5000 * pi * (metro ? 1 : 1.2)) / 100) * 100,
    spent: 0,
    guardianPaid: 0,
    timeUsed: 0,
    late: 0,
    steps: ['start'],
  };
  d.chain = chain;
  chain.helperId = pickHelper(state, chain)?.id;
  fillCtx(state, chain, ctx);
  return chain;
}

/** 이 사람에게 이 옷을 빌릴 수 있는가 (성별·나이·교복 여부. 성인 커플끼리만 서로의 옷을 빌린다) */
function canLend(state: GameState, c: DailyChain, npc: Npc): boolean {
  const ch = state.ch;
  const a = npcAge(npc, state.year);
  const gap = Math.abs(a - ch.age);
  if (!npc.alive || npc.missing || a < 8 || npc.id === c.schedule.withId) return false;
  switch (npc.role) {
    case 'sibling':
    case 'friend':
      if (npc.sex !== ch.sex && !c.item.unisex) return false;
      if (c.item.uniform) return a <= 22 && gap <= (npc.role === 'friend' ? 1 : 3);
      return gap <= (ch.age < 19 ? 3 : 12);
    case 'partner':
    case 'spouse':
      return Boolean(c.item.unisex) && ch.age >= 19 && a >= 19;
    case 'mother':
    case 'father':
      return ch.age >= 19 && npc.sex === ch.sex && !c.item.uniform;
    default:
      return false;
  }
}

/** 한 사슬에서 옷을 부탁해 보는 사람 수. 세 번 거절당하면 더 묻지 않는다 */
export const MAX_ASKS = 3;

/** 아직 묻지 않은 사람 중 부탁할 사람: 친밀도가 높고 한집에 살수록 먼저 떠오른다 (사슬마다 조금 흔들린다) */
function pickHelper(state: GameState, c: DailyChain): Npc | undefined {
  if (c.asked.length >= MAX_ASKS) return undefined;
  let best: Npc | undefined;
  let bestScore = -Infinity;
  for (const n of state.ch.npcs) {
    if (c.asked.includes(n.id) || !canLend(state, c, n) || !timeToFetch(state, c, n)) continue;
    const jitter = chainRng(state, c, 'pick', n.id).float(0, 10);
    const score = n.closeness + (livesTogether(state, n) ? 10 : 0) + jitter;
    if (score > bestScore) {
      best = n;
      bestScore = score;
    }
  }
  return best;
}

/** 한집에 살지 않는 사람에게 부탁해 볼 만큼 시간이 남았는가 (가장 가까워도 왕복 40분, 준비 30분) */
function timeToFetch(state: GameState, c: DailyChain, npc: Npc): boolean {
  return livesTogether(state, npc) || c.deadline - 30 - c.now >= 40;
}

function helperOf(state: GameState, c: DailyChain): Npc | undefined {
  const npc = present(state.ch, c.helperId);
  return npc && c.asked.length < MAX_ASKS && !c.asked.includes(npc.id) && canLend(state, c, npc) && timeToFetch(state, c, npc) ? npc : undefined;
}

/** 지금 부탁할 사람이 없어졌으면(시간이 지나 멀리 사는 사람에게는 늦었다) 남은 사람 중에서 다시 고른다 */
function refreshHelper(state: GameState, c: DailyChain): void {
  if (c.stage !== 'done' && !helperOf(state, c)) c.helperId = pickHelper(state, c)?.id;
}

/** 카드 문장 값. 빌려준 사람이 정해졌으면 그 사람을 {도우미}로 남긴다 (나중의 반납 카드가 물려받는다) */
function fillCtx(state: GameState, c: DailyChain, ctx: Ctx): void {
  ctx.dailyChain = c.id;
  const weather = DAILY_LINES.weather[c.weather].text;
  ctx.날씨 = c.dryerNote !== undefined ? `${weather}. ${DAILY_LINES.dryer[c.dryerNote]}` : weather;
  ctx.옷 = c.item.name;
  ctx.약속상대 = withName(state, c);
  ctx.일정 = render(DAILY_LINES.schedule[scheduleKey(c.schedule)], state, ctx);
  ctx.조정 = render(DAILY_LINES.adjust[scheduleKey(c.schedule)], state, ctx);
  ctx.시각 = clockText(c.now);
  ctx.남은시간 = spanText(c.deadline - c.now);
  ctx.빨래방비 = formatWon(c.laundromatCost);
  const lender = present(state.ch, c.lenderId);
  const helper = lender ?? (c.stage === 'done' ? undefined : helperOf(state, c));
  if (lender || helper || ctx.도우미 === undefined) ctx.도우미 = helper ? nameOf(helper, state.ch) : '';
  ctx.상황 = say(state, ctx, c.clothes === 'damp' ? 'stateDamp' : 'stateWet');
}

// ── 지금 열린 방법 (scope의 daily.*와 카드 선택지 조건) ─────

/** 이 카드의 사슬: 같은 해에 열린, 끝나지 않은 사슬. ctx가 다른 사슬을 가리키면 없다 */
function liveChain(state: GameState, ctx: Ctx = {}): DailyChain | undefined {
  const c = state.ch.daily?.chain;
  if (!c || c.stage === 'done' || c.age !== state.ch.age) return undefined;
  if (ctx.dailyChain !== undefined && ctx.dailyChain !== c.id) return undefined;
  return c;
}

/** 보호자가 곁에 있는 미성년자 (밤에 빨래방에 같이 가거나 학교에 연락해 준다) */
function guardianHome(ch: Character): boolean {
  if (ch.age >= 19) return false;
  if (ch.family.type === 'facility' || ch.family.type === 'grandparents') return true;
  return ch.family.livesWithParents && alive(ch, 'mother', 'father').length > 0;
}

function laundromatMinutes(state: GameState): number {
  const metro = Boolean(REGION_BY_ID.get(state.ch.region)?.metro);
  // 오가는 길 + 건조기 50분 + 자리 기다리기
  return (metro ? 15 : 30) * 2 + 50 + 10;
}

function canWait(c: DailyChain): boolean {
  return !c.waited && c.clothes === 'wet' && c.deadline - READY - c.now >= 30;
}

function canLaundromat(state: GameState, c: DailyChain): boolean {
  if (!c.laundromatNear || c.laundromatTried || c.clothes === 'dry') return false;
  // 열네 살 아래는 혼자 밤에 나가지 않는다: 보호자와 함께 갈 수 있을 때만
  if (state.ch.age < 14 && !guardianHome(state.ch)) return false;
  return c.deadline - 15 - c.now >= laundromatMinutes(state);
}

function canCancel(c: DailyChain): boolean {
  return c.schedule.kind === 'outing' && Boolean(c.schedule.withId) && c.adjustRefused;
}

/** 열린 의무 중 지금 돌려줄 수 있는 것 (상대가 살아 있고 연락이 닿는다). 오래된 것부터 */
export function returnable(state: GameState, kind?: ObligationKind): DailyObligation[] {
  return readDaily(state.ch).obligations.filter((o) => o.status === 'open' && (!kind || o.kind === kind) && present(state.ch, o.npcId));
}

export function openObligations(state: GameState): DailyObligation[] {
  return readDaily(state.ch).obligations.filter((o) => o.status === 'open');
}

function recentLates(state: GameState, kinds: ScheduleKind[], years = 3): number {
  const age = state.ch.age;
  return readDaily(state.ch).lates.filter((l) => kinds.includes(l.kind) && age - l.age < years).length;
}

/**
 * 조건식이 읽는 daily.* 값 (scope.ts). 사건 trigger·선택지 if·활동 if가 쓴다.
 * ctx.dailyChain이 있으면 그 사슬일 때만, ctx.dailyOb가 있으면 그 의무를 본다.
 */
export function dailyScope(state: GameState, ctx: Ctx = {}): Record<string, unknown> {
  const ch = state.ch;
  const d = readDaily(ch);
  const c = liveChain(state);
  const here = Boolean(c && (ctx.dailyChain === undefined || ctx.dailyChain === c.id));
  const ob = ctx.dailyOb !== undefined ? d.obligations.find((o) => o.id === ctx.dailyOb) : undefined;
  const open = ob?.status === 'open';
  const lenderHere = Boolean(ob && present(ch, ob.npcId));
  return {
    active: Boolean(c),
    here,
    stage: c?.stage ?? 'none',
    schedule: c?.schedule.kind ?? 'none',
    outing: c?.schedule.outing ?? 'none',
    clothes: c?.clothes ?? 'none',
    canWait: Boolean(c && canWait(c)),
    canLaundromat: Boolean(c && canLaundromat(state, c)),
    canBorrow: Boolean(c && helperOf(state, c)),
    canAdjust: Boolean(c && !c.adjustTried),
    canWearDamp: c?.clothes === 'damp',
    canCancel: Boolean(c && canCancel(c)),
    dryer: Boolean(d.dryer),
    prepared: d.preparedAge === ch.age,
    owes: openObligations(state).length,
    canReturn: returnable(state, 'return_clothes').length > 0,
    dueOpen: open && lenderHere,
    dueLost: open && !lenderHere,
    chains: d.history.length,
    lateWork: recentLates(state, ['shift', 'office']),
    lateSchool: recentLates(state, ['school']),
    forgot: d.memory.filter((m) => m.kind === 'forgot').length,
  };
}

// ── 사슬 단계 ────────────────────────────────────────────

type Handler = (state: GameState, c: DailyChain, ctx: Ctx, changes: Change[]) => void;

/** 사슬을 끝낸다: 결과·지각을 기록하고 요약을 남긴다 */
function finish(state: GameState, c: DailyChain, outcome: DailyOutcome): void {
  c.stage = 'done';
  c.outcome = outcome;
  const d = ensureDaily(state.ch);
  d.history.push({
    id: c.id,
    kind: c.kind,
    age: c.age,
    schedule: c.schedule.kind,
    outing: c.schedule.outing,
    weather: c.weather,
    item: c.item.name,
    outcome,
    helperId: c.lenderId,
    spent: c.spent,
    timeUsed: c.timeUsed,
    late: c.late,
    steps: [...c.steps],
  });
  if (d.history.length > HISTORY_CAP) d.history.splice(0, d.history.length - HISTORY_CAP);
}

/** 지각 기록. 학교·직장의 지각이 쌓이면 상담·근태 경고 문장을 돌려준다 */
function recordLate(state: GameState, c: DailyChain, minutes: number, changes: Change[]): string {
  if (minutes <= 0) return '';
  c.late += minutes;
  const d = ensureDaily(state.ch);
  d.lates.push({ age: state.ch.age, kind: c.schedule.kind, minutes });
  if (d.lates.length > LATES_CAP) d.lates.splice(0, d.lates.length - LATES_CAP);
  const ctx: Ctx = {};
  if (c.schedule.kind === 'shift' || c.schedule.kind === 'office') {
    if (c.schedule.business || recentLates(state, ['shift', 'office']) < 2) return '';
    changeAttr(state, 'reputation', -3, changes);
    changeAttr(state, 'stress', 3, changes);
    return say(state, ctx, 'workWarn');
  }
  if (c.schedule.kind === 'school' && c.schedule.school !== 'university' && recentLates(state, ['school']) >= 3) {
    changeAttr(state, 'stress', 2, changes);
    return say(state, ctx, 'schoolWarn');
  }
  return '';
}

/** 기다리기: 아침(나서기 45분 전)에 옷이 말랐는지 본다. 선풍기·드라이어로 조금 빨라진다 */
const stepWait: Handler = (state, c, ctx, changes) => {
  const rng = chainRng(state, c, 'wait');
  c.waited = true;
  const check = c.deadline - READY;
  const avail = check - c.now;
  const actual = round10(c.dryLeft * rng.float(0.8, 1.15) * 0.85);
  c.timeUsed += 30; // 선풍기를 옮기고 드라이어를 대는 시간
  c.now = check;
  if (actual <= avail) {
    c.clothes = 'dry';
    c.dryLeft = 0;
    changeAttr(state, 'stamina', -1, changes);
    ctx.시각 = clockText(c.now);
    ctx.결과 = say(state, ctx, 'waitDry');
    finish(state, c, 'dried');
    return;
  }
  c.dryLeft = actual - avail;
  c.clothes = c.dryLeft <= 150 ? 'damp' : 'wet';
  c.stage = 'fallback';
  changeAttr(state, 'stress', 2, changes);
  ctx.시각 = clockText(c.now);
  ctx.결과 = say(state, ctx, c.clothes === 'damp' ? 'waitDamp' : 'waitWet');
};

/** 빨래방: 돈과 시간이 들지만 확실하다. 자정을 넘기면 잠이 모자란다. 미성년자 몫은 보호자가 낸다 */
const stepLaundromat: Handler = (state, c, ctx, changes) => {
  c.laundromatTried = true;
  const p = pay(state, c.laundromatCost);
  c.spent += p.cash + p.debt;
  c.guardianPaid += p.guardian;
  changes.push(paymentText(p));
  advance(c, laundromatMinutes(state));
  c.clothes = 'dry';
  c.dryLeft = 0;
  if (c.now > DAY + 30) changeAttr(state, 'stamina', -1, changes);
  changeAttr(state, 'stress', 1, changes);
  ctx.결과 = say(state, ctx, state.ch.age < 14 ? 'laundromatGuardian' : 'laundromat');
  finish(state, c, 'laundromat');
};

export interface NpcAnswer {
  yes: boolean;
  /** 거절 이유 (lines.say의 refuse_·postpone_ 뒤) 또는 수락 방식 (lendTogether·lendBring·lendPickup) */
  reason: string;
  /** 편도 이동 시간 (분). 한집이면 0 */
  travel: number;
}

/** 그 시각 그 인물의 사정: 자유로움·잠듦·근무(야간 교대·야근)·외박·출장·(미성년자) 밤 외출 금지 */
export type NpcSituation = 'free' | 'asleep' | 'working' | 'overtime' | 'away' | 'curfew';

/** 직업 문구로 본 '일하지 않는 사람' ('사무직'에도 '무직'이 들어 있으므로 무직은 통째로만 본다) */
const NO_WORK = /^무직$|은퇴|주부|학생/;

/**
 * 그 인물 자신의 일정으로 본 지금의 사정 (하루 사슬 공통: F-002의 돌봄 부탁도 같은 판단을 쓴다).
 * 시간대(slotOf)·나이·직업·한집 여부만 보고, 플레이어의 급한 정도는 보지 않는다.
 * rolls는 호출하는 쪽이 사슬·인물별로 미리 뽑아 둔 굴림 [잠, 근무, (예비), 외출]이다
 */
export function npcSituation(state: GameState, npc: Npc, minute: number, together: boolean, rolls: number[]): NpcSituation {
  const a = npcAge(npc, state.year);
  const slot = slotOf(minute);
  const late = slot === 'night' || slot === 'dawn';
  const sleepy = late ? (a >= 55 || a <= 12 ? 0.55 : 0.25) * (together ? 0.4 : 1) : 0;
  if (rolls[0] < sleepy) return 'asleep';
  if (together) return 'free';
  const job = npc.job ?? '';
  const shift = SHIFT_TITLE.test(job);
  // 직업을 모르는 성인도 일을 할 수 있다 (친구·형제의 직업은 기록되지 않는 경우가 많다)
  const working = job ? !NO_WORK.test(job) : a >= 20 && a < 65;
  if (shift && rolls[1] < (late ? 0.35 : 0.15)) return 'working';
  if (!shift && working && slot === 'evening' && rolls[1] < 0.12) return 'overtime';
  if (!shift && working && late && rolls[1] < 0.04) return 'working';
  // 미성년자는 밤에 혼자 집을 나서지 않는다 (가져다주지도, 가지러 오게 하지도 않는다)
  if (a < 19 && late) return 'curfew';
  if (rolls[3] < 0.05) return 'away';
  return 'free';
}

/**
 * 옷을 빌려 달라는 부탁에 대한 그 사람의 답. 먼저 그 사람 자신의 사정(거리·잠·근무·자기도 입을 옷·출장)을 보고,
 * 사정이 없으면 성향·친밀도·지난 기억으로 정한다. 난수는 사슬 id와 인물 id로 정해져 저장·불러오기 뒤에도 같다.
 */
export function answerLend(state: GameState, c: DailyChain, npc: Npc): NpcAnswer {
  const rng = chainRng(state, c, 'lend', npc.id);
  const metro = Boolean(REGION_BY_ID.get(state.ch.region)?.metro);
  const together = livesTogether(state, npc);
  const travel = together ? 0 : metro ? rng.int(2, 4) * 10 : rng.int(3, 6) * 10;
  // 굴림은 미리 정해 둔다: 앞 조건이 바뀌어도 뒤 굴림이 밀리지 않는다
  const roll = [rng.next(), rng.next(), rng.next(), rng.next(), rng.next(), rng.next()];
  const a = npcAge(npc, state.year);
  if (!together && c.deadline - 30 - c.now < travel * 2) return { yes: false, reason: 'far', travel };
  const sit = npcSituation(state, npc, c.now, together, roll);
  if (sit !== 'free') return { yes: false, reason: sit, travel };
  if (roll[2] < (c.item.uniform && a <= 19 ? 0.35 : 0.12)) return { yes: false, reason: 'needsIt', travel };
  const m = memoryOf(state, npc.id);
  let p = 0.15 + 0.45 * disposition(state, npc) + (0.3 * npc.closeness) / 100;
  if (['spouse', 'mother', 'father'].includes(npc.role)) p += 0.15;
  if (together) p += 0.05;
  p += -0.3 * m.forgot - 0.1 * m.late + 0.05 * Math.min(2, m.returned);
  p = Math.min(0.95, Math.max(0.03, p));
  if (roll[4] >= p) return { yes: false, reason: m.forgot > 0 ? 'grudge' : 'mood', travel };
  if (together) return { yes: true, reason: 'lendTogether', travel };
  // 열네 살 아래 아이는 밤에 혼자 가지러 가지 않는다: 그쪽 집에서 가져다준다
  const bring = roll[5] < 0.5 || state.ch.age < 14;
  return { yes: true, reason: bring ? 'lendBring' : 'lendPickup', travel };
}

/** 약속을 미뤄 달라는 부탁에 대한 그 사람의 답 (예약·다음 일정이 먼저, 그다음 성향·기억) */
export function answerPostpone(state: GameState, c: DailyChain, npc: Npc): NpcAnswer {
  const rng = chainRng(state, c, 'postpone', npc.id);
  const roll = [rng.next(), rng.next(), rng.next()];
  if (roll[0] < 0.2) return { yes: false, reason: 'booked', travel: 0 };
  if (roll[1] < 0.15) return { yes: false, reason: 'nextPlan', travel: 0 };
  const m = memoryOf(state, npc.id);
  const recent = memoryOf(state, npc.id, 5);
  let p = 0.25 + 0.4 * disposition(state, npc) + (0.3 * npc.closeness) / 100;
  p += -0.15 * recent.postponed - 0.1 * recent.cancelled - 0.3 * m.forgot;
  p = Math.min(0.95, Math.max(0.03, p));
  if (roll[2] >= p) return { yes: false, reason: m.forgot > 0 || recent.postponed > 0 ? 'grudge' : 'mood', travel: 0 };
  return { yes: true, reason: 'postponeYes', travel: 0 };
}

/** 빌리기: 부탁할 사람의 답을 듣는다. 빌리면 반납 의무가 생기고, 거절이면 다음 사람과 남은 방법으로 */
const stepBorrow: Handler = (state, c, ctx, changes) => {
  const npc = helperOf(state, c);
  if (!npc) {
    ctx.결과 = say(state, ctx, 'nobody');
    return;
  }
  c.asked.push(npc.id);
  advance(c, 15);
  ctx.도우미 = nameOf(npc, state.ch);
  const ans = answerLend(state, c, npc);
  ctx.이동 = spanText(ans.travel);
  ctx.왕복 = spanText(ans.travel * 2);
  if (!ans.yes) {
    remember(state, npc.id, 'refused', c.id);
    if (ans.reason === 'mood' || ans.reason === 'grudge') closeness(npc, -1, state.ch, changes);
    ctx.결과 = say(state, ctx, `refuse_${ans.reason}`);
    c.stage = 'fallback';
    c.helperId = pickHelper(state, c)?.id;
    return;
  }
  // 가지러 다녀오거나(왕복) 가져다줄 때까지 기다린다(편도)
  advance(c, ans.reason === 'lendPickup' ? ans.travel * 2 : ans.travel);
  remember(state, npc.id, 'lent', c.id);
  closeness(npc, 2, state.ch, changes);
  c.lenderId = npc.id;
  c.clothes = 'borrowed';
  // 다음 해 연말까지 돌려주기로 한다 (돌려줄 기회는 다음 해 자유 행동부터다)
  const ob = addObligation(state, c.id, 'return_clothes', npc, c.item.name, state.ch.age + 1);
  ctx.dailyOb = ob.id;
  ctx.결과 = say(state, ctx, ans.reason);
  finish(state, c, 'borrowed');
};

/**
 * 의무 종류별 후속 사건: 기한이 지난 다음 해 첫머리에 dueEvent(상대가 곁에 있을 때 독촉)와
 * lostEvent(상대가 떠나 돌려줄 길이 없을 때 정리)를 함께 예약한다. 둘 다 그 의무가 열려 있을 때만 뜬다
 */
export const OBLIGATION_KINDS: Record<ObligationKind, { dueEvent: string; lostEvent: string }> = {
  return_clothes: { dueEvent: 'daily_return_due', lostEvent: 'daily_return_lost' },
};

/**
 * 의무를 연다 (사슬 종류와 무관한 공통 부분): 누구에게(인물 ID) 무엇을 몇 살 연말까지.
 * 후속 사건은 의무 id를 ctx.dailyOb로 실어 예약한다. 수락했을 때만 예약되므로 거절된 부탁은 흔적을 남기지 않는다
 */
export function addObligation(state: GameState, chainId: string, kind: ObligationKind, npc: Npc, what: string, dueAge: number): DailyObligation {
  const d = ensureDaily(state.ch);
  const ob: DailyObligation = {
    id: nextId(d, 'o'),
    chainId,
    kind,
    npcId: npc.id,
    who: nameOf(npc, state.ch),
    what,
    since: state.ch.age,
    dueAge,
    status: 'open',
  };
  d.obligations.push(ob);
  const def = OBLIGATION_KINDS[kind];
  for (const eventId of [def.dueEvent, def.lostEvent]) {
    state.scheduled.push({ eventId, atAge: dueAge + 1, ctx: { dailyOb: ob.id, 도우미: ob.who, 옷: ob.what } });
  }
  return ob;
}

/** 옷이 마를 때까지 기다렸다 가면 얼마나 늦는가 (20분~2시간 반) */
function lateIfWaiting(c: DailyChain): number {
  const left = c.dryLeft - Math.max(0, c.deadline - 15 - c.now);
  return Math.min(150, round10(Math.max(20, left)));
}

/** 일정 조정: 학교는 늦는다고 알리고, 직장은 반차·교대 교환을 청하고, 약속은 상대에게 미루자고 한다 */
const stepAdjust: Handler = (state, c, ctx, changes) => {
  c.adjustTried = true;
  advance(c, 10);
  const s = c.schedule;
  if (s.kind === 'school') return adjustSchool(state, c, ctx, changes);
  if (s.kind === 'office' && s.business) {
    ctx.결과 = say(state, ctx, 'businessOpen');
    return finish(state, c, 'adjusted');
  }
  if (s.kind === 'office' || s.kind === 'shift') return adjustWork(state, c, ctx, changes);
  return adjustOuting(state, c, ctx, changes);
};

function adjustSchool(state: GameState, c: DailyChain, ctx: Ctx, changes: Change[]): void {
  if (c.schedule.school === 'university') {
    // 조원들의 사정: 이미 순서가 정해졌을 수 있다
    if (chainRng(state, c, 'adjust').chance(0.6)) {
      ctx.결과 = say(state, ctx, 'univYes');
      return finish(state, c, 'adjusted');
    }
    ctx.결과 = say(state, ctx, 'univNo');
    c.stage = 'fallback';
    return;
  }
  // 학교는 늦는다는 연락을 받아 준다. 대신 지각으로 남는다
  const minutes = lateIfWaiting(c);
  ctx.지각 = spanText(minutes);
  changeAttr(state, 'stress', 2, changes);
  const warn = recordLate(state, c, minutes, changes);
  ctx.결과 = joinLines(say(state, ctx, guardianHome(state.ch) ? 'schoolLateGuardian' : 'schoolLate'), warn);
  c.clothes = 'dry';
  finish(state, c, 'late');
}

function adjustWork(state: GameState, c: DailyChain, ctx: Ctx, changes: Change[]): void {
  const rng = chainRng(state, c, 'adjust');
  const lates = recentLates(state, ['shift', 'office']);
  const swaps = readDaily(state.ch).history.filter((h) => h.schedule === 'shift' && h.outcome === 'adjusted' && state.ch.age - h.age < 3).length;
  const shift = c.schedule.kind === 'shift';
  // 팀장·동료는 자기 사정으로 정한다: 최근 지각·교환 횟수와 평판이 영향을 준다
  const p = shift ? 0.5 - 0.15 * swaps - 0.05 * lates : 0.65 - 0.15 * lates + (state.ch.state.reputation - 50) / 250;
  if (rng.chance(Math.min(0.9, Math.max(0.1, p)))) {
    changeAttr(state, 'stress', shift ? 1 : -1, changes);
    ctx.결과 = say(state, ctx, shift ? 'swapYes' : 'bossYes');
    c.clothes = 'dry';
    return finish(state, c, 'adjusted');
  }
  ctx.결과 = say(state, ctx, shift ? 'swapNo' : 'bossNo');
  c.stage = 'fallback';
}

function adjustOuting(state: GameState, c: DailyChain, ctx: Ctx, changes: Change[]): void {
  const s = c.schedule;
  if (s.outing === 'wedding') {
    const amount = Math.round((chainRng(state, c, 'gift').chance(0.6) ? 50_000 : 100_000) * state.world.economy.priceIndex / 1000) * 1000;
    const p = pay(state, amount);
    c.spent += p.cash + p.debt;
    c.guardianPaid += p.guardian;
    changes.push(paymentText(p));
    ctx.결과 = say(state, ctx, 'weddingSkip');
    return finish(state, c, 'skipped');
  }
  const npc = present(state.ch, s.withId);
  if (s.outing === 'reunion' || !npc) {
    const minutes = lateIfWaiting(c);
    ctx.지각 = spanText(minutes);
    c.late += minutes;
    c.clothes = 'dry';
    ctx.결과 = say(state, ctx, 'reunionLate');
    return finish(state, c, 'adjusted');
  }
  const ans = answerPostpone(state, c, npc);
  if (ans.yes) {
    remember(state, npc.id, 'postponed', c.id);
    c.clothes = 'dry';
    ctx.결과 = say(state, ctx, 'postponeYes');
    return finish(state, c, 'adjusted');
  }
  remember(state, npc.id, 'declined', c.id);
  closeness(npc, -1, state.ch, changes);
  c.adjustRefused = true;
  c.stage = 'fallback';
  ctx.결과 = say(state, ctx, `postpone_${ans.reason}`);
}

/** 덜 마른 옷을 입고 나간다: 드라이어에 매달리다 늦기도 하고, 추운 날은 몸이 상하고, 냄새가 나기도 한다 */
const stepWearDamp: Handler = (state, c, ctx, changes) => {
  const rng = chainRng(state, c, 'damp');
  const late = rng.chance(0.4) ? rng.int(1, 2) * 10 : 0;
  const smell = rng.chance(0.4);
  changeAttr(state, 'stress', 2, changes);
  if (c.weather === 'cold') changeAttr(state, 'health', -1, changes);
  const parts = [say(state, ctx, 'dampOk')];
  if (smell) {
    parts.push(say(state, ctx, 'dampSmell'));
    if (c.schedule.kind !== 'outing') changeAttr(state, 'reputation', -1, changes);
    const mate = c.schedule.outing === 'date' ? present(state.ch, c.schedule.withId) : undefined;
    if (mate) closeness(mate, -1, state.ch, changes);
  }
  if (late > 0) {
    ctx.지각 = spanText(late);
    parts.push(say(state, ctx, 'dampLate'));
    parts.push(recordLate(state, c, late, changes));
  }
  ctx.결과 = joinLines(...parts);
  finish(state, c, 'damp');
};

/** 다른 옷을 입는다: 교복은 생활지도에 걸릴 수 있고, 근무복은 여벌이 있을 수도 없을 수도 있다 */
const stepWearOther: Handler = (state, c, ctx, changes) => {
  const rng = chainRng(state, c, 'other');
  const s = c.schedule;
  c.clothes = 'substitute';
  let key = 'otherFine';
  if (s.kind === 'school' && c.item.name.includes('체육복')) key = 'gymOther';
  else if (s.kind === 'school' && s.school === 'secondary' && c.item.name.includes('교복')) {
    key = rng.chance(0.4) ? 'uniformCaught' : 'uniformOk';
    if (key === 'uniformCaught') changeAttr(state, 'stress', 3, changes);
  } else if (s.kind === 'office') {
    key = 'officeOther';
    changeAttr(state, 'stress', 1, changes);
  } else if (s.kind === 'shift') {
    key = rng.chance(0.7) ? 'shiftSpare' : 'shiftNoSpare';
    if (key === 'shiftNoSpare') changeAttr(state, 'stress', 2, changes);
  } else if (s.kind === 'outing') {
    key = s.outing === 'date' ? 'dateOther' : 'outingOther';
    changeAttr(state, 'happiness', -1, changes);
  }
  ctx.결과 = say(state, ctx, key);
  finish(state, c, 'substitute');
};

/** 약속 취소: 미루자는 부탁이 거절된 뒤에만. 상대가 서운해하고 기억한다 */
const stepCancel: Handler = (state, c, ctx, changes) => {
  const npc = present(state.ch, c.schedule.withId);
  if (npc) {
    remember(state, npc.id, 'cancelled', c.id);
    closeness(npc, -5, state.ch, changes);
  }
  changeAttr(state, 'happiness', -2, changes);
  ctx.결과 = say(state, ctx, 'cancelled');
  finish(state, c, 'cancelled');
};

/**
 * 사슬 종류별 단계 처리. 새 사슬(F-002 교대 변경과 돌봄 공백 등)은 여기에 kind와 처리 함수를 더하고,
 * 공통 부분(시각·시간대·부탁 상대·의무·기억·지각·끝내기)은 그대로 쓴다. 연 단위 루프는 바뀌지 않는다
 */
const CHAIN_KINDS: Record<DailyChain['kind'], Partial<Record<DailyStep, Handler>>> = {
  laundry: {
    wait: stepWait,
    laundromat: stepLaundromat,
    borrow: stepBorrow,
    adjust: stepAdjust,
    wear_damp: stepWearDamp,
    wear_other: stepWearOther,
    cancel: stepCancel,
  },
};

// ── 의무 정리 (돌려주기·늦은 반납·새로 사 주기·모른 척·돌려줄 길 없음) ──

type Settle = Exclude<ObligationStatus, 'open'>;

/** 의무 하나를 닫는다. 관계·기억·돈을 바꾸고 결과 문장을 돌려준다 */
export function settleObligation(state: GameState, ob: DailyObligation, status: Settle, changes: Change[]): string {
  const ch = state.ch;
  const npc = present(ch, ob.npcId);
  const ctx: Ctx = { 도우미: npc ? nameOf(npc, ch) : ob.who, 옷: ob.what };
  ob.status = status;
  ob.closedAge = ch.age;
  trimClosed(ensureDaily(ch));
  const kind: MemoryKind =
    status === 'returned' ? 'returned' : status === 'forgotten' ? 'forgot' : status === 'void' ? 'void' : status === 'compensated' ? 'compensated' : 'returned_late';
  remember(state, ob.npcId, kind, ob.chainId);
  switch (status) {
    case 'returned':
      if (npc) closeness(npc, 3, ch, changes);
      changeAttr(state, 'stress', -1, changes);
      return say(state, ctx, 'returned');
    case 'returned_late':
      if (npc) closeness(npc, -2, ch, changes);
      return say(state, ctx, 'returnedLate');
    case 'compensated': {
      const base = rngFor(state.seed, 'daily', ob.id, 'compensate').int(3, 5) * 10_000;
      const p = pay(state, Math.round((base * state.world.economy.priceIndex) / 1000) * 1000);
      changes.push(paymentText(p));
      if (npc) closeness(npc, -1, ch, changes);
      return say(state, ctx, 'compensated');
    }
    case 'forgotten':
      if (npc) closeness(npc, -10, ch, changes);
      changeAttr(state, 'morality', -3, changes);
      return say(state, ctx, 'forgot');
    case 'void': {
      const gone = ch.npcs.find((n) => n.id === ob.npcId);
      return say(state, ctx, gone && !gone.alive ? 'lostDead' : 'lostGone');
    }
  }
}

function trimClosed(d: DailyState): void {
  const closed = d.obligations.filter((o) => o.status !== 'open');
  if (closed.length <= CLOSED_CAP) return;
  const drop = new Set(closed.slice(0, closed.length - CLOSED_CAP));
  d.obligations = d.obligations.filter((o) => !drop.has(o));
}

const SETTLE_STEP: Partial<Record<DailyStep, Settle>> = {
  return: 'returned_late',
  compensate: 'compensated',
  forget: 'forgotten',
  void: 'void',
};

// ── 데이터 검사 (validate.ts) ────────────────────────────

/** 엔진이 읽는 문장 열쇠 (사슬 단계가 lines.say에서 찾는다). 빠지면 빈 문장이 뜬다 */
const SAY_KEYS = [
  'stateWet', 'stateDamp', 'waitDry', 'waitDamp', 'waitWet', 'laundromat', 'laundromatGuardian',
  'lendTogether', 'lendBring', 'lendPickup', 'nobody', 'schoolLate', 'schoolLateGuardian', 'schoolWarn',
  'univYes', 'univNo', 'bossYes', 'bossNo', 'businessOpen', 'swapYes', 'swapNo', 'postponeYes',
  'weddingSkip', 'reunionLate', 'dampOk', 'dampSmell', 'dampLate', 'uniformCaught', 'uniformOk', 'gymOther',
  'otherFine', 'officeOther', 'shiftSpare', 'shiftNoSpare', 'outingOther', 'dateOther', 'cancelled', 'workWarn',
  'returned', 'returnedLate', 'compensated', 'forgot', 'lostDead', 'lostGone', 'closed', 'gone',
  // 인물의 거절 이유 (npcSituation·answerLend·answerPostpone)
  'refuse_far', 'refuse_asleep', 'refuse_working', 'refuse_overtime', 'refuse_curfew', 'refuse_away',
  'refuse_needsIt', 'refuse_mood', 'refuse_grudge', 'postpone_booked', 'postpone_nextPlan', 'postpone_mood', 'postpone_grudge',
];

/** 문장 표가 엔진과 맞는지: 일정마다 나서는 시각·문장·조정 문장·옷 목록, 날씨 정의, 단계 문장, 의무의 후속 사건 */
export function dailyDataIssues(eventIds: Set<string>): string[] {
  const out: string[] = [];
  const L = DAILY_LINES;
  for (const key of Object.keys(LEAVE)) {
    if (!L.schedule[key]) out.push(`lines.schedule.${key} 없음`);
    if (!L.adjust[key]) out.push(`lines.adjust.${key} 없음`);
  }
  const itemKeys = ['shift', 'office', 'school_elementary', 'school_secondary', 'school_university', 'outing', 'wedding'];
  for (const key of itemKeys) {
    const list = L.items[key];
    if (!list || list.length === 0) out.push(`lines.items.${key} 없음`);
    for (const it of list ?? []) if (!(it.thick > 0)) out.push(`lines.items.${key} '${it.name}'의 thick가 0 이하`);
  }
  // 사무직·교대 근무 옷 목록은 business 일정에도 쓴다 (itemKey가 office)
  for (const w of WEATHERS) {
    const def = L.weather[w];
    if (!def) out.push(`lines.weather.${w} 없음`);
    else if (!(def.hours[0] > 0 && def.hours[0] <= def.hours[1] && def.w > 0)) out.push(`lines.weather.${w}의 hours·w가 잘못됐다`);
  }
  for (const key of SAY_KEYS) if (!L.say[key]) out.push(`lines.say.${key} 없음`);
  for (const def of Object.values(OBLIGATION_KINDS)) {
    for (const id of [def.dueEvent, def.lostEvent]) if (!eventIds.has(id)) out.push(`의무 후속 사건 ${id} 없음`);
  }
  return out;
}

/** 엔진이 직접 예약하는 사건 (다른 사건의 next로 이어지지 않는다) */
export const DAILY_SYSTEM_EVENTS = Object.values(OBLIGATION_KINDS).flatMap((d) => [d.dueEvent, d.lostEvent]);

// ── 진입점 ───────────────────────────────────────────────

/** 사건 효과의 { type: 'daily', step } (effects.ts). 결과 문장은 ctx.결과, 상황은 ctx.상황에 남긴다 */
export function applyDailyAction(state: GameState, a: { step: string }, ec: EffectContext): void {
  const { ctx, changes } = ec;
  const step = a.step as DailyStep;
  if (step === 'start') {
    startChain(state, ctx);
    return;
  }
  const settle = SETTLE_STEP[step];
  if (settle) {
    const ob = readDaily(state.ch).obligations.find((o) => o.id === ctx.dailyOb);
    const text = ob && ob.status === 'open' ? settleObligation(state, ob, settle, changes) : say(state, ctx, 'closed');
    ctx.결과 = text;
    ctx.상황 = text;
    return;
  }
  const c = liveChain(state, ctx);
  const handler = c ? CHAIN_KINDS[c.kind]?.[step] : undefined;
  if (!handler || !c) {
    ctx.결과 = say(state, ctx, 'gone');
    return;
  }
  c.steps.push(step);
  handler(state, c, ctx, changes);
  refreshHelper(state, c);
  fillCtx(state, c, ctx);
}

/** 빨래·집안일 활동 (activities.json의 chore_*) */
export function isChore(def: ActivityDef): boolean {
  return def.id.startsWith('chore_');
}

/**
 * 활동 처리 (activities.ts의 훅). 빨래를 미리 하면 그해 사슬 확률이 줄고, 건조기를 들이면 크게 준다.
 * 빌린 옷 돌려주기는 가장 오래된 열린 의무를 제때 닫는다 (기한 전 반납: 독촉 카드는 뜨지 않는다).
 * 바뀐 활동 문장을 돌려주고, 없으면 undefined (활동의 log를 쓴다)
 */
export function choreActivity(state: GameState, def: ActivityDef, changes: Change[]): string | undefined {
  const ch = state.ch;
  switch (def.id) {
    case 'chore_laundry':
      ensureDaily(ch).preparedAge = ch.age;
      return undefined;
    case 'chore_dryer': {
      const d = ensureDaily(ch);
      d.dryer = true;
      d.dryerAge = ch.age;
      return undefined;
    }
    case 'chore_return': {
      const ob = returnable(state, 'return_clothes')[0];
      return ob ? settleObligation(state, ob, 'returned', changes) : undefined;
    }
  }
  return undefined;
}

