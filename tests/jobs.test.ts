// 직업 확장 (U-001): 직업 정의·분류, 고용 형태별 소득과 계약, 실직→구직급여→복귀, 부업 충돌, 자격 재응시·갱신,
// 산재·체불, 저장/불러오기와 옛 저장의 직업 ID

import { describe, expect, it } from 'vitest';
import { timePointsFor } from '../src/engine/activities';
import { referencedPaths } from '../src/engine/conditions';
import { hireChance, jobOpenings, jobSalary, leaveJob, meetsJob, takeJob, yearlyEarnings } from '../src/engine/career';
import { EVENT_BY_ID, JOB_BY_ID, JOBS } from '../src/engine/data';
import { milestonesFor, presentCard } from '../src/engine/eventEngine';
import { applyForJob, choose, newGame, proceed, quitJob, syncDerivedFlags } from '../src/engine/game';
import { rngFor } from '../src/engine/rng';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import { buildScope } from '../src/engine/scope';
import type { Degree, EmploymentType, GameState } from '../src/engine/types';
import { EMPLOYMENT_TYPES, WORK_SCHEDULES } from '../src/engine/types';
import { validateData } from '../src/engine/validate';
import {
  benefitDays,
  currentType,
  FIELD_BY_ID,
  hasLicense,
  jobRequirements,
  JOB_FIELDS,
  ledgerOf,
  LICENSE_BY_ID,
  LICENSES,
  licensePassChance,
  offerFor,
  payFactor,
  schedulesClash,
  sideJobBlock,
  standardType,
  startTraining,
  studyLicense,
  takeSideJob,
  workOf,
} from '../src/engine/work';

/** 기존 20종 (저장된 게임이 가리키는 ID) */
const LEGACY = {
  convenience_store: '편의점 직원',
  delivery_rider: '배달 라이더',
  chef: '요리사',
  factory: '생산직',
  sme_office: '중소기업 사무직',
  sales: '영업직',
  large_corp: '대기업 사무직',
  developer: '개발자',
  nurse: '간호사',
  teacher: '교사',
  civil_servant: '9급 공무원',
  nco: '직업군인(부사관)',
  care_worker: '요양보호사',
  doctor: '의사',
  lawyer: '변호사',
  youtuber: '유튜버',
  entertainer: '연예인',
  self_employed: '자영업',
  public_tech: '공기업 기술직',
  athlete: '프로 운동선수',
} as const;

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** 그 나이의 학교를 마친 어른 (같은 시드면 능력치도 같다) */
function adult(seed: string, age = 30, degree: Degree = 'high'): GameState {
  const s = newGame({ seed, mode: 'reality', birthYear: 2026 });
  s.ch.age = age;
  s.year = s.ch.birthYear + age;
  s.world.year = s.year;
  s.ch.edu.status = 'graduated';
  s.ch.edu.degree = degree;
  s.ch.stats.health = 80;
  s.ch.res.cash = 30_000_000;
  s.points = { max: 4, left: 4 };
  return s;
}

/** 다음 나이로 (연말 결산의 돈 단계만: yearlyEarnings가 work.ts의 연말 처리를 부른다) */
function yearEnd(s: GameState): number {
  const got = yearlyEarnings(s, rngFor(s.seed, 'yearend', s.ch.age));
  // 기한이 지난 태그 정리 (game.ts의 연말 결산과 같은 규칙)
  for (const [id, f] of Object.entries(s.ch.flags)) if (f.until !== undefined && s.ch.age >= f.until) delete s.ch.flags[id];
  s.ch.age += 1;
  s.year += 1;
  s.world.year = s.year;
  s.ch.career.appliedThisYear = [];
  s.points = { max: 4, left: 4 };
  syncDerivedFlags(s);
  return got;
}

/** 이 직업을 원하는 고용 형태로 내미는 시드를 찾는다 (같은 시드면 늘 같은 형태) */
function seedWithOffer(prefix: string, jobId: string, type: EmploymentType, setup: (s: GameState) => void = () => {}): GameState {
  for (let i = 0; i < 400; i++) {
    const s = adult(`${prefix}-${i}`);
    setup(s);
    if (offerFor(s, JOB_BY_ID.get(jobId)!)?.type === type) return s;
  }
  throw new Error(`${jobId}를 ${type}로 내미는 시드가 없다`);
}

