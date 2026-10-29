// 사법 기록의 단일 정의(R-010), 시뮬레이터 지표 계산(R-002·R-003), 사기 아크 봇 정책, 새 인생의 기본 모드

import { describe, expect, it } from 'vitest';
import { hireChance, jobOpenings, meetsJob, takeJob } from '../src/engine/career';
import { EVENT_BY_ID, JOB_BY_ID } from '../src/engine/data';
import { newGame } from '../src/engine/game';
import { prosecute, type Verdict } from '../src/engine/justice';
import {
  barredFromJob,
  convictionCount,
  hasCriminalRecord,
  recordHireFactor,
  sentenceRecords,
  servedPrison,
  type SentenceKind,
} from '../src/engine/records';
import { rngFor } from '../src/engine/rng';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import { refusalChoice, simulateLife } from '../src/engine/sim';
import { epitaph } from '../src/engine/summary';
import type { ActiveCard, GameState } from '../src/engine/types';
import { DEFAULT_MODE, useGame } from '../src/ui/store';
import { checkWithin, fertilityRate, lifeExpectancy, meanEstimate, proportion, survival } from '../tools/simulator/metrics';

/** 시드로 태어난 사람을 그 나이의 성인으로 만든다 (같은 시드면 능력치도 같다) */
function personAt(seed: string, age: number): GameState {
  const s = newGame({ seed, mode: 'reality', birthYear: 2026 });
  s.ch.age = age;
  s.year = s.ch.birthYear + age;
  s.world.year = s.year;
  s.ch.edu.status = 'graduated';
  s.ch.edu.degree = 'high';
  return s;
}

/** 원하는 처분이 나올 때까지 재판의 난수 줄기만 바꾼다. 늘 같은 줄기에서 멈추므로 결과는 고정이다 */
function sentenced(
  kind: Verdict['kind'],
  crime: string,
  age = 30,
  setup: (s: GameState) => void = () => {},
): { state: GameState; verdict: Verdict; seed: string } {
  const seed = `REC-${kind}-${crime}-${age}`;
  for (let i = 0; i < 200; i++) {
    const state = personAt(seed, age);
    setup(state);
    const verdict = prosecute(state, crime, rngFor(seed, i));
    if (verdict.kind === kind) return { state, verdict, seed };
  }
  throw new Error(`${crime}에서 ${kind} 판결을 찾지 못했다`);
}

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const OFFICE = JOB_BY_ID.get('sme_office')!;

