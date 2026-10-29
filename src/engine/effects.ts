// 사건·활동의 효과를 상태에 적용하고, 화면에 보여 줄 변화 목록을 만든다.
// 적용 순서: 능력치 → 돈 → 태그 추가 → 치료 단계 → 행동(do) → 태그 제거 → 상태 변화 보상 → 예약 → 긴장도 → 사망

import {
  closeBusiness,
  computeCsat,
  csatSummary,
  enterUniversity,
  graduateUniversity,
  leaveJob,
  retire,
  startBusiness,
  takeJob,
} from './career';
import { JOB_BY_ID, REGIONS, TAG_BY_ID } from './data';
import { addImpact } from './director';
import { formatWon, HIGH_TYPE_LABEL, josa, signedWon } from './format';
import { prosecute, release } from './justice';
import { barredFromJob } from './records';
import {
  addFriend,
  addSibling,
  alive,
  breakUp,
  changeCloseness,
  divorce,
  haveChild,
  loseFriend,
  marry,
  parentsDivorce,
  roleLabel,
  startPartner,
} from './relations';
import type { Rng } from './rng';
import { mortgageLimit } from './scope';
import type { Action, Effects, Range, TagDef, TreatStep } from './schema';
import { applySubstanceAction } from './substances';
import { applyDailyAction } from './daily';
import type { AttrKey, Change, GameState, TalentKey, UnivTier } from './types';
import { STAT_KEYS, HIDDEN_KEYS, STATE_KEYS } from './types';
import { TALENT_LABEL } from './text';

export const ATTR_LABEL: Record<AttrKey, string> = {
  health: '건강',
  stamina: '체력',
  intelligence: '지능',
  looks: '외모',
  sociability: '사교성',
  happiness: '행복',
  stress: '스트레스',
  reputation: '평판',
  morality: '도덕성',
  mental: '멘탈',
  luck: '운',
};

export function rollRange(r: Range, rng: Rng): number {
  return Array.isArray(r) ? rng.int(Math.min(r[0], r[1]), Math.max(r[0], r[1])) : r;
}

function clamp(x: number): number {
  return Math.max(0, Math.min(100, x));
}

/** 능력치 변경. 숨은 수치는 숫자 대신 느낌으로만 알려 준다 */
export function changeAttr(state: GameState, key: AttrKey, delta: number, changes: Change[]): void {
  if (delta === 0) return;
  const ch = state.ch;
  let before: number;
  if ((STAT_KEYS as readonly string[]).includes(key)) {
    const k = key as (typeof STAT_KEYS)[number];
    before = ch.stats[k];
    ch.stats[k] = clamp(before + delta);
    delta = ch.stats[k] - before;
  } else if ((HIDDEN_KEYS as readonly string[]).includes(key)) {
    const k = key as (typeof HIDDEN_KEYS)[number];
    before = ch.hidden[k];
    ch.hidden[k] = clamp(before + delta);
    delta = ch.hidden[k] - before;
  } else if ((STATE_KEYS as readonly string[]).includes(key)) {
    const k = key as (typeof STATE_KEYS)[number];
    before = ch.state[k];
    ch.state[k] = clamp(before + delta);
    delta = ch.state[k] - before;
  } else {
    throw new Error(`없는 능력치: ${key}`);
  }
  if (Math.round(delta) === 0) return;
  const d = Math.round(delta);
  if (key === 'morality') {
    if (d <= -8) changes.push({ text: '마음 한구석이 무거워졌다', sign: 'bad' });
    else if (d >= 8) changes.push({ text: '스스로가 조금 떳떳해졌다', sign: 'good' });
    return;
  }
  if (key === 'mental') {
    if (d <= -8) changes.push({ text: '마음에 상처가 남았다', sign: 'bad' });
    else if (d >= 8) changes.push({ text: '마음이 조금 단단해졌다', sign: 'good' });
    return;
  }
  if (key === 'luck') return;
  const good = key === 'stress' ? d < 0 : d > 0;
  changes.push({ text: `${ATTR_LABEL[key]} ${d > 0 ? '+' : '−'}${Math.abs(d)}`, sign: good ? 'good' : 'bad' });
}

