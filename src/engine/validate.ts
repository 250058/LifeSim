// 사건 데이터 검증: 없는 태그·사건 참조, 문법이 틀린 조건식, 확률 오류,
// 생애 단계별 사건 수를 잡아낸다. 사건 작성 도구와 테스트가 함께 쓴다.

import { referencedPaths } from './conditions';
import { CRIME_SYSTEM_EVENTS, crimeActionProblem } from './crime';
import { CRIMES } from './justice';
import { ACTIVITIES, EVENT_FILES, EVENTS, JOB_BY_ID, TAG_BY_ID, TAGS } from './data';
import { STAGES } from './format';
import { newGame } from './game';
import { buildScope } from './scope';
import type { Action, ChoiceDef, Effects, EventDef, NextRef } from './schema';
import { effectsOf, targetRolesOf } from './text';
import { HIDDEN_KEYS, STATE_KEYS, STAT_KEYS, SUBSTANCE_ACTS, SUBSTANCE_IDS, TALENT_KEYS } from './types';
import { POOL_IDS } from './pools';

export interface Issue {
  level: 'error' | 'warn';
  where: string;
  message: string;
}

const TYPES = new Set(['milestone', 'random', 'chain_start', 'chain', 'consequence', 'npc', 'world']);
const DRAWN = new Set(['random', 'chain_start', 'consequence', 'npc', 'world']);
const ATTRS = new Set<string>([...STAT_KEYS, ...HIDDEN_KEYS, ...STATE_KEYS]);
/** 엔진 코드가 직접 부르는 사건 (다른 사건이 참조하지 않아도 된다) */
const SYSTEM_EVENTS = new Set([
  'npc_death',
  'inheritance',
  'arrested',
  'rom_pregnancy_scare',
  // substances.ts: 재발, 불법 약물 적발·응급실
  'sub_relapse',
  'sub_drug_arrest',
  'sub_drug_emergency',
]);
// crime.ts: 사건 번호를 붙여 예약하는 단계 카드 (수사·재판·조직 조사·재발·회복 등)
for (const id of CRIME_SYSTEM_EVENTS) SYSTEM_EVENTS.add(id);
/** 본인의 술·담배·약물 사용을 뜻하는 태그 */
const USE_TAGS = new Set(['smoker', 'vaper', 'heavy_drinker', 'drug_use']);
/** 물질을 정하지 않아도 되는 행동 (치료 중·끊는 중인 물질 전부에 적용) */
const SUBSTANCE_ANY_ACTS = new Set(['completeTreatment', 'dropTreatment', 'resist']);

/** 효과가 본인의 사용을 일으키는가 (사용 행동 또는 사용 태그) */
function causesUse(fx: Effects | undefined): boolean {
  if (!fx) return false;
  if ((fx.addFlags ?? []).some((f) => USE_TAGS.has(f))) return true;
  return (fx.do ?? []).some((a) => a.type === 'substance' && a.act === 'use');
}

function choiceCausesUse(c: ChoiceDef): boolean {
  return causesUse(c.effects) || causesUse(c.onSuccess?.effects) || causesUse(c.onFail?.effects);
}

/** 경로 첫 부분이 이 중 하나면 동적 키라서 하위 키를 검사하지 않는다 */
const DYNAMIC_ROOTS = new Set(['flags', 'ctx', 'traits']);

/** 자리표시자로 쓸 수 있는 이름 */
export const KNOWN_PLACEHOLDERS = new Set([
  // 상태에서 바로 계산
  '이름', '성명', '지역', '고향', '연도', '나이', '보호자', '최저시급', '내신', '대학', '직장', '입영지',
  '신체등급', '연금', '연인', '배우자', '조부모', '수능백분위', '빚', '짝',
  // 카드가 처음 뜰 때 생성
  '지인', '상대', '친구', '부모', '형제', '재능', '재능장면', '암종', '병기', '정당', '잔소리', '자녀', '합격대학', '분양가',
  '과기원', '예대', '체대', '수시목표', '수시대학', '학교', '집값',
  '헤어진가족', '상봉',
  // 행동(do)이 채우는 값
  '수능', '결과', '판결',
  // 엔진이 카드와 함께 넘기는 값
  '고인', '고인관계', '향년', '사인', '상속액', '혐의', '물질',
]);

