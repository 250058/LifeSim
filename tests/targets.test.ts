// 대상 인물 검사 (코덱스 R-011·R-012).
//  - R-011: 사건이 가리키는 자녀는 문장과 무관하게 카드가 뜰 때 한 명으로 묶이고, 그 아이만 바뀐다.
//  - R-012: 예약·연속 사건은 묶인 사람이 살아서 조건에 맞을 때만 뜬다. 아니면 다른 사람으로 바꾸지 않고
//           취소하고 이유를 일기에 남긴다. 부고·추모처럼 고인을 부르는 사건은 그대로 뜬다.
// 시험용 사건은 EVENTS에 잠깐 넣었다가 테스트가 끝나면 뺀다.

import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_BY_ID, EVENT_FILES, EVENTS, getEvent } from '../src/engine/data';
import { presentCard, resetEventIndex } from '../src/engine/eventEngine';
import { josa } from '../src/engine/format';
import { choose, endTurn, newGame, proceed } from '../src/engine/game';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import type { ChoiceDef, EventDef } from '../src/engine/schema';
import { placeholdersOf, targetRolesOf } from '../src/engine/text';
import type { GameState, Npc, NpcRole } from '../src/engine/types';
import { targetIssues, validateData } from '../src/engine/validate';

const added: EventDef[] = [];
const TEST_FILE = 'test/targets.json';

function addEvents(evs: EventDef[], file = false): void {
  for (const ev of evs) {
    EVENTS.push(ev);
    EVENT_BY_ID.set(ev.id, ev);
    added.push(ev);
  }
  if (file) EVENT_FILES[TEST_FILE] = evs;
  resetEventIndex();
}

afterEach(() => {
  for (const ev of added.splice(0)) {
    EVENTS.splice(EVENTS.indexOf(ev), 1);
    EVENT_BY_ID.delete(ev.id);
  }
  delete EVENT_FILES[TEST_FILE];
  resetEventIndex();
});

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** 저장했다가 다시 불러온 상태 */
function reload(state: GameState): GameState {
  const storage = memoryStorage();
  expect(saveGame(state, storage)).toBe(true);
  return loadGame(storage)!;
}

/** 2026년에 age살인 사람. 원래 있던 자녀는 지우고 행동 단계에 둔다 */
function adult(seed: string, age: number, sex: 'F' | 'M' = 'F'): GameState {
  const s = newGame({ seed, mode: 'reality', birthYear: 2026 - age });
  s.year = 2026;
  s.ch.age = age;
  s.ch.sex = sex;
  s.ch.npcs = s.ch.npcs.filter((n) => n.role !== 'child');
  s.phase = 'action';
  s.queue = [];
  return s;
}

function addNpc(s: GameState, role: NpcRole, id: string, name: string, age: number, extra: Partial<Npc> = {}): Npc {
  const n: Npc = { id, name, sex: 'M', birthYear: s.year - age, role, alive: true, closeness: 50, health: 80, ...extra };
  s.ch.npcs.push(n);
  return n;
}

const npc = (s: GameState, id: string) => s.ch.npcs.find((n) => n.id === id)!;

/** 글자가 들어간 선택지를 고른다 */
function pick(s: GameState, text: string): void {
  const i = s.card!.choices.findIndex((c) => c.text.includes(text));
  expect(i, `선택지 '${text}'`).toBeGreaterThanOrEqual(0);
  choose(s, i);
}

/**
 * '+1년'을 누르고 다음 해 행동 단계까지 카드를 넘긴다. 결정이 필요한 카드는 onCard가 고르고
 * (저장·불러오기를 하면 새 상태를 돌려준다), 고르지 않으면 첫 선택지.
 */
function nextYear(s: GameState, onCard: (s: GameState) => GameState | void = () => undefined): GameState {
  const age = s.ch.age;
  endTurn(s);
  for (let guard = 0; guard < 500 && s.phase !== 'dead' && !(s.phase === 'action' && s.ch.age > age); guard++) {
    if (s.card && s.card.choices.length > 0 && !s.card.result) {
      s = onCard(s) ?? s;
      if (!s.card!.result) choose(s, 0);
    } else {
      proceed(s);
    }
  }
  expect(s.phase).toBe('action');
  return s;
}

const CLOSE: ChoiceDef[] = [
  { text: '안아 준다', result: '꼭 안아 줬다.', effects: { do: [{ type: 'npcCloseness', role: 'child', delta: 4 }] } },
  { text: '그냥 둔다', result: '그냥 뒀다.' },
];

