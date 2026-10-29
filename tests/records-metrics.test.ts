// 사법 기록의 단일 정의(R-010)와 자격 결격(공공 부문·피선거권·소년법 67조), 연이은 형기와 출소 기록,
// 시뮬레이터 지표 계산과 판정 규칙(R-002·R-003), 사기 아크 봇 정책, 새 인생의 기본 모드

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hireChance, jobOpenings, meetsJob, takeJob } from '../src/engine/career';
import { EVENT_BY_ID, JOB_BY_ID } from '../src/engine/data';
import { applyEffects } from '../src/engine/effects';
import { chooseOption, presentCard, triggerOk } from '../src/engine/eventEngine';
import { newGame } from '../src/engine/game';
import { prosecute, type Verdict } from '../src/engine/justice';
import {
  addSentence,
  barredFromJob,
  convictionCount,
  electionBarred,
  hasCriminalRecord,
  publicSectorBarred,
  recordHireFactor,
  sentenceRecords,
  sentencedToImprisonment,
  servedPrison,
  type SentenceKind,
} from '../src/engine/records';
import { rngFor } from '../src/engine/rng';
import { loadGame, saveGame, type KeyValueStorage } from '../src/engine/save';
import { buildScope } from '../src/engine/scope';
import { refusalChoice, simulateLife } from '../src/engine/sim';
import { epitaph } from '../src/engine/summary';
import type { ActiveCard, Change, GameState } from '../src/engine/types';
import { DEFAULT_MODE, useGame } from '../src/ui/store';
import {
  checkWithin,
  EXIT_CODE,
  fertilityRate,
  lifeExpectancy,
  meanEstimate,
  MIN_SAMPLE,
  overallVerdict,
  proportion,
  survival,
} from '../tools/simulator/metrics';

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

/** 같은 사람의 나이만 바꾼다 (연도도 함께) */
function setAge(s: GameState, age: number): void {
  s.ch.age = age;
  s.year = s.ch.birthYear + age;
  s.world.year = s.year;
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

/** 사건 카드를 올리고 문구가 같은 선택지를 고른다. 카드가 뜨지 않으면 undefined */
function playCard(s: GameState, eventId: string, choiceText: string): ActiveCard | undefined {
  if (!presentCard(s, { eventId, ctx: {} })) return undefined;
  const card = s.card!;
  const i = card.choices.findIndex((c) => c.text === choiceText);
  expect(i, `${eventId}에 '${choiceText}' 선택지가 없다`).toBeGreaterThanOrEqual(0);
  chooseOption(s, i);
  return card;
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
      expect(sentencedToImprisonment(ch)).toBe(c.record === 'probation' || c.record === 'prison');
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
      expect(publicSectorBarred(probation.ch)).toBe(barred);
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
    expect(buildScope(loaded).legal).toMatchObject({ publicBarred: false, electionBarred: false });

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
    expect(sentencedToImprisonment(oldTag.ch)).toBe(true);

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
});

