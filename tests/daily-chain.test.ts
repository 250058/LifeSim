// 하루 사슬 F-001: 세탁 지연과 다음 날 일정 (검토 2026-10-29 03:55 F-001, 09:52 '작은 일상 사슬')
//
// - 덜 마른 빨래 + 날씨 + 다음 날 일정(새벽 교대 근무·출근·등교·외출)이 한 장면으로 엮인다
// - 기다리기·빨래방·옷 빌리기·일정 조정·다른 옷 입기 각 갈래가 옷 상태·돈·시간·지각·관계 기억을 남긴다
// - 부탁 상대는 실제 인물 ID로 묶이고, 자기 사정·성향·기억으로 스스로 거절할 수 있다
// - 빌린 옷은 나중에 돌려줘야 한다: 기한 전에 돌려주면 독촉이 없고, 모른 척하면 관계와 다음 부탁에 남는다
// - 사슬 중간에 저장·불러오기를 해도 같은 선택은 같은 결과다. 같은 시드는 같은 기록이다
// - 옛 저장(하루 기록 없음)도 불러오고 사슬을 시작할 수 있다

import { describe, expect, it } from 'vitest';
import { activityViews } from '../src/engine/activities';
import { takeJob } from '../src/engine/career';
import {
  answerLend,
  clockText,
  DAILY_LINES,
  DAILY_STEPS,
  dailyScope,
  readDaily,
  spanText,
  type DailyChain,
  type DailyState,
} from '../src/engine/daily';
import { EVENT_FILES, getEvent } from '../src/engine/data';
import { eventProbability, presentCard } from '../src/engine/eventEngine';
import { choose, doActivity, endTurn, newGame, proceed } from '../src/engine/game';
import { addSibling, makeNpc, startPartner } from '../src/engine/relations';
import { rngFor } from '../src/engine/rng';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import { buildScope } from '../src/engine/scope';
import { simulateLife } from '../src/engine/sim';
import { render } from '../src/engine/text';
import type { GameState, Npc, Sex } from '../src/engine/types';
import { validateData } from '../src/engine/validate';

// ── 상태 만들기 ──────────────────────────────────────────

interface Setup {
  age: number;
  sex?: Sex;
  job?: string;
  school?: 'elementary' | 'middle' | 'high' | 'university';
  retired?: boolean;
  cash?: number;
  /** 같은 성별·또래 친구 (친밀도) */
  friend?: number;
}

function person(seed: string, o: Setup): GameState {
  const s = newGame({ seed, mode: 'reality', birthYear: 2026 });
  const ch = s.ch;
  if (o.sex) ch.sex = o.sex;
  ch.age = o.age;
  s.year = ch.birthYear + o.age;
  s.world.year = s.year;
  ch.edu.status = o.school ?? 'graduated';
  ch.edu.degree = o.age >= 23 ? 'university' : 'high';
  ch.family.livesWithParents = o.age < 19;
  ch.res.cash = o.cash ?? 1_000_000;
  ch.res.debt = 0;
  if (o.job) takeJob(s, o.job);
  if (o.retired) ch.career.retired = true;
  if (o.friend !== undefined) {
    const f = makeNpc(s, rngFor(seed, 'friend'), 'friend', ch.sex, ch.birthYear, { closeness: o.friend });
    ch.npcs.push(f);
  }
  s.card = undefined;
  s.queue = [];
  s.scheduled = [];
  s.phase = 'action';
  s.step = 'yearStart';
  s.points = { max: 3, left: 3 };
  return s;
}

/** 덜 마른 빨래 카드를 띄운다 */
function open(s: GameState): DailyChain {
  expect(presentCard(s, { eventId: 'daily_laundry', ctx: {} })).toBe(true);
  return s.ch.daily!.chain!;
}

/** 지금 카드에서 그 단계를 하는 선택지의 화면 번호 (없으면 -1) */
function stepIndex(s: GameState, step: string): number {
  const card = s.card;
  if (!card || card.result) return -1;
  const ev = getEvent(card.eventId);
  return card.choices.findIndex((c) => (ev.choices![c.index].effects?.do ?? []).some((a) => a.type === 'daily' && a.step === step));
}