/** 시험용 육아 사건: 0~12세 자녀, 선택하면 자녀 친밀도 +4 */
function kidEvent(id: string, text: string, extra: Partial<EventDef> = {}): EventDef {
  return {
    id,
    type: 'random',
    title: '저녁 식탁',
    text,
    tone: 'neutral',
    impact: 3,
    trigger: { age: [19, 120], childAge: [0, 12] },
    weight: { base: 0.5, noMode: true },
    choices: CLOSE,
    ...extra,
  } as EventDef;
}

/** 0~12세 셋과 15세 하나를 둔 마흔 살 부모 */
function familyOfFour(seed: string): GameState {
  const s = adult(seed, 40);
  addNpc(s, 'child', 'k3', '한셋', 3);
  addNpc(s, 'child', 'k7', '한일곱', 7);
  addNpc(s, 'child', 'k11', '한열하나', 11);
  addNpc(s, 'child', 'k15', '한열다섯', 15);
  return s;
}

const kidIds = ['k3', 'k7', 'k11', 'k15'];

describe('R-011 대상 자녀는 문장과 무관하게 한 명', () => {
  it('이름이 없는 육아 카드(par_breastfeeding)도 나이대에 맞는 아기 하나만 바뀐다', () => {
    const s = adult('REVIEW-CHILD-BINDING', 30, 'F');
    addNpc(s, 'child', 'baby', '김아기', 0);
    addNpc(s, 'child', 'ten', '김열살', 10);
    const ev = getEvent('par_breastfeeding');
    expect(placeholdersOf(ev)).not.toContain('자녀');
    expect(targetRolesOf(ev)).toContain('child');

    expect(presentCard(s, { eventId: 'par_breastfeeding', ctx: {} })).toBe(true);
    expect(s.card!.ctx).toMatchObject({ childId: 'baby', 자녀: '김아기' });
    pick(s, '완모');
    expect(npc(s, 'baby').closeness).toBe(54);
    expect(npc(s, 'ten').closeness).toBe(50);
    expect(s.card!.result!.changes.map((c) => c.text)).toContain('김아기 친밀도 +4');
  });

  it('나이대가 겹치는 여러 아이 중 한 명만 묶이고 그 아이만 바뀐다', () => {
    addEvents([kidEvent('tgt_plain', '아이가 식탁에서 오늘 있었던 일을 이야기했다.')]);
    const bound = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const s = familyOfFour(`ONE-CHILD-${i}`);
      expect(presentCard(s, { eventId: 'tgt_plain', ctx: {} })).toBe(true);
      const id = s.card!.ctx.childId;
      expect(['k3', 'k7', 'k11']).toContain(id);
      expect(s.card!.ctx.자녀).toBe(npc(s, id).name);
      pick(s, '안아 준다');
      for (const k of kidIds) expect(npc(s, k).closeness).toBe(k === id ? 54 : 50);
      bound.add(id);
    }
    // 늘 같은 아이만 고르는 것이 아니다
    expect(bound.size).toBeGreaterThan(1);
  });

  it('문장에서 {자녀}를 지워도 같은 시드면 같은 아이가 묶인다', () => {
    addEvents([
      kidEvent('tgt_named', '{자녀}이/가 식탁에서 오늘 있었던 일을 이야기했다.'),
      kidEvent('tgt_plain', '아이가 식탁에서 오늘 있었던 일을 이야기했다.'),
    ]);
    const bound = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const named = familyOfFour(`SAME-CHILD-${i}`);
      const plain = familyOfFour(`SAME-CHILD-${i}`);
      presentCard(named, { eventId: 'tgt_named', ctx: {} });
      presentCard(plain, { eventId: 'tgt_plain', ctx: {} });
      expect(plain.card!.ctx.childId).toBe(named.card!.ctx.childId);
      expect(named.card!.text).toContain(named.card!.ctx.자녀);
      bound.add(named.card!.ctx.childId);
    }
    expect(bound.size).toBeGreaterThan(1);
  });

  it('카드를 띄운 채 저장했다 불러와 골라도 묶인 아이만 바뀐다', () => {
    addEvents([kidEvent('tgt_plain', '아이가 식탁에서 오늘 있었던 일을 이야기했다.')]);
    const before = familyOfFour('SAVE-MID-CARD');
    presentCard(before, { eventId: 'tgt_plain', ctx: {} });
    const id = before.card!.ctx.childId;
    const s = reload(before);
    expect(s.card!.ctx.childId).toBe(id);
    pick(s, '안아 준다');
    for (const k of kidIds) expect(npc(s, k).closeness).toBe(k === id ? 54 : 50);
  });

  it('이름도 나이 조건도 없는 사건(lonely_days)의 자녀 친밀도도 한 명에게만 간다', () => {
    const s = adult('LONELY-CALL', 70, 'M');
    addNpc(s, 'child', 'a', '정첫째', 44);
    addNpc(s, 'child', 'b', '정둘째', 41);
    expect(placeholdersOf(getEvent('lonely_days'))).not.toContain('자녀');
    expect(presentCard(s, { eventId: 'lonely_days', ctx: {} })).toBe(true);
    const id = s.card!.ctx.childId;
    pick(s, '자녀에게 전화');
    expect([npc(s, 'a').closeness, npc(s, 'b').closeness].sort()).toEqual([50, 56]);
    expect(npc(s, id).closeness).toBe(56);
  });

  it('묶을 아이가 없으면 자녀 친밀도 효과를 쓰지 않는다 (조카·이산가족에게 번지지 않는다)', () => {
    addEvents([
      kidEvent('tgt_any', '오랜만에 가족이 모였다.', { trigger: { age: [19, 120] } }),
      kidEvent('tgt_auto', '아이 생각이 났다.', {
        trigger: { age: [19, 120] },
        choices: undefined,
        effects: { do: [{ type: 'npcCloseness', role: 'child', delta: 5 }] },
      }),
    ]);
    // 앞 사건이 명단에 없는 사람('조카')을 가리켰으면 다른 아이로 바꾸지 않는다
    const s = familyOfFour('NEPHEW');
    expect(presentCard(s, { eventId: 'tgt_any', ctx: { 자녀: '조카' } })).toBe(true);
    expect(s.card!.ctx.childId).toBeUndefined();
    expect(s.card!.choices.map((c) => c.text)).toEqual(['그냥 둔다']);
    expect(presentCard(s, { eventId: 'tgt_auto', ctx: { 자녀: '조카' } })).toBe(false);
    for (const k of kidIds) expect(npc(s, k).closeness).toBe(50);

    // 하나뿐인 아이가 이산가족이면 묶을 수 없다
    const w = adult('WAR-SEPARATED', 50);
    addNpc(w, 'child', 'lost', '윤헤어짐', 20, { missing: true });
    expect(presentCard(w, { eventId: 'tgt_any', ctx: {} })).toBe(true);
    expect(w.card!.choices.map((c) => c.text)).toEqual(['그냥 둔다']);
    expect(presentCard(w, { eventId: 'tgt_auto', ctx: {} })).toBe(false);
    expect(npc(w, 'lost').closeness).toBe(50);
  });
});

