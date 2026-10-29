// 사건 데이터 검증: 없는 태그·사건 참조, 문법이 틀린 조건식, 확률 오류,
// 생애 단계별 사건 수를 잡아낸다. 사건 작성 도구와 테스트가 함께 쓴다.

import { referencedPaths } from './conditions';
import { CRIMES } from './justice';
import { ACTIVITIES, EVENT_FILES, EVENTS, JOB_BY_ID, TAG_BY_ID } from './data';
import { STAGES } from './format';
import { newGame } from './game';
import { buildScope } from './scope';
import type { Action, ChoiceDef, Effects, EventDef, NextRef } from './schema';
import { HIDDEN_KEYS, STATE_KEYS, STAT_KEYS, TALENT_KEYS } from './types';

export interface Issue {
  level: 'error' | 'warn';
  where: string;
  message: string;
}

const TYPES = new Set(['milestone', 'random', 'chain_start', 'chain', 'consequence', 'npc', 'world']);
const DRAWN = new Set(['random', 'chain_start', 'consequence', 'npc', 'world']);
const ATTRS = new Set<string>([...STAT_KEYS, ...HIDDEN_KEYS, ...STATE_KEYS]);
/** 엔진 코드가 직접 부르는 사건 (다른 사건이 참조하지 않아도 된다) */
const SYSTEM_EVENTS = new Set(['npc_death', 'inheritance', 'arrested']);
/** 경로 첫 부분이 이 중 하나면 동적 키라서 하위 키를 검사하지 않는다 */
const DYNAMIC_ROOTS = new Set(['flags', 'ctx', 'traits']);

/** 자리표시자로 쓸 수 있는 이름 */
export const KNOWN_PLACEHOLDERS = new Set([
  // 상태에서 바로 계산
  '이름', '성명', '지역', '고향', '연도', '나이', '보호자', '최저시급', '내신', '대학', '직장', '입영지',
  '신체등급', '연금', '연인', '배우자', '조부모', '수능백분위', '빚',
  // 카드가 처음 뜰 때 생성
  '지인', '상대', '친구', '부모', '형제', '재능', '재능장면', '암종', '병기', '정당', '잔소리', '자녀', '합격대학', '분양가',
  '과기원', '예대', '체대', '수시목표', '수시대학', '학교', '집값',
  '헤어진가족', '상봉',
  // 행동(do)이 채우는 값
  '수능', '결과', '판결',
  // 엔진이 카드와 함께 넘기는 값
  '고인', '고인관계', '향년', '사인', '상속액', '혐의',
]);

const ACTION_TYPES = new Set([
  'discoverTalent', 'addSibling', 'addFriend', 'loseFriend', 'startPartner', 'breakUp', 'marry', 'haveChild', 'divorce',
  'parentsDivorce', 'parentsMarriage', 'moveRegion', 'enroll', 'computeCsat', 'enterUniversity', 'graduate', 'getJob',
  'loseJob', 'promote', 'retire', 'militaryExam', 'enlist', 'startService', 'discharge', 'prosecute', 'release', 'gamble',
  'startBusiness', 'closeBusiness', 'parentHealth', 'npcCloseness', 'leaveHome', 'refundPct', 'inherit', 'grade',
  'buyHome', 'debtRelief', 'earlyAdmit', 'passGed', 'separateFamily', 'reunite', 'setStyle',
]);

const HIGH_TYPES = new Set(['general', 'foreign', 'autonomous', 'gifted', 'science', 'arts', 'sports', 'vocational', 'meister', 'alternative']);

function sampleScope(): Record<string, unknown> {
  const state = newGame({ seed: 'VALIDATE', mode: 'drama', birthYear: 2026 });
  return buildScope(state) as Record<string, unknown>;
}

function pathKnown(scope: Record<string, unknown>, path: string[]): boolean {
  if (path.length === 0) return false;
  if (!(path[0] in scope)) return false;
  if (DYNAMIC_ROOTS.has(path[0])) return true;
  if (path[0] === 'world' && path[1] === 'news') return true;
  let cur: unknown = scope;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || !(key in (cur as object))) return false;
    cur = (cur as Record<string, unknown>)[key];
  }
  return true;
}