/** 그 단계를 고르고 결과 문장을 돌려준 뒤 카드를 넘긴다 */
function act(s: GameState, step: string): string {
  const i = stepIndex(s, step);
  expect(i, `선택지 없음: ${step} (${s.card?.choices.map((c) => c.text).join(' / ')})`).toBeGreaterThanOrEqual(0);
  choose(s, i);
  const text = s.card!.result!.text;
  proceed(s);
  return text;
}

/** 조건을 만족하는 첫 시드의 상태를 찾는다 (사슬 난수는 시드·사슬 id로만 정해진다) */
function find(prefix: string, make: (seed: string) => GameState, ok: (s: GameState) => boolean, limit = 400): GameState {
  for (let i = 0; i < limit; i++) {
    const s = make(`${prefix}-${i}`);
    if (ok(s)) return s;
  }
  throw new Error(`${prefix}: 조건에 맞는 시드가 없다`);
}

const memStore = (): KeyValueStorage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

function roundTrip(s: GameState): GameState {
  const store = memStore();
  expect(saveGame(s, store)).toBe(true);
  return loadGame(store)!;
}

/** 그다음 해의 자유 행동으로 건너뛴다 (무작위 사건 없이: 단위 검증용) */
function skipYear(s: GameState): void {
  s.ch.age += 1;
  s.year += 1;
  s.world.year += 1;
  s.phase = 'action';
  s.points = { max: 3, left: 3 };
  s.actions = {};
}

function lenderOf(s: GameState): Npc {
  const ob = readDaily(s.ch).obligations[0];
  return s.ch.npcs.find((n) => n.id === ob.npcId)!;
}

const scope = (s: GameState, ctx: Record<string, string> = {}) => buildScope(s, ctx).daily as Record<string, unknown>;

// ── 데이터 ───────────────────────────────────────────────

describe('하루 사슬 데이터', () => {
  it('사건이 등록되고, 모든 행동 단계와 문장 자리표시자가 맞으며, 검증 오류·경고가 없다', () => {
    const events = EVENT_FILES['events/daily.json'];
    expect(events.map((e) => e.id)).toEqual(['daily_laundry', 'daily_laundry_fallback', 'daily_return_due', 'daily_return_lost']);
    for (const ev of events) {
      const fxs = [ev.effects, ...(ev.choices ?? []).map((c) => c.effects)];
      for (const fx of fxs) for (const a of fx?.do ?? []) if (a.type === 'daily') expect(DAILY_STEPS as readonly string[]).toContain(a.step);
    }
    expect(validateData().filter((i) => i.where.includes('daily'))).toEqual([]);
    // 문장 표의 자리표시자는 모두 채워진다
    const s = person('DAILY-LINES', { age: 30 });
    const ctx = { 옷: '셔츠', 도우미: '민지', 시각: '밤 11시', 지각: '20분', 이동: '30분', 왕복: '1시간', 약속상대: '지수' };
    const all = [...Object.values(DAILY_LINES.say), ...Object.values(DAILY_LINES.schedule), ...Object.values(DAILY_LINES.adjust)];
    for (const t of all) expect(render(t, s, ctx), t).not.toMatch(/[{}]/);
  });

  it('시각·시간 표기', () => {
    expect(clockText(23 * 60 + 50)).toBe('밤 11시 50분');
    expect(clockText(1440 + 5 * 60 + 20)).toBe('새벽 5시 20분');
    expect(clockText(1440 + 7 * 60)).toBe('아침 7시');
    expect(clockText(1440 + 10)).toBe('밤 12시 10분');
    expect(spanText(100)).toBe('1시간 40분');
    expect(spanText(40)).toBe('40분');
  });
});

// ── 맥락 ─────────────────────────────────────────────────