// ── 태그 ─────────────────────────────────────────────────
// 기간이 있는 태그의 until은 '그 나이의 연말 결산에서 사라진다'는 뜻이다. 붙은 나이 + duration이 until이고,
// until 나이에도 연초 예약 사건과 그해 사건까지는 남아 있다 (expireFlags).

/** 지금 붙이면 언제까지 남는가 */
function untilFor(state: GameState, tag: TagDef | undefined): number | undefined {
  return tag?.duration !== undefined ? state.ch.age + tag.duration : undefined;
}

/** 이미 있는 태그는 그대로 둔다 (기한도 새로 잡지 않는다. 치료를 이어 가려면 treat의 continue를 쓴다) */
export function addFlag(state: GameState, id: string, changes: Change[]): void {
  const ch = state.ch;
  if (ch.flags[id]) return;
  const tag = TAG_BY_ID.get(id);
  ch.flags[id] = { since: ch.age, until: untilFor(state, tag) };
  if (tag?.visible) changes.push({ text: `태그: ${tag.name}`, sign: tag.sign ?? 'info' });
}

export function removeFlag(state: GameState, id: string, changes: Change[]): void {
  const ch = state.ch;
  if (!ch.flags[id]) return;
  delete ch.flags[id];
  const tag = TAG_BY_ID.get(id);
  if (tag?.visible && tag.sign === 'bad') changes.push({ text: `${tag.name} 태그가 사라졌다`, sign: 'good' });
}

/** '중단 후' 태그를 지금부터 새로 붙인다 (그만둔 때가 경과 사건의 기준이다) */
function markStopped(state: GameState, id: string): void {
  state.ch.flags[id] = { since: state.ch.age, until: untilFor(state, TAG_BY_ID.get(id)) };
}

/** 치료 태그를 지금부터 새로 잡는다. 하는 중이면 시작 나이는 그대로 두고 기한만 늘린다 */
function renewTreatment(state: GameState, tag: TagDef): void {
  const ch = state.ch;
  const since = ch.flags[tag.id]?.since ?? ch.age;
  ch.flags[tag.id] = { since, until: untilFor(state, tag) };
  if (tag.stopped) delete ch.flags[tag.stopped];
}

/**
 * 치료 한 단계 (schema의 TreatAct). 같은 상태에서 이어 가기와 그만두기를 고르면 저장한 뒤에도 서로 다르다:
 * 이어 가면 치료 중 태그의 기한이 새로 잡히고, 그만두면 치료 중 태그가 지워지고 '중단 후' 태그가 남는다.
 */
export function applyTreatment(state: GameState, step: TreatStep, changes: Change[]): void {
  const ch = state.ch;
  const tag = TAG_BY_ID.get(step.tag);
  if (!tag?.stopped) throw new Error(`치료 태그가 아니다 (stopped가 없다): ${step.tag}`);
  const using = Boolean(ch.flags[tag.id]);
  const name = tag.treatment ?? tag.name;
  switch (step.act) {
    case 'start':
    case 'resume':
    case 'continue': {
      // 하는 중이면 셋 다 '이어 가기'다. 그만둔 뒤라면 셋 다 다시 시작하는 것이다
      const fresh = step.act === 'start' && !ch.flags[tag.stopped];
      renewTreatment(state, tag);
      const until = ch.flags[tag.id].until;
      const label = using
        ? `${name} 유지${until !== undefined ? ` (${until}세까지)` : ''}`
        : `${name} ${fresh ? '시작' : '다시 시작'}`;
      changes.push({ text: label, sign: 'info' });
      break;
    }
    case 'reduce':
      // 올해 연말 결산까지만 하고 끝낸다. 계속 받아야 하는 치료면 그 뒤에 '중단 후' 태그가 남는다
      if (!using) break;
      ch.flags[tag.id] = { since: ch.flags[tag.id].since, until: ch.age };
      changes.push({ text: `${name} 줄여 가기 (올해까지)`, sign: 'info' });
      break;
    case 'stop':
      delete ch.flags[tag.id];
      markStopped(state, tag.stopped);
      changes.push({ text: `${name} 중단`, sign: 'info' });
      break;
  }
}