function grantLicense(s: GameState, id: string, age = s.ch.age): void {
  const lic = (workOf(s.ch).licenses ??= {});
  lic[id] = { tries: 1, lastTry: age, passed: age, renewAt: LICENSE_BY_ID.get(id)?.renew ? age + LICENSE_BY_ID.get(id)!.renew! : undefined };
}

// ── 데이터 ───────────────────────────────────────────────

describe('직업 정의: 분류·고용 형태·조건·근거', () => {
  it('기존 20종 ID와 이름이 그대로 있고, 새 정의가 150개 이상이다', () => {
    for (const [id, title] of Object.entries(LEGACY)) expect(JOB_BY_ID.get(id)?.title).toBe(title);
    const added = JOBS.filter((j) => !(j.id in LEGACY));
    expect(added.length).toBeGreaterThanOrEqual(150);
    expect(new Set(JOBS.map((j) => j.id)).size).toBe(JOBS.length);
  });

  it('17개 분야마다 8개 이상, 모든 직업에 KSCO 중분류·고용 형태·시간·근무 형태·산재 등급·연봉 근거가 있다', () => {
    expect(JOB_FIELDS).toHaveLength(17);
    for (const f of JOB_FIELDS) expect(JOBS.filter((j) => j.field === f.id).length, f.label).toBeGreaterThanOrEqual(8);
    for (const j of JOBS) {
      expect(FIELD_BY_ID.has(j.field ?? ''), j.id).toBe(true);
      expect(j.ksco, j.id).toMatch(/^([1-9][0-9]|A0)$/);
      const types = Object.keys(j.employment ?? {});
      expect(types.length, j.id).toBeGreaterThan(0);
      for (const t of types) expect(EMPLOYMENT_TYPES as readonly string[], j.id).toContain(t);
      for (const s of j.schedule ?? []) expect(WORK_SCHEDULES as readonly string[], j.id).toContain(s);
      expect(j.hours, j.id).toBeGreaterThan(0);
      expect(j.injury ?? -1, j.id).toBeGreaterThanOrEqual(0);
      expect(j.injury ?? 9, j.id).toBeLessThanOrEqual(4);
      expect(j.salary[0], j.id).toBeLessThanOrEqual(j.salary[1]);
      expect(j.source, j.id).toBeTruthy();
    }
  });

  it('면허·조건식 참조가 모두 실재한다 (조건식은 조건 범위에 있는 값만 읽는다)', () => {
    const scope = buildScope(adult('REQ-SCOPE')) as Record<string, unknown>;
    const known = (path: string[]) => {
      let cur: unknown = scope;
      for (const k of path) {
        if (cur === null || typeof cur !== 'object' || !(k in (cur as object))) return false;
        cur = (cur as Record<string, unknown>)[k];
      }
      return true;
    };
    for (const j of JOBS) {
      for (const id of [...(j.licenses ?? []), ...(j.prefers ?? [])]) expect(LICENSE_BY_ID.has(id), `${j.id} → ${id}`).toBe(true);
      if (!j.req) continue;
      for (const p of referencedPaths(j.req)) {
        expect(known(p), `${j.id}: ${j.req}`).toBe(true);
        // 공고 캐시(career.ts openingsKey)는 능력치만 열쇠에 넣는다: 직업 조건식은 능력치만 읽어야 한다
        expect(p[0], `${j.id}: ${j.req}`).toBe('stats');
      }
    }
    for (const l of LICENSES) for (const n of l.needs ?? []) expect(LICENSE_BY_ID.has(n), `${l.id} → ${n}`).toBe(true);
  });

  it('이름만 다른 직업으로 수를 부풀리지 않았다: 엔진이 쓰는 성질 조합이 150가지 이상 서로 다르다', () => {
    const profile = (j: (typeof JOBS)[number]) =>
      JSON.stringify([
        j.field,
        Object.keys(j.employment ?? {}).sort(),
        Math.round((j.hours ?? 40) / 5),
        [...(j.schedule ?? [])].sort(),
        j.injury,
        j.minDegree,
        j.licenses ?? [],
        j.minExp ?? 0,
        Math.round(j.salary[0] / 5_000_000),
        Boolean(j.customer),
      ]);
    expect(new Set(JOBS.map(profile)).size).toBeGreaterThanOrEqual(150);
  });

  it('일터 사건은 데이터 검증을 통과하고 직업마다 따로 쓰지 않았다 (job.id 조건 없이 성질로 고른다)', () => {
    const issues = validateData().filter((i) => i.where.startsWith('events/work.json') && i.level === 'error');
    expect(issues).toEqual([]);
    const work = [...EVENT_BY_ID.values()].filter((e) => e.id.startsWith('work_'));
    expect(work.length).toBeGreaterThanOrEqual(20);
    // 자동화 사건만 기존 ai_restructuring과 겹치지 않게 네 직업을 뺀다
    const byId = work.filter((e) => /job\.id ==/.test(e.trigger?.if ?? ''));
    expect(byId).toEqual([]);
  });
});

