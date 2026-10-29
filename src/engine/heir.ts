// 자녀로 이어하기: 죽은 사람의 자녀가 주인공이 되어 같은 세계, 같은 해에서 이어 산다.
// 자녀는 지금까지 NPC였으므로 나이에 맞는 학력·직업·병역·가족을 이때 채운다.
// 재산은 상속세를 떼고 배우자 1.5, 자녀 1의 비율(법정상속분)로 나눈다.

import { timePointsFor } from './activities';
import { jobSalary, meetsJob, takeJob, computePension } from './career';
import { JOBS, REGION_BY_ID, WORLD } from './data';
import { initDirector } from './director';
import { formatWon, josa } from './format';
import { healthTarget } from './health';
import { addFriend, alive, makeNpc, randomGiven, roleLabel, spouseOf } from './relations';
import { rngFor, type Rng } from './rng';
import { SAVE_VERSION } from './save';
import { netWorth } from './scope';
import { syncDerivedFlags } from './game';
import {
  PERSONALITY_KEYS,
  TALENT_KEYS,
  type Character,
  type Degree,
  type GameState,
  type Npc,
  type PersonalityKey,
  type TalentKey,
  type UnivTier,
} from './types';

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(x)));

const DEGREE_RANK: Record<Degree, number> = { none: 0, elementary: 1, middle: 2, high: 3, college: 4, university: 5 };

/** 상속세 누진 구간 (2026년 원, 물가만큼 늘린다) */
const TAX_BRACKETS: [number, number][] = [
  [100_000_000, 0.1],
  [500_000_000, 0.2],
  [1_000_000_000, 0.3],
  [3_000_000_000, 0.4],
  [Infinity, 0.5],
];

export function inheritanceTax(taxable: number, priceIndex: number): number {
  let tax = 0;
  let floor = 0;
  for (const [limit, rate] of TAX_BRACKETS) {
    const top = limit * priceIndex;
    if (taxable > floor) tax += (Math.min(taxable, top) - floor) * rate;
    floor = top;
  }
  return Math.round(tax);
}

export interface HeirOption {
  npc: Npc;
  age: number;
  label: string;
}

/** 이어 살 수 있는 자녀 (살아 있고 연락이 닿는) */
export function heirOptions(state: GameState): HeirOption[] {
  const ch = state.ch;
  return alive(ch, 'child')
    .sort((a, b) => a.birthYear - b.birthYear)
    .map((npc) => ({ npc, age: state.year - npc.birthYear, label: roleLabel(npc, ch) }));
}

interface Estate {
  /** 이 자녀가 받는 돈 */
  share: number;
  tax: number;
  renounced: boolean;
  /** 살아 있는 배우자 몫 (그 부모가 떠날 때 다시 상속된다) */
  spouseShare: number;
}

function divideEstate(prev: GameState): Estate {
  const pi = prev.world.economy.priceIndex;
  const gross = netWorth(prev);
  const spouse = spouseOf(prev.ch);
  const kids = alive(prev.ch, 'child').length;
  if (gross <= 0) return { share: 0, tax: 0, renounced: gross < 0, spouseShare: 0 };
  // 일괄공제 5억, 배우자가 있으면 배우자공제 5억 더
  const deduction = 500_000_000 * pi * (spouse ? 2 : 1);
  const tax = inheritanceTax(Math.max(0, gross - deduction), pi);
  const after = gross - tax;
  const units = (spouse ? 1.5 : 0) + Math.max(1, kids);
  return {
    share: Math.round(after / units),
    tax,
    renounced: false,
    spouseShare: spouse ? Math.round((after * 1.5) / units) : 0,
  };
}

function pickDegree(rng: Rng, wealth: number, intelligence: number): Degree {
  const uni = 35 + wealth * 6 + (intelligence - 50) * 0.6;
  return rng.weighted(
    [
      ['university', Math.max(5, uni)],
      ['college', 18],
      ['high', Math.max(8, 40 - wealth * 5)],
    ] as [Degree, number][],
    ([, w]) => w,
  )![0];
}

function tierFor(intelligence: number, rng: Rng): UnivTier {
  const x = intelligence + rng.normal(0, 10);
  return x >= 85 ? 'S' : x >= 72 ? 'A' : x >= 58 ? 'B' : x >= 45 ? 'C' : 'D';
}