describe('다음 날 일정과 엮이는 맥락', () => {
  const kinds = (make: (seed: string) => GameState, n = 40) => {
    const out = new Set<string>();
    for (let i = 0; i < n; i++) {
      const s = make(`DAILY-CTX-${i}`);
      const c = open(s);
      out.add(c.schedule.kind);
      expect(c.now).toBeLessThan(c.deadline);
      expect(c.clothes).toBe('wet');
      expect(s.card!.text).not.toMatch(/[{}]/);
    }
    return out;
  };

  it('중학생은 등교(가끔 친구 약속), 공장 교대 근무자는 새벽 교대, 사무직은 출근, 은퇴자는 외출', () => {
    const student = kinds((seed) => person(seed, { age: 15, school: 'middle', friend: 70 }));
    expect(student.has('school')).toBe(true);
    expect([...student].every((k) => k === 'school' || k === 'outing')).toBe(true);
    expect(kinds((seed) => person(seed, { age: 35, job: 'factory' }))).toContain('shift');
    expect(kinds((seed) => person(seed, { age: 35, job: 'sme_office' }))).toContain('office');
    expect([...kinds((seed) => person(seed, { age: 72, retired: true, friend: 60 }))]).toEqual(['outing']);
  });

  it('교대 근무는 새벽에 나서고, 카드 문장에 그 일정이 들어간다', () => {
    const s = find('DAILY-SHIFT', (seed) => person(seed, { age: 35, job: 'factory' }), (x) => open(x).schedule.kind === 'shift');
    const c = s.ch.daily!.chain!;
    expect(c.deadline - 1440).toBeLessThan(6 * 60);
    expect(s.card!.text).toContain('교대 근무');
  });

  it('데이트 외출과 연인에게 옷 빌리기는 나와 상대가 모두 성인일 때만', () => {
    for (let i = 0; i < 60; i++) {
      const s = person(`DAILY-MINOR-${i}`, { age: 17, school: 'high' });
      const p = makeNpc(s, rngFor(s.seed, 'p'), 'partner', s.ch.sex === 'M' ? 'F' : 'M', s.ch.birthYear, { closeness: 95 });
      s.ch.npcs.push(p);
      const c = open(s);
      expect(c.schedule.outing).not.toBe('date');
      expect(c.helperId).not.toBe(p.id);
    }
    // 성인 커플이면 데이트 일정이 나올 수 있다
    const adult = find('DAILY-DATE', (seed) => {
      const s = person(seed, { age: 28 });
      startPartner(s, rngFor(seed, 'p'));
      return s;
    }, (s) => open(s).schedule.outing === 'date');
    expect(adult.card!.text).toContain('데이트');
  });
});

// ── 갈래 ─────────────────────────────────────────────────

