// 자녀로 이어하기: 죽은 사람의 자녀가 주인공이 되어 같은 세계, 같은 해에서 이어 산다.
// 자녀는 지금까지 NPC였다. 이미 알려진 사실(이름·성별·생년·건강·부모와의 친밀도, 부모의 인생에 기록된
// 가족 관계)은 그대로 옮기고, 기록되지 않은 과거(학력·직업·병역·자기 가족)만 나이와 시점이 맞는 범위에서 채운다.
// 재산은 상속세를 떼고 배우자 1.5, 자녀 1의 비율(법정상속분)로 나눈다.
//
// 돈의 단위는 career.ts와 같다. 연봉(salary)·현금·상속분은 그해 명목액, 평균 연봉(avgSalary)·연금(pension)·
// family.estate는 2026년 원 기준액이고 쓸 때 물가지수를 한 번 곱한다.
// 이 규칙을 지키기 전에 이어 한 저장은 그때의 물가지수가 남아 있지 않아 바로잡을 근거가 없으므로 그대로 둔다 (R-007).
// 나이·혼인 시점 규칙(R-006) 전에 이어 한 저장의 불가능한 가족 기록은 불러올 때 save.ts가 바로잡는다.

import { timePointsFor } from './activities';
import { jobSalary, meetsJob, takeJob, computePension } from './career';
import type { JobDef } from './schema';
import { JOBS, REGION_BY_ID, WORLD } from './data';
import { initDirector } from './director';
import { formatWon, josa } from './format';
import { healthTarget } from './health';
import { addFriend, alive, makeNpc, randomGiven, roleLabel, spouseOf } from './relations';
import { rngFor, type Rng } from './rng';
import { SAVE_VERSION } from './save';
import { netWorth } from './scope';
import { syncDerivedFlags } from './game';
import { currentType, payFactor, standardType } from './work';
import {
  PERSONALITY_KEYS,
  TALENT_KEYS,
  type Character,
  type Degree,
  type FamilyType,
  type GameState,
  type Npc,
  type NpcRole,
  type PersonalityKey,
  type Sex,
  type TalentKey,
  type UnivTier,
} from './types';

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(x)));

const DEGREE_RANK: Record<Degree, number> = { none: 0, elementary: 1, middle: 2, high: 3, college: 4, university: 5 };

/** 성년 나이. 이보다 어리면 결혼한 적도, 배우자도, 아이도 없다 */
const ADULT_AGE = 19;
/** 아이를 낳는 여성의 마지막 나이 (scope.ts의 family.fertile과 같다) */
const LAST_BIRTH_AGE = 44;
/** 평균 초혼 나이 (2024 인구동향, 시뮬레이터 보정표와 같은 값) */
const FIRST_MARRIAGE_AGE: Record<Sex, number> = { M: 33.9, F: 31.6 };
/** 어린이집·유치원에 다닐 나이부터 친구가 있다 */
const FRIEND_AGE = 3;

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

/** 아이의 다른 친부모가 부모의 기록에 남는 자리: 배우자, 이혼한 전 배우자, 아직 결혼하지 않은 연인 */
const OTHER_PARENT_ROLES: NpcRole[] = ['spouse', 'ex', 'partner'];

/**
 * 이 아이를 함께 낳은 다른 친부모 (세상을 떠났거나 생사 불명일 수 있다).
 * 아이가 태어날 때 남긴 인물 ID(otherParentId)를 먼저 쓴다. 그 사람은 그때의 배우자나 연인이었고(혼인신고를 미루고
 * 낳기도 한다), 지금은 배우자·전 배우자·연인 가운데 하나다. null(함께 낳은 사람이 없었다)이거나 헤어진 연인처럼
 * 기록에서 사라졌으면 모른다. 이때 혼인 시점으로 짐작하면 다른 사람을 부모로 세우게 되므로 짐작하지 않는다.
 */
function birthPartner(parent: Character, child: Npc): Npc | undefined {
  const id = child.otherParentId;
  if (id === undefined) return guessBirthPartner(parent, child);
  return parent.npcs.find((n) => n.id === id && OTHER_PARENT_ROLES.includes(n.role));
}