function wealthFromEstate(estate2026: number): number {
  if (estate2026 >= 200_000_000_000) return 6;
  if (estate2026 >= 900_000_000) return 5;
  if (estate2026 >= 400_000_000) return 4;
  if (estate2026 >= 150_000_000) return 3;
  if (estate2026 >= 30_000_000) return 2;
  return 1;
}

/**
 * 자녀 한 명을 골라 새 판을 만든다. 같은 부모 인생, 같은 자녀를 고르면 언제나 같은 판이 나온다
 * (시드는 '부모 시드/자녀 순번').
 */
export function continueAsChild(prev: GameState, childId: string): GameState | null {
  const options = heirOptions(prev);
  const index = options.findIndex((o) => o.npc.id === childId);
  if (index < 0 || prev.ch.alive) return null;
  const child = options[index].npc;
  const parent = prev.ch;
  const year = prev.year;
  const age = year - child.birthYear;
  const seed = `${prev.seed}/${index + 1}`;
  const rng = rngFor(seed, 'heir');
  const pi = prev.world.economy.priceIndex;
  const estate = divideEstate(prev);
  const wealth = wealthFromEstate(netWorth(prev) / pi);

  const state = {
    v: SAVE_VERSION,
    seed,
    mode: prev.mode,
    startYear: child.birthYear,
    year,
    world: structuredClone(prev.world),
    director: initDirector(),
    phase: 'action',
    step: 'yearStart',
    queue: [],
    scheduled: [],
    points: { max: 0, left: 0 },
    actions: {},
    log: [],
    counts: {},
    lastAge: {},
    serial: prev.serial,
    lineage: { generation: (prev.lineage?.generation ?? 1) + 1, parentName: parent.surname + parent.given, rootSeed: prev.lineage?.rootSeed ?? prev.seed },
  } as unknown as GameState;

  const personality = {} as Record<PersonalityKey, number>;
  for (const k of PERSONALITY_KEYS) personality[k] = clamp(rng.normal(50, 15));
  const talentCount = rng.int(1, 3);
  const talents = (rng.shuffle([...TALENT_KEYS]).slice(0, talentCount) as TalentKey[]).map((key) => ({
    key,
    discovered: age >= 15 && rng.chance(0.5),
  }));

  const spouseOfParent = spouseOf(parent);
  const exOfParent = parent.npcs.find((n) => n.role === 'ex' && n.alive && !n.missing);
  const otherParent = spouseOfParent ?? exOfParent;
  const grandparents = parent.npcs.filter((n) => (n.role === 'mother' || n.role === 'father') && n.alive && !n.missing);
  const minor = age < 19;
  const familyType = otherParent ? 'single_parent' : minor ? (grandparents.length > 0 ? 'grandparents' : 'facility') : 'two_parent';

  const ch: Character = {
    surname: child.name.slice(0, 1),
    given: child.name.slice(1),
    sex: child.sex,
    birthYear: child.birthYear,
    birthRegion: parent.region,
    region: parent.region,
    age,
    alive: true,
    stats: {
      health: clamp(healthTarget(age) + rng.normal(0, 6)),
      stamina: clamp(rng.normal(55 - Math.max(0, age - 40) * 0.6, 10)),
      intelligence: clamp((parent.stats.intelligence + 50) / 2 + rng.normal(0, 10)),
      looks: clamp((parent.stats.looks + 50) / 2 + rng.normal(0, 10)),
      sociability: clamp(40 + personality.extraversion * 0.25 + rng.normal(0, 8)),
      happiness: clamp(rng.normal(48, 8)),
    },
    hidden: { morality: clamp(rng.normal(55, 12)), mental: clamp(rng.normal(50, 15)), luck: rng.int(30, 70) },
    state: { stress: 35, reputation: clamp(5 + parent.state.reputation * 0.25) },
    personality,
    talents,
    traits: [],
    flags: {},
    res: { cash: estate.share, debt: 0, stocks: 0, coins: 0, realEstate: 0, network: clamp(10 + parent.res.network * 0.2) },
    family: {
      type: familyType,
      wealth,
      parentsMarried: false,
      marriageQuality: 50,
      parentingStyle: 'authoritative',
      estate: Math.round(estate.spouseShare / pi),
      hiddenDebt: 0,
      livesWithParents: minor && familyType !== 'facility',
    },
    npcs: [],
    edu: { status: 'none', grade: 50, studyThisYear: 0, highStudy: 0, degree: 'none' },
    career: { salary: 0, years: 0, totalYears: 0, avgSalary: 0, raise: 1, retired: false, pension: 0, history: [], appliedThisYear: [] },
    military: { status: 'none' },
    legal: { convictions: 0 },
  };
  state.ch = ch;
  if (familyType === 'facility') ch.flags.raised_in_facility = { since: age };
  if (familyType === 'grandparents') ch.flags.raised_by_grandparents = { since: age };

  // 가족: 떠난 부모, 남은 부모, 형제자매, 조부모(부모의 부모)
  const parentRole = parent.sex === 'M' ? 'father' : 'mother';
  ch.npcs.push({
    id: `p${prev.serial}`,
    name: parent.surname + parent.given,
    sex: parent.sex,
    birthYear: parent.birthYear,
    role: parentRole,
    alive: false,
    deathYear: year,
    deathCause: parent.death?.cause,
    closeness: child.closeness,
    health: 0,
  });
  if (otherParent) ch.npcs.push({ ...otherParent, role: otherParent.sex === 'M' ? 'father' : 'mother', since: undefined, closeness: clamp(otherParent === exOfParent ? 40 : 70) });
  for (const sib of parent.npcs.filter((n) => n.role === 'child' && n.id !== child.id)) {
    ch.npcs.push({ ...sib, role: 'sibling', closeness: clamp(rng.normal(60, 15)) });
  }
  for (const g of grandparents) ch.npcs.push({ ...g, role: 'grandparent', closeness: clamp(rng.normal(65, 12)) });

  fillSchoolAndWork(state, rng, wealth);
  fillOwnFamily(state, rng);
  for (let i = rng.int(1, 3); i > 0; i--) addFriend(state, rng);

  const parentLabel = parentRole === 'father' ? '아버지' : '어머니';
  const region = REGION_BY_ID.get(ch.region)?.name ?? '';
  const money = estate.renounced
    ? '빚이 재산보다 많아 상속을 포기했다.'
    : estate.share > 0
      ? `${estate.tax > 0 ? `상속세 ${josa(formatWon(Math.round(estate.tax / 10_000) * 10_000), '을/를')} 내고` : '상속세 없이'} ${josa(formatWon(Math.round(estate.share / 10_000) * 10_000), '을/를')} 물려받았다.`
      : '물려받은 재산은 없다.';
  state.log.push({
    year,
    age,
    kind: 'birth',
    text: `${year}년, ${parentLabel} ${parent.surname + parent.given}의 장례를 치렀다. ${josa(ch.surname + ch.given, '은/는')} ${age}세, ${region}에 산다. ${money}`,
    impact: 0,
  });

  const max = timePointsFor(state);
  state.points = { max, left: max };
  syncDerivedFlags(state);
  return state;
}