// ── 고용 형태 ────────────────────────────────────────────

describe('고용 형태가 소득·계약·시간에 실제로 다르게 작동한다', () => {
  it('같은 직업도 형태에 따라 받는 몫이 다르다 (표준 = 1, 파견 < 계약 < 정규, 시간제는 시간 비례)', () => {
    const factory = JOB_BY_ID.get('factory')!;
    expect(standardType(factory)).toBe('regular');
    expect(payFactor(factory, 'regular')).toBe(1);
    expect(payFactor(factory, 'contract')).toBeCloseTo(0.9);
    expect(payFactor(factory, 'dispatch')).toBeCloseTo(0.85);
    const store = JOB_BY_ID.get('convenience_store')!;
    expect(standardType(store)).toBe('parttime');
    expect(payFactor(store, 'parttime')).toBe(1);
  });

  it('일용직은 일한 날만큼 받고, 작업반에 들면 일감 날수가 늘어난다', () => {
    const days = (crew: boolean) => {
      const out: number[] = [];
      for (let i = 0; i < 120; i++) {
        const s = seedWithOffer(`DAY-${crew}-${i}`, 'construction_laborer', 'daily');
        takeJob(s, 'construction_laborer');
        if (crew) s.ch.flags.work_crew = { since: s.ch.age, until: s.ch.age + 3 };
        yearEnd(s);
        out.push(ledgerOf(s.ch)[0].days!);
      }
      return out;
    };
    const plain = days(false);
    const crew = days(true);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.min(...plain)).toBeGreaterThanOrEqual(40);
    expect(Math.max(...plain)).toBeLessThanOrEqual(270);
    expect(new Set(plain).size).toBeGreaterThan(20);
    expect(mean(crew) - mean(plain)).toBeGreaterThan(10);
  });

  it('플랫폼·프리랜서 소득은 해마다 출렁이고, 정규직은 연봉 곡선 그대로다', () => {
    const spread = (jobId: string, type: EmploymentType) => {
      const ratios: number[] = [];
      for (let i = 0; i < 80; i++) {
        const s = seedWithOffer(`VAR-${jobId}-${i}`, jobId, type);
        takeJob(s, jobId);
        yearEnd(s);
        const job = JOB_BY_ID.get(jobId)!;
        const base = jobSalary(job, 1, 1, 1) * payFactor(job, type);
        ratios.push(ledgerOf(s.ch)[0].gross / base);
      }
      return Math.max(...ratios) - Math.min(...ratios);
    };
    expect(spread('quick_courier', 'platform')).toBeGreaterThan(0.5);
    expect(spread('translator', 'freelance')).toBeGreaterThan(0.5);
    expect(spread('soe_office', 'regular')).toBeLessThan(0.01);
  });

  it('무급 가족종사는 생활비 몫만 받고, 나머지 일의 값 일부가 가업에 쌓이며, 부모가 떠나면 가업을 잇는다', () => {
    const s = adult('FAMILY-1', 28);
    takeJob(s, 'family_store_helper');
    expect(currentType(s)).toBe('family');
    const estate = s.ch.family.estate;
    yearEnd(s);
    expect(s.ch.family.estate).toBeGreaterThan(estate);
    const share = s.ch.career.salary;
    for (const n of s.ch.npcs) if (n.role === 'mother' || n.role === 'father') n.alive = false;
    yearEnd(s);
    expect(currentType(s)).toBe('self');
    expect(s.ch.career.salary).toBeGreaterThan(share * 2);
  });

  it('근로시간이 한 해의 시간 포인트를 바꾼다: 주 25시간 이하 3, 보통 2, 주 52시간 이상 1', () => {
    const part = seedWithOffer('PT', 'nanny', 'parttime');
    takeJob(part, 'nanny');
    expect(timePointsFor(part)).toBe(3);
    // 시간제라도 주 35시간 카페 일은 보통 일과 같다
    const barista = seedWithOffer('PT-CAFE', 'cafe_barista', 'parttime');
    takeJob(barista, 'cafe_barista');
    expect(timePointsFor(barista)).toBe(2);
    const office = adult('PT-OFFICE');
    takeJob(office, 'sme_office');
    expect(timePointsFor(office)).toBe(2);
    const long = adult('PT-LONG');
    takeJob(long, 'executive');
    expect(timePointsFor(long)).toBe(1);
  });
});