describe('공공 부문 결격은 직업을 주는 곳마다 지킨다 (getJob · gongsi_exam · meister_hire)', () => {
  /** 공시생이 시험을 본다. 카드 일련번호만 바꿔 판정 주사위를 여러 번 굴린다 */
  function sitGongsi(base: GameState, age: number, tries = 30) {
    const out: { job?: string; success?: boolean; text: string; shown: string[] }[] = [];
    for (let t = 0; t < tries; t++) {
      const s = structuredClone(base);
      setAge(s, age);
      s.ch.flags.gongsi = { since: age - 1 };
      s.ch.stats.intelligence = 80;
      s.serial = 1000 + t;
      const card = playCard(s, 'gongsi_exam', '답안지를 제출한다')!;
      out.push({
        job: s.ch.career.jobId,
        success: card.result?.success,
        text: card.result?.text ?? '',
        shown: card.choices.map((c) => c.text),
      });
    }
    return out;
  }

  it('검토 재현: 집행유예 중과 유예가 끝나고 2년까지는 9급에 합격해도 임용되지 않고, 그 뒤에는 임용된다', () => {
    const { state } = sentenced('suspended', 'theft', 25); // 유예 27세까지, 결격 29세 전까지
    for (const age of [25, 26, 27, 28]) {
      const tries = sitGongsi(state, age);
      expect(tries.every((t) => t.job === undefined)).toBe(true);
      expect(tries.some((t) => t.success && t.text.includes('결격'))).toBe(true);
      expect(tries[0].shown).toEqual(['시험을 포기하고 취업한다', '답안지를 제출한다']);
    }
    const after = sitGongsi(state, 29);
    expect(after.some((t) => t.job === 'civil_servant')).toBe(true);
    expect(after.every((t) => !t.text.includes('결격'))).toBe(true);
  });

  it('실형은 출소 뒤 5년까지 9급 임용이 막힌다', () => {
    const prison = sentenced('prison', 'escape', 22).state;
    const release = sentenceRecords(prison.ch)[0].until!;
    for (const age of [release, release + 4]) expect(sitGongsi(prison, age).every((t) => t.job === undefined)).toBe(true);
    expect(sitGongsi(prison, release + 5).some((t) => t.job === 'civil_servant')).toBe(true);
  });

  it('집행유예로 당연퇴직한 공무원은 결격 기간에 공채로 다시 임용되지 않는다', () => {
    const civil = sentenced('suspended', 'theft', 30, (s) => void takeJob(s, 'civil_servant')).state;
    expect(civil.ch.career.jobId).toBeUndefined();
    for (const age of [31, 33]) expect(sitGongsi(civil, age).every((t) => t.job === undefined)).toBe(true);
  });

  it('사건이 직접 주는 직업도 결격 기간이면 임용되지 않는다 (getJob: 9급 공무원·공기업 기술직)', () => {
    const { state } = sentenced('suspended', 'theft', 25);
    const give = (job: string) => {
      const s = structuredClone(state);
      const changes: Change[] = [];
      applyEffects(s, { do: [{ type: 'getJob', job }] }, { ctx: {}, rng: rngFor('GETJOB', job), changes });
      return { job: s.ch.career.jobId, changes: changes.map((c) => c.text) };
    };
    for (const job of ['civil_servant', 'public_tech']) {
      expect(give(job)).toEqual({ job: undefined, changes: [`임용 결격: ${JOB_BY_ID.get(job)!.title}`] });
    }
    // 결격과 무관한 직업은 그대로 준다
    expect(give('factory').job).toBe('factory');
  });

  it('마이스터고 공기업 채용(18세)은 19세 미만에 저지른 죄의 집행유예로 막히지 않는다 (소년법 67조)', () => {
    const { state } = sentenced('suspended', 'scam_accomplice', 18);
    state.ch.edu.status = 'high';
    state.ch.edu.highType = 'meister';
    state.ch.edu.grade = 90;
    state.ch.stats.stamina = 90;
    expect(publicSectorBarred(state.ch)).toBe(false);
    let hired = 0;
    for (let t = 0; t < 20; t++) {
      const s = structuredClone(state);
      s.serial = 2000 + t;
      playCard(s, 'meister_hire', '필기와 실기를 본다');
      if (s.ch.career.jobId === 'public_tech') hired++;
    }
    expect(hired).toBeGreaterThan(0);
  });
});