describe('갈래마다 남는 상태', () => {
  it('기다리기: 제때 마르면 그대로 끝난다', () => {
    const s = find('DAILY-WAITOK', (seed) => person(seed, { age: 30 }), (x) => {
      open(x);
      act(x, 'wait');
      return x.ch.daily!.chain!.outcome === 'dried';
    });
    const c = s.ch.daily!.chain!;
    expect(c.clothes).toBe('dry');
    expect(c.steps).toEqual(['start', 'wait']);
    expect(s.phase).toBe('action');
    expect(s.counts.daily_laundry_fallback).toBeUndefined();
    expect(readDaily(s.ch).history.at(-1)!.outcome).toBe('dried');
  });

  it('기다리기: 덜 마르면 아침에 남은 방법으로 다시 고르고, 덜 마른 옷을 입고 나갈 수 있다', () => {
    const s = find('DAILY-WAITDAMP', (seed) => person(seed, { age: 30 }), (x) => {
      open(x);
      act(x, 'wait');
      return x.ch.daily!.chain!.clothes === 'damp';
    });
    const c = s.ch.daily!.chain!;
    expect(s.card!.eventId).toBe('daily_laundry_fallback');
    expect(c.now).toBe(c.deadline - 45);
    expect(stepIndex(s, 'wait')).toBe(-1); // 기다리기는 한 번뿐
    act(s, 'wear_damp');
    expect(c.outcome).toBe('damp');
    expect(s.phase).toBe('action');
  });

  it('빨래방: 성인은 내 돈과 시간을 쓴다', () => {
    const s = find('DAILY-LAUNDRY', (seed) => person(seed, { age: 30, cash: 500_000 }), (x) => {
      open(x);
      return stepIndex(x, 'laundromat') >= 0;
    });
    const c = s.ch.daily!.chain!;
    expect(s.card!.choices[stepIndex(s, 'laundromat')].text).toContain(c.laundromatCost.toLocaleString('ko-KR'));
    act(s, 'laundromat');
    expect(s.ch.res.cash).toBe(500_000 - c.laundromatCost);
    expect(c.spent).toBe(c.laundromatCost);
    expect(c.outcome).toBe('laundromat');
    expect(c.timeUsed).toBeGreaterThanOrEqual(80);
  });

  it('빨래방: 열두 살은 보호자와 가고, 모자란 돈은 보호자가 낸다 (아이에게 빚이 생기지 않는다)', () => {
    const s = find('DAILY-KID', (seed) => person(seed, { age: 12, school: 'elementary', cash: 0 }), (x) => {
      open(x);
      return stepIndex(x, 'laundromat') >= 0;
    });
    const c = s.ch.daily!.chain!;
    const text = act(s, 'laundromat');
    expect(text).toContain('함께');
    expect(s.ch.res.cash).toBe(0);
    expect(s.ch.res.debt).toBe(0);
    expect(c.guardianPaid).toBe(c.laundromatCost);
  });

  it('옷 빌리기: 수락하면 그 인물 ID로 반납 의무가 생기고 2년 뒤 독촉 카드가 예약된다', () => {
    const s = find('DAILY-LEND', (seed) => person(seed, { age: 30, friend: 90 }), (x) => {
      open(x);
      if (stepIndex(x, 'borrow') < 0) return false;
      act(x, 'borrow');
      return x.ch.daily!.chain!.outcome === 'borrowed';
    });
    const c = s.ch.daily!.chain!;
    const d = readDaily(s.ch);
    const ob = d.obligations[0];
    expect(ob).toMatchObject({ kind: 'return_clothes', npcId: c.lenderId, status: 'open', since: 30, dueAge: 31, what: c.item.name });
    expect(s.ch.npcs.some((n) => n.id === ob.npcId)).toBe(true);
    expect(d.memory.find((m) => m.kind === 'lent')!.npcId).toBe(ob.npcId);
    const due = s.scheduled.filter((e) => e.eventId === 'daily_return_due' && e.ctx.dailyOb === ob.id);
    expect(due).toHaveLength(1);
    expect(due[0].atAge).toBe(32);
    expect(due[0].ctx.도우미).toBe(ob.who);
  });

  it('일정 조정: 학교는 늦는다고 알리면 지각으로 남고, 지각이 쌓이면 상담을 한다', () => {
    const s = find('DAILY-SCHOOL', (seed) => person(seed, { age: 15, school: 'middle' }), (x) => open(x).schedule.kind === 'school');
    const text = act(s, 'adjust');
    expect(text).toContain('늦게 교실에 들어갔다');
    const c = s.ch.daily!.chain!;
    expect(c.outcome).toBe('late');
    expect(c.late).toBeGreaterThanOrEqual(20);
    expect(readDaily(s.ch).lates).toHaveLength(1);
    // 같은 해에 지각이 두 번 더 있었다면 세 번째에 상담 문장
    s.ch.daily!.lates.push({ age: 15, kind: 'school', minutes: 30 });
    const t = find('DAILY-SCHOOL2', (seed) => {
      const x = person(seed, { age: 15, school: 'middle' });
      x.ch.daily = JSON.parse(JSON.stringify(s.ch.daily)) as DailyState;
      x.ch.daily.chain = undefined;
      return x;
    }, (x) => open(x).schedule.kind === 'school');
    expect(act(t, 'adjust')).toContain('상담');
  });

  it('일정 조정: 약속 상대가 미루기를 거절하면 서운함이 남고 취소가 열린다', () => {
    const s = find('DAILY-POSTPONE', (seed) => person(seed, { age: 72, retired: true, friend: 60 }), (x) => {
      const c = open(x);
      if (c.schedule.outing !== 'meetup') return false;
      act(x, 'adjust');
      return c.adjustRefused;
    });
    const c = s.ch.daily!.chain!;
    const friend = s.ch.npcs.find((n) => n.id === c.schedule.withId)!;
    const before = friend.closeness;
    expect(s.card!.eventId).toBe('daily_laundry_fallback');
    expect(stepIndex(s, 'adjust')).toBe(-1);
    act(s, 'cancel');
    expect(c.outcome).toBe('cancelled');
    expect(friend.closeness).toBe(before - 5);
    expect(readDaily(s.ch).memory.filter((m) => m.npcId === friend.id).map((m) => m.kind)).toEqual(['declined', 'cancelled']);
  });

  it('다른 옷: 바로 끝나고, 사무직은 하루 종일 신경이 쓰인다', () => {
    const s = find('DAILY-OTHER', (seed) => person(seed, { age: 35, job: 'sme_office' }), (x) => open(x).schedule.kind === 'office');
    expect(act(s, 'wear_other')).toContain('신경이 쓰였다');
    expect(s.ch.daily!.chain!.outcome).toBe('substitute');
    expect(s.phase).toBe('action');
  });
});