// ── 취업 → 일 → 계약 → 실직 → 복귀 ─────────────────────────

describe('취업 → 일 → 계약 만료 → 실직·구직급여 → 경력 복귀', () => {
  /** 계약직으로 들어가 2년 차 연말에 '재계약 불가'가 나는 시드 */
  function endingContract(): GameState {
    for (let i = 0; i < 300; i++) {
      const s = seedWithOffer(`CONTRACT-${i}`, 'sme_office', 'contract');
      takeJob(s, 'sme_office');
      yearEnd(s);
      yearEnd(s);
      if (s.ch.career.work?.ending) return s;
    }
    throw new Error('재계약 불가 시드를 찾지 못했다');
  }

  it('계약 기간·소득 원장·만료 카드·구직급여·복귀 공고가 한 사슬로 이어진다', () => {
    const s = endingContract();
    const w = s.ch.career.work!;
    // 30세 입사, 2년 계약: 32세 생일까지
    expect(w.contractUntil).toBe(32);
    expect(s.ch.age).toBe(32);
    expect(ledgerOf(s.ch).map((y) => y.type)).toEqual(['contract', 'contract']);
    expect(ledgerOf(s.ch)[0].gross).toBeGreaterThan(0);
    // 다음 해 첫머리: 만료 카드가 관문으로 뜬다
    expect(milestonesFor(s).some((p) => p.eventId === 'work_contract_end')).toBe(true);
    s.step = 'yearStart';
    expect(presentCard(s, { eventId: 'work_contract_end', ctx: {} })).toBe(true);
    choose(s, 0); // 받아들이고 구직급여를 알아본다
    proceed(s);
    expect(s.ch.career.jobId).toBeUndefined();
    expect(w.exit).toMatchObject({ age: 32, reason: 'contract_end', jobId: 'sme_office', type: 'contract', insuredYears: 2 });
    syncDerivedFlags(s);
    expect(s.ch.flags.unemployed).toEqual({ since: 32 });
    // 연말: 비자발적 이직이라 구직급여 (2년 가입·50세 미만 150일 × 하한 66,048원)
    yearEnd(s);
    const paid = ledgerOf(s.ch).at(-1)!;
    expect(paid.jobId).toBeUndefined();
    expect(paid.benefit).toBe(Math.round(66_048 * benefitDays(32, 2)));
    // 같은 실직에 두 번 주지 않는다
    yearEnd(s);
    expect(ledgerOf(s.ch).at(-1)?.age).toBe(32);
    // 실직 중이면 그만둔 직업이 공고에 보인다 (경력 복귀)
    const back = jobOpenings(s).find((o) => o.job.id === 'sme_office');
    expect(back).toBeDefined();
  });

  it('구제 신청이 받아들여지면 같은 자리에서 계약이 이어지고, 용역 전환은 소속과 몫이 바뀐다', () => {
    const saved = endingContract();
    saved.step = 'yearStart';
    saved.ch.flags.work_contract_saved = { since: saved.ch.age, until: saved.ch.age + 1 };
    yearEnd(saved);
    expect(saved.ch.career.jobId).toBe('sme_office');
    expect(saved.ch.career.work!.ending).toBeUndefined();
    expect(saved.ch.career.work!.renewals).toBe(1);

    const moved = endingContract();
    const before = moved.ch.career.salary;
    moved.ch.flags.work_to_dispatch = { since: moved.ch.age, until: moved.ch.age + 1 };
    yearEnd(moved);
    expect(currentType(moved)).toBe('dispatch');
    expect(moved.ch.career.salary).toBeLessThan(before * 1.05);
  });

  it('만료 통보 뒤 아무 길도 정해지지 않으면 그해 말에 계약이 끝난다', () => {
    const s = endingContract();
    yearEnd(s);
    expect(s.ch.career.jobId).toBeUndefined();
    expect(s.ch.career.work!.exit!.reason).toBe('contract_end');
  });

  it('스스로 그만두면 구직급여가 없고, 다시 지원해 들어갈 수 있다', () => {
    const s = adult('QUIT-1');
    takeJob(s, 'factory');
    yearEnd(s);
    yearEnd(s);
    s.phase = 'action';
    const r = quitJob(s);
    expect(r.ok).toBe(true);
    expect(s.ch.career.work!.exit!.reason).toBe('quit');
    syncDerivedFlags(s);
    yearEnd(s);
    expect(ledgerOf(s.ch).some((y) => (y.benefit ?? 0) > 0)).toBe(false);
    // 복귀: 공고나 직접 지원으로 같은 직업에 다시 들어간다 (붙을 때까지 해마다)
    for (let year = 0; year < 15 && !s.ch.career.jobId; year++) {
      s.phase = 'action';
      applyForJob(s, 'factory');
      if (!s.ch.career.jobId) yearEnd(s);
    }
    expect(s.ch.career.jobId).toBe('factory');
    expect(s.ch.career.history.filter((h) => h.jobId === 'factory')).toHaveLength(2);
  });

  it('공고에 없는 일도 조건을 갖췄으면 시간 한 칸을 들여 직접 지원할 수 있다 (합격 가능성은 낮다)', () => {
    const s = adult('DIRECT-1', 30, 'university');
    s.phase = 'action';
    const posted = new Set(jobOpenings(s).map((o) => o.job.id));
    const target = JOBS.find((j) => j.listed && !posted.has(j.id) && meetsJob(s, j) && offerFor(s, j))!;
    expect(target).toBeDefined();
    const left = s.points.left;
    applyForJob(s, target.id);
    expect(s.points.left).toBe(left - 1);
    expect(s.ch.career.appliedThisYear).toContain(target.id);
    // 조건이 안 되는 일은 무엇이 모자란지 알려 준다
    const blocked = applyForJob(s, 'bus_driver');
    expect(blocked.ok).toBe(false);
    expect(blocked.text).toContain('1종 대형 운전면허');
  });

  it('지원 조건 표시와 실제 판정(meetsJob)이 모든 직업에서 같다', () => {
    const people = [adult('REQ-1', 19, 'high'), adult('REQ-2', 35, 'university'), adult('REQ-3', 50, 'none'), adult('REQ-4', 24, 'college')];
    grantLicense(people[1], 'driver_1');
    grantLicense(people[1], 'driver_large');
    grantLicense(people[1], 'bus_cert');
    for (const s of people) {
      const scope = buildScope(s);
      for (const job of JOBS) expect(jobRequirements(s, job, scope).every((r) => r.ok), `${job.id} @${s.ch.age}`).toBe(meetsJob(s, job));
    }
  });

  it('공고는 같은 해 같은 목록이고, 자격이 하나 늘어도 기존 공고는 많아야 하나만 밀린다', () => {
    const s = adult('POST-1');
    const a = jobOpenings(s).map((o) => o.job.id);
    expect(jobOpenings(s).map((o) => o.job.id)).toEqual(a);
    grantLicense(s, 'forklift');
    const b = new Set(jobOpenings(s).map((o) => o.job.id));
    expect(a.filter((id) => !b.has(id)).length).toBeLessThanOrEqual(1);
  });

  it('같은 상태 객체를 고쳐 가며 공고를 다시 물어도 새로 계산한 결과와 같다 (공고 캐시가 낡지 않는다)', () => {
    const s = adult('MEMO-1', 33, 'college');
    const ids = (x: GameState) => jobOpenings(x).map((o) => `${o.job.id}:${o.offer?.type}:${o.chance.toFixed(6)}:${o.via ?? ''}`);
    const fresh = (x: GameState) => ids(JSON.parse(JSON.stringify(x)) as GameState);
    const steps: ((x: GameState) => void)[] = [
      (x) => void (x.ch.res.cash = 900_000_000),
      (x) => grantLicense(x, 'driver_1'),
      (x) => void (x.ch.stats.intelligence = 95),
      (x) => void (x.ch.flags.unemployed = { since: 30 }),
      (x) => void (x.ch.flags.work_referral = { since: 33, until: 35 }),
      (x) => void (x.ch.region = 'jeonnam'),
      (x) => void (x.world.economy.unemployment = 6),
      (x) => void x.ch.npcs.forEach((n) => (n.alive = false)),
      (x) => void (x.ch.legal.convictions = 1),
    ];
    for (const step of steps) {
      ids(s); // 캐시를 채운다
      step(s);
      expect(ids(s)).toEqual(fresh(s));
    }
  });

  it('65세가 넘으면 공고가 줄고 새로 붙기도 어렵다', () => {
    const young = adult('SENIOR-1', 50);
    const old = adult('SENIOR-1', 72);
    expect(jobOpenings(old).length).toBeLessThan(jobOpenings(young).length);
    const cleaner = JOB_BY_ID.get('building_cleaner')!;
    expect(hireChance(old, cleaner)).toBeLessThan(hireChance(young, cleaner));
  });
});

