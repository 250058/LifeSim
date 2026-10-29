// 탄생 시스템: 시작 버튼을 누르면 아래 10가지가 실제 분포에 맞춰 정해진다.
// 출생 연도, 성별, 출생지, 가정 형편, 부모, 형제자매, 유전 능력치, 숨은 재능, 성격, 선천 특성

import { REGIONS } from './data';
import { josa } from './format';
import { makeNpc, randomGiven, randomSurname, roleLabel } from './relations';
import { rngFor, type Rng } from './rng';
import { modeMultiplier } from './world';
import type {
  Character,
  Family,
  FamilyType,
  GameState,
  Mode,
  Npc,
  ParentingStyle,
  PersonalityKey,
  Sex,
  Talent,
  TalentKey,
} from './types';
import { PERSONALITY_KEYS, TALENT_KEYS } from './types';

/** 출생 성비 약 105 (여아 100명당 남아) */
export const P_MALE = 105 / 205;
/** 출생 순위 비중 (2025 출생통계): 첫째 62.4%, 둘째 31.2%, 셋째 이상 6.4% */
const BIRTH_ORDER: [number, number][] = [
  [1, 62.4],
  [2, 31.2],
  [3, 6.4],
];
/** 부모 평균 출산 연령 (2025): 어머니 33.8세, 아버지 36.1세 */
const MOTHER_AGE = 33.8;
const FATHER_GAP = 2.3;

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(x)));

/** 희귀 출발. 기본 확률은 모드 배수를 받는다 */
const RARE_STARTS = {
  chaebol: 0.0003,
  facility: 0.003,
  grandparents: 0.006,
  singleParent: 0.05,
};

/** [특성, 확률, 모드 배수를 받는가] */
const RARE_TRAITS: [string, number, boolean][] = [
  ['genius', 0.001, true],
  ['congenital_heart', 0.008, false],
  ['perfect_pitch', 0.0005, true],
];
/** 다태아 비율 약 5% (최근 출생통계) */
const P_TWIN = 0.05;

const EDUCATION_BY_WEALTH: Record<number, [string, number][]> = {
  1: [
    ['고졸', 55],
    ['전문대졸', 25],
    ['대졸', 20],
  ],
  2: [
    ['고졸', 35],
    ['전문대졸', 30],
    ['대졸', 35],
  ],
  3: [
    ['고졸', 20],
    ['전문대졸', 25],
    ['대졸', 55],
  ],
  4: [
    ['고졸', 10],
    ['대졸', 70],
    ['대학원졸', 20],
  ],
  5: [
    ['대졸', 60],
    ['대학원졸', 40],
  ],
  6: [
    ['대졸', 30],
    ['대학원졸', 70],
  ],
};

const JOBS_BY_WEALTH: Record<number, string[]> = {
  1: ['일용직 노동자', '식당 종업원', '배달 기사', '요양보호사', '편의점 점주', '무직'],
  2: ['생산직 근로자', '경비원', '택시 기사', '마트 직원', '미용사', '자영업자'],
  3: ['중소기업 사무직', '공무원', '간호사', '자영업자', '영업직', '버스 기사'],
  4: ['대기업 과장', '교사', '공무원', '개발자', '은행원', '약사'],
  5: ['대기업 부장', '의사', '변호사', '회계사', '교수', '사업가'],
  6: ['그룹 부회장', '계열사 사장', '그룹 전무'],
};

/** 가정 형편별 부모가 물려줄 재산 (2026년 원) */
const ESTATE_BY_WEALTH: Record<number, [number, number]> = {
  1: [0, 30_000_000],
  2: [30_000_000, 150_000_000],
  3: [150_000_000, 400_000_000],
  4: [400_000_000, 900_000_000],
  5: [900_000_000, 3_000_000_000],
  6: [200_000_000_000, 800_000_000_000],
};

export interface NewGameOptions {
  seed: string;
  mode: Mode;
  birthYear: number;
}

function personality(rng: Rng): Record<PersonalityKey, number> {
  const p = {} as Record<PersonalityKey, number>;
  for (const k of PERSONALITY_KEYS) p[k] = clamp(rng.normal(50, 15));
  return p;
}

function talents(rng: Rng): Talent[] {
  const count = rng.weighted(
    [
      [1, 50],
      [2, 35],
      [3, 15],
    ] as const,
    ([, w]) => w,
  )![0];
  const keys = rng.shuffle([...TALENT_KEYS]).slice(0, count) as TalentKey[];
  return keys.map((key) => ({ key, discovered: false }));
}

function rare(mode: Mode, p: number, rng: Rng): boolean {
  return rng.chance(p * modeMultiplier(mode, p));
}