// ── 인물의 독립적인 판단 ─────────────────────────────────

describe('부탁 상대는 자기 사정·성향·기억으로 판단한다', () => {
  it('거절하면 기억에 남고, 의무는 생기지 않으며, 다른 방법으로 다시 고른다', () => {
    const s = find('DAILY-REFUSE', (seed) => person(seed, { age: 30, friend: 60 }), (x) => {
      open(x);
      if (stepIndex(x, 'borrow') < 0) return false;
      act(x, 'borrow');
      return x.ch.daily!.chain!.stage === 'fallback';
    });
    const c = s.ch.daily!.chain!;
    expect(c.asked).toHaveLength(1);
    expect(readDaily(s.ch).memory.map((m) => m.kind)).toEqual(['refused']);
    expect(readDaily(s.ch).obligations).toHaveLength(0);
    expect(s.card!.eventId).toBe('daily_laundry_fallback');
    // 같은 사람에게 두 번 묻지 않는다
    expect(c.helperId).not.toBe(c.asked[0]);
  });

  it('답은 그 사람의 사정으로 정해진다: 아무리 가까워도 잠들었거나 자기도 입어야 하면 거절한다', () => {
    const reasons = new Set<string>();
    for (let i = 0; i < 120; i++) {
      const s = person(`DAILY-OWN-${i}`, { age: 30, friend: 100 });
      const c = open(s);
      const f = s.ch.npcs.find((n) => n.role === 'friend' && n.closeness === 100)!;
      const a = answerLend(s, c, f);
      if (!a.yes) reasons.add(a.reason);
      // 내 사정(돈·스트레스)은 답을 바꾸지 않는다
      s.ch.res.cash = 0;
      s.ch.state.stress = 100;
      expect(answerLend(s, c, f)).toEqual(a);
    }
    expect(reasons.has('needsIt')).toBe(true);
    expect([...reasons].some((r) => r === 'asleep' || r === 'away' || r === 'far')).toBe(true);
  });

  it('옷을 돌려주지 않은 기억이 있으면 덜 빌려주고, 거절할 때 그 일을 꺼낸다', () => {
    let clean = 0;
    let grudge = 0;
    const reasons = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = person(`DAILY-MEM-${i}`, { age: 30, friend: 60 });
      const c = open(s);
      const f = s.ch.npcs.find((n) => n.role === 'friend' && n.closeness === 60)!;
      if (answerLend(s, c, f).yes) clean++;
      s.ch.daily!.memory.push({ npcId: f.id, age: 28, kind: 'forgot' });
      const a = answerLend(s, c, f);
      if (a.yes) grudge++;
      else reasons.add(a.reason);
    }
    expect(grudge).toBeLessThan(clean * 0.75);
    expect(reasons.has('grudge')).toBe(true);
  });
});

// ── 반납 의무 ────────────────────────────────────────────