describe('R-012 이어지는 사건은 묶인 사람을 다시 확인한다', () => {
  /** 19·20세 자녀를 둔 마흔아홉 살 부모가 한 아이의 독학 재수를 믿어 준다 (1년 뒤 결과 예약) */
  function retakeDecided(seed: string): { s: GameState; target: string; sibling: string } {
    const s = adult(seed, 49);
    addNpc(s, 'child', 'r19', '박재수', 19);
    addNpc(s, 'child', 'r20', '박스물', 20);
    expect(presentCard(s, { eventId: 'par_retake_decision', ctx: {} })).toBe(true);
    const target = s.card!.ctx.childId;
    pick(s, '독학');
    proceed(s);
    expect(s.scheduled).toEqual([{ eventId: 'par_retake_result', atAge: 50, ctx: expect.objectContaining({ childId: target }) }]);
    return { s, target, sibling: target === 'r19' ? 'r20' : 'r19' };
  }

  it('대상 자녀가 죽으면 조건을 채우는 형제가 있어도 결과가 뜨지 않고 이유가 일기에 남는다 (저장·불러오기 사이)', () => {
    const { s: before, target, sibling } = retakeDecided('REVIEW-DEAD-CHILD');
    const dead = npc(before, target);
    dead.alive = false;
    dead.deathYear = 2026;
    dead.deathCause = '사고';
    const shown: string[] = [];
    const s = nextYear(reload(before), (x) => void shown.push(x.card!.eventId));

    expect(npc(s, sibling).alive).toBe(true);
    expect(s.year - npc(s, sibling).birthYear).toBeGreaterThanOrEqual(19);
    expect(shown).not.toContain('par_retake_result');
    expect(s.scheduled.some((x) => x.eventId === 'par_retake_result')).toBe(false);
    const lines = s.log.filter((e) => e.text.includes('두 번째 성적표'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'system', year: 2027, age: 50 });
    expect(lines[0].text).toBe(`${josa(dead.name, '이/가')} 세상을 떠났다. 예정됐던 일(두 번째 성적표)은 없던 일이 됐다.`);
  });

  it('대상이 살아 있으면 형제가 아니라 그 아이에게 한 번만 뜬다 (저장·불러오기 사이)', () => {
    const { s: before, target, sibling } = retakeDecided('REVIEW-ALIVE-CHILD');
    let seen = 0;
    let delta: Record<string, number> = {};
    const s = nextYear(reload(before), (x) => {
      if (x.card!.eventId !== 'par_retake_result') return;
      seen++;
      expect(x.card!.ctx.childId).toBe(target);
      expect(x.card!.text).toContain(npc(x, target).name);
      // 카드를 띄운 채 저장했다 불러온다
      const y = reload(x);
      const was = { t: npc(y, target).closeness, o: npc(y, sibling).closeness };
      pick(y, '고생했다');
      delta = { t: npc(y, target).closeness - was.t, o: npc(y, sibling).closeness - was.o };
      return y;
    });
    expect(seen).toBe(1);
    expect(delta).toEqual({ t: 6, o: 0 });
    expect(s.log.filter((e) => e.title === '두 번째 성적표')).toHaveLength(1);
    expect(s.log.some((e) => e.text.includes('(두 번째 성적표)은 없던 일'))).toBe(false);
  });

  it('나이대를 벗어난 아이는 나이대에 맞는 형제가 있어도 취소된다', () => {
    const s = adult('AGED-OUT', 52);
    addNpc(s, 'child', 'old', '송스물넷', 24);
    addNpc(s, 'child', 'young', '송스물', 20);
    const log = s.log.length;
    expect(presentCard(s, { eventId: 'par_retake_result', ctx: { 자녀: '송스물넷', childId: 'old' } })).toBe(false);
    expect(s.card).toBeUndefined();
    expect(s.log.slice(log).map((e) => e.text)).toEqual(['송스물넷은 그새 24살이 됐다. 예정됐던 일(두 번째 성적표)은 없던 일이 됐다.']);
    // 같은 사건을 새로 뽑았다면 나이대에 맞는 아이가 묶인다
    expect(presentCard(s, { eventId: 'par_retake_result', ctx: {} })).toBe(true);
    expect(s.card!.ctx.childId).toBe('young');
  });

  it('부모가 세상을 떠나면 병세 후속 사건이 다른 부모에게 옮겨 가지 않는다', () => {
    const setup = (motherAlive: boolean) => {
      const s = adult('PARENT-GONE', 45);
      s.ch.npcs = s.ch.npcs.filter((n) => n.role !== 'mother' && n.role !== 'father');
      addNpc(s, 'mother', 'mom', '김순자', 78, { sex: 'F', alive: motherAlive, health: 50 });
      addNpc(s, 'father', 'dad', '이영수', 75, { health: 60 });
      return s;
    };
    const s = setup(false);
    expect(presentCard(s, { eventId: 'med_p_hip_worse', ctx: { 부모: '엄마', parentId: 'mom' } })).toBe(false);
    expect(s.log.at(-1)!.text).toBe('엄마가 세상을 떠났다. 예정됐던 일(누워 지낸 겨울)은 없던 일이 됐다.');
    expect(npc(s, 'dad').health).toBe(60);

    // 살아 있으면 그 사람에게 그대로 뜬다
    const ok = setup(true);
    expect(presentCard(ok, { eventId: 'med_p_hip_worse', ctx: { 부모: '엄마', parentId: 'mom' } })).toBe(true);
    pick(ok, '입원');
    expect(npc(ok, 'mom').health).toBe(52);
    expect(npc(ok, 'dad').health).toBe(60);
  });

  it('헤어진 연인과의 결혼 날짜는 새 연인에게 옮겨 가지 않는다', () => {
    const setup = () => {
      const s = adult('PARTNER-GONE', 32);
      s.ch.flags.rom_engaged = { since: 31 };
      addNpc(s, 'partner', 'newP', '오새봄', 33);
      return s;
    };
    const s = setup();
    expect(presentCard(s, { eventId: 'rom_wedding_date', ctx: { 연인: '이준현', partnerId: 'oldP' } })).toBe(false);
    expect(s.log.at(-1)!.text).toBe('이준현과 헤어졌다. 예정됐던 일(날짜)은 없던 일이 됐다.');
    expect(npc(s, 'newP').closeness).toBe(50);

    // 같은 연인이면 그대로 뜬다. 연인 id가 없는 옛 저장의 예약도 불러와 그대로 처리한다
    const same = setup();
    expect(presentCard(same, { eventId: 'rom_wedding_date', ctx: { 연인: '오새봄', partnerId: 'newP' } })).toBe(true);
    const legacy = reload(setup());
    expect(presentCard(legacy, { eventId: 'rom_wedding_date', ctx: { 연인: '오새봄' } })).toBe(true);
    expect(legacy.card!.text).toContain('오새봄');
  });

  it('부고 카드는 고인이 이미 죽어 있어도 그대로 뜬다 (고인을 부르는 사건은 재검사하지 않는다)', () => {
    const s = adult('MEMORIAL', 50);
    addNpc(s, 'child', 'gone', '최하늘', 20, { alive: false, deathYear: 2026, deathCause: '교통사고' });
    expect(targetRolesOf(getEvent('npc_death'))).toEqual([]);
    const ctx = { 고인: '최하늘', 고인관계: '아들', 향년: '20', 사인: '교통사고', npcId: 'gone', closeness: '50', childId: 'gone' };
    expect(presentCard(s, { eventId: 'npc_death', ctx })).toBe(true);
    expect(s.card!.text).toContain('최하늘');
    expect(s.log.some((e) => e.text.includes('없던 일'))).toBe(false);
  });
});