/**
 * ID를 남기기 전에 태어난 아이(옛 저장): 혼인 시점으로 짐작한다. 배우자·전 배우자의 since는 혼인한 때 부모의
 * 나이이고, 혼인은 겹치지 않는다.
 * 1. 아이가 태어난 나이까지 시작된 혼인 가운데 가장 늦은 것이 그때의 혼인이다. 다만 상대가 아이가 태어나기 전해보다
 *    먼저 세상을 떠났다면 사별한 뒤에 낳은 아이다.
 * 2. 혼인 중에 태어나지 않았다면 혼인신고를 미루고 낳은 아이다. 연인은 한 번에 한 명이고 결혼은 그 연인과만 하므로,
 *    그 친부모와 나중에 혼인했다면 태어난 뒤 첫 혼인 상대다 (대개 지금의 배우자). 그런 혼인이 없으면 모른다.
 */
function guessBirthPartner(parent: Character, child: Npc): Npc | undefined {
  const bornAt = child.birthYear - parent.birthYear;
  const marriages = parent.npcs
    .filter((n) => (n.role === 'spouse' || n.role === 'ex') && n.since !== undefined)
    .sort((a, b) => a.since! - b.since!);
  const during = marriages.filter((n) => n.since! <= bornAt).pop();
  const widowedBefore = during !== undefined && !during.alive && during.deathYear !== undefined && during.deathYear < child.birthYear - 1;
  if (during && !widowedBefore) return during;
  return marriages.find((n) => n.since! > bornAt);
}

/** 부모 쪽에서 이어받는 가족 */
interface ParentSide {
  /** 이 아이를 낳은 다른 부모 (세상을 떠났거나 생사 불명일 수 있다) */
  other?: Npc;
  /** 그 부모가 살아 있고 연락이 닿으면 보호자가 된다 */
  guardian?: Npc;
  /** 아이가 태어난 뒤 부모와 결혼한 배우자 (계부모). 엄마·아빠로 넣지 않는다 */
  step?: Npc;
  /** 부모의 부모 (세상을 떠난 분도 기록으로 남긴다) */
  grandparents: Npc[];
}

