// 조건식이 읽는 값들. 사건 JSON의 trigger.if, modifiers, choices.if 에서
// 'stats.intelligence', 'family.siblings', 'world.economy' 처럼 쓴다.

import { JOB_BY_ID, REGION_BY_ID } from './data';
import { familySupport, alive, npcAge, partnerOf, spouseOf } from './relations';
import { ELITE_HIGH, stageOf } from './format';
import { isPresidentialYear } from './world';
import type { Scope } from './conditions';
import type { GameState } from './types';
import { TALENT_KEYS } from './types';

export function netWorth(state: GameState): number {
  const r = state.ch.res;
  return r.cash + r.stocks + r.coins + r.realEstate - r.debt;
}

/** 올해 들어오는 돈 (연봉 + 연금, 세전) */
export function annualIncome(state: GameState): number {
  const c = state.ch.career;
  const pension = state.ch.age >= 65 ? Math.round(c.pension * state.world.economy.priceIndex) : 0;
  return (c.jobId ? c.salary : 0) + pension;
}

/** 지금 사는 지역의 집값 (2026년 지역 평균 × 집값지수) */
export function homePrice(state: GameState): number {
  const region = REGION_BY_ID.get(state.ch.region);
  return Math.round(((region?.homePrice ?? 400_000_000) * state.world.economy.housingIndex) / 100);
}

export function inPrison(state: GameState): boolean {
  const p = state.ch.legal.prisonUntil;
  return p !== undefined && state.ch.age < p;
}

export function buildScope(state: GameState, ctx: Record<string, string> = {}): Scope {
  const ch = state.ch;
  const year = state.year;
  const flags: Record<string, boolean> = {};
  for (const k of Object.keys(ch.flags)) flags[k] = true;

  const talents: Record<string, unknown> = {};
  const found: Record<string, boolean> = {};
  let hiddenCount = 0;
  for (const key of TALENT_KEYS) {
    const t = ch.talents.find((x) => x.key === key);
    talents[key] = Boolean(t);
    found[key] = Boolean(t?.discovered);
    if (t && !t.discovered) hiddenCount++;
  }
  talents.hiddenCount = hiddenCount;

  const traits: Record<string, boolean> = {};
  for (const t of ch.traits) traits[t] = true;

  const mother = alive(ch, 'mother')[0];
  const father = alive(ch, 'father')[0];
  const parentAges = [mother, father].filter(Boolean).map((p) => npcAge(p!, year));
  const partner = partnerOf(ch);
  const spouse = spouseOf(ch);
  const femaleAge = ch.sex === 'F' ? ch.age : spouse ? npcAge(spouse, year) : 99;
  const job = ch.career.jobId ? JOB_BY_ID.get(ch.career.jobId) : undefined;
  const region = REGION_BY_ID.get(ch.region);
  const csat = ch.edu.csat;
  const mil = ch.military;
  const legal = ch.legal;

  return {
    age: ch.age,
    sex: ch.sex,
    stage: stageOf(ch.age),
    year,
    mode: state.mode,
    stats: { ...ch.stats },
    hidden: { ...ch.hidden },
    state: { ...ch.state },
    personality: { ...ch.personality },
    money: {
      ...ch.res,
      netWorth: netWorth(state),
      income: annualIncome(state),
    },
    flags,
    talents,
    found,
    traits,
    family: {
      wealth: ch.family.wealth,
      type: ch.family.type,
      style: ch.family.parentingStyle,
      parentsMarried: ch.family.parentsMarried,
      marriageQuality: ch.family.marriageQuality,
      livesWithParents: ch.family.livesWithParents,
      siblings: alive(ch, 'sibling').length,
      parentsAlive: parentAges.length,
      motherAlive: Boolean(mother),
      fatherAlive: Boolean(father),
      motherAge: mother ? npcAge(mother, year) : 0,
      fatherAge: father ? npcAge(father, year) : 0,
      parentMaxAge: parentAges.length ? Math.max(...parentAges) : 0,
      friends: alive(ch, 'friend').length,
      hasPartner: Boolean(partner),
      partnerYears: partner && partner.since !== undefined ? ch.age - partner.since : 0,
      married: Boolean(spouse),
      marriedYears: spouse && spouse.since !== undefined ? ch.age - spouse.since : 0,
      spouseCloseness: spouse ? spouse.closeness : 0,
      children: alive(ch, 'child').length,
      fertile: Boolean(spouse) && femaleAge <= 44,
      support: familySupport(ch),
      estate: ch.family.estate,
      hiddenDebt: ch.family.hiddenDebt,
    },
    edu: {
      status: ch.edu.status,
      grade: ch.edu.grade,
      degree: ch.edu.degree,
      highType: ch.edu.highType ?? 'none',
      elite: Boolean(ch.edu.highType && ELITE_HIGH.includes(ch.edu.highType)),
      // 수능 최저: 수능을 봤다면 5등급 안이어야 수시 합격이 유지된다
      earlyAdmitted: Boolean(ch.edu.earlyAdmit && (!csat || csat.grade <= 5)),
      enrolled: ['kindergarten', 'elementary', 'middle', 'high', 'university'].includes(ch.edu.status),
      csatJustTaken: Boolean(csat && csat.age === ch.age - 1),
      canEnroll: Boolean(csat && csat.age === ch.age - 1 && csat.tier),
      csatGrade: csat ? csat.grade : 0,
      tier: ch.edu.univ?.tier ?? 'none',
      graduateNow: Boolean(
        ch.edu.status === 'university' && ch.edu.univ && ch.age >= ch.edu.univ.startAge + ch.edu.univ.years && !ch.edu.onLeave,
      ),
    },
    job: {
      id: ch.career.jobId ?? 'none',
      employed: Boolean(ch.career.jobId),
      salary: ch.career.salary,
      years: ch.career.years,
      business: Boolean(ch.career.business),
      retired: ch.career.retired,
      layoffRisk: job ? job.layoffRisk : 0,
      stress: job ? job.stress : 0,
      retireAge: job ? job.retireAge : 0,
      atRetireAge: Boolean(job && !ch.career.business && ch.age >= job.retireAge),
    },
    military: {
      status: mil.status,
      grade: mil.grade ?? 0,
      branch: mil.branch ?? 'none',
      serving: mil.status === 'serving',
      enlistNow: mil.status === 'pending' && mil.enlistAge === ch.age,
      dischargeNow: mil.status === 'serving' && mil.dischargeAge === ch.age,
      unitMood: mil.unitMood ?? 50,
    },
    legal: {
      convictions: legal.convictions,
      inPrison: inPrison(state),
      onProbation: legal.probationUntil !== undefined && ch.age < legal.probationUntil,
      releaseNow: legal.prisonUntil !== undefined && ch.age === legal.prisonUntil,
    },
    world: {
      economy: state.world.economy.phase,
      tension: state.world.tension,
      unemployment: state.world.economy.unemployment,
      interest: state.world.economy.interest,
      automation: state.world.automation,
      pandemic: state.world.pandemic > 0,
      pandemicStart: Boolean(state.world.news.pandemicStart),
      electionYear: isPresidentialYear(year),
      news: { ...state.world.news },
    },
    director: { tension: state.director.tension, pace: state.director.pace },
    region: { id: ch.region, metro: Boolean(region?.metro) },
    ctx,
  };
}