// ── 부업 ─────────────────────────────────────────────────

describe('부업: 시간·피로·겸직 금지·일정 충돌', () => {
  it('야간·교대 본업에 야간 부업은 겹치고, 겸직 금지 직업은 부업을 할 수 없으며, 주 72시간을 넘길 수 없다', () => {
    expect(schedulesClash(['shift', 'night'], ['night'])).toBe(true);
    expect(schedulesClash(['day'], ['night'])).toBe(false);
    expect(schedulesClash(['shift'], ['remote'])).toBe(false);

    const taxi = adult('SIDE-TAXI');
    grantLicense(taxi, 'driver_1');
    grantLicense(taxi, 'taxi_cert');
    takeJob(taxi, 'taxi_driver');
    expect(sideJobBlock(taxi, JOB_BY_ID.get('designated_driver')!)).toContain('겹친다');

    const official = adult('SIDE-CIVIL');
    takeJob(official, 'civil_servant');
    expect(sideJobBlock(official, JOB_BY_ID.get('translator')!)).toContain('겸직');

    const long = adult('SIDE-LONG');
    grantLicense(long, 'driver_1');
    takeJob(long, 'restaurant_owner');
    expect(sideJobBlock(long, JOB_BY_ID.get('designated_driver')!)).toContain('72시간');
  });

  it('사무직이 밤에 대리운전을 하면 시간 한 칸이 줄고, 연말에 부업 소득과 피로가 남는다. 겸직 금지 직업으로 옮기면 부업은 접힌다', () => {
    const s = adult('SIDE-OK');
    grantLicense(s, 'driver_1');
    takeJob(s, 'sme_office');
    s.phase = 'action';
    const before = timePointsFor(s);
    const r = takeSideJob(s, 'designated_driver');
    expect(r.ok).toBe(true);
    expect(s.points.left).toBe(3);
    expect(timePointsFor(s)).toBe(before - 1);
    const stress = s.ch.state.stress;
    yearEnd(s);
    const y = ledgerOf(s.ch).at(-1)!;
    expect(y.side).toBeGreaterThan(0);
    expect(s.ch.state.stress).toBeGreaterThan(stress);
    takeJob(s, 'civil_servant');
    expect(s.ch.career.work!.side).toBeUndefined();
  });
});