describe('검증기: 대상 인물 규칙', () => {
  const chain = (id: string, childAge: [number, number], extra: Partial<EventDef> = {}): EventDef =>
    ({ id, type: 'chain', title: id, text: '{자녀}의 일.', trigger: { childAge }, ...extra }) as EventDef;

  it('실제 데이터에는 대상 규칙 오류·경고가 없다', () => {
    expect(targetIssues(EVENTS)).toEqual([]);
    expect(validateData().filter((i) => i.level === 'error')).toEqual([]);
  });

  it('모든 자녀를 뜻하는 역할(children)이나 한 사람을 고를 수 없는 역할(조부모)은 오류다', () => {
    const fx = (role: string) => ({ do: [{ type: 'npcCloseness', role, delta: 3 }] }) as EventDef['effects'];
    addEvents(
      [
        kidEvent('tgt_all_kids', '온 가족이 모였다.', { effects: fx('children') }),
        kidEvent('tgt_grandparent', '할머니 댁에 갔다.', { effects: fx('grandparent') }),
      ],
      true,
    );
    const errors = validateData().filter((i) => i.level === 'error' && i.where.startsWith(TEST_FILE));
    expect(errors.map((e) => e.where)).toEqual([`${TEST_FILE} › tgt_all_kids`, `${TEST_FILE} › tgt_grandparent`]);
    expect(errors[0].message).toContain('모든 자녀를 뜻하는 표기는 아직 없다');
  });

  it('아이를 낳는 사건이 자녀를 대상으로 삼으면 오류다 (형·누나가 묶인다)', () => {
    const birth = kidEvent('tgt_birth', '{자녀}이/가 태어났다.', {
      trigger: { age: [19, 50] },
      effects: { do: [{ type: 'haveChild' }] },
      choices: undefined,
    });
    expect(targetIssues([birth]).map((i) => i.level)).toEqual(['error']);
  });

  it('물려받은 자녀의 나이가 다음 사건의 나이대를 벗어나면 경고한다 (실제로 닿지 않는 넓은 나이대는 경고하지 않는다)', () => {
    const later = (event: string): ChoiceDef[] => [{ text: '지켜본다', result: '지켜봤다.', effects: { later: [{ event, inYears: 1 }] } }];
    const start = kidEvent('tgt_start', '{자녀}이/가 아프다.', { trigger: { childAge: [0, 6] }, choices: [{ text: '병원에 간다', result: '갔다.', next: 'tgt_dx' }] });
    const dx = chain('tgt_dx', [0, 9], { choices: later('tgt_worse') });
    const worse = chain('tgt_worse', [0, 9]);
    // 0~6세에서 시작해 1년 뒤면 1~7세: 0~9세 나이대 안이다
    expect(targetIssues([start, dx, worse])).toEqual([]);

    // 0~9세에서 바로 1년 뒤로 예약하면 10세가 되는 아이는 언제나 취소된다
    const wide = kidEvent('tgt_wide', '{자녀}이/가 아프다.', { trigger: { childAge: [0, 9] }, choices: later('tgt_worse') });
    const issues = targetIssues([wide, worse]);
    expect(issues.map((i) => [i.level, i.where])).toEqual([['warn', 'tgt_wide']]);
    expect(issues[0].message).toContain('1~10세');
  });
});