describe('사법 기록: 처분 이력 한 곳, 같은 정의 (R-010)', () => {
  it('검토 재현: 30세 절도 벌금형도 전과 태그·유죄 1회·벌금 기록이 함께 남는다', () => {
    const s = personAt('REVIEW-FINE', 30);
    const v = prosecute(s, 'theft', rngFor('REVIEW-FINE', 1));
    expect(v.kind).toBe('fine');
    expect(s.ch.legal.convictions).toBe(1);
    expect(s.ch.flags.criminal_record).toEqual({ since: 30 });
    expect(v.changes.map((c) => c.text)).toContain('태그: 전과자');
    const records = sentenceRecords(s.ch);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ age: 30, crime: 'theft', kind: 'fine', until: 32 });
    expect(records[0].amount).toBeGreaterThan(0);
    expect(hasCriminalRecord(s.ch)).toBe(true);
  });

  const cases: { verdict: Verdict['kind']; crime: string; age: number; record: SentenceKind; convicted: boolean }[] = [
    { verdict: 'drop', crime: 'courier_selfreport', age: 30, record: 'suspended_prosecution', convicted: false },
    { verdict: 'juvenile', crime: 'theft', age: 16, record: 'juvenile', convicted: false },
    { verdict: 'fine', crime: 'theft', age: 30, record: 'fine', convicted: true },
    { verdict: 'suspended', crime: 'theft', age: 30, record: 'probation', convicted: true },
    { verdict: 'prison', crime: 'escape', age: 30, record: 'prison', convicted: true },
  ];
  for (const c of cases) {
    it(`${c.record}: 기록·전과 태그·유죄 횟수·전과 판정이 서로 맞는다`, () => {
      const { state } = sentenced(c.verdict, c.crime, c.age);
      const ch = state.ch;
      expect(sentenceRecords(ch).map((r) => r.kind)).toEqual([c.record]);
      expect(Boolean(ch.flags.criminal_record)).toBe(c.convicted);
      expect(Boolean(ch.flags.juvenile_record)).toBe(c.record === 'juvenile');
      expect(ch.legal.convictions).toBe(c.convicted ? 1 : 0);
      expect(convictionCount(ch)).toBe(ch.legal.convictions);
      expect(hasCriminalRecord(ch)).toBe(c.convicted);
      expect(servedPrison(ch)).toBe(c.record === 'prison');
    });
  }

  it('재범 판정은 유죄 판결만 센다: 소년보호처분·기소유예 뒤의 첫 벌금은 초범이다', () => {
    const s = personAt('REC-PRIORS', 16);
    prosecute(s, 'theft', rngFor('REC-PRIORS', 'juvenile'));
    expect(convictionCount(s.ch)).toBe(0);
    s.ch.age = 30;
    let fines = 0;
    for (let i = 0; fines < 2 && i < 200; i++) {
      // 같은 상태에 거듭 재판: 처분마다 기록이 쌓이고, 유죄 횟수는 유죄 기록 수와 같다
      const v = prosecute(s, 'gambling', rngFor('REC-PRIORS', i));
      if (v.kind === 'fine') fines++;
    }
    const convictions = sentenceRecords(s.ch).filter((r) => ['fine', 'probation', 'prison'].includes(r.kind)).length;
    expect(convictions).toBeGreaterThanOrEqual(2);
    expect(s.ch.legal.convictions).toBe(convictions);
    expect(convictionCount(s.ch)).toBe(convictions);
    expect(sentenceRecords(s.ch)[0].kind).toBe('juvenile');
  });

  it('채용은 같은 기록을 처분별로 다르게 본다 (모든 유죄에 같은 불이익을 주지 않는다)', () => {
    const expected: [Verdict['kind'], string, number, number][] = [
      ['drop', 'courier_selfreport', 30, 1],
      ['juvenile', 'theft', 16, 1],
      ['fine', 'theft', 30, 0.9],
      ['suspended', 'theft', 30, 0.65],
      ['prison', 'escape', 30, 0.45],
    ];
    for (const [kind, crime, age, factor] of expected) {
      const { state, seed } = sentenced(kind, crime, age);
      const before = hireChance(personAt(seed, age), OFFICE);
      expect(before).toBeGreaterThan(0.05);
      expect(before).toBeLessThan(0.9);
      expect(recordHireFactor(state.ch)).toBe(factor);
      expect(hireChance(state, OFFICE) / before).toBeCloseTo(factor, 10);
    }
  });

  it('벌금·집행유예의 불이익은 기간이 지나면 사라지고, 실형은 실효 뒤에도 일부 남는다', () => {
    const fine = sentenced('fine', 'theft').state;
    fine.ch.age = 31;
    expect(recordHireFactor(fine.ch)).toBe(0.9);
    fine.ch.age = 32; // 형 실효 2년
    expect(recordHireFactor(fine.ch)).toBe(1);

    const probation = sentenced('suspended', 'theft').state;
    probation.ch.age = 32; // 유예 기간 2년이 끝남
    expect(recordHireFactor(probation.ch)).toBe(1);

    const prison = sentenced('prison', 'escape').state;
    const release = sentenceRecords(prison.ch)[0].until!;
    prison.ch.age = release + 4;
    expect(recordHireFactor(prison.ch)).toBe(0.45);
    prison.ch.age = release + 5; // 3년 이하 징역은 출소 뒤 5년에 실효
    expect(recordHireFactor(prison.ch)).toBe(0.8);
  });

  it('공공 부문 결격: 집행유예는 유예가 끝나고 2년, 실형은 출소 뒤 5년까지. 벌금·민간 직장은 막지 않는다', () => {
    const probation = sentenced('suspended', 'theft', 22).state;
    for (const [age, barred] of [[22, true], [25, true], [26, false]] as const) {
      probation.ch.age = age;
      expect(barredFromJob(probation.ch, 'civil_servant')).toBe(barred);
      expect(barredFromJob(probation.ch, 'sme_office')).toBe(false);
    }

    const prison = sentenced('prison', 'escape', 22).state;
    const release = sentenceRecords(prison.ch)[0].until!;
    prison.ch.age = release + 4;
    expect(barredFromJob(prison.ch, 'teacher')).toBe(true);
    prison.ch.age = release + 5;
    expect(barredFromJob(prison.ch, 'teacher')).toBe(false);

    const fine = sentenced('fine', 'theft', 22).state;
    expect(barredFromJob(fine.ch, 'civil_servant')).toBe(false);
  });

  it('결격 기간에는 부사관 공고가 자격 목록에서 빠진다 (채용 공고와 같은 조회)', () => {
    const fit = (s: GameState) => {
      s.ch.stats.stamina = 70;
    };
    const nco = JOB_BY_ID.get('nco')!;
    const clean = personAt('REC-NCO', 22);
    fit(clean);
    expect(meetsJob(clean, nco)).toBe(true);
    const { state } = sentenced('suspended', 'theft', 22, fit);
    expect(meetsJob(state, nco)).toBe(false);
    expect(meetsJob(state, OFFICE)).toBe(true);
    for (let age = 22; age <= 25; age++) {
      state.ch.age = age;
      expect(jobOpenings(state).some((o) => o.job.id === 'nco')).toBe(false);
    }
    state.ch.age = 26;
    expect(meetsJob(state, nco)).toBe(true);
  });

  it('공무원은 집행유예만으로 당연퇴직하고, 민간 직장인은 그대로 다닌다', () => {
    const civil = sentenced('suspended', 'theft', 30, (s) => void takeJob(s, 'civil_servant'));
    expect(civil.state.ch.career.jobId).toBeUndefined();
    expect(civil.verdict.changes.map((c) => c.text)).toContain('당연퇴직');

    const office = sentenced('suspended', 'theft', 30, (s) => void takeJob(s, 'sme_office'));
    expect(office.state.ch.career.jobId).toBe('sme_office');
  });

  it('records가 없는 기존 저장도 불러오고, 판결 종류를 모르는 기록은 예전 규칙 그대로 쓴다', () => {
    // 예전 벌금형: 유죄 1회, 태그 없음
    const oldFine = personAt('REC-LEGACY-FINE', 30);
    oldFine.ch.legal = { convictions: 1 };
    const store = memoryStorage();
    expect(saveGame(oldFine, store)).toBe(true);
    const loaded = loadGame(store)!;
    expect(loaded).not.toBeNull();
    expect(sentenceRecords(loaded.ch)).toEqual([]);
    expect(hasCriminalRecord(loaded.ch)).toBe(true);
    expect(recordHireFactor(loaded.ch)).toBe(1);
    expect(barredFromJob(loaded.ch, 'civil_servant')).toBe(false);

    // 예전 집행유예·실형: 태그만 있다 → 예전처럼 채용 ×0.45, 묘비명의 철창도 그대로
    const legacyTagged = () => {
      const s = personAt('REC-LEGACY-TAG', 30);
      s.ch.legal = { convictions: 1 };
      s.ch.flags.criminal_record = { since: 25 };
      return s;
    };
    const oldTag = legacyTagged();
    expect(recordHireFactor(oldTag.ch)).toBe(0.45);
    expect(servedPrison(oldTag.ch)).toBe(true);

    // 그 뒤의 새 벌금은 기록되고, 예전 판결과 합쳐 센다
    const later = (() => {
      for (let i = 0; i < 200; i++) {
        const s = legacyTagged();
        if (prosecute(s, 'gambling', rngFor('REC-LEGACY-TAG', i)).kind === 'fine') return s;
      }
      throw new Error('벌금 판결을 찾지 못했다');
    })();
    expect(sentenceRecords(later.ch).map((r) => r.kind)).toEqual(['fine']);
    expect(convictionCount(later.ch)).toBe(2);
    expect(later.ch.flags.criminal_record).toEqual({ since: 25 });
    expect(recordHireFactor(later.ch)).toBe(0.45);
  });

  it("묘비명의 '철창 안에서도'는 실형을 산 사람에게만 붙는다", () => {
    const onlyRecordTag = (s: GameState) => {
      for (const id of Object.keys(s.ch.flags)) if (id !== 'criminal_record') delete s.ch.flags[id];
    };
    const fine = sentenced('fine', 'theft').state;
    onlyRecordTag(fine);
    expect(epitaph(fine)).not.toContain('철창');
    const probation = sentenced('suspended', 'theft').state;
    onlyRecordTag(probation);
    expect(epitaph(probation)).not.toContain('철창');
    const prison = sentenced('prison', 'escape').state;
    onlyRecordTag(prison);
    expect(epitaph(prison)).toContain('철창 안에서도');
  });
});