describe('소년법 67조: 19세 미만에 저지른 죄의 형은 자격 결격에서 뺀다', () => {
  it('집행유예는 선고 때부터 결격·피선거권 제한이 없다. 같은 처분을 19세에 받으면 유예가 끝나고 2년까지 결격이다', () => {
    const minor = sentenced('suspended', 'desertion', 18).state;
    expect(sentenceRecords(minor.ch)[0]).toMatchObject({ age: 18, kind: 'probation', until: 20 });
    for (const age of [18, 19, 20, 21]) {
      setAge(minor, age);
      expect(barredFromJob(minor.ch, 'civil_servant')).toBe(false);
      expect(electionBarred(minor.ch)).toBe(false);
    }
    const adult = sentenced('suspended', 'desertion', 19).state;
    for (const [age, barred] of [[19, true], [22, true], [23, false]] as const) {
      setAge(adult, age);
      expect(barredFromJob(adult.ch, 'civil_servant')).toBe(barred);
    }
  });

  it('실형은 집행이 끝나야 빠진다: 갇혀 있는 동안은 결격, 출소하면 바로 풀린다. 채용 배수는 그대로다', () => {
    const jail = sentenced('prison', 'scam_accomplice', 17).state;
    const release = sentenceRecords(jail.ch)[0].until!;
    setAge(jail, release - 1);
    expect(barredFromJob(jail.ch, 'civil_servant')).toBe(true);
    expect(electionBarred(jail.ch)).toBe(true);
    setAge(jail, release);
    expect(barredFromJob(jail.ch, 'civil_servant')).toBe(false);
    expect(electionBarred(jail.ch)).toBe(false);
    // 자격 법령이 아닌 민간 채용 보정은 실효 전까지 남는다
    expect(recordHireFactor(jail.ch)).toBe(0.45);
  });

  it('19세 미만에 저지른 죄로 집행유예를 받은 공기업 직원은 당연퇴직하지 않는다 (19세부터는 퇴직)', () => {
    const minor = sentenced('suspended', 'scam_accomplice', 18, (s) => void takeJob(s, 'public_tech'));
    expect(minor.state.ch.career.jobId).toBe('public_tech');
    expect(minor.verdict.changes.map((c) => c.text)).not.toContain('당연퇴직');
    const adult = sentenced('suspended', 'scam_accomplice', 19, (s) => void takeJob(s, 'public_tech'));
    expect(adult.state.ch.career.jobId).toBeUndefined();
    expect(adult.verdict.changes.map((c) => c.text)).toContain('당연퇴직');
  });
});

describe('피선거권: 정치 아크는 전과 태그가 아니라 처분 기록으로 막는다 (공직선거법 19조 2호)', () => {
  const offer = EVENT_BY_ID.get('political_offer')!;
  const offerOk = (s: GameState) => triggerOk(offer, buildScope(s), s);

  it('검토 재현: 30세 벌금 뒤에도 공천 제안 조건을 만족한다 (벌금은 피선거권을 막지 않는다)', () => {
    const s = personAt('REVIEW-FINE', 30);
    expect(prosecute(s, 'theft', rngFor('REVIEW-FINE', 1)).kind).toBe('fine');
    expect(s.ch.flags.criminal_record).toBeDefined();
    for (const age of [30, 31, 40]) {
      setAge(s, age);
      expect(buildScope(s).legal).toMatchObject({ electionBarred: false });
      expect(offerOk(s)).toBe(true);
    }
  });

  it('집행유예는 유예 기간 동안만, 3년 이하 실형은 출소 뒤 5년(형 실효)까지 막는다', () => {
    const probation = sentenced('suspended', 'theft', 30).state; // 유예 32세까지
    for (const [age, ok] of [[30, false], [31, false], [32, true]] as const) {
      setAge(probation, age);
      expect(offerOk(probation)).toBe(ok);
    }
    const prison = sentenced('prison', 'escape', 30).state;
    const release = sentenceRecords(prison.ch)[0].until!;
    for (const [age, ok] of [[release, false], [release + 4, false], [release + 5, true]] as const) {
      setAge(prison, age);
      expect(offerOk(prison)).toBe(ok);
    }
  });

  it('3년 넘는 실형은 출소 뒤 10년이 지나야 피선거권이 돌아온다', () => {
    const seed = 'REC-LONG-PRISON';
    const long = (() => {
      for (let i = 0; i < 200; i++) {
        const s = personAt(seed, 30);
        const v = prosecute(s, 'wartime_desertion', rngFor(seed, i));
        if (v.kind === 'prison' && sentenceRecords(s.ch)[0].months! > 36) return s;
      }
      throw new Error('3년 넘는 실형을 찾지 못했다');
    })();
    const release = sentenceRecords(long.ch)[0].until!;
    setAge(long, release + 9);
    expect(electionBarred(long.ch)).toBe(true);
    setAge(long, release + 10);
    expect(electionBarred(long.ch)).toBe(false);
    expect(offerOk(long)).toBe(true);
  });

  it('판결 종류를 모르는 예전 저장의 전과 태그는 예전 규칙대로 정치 아크에서 뺀다', () => {
    const s = personAt('REC-LEGACY-POL', 40);
    s.ch.legal = { convictions: 1 };
    s.ch.flags.criminal_record = { since: 25 };
    expect(electionBarred(s.ch)).toBe(true);
    expect(offerOk(s)).toBe(false);
  });

  it('대선 출마도 피선거권이 없으면 열리지 않는다', () => {
    const run = EVENT_BY_ID.get('presidential_run')!;
    // 2026년생은 44세(2070년)와 49세(2075년)가 대선 해다
    const s = sentenced('suspended', 'theft', 44).state; // 유예 46세까지
    s.ch.flags.lawmaker = { since: 35 };
    expect(buildScope(s).world).toMatchObject({ electionYear: true });
    expect(triggerOk(run, buildScope(s), s)).toBe(false);
    setAge(s, 49);
    expect(buildScope(s).world).toMatchObject({ electionYear: true });
    expect(triggerOk(run, buildScope(s), s)).toBe(true);
  });
});