function parentSide(parent: Character, child: Npc): ParentSide {
  const other = birthPartner(parent, child);
  const spouse = spouseOf(parent);
  return {
    other,
    guardian: other && other.alive && !other.missing ? other : undefined,
    step: spouse && spouse !== other ? spouse : undefined,
    grandparents: parent.npcs.filter((n) => n.role === 'mother' || n.role === 'father'),
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

  // 미성년자는 살아 있는 친부모 → 조부모 → 보육원 순으로 맡는다. 계부모는 친권자가 아니다
  const kin = parentSide(parent, child);
  const minor = age < ADULT_AGE;
  const livingGrandparents = kin.grandparents.filter((n) => n.alive && !n.missing);
  const familyType: FamilyType = kin.guardian ? 'single_parent' : minor ? (livingGrandparents.length > 0 ? 'grandparents' : 'facility') : 'two_parent';

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
      // 건강은 NPC로 살아온 값을 그대로 이어받는다
      health: clamp(child.health),
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
      // 살아 있는 친부모가 고인의 배우자면 그 몫은 언젠가 다시 이 아이에게 온다. 계부모의 몫은 오지 않는다
      estate: kin.guardian && kin.guardian === spouseOf(parent) ? Math.round(estate.spouseShare / pi) : 0,
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
  // 부모를 잃은 해: 게임 안에서 부모가 죽을 때와 같은 표시
  ch.flags.parent_died_recent = { since: age, until: age + 1 };

  // 가족: 떠난 부모, 이 아이를 낳은 다른 부모, 형제자매(부모의 다른 자녀), 조부모(부모의 부모)
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
  if (kin.other) {
    ch.npcs.push({ ...kin.other, role: kin.other.sex === 'M' ? 'father' : 'mother', since: undefined, closeness: clamp(kin.other.role === 'ex' ? 40 : 70) });
  }
  // 형제자매의 다른 친부모 ID는 고인의 자녀 기록이므로 옮기지 않는다
  for (const sib of parent.npcs.filter((n) => n.role === 'child' && n.id !== child.id)) {
    ch.npcs.push({ ...sib, role: 'sibling', otherParentId: undefined, closeness: clamp(rng.normal(60, 15)) });
  }
  for (const g of kin.grandparents) ch.npcs.push({ ...g, role: 'grandparent', closeness: clamp(rng.normal(65, 12)) });

  fillSchoolAndWork(state, rng, wealth);
  fillOwnFamily(state, rng);
  if (age >= FRIEND_AGE) for (let i = rng.int(1, 3); i > 0; i--) addFriend(state, rng);

  const parentLabel = parentRole === 'father' ? '아버지' : '어머니';
  const region = REGION_BY_ID.get(ch.region)?.name ?? '';
  const money = estate.renounced
    ? '빚이 재산보다 많아 상속을 포기했다.'
    : estate.share > 0
      ? `${estate.tax > 0 ? `상속세 ${josa(formatWon(Math.round(estate.tax / 10_000) * 10_000), '을/를')} 내고` : '상속세 없이'} ${josa(formatWon(Math.round(estate.share / 10_000) * 10_000), '을/를')} 물려받았다.`
      : '물려받은 재산은 없다.';
  const stepLine = kin.step
    ? `${josa(parentLabel, '와/과')} 재혼한 ${kin.step.sex === 'F' ? '새어머니' : '새아버지'} ${kin.step.name}도 장례를 함께 치렀다.`
    : '';
  state.log.push({
    year,
    age,
    kind: 'birth',
    text: [
      `${year}년, ${parentLabel} ${parent.surname + parent.given}의 장례를 치렀다.`,
      stepLine,
      `${josa(ch.surname + ch.given, '은/는')} ${age}세, ${region}에 산다.`,
      minor ? guardianLine(ch, kin.guardian) : '',
      money,
    ]
      .filter(Boolean)
      .join(' '),
    impact: 0,
  });

  const max = timePointsFor(state);
  state.points = { max, left: max };
  syncDerivedFlags(state);
  return state;
}

/** 미성년 후계자를 누가 돌보는가 */
function guardianLine(ch: Character, guardian: Npc | undefined): string {
  if (ch.family.type === 'facility') return '돌봐 줄 가족이 없어 보육원에서 지낸다.';
  const g = guardian ? ch.npcs.find((n) => n.id === guardian.id) : alive(ch, 'grandparent')[0];
  return g ? `${roleLabel(g, ch)} ${josa(g.name, '이/가')} 키운다.` : '';
}

/**
 * 후계자가 지금 하고 있을 법한 일: 공고에 나오는 직업 중 공고 자격(meetsJob: 임용 자격 + 선발 기준)을 갖춘 것.
 * 판결 결격·면허·학력·나이는 다른 진입 경로와 같은 규칙이다 (R-018). 실제 배정은 takeJob이 다시 판정한다
 */
export function heirJobCandidates(state: GameState): JobDef[] {
  return JOBS.filter((j) => j.listed && meetsJob(state, j));
}

/** 나이에 맞는 학교·병역·직업. 지금보다 늦게 시작하는 기록은 만들지 않는다 */
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
      // 재수하면 20세에 입학한다. 아직 그 나이가 안 됐으면 올해 입학한 것이다
      const startAge = Math.min(age, 19 + (rng.chance(0.2) ? 1 : 0));
      edu.univ = { name: rng.pick(WORLD.universities[tier]), tier, startAge, years: 4 };
      if (age < startAge + 4) {
        edu.status = 'university';
        edu.degree = 'high';
      } else {
        edu.status = 'graduated';
        edu.degree = 'university';
      }
    } else if (degree === 'college' && age < 21) {
      // 전문대(2년제, D등급)는 21세에 졸업한다. 그 전이면 다니는 중이다
      edu.univ = { name: rng.pick(WORLD.universities.D), tier: 'D', startAge: 19, years: 2 };
      edu.status = 'university';
      edu.degree = 'high';
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

  // 직업: 학교를 마친 어른은 대부분 일하고 있다.
  // 연봉은 올해 명목액, 평균 연봉과 연금은 2026년 원이다 (career.ts의 yearlyEarnings·computePension과 같은 단위)
  const pi = state.world.economy.priceIndex;
  if (age >= 23 && age < 60 && edu.status !== 'university' && rng.chance(0.8)) {
    // 학력에 맞는 일을 더 자주 고른다 (대졸이 편의점 계산대에 서는 경우는 드물다)
    const jobs = heirJobCandidates(state);
    if (jobs.length > 0) {
      const mine = DEGREE_RANK[edu.degree];
      const pick = rng.weighted(jobs, (j) => (DEGREE_RANK[j.minDegree] === mine ? 4 : mine - DEGREE_RANK[j.minDegree] >= 2 ? 0.5 : 1))!;
      // 후계자도 다른 경로와 같은 임용 자격을 takeJob 안에서 받는다 (R-018). 걸리면 일 없이 시작한다
      const job = takeJob(state, pick.id);
      // 근속을 거슬러 잡아도 그 직업의 최소 나이 전에 들어간 기록은 만들지 않는다 (임용 자격의 나이 조건, R-018)
      const years = rng.int(0, Math.max(0, Math.min(age - 23, age - pick.minAge, 30)));
      if (job) {
        const c = ch.career;
        c.years = years;
        c.totalYears = years + rng.int(0, 3);
        // 고용 형태의 몫까지 반영한 2026년 원 연봉에 물가를 곱한다 (형태 몫을 빼면 계약직·시간제도 표준 연봉이 된다)
        const real = jobSalary(job, years, 1, 1) * payFactor(job, currentType(state) ?? standardType(job));
        c.salary = Math.round(real * pi);
        c.avgSalary = Math.round(real * 0.85);
        c.history[c.history.length - 1].fromAge = age - years;
      }
    }
  } else if (age >= 60) {
    const c = ch.career;
    c.totalYears = rng.int(15, 35);
    c.avgSalary = Math.round(rng.float(25_000_000, 60_000_000));
    if (age >= 65) {
      c.retired = true;
      c.pension = computePension(state);
    }
  }
}