// ── 자격·면허 ────────────────────────────────────────────

describe('자격·면허: 떨어져도 다시 응시하고, 갱신을 놓치면 효력을 잃는다', () => {
  it('공인중개사: 떨어진 해에는 다시 못 보지만 이듬해 다시 보고, 응시할수록 합격률이 오른다. 따면 그 직업이 열린다', () => {
    const s = adult('LIC-REALTOR');
    s.phase = 'action';
    const realtor = JOB_BY_ID.get('realtor')!;
    expect(meetsJob(s, realtor)).toBe(false);
    const def = LICENSE_BY_ID.get('realtor')!;
    const first = licensePassChance(s, def);
    let tries = 0;
    for (let year = 0; year < 30 && !hasLicense(s.ch, 'realtor'); year++) {
      s.ch.res.cash = 30_000_000;
      s.phase = 'action';
      const r = studyLicense(s, 'realtor');
      tries++;
      if (!r.ok) {
        // 같은 해 두 번째 응시는 막힌다
        expect(studyLicense(s, 'realtor').text).toContain('올해 시험은 이미 봤다');
        expect(licensePassChance(s, def)).toBeGreaterThanOrEqual(first);
      }
      if (!hasLicense(s.ch, 'realtor')) yearEnd(s);
    }
    expect(hasLicense(s.ch, 'realtor')).toBe(true);
    expect(s.ch.career.work!.licenses!.realtor.tries).toBe(tries);
    expect(meetsJob(s, realtor)).toBe(true);
  });

  it('운전면허: 갱신 기한을 1년 넘기면 효력을 잃고 그 면허가 필요한 일을 계속할 수 없다. 갱신하면 이어진다', () => {
    const lapse = adult('LIC-LAPSE', 40);
    grantLicense(lapse, 'driver_1', 30); // 40세 갱신
    takeJob(lapse, 'designated_driver');
    expect(lapse.ch.career.work!.licenses!.driver_1.renewAt).toBe(40);
    yearEnd(lapse); // 40세 말: 유예 중
    expect(lapse.ch.career.jobId).toBe('designated_driver');
    yearEnd(lapse); // 41세 말: 효력 정지
    expect(lapse.ch.career.work!.licenses!.driver_1.lapsed).toBe(true);
    expect(lapse.ch.career.jobId).toBeUndefined();
    expect(lapse.ch.career.work!.exit!.reason).toBe('dismissed');

    const renew = adult('LIC-RENEW', 40);
    grantLicense(renew, 'driver_1', 30);
    takeJob(renew, 'designated_driver');
    renew.phase = 'action';
    expect(studyLicense(renew, 'driver_1').ok).toBe(true);
    expect(renew.ch.career.work!.licenses!.driver_1.renewAt).toBe(50);
    yearEnd(renew);
    yearEnd(renew);
    expect(renew.ch.career.jobId).toBe('designated_driver');
  });

  it('직업훈련은 연말에 끝나고, IT 과정을 마치면 학력 대신 개발 일자리에 지원할 수 있다', () => {
    const s = adult('TRAIN-IT', 30, 'high');
    s.ch.stats.intelligence = 70;
    const dev = JOB_BY_ID.get('developer')!;
    expect(meetsJob(s, dev)).toBe(false);
    s.phase = 'action';
    expect(startTraining(s, 'it').ok).toBe(true);
    yearEnd(s);
    expect(s.ch.career.work!.trained).toContain('it');
    expect(meetsJob(s, dev)).toBe(true);
  });
});