/** 나이에 맞는 학교·병역·직업 */
function fillSchoolAndWork(state: GameState, rng: Rng, wealth: number): void {
  const ch = state.ch;
  const age = ch.age;
  const edu = ch.edu;
  if (age < 3) edu.status = 'none';
  else if (age <= 6) edu.status = 'kindergarten';
  else if (age <= 12) edu.status = 'elementary';
  else if (age <= 15) {
    edu.status = 'middle';
    edu.degree = 'elementary';
  } else if (age <= 18) {
    edu.status = 'high';
    edu.degree = 'middle';
    edu.highType = rng.chance(0.82) ? 'general' : 'vocational';
  } else {
    const degree = pickDegree(rng, wealth, ch.stats.intelligence);
    if (degree === 'university') {
      const tier = tierFor(ch.stats.intelligence, rng);
      const startAge = 19 + (rng.chance(0.2) ? 1 : 0);
      edu.univ = { name: rng.pick(WORLD.universities[tier]), tier, startAge, years: 4 };
      if (age < startAge + 4) {
        edu.status = 'university';
        edu.degree = 'high';
      } else {
        edu.status = 'graduated';
        edu.degree = 'university';
      }
    } else {
      edu.status = 'graduated';
      edu.degree = degree;
    }
    edu.highType = rng.chance(0.82) ? 'general' : 'vocational';
  }
  if (['elementary', 'middle', 'high'].includes(edu.status)) edu.grade = clamp(ch.stats.intelligence + rng.normal(0, 12));

  // 병역: 19세 판정검사 전이면 그대로, 그 뒤면 입영 대기나 전역
  if (ch.sex === 'M' && age >= 19) {
    if (age >= 22) {
      if (rng.chance(0.94)) {
        ch.military = { status: 'done', grade: rng.int(1, 3), branch: 'army', enlistAge: 20, dischargeAge: 22 };
        ch.flags.military_done = { since: 22 };
      } else ch.military = { status: 'exempt', grade: 5 };
    } else {
      ch.military = { status: 'pending', grade: rng.int(1, 3), branch: 'army', enlistAge: age + 1 };
    }
  }

  // 직업: 학교를 마친 어른은 대부분 일하고 있다
  const pi = state.world.economy.priceIndex;
  if (age >= 23 && age < 60 && edu.status !== 'university' && rng.chance(0.8)) {
    // 학력에 맞는 일을 더 자주 고른다 (대졸이 편의점 계산대에 서는 경우는 드물다)
    const jobs = JOBS.filter((j) => j.listed && meetsJob(state, j));
    if (jobs.length > 0) {
      const mine = DEGREE_RANK[edu.degree];
      const job = rng.weighted(jobs, (j) => (DEGREE_RANK[j.minDegree] === mine ? 4 : mine - DEGREE_RANK[j.minDegree] >= 2 ? 0.5 : 1))!;
      takeJob(state, job.id);
      const years = rng.int(0, Math.max(0, Math.min(age - 23, 30)));
      const c = ch.career;
      c.years = years;
      c.totalYears = years + rng.int(0, 3);
      c.salary = jobSalary(job, years, pi, 1);
      c.avgSalary = Math.round(c.salary * 0.85);
      c.history[c.history.length - 1].fromAge = age - years;
    }
  } else if (age >= 60) {
    const c = ch.career;
    c.totalYears = rng.int(15, 35);
    c.avgSalary = Math.round(rng.float(25_000_000, 60_000_000) * pi);
    if (age >= 65) {
      c.retired = true;
      c.pension = computePension(state);
    }
  }
}