const ACTION_TYPES = new Set([
  'discoverTalent', 'addSibling', 'addFriend', 'loseFriend', 'startPartner', 'breakUp', 'marry', 'haveChild', 'divorce',
  'parentsDivorce', 'parentsMarriage', 'moveRegion', 'enroll', 'computeCsat', 'enterUniversity', 'graduate', 'getJob',
  'loseJob', 'promote', 'retire', 'militaryExam', 'enlist', 'startService', 'discharge', 'prosecute', 'release', 'gamble',
  'startBusiness', 'closeBusiness', 'parentHealth', 'npcCloseness', 'leaveHome', 'refundPct', 'inherit', 'grade',
  'buyHome', 'debtRelief', 'earlyAdmit', 'passGed', 'separateFamily', 'reunite', 'setStyle', 'substance',
]);

// 범죄 피해·목격·지원 사건 (crime.ts)
ACTION_TYPES.add('crime');

const HIGH_TYPES = new Set(['general', 'foreign', 'autonomous', 'gifted', 'science', 'arts', 'sports', 'vocational', 'meister', 'alternative']);

/**
 * 친밀도를 바꿀 수 있는 역할 (text.ts '대상 인물'과 짝). child·sibling·friend는 카드에 묶인 한 사람,
 * partner·spouse·mother·father는 원래 한 사람, parents는 부모 둘 다를 뜻하는 유일한 복수 표기다.
 * 조부모·전 배우자는 여러 명일 수 있는데 한 사람을 고를 규칙이 없어 '모두'로 번지므로 쓸 수 없다.
 * 모든 자녀를 뜻하는 표기('children' 등)는 아직 없다.
 */
const CLOSENESS_ROLES = new Set(['child', 'sibling', 'friend', 'partner', 'spouse', 'mother', 'father', 'parents']);

/** 사람을 새로 만드는 행동 → 그 역할. 대상은 카드가 뜰 때 이미 있는 사람 중에서 묶이므로 같은 사건의 대상이 될 수 없다 */
const CREATES: Partial<Record<Action['type'], 'child' | 'sibling'>> = { haveChild: 'child', addSibling: 'sibling' };

/** 나이 범위의 끝 (자녀 나이대를 정하지 않은 사건) */
const MAX_AGE = 120;

function nextIds(next: NextRef | undefined): string[] {
  if (!next) return [];
  return typeof next === 'string' ? [next] : next.map((n) => n.event);
}

/** 이어지는 사건 하나: next는 0년, later는 n년 뒤 */
interface Link {
  from: EventDef;
  to: EventDef;
  years: number;
}

function linksOf(events: EventDef[]): Link[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const out: Link[] = [];
  const add = (from: EventDef, id: string, years: number) => {
    const to = byId.get(id);
    if (to) out.push({ from, to, years });
  };
  for (const ev of events) {
    for (const id of nextIds(ev.next)) add(ev, id, 0);
    for (const c of ev.choices ?? []) {
      for (const n of [c.next, c.onSuccess?.next, c.onFail?.next]) for (const id of nextIds(n)) add(ev, id, 0);
    }
    for (const fx of effectsOf(ev)) for (const l of fx.later ?? []) add(ev, l.event, l.inYears);
  }
  return out;
}

const targetsChild = (ev: EventDef) => targetRolesOf(ev).includes('child');

/**
 * 사건마다 '묶인 자녀가 그 사건에 올 때 가질 수 있는 나이' [최소, 최대].
 * 자녀를 스스로 묶는 사건(추첨·관문으로 바로 뜨거나, 자녀를 넘기지 않는 앞 사건에서 오는 연속 사건)은
 * 자기 자녀 나이대에서 시작하고, 이어지는 사건으로 지연 햇수만큼 더해 퍼진다.
 */