/** 옷을 빌린 상태 (빌려준 사람: 같은 성별 형제 — 친구보다 오래 곁에 남는다) */
function borrowed(prefix: string): GameState {
  return find(prefix, (seed) => {
    const s = person(seed, { age: 30 });
    for (const n of s.ch.npcs) if (n.role === 'friend') n.alive = false;
    const sib = addSibling(s, rngFor(seed, 'sib'));
    sib.sex = s.ch.sex;
    sib.birthYear = s.ch.birthYear - 2;
    sib.closeness = 90;
    return s;
  }, (x) => {
    open(x);
    if (stepIndex(x, 'borrow') < 0) return false;
    act(x, 'borrow');
    return x.ch.daily!.chain!.outcome === 'borrowed';
  });
}

describe('빌린 옷 돌려주기', () => {
  it('기한 전에 활동으로 돌려주면 의무가 닫히고 독촉 카드는 뜨지 않는다', () => {
    const s = borrowed('DAILY-RETURN');
    const lender = lenderOf(s);
    const before = lender.closeness;
    // 실제 게임에서 사슬은 그해 자유 행동이 끝난 뒤(사건 단계)에 오므로 돌려줄 기회는 다음 해부터다
    skipYear(s);
    expect(scope(s).canReturn).toBe(true);
    expect(activityViews(s).map((v) => v.def.id)).toContain('chore_return');
    const r = doActivity(s, 'chore_return')!;
    expect(r.text).toContain('돌려줬다');
    const ob = readDaily(s.ch).obligations[0];
    expect(ob.status).toBe('returned');
    expect(lender.closeness).toBe(Math.min(100, before + 3));
    expect(activityViews(s).map((v) => v.def.id)).not.toContain('chore_return');
    skipYear(s);
    for (const e of s.scheduled.filter((x) => x.atAge === s.ch.age)) expect(presentCard(s, { eventId: e.eventId, ctx: e.ctx })).toBe(false);
    expect(s.counts.daily_return_due).toBeUndefined();
    expect(readDaily(s.ch).memory.map((m) => m.kind)).toEqual(['lent', 'returned']);
  });

  it('돌려주지 않으면 2년째 첫머리에 독촉이 오고, 모른 척하면 관계와 다음 부탁에 남는다', () => {
    const s = borrowed('DAILY-FORGET');
    const lender = lenderOf(s);
    skipYear(s);
    skipYear(s);
    const due = s.scheduled.find((e) => e.eventId === 'daily_return_due')!;
    expect(due.atAge).toBe(s.ch.age);
    expect(presentCard(s, { eventId: 'daily_return_due', ctx: due.ctx })).toBe(true);
    expect(s.card!.text).toContain(lender.name === due.ctx.도우미 ? lender.name : due.ctx.도우미);
    const before = lender.closeness;
    act(s, 'forget');
    expect(readDaily(s.ch).obligations[0].status).toBe('forgotten');
    expect(lender.closeness).toBe(Math.max(0, before - 10));
    expect(scope(s, due.ctx).dueOpen).toBe(false);
    // 같은 날 예약된 '돌려주지 못한 옷'은 뜨지 않는다 (이미 정리됐다)
    expect(presentCard(s, { eventId: 'daily_return_lost', ctx: due.ctx })).toBe(false);
    expect(readDaily(s.ch).memory.at(-1)!.kind).toBe('forgot');
  });

  it('늦게라도 돌려주거나 새로 사 주면 각각 다르게 남는다', () => {
    for (const [step, status] of [['return', 'returned_late'], ['compensate', 'compensated']] as const) {
      const s = borrowed(`DAILY-LATE-${step}`);
      skipYear(s);
      skipYear(s);
      const due = s.scheduled.find((e) => e.eventId === 'daily_return_due')!;
      const cash = s.ch.res.cash;
      presentCard(s, { eventId: 'daily_return_due', ctx: due.ctx });
      act(s, step);
      expect(readDaily(s.ch).obligations[0].status).toBe(status);
      if (step === 'compensate') expect(s.ch.res.cash).toBeLessThan(cash);
      else expect(s.ch.res.cash).toBe(cash);
    }
  });

  it('빌려준 사람이 그사이 세상을 떠나면 독촉 대신 돌려주지 못한 옷으로 정리된다', () => {
    const s = borrowed('DAILY-LOST');
    const lender = lenderOf(s);
    skipYear(s);
    lender.alive = false;
    lender.deathYear = s.year;
    expect(scope(s).canReturn).toBe(false);
    expect(activityViews(s).map((v) => v.def.id)).not.toContain('chore_return');
    skipYear(s);
    const due = s.scheduled.find((e) => e.eventId === 'daily_return_due')!;
    expect(presentCard(s, { eventId: 'daily_return_due', ctx: due.ctx })).toBe(false);
    const lost = s.scheduled.find((e) => e.eventId === 'daily_return_lost')!;
    expect(presentCard(s, { eventId: 'daily_return_lost', ctx: lost.ctx })).toBe(false); // 선택이 없는 작은 사건: 일기 한 줄
    expect(s.log.at(-1)!.text).toContain('세상을 떠났다');
    expect(readDaily(s.ch).obligations[0].status).toBe('void');
  });

  it('실제 해 넘김에서도 2년째 첫머리에 독촉 카드가 한 번만 뜬다', () => {
    const s = borrowed('DAILY-REAL');
    const ob = readDaily(s.ch).obligations[0];
    const start = s.ch.age;
    let dueShown = 0;
    for (let guard = 0; guard < 400 && s.phase !== 'dead' && s.ch.age < start + 3; guard++) {
      if (s.phase === 'action') endTurn(s);
      else if (s.card && s.card.choices.length > 0 && !s.card.result) {
        if (s.card.eventId === 'daily_return_due' && s.card.ctx.dailyOb === ob.id) {
          dueShown++;
          expect(s.ch.age).toBe(start + 2);
          choose(s, stepIndex(s, 'return'));
        } else choose(s, 0);
      } else proceed(s);
    }
    expect(s.phase).not.toBe('dead');
    expect(dueShown).toBe(1);
    expect(readDaily(s.ch).obligations.find((o) => o.id === ob.id)!.status).toBe('returned_late');
  });
});

