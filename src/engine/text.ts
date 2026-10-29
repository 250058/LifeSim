// 사건 문장 채우기. {지인}, {부모}, {대학} 같은 자리표시자를 실제 이름과 값으로 바꾸고
// 바로 뒤의 조사를 받침에 맞게 고친다: '{지인}이/가' → '김민지가', '{지인}이 ' → '박지훈이 '

import { admissionName, susiTier } from './career';
import { REGION_BY_ID, WORLD } from './data';
import { formatWon, HIGH_TYPE_LABEL, josa, JOSA_PATTERN, SINGLE_TO_PAIR } from './format';
import { homePrice } from './scope';
import { alive, guardianLabel, npcAge, partnerOf, randomGiven, randomSurname, roleLabel, spouseOf } from './relations';
import type { EventDef } from './schema';
import type { Rng } from './rng';
import type { GameState, Sex, TalentKey } from './types';

const PLACEHOLDER = /\{([^{}]+)\}/g;

/** 사건 하나에 쓰인 모든 자리표시자 */
export function placeholdersOf(ev: EventDef): string[] {
  const texts: string[] = [ev.title, ev.text, ev.zoom ?? ''];
  for (const c of ev.choices ?? []) {
    texts.push(c.text, c.result ?? '', c.onSuccess?.text ?? '', c.onFail?.text ?? '');
  }
  const keys = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(PLACEHOLDER)) keys.add(m[1]);
  return [...keys].sort();
}

export const TALENT_LABEL: Record<TalentKey, string> = {
  music: '음악',
  sports: '운동',
  math: '수학',
  language: '언어',
  art: '미술',
  leadership: '리더십',
  craft: '손재주',
};

const TALENT_SCENE: Record<TalentKey, string> = {
  music: '음악 시간에 리코더를 불자 선생님이 잠깐 멈추라고 했다. "너 어디서 배웠니?"',
  sports: '체육 시간 오래달리기에서 반 아이들을 한 바퀴 차이로 따돌렸다. 체육 선생님이 이름을 물었다.',
  math: '수학 경시대회 문제를 혼자 다 풀었다. 담임이 시험지를 두 번 들여다봤다.',
  language: '원어민 선생님이 내 발음을 듣고 눈이 동그래졌다. 영어 동화책 한 권을 하루 만에 외웠다.',
  art: '미술 시간에 그린 그림이 교내 복도에 걸렸다. 교장 선생님이 한참 서서 봤다.',
  leadership: '모둠 활동에서 다들 자연스럽게 내 말을 따랐다. 싸우던 두 아이도 내가 말리자 멈췄다.',
  craft: '고장 난 라디오를 혼자 뜯어서 고쳐 놓았다. 아빠가 공구함을 통째로 물려줬다.',
};

const ENLIST_PLACE: Record<string, string> = {
  army: '논산 육군훈련소',
  navy: '진해 해군교육사령부',
  airforce: '진주 공군교육사령부',
  marines: '포항 해병대교육훈련단',
  social: '사회복무요원 기초군사훈련',
};

function personName(state: GameState, rng: Rng, sex: Sex, birthYear: number): string {
  void state;
  return randomSurname(rng) + randomGiven(rng, sex, birthYear);
}

function nagging(state: GameState): string {
  const ch = state.ch;
  if (ch.age < 19 || ch.edu.status === 'university') return '공부는 잘하니? 반에서 몇 등 하니?';
  if (!ch.career.jobId) return '취직은 했니? 요즘 뭐 하고 지내니?';
  if (!spouseOf(ch)) return '결혼은 언제 하니? 만나는 사람은 있고?';
  const kids = alive(ch, 'child').length;
  if (kids === 0) return '애는 언제 가질 거니? 더 늦으면 힘들다.';
  if (kids === 1) return '둘째는? 애 혼자 크면 외로워.';
  return '애들 학원은 어디 보내니? 요즘 영어유치원 다들 보내던데.';
}

/**
 * 카드가 처음 나올 때 한 번 만드는 값들. 같은 카드 안에서는 같은 사람을 가리켜야 하므로
 * ctx에 저장한다. 이미 있으면 건드리지 않는다 (연속 사건이 같은 지인을 이어받는다).
 */