export function createCharacter(state: GameState, opts: NewGameOptions): Character {
  const rng = rngFor(opts.seed, 'birth');
  const { mode, birthYear } = opts;

  const sex: Sex = rng.chance(P_MALE) ? 'M' : 'F';
  const region = rng.weighted(REGIONS, (r) => r.births2024)!.id;

  // 가정 형편: 소득 5분위 각 20% + 희귀 출발
  let wealth = rng.int(1, 5);
  let type: FamilyType = 'two_parent';
  if (rare(mode, RARE_STARTS.chaebol, rng)) wealth = 6;
  else if (rare(mode, RARE_STARTS.facility, rng)) {
    type = 'facility';
    wealth = 1;
  } else if (rare(mode, RARE_STARTS.grandparents, rng)) {
    type = 'grandparents';
    wealth = Math.min(wealth, 2);
  } else if (rng.chance(RARE_STARTS.singleParent)) {
    type = 'single_parent';
    wealth = Math.min(wealth, 3);
  }

  const parentingStyle = rng.weighted(
    [
      ['authoritative', 35],
      ['authoritarian', 30],
      ['permissive', 22],
      ['neglectful', 13],
    ] as [ParentingStyle, number][],
    ([, w]) => w,
  )![0];

  const [eLo, eHi] = ESTATE_BY_WEALTH[wealth];
  const family: Family = {
    type,
    wealth,
    parentsMarried: type === 'two_parent',
    marriageQuality: clamp(rng.normal(60, 15)),
    parentingStyle,
    estate: type === 'facility' ? 0 : Math.round(rng.float(eLo, eHi)),
    hiddenDebt: rng.chance(0.08) && wealth <= 4 ? Math.round(rng.float(20_000_000, 200_000_000)) : 0,
    livesWithParents: type !== 'facility',
  };

  const surname = randomSurname(rng);
  const given = randomGiven(rng, sex, birthYear);

  const ch: Character = {
    surname,
    given,
    sex,
    birthYear,
    birthRegion: region,
    region,
    age: 0,
    alive: true,
    stats: { health: 0, stamina: 0, intelligence: 0, looks: 0, sociability: 0, happiness: 0 },
    hidden: { morality: clamp(rng.normal(55, 12)), mental: clamp(rng.normal(50, 15)), luck: rng.int(30, 70) },
    state: { stress: 10, reputation: wealth === 6 ? 25 : 5 },
    personality: personality(rng),
    talents: talents(rng),
    traits: [],
    flags: {},
    res: { cash: 0, debt: 0, stocks: 0, coins: 0, realEstate: 0, network: wealth === 6 ? 40 : 10 },
    family,
    npcs: [],
    edu: { status: 'none', grade: 50, studyThisYear: 0, highStudy: 0, degree: 'none' },
    career: {
      salary: 0,
      years: 0,
      totalYears: 0,
      avgSalary: 0,
      raise: 1,
      retired: false,
      pension: 0,
      history: [],
      appliedThisYear: [],
    },
    military: { status: 'none' },
    legal: { convictions: 0 },
  };
  state.ch = ch;

  // 부모: 나이, 학력, 직업, 능력치. 부모도 같은 규칙으로 사는 NPC다
  const parentStats: { int: number; looks: number; stamina: number }[] = [];
  const motherAge = clamp(rng.normal(MOTHER_AGE, 4.2), 18, 46);
  const fatherAge = clamp(motherAge + rng.normal(FATHER_GAP, 3), 18, 60);
  const edu = (w: number) => rng.weighted(EDUCATION_BY_WEALTH[w], ([, x]) => x)![0];
  const job = (w: number) => rng.pick(JOBS_BY_WEALTH[w]);
  const parentNpc = (role: 'mother' | 'father', age: number): Npc => {
    const s = { int: clamp(rng.normal(48 + wealth * 2, 14)), looks: clamp(rng.normal(50, 14)), stamina: clamp(rng.normal(50, 14)) };
    parentStats.push(s);
    return makeNpc(state, rng, role, role === 'mother' ? 'F' : 'M', birthYear - age, {
      surname: role === 'father' ? surname : randomSurname(rng),
      closeness: clamp(rng.normal(70, 12)),
      health: clamp(rng.normal(84, 6)),
      education: edu(wealth),
      job: job(wealth),
    });
  };

  if (type === 'two_parent' || type === 'single_parent') {
    ch.npcs.push(parentNpc('mother', motherAge));
    if (type === 'two_parent') ch.npcs.push(parentNpc('father', fatherAge));
  } else if (type === 'grandparents') {
    // 조손가정: 할머니가 키운다. 부모는 연락이 끊겼다
    const gAge = clamp(rng.normal(62, 5), 50, 75);
    ch.npcs.push(
      makeNpc(state, rng, 'grandparent', 'F', birthYear - gAge, { closeness: 80, health: 70, job: '무직' }),
    );
    parentStats.push({ int: 50, looks: 50, stamina: 50 });
  } else {
    parentStats.push({ int: 50, looks: 50, stamina: 50 });
  }

  // 유전 능력치: 부모 평균 ± 랜덤 (평균으로 회귀)
  const avg = (k: 'int' | 'looks' | 'stamina') => parentStats.reduce((s, p) => s + p[k], 0) / parentStats.length;
  ch.stats.intelligence = clamp(0.5 * avg('int') + 25 + rng.normal(0, 12));
  ch.stats.looks = clamp(0.5 * avg('looks') + 25 + rng.normal(0, 12));
  ch.stats.stamina = clamp(0.5 * avg('stamina') + 25 + rng.normal(0, 12));
  ch.stats.health = clamp(rng.normal(88, 5));
  ch.stats.sociability = clamp(40 + ch.personality.extraversion * 0.25 + rng.normal(0, 8));
  ch.stats.happiness = clamp(rng.normal(70, 8));

  // 형제자매: 출생 순위 분포. 위로 형제가 있으면 2~4살 터울
  const order = rng.weighted(BIRTH_ORDER, ([, w]) => w)![0];
  let olderYear = birthYear;
  for (let i = 1; i < order; i++) {
    olderYear -= rng.int(2, 4);
    const sSex: Sex = rng.chance(P_MALE) ? 'M' : 'F';
    ch.npcs.push(makeNpc(state, rng, 'sibling', sSex, olderYear, { surname, closeness: clamp(rng.normal(60, 15)) }));
  }

  // 선천 특성 (희귀)
  if (rng.chance(P_TWIN)) {
    ch.traits.push('twin');
    const tSex: Sex = rng.chance(0.65) ? sex : sex === 'M' ? 'F' : 'M';
    ch.npcs.push(makeNpc(state, rng, 'sibling', tSex, birthYear, { surname, closeness: 75, twin: true }));
  }
  for (const [trait, p, boosted] of RARE_TRAITS) {
    if (boosted ? rare(mode, p, rng) : rng.chance(p)) ch.traits.push(trait);
  }
  if (ch.traits.includes('genius')) ch.stats.intelligence = clamp(ch.stats.intelligence + 30, 0, 100);
  if (ch.traits.includes('congenital_heart')) ch.stats.health = clamp(ch.stats.health - 25);
  if (ch.traits.includes('perfect_pitch') && !ch.talents.some((t) => t.key === 'music')) {
    ch.talents.push({ key: 'music', discovered: false });
  }
  if (wealth === 6) ch.flags.chaebol_heir = { since: 0 };
  if (type === 'facility') ch.flags.raised_in_facility = { since: 0 };
  if (type === 'grandparents') ch.flags.raised_by_grandparents = { since: 0 };

  return ch;
}