/**
 * 연말 결산에서 기한이 지난 태그를 지운다 (until 나이의 결산 때). 계속 받아야 하는 치료(ongoing)를
 * 유지하지 않은 채 기한을 넘기면 그만둔 것으로 보고 '중단 후' 태그를 남긴다. 정해진 기간을 마친 치료는 그냥 끝난다.
 */
export function expireFlags(state: GameState): void {
  const ch = state.ch;
  const lapsed: string[] = [];
  for (const [id, f] of Object.entries(ch.flags)) {
    if (f.until === undefined || ch.age < f.until) continue;
    delete ch.flags[id];
    const tag = TAG_BY_ID.get(id);
    if (tag?.ongoing && tag.stopped) lapsed.push(tag.stopped);
  }
  // 지우기를 다 끝낸 뒤에 붙인다 (같은 결산에서 지워질 옛 '중단 후' 태그와 섞이지 않게)
  for (const id of lapsed) markStopped(state, id);
}

export interface EffectContext {
  ctx: Record<string, string>;
  rng: Rng;
  changes: Change[];
}

export function applyEffects(state: GameState, fx: Effects | undefined, ec: EffectContext): void {
  if (!fx) return;
  const { rng, changes, ctx } = ec;
  const ch = state.ch;

  if (fx.stats) applyStats(state, fx.stats, rng, changes);

  if (fx.money) {
    const m = fx.money;
    const r = ch.res;
    if (m.cash !== undefined) cashChange(state, rollRange(m.cash, rng), changes);
    if (m.cash2026 !== undefined) {
      cashChange(state, Math.round((rollRange(m.cash2026, rng) * state.world.economy.priceIndex) / 1000) * 1000, changes);
    }
    if (m.cashPct !== undefined && r.cash > 0) {
      const amount = Math.round(r.cash * m.cashPct);
      r.cash += amount;
      if (amount < 0) ctx.lastLoss = String(-amount);
      if (amount !== 0) changes.push({ text: `현금 ${signedWon(amount)}`, sign: amount > 0 ? 'good' : 'bad' });
    }
    if (m.debt !== undefined) {
      const amount = rollRange(m.debt, rng);
      r.debt = Math.max(0, r.debt + amount);
      if (amount !== 0) changes.push({ text: `빚 ${signedWon(amount)}`, sign: amount > 0 ? 'bad' : 'good' });
    }
    for (const [field, label] of [
      ['stocksPct', 'stocks'],
      ['coinsPct', 'coins'],
      ['realEstatePct', 'realEstate'],
    ] as const) {
      const pct = m[field];
      if (pct === undefined || r[label] <= 0) continue;
      const amount = Math.round(r[label] * pct);
      r[label] += amount;
      const name = label === 'stocks' ? '주식' : label === 'coins' ? '코인' : '부동산';
      if (amount !== 0) changes.push({ text: `${name} ${signedWon(amount)}`, sign: amount > 0 ? 'good' : 'bad' });
    }
    if (m.network !== undefined) {
      const amount = rollRange(m.network, rng);
      r.network = clamp(r.network + amount);
      if (amount !== 0) changes.push({ text: `인맥 ${amount > 0 ? '+' : '−'}${Math.abs(amount)}`, sign: amount > 0 ? 'good' : 'bad' });
    }
  }

  // 상태 변화 보상은 태그가 바뀌기 전 상태와 비교한다
  const before = fx.transition ? transitionBefore(state, fx.transition.from, fx.transition.to) : undefined;
  for (const id of fx.addFlags ?? []) addFlag(state, id, changes);
  for (const step of fx.treat ?? []) applyTreatment(state, step, changes);
  for (const action of fx.do ?? []) runAction(state, action, ec);
  for (const id of fx.removeFlags ?? []) removeFlag(state, id, changes);
  if (fx.transition && before && transitioned(state, before, fx.transition.from, fx.transition.to)) {
    applyStats(state, fx.transition.stats, rng, changes);
  }

  for (const l of fx.later ?? []) {
    state.scheduled.push({ eventId: l.event, atAge: ch.age + l.inYears, ctx: { ...ctx } });
  }
  if (fx.tension) addImpact(state, fx.tension);
  if (fx.death) killCharacter(state, fx.death);
}