/** 이 나이에 배우자가 있을 확률. 미성년자는 0, 27세 이상은 예전 값 그대로 */
function marriedChance(age: number): number {
  if (age < ADULT_AGE) return 0;
  if (age < 23) return 0.02;
  if (age < 27) return 0.08;
  if (age < 32) return 0.35;
  if (age < 40) return 0.6;
  return 0.72;
}

/** 결혼한 나이: 성년부터 지금 나이 사이에서 평균 초혼 나이 근처를 더 자주 고른다 */
function drawMarriageAge(rng: Rng, sex: Sex, age: number): number {
  const ages: number[] = [];
  for (let a = ADULT_AGE; a <= age; a++) ages.push(a);
  const mean = FIRST_MARRIAGE_AGE[sex];
  return rng.weighted(ages, (a) => Math.exp(-(((a - mean) / 4.5) ** 2) / 2))!;
}

/**
 * 어른이면 나이에 맞게 배우자와 아이가 있을 수 있다. 기록이 없는 과거이므로 다음 범위 안에서만 채운다:
 * 결혼은 성년부터 지금 나이 사이, 상대도 결혼할 때 성년, 아이는 결혼한 다음 해부터 올해 사이에
 * 어머니가 44세 이하일 때 태어난다. 미성년자에게는 배우자도 아이도 없다.
 */
function fillOwnFamily(state: GameState, rng: Rng): void {
  const ch = state.ch;
  const age = ch.age;
  if (age < ADULT_AGE || !rng.chance(marriedChance(age))) return;
  const married = drawMarriageAge(rng, ch.sex, age);
  const weddingYear = ch.birthYear + married;
  const sex: Sex = ch.sex === 'M' ? 'F' : 'M';
  // 나이 차는 연애를 시작할 때(startPartner)와 같은 분포. 다만 결혼할 때 상대도 성년이었다
  const spouseBirthYear = Math.min(ch.birthYear + Math.round(rng.normal(sex === 'F' ? 1.5 : -1.5, 3)), weddingYear - ADULT_AGE);
  const spouse = makeNpc(state, rng, 'spouse', sex, spouseBirthYear, {
    closeness: clamp(rng.normal(65, 12)),
    health: clamp(healthTarget(state.year - spouseBirthYear) + rng.normal(0, 6)),
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
  const motherBirthYear = ch.sex === 'F' ? ch.birthYear : spouse.birthYear;
  const taken = (name: string) => name === ch.surname + ch.given || ch.npcs.some((n) => n.name === name);
  // 첫째는 결혼한 다음 해, 동생들은 2~4살 터울
  let born = weddingYear + 1;
  for (let i = 0; i < kids; i++) {
    if (i > 0) born += rng.int(2, 4);
    if (born > state.year || born - motherBirthYear > LAST_BIRTH_AGE) break;
    const kSex = rng.chance(105 / 205) ? 'M' : 'F';
    const kid = makeNpc(state, rng, 'child', kSex, born, {
      surname: fatherSurname,
      closeness: clamp(rng.normal(75, 10)),
      health: clamp(healthTarget(state.year - born)),
      otherParentId: spouse.id,
    });
    // 한집에 같은 이름이 둘이면 이름을 다시 짓는다
    for (let t = 0; t < 5 && taken(kid.name); t++) kid.name = fatherSurname + randomGiven(rng, kSex, kid.birthYear);
    ch.npcs.push(kid);
  }
}