// ── 저장·재현 ────────────────────────────────────────────

describe('저장·불러오기와 재현', () => {
  /** 화면 순서대로 고른다: 매번 picks의 단계 중 보이는 첫 선택지 */
  function play(s: GameState, picks: string[]): string[] {
    const out: string[] = [];
    for (let guard = 0; guard < 10 && s.phase === 'event'; guard++) {
      const step = picks.find((p) => stepIndex(s, p) >= 0);
      if (!step) break;
      out.push(act(s, step));
    }
    return out;
  }

  it('첫 카드에서 저장·불러오기를 해도 같은 선택은 같은 결과와 같은 상태다', () => {
    for (let i = 0; i < 12; i++) {
      const a = person(`DAILY-SAVE-${i}`, { age: 30, friend: 70 });
      open(a);
      const b = roundTrip(a);
      const picks = ['borrow', 'adjust', 'wait', 'wear_damp', 'wear_other'];
      expect(play(b, picks)).toEqual(play(a, picks));
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });

  it('거절 뒤 다시 고르는 카드에서 저장해도 이어지는 결과가 같다', () => {
    const a = find('DAILY-MID', (seed) => person(seed, { age: 30, friend: 60 }), (x) => {
      open(x);
      if (stepIndex(x, 'borrow') < 0) return false;
      act(x, 'borrow');
      return x.card?.eventId === 'daily_laundry_fallback';
    });
    const b = roundTrip(a);
    expect(b.card).toEqual(a.card);
    const picks = ['borrow', 'laundromat', 'adjust', 'wear_damp', 'wear_other'];
    expect(play(b, picks)).toEqual(play(a, picks));
    expect(JSON.stringify(b.ch.daily)).toBe(JSON.stringify(a.ch.daily));
  });

  it('빌린 옷이 남은 채 저장해도 의무·예약·독촉 결과가 같고, 한 번만 처리된다', () => {
    const a = borrowed('DAILY-SAVEOB');
    skipYear(a);
    skipYear(a);
    const b = roundTrip(a);
    for (const s of [a, b]) {
      const due = s.scheduled.find((e) => e.eventId === 'daily_return_due')!;
      expect(presentCard(s, { eventId: 'daily_return_due', ctx: due.ctx })).toBe(true);
      act(s, 'compensate');
      // 같은 예약을 다시 불러도 이미 닫혀 있어 두 번 처리되지 않는다
      expect(presentCard(s, { eventId: 'daily_return_due', ctx: due.ctx })).toBe(false);
    }
    expect(JSON.stringify(b.ch)).toBe(JSON.stringify(a.ch));
    expect(readDaily(b.ch).obligations[0].status).toBe('compensated');
  });

  it('같은 시드의 인생은 같은 하루 사슬 기록을 만든다', () => {
    const a = simulateLife('DAILY-DET-1', { mode: 'reality' });
    const b = simulateLife('DAILY-DET-1', { mode: 'reality' });
    expect(JSON.stringify(b.ch.daily)).toBe(JSON.stringify(a.ch.daily));
    expect(b.counts.daily_laundry).toBe(a.counts.daily_laundry);
  });

  it('옛 저장(하루 기록 없음)도 불러오고, 빈 기록으로 읽으며, 사슬을 시작할 수 있다', () => {
    const s = person('DAILY-OLD', { age: 30, friend: 70 });
    delete s.ch.daily;
    const loaded = roundTrip(s);
    expect(loaded.ch.daily).toBeUndefined();
    expect(scope(loaded)).toMatchObject({ active: false, owes: 0, canReturn: false, dryer: false, stage: 'none' });
    expect(activityViews(loaded).map((v) => v.def.id)).not.toContain('chore_return');
    open(loaded);
    expect(readDaily(loaded.ch).seq).toBe(1);
    // 일부 필드만 있는 기록도 채워 쓴다
    const partial = person('DAILY-PARTIAL', { age: 30 });
    partial.ch.daily = { seq: 3 } as unknown as DailyState;
    open(partial);
    expect(partial.ch.daily.chain!.id).toBe('d4');
    expect(dailyScope(partial).owes).toBe(0);
  });
});

// ── 원인과 빈도 ──────────────────────────────────────────

describe('준비·도구와 실제 빈도', () => {
  it('빨래를 미리 하면 그해 확률이 절반, 건조기가 있으면 다시 0.3배', () => {
    const s = person('DAILY-PREP', { age: 30, cash: 50_000_000 });
    const ev = getEvent('daily_laundry');
    const p0 = eventProbability(ev, s).P;
    expect(doActivity(s, 'chore_laundry')).not.toBeNull();
    expect(eventProbability(ev, s).P).toBeCloseTo(p0 * 0.5, 10);
    expect(doActivity(s, 'chore_dryer')).not.toBeNull();
    expect(eventProbability(ev, s).P).toBeCloseTo(p0 * 0.5 * 0.3, 10);
    expect(activityViews(s).map((v) => v.def.id)).not.toContain('chore_dryer');
    // 다음 해: 미리 한 빨래의 효과는 그해뿐이고 건조기는 남는다 (같은 나이의 건조기 없는 사람과 비교)
    skipYear(s);
    const plain = person('DAILY-PREP', { age: 31, cash: 50_000_000 });
    expect(eventProbability(ev, s).P).toBeCloseTo(eventProbability(ev, plain).P * 0.3, 10);
  });

  it('현실 모드 인생 다수에서 나타나고, 한 인생에 지나치게 반복되지 않으며, 모든 사슬이 끝난다', () => {
    const per: number[] = [];
    for (let i = 0; i < 30; i++) {
      const s = simulateLife(`DAILY-REACH-${i}`, { mode: 'reality' });
      const h = readDaily(s.ch).history;
      per.push(h.length);
      expect(h.every((r) => r.outcome !== 'abandoned')).toBe(true);
      // 2년 쿨다운: 같은 나이에 두 번 없다
      expect(new Set(h.map((r) => r.age)).size).toBe(h.length);
    }
    expect(per.filter((n) => n > 0).length).toBeGreaterThanOrEqual(12);
    expect(Math.max(...per)).toBeLessThanOrEqual(12);
  });
});