function applyStats(state: GameState, stats: NonNullable<Effects['stats']>, rng: Rng, changes: Change[]): void {
  for (const [key, r] of Object.entries(stats)) {
    if (r === undefined) continue;
    changeAttr(state, key as AttrKey, rollRange(r, rng), changes);
  }
}

function transitionBefore(state: GameState, from: string, to: string | undefined): { from: boolean; to: boolean } {
  const flags = state.ch.flags;
  return { from: Boolean(flags[from]), to: to !== undefined && Boolean(flags[to]) };
}

/** from이 있다가 사라졌고, to가 있으면 없다가 생겼는가. 이미 관리 중이던 사람에게는 보상이 없다 */
function transitioned(state: GameState, before: { from: boolean; to: boolean }, from: string, to: string | undefined): boolean {
  const flags = state.ch.flags;
  if (!before.from || flags[from]) return false;
  return to === undefined || (!before.to && Boolean(flags[to]));
}

// ── 지출 ─────────────────────────────────────────────────

/** 지출 한 번의 내역 (원). 청구액 total = 내 현금 cash + 새 빚 debt + 보호자 부담 guardian */
export interface Payment {
  total: number;
  cash: number;
  debt: number;
  guardian: number;
}

/**
 * 사건이 요구한 지출. 먼저 내 현금에서 낸다. 모자라면 미성년자는 나머지를 보호자가 내고 (아이에게 빚이 생기지 않는다),
 * 성인은 나머지가 빚이 된다. 돌려주는 내역으로 실제 잔액 변화와 다른 사람의 부담을 따로 보여 준다.
 * 보호자의 지원 자격·예산은 아직 모델링하지 않았다 (가구 회계 전체가 구현된 것은 아니다).
 */
export function pay(state: GameState, amount: number): Payment {
  const r = state.ch.res;
  const cash = Math.min(Math.max(0, r.cash), amount);
  r.cash -= cash;
  const rest = amount - cash;
  if (state.ch.age < 19) return { total: amount, cash, debt: 0, guardian: rest };
  r.debt += rest;
  return { total: amount, cash, debt: rest, guardian: 0 };
}

/** 지출 표시: 실제로 줄어든 내 현금을 앞에, 빚이나 보호자 부담으로 넘어간 몫을 괄호에 쓴다 */
export function paymentText(p: Payment): Change {
  const others = [p.debt > 0 ? `빚 +${formatWon(p.debt)}` : '', p.guardian > 0 ? `보호자 부담 ${formatWon(p.guardian)}` : '']
    .filter(Boolean)
    .join(', ');
  if (p.cash > 0) return { text: `현금 −${formatWon(p.cash)}${others ? ` (${others})` : ''}`, sign: 'bad' };
  // 내 돈은 그대로다: 빚이 늘었거나 (성인) 보호자가 다 냈다 (미성년자)
  return { text: others, sign: p.debt > 0 ? 'bad' : 'info' };
}

/** 현금이 오가는 효과: 들어오면 그대로 더하고, 나가면 pay로 실제 지급 내역을 나눠 보여 준다 */
function cashChange(state: GameState, amount: number, changes: Change[]): void {
  if (amount === 0) return;
  if (amount > 0) {
    state.ch.res.cash += amount;
    changes.push({ text: `현금 ${signedWon(amount)}`, sign: 'good' });
    return;
  }
  changes.push(paymentText(pay(state, -amount)));
}

export function killCharacter(state: GameState, cause: string): void {
  const ch = state.ch;
  if (!ch.alive) return;
  ch.alive = false;
  ch.death = { age: ch.age, year: state.year, cause };
}

function discoverTalent(state: GameState, key: TalentKey | undefined, changes: Change[]): TalentKey | undefined {
  const ch = state.ch;
  const t = key ? ch.talents.find((x) => x.key === key) : ch.talents.find((x) => !x.discovered);
  if (!t || t.discovered) return undefined;
  t.discovered = true;
  changes.push({ text: `숨은 재능 발견: ${TALENT_LABEL[t.key]}`, sign: 'good' });
  return t.key;
}