export function validateData(): Issue[] {
  const issues: Issue[] = [];
  const scope = sampleScope();
  const ids = new Set<string>();
  const referenced = new Set<string>();

  const err = (where: string, message: string) => issues.push({ level: 'error', where, message });
  const warn = (where: string, message: string) => issues.push({ level: 'warn', where, message });

  const checkExpr = (where: string, expr: string) => {
    try {
      for (const path of referencedPaths(expr)) {
        if (!pathKnown(scope, path)) err(where, `조건식이 모르는 값을 읽는다: ${path.join('.')} (${expr})`);
        if (path[0] === 'flags' && path[1] && !TAG_BY_ID.has(path[1])) err(where, `없는 태그 참조: ${path[1]}`);
      }
    } catch (e) {
      err(where, `조건식 문법 오류: ${(e as Error).message}`);
    }
  };

  const checkFlag = (where: string, id: string) => {
    if (!TAG_BY_ID.has(id)) err(where, `없는 태그: ${id}`);
  };

  const checkNext = (where: string, next: NextRef | undefined) => {
    if (!next) return;
    const list = typeof next === 'string' ? [next] : next.map((n) => n.event);
    for (const id of list) {
      referenced.add(id);
      if (!EVENTS.some((e) => e.id === id)) err(where, `없는 사건으로 이어짐: ${id}`);
    }
    if (typeof next !== 'string') {
      const total = next.reduce((s, n) => s + n.w, 0);
      if (total <= 0) err(where, 'next 가중치 합이 0이다');
    }
  };

  const checkAction = (where: string, a: Action) => {
    if (!ACTION_TYPES.has(a.type)) return err(where, `알 수 없는 행동: ${a.type}`);
    if (a.type === 'getJob' && !JOB_BY_ID.has(a.job)) err(where, `없는 직업: ${a.job}`);
    if (a.type === 'enroll' && a.highType && !HIGH_TYPES.has(a.highType)) err(where, `없는 고등학교 유형: ${a.highType}`);
    if (a.type === 'prosecute' && a.crime !== 'ctx' && !CRIMES[a.crime]) err(where, `없는 범죄: ${a.crime}`);
    if (a.type === 'discoverTalent' && a.talent && !(TALENT_KEYS as readonly string[]).includes(a.talent)) {
      err(where, `없는 재능: ${a.talent}`);
    }
  };

  const checkEffects = (where: string, fx: Effects | undefined) => {
    if (!fx) return;
    for (const key of Object.keys(fx.stats ?? {})) if (!ATTRS.has(key)) err(where, `없는 능력치: ${key}`);
    for (const id of fx.addFlags ?? []) checkFlag(where, id);
    for (const id of fx.removeFlags ?? []) checkFlag(where, id);
    for (const a of fx.do ?? []) checkAction(where, a);
    for (const l of fx.later ?? []) {
      referenced.add(l.event);
      if (!EVENTS.some((e) => e.id === l.event)) err(where, `없는 사건 예약: ${l.event}`);
      if (l.inYears < 1) err(where, `later.inYears는 1 이상이어야 한다`);
    }
  };

  const checkText = (where: string, text: string | undefined) => {
    if (!text) return;
    for (const m of text.matchAll(/\{([^{}]+)\}/g)) {
      if (!KNOWN_PLACEHOLDERS.has(m[1])) err(where, `모르는 자리표시자: {${m[1]}}`);
    }
  };

  const checkChoice = (where: string, c: ChoiceDef) => {
    checkText(where, c.text);
    checkText(where, c.result);
    if (c.if) checkExpr(where, c.if);
    checkEffects(where, c.effects);
    checkNext(where, c.next);
    if (c.check) {
      const keys = c.check.stats ?? (c.check.stat ? [c.check.stat] : []);
      if (keys.length === 0) err(where, '판정에 능력치가 없다');
      for (const k of keys) {
        if (!ATTRS.has(k) && !pathKnown(scope, k.split('.'))) err(where, `판정할 수 없는 값: ${k}`);
      }
      if (!c.onSuccess && !c.onFail) warn(where, '판정이 있지만 결과가 없다');
    }
    for (const out of [c.onSuccess, c.onFail]) {
      if (!out) continue;
      checkText(where, out.text);
      checkEffects(where, out.effects);
      checkNext(where, out.next);
    }
  };

  for (const [file, events] of Object.entries(EVENT_FILES)) {
    for (const ev of events) {
      const where = `${file} › ${ev.id}`;
      if (ids.has(ev.id)) err(where, '사건 id가 겹친다');
      ids.add(ev.id);
      if (!TYPES.has(ev.type)) err(where, `알 수 없는 종류: ${ev.type}`);
      if (!ev.title || !ev.text) err(where, '제목이나 본문이 없다');
      checkText(where, ev.title);
      checkText(where, ev.text);
      checkText(where, ev.zoom);
      const t = ev.trigger;
      if (t) {
        if (t.age && t.age[0] > t.age[1]) err(where, '나이 범위가 뒤집혔다');
        for (const f of [...(t.flags ?? []), ...(t.anyFlags ?? []), ...(t.notFlags ?? [])]) checkFlag(where, f);
        if (t.if) checkExpr(where, t.if);
      }
      if (DRAWN.has(ev.type)) {
        if (!ev.weight) err(where, '추첨 사건에 weight가 없다');
        else {
          const w = ev.weight;
          if (!(w.base > 0 && w.base <= 1)) err(where, `기본 확률 p₀는 0~1 사이여야 한다: ${w.base}`);
          for (const [k, v] of Object.entries(w.ageCurve ?? {})) {
            if (Number.isNaN(Number(k)) || v < 0) err(where, `나이 곡선 오류: ${k} → ${v}`);
          }
          let maxP = w.base * Math.max(1, ...Object.values(w.ageCurve ?? {}));
          for (const m of w.modifiers ?? []) {
            checkExpr(where, m.if);
            if (m.x < 0) err(where, `음수 배수: ${m.x}`);
            if (m.x > 1) maxP *= m.x;
          }
          if (maxP > 1.5) warn(where, `보정을 모두 받으면 확률이 ${maxP.toFixed(2)} (상한 0.95에 걸림)`);
        }
      } else if (ev.weight) {
        warn(where, `${ev.type} 사건의 weight는 쓰이지 않는다`);
      }
      if (ev.filler && !(ev.type === 'random' || ev.type === 'npc')) err(where, 'filler는 random·npc 사건만 될 수 있다');
      if (ev.filler && (ev.impact ?? 0) > 12) warn(where, '충격량이 12를 넘어 일상 사건으로 쓰이지 않는다');
      checkEffects(where, ev.effects);
      checkNext(where, ev.next);
      const choices = ev.choices ?? [];
      // 화면에는 조건에 맞는 선택지만 뜬다. 조건 없는 선택지는 4개까지
      if (choices.length > 8) err(where, `선택지가 너무 많다 (${choices.length})`);
      if (choices.filter((c) => !c.if).length > 4) err(where, '조건 없는 선택지가 4개를 넘는다');
      if (choices.length === 1) warn(where, '선택지가 하나뿐이다 (정보 카드라면 choices를 비워라)');
      choices.forEach((c, i) => checkChoice(`${where} › 선택지 ${i + 1}`, c));
    }
  }

  for (const ev of EVENTS) {
    if (ev.type === 'chain' && !referenced.has(ev.id) && !SYSTEM_EVENTS.has(ev.id)) {
      warn(`${ev.id}`, '어느 사건도 이 연속 사건으로 이어지지 않는다');
    }
  }

  for (const a of ACTIVITIES) {
    const where = `activities.json › ${a.id}`;
    if (a.if) checkExpr(where, a.if);
    checkEffects(where, a.effects);
  }

  return issues;
}

/** 생애 단계마다 그 나이에 일어날 수 있는 사건 수 (마일스톤 포함, 연속 사건 제외) */
export function eventsPerStage(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of STAGES) {
    out[s.label] = EVENTS.filter((ev) => {
      if (ev.type === 'chain') return false;
      const [lo, hi] = ev.trigger?.age ?? [0, 200];
      return lo <= s.to && hi >= s.from;
    }).length;
  }
  return out;
}

export function eventStats(): { total: number; byType: Record<string, number> } {
  const byType: Record<string, number> = {};
  for (const ev of EVENTS) byType[ev.type] = (byType[ev.type] ?? 0) + 1;
  return { total: EVENTS.length, byType };
}

export type { EventDef };