describe("묘비명: '버텼다'는 징역형(집행유예·실형)을 받은 인생에만", () => {
  /** 군필만 남긴 행복한 독신: 다른 조각 없이 기록만 비교한다 */
  function plain(s: GameState): GameState {
    const record = s.ch.flags.criminal_record;
    s.ch.flags = { military_done: { since: 21 } };
    if (record) s.ch.flags.criminal_record = record;
    s.ch.stats.happiness = 80;
    s.ch.npcs = s.ch.npcs.filter((n) => n.role !== 'spouse' && n.role !== 'ex' && n.role !== 'child');
    return s;
  }

  it('검토 재현: 벌금 한 번으로 웃었다가 버텼다로 바뀌지 않는다', () => {
    expect(epitaph(plain(personAt('EPI-CLEAN', 30)))).toBe('군대에서도 웃었다');
    expect(epitaph(plain(sentenced('fine', 'theft').state))).toBe('군대에서도 웃었다');
    expect(epitaph(plain(sentenced('suspended', 'theft').state))).toBe('군대에서도 버텼다');
    expect(epitaph(plain(sentenced('prison', 'escape').state))).toBe('철창 안에서도, 군대에서도 버텼다');
  });

  it("'철창 안에서도'는 실형을 산 사람에게만 붙고, 예전 저장의 태그는 예전처럼 본다", () => {
    expect(epitaph(plain(sentenced('suspended', 'theft').state))).not.toContain('철창');
    const legacy = plain(personAt('EPI-LEGACY', 30));
    legacy.ch.legal = { convictions: 1 };
    legacy.ch.flags.criminal_record = { since: 25 };
    expect(epitaph(legacy)).toBe('철창 안에서도, 군대에서도 버텼다');
  });
});