/** 출생 직후 인생 기록 첫 줄 */
export function birthStory(state: GameState): string {
  const ch = state.ch;
  const region = REGIONS.find((r) => r.id === ch.region)!;
  const sexText = ch.sex === 'M' ? '남자아이' : '여자아이';
  const wealthText = ['', '빠듯한', '넉넉하지 않은', '평범한', '여유 있는', '부유한', '재벌가의'][ch.family.wealth];
  const parents =
    ch.family.type === 'facility'
      ? '보육원 앞에 놓인 바구니에서 발견됐다.'
      : ch.family.type === 'grandparents'
        ? '부모 대신 할머니 품에 안겼다.'
        : ch.family.type === 'single_parent'
          ? '엄마 혼자 키우는 집이다.'
          : '';
  const siblings = ch.npcs.filter((n) => n.role === 'sibling');
  const twin = siblings.find((s) => s.twin);
  const older = siblings.filter((s) => !s.twin).map((s) => `${roleLabel(s, ch)} ${s.name}`);
  const sibText = [
    twin ? `쌍둥이 ${josa(twin.name, '과/와')} 함께 태어났다.` : '',
    older.length > 0 ? `위로 ${josa(older.join(', '), '이/가')} 있다.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return [
    `${state.year}년, ${region.name}에서 ${wealthText} 집 ${sexText}로 태어났다. 이름은 ${ch.surname}${ch.given}.`,
    parents,
    sibText,
  ]
    .filter(Boolean)
    .join(' ');
}