function childReach(events: EventDef[], links: Link[]): Map<EventDef, [number, number]> {
  // 묶인 자녀를 넘겨줄 수 있는 사건: 자녀를 대상으로 하거나, 그런 사건에서 이어진다 (ctx를 그대로 물려준다)
  const carries = new Set(events.filter(targetsChild));
  for (let grew = true; grew; ) {
    grew = false;
    for (const l of links) {
      if (carries.has(l.from) && !carries.has(l.to)) {
        carries.add(l.to);
        grew = true;
      }
    }
  }
  const preds = new Map<EventDef, EventDef[]>();
  for (const l of links) preds.set(l.to, [...(preds.get(l.to) ?? []), l.from]);
  const reach = new Map<EventDef, [number, number]>();
  for (const ev of events) {
    if (!targetsChild(ev)) continue;
    const ps = preds.get(ev) ?? [];
    if (ev.type !== 'chain' || ps.length === 0 || ps.some((p) => !carries.has(p))) reach.set(ev, ev.trigger?.childAge ?? [0, MAX_AGE]);
  }
  for (let round = 0; round < MAX_AGE * 2; round++) {
    let changed = false;
    for (const l of links) {
      const r = reach.get(l.from);
      if (!r) continue;
      let lo = Math.min(MAX_AGE, r[0] + l.years);
      let hi = Math.min(MAX_AGE, r[1] + l.years);
      // 나이대가 맞지 않는 아이는 그 사건에서 취소되므로 더 퍼지지 않는다
      const range = l.to.trigger?.childAge;
      if (range) [lo, hi] = [Math.max(lo, range[0]), Math.min(hi, range[1])];
      if (lo > hi) continue;
      const cur = reach.get(l.to);
      const next: [number, number] = cur ? [Math.min(cur[0], lo), Math.max(cur[1], hi)] : [lo, hi];
      if (!cur || next[0] !== cur[0] || next[1] !== cur[1]) {
        reach.set(l.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return reach;
}

/**
 * 대상 인물 규칙 (R-011·R-012, text.ts '대상 인물'과 짝):
 *  - 아이·동생을 새로 만드는 사건은 그 역할을 대상으로 삼을 수 없다. 대상은 카드가 뜰 때 이미 있는 사람 중에서
 *    묶이므로 갓난아이가 아니라 형·누나를 가리키게 된다 (오류).
 *  - 자녀를 물려받는 연속·예약 사건은 물려받은 아이의 나이가 그 사건의 자녀 나이대에 들어야 한다.
 *    벗어나는 아이에게는 뜨기 직전 재검사에서 언제나 취소된다 (경고).
 */
export function targetIssues(events: EventDef[], whereOf: (ev: EventDef) => string = (ev) => ev.id): Issue[] {
  const issues: Issue[] = [];
  for (const ev of events) {
    const roles = targetRolesOf(ev);
    for (const fx of effectsOf(ev)) {
      for (const a of fx.do ?? []) {
        const made = CREATES[a.type];
        if (made && roles.includes(made)) {
          issues.push({ level: 'error', where: whereOf(ev), message: `${a.type}로 새로 생기는 사람은 이 사건의 대상(${made})이 될 수 없다: 대상은 카드가 뜰 때 이미 있는 사람 중에서 묶인다` });
        }
      }
    }
  }
  const links = linksOf(events);
  const reach = childReach(events, links);
  const seen = new Set<string>();
  for (const l of links) {
    const r = reach.get(l.from);
    const range = l.to.trigger?.childAge;
    if (!r || !range) continue;
    const lo = r[0] + l.years;
    const hi = r[1] + l.years;
    const key = `${l.from.id}>${l.to.id}>${l.years}`;
    if ((lo >= range[0] && hi <= range[1]) || seen.has(key)) continue;
    seen.add(key);
    issues.push({
      level: 'warn',
      where: whereOf(l.from),
      message: `${l.to.id}에 물려주는 자녀는 ${lo}~${Math.min(hi, MAX_AGE)}세인데 그 사건의 자녀 나이대는 ${range[0]}~${range[1]}세다 (벗어난 아이에게는 취소된다)`,
    });
  }
  return issues;
}

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
    if (a.type === 'crime') {
      const problem = crimeActionProblem(a);
      if (problem) err(where, problem);
    }
    if (a.type === 'discoverTalent' && a.talent && !(TALENT_KEYS as readonly string[]).includes(a.talent)) {
      err(where, `없는 재능: ${a.talent}`);
    }
    if (a.type === 'npcCloseness' && !CLOSENESS_ROLES.has(a.role)) {
      err(where, `친밀도 역할 ${a.role}: 한 사람을 고를 규칙이 없다 (자녀·형제·친구는 카드에 묶인 한 명, 부모 둘 다는 parents. 모든 자녀를 뜻하는 표기는 아직 없다)`);
    }
    if (a.type === 'substance') {
      if (!(SUBSTANCE_ACTS as readonly string[]).includes(a.act)) err(where, `없는 물질 행동: ${a.act}`);
      if (a.substance === undefined) {
        if (!SUBSTANCE_ANY_ACTS.has(a.act)) err(where, `물질을 정해야 하는 행동: ${a.act}`);
      } else if (a.substance !== 'ctx' && !(SUBSTANCE_IDS as readonly string[]).includes(a.substance)) {
        err(where, `없는 물질: ${a.substance}`);
      }
      if (a.amount !== undefined && !(a.amount > 0 && a.amount <= 3)) err(where, `사용량은 0보다 크고 3 이하: ${a.amount}`);
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

  const tagIds = new Set<string>();
  for (const t of TAGS) {
    if (tagIds.has(t.id)) err(`태그 ${t.id}`, '태그 id가 겹친다 (tags.json과 사건 목록의 tags를 함께 본다)');
    tagIds.add(t.id);
  }

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
      if (ev.pool && !(POOL_IDS as string[]).includes(ev.pool)) err(where, `없는 풀: ${ev.pool}`);
      // 성인 전용 사건은 만 19세 미만에게 절대 열리지 않아야 한다
      if (ev.adult && !(t?.age && t.age[0] >= 19)) err(where, '성인 전용 사건은 trigger.age 최소가 19 이상이어야 한다');
      // 본인의 술·담배·약물 사용은 성인만: 사건 자체가 19세 이상이거나, 선택지에 substance.adult 조건이 있어야 한다.
      // 미성년자에게 권유가 오는 사건은 괜찮다 (거절·노출만 기록된다)
      const adultOnly = Boolean(ev.adult) || (t?.age?.[0] ?? 0) >= 19;
      if (!adultOnly && causesUse(ev.effects)) err(where, '미성년자에게도 일어나는 사건이 술·담배·약물 사용을 일으킨다');
      (ev.choices ?? []).forEach((c, i) => {
        if (!adultOnly && choiceCausesUse(c) && !c.if?.includes('substance.adult')) {
          err(`${where} › 선택지 ${i + 1}`, '미성년자도 고를 수 있는 선택지가 술·담배·약물 사용을 일으킨다 (if에 substance.adult가 필요하다)');
        }
      });
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

  // 대상 인물: 새로 생기는 사람을 대상으로 삼는 사건, 물려받은 자녀의 나이가 맞지 않는 연속·예약 사건
  const fileOf = new Map<string, string>();
  for (const [file, events] of Object.entries(EVENT_FILES)) for (const ev of events) fileOf.set(ev.id, file);
  issues.push(...targetIssues(EVENTS, (ev) => `${fileOf.get(ev.id) ?? '?'} › ${ev.id}`));

  for (const a of ACTIVITIES) {
    const where = `activities.json › ${a.id}`;
    if (a.if) checkExpr(where, a.if);
    checkEffects(where, a.effects);
    // 성인 전용(adult)은 본인 나이만 본다. 커플 활동(couple)은 여기에 더해 상대도 성인이어야 한다
    // (엔진이 family.partnerAdult를 따로 검사한다). 독신의 음주·흡연에 커플 조건을 요구하지 않는다
    if (a.adult && a.age[0] < 19) err(where, '성인 전용 활동은 만 19세 이상이어야 한다');
    if (a.couple && !a.adult) err(where, '커플 활동은 성인 전용(adult)이기도 해야 한다');
    if (causesUse(a.effects) && !a.adult) err(where, '술·담배·약물 사용 활동은 성인 전용(adult)이어야 한다');
    if (a.special === 'substance' || a.substance) {
      const s = a.substance;
      if (!s || a.special !== 'substance') {
        err(where, 'special "substance"와 substance 정보는 함께 써야 한다');
      } else {
        if (!(SUBSTANCE_IDS as readonly string[]).includes(s.id)) err(where, `없는 물질: ${s.id}`);
        if (!(SUBSTANCE_ACTS as readonly string[]).includes(s.act)) err(where, `없는 물질 행동: ${s.act}`);
        if (s.act === 'use' && !a.adult) err(where, '술·담배·약물 사용 활동은 성인 전용(adult)이어야 한다');
      }
    }
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

export function eventStats(): { total: number; byType: Record<string, number>; byPool: Record<string, number> } {
  const byType: Record<string, number> = {};
  const byPool: Record<string, number> = {};
  for (const ev of EVENTS) {
    byType[ev.type] = (byType[ev.type] ?? 0) + 1;
    if (ev.pool) byPool[ev.pool] = (byPool[ev.pool] ?? 0) + 1;
  }
  return { total: EVENTS.length, byType, byPool };
}

export type { EventDef };
