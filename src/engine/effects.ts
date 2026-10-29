// 사건·활동의 효과를 상태에 적용하고, 화면에 보여 줄 변화 목록을 만든다.
// 적용 순서: 능력치 → 돈 → 태그 추가 → 행동(do) → 태그 제거 → 예약 → 긴장도 → 사망

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
import { REGIONS, TAG_BY_ID } from './data';
import { addImpact } from './director';
import { formatWon, HIGH_TYPE_LABEL, josa, signedWon } from './format';
import { prosecute, payOrBorrow, release } from './justice';
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
import type { Action, Effects, Range } from './schema';
import { applySubstanceAction } from './substances';
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

export function addFlag(state: GameState, id: string, changes: Change[]): void {
  const ch = state.ch;
  if (ch.flags[id]) return;
  const tag = TAG_BY_ID.get(id);
  ch.flags[id] = { since: ch.age, until: tag?.duration !== undefined ? ch.age + tag.duration : undefined };
  if (tag?.visible) changes.push({ text: `태그: ${tag.name}`, sign: tag.sign ?? 'info' });
}

export function removeFlag(state: GameState, id: string, changes: Change[]): void {
  const ch = state.ch;
  if (!ch.flags[id]) return;
  delete ch.flags[id];
  const tag = TAG_BY_ID.get(id);
  if (tag?.visible && tag.sign === 'bad') changes.push({ text: `${tag.name} 태그가 사라졌다`, sign: 'good' });
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

  if (fx.stats) {
    for (const [key, r] of Object.entries(fx.stats)) {
      if (r === undefined) continue;
      changeAttr(state, key as AttrKey, rollRange(r, rng), changes);
    }
  }

  if (fx.money) {
    const m = fx.money;
    const r = ch.res;
    if (m.cash !== undefined) {
      const amount = rollRange(m.cash, rng);
      if (amount < 0) payOrBorrow(state, -amount);
      else r.cash += amount;
      if (amount !== 0) changes.push({ text: `현금 ${signedWon(amount)}`, sign: amount > 0 ? 'good' : 'bad' });
    }
    if (m.cash2026 !== undefined) {
      const amount = Math.round((rollRange(m.cash2026, rng) * state.world.economy.priceIndex) / 1000) * 1000;
      if (amount < 0) payOrBorrow(state, -amount);
      else r.cash += amount;
      if (amount !== 0) changes.push({ text: `현금 ${signedWon(amount)}`, sign: amount > 0 ? 'good' : 'bad' });
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

  for (const id of fx.addFlags ?? []) addFlag(state, id, changes);
  for (const action of fx.do ?? []) runAction(state, action, ec);
  for (const id of fx.removeFlags ?? []) removeFlag(state, id, changes);

  for (const l of fx.later ?? []) {
    state.scheduled.push({ eventId: l.event, atAge: ch.age + l.inYears, ctx: { ...ctx } });
  }
  if (fx.tension) addImpact(state, fx.tension);
  if (fx.death) killCharacter(state, fx.death);
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
    case 'npcCloseness':
      changeCloseness(ch, a.role, a.delta, a.role === 'sibling' ? ctx.siblingId : undefined);
      break;
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
  }
}