// ── 산재·체불 ────────────────────────────────────────────

describe('산재와 체불: 고른 처리에 따라 소득과 받을 돈이 달라진다', () => {
  function injured(choice: number): GameState {
    const s = seedWithOffer('INJ', 'welder', 'regular', (x) => grantLicense(x, 'welder'));
    takeJob(s, 'welder');
    s.step = 'yearStart';
    expect(presentCard(s, { eventId: 'work_injury', ctx: {} })).toBe(true);
    choose(s, choice);
    proceed(s);
    yearEnd(s);
    return s;
  }

  it('산재 신청은 휴업급여 70%, 공상은 회사가 임금을 대고, 자비로 바로 나가면 반달 치를 잃는다', () => {
    const claim = injured(0);
    const company = injured(1);
    const self = injured(2);
    const g = (s: GameState) => ledgerOf(s.ch).at(-1)!.gross;
    expect(company.ch.career.work!.injury!.cover).toBe('company');
    expect(self.ch.career.work!.injury!.months).toBe(0.5);
    expect(g(company)).toBeGreaterThan(g(self));
    // 산재는 쉰 달 × 30%만 줄어든다 (불승인이면 자비와 같다)
    const w = claim.ch.career.work!.injury!;
    if (w.cover === 'claim') expect(g(claim)).toBeGreaterThan(g(company) * (1 - (w.months / 12) * 0.3) - 2);
    expect(claim.scheduled.some((x) => x.eventId === 'work_injury_after')).toBe(true);
  });

  it('체불 진정을 넣으면 받을 돈이 남고, 회수되면 그해 소득에 들어오며 태그가 사라진다', () => {
    for (let i = 0; i < 60; i++) {
      const s = adult(`ARREARS-${i}`);
      takeJob(s, 'shipyard_worker');
      s.step = 'yearStart';
      expect(presentCard(s, { eventId: 'work_wage_arrears', ctx: {} })).toBe(true);
      choose(s, 0); // 진정
      proceed(s);
      expect(s.ch.flags.work_wage_claim).toBeDefined();
      yearEnd(s);
      const w = s.ch.career.work!;
      const first = ledgerOf(s.ch).at(-1)!;
      if (w.arrears) {
        expect(w.arrears.amount).toBeGreaterThan(0);
        expect(s.ch.flags.work_arrears).toBeDefined();
        continue;
      }
      // 첫해에 회수됐다
      expect(first.benefit).toBeGreaterThan(0);
      expect(s.ch.flags.work_arrears).toBeUndefined();
      return;
    }
    throw new Error('회수 사례를 찾지 못했다');
  });
});