/** 어른이면 나이에 맞게 배우자와 아이가 있을 수 있다 */
function fillOwnFamily(state: GameState, rng: Rng): void {
  const ch = state.ch;
  const age = ch.age;
  const pMarried = age < 27 ? 0.05 : age < 32 ? 0.35 : age < 40 ? 0.6 : 0.72;
  if (!rng.chance(pMarried)) return;
  const sex = ch.sex === 'M' ? 'F' : 'M';
  const married = rng.int(26, Math.min(age, 40));
  const spouse = makeNpc(state, rng, 'spouse', sex, ch.birthYear + rng.int(-3, 3), {
    closeness: clamp(rng.normal(65, 12)),
    health: clamp(healthTarget(age) + rng.normal(0, 6)),
    since: married,
  });
  ch.npcs.push(spouse);
  ch.family.livesWithParents = false;
  const kids = rng.weighted(
    [
      [0, 28],
      [1, 37],
      [2, 30],
      [3, 5],
    ] as const,
    ([, w]) => w,
  )![0];
  const fatherSurname = ch.sex === 'M' ? ch.surname : spouse.name.slice(0, 1);
  for (let i = 0; i < kids; i++) {
    const kidAge = age - married - 1 - i * rng.int(2, 4);
    if (kidAge < 0) break;
    const kSex = rng.chance(105 / 205) ? 'M' : 'F';
    const kid = makeNpc(state, rng, 'child', kSex, state.year - kidAge, { surname: fatherSurname, closeness: clamp(rng.normal(75, 10)), health: 88 });
    // 한집에 같은 이름이 둘이면 이름을 다시 짓는다
    for (let t = 0; t < 5 && ch.npcs.some((n) => n.name === kid.name); t++) kid.name = fatherSurname + randomGiven(rng, kSex, kid.birthYear);
    ch.npcs.push(kid);
  }
}