export function generateCtx(state: GameState, ev: EventDef, ctx: Record<string, string>, rng: Rng): void {
  const ch = state.ch;
  for (const key of placeholdersOf(ev)) {
    if (ctx[key] !== undefined) continue;
    switch (key) {
      case '지인':
        ctx[key] = personName(state, rng, rng.chance(0.6) ? ch.sex : ch.sex === 'M' ? 'F' : 'M', ch.birthYear + rng.int(-4, 2));
        break;
      case '상대':
        ctx[key] = personName(state, rng, ch.sex === 'M' ? 'F' : 'M', ch.birthYear + rng.int(-3, 3));
        break;
      case '친구': {
        const fs = alive(ch, 'friend');
        if (fs.length > 0) {
          const f = rng.pick(fs);
          ctx[key] = f.name;
          ctx.friendId = f.id;
        } else {
          ctx[key] = personName(state, rng, ch.sex, ch.birthYear);
        }
        break;
      }
      case '부모': {
        const ps = alive(ch, 'mother', 'father');
        if (ps.length > 0) {
          // 나이가 더 많은 쪽 (병환·피싱 사건의 당사자)
          const p = ps.reduce((a, b) => (npcAge(a, state.year) >= npcAge(b, state.year) ? a : b));
          ctx[key] = roleLabel(p, ch);
          ctx.parentId = p.id;
        } else {
          ctx[key] = guardianLabel(ch);
        }
        break;
      }
      case '형제': {
        const sibs = alive(ch, 'sibling');
        if (sibs.length > 0) {
          const s = rng.pick(sibs);
          ctx[key] = roleLabel(s, ch);
          ctx.siblingId = s.id;
        } else {
          ctx[key] = '사촌';
        }
        break;
      }
      case '재능':
      case '재능장면': {
        // 둘은 항상 함께 정해진다
        if (ctx.talent !== undefined) break;
        const hidden = ch.talents.filter((t) => !t.discovered);
        const t = hidden.length > 0 ? rng.pick(hidden) : ch.talents[0];
        ctx.talent = t ? t.key : '';
        ctx.재능 = t ? TALENT_LABEL[t.key] : '';
        ctx.재능장면 = t ? TALENT_SCENE[t.key] : '';
        break;
      }
      case '암종': {
        const types = WORLD.cancerTypes.filter((c) =>
          ch.sex === 'M' ? c !== '유방암' : c !== '전립선암',
        );
        ctx[key] = rng.pick(types);
        break;
      }
      case '병기': {
        const early = Boolean(ch.flags.checked_up);
        ctx[key] = rng.weighted(['1기', '2기', '3기', '4기'], (s) =>
          s === '1기' ? (early ? 5 : 2) : s === '2기' ? 3 : s === '3기' ? 2 : early ? 0.5 : 1.5,
        )!;
        break;
      }
      case '정당':
        ctx[key] = state.world.politics.ruling ?? rng.pick(WORLD.parties);
        break;
      case '연인':
        ctx[key] = partnerOf(ch)?.name ?? '그 사람';
        break;
      case '배우자':
        ctx[key] = spouseOf(ch)?.name ?? '배우자';
        break;
      case '잔소리':
        ctx[key] = nagging(state);
        break;
      case '자녀': {
        const kids = alive(ch, 'child');
        if (kids.length > 0) {
          const k = rng.pick(kids);
          ctx[key] = k.name;
          ctx.childId = k.id;
        } else {
          ctx[key] = '조카';
        }
        break;
      }
      case '합격대학':
        ctx[key] = admissionName(state, rng);
        break;
      // 특별 전형: 이름과 등급을 함께 정해 두면 enterUniversity·earlyAdmit가 그대로 쓴다
      case '과기원':
        ctx[key] = ctx.합격대학 = rng.pick(WORLD.specialUniversities.science);
        ctx.합격등급 = 'S';
        break;
      case '예대':
        ctx[key] = ctx.합격대학 = rng.pick(WORLD.specialUniversities.arts);
        ctx.합격등급 = 'A';
        break;
      case '체대':
        ctx[key] = ctx.합격대학 = rng.pick(WORLD.specialUniversities.sports);
        ctx.합격등급 = 'B';
        break;
      case '수시목표': {
        const tier = susiTier(state);
        ctx[key] = ctx.합격대학 = rng.pick(WORLD.universities[tier]);
        ctx.합격등급 = tier;
        break;
      }
      case '집값': {
        const price = homePrice(state);
        ctx.homePrice = String(price);
        ctx[key] = formatWon(price);
        break;
      }
      case '분양가': {
        const price = Math.round(homePrice(state) * 0.85);
        ctx.homePrice = String(price);
        ctx[key] = formatWon(price);
        break;
      }
    }
  }
}

/** 렌더링 시점에 상태에서 바로 계산하는 값 */
function dynamicValue(state: GameState, key: string): string | undefined {
  const ch = state.ch;
  switch (key) {
    case '이름':
      return ch.given;
    case '성명':
      return ch.surname + ch.given;
    case '지역':
      return REGION_BY_ID.get(ch.region)?.short ?? ch.region;
    case '고향':
      return REGION_BY_ID.get(ch.birthRegion)?.short ?? ch.birthRegion;
    case '연도':
      return String(state.year);
    case '나이':
      return String(ch.age);
    case '보호자':
      return guardianLabel(ch);
    case '최저시급':
      return state.world.economy.minWage.toLocaleString('ko-KR');
    case '내신':
      return `상위 ${Math.max(1, Math.round(100 - ch.edu.grade))}%`;
    case '대학':
      return ch.edu.univ?.name ?? '대학';
    case '직장':
      return ch.career.title ?? '회사';
    case '입영지':
      return ENLIST_PLACE[ch.military.branch ?? 'army'];
    case '신체등급':
      return String(ch.military.grade ?? 1);
    case '연금':
      return formatWon(Math.round((ch.career.pension * state.world.economy.priceIndex) / 12 / 1000) * 1000);
    case '빚':
      return formatWon(Math.round(ch.res.debt / 10_000) * 10_000);
    case '조부모':
      return ch.sex === 'F' ? '할머니' : '할아버지';
    case '수시대학':
      return ch.edu.earlyAdmit?.name ?? '대학';
    case '학교':
      return ch.edu.highType ? HIGH_TYPE_LABEL[ch.edu.highType] : '학교';
    case '수능백분위':
      return ch.edu.csat ? String(ch.edu.csat.percentile) : '';
    case '연인':
      return partnerOf(ch)?.name;
    case '배우자':
      return spouseOf(ch)?.name;
  }
  return undefined;
}

/** 자리표시자 치환 + 조사 교정 */
export function render(template: string, state: GameState, ctx: Record<string, string>): string {
  const re = new RegExp(`\\{([^{}]+)\\}(?:(${JOSA_PATTERN})|([이가을를은는과와])(?=[\\s.,!?'"…)\\]]|$))?`, 'g');
  return template.replace(re, (_m, key: string, pair?: string, single?: string) => {
    const value = ctx[key] ?? dynamicValue(state, key) ?? '';
    if (pair) return josa(value, pair);
    if (single) return josa(value, SINGLE_TO_PAIR[single]);
    return value;
  });
}