describe('시뮬레이터 지표 (R-002·R-003)', () => {
  it('비율의 Wilson 95% 신뢰구간', () => {
    const zero = proportion(0, 10);
    expect(zero.value).toBe(0);
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeCloseTo(0.2775, 4);
    const half = proportion(5, 10);
    expect(half.lo).toBeCloseTo(0.2366, 4);
    expect(half.hi).toBeCloseTo(0.7634, 4);
    expect(proportion(10, 10).hi).toBe(1);
    const none = proportion(0, 0);
    expect(none.n).toBe(0);
    expect([none.lo, none.hi]).toEqual([0, 1]);
  });

  it('평균의 95% 신뢰구간 (표본 분산 n−1)', () => {
    const e = meanEstimate([1, 2, 3, 4, 5]);
    expect(e.value).toBe(3);
    expect(e.lo).toBeCloseTo(3 - 1.959964 * Math.sqrt(2.5 / 5), 6);
    expect(e.hi).toBeCloseTo(3 + 1.959964 * Math.sqrt(2.5 / 5), 6);
    expect(meanEstimate([7]).hi).toBe(Infinity);
    expect(meanEstimate([]).n).toBe(0);
  });

  it('생존율과 기대여명: 마지막 나이 ≥ x면 x세에 닿았고, 죽음은 마지막 해의 가운데로 본다', () => {
    const finalAges = [0, 10, 80, 85, 90];
    const s80 = survival(finalAges, 80);
    expect(s80.value).toBeCloseTo(0.6, 10);
    expect(s80.n).toBe(5);
    expect(lifeExpectancy(finalAges).value).toBeCloseTo(53.5, 10);
    const e80 = lifeExpectancy(finalAges, 80);
    expect(e80.value).toBeCloseTo(5.5, 10);
    expect(e80.n).toBe(3);
  });

  it('합계출산율 근사는 여성 인년을 분모로 한 나이별 출산율의 합이다 (여성 한 명당 자녀 수와 다르다)', () => {
    const mothers = [
      { finalAge: 80, birthAges: [30, 33] },
      { finalAge: 20, birthAges: [18] }, // 20세에 죽었다: 21세부터는 분모에서 빠진다
      { finalAge: 60, birthAges: [] },
      { finalAge: 49, birthAges: [30] },
    ];
    const f = fertilityRate(mothers);
    expect(f.asfr[18]).toBeCloseTo(1 / 4, 10);
    expect(f.asfr[30]).toBeCloseTo(2 / 3, 10);
    expect(f.asfr[33]).toBeCloseTo(1 / 3, 10);
    expect(f.value).toBeCloseTo(1.25, 10);
    expect(f.births).toBe(4);
    expect(f.personYears).toBe(6 * 4 + 29 * 3);
    // 여성 한 명당 평균 자녀 수는 1.0: 일찍 죽은 여성 때문에 다른 값이 된다
    expect(mothers.reduce((a, m) => a + m.birthAges.length, 0) / mothers.length).toBe(1);
    // 여성별 기여분 [2/3, 1/4, 0, 1/3]의 분산으로 구한 구간
    expect(f.lo).toBeCloseTo(0.1707, 3);
    expect(f.hi).toBeCloseTo(2.3293, 3);
  });

  it('합계출산율 근사는 15~49세 밖이나 죽은 뒤의 출생을 세지 않는다', () => {
    const f = fertilityRate([{ finalAge: 30, birthAges: [14, 25, 31] }]);
    expect(f.births).toBe(1);
    expect(f.value).toBeCloseTo(1, 10);
    expect(Number.isNaN(f.lo)).toBe(true); // 한 명으로는 구간을 정할 수 없다
  });

  it('판정은 95% 신뢰구간이 목표 ± 허용과 겹치면 통과한다', () => {
    expect(checkWithin({ value: 0.62, lo: 0.58, hi: 0.66, n: 500 }, 0.644, 0.04)).toEqual({ pass: true, inside: true });
    expect(checkWithin({ value: 0.59, lo: 0.55, hi: 0.63, n: 100 }, 0.644, 0.04)).toEqual({ pass: true, inside: false });
    expect(checkWithin({ value: 0.5, lo: 0.46, hi: 0.54, n: 500 }, 0.644, 0.04)).toEqual({ pass: false, inside: false });
    expect(checkWithin(proportion(0, 0), 0.5, 0.5).pass).toBe(false);
  });
});