// ── 저장 ─────────────────────────────────────────────────

describe('저장·불러오기와 옛 저장', () => {
  it('계약·부업·면허·체불·원장이 있는 상태를 저장·재개해도 같은 결과로 이어진다', () => {
    const s = seedWithOffer('SAVE-WORK', 'sme_office', 'contract', (x) => grantLicense(x, 'driver_1'));
    takeJob(s, 'sme_office');
    s.phase = 'action';
    takeSideJob(s, 'designated_driver');
    workOf(s.ch).arrears = { amount: 3_000_000, since: s.ch.age };
    s.ch.flags.work_arrears = { since: s.ch.age };
    yearEnd(s);
    const storage = memoryStorage();
    expect(saveGame(s, storage)).toBe(true);
    const loaded = loadGame(storage)!;
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(s));
    yearEnd(s);
    yearEnd(loaded);
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(s));
  });

  it('career.work가 없는 옛 저장의 기존 직업 ID: 표준 형태로 읽고, 연봉은 그대로이며, 모르는 계약 만료일을 만들지 않는다', () => {
    for (const id of Object.keys(LEGACY)) {
      if (id === 'self_employed') continue;
      const s = adult(`OLD-${id}`, 40, 'university');
      takeJob(s, id);
      s.ch.career.years = 5;
      delete s.ch.career.work; // 직업 확장 전 저장
      const storage = memoryStorage();
      saveGame(s, storage);
      const old = loadGame(storage)!;
      const job = JOB_BY_ID.get(id)!;
      expect(currentType(old)).toBe(standardType(job));
      yearEnd(old);
      expect(old.ch.career.jobId === id || old.ch.career.jobId === undefined).toBe(true);
      if (old.ch.career.jobId === id) {
        expect(old.ch.career.salary).toBe(jobSalary(job, 6, 1, 1));
        expect(old.ch.career.work?.contractUntil).toBeUndefined();
      }
      expect(ledgerOf(old.ch).length).toBeGreaterThan(0);
    }
  });

  it('직업을 잃게 만드는 기존 경로(사건 loseJob)는 까닭을 짐작해 남긴다: 위로금이 붙으면 권고사직', () => {
    const s = adult('LOSE-1');
    takeJob(s, 'large_corp');
    s.ch.career.years = 10;
    leaveJob(s, 12);
    expect(s.ch.career.work!.exit!.reason).toBe('layoff');
    const q = adult('LOSE-2');
    takeJob(q, 'delivery_rider');
    q.ch.career.years = 5;
    // 플랫폼 노동은 퇴직금이 없다
    expect(leaveJob(q, 0)).toBe(0);
  });
});