describe('수감 중에 받은 형은 이어서 살고, 출소 기록은 실제 출소 나이를 따른다', () => {
  it('검토 재현: 25세 전시 군무이탈 실형 중 26세 탈옥 시도는 형기를 늘린다 (당겨지지 않는다)', () => {
    const s = sentenced('prison', 'wartime_desertion', 25).state;
    const first = sentenceRecords(s.ch)[0].until!;
    setAge(s, 26);
    const card = playCard(s, 'prison_days', '탈옥을 계획한다')!;
    expect(card.result!.text).toContain('이어서 산다');
    const [a, b] = sentenceRecords(s.ch);
    expect(b).toMatchObject({ age: 26, crime: 'escape', kind: 'prison' });
    expect(a.until).toBe(first);
    expect(b.until).toBe(first + Math.ceil(b.months! / 12));
    expect(s.ch.legal.prisonUntil).toBe(b.until);

    // 앞 형이 끝나는 해에는 나가지 못하고, 뒤 형이 끝나야 출소한다
    setAge(s, first);
    expect(buildScope(s).legal).toMatchObject({ inPrison: true, releaseNow: false });
    setAge(s, b.until!);
    expect(buildScope(s).legal).toMatchObject({ inPrison: false, releaseNow: true });
    presentCard(s, { eventId: 'prison_release', ctx: {} });
    expect(s.ch.legal.prisonUntil).toBeUndefined();
    expect(sentenceRecords(s.ch).map((r) => r.until)).toEqual([first, b.until]);

    // 결격은 실제 출소에서 5년
    setAge(s, b.until! + 4);
    expect(barredFromJob(s.ch, 'civil_servant')).toBe(true);
    setAge(s, b.until! + 5);
    expect(barredFromJob(s.ch, 'civil_servant')).toBe(false);
  });

  it('예전 저장에서 덮어써진 형기: 출소할 때 늦게 적힌 기록을 실제 출소 나이로 고치고, 저장해도 유지된다', () => {
    const s = personAt('REC-STALE', 28);
    s.ch.legal = { convictions: 2, prisonUntil: 28 };
    addSentence(s.ch, { age: 25, crime: 'wartime_desertion', kind: 'prison', months: 58, until: 30 });
    addSentence(s.ch, { age: 26, crime: 'escape', kind: 'prison', months: 16, until: 28 });
    s.ch.flags.criminal_record = { since: 25 };
    expect(buildScope(s).legal).toMatchObject({ releaseNow: true });
    presentCard(s, { eventId: 'prison_release', ctx: {} });
    expect(sentenceRecords(s.ch).map((r) => r.until)).toEqual([28, 28]);

    const store = memoryStorage();
    expect(saveGame(s, store)).toBe(true);
    const loaded = loadGame(store)!;
    expect(sentenceRecords(loaded.ch).map((r) => r.until)).toEqual([28, 28]);
    // 결격은 실제 출소(28세)에서 5년: 예전 기록대로면 35세까지였다
    setAge(loaded, 32);
    expect(barredFromJob(loaded.ch, 'civil_servant')).toBe(true);
    setAge(loaded, 33);
    expect(barredFromJob(loaded.ch, 'civil_servant')).toBe(false);
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
});

describe('시뮬레이터 판정: 통과는 충분한 표본과 허용 범위 안의 점추정 (R-003 후속)', () => {
  it('점추정이 허용 범위 안이면 통과, 구간만 겹치면 경계, 구간까지 벗어나면 실패 (허용 범위를 함께 돌려준다)', () => {
    // 목표 64.4% ± 4%p → 허용 [60.4%, 68.4%]
    const pass = checkWithin({ value: 0.62, lo: 0.59, hi: 0.65, n: 2000 }, 0.644, 0.04);
    expect(pass).toMatchObject({ verdict: 'pass', inside: true, overlap: true });
    expect(pass.band[0]).toBeCloseTo(0.604, 10);
    expect(pass.band[1]).toBeCloseTo(0.684, 10);
    expect(pass.halfWidth).toBeCloseTo(0.03, 10);
    expect(checkWithin({ value: 0.595, lo: 0.565, hi: 0.625, n: 2000 }, 0.644, 0.04)).toMatchObject({
      verdict: 'border',
      inside: false,
      overlap: true,
    });
    expect(checkWithin({ value: 0.5, lo: 0.47, hi: 0.53, n: 2000 }, 0.644, 0.04).verdict).toBe('fail');
    // 구간이 넓어도 통째로 벗어나면 이미 실패다
    expect(checkWithin({ value: 0.3, lo: 0.2, hi: 0.4, n: 300 }, 0.644, 0.04).verdict).toBe('fail');
  });

  it('검토 재현: --n 3 (남 1·여 2)의 항목은 통과가 아니라 판정 불가다', () => {
    expect(checkWithin(lifeExpectancy([85]), 80.8, 1.5).verdict).toBe('insufficient');
    expect(checkWithin(survival([85], 80), 0.644, 0.04).verdict).toBe('insufficient');
    expect(checkWithin(lifeExpectancy([76, 77]), 86.6, 1.5).verdict).toBe('insufficient');
    expect(checkWithin(lifeExpectancy([76, 77], 60), 28.4, 1.5).verdict).toBe('insufficient');
    // 구간이 좁아도 최소 표본보다 적으면 판정하지 않는다
    expect(checkWithin({ value: 0.644, lo: 0.64, hi: 0.648, n: MIN_SAMPLE - 1 }, 0.644, 0.04).verdict).toBe('insufficient');
    expect(checkWithin(proportion(0, 0), 0.5, 0.5).verdict).toBe('insufficient');
  });

  it('검토 재현: 남성 522명의 80세 생존은 구간이 ±4%p보다 넓어 판정하지 않고, 필요한 표본을 알려 준다', () => {
    // 예전 규칙에서는 56.3%부터 72.2%까지 모두 통과였다
    const mid = checkWithin(proportion(325, 522), 0.644, 0.04);
    expect(mid.verdict).toBe('insufficient');
    expect(mid.halfWidth).toBeGreaterThan(0.04);
    expect(mid.neededN).toBeGreaterThan(522);
    expect(mid.neededN).toBeLessThan(600);
    for (const k of [294, 377]) expect(checkWithin(proportion(k, 522), 0.644, 0.04).verdict).not.toBe('pass');
    // 같은 비율이라도 표본이 넉넉하면 판정한다
    expect(checkWithin(proportion(3115, 5000), 0.644, 0.04).verdict).toBe('pass');
    expect(checkWithin(proportion(2900, 5000), 0.644, 0.04).verdict).toBe('fail');
  });

  it('종합 판정은 모든 항목이 통과일 때만 통과다. 종료 코드는 판정마다 다르다', () => {
    expect(overallVerdict(['pass', 'pass'])).toBe('pass');
    expect(overallVerdict(['pass', 'border'])).toBe('border');
    expect(overallVerdict(['border', 'insufficient', 'pass'])).toBe('insufficient');
    expect(overallVerdict(['insufficient', 'fail', 'pass'])).toBe('fail');
    expect(overallVerdict([])).toBe('insufficient');
    expect(EXIT_CODE).toEqual({ pass: 0, fail: 1, insufficient: 3, border: 4 });
  });

  it('검토 재현: npm run sim -- --n 3 은 판정 불가를 출력하고 0이 아닌 코드로 끝난다', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const out = join(tmpdir(), `lifesim-sim-tiny-${process.pid}.json`);
    const run = spawnSync(process.execPath, [tsx, 'tools/simulator/run.ts', '--n', '3', '--seed', 'TINY', '--out', out], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(run.status).toBe(EXIT_CODE.insufficient);
    expect(run.stdout).toContain('종합 판정: 판정 불가');
    expect(run.stdout).not.toContain('종합 판정: 통과');
    const report = JSON.parse(readFileSync(out, 'utf8'));
    expect(report).toMatchObject({ verdict: 'insufficient', exitCode: 3, pass: false });
    expect(report.checks).toHaveLength(7);
    expect(report.checks.every((c: { verdict: string }) => c.verdict === 'insufficient')).toBe(true);
  }, 60_000);
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