function runAction(state: GameState, a: Action, ec: EffectContext): void {
  const { rng, changes, ctx } = ec;
  const ch = state.ch;
  switch (a.type) {
    case 'discoverTalent': {
      const key = a.talent ?? (ctx.talent as TalentKey | undefined);
      discoverTalent(state, key || undefined, changes);
      break;
    }
    case 'addSibling': {
      const s = addSibling(state, rng);
      changes.push({ text: `${roleLabel(s, ch)} ${s.name}`, sign: 'good' });
      break;
    }
    case 'addFriend': {
      if (ctx.friendId) break; // 이미 아는 친구
      const f = addFriend(state, rng, ctx.친구);
      ctx.friendId = f.id;
      changes.push({ text: `새 친구: ${f.name}`, sign: 'good' });
      break;
    }
    case 'loseFriend': {
      const f = loseFriend(state, rng, ctx.friendId);
      if (f) changes.push({ text: `${josa(f.name, '와/과')} 멀어졌다`, sign: 'bad' });
      break;
    }
    case 'startPartner': {
      const p = startPartner(state, rng, ctx.상대);
      changes.push({ text: `연인: ${p.name}`, sign: 'good' });
      break;
    }
    case 'breakUp': {
      const p = breakUp(state);
      if (p) changes.push({ text: `${josa(p.name, '와/과')} 헤어졌다`, sign: 'bad' });
      break;
    }
    case 'marry': {
      const s = marry(state);
      if (s) changes.push({ text: `결혼: ${s.name}`, sign: 'good' });
      break;
    }
    case 'haveChild': {
      const c = haveChild(state, rng);
      changes.push({ text: `${roleLabel(c, ch)} ${c.name} 출생`, sign: 'good' });
      break;
    }
    case 'divorce': {
      const s = divorce(state);
      if (s) {
        state.ch.flags.divorced = { since: ch.age };
        changes.push({ text: '이혼 (재산 분할)', sign: 'bad' });
      }
      break;
    }
    case 'parentsDivorce':
      parentsDivorce(state, a.with ?? 'mother');
      changes.push({ text: '부모님 이혼', sign: 'bad' });
      break;
    case 'parentsMarriage':
      ch.family.marriageQuality = clamp(ch.family.marriageQuality + a.delta);
      break;
    case 'moveRegion': {
      const options = REGIONS.filter((r) => r.id !== ch.region);
      const target = a.region ?? rng.weighted(options, (r) => r.births2024)?.id ?? ch.region;
      ch.region = target;
      const name = REGIONS.find((r) => r.id === target)?.short ?? target;
      changes.push({ text: `이사: ${name}`, sign: 'info' });
      break;
    }
    case 'enroll': {
      ch.edu.status = a.school;
      if (a.highType) ch.edu.highType = a.highType;
      if (a.school === 'elementary' || a.school === 'middle' || a.school === 'high') {
        // 새 학교, 새 반: 진행 중이던 따돌림은 끊긴다
        delete ch.flags.bullying_active;
      }
      if (a.school === 'high') {
        changes.push({ text: `입학: ${HIGH_TYPE_LABEL[a.highType ?? 'general']}`, sign: 'info' });
      }
      // 자퇴하면 학력은 중졸. 검정고시에 붙어야 고졸이 된다
      break;
    }
    case 'passGed':
      ch.edu.degree = 'high';
      addFlag(state, 'ged', changes);
      break;
    case 'earlyAdmit': {
      const name = ctx.합격대학;
      const tier = ctx.합격등급 as UnivTier | undefined;
      if (name && tier) {
        ch.edu.earlyAdmit = { name, tier };
        changes.push({ text: `수시 합격: ${name}`, sign: 'good' });
      }
      break;
    }
    case 'computeCsat': {
      computeCsat(state, rng);
      ctx.수능 = csatSummary(state);
      break;
    }
    case 'enterUniversity': {
      const early = a.early ? ch.edu.earlyAdmit : undefined;
      const tier = early?.tier ?? (ctx.합격등급 as UnivTier | undefined);
      const name = enterUniversity(state, rng, early?.name ?? ctx.합격대학, tier);
      if (early) addFlag(state, 'early_admission', changes);
      ch.edu.earlyAdmit = undefined;
      ctx.대학 = name;
      changes.push({ text: `입학: ${name}`, sign: 'good' });
      break;
    }
    case 'graduate':
      if (ch.edu.status === 'high') {
        ch.edu.status = 'graduated';
        ch.edu.degree = 'high';
      } else if (ch.edu.status === 'university') {
        graduateUniversity(state);
        changes.push({ text: `졸업: ${ch.edu.univ?.name ?? '대학'}`, sign: 'good' });
      }
      break;
    case 'getJob': {
      // 공공 부문 결격 기간이면 사건이 주는 직업도 임용되지 않는다 (직업 목록과 같은 조회, records.ts)
      if (barredFromJob(ch, a.job)) {
        changes.push({ text: `임용 결격: ${JOB_BY_ID.get(a.job)?.title ?? a.job}`, sign: 'bad' });
        break;
      }
      const job = takeJob(state, a.job);
      changes.push({ text: `직업: ${job.title}`, sign: 'good' });
      break;
    }
    case 'loseJob': {
      if (!ch.career.jobId) break;
      const title = ch.career.title;
      const pay = ch.career.business ? closeBusiness(state, 0.1) : leaveJob(state, a.severanceMonths ?? 0);
      changes.push({ text: `${josa(title ?? '일', '을/를')} 그만뒀다`, sign: 'bad' });
      if (pay > 0) changes.push({ text: `퇴직금 ${formatWon(pay)}`, sign: 'good' });
      break;
    }
    case 'promote': {
      if (!ch.career.jobId) break;
      ch.career.raise *= 1 + a.pct;
      ch.career.salary = Math.round(ch.career.salary * (1 + a.pct));
      changes.push({ text: `연봉 +${Math.round(a.pct * 100)}%`, sign: 'good' });
      break;
    }
    case 'retire': {
      const monthly = Math.round(retire(state) / 12 / 1000) * 1000;
      ctx.연금 = formatWon(monthly);
      changes.push({ text: `연금 월 ${formatWon(monthly)}`, sign: 'info' });
      break;
    }
    case 'militaryExam': {
      const score = ch.stats.health * 0.6 + ch.stats.stamina * 0.4 + rng.normal(0, 8);
      let grade = score >= 80 ? 1 : score >= 68 ? 2 : score >= 52 ? 3 : score >= 40 ? 4 : score >= 25 ? 5 : 6;
      if (ch.traits.includes('congenital_heart')) grade = Math.max(grade, 5);
      if (ch.flags.industrial_injury) grade = Math.max(grade, 4);
      ch.military.grade = grade;
      ctx.신체등급 = String(grade);
      if (grade >= 5) {
        ch.military.status = 'exempt';
        addFlag(state, 'military_exempt', changes);
      }
      break;
    }
    case 'enlist': {
      const grade = ch.military.grade ?? 1;
      if (grade >= 5) break;
      ch.military.status = 'pending';
      ch.military.branch = grade === 4 ? 'social' : (a.branch ?? 'army');
      ch.military.enlistAge = ch.age + (a.inYears ?? 1);
      break;
    }
    case 'startService': {
      ch.military.status = 'serving';
      ch.military.dischargeAge = ch.age + 2;
      ch.military.unitMood = rng.int(10, 95);
      if (ch.edu.status === 'university') ch.edu.onLeave = true;
      if (ch.career.jobId && !ch.career.business) leaveJob(state, 0);
      ch.family.livesWithParents = false;
      break;
    }
    case 'discharge':
      ch.military.status = 'done';
      ch.military.dischargeAge = undefined;
      if (ch.edu.onLeave && ch.edu.univ) {
        ch.edu.onLeave = false;
        ch.edu.univ.years += 2; // 군 휴학한 만큼 졸업이 늦어진다
      }
      ch.family.livesWithParents = ch.family.type !== 'facility' && alive(ch, 'mother', 'father').length > 0;
      break;
    case 'prosecute': {
      const crimeId = a.crime === 'ctx' ? ctx.crime : a.crime;
      const v = prosecute(state, crimeId, rng, a.lenient);
      ctx.판결 = v.text;
      changes.push(...v.changes);
      if (crimeId === 'desertion') ch.military.status = 'done';
      break;
    }
    case 'release':
      release(state);
      break;
    case 'gamble': {
      const stake = Math.round(Math.max(0, ch.res.cash) * a.stakePct);
      if (stake <= 0) {
        ctx.결과 = '걸 돈이 없었다.';
        break;
      }
      const to10k = (x: number) => Math.round(x / 10_000) * 10_000;
      let delta: number;
      if (rng.chance(a.winChance)) {
        delta = to10k(stake * (a.winMult - 1) * rng.float(0.6, 1.4));
        ctx.결과 = `${signedWon(delta)}. 수익 인증 사진을 단톡방에 올렸다.`;
      } else {
        delta = -to10k(stake * rng.float(0.4, 0.95));
        ctx.결과 = `${signedWon(delta)}. 손절 버튼 위에서 손가락이 멈췄다.`;
      }
      ch.res.cash += delta;
      changes.push({ text: `현금 ${signedWon(delta)}`, sign: delta > 0 ? 'good' : 'bad' });
      break;
    }
    case 'startBusiness': {
      const capital = startBusiness(state, a.capitalPct, a.name ?? '가게');
      changes.push({ text: `창업 자금 ${formatWon(capital)}`, sign: 'info' });
      break;
    }
    case 'closeBusiness': {
      const got = closeBusiness(state, a.recoverPct);
      changes.push({ text: `폐업 (회수 ${formatWon(got)})`, sign: 'bad' });
      break;
    }
    case 'parentHealth': {
      const p = ch.npcs.find((n) => n.id === ctx.parentId && n.alive) ?? alive(ch, 'mother', 'father')[0];
      if (p) p.health = clamp(p.health + a.delta);
      break;
    }
    case 'npcCloseness': {
      // 카드가 정한 사람이 있으면 그 사람만 (형제·자녀·친구·부모)
      const target =
        a.role === 'sibling' ? ctx.siblingId : a.role === 'child' ? ctx.childId : a.role === 'friend' ? ctx.friendId : undefined;
      const changed = changeCloseness(ch, a.role, a.delta, target);
      if (changed.length === 1 && a.delta !== 0) {
        changes.push({ text: `${changed[0].name} 친밀도 ${a.delta > 0 ? '+' : '−'}${Math.abs(a.delta)}`, sign: a.delta > 0 ? 'good' : 'bad' });
      } else if (changed.length > 1 && a.delta !== 0) {
        changes.push({ text: `${roleLabel(changed[0], ch)} 등 ${changed.length}명 친밀도 ${a.delta > 0 ? '+' : '−'}${Math.abs(a.delta)}`, sign: a.delta > 0 ? 'good' : 'bad' });
      }
      break;
    }
    case 'leaveHome':
      ch.family.livesWithParents = false;
      break;
    case 'refundPct': {
      const loss = Number(ctx.lastLoss ?? 0);
      const amount = Math.round(loss * a.pct);
      if (amount > 0) {
        ch.res.cash += amount;
        changes.push({ text: `환급 ${signedWon(amount)}`, sign: 'good' });
      }
      break;
    }
    case 'inherit': {
      const total = Number(ctx.inheritance ?? 0);
      const raw = Math.round(total * a.share);
      const amount = a.limited ? Math.max(0, raw) : raw;
      if (amount >= 0) ch.res.cash += amount;
      else ch.res.debt += -amount;
      if (amount !== 0) changes.push({ text: `상속 ${signedWon(amount)}`, sign: amount > 0 ? 'good' : 'bad' });
      ch.family.estate = 0;
      ch.family.hiddenDebt = 0;
      break;
    }
    case 'debtRelief': {
      const r = ch.res;
      if (a.pct >= 1) {
        // 파산: 남은 재산은 채권자에게 넘어가고 빚은 면책된다
        r.cash = 0;
        r.stocks = 0;
        r.coins = 0;
        r.realEstate = 0;
        removeFlag(state, 'homeowner', changes);
      }
      const forgiven = Math.round(r.debt * Math.min(1, a.pct));
      r.debt -= forgiven;
      if (forgiven > 0) changes.push({ text: `빚 −${formatWon(forgiven)} (면책)`, sign: 'good' });
      addFlag(state, 'bankrupt', changes);
      break;
    }
    case 'separateFamily': {
      const candidates = ch.npcs.filter(
        (n) => n.alive && !n.missing && ['mother', 'father', 'sibling', 'grandparent', 'spouse', 'child'].includes(n.role),
      );
      if (candidates.length === 0) break;
      const lost = rng.pick(candidates);
      lost.missing = true;
      ctx.헤어진가족 = roleLabel(lost, ch);
      addFlag(state, 'separated_family', changes);
      changes.push({ text: `${roleLabel(lost, ch)} ${josa(lost.name, '과/와')} 헤어졌다`, sign: 'bad' });
      break;
    }
    case 'reunite': {
      const lost = ch.npcs.find((n) => n.missing);
      if (!lost) break;
      lost.missing = false;
      if (!lost.alive) {
        ctx.상봉 = `${josa(roleLabel(lost, ch), '은/는')} 이미 세상을 떠난 뒤였다.`;
        changes.push({ text: `${lost.name}의 소식을 들었다`, sign: 'bad' });
      } else {
        ctx.상봉 = `${josa(roleLabel(lost, ch), '이/가')} 살아 있었다.`;
        lost.closeness = Math.max(lost.closeness, 80);
        changes.push({ text: `${josa(lost.name, '과/와')} 다시 만났다`, sign: 'good' });
      }
      if (!ch.npcs.some((n) => n.missing)) removeFlag(state, 'separated_family', changes);
      break;
    }
    case 'setStyle':
      for (const s of ['basic', 'trendy', 'luxury', 'comfort']) {
        if (s !== a.style) delete ch.flags[`style_${s}`];
      }
      addFlag(state, `style_${a.style}`, changes);
      break;
    case 'grade':
      ch.edu.grade = clamp(ch.edu.grade + a.delta);
      changes.push({ text: `내신 ${a.delta > 0 ? '+' : '−'}${Math.abs(a.delta)}`, sign: a.delta > 0 ? 'good' : 'bad' });
      break;
    case 'buyHome': {
      // 계약금 비율(LTV)과 소득 대비 대출 한도(DSR)를 모두 넘지 않는 선에서 산다.
      // 모자라면 더 작은 집으로 낮추고, 그래도 안 되면 계약을 못 한다.
      const listed = Number(ctx.homePrice ?? 0);
      if (listed <= 0 || ch.flags.homeowner) break;
      const cash = Math.max(0, ch.res.cash);
      const maxLoan = mortgageLimit(state);
      const affordable = Math.min(listed, cash / a.downPct, cash + maxLoan);
      if (affordable < listed * 0.4) {
        changes.push({ text: '대출 한도가 모자라 계약하지 못했다', sign: 'bad' });
        break;
      }
      const price = Math.round(affordable / 1_000_000) * 1_000_000;
      const down = Math.min(cash, Math.max(Math.round(price * a.downPct), price - maxLoan));
      ch.res.cash -= down;
      ch.res.debt += price - down;
      ch.res.realEstate += price;
      addFlag(state, 'homeowner', changes);
      if (price < listed) changes.push({ text: '돈에 맞춰 더 작은 집을 골랐다', sign: 'info' });
      changes.push({ text: `집 ${formatWon(price)} (대출 ${formatWon(price - down)})`, sign: 'info' });
      break;
    }
    case 'substance':
      // 술·담배·약물: 사용·거절·줄이기·끊기·치료. 미성년자의 사용은 substances.ts가 막는다
      applySubstanceAction(state, a, ec);
      break;
    case 'daily':
      // 하루 사슬(빨래와 다음 날 일정): 시각·옷·부탁·반납 의무는 daily.ts가 기록한다
      applyDailyAction(state, a, ec);
      break;
  }
}