describe('봇: 사기 아크에서는 대부분 끊거나 거절한다', () => {
  const cardOf = (eventId: string): ActiveCard => {
    const ev = EVENT_BY_ID.get(eventId)!;
    return {
      eventId,
      serial: 0,
      title: ev.title,
      text: ev.text,
      tone: 'neutral',
      ctx: {},
      intro: [],
      choices: (ev.choices ?? []).map((c, i) => ({ index: i, text: c.text })),
    };
  };
  const refusalText = (id: string) => {
    const card = cardOf(id);
    const i = refusalChoice(card);
    return i === undefined ? undefined : card.choices[i].text;
  };

  it('끊기·거절·신고 선택지를 찾고, 사기 아크가 아니거나 그런 선택지가 없으면 고르지 않는다', () => {
    expect(refusalText('phishing_call')).toBe('끊고 112에 직접 확인한다');
    expect(refusalText('courier_offer')).toBe('112에 신고한다');
    expect(refusalText('overseas_job_offer')).toBe('거절한다');
    expect(refusalText('compound_days')).toBeUndefined();
    expect(refusalText('sv_start')).toBeUndefined();
  });

  it('피싱 전화를 받아도 송금까지 가는 경우는 드물다', () => {
    let calls = 0;
    let losses = 0;
    for (let i = 0; i < 100; i++) {
      const s = simulateLife(`BOT-SCAM-${i}`, { mode: 'reality' });
      calls += s.counts.phishing_call ?? 0;
      losses += s.counts.phishing_loss ?? 0;
    }
    expect(calls).toBeGreaterThan(50);
    expect(losses / calls).toBeLessThan(0.1);
  });
});

describe('새 인생의 기본 모드', () => {
  it('고르지 않으면 현실 모드로 태어나고, 고른 모드와 저장된 인생의 모드는 그대로다', () => {
    expect(DEFAULT_MODE).toBe('reality');
    useGame.getState().start({ seed: 'MODE-DEFAULT' });
    expect(useGame.getState().game?.mode).toBe('reality');
    useGame.getState().start({ seed: 'MODE-DRAMA', mode: 'drama' });
    expect(useGame.getState().game?.mode).toBe('drama');

    const store = memoryStorage();
    saveGame(newGame({ seed: 'MODE-SAVED', mode: 'makjang', birthYear: 2026 }), store);
    expect(loadGame(store)?.mode).toBe('makjang');
  });
});
