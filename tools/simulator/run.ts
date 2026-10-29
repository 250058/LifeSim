// 밸런스 시뮬레이터: npm run sim -- --n 1000 [--mode reality|drama|makjang] [--seed SIM]
//
// 기본은 현실 모드다. 2024 생명표 기준의 성별 생존 보정을 판정하고, 나머지 지표는 정의(대상·분모·기간·단위),
// 표본 수, 95% 신뢰구간과 함께 참고로만 보고한다. --mode drama·makjang은 연출 보고서다: 큰 사건이 인생마다
// 몇 개 나오는지 보고, 수명이 무너지지 않았는지만 판정한다. 한 번도 일어나지 않은 사건도 여기서 찾는다.
// 모든 인생은 같은 해(2026)에 태어난 한 코호트이고, 봇의 선택 정책은 src/engine/sim.ts에 있다.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pkg from '../../package.json';
import { EVENTS } from '../../src/engine/data';
import { BIG_IMPACT } from '../../src/engine/director';
import { eligibleYears } from '../../src/engine/eventEngine';
import { HIGH_TYPE_LABEL, josa } from '../../src/engine/format';
import { convictionCount, hasCriminalRecord, sentenceRecords, type SentenceKind } from '../../src/engine/records';
import { SAVE_VERSION } from '../../src/engine/save';
import { SCAM_REFUSE_RATE, simulateLife } from '../../src/engine/sim';
import type { GameState, Mode, Sex } from '../../src/engine/types';
import { modeMultiplier } from '../../src/engine/world';
import { checkWithin, fertilityRate, lifeExpectancy, meanEstimate, proportion, survival, type Estimate } from './metrics';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const MODES: Mode[] = ['reality', 'drama', 'makjang'];
const N = Number(arg('n', '10000'));
const MODE = arg('mode', 'reality') as Mode;
const PREFIX = arg('seed', 'SIM');
if (!Number.isInteger(N) || N < 1) {
  console.error(`--n은 1 이상의 정수여야 한다: ${arg('n', '')}`);
  process.exit(2);
}
if (!MODES.includes(MODE)) {
  console.error(`--mode는 ${MODES.join(' · ')} 중 하나다: ${MODE}`);
  process.exit(2);
}
const REALITY = MODE === 'reality';

// ── 비교 기준 ─────────────────────────────────────────────

/** 2024 생명표 (국가데이터처, 2025-12-03 발표). 기획서 보정표와 보도 기사로 확인한 값만 쓴다 */
const LIFE_TABLE = {
  source: '2024 생명표 (기간 생명표)',
  e0: { all: 83.7, M: 80.8, F: 86.6 },
  e40: { M: 41.9, F: 47.4 },
  e60: { M: 23.7, F: 28.4 },
  survive: { 80: { M: 0.644, F: 0.822 }, 100: { M: 0.012, F: 0.048 } } as Record<number, Record<Sex, number>>,
};
/** 기획서 보정표의 다른 기간 지표 */
const TABLE = {
  cancerDeath: { M: 0.245, F: 0.152, source: '생명표 사망원인별 사망확률 (기획서 보정표)' },
  firstMarriage: { M: 33.9, F: 31.6, source: '2025 평균 초혼 연령 (그해 초혼한 사람, 기간 지표)' },
  tfr: { value: 0.8, source: '2025 합계출산율 (기간 지표, 기획서 보정표)' },
  schoolViolence: '2025 1차 학교폭력 실태조사 피해응답률 2.5% (초4~고3 재학생이 조사 기간에 겪은 비율)',
};
/** 판정 허용 오차 (게임 보정 기준으로 정한 값): 기획서의 '전체 기대수명 ±3세'에 성별 기준을 더한다 */
const TOL = { e0All: 3, e0Sex: 1.5, survive80: 0.04, remaining: 1.5, cancer: 0.04, firstMarriage: 1.5, tfr: 0.15 };

// ── 시뮬레이션 ────────────────────────────────────────────

const t0 = Date.now();
const lives: GameState[] = [];
const eventCount: Record<string, number> = {};
const livesWith: Record<string, number> = {};
for (let i = 0; i < N; i++) {
  const s = simulateLife(`${PREFIX}-${i}`, { mode: MODE });
  for (const [id, n] of Object.entries(s.counts)) {
    eventCount[id] = (eventCount[id] ?? 0) + n;
    livesWith[id] = (livesWith[id] ?? 0) + 1;
  }
  // 메모리를 아끼려고 필요한 것만 남긴다
  s.log = [];
  lives.push(s);
}
const secs = (Date.now() - t0) / 1000;

// ── 집계 도구 ─────────────────────────────────────────────

type Unit = 'pct' | 'years' | 'num';
const SEXES: [Sex, string][] = [['M', '남'], ['F', '여']];
const bySex = (sex: Sex) => lives.filter((s) => s.ch.sex === sex);
const ages = (ls: GameState[]) => ls.map((s) => s.ch.age);
const reached = (ls: GameState[], age: number) => ls.filter((s) => s.ch.age >= age);
const share = (ls: GameState[], pred: (s: GameState) => boolean) => proportion(ls.filter(pred).length, ls.length);
const children = (s: GameState) => s.ch.npcs.filter((n) => n.role === 'child');
const everMarried = (s: GameState) => s.ch.npcs.some((n) => n.role === 'spouse' || n.role === 'ex');
const firstMarriageAge = (s: GameState) => {
  const since = s.ch.npcs.filter((n) => (n.role === 'spouse' || n.role === 'ex') && n.since !== undefined).map((n) => n.since!);
  return since.length > 0 ? Math.min(...since) : undefined;
};

function fmt(x: number, unit: Unit): string {
  if (!Number.isFinite(x)) return '—';
  if (unit === 'pct') return `${(x * 100).toFixed(1)}%`;
  return x.toFixed(unit === 'num' ? 2 : 1);
}
const fmtCI = (e: Estimate, unit: Unit) => `[${fmt(e.lo, unit)}, ${fmt(e.hi, unit)}]`;
const fmtTol = (tol: number, unit: Unit) => (unit === 'pct' ? `±${Math.round(tol * 100)}%p` : `±${tol}`);

interface Metric {
  id: string;
  label: string;
  unit: Unit;
  est: Estimate;
  /** 대상과 분모, 단위 */
  def: string;
  /** 비교 기준과 비교 가능성 */
  note?: string;
}
interface Check extends Metric {
  target: number;
  tol: number;
  pass: boolean;
  inside: boolean;
}

const metrics: Metric[] = [];
const checks: Check[] = [];

function metric(m: Metric): Metric {
  metrics.push(m);
  console.log(`  ${m.label.padEnd(18)} ${fmt(m.est.value, m.unit).padStart(7)}  ${fmtCI(m.est, m.unit)}`);
  console.log(`      ${m.def}${m.note ? ` · ${m.note}` : ''}`);
  return m;
}

/** 목표와 허용 오차가 있는 항목. required면 종합 판정에 들어간다 */
function check(m: Metric, target: number, tol: number, required: boolean): Check {
  const c: Check = { ...m, target, tol, ...checkWithin(m.est, target, tol) };
  if (required) checks.push(c);
  else metrics.push(c);
  const verdict = c.pass ? (c.inside ? '통과' : '통과 (구간만 겹침)') : '벗어남';
  console.log(
    `  ${c.label.padEnd(18)} ${fmt(c.est.value, c.unit).padStart(7)}  ${fmtCI(c.est, c.unit).padEnd(17)} 목표 ${fmt(target, c.unit)} ${fmtTol(tol, c.unit)}  ${required ? verdict : `참고: ${verdict}`}`,
  );
  console.log(`      ${c.def}${c.note ? ` · ${c.note}` : ''}`);
  return c;
}

/** 목록형 한 줄: 값과 분자/분모 */
const listRow = (label: string, e: Estimate) =>
  console.log(`  ${label.padEnd(24)} ${fmt(e.value, 'pct').padStart(7)}  ${(e.n > 0 ? `(${Math.round(e.value * e.n)}/${e.n})` : '(표본 없음)').padStart(13)}`);

// ── 머리말 ────────────────────────────────────────────────

const dataHash = createHash('sha1').update(JSON.stringify(EVENTS)).digest('hex').slice(0, 10);
const botPolicy =
  `무직이면 구직, 시간은 공부·운동·친구 등 안전한 활동(위험 활동 1%), 선택지는 40% 첫 번째·60% 무작위, ` +
  `사기 아크(보이스피싱·감금 단지)는 ${Math.round(SCAM_REFUSE_RATE * 100)}% 끊기·거절·신고`;
const command = `npm run sim -- --n ${N} --mode ${MODE} --seed ${PREFIX}`;

console.log(`\n대한민국 인생 시뮬레이터 · ${REALITY ? '현실 보정 보고서' : '연출 보고서'}`);
console.log(`  실행: ${command} · ${secs.toFixed(1)}초`);
console.log(`  표본: ${N.toLocaleString()}명 (남 ${bySex('M').length.toLocaleString()} · 여 ${bySex('F').length.toLocaleString()}), 시드 ${PREFIX}-0 … ${PREFIX}-${N - 1}`);
console.log(`  버전: 엔진 ${pkg.version} · 저장 형식 v${SAVE_VERSION} · 사건 ${EVENTS.length.toLocaleString()}개 (sha1 ${dataHash})`);
console.log(`  봇: ${botPolicy} (src/engine/sim.ts)`);
console.log(`  기간: 모든 모의 지표는 2026년생 한 코호트를 죽을 때까지 따라간 값이다. 비교 기준은 대부분 한 해의 기간 지표다.`);
console.log(`  [ ]는 95% 신뢰구간 (비율은 Wilson, 평균은 정규 근사). 판정은 신뢰구간이 '목표 ± 허용'과 겹치면 통과.`);

// ── 생존 ──────────────────────────────────────────────────

console.log(`\n생존 — ${REALITY ? '판정 대상' : '연출 모드 안전 기준 (생명표 보정 판정은 --mode reality)'}`);
check(
  { id: 'e0', label: '기대수명 (전체)', unit: 'years', est: lifeExpectancy(ages(lives)), def: `모든 인생 ${N}명, 죽은 해의 만 나이 + 0.5의 평균 (세)`, note: `비교: ${LIFE_TABLE.source}` },
  LIFE_TABLE.e0.all,
  TOL.e0All,
  true,
);
for (const [sex, ko] of SEXES) {
  const ls = bySex(sex);
  check(
    { id: `e0_${sex}`, label: `기대수명 (${ko})`, unit: 'years', est: lifeExpectancy(ages(ls)), def: `${ko}성 인생 ${ls.length}명 (세)`, note: `비교: ${LIFE_TABLE.source}` },
    LIFE_TABLE.e0[sex],
    TOL.e0Sex,
    REALITY,
  );
  check(
    { id: `s80_${sex}`, label: `80세 생존 (${ko})`, unit: 'pct', est: survival(ages(ls), 80), def: `${ko}성 인생 ${ls.length}명 중 80세 생일을 맞은 비율`, note: `비교: ${LIFE_TABLE.source}` },
    LIFE_TABLE.survive[80][sex],
    TOL.survive80,
    REALITY,
  );
  check(
    { id: `e60_${sex}`, label: `60세 기대여명 (${ko})`, unit: 'years', est: lifeExpectancy(ages(ls), 60), def: `60세에 닿은 ${ko}성 ${reached(ls, 60).length}명이 더 산 햇수 + 0.5의 평균 (년)`, note: `비교: ${LIFE_TABLE.source}` },
    LIFE_TABLE.e60[sex],
    TOL.remaining,
    REALITY,
  );
}

console.log('\n나이별 생존율 S(x) (참고: 태어난 사람 중 x세 생일을 맞은 비율, 성별 인생 수가 분모)');
console.log(`  ${'x'.padStart(4)}  ${'남 S(x) [95% CI]'.padEnd(28)}${'여 S(x) [95% CI]'.padEnd(28)}생명표 남 / 여`);
for (const x of [1, 20, 40, 65, 80, 90, 100]) {
  const cells = SEXES.map(([sex]) => {
    const e = survival(ages(bySex(sex)), x);
    metrics.push({ id: `S${x}_${sex}`, label: `${x}세 생존 (${sex})`, unit: 'pct', est: e, def: `${sex} 인생 중 ${x}세 생일을 맞은 비율` });
    return `${fmt(e.value, 'pct')} ${fmtCI(e, 'pct')}`.padEnd(28);
  });
  const lt = LIFE_TABLE.survive[x];
  console.log(`  ${String(x).padStart(4)}  ${cells.join('')}${lt ? `${fmt(lt.M, 'pct')} / ${fmt(lt.F, 'pct')}` : '—'}`);
}
for (const [sex, ko] of SEXES) {
  const ls = bySex(sex);
  check(
    { id: `e40_${sex}`, label: `40세 기대여명 (${ko})`, unit: 'years', est: lifeExpectancy(ages(ls), 40), def: `40세에 닿은 ${ko}성 ${reached(ls, 40).length}명 (년)`, note: `비교: ${LIFE_TABLE.source}` },
    LIFE_TABLE.e40[sex],
    TOL.remaining,
    false,
  );
}

// ── 사망 원인 ─────────────────────────────────────────────

console.log('\n사망 원인 (참고)');
for (const [sex, ko] of SEXES) {
  const ls = bySex(sex);
  check(
    { id: `cancer_${sex}`, label: `암 사망 (${ko})`, unit: 'pct', est: share(ls, (s) => s.ch.death?.cause === '암'), def: `${ko}성 인생 ${ls.length}명 중 사인이 암인 비율 (평생)`, note: `비교: ${TABLE.cancerDeath.source}` },
    TABLE.cancerDeath[sex],
    TOL.cancer,
    false,
  );
}

// ── 출산·혼인 ─────────────────────────────────────────────

console.log('\n출산·혼인 (참고)');
const women = bySex('F');
const fertility = fertilityRate(women.map((s) => ({ finalAge: s.ch.age, birthAges: children(s).map((k) => k.birthYear - s.ch.birthYear) })));
check(
  {
    id: 'tfr_proxy',
    label: '합계출산율 근사',
    unit: 'num',
    est: fertility,
    def: `여성 주인공 ${women.length}명의 15~49세 나이별 출산율 합 = Σ(a세 출생아 / a세 여성 인년), 출생아 ${fertility.births}명 / ${fertility.personYears.toLocaleString()}인년`,
    note: `비교: ${TABLE.tfr.source}. 모의는 한 코호트, 기준은 한 해라 근사 비교다`,
  },
  TABLE.tfr.value,
  TOL.tfr,
  false,
);
const women50 = reached(women, 50);
metric({
  id: 'completed_fertility',
  label: '50세 여성 출생아 수',
  unit: 'num',
  est: meanEstimate(women50.map((s) => children(s).filter((k) => k.birthYear - s.ch.birthYear < 50).length)),
  def: `50세에 닿은 여성 ${women50.length}명이 50세 전에 낳은 아이 수 평균 (코호트 완결 출산력)`,
});
metric({
  id: 'children_per_life',
  label: '인생당 자녀 수',
  unit: 'num',
  est: meanEstimate(lives.map((s) => children(s).length)),
  def: `남녀 모든 인생 ${N}명의 자녀 수 평균 (일찍 죽은 사람 포함)`,
  note: '합계출산율과 정의가 달라 비교하지 않는다',
});
for (const [sex, ko] of SEXES) {
  const married = bySex(sex).map(firstMarriageAge).filter((a): a is number => a !== undefined);
  check(
    { id: `first_marriage_${sex}`, label: `평균 초혼 나이 (${ko})`, unit: 'years', est: meanEstimate(married), def: `결혼한 ${ko}성 주인공 ${married.length}명의 첫 혼인 나이 평균 (세, 코호트)`, note: `비교: ${TABLE.firstMarriage.source}` },
    TABLE.firstMarriage[sex],
    TOL.firstMarriage,
    false,
  );
}
for (const [sex, ko] of SEXES) {
  const ls = reached(bySex(sex), 50);
  metric({
    id: `married_by50_${sex}`,
    label: `50세 전 혼인 (${ko})`,
    unit: 'pct',
    est: share(ls, (s) => (firstMarriageAge(s) ?? 99) < 50),
    def: `50세에 닿은 ${ko}성 ${ls.length}명 중 50세 전에 결혼한 비율`,
  });
}
const married = lives.filter(everMarried);
metric({ id: 'divorced', label: '이혼 경험', unit: 'pct', est: share(married, (s) => Boolean(s.ch.flags.divorced)), def: `결혼한 적 있는 ${married.length}명 중 이혼한 비율 (평생)` });

// ── 사법 기록 ─────────────────────────────────────────────

const KIND_LABEL: Record<SentenceKind, string> = {
  suspended_prosecution: '기소유예',
  juvenile: '소년보호처분',
  fine: '벌금',
  probation: '집행유예',
  prison: '실형',
};
console.log('\n사법 기록 (참고, 정의는 src/engine/records.ts: 전과 = 벌금 이상 유죄 판결)');
const adults = reached(lives, 19);
const recorded = (s: GameState) => hasCriminalRecord(s.ch);
metric({ id: 'criminal_record', label: '전과', unit: 'pct', est: share(lives, recorded), def: `모든 인생 ${N}명 중 벌금 이상 유죄 판결이 한 번이라도 있는 비율 (평생)` });
metric({ id: 'criminal_record_adult', label: '전과 (19세 이상)', unit: 'pct', est: share(adults, recorded), def: `19세에 닿은 ${adults.length}명 기준` });
const convicted = lives.filter(recorded);
metric({ id: 'repeat_offender', label: '재범 (유죄 2회 이상)', unit: 'pct', est: share(convicted, (s) => convictionCount(s.ch) >= 2), def: `전과가 있는 ${convicted.length}명 중` });
for (const kind of Object.keys(KIND_LABEL) as SentenceKind[]) {
  listRow(`${josa(KIND_LABEL[kind], '을/를')} 받은 적 있음`, share(lives, (s) => sentenceRecords(s.ch).some((r) => r.kind === kind)));
}

// ── 인생 경로 ─────────────────────────────────────────────

console.log('\n인생 경로 (참고)');
const schoolAge = reached(lives, 10);
metric({
  id: 'school_violence_lifetime',
  label: '학폭 피해 (평생)',
  unit: 'pct',
  est: share(schoolAge, (s) => (s.counts.sv_start ?? 0) > 0),
  def: `10세에 닿은 ${schoolAge.length}명 중 학폭 아크(sv_start)를 한 번이라도 겪은 비율 (평생 경험률)`,
  note: `비교 불가: ${TABLE.schoolViolence}과 기간·대상이 다르다`,
});
const grown25 = reached(lives, 25);
metric({ id: 'college', label: '대학 졸업', unit: 'pct', est: share(grown25, (s) => ['university', 'college'].includes(s.ch.edu.degree)), def: `25세에 닿은 ${grown25.length}명 중 전문대·대학 졸업 비율` });
const men30 = reached(bySex('M'), 30);
metric({ id: 'military_done', label: '군필 (남)', unit: 'pct', est: share(men30, (s) => Boolean(s.ch.flags.military_done)), def: `30세에 닿은 남성 ${men30.length}명 중 복무를 마친 비율` });
const grown40 = reached(lives, 40);
metric({ id: 'homeowner', label: '자가 보유 (사망 시)', unit: 'pct', est: share(grown40, (s) => Boolean(s.ch.flags.homeowner)), def: `40세에 닿은 ${grown40.length}명 중 죽을 때 집을 가진 비율` });
metric({
  id: 'events_per_year',
  label: '연간 사건 수',
  unit: 'num',
  est: meanEstimate(lives.map((s) => Object.values(s.counts).reduce((a, b) => a + b, 0) / (s.ch.age + 1))),
  def: `인생마다 (기록된 사건 카드 수 ÷ 산 햇수)의 평균, ${N}명 (마일스톤·세계 사건·생활 풀 포함)`,
});

// ── 희귀 사건 (연출 목표) ─────────────────────────────────

/**
 * 큰 사건: 드라마 모드가 배수를 올리는 사건(명목 평생 확률 30% 미만, world.ts) 중 충격량이 디렉터의
 * '큰 사건' 기준(BIG_IMPACT) 이상인 것. 생활 풀·일상 채움·인구통계(noMode) 사건은 배수를 받지 않으므로 빠진다.
 */
const BIG = new Set(
  EVENTS.filter(
    (e) => e.weight && !e.pool && !e.filler && !e.weight.noMode && (e.impact ?? 0) >= BIG_IMPACT && modeMultiplier('drama', e.weight.base, eligibleYears(e)) > 1,
  ).map((e) => e.id),
);
const bigPerLife = lives.map((s) => Object.keys(s.counts).filter((id) => BIG.has(id)).length);
console.log(`\n큰 사건 (${REALITY ? '참고' : '연출 목표: 인생마다 큰 사건 한두 개. 판정하지 않는다'})`);
metric({
  id: 'big_events_per_life',
  label: '인생당 큰 사건',
  unit: 'num',
  est: meanEstimate(bigPerLife),
  def: `모든 인생 ${N}명이 겪은 큰 사건 종류 수의 평균. 큰 사건 = 드라마 배수를 받는 사건 중 충격량 ${BIG_IMPACT} 이상인 ${BIG.size}개`,
});
listRow('큰 사건 0개', proportion(bigPerLife.filter((k) => k === 0).length, N));
listRow('큰 사건 1~2개', proportion(bigPerLife.filter((k) => k >= 1 && k <= 2).length, N));
listRow('큰 사건 3개 이상', proportion(bigPerLife.filter((k) => k >= 3).length, N));

// ── 목록형 참고 (분모는 제목에 적었다) ─────────────────────

console.log('\n고등학교 유형 (18세에 닿은 사람 기준)');
const grown18 = reached(lives, 18);
const highTypes: Record<string, number> = {};
for (const s of grown18) {
  const key = s.ch.edu.highType ? HIGH_TYPE_LABEL[s.ch.edu.highType] : '고교 미진학';
  highTypes[key] = (highTypes[key] ?? 0) + 1;
}
for (const [k, n] of Object.entries(highTypes).sort((a, b) => b[1] - a[1])) listRow(k, proportion(n, grown18.length));
listRow('자퇴', share(grown18, (s) => Boolean(s.ch.flags.dropout)));
listRow('검정고시 합격', share(grown18, (s) => Boolean(s.ch.flags.ged)));
listRow('수시·실기·특기자로 진학', share(grown18, (s) => Boolean(s.ch.flags.early_admission)));

const everCount = (id: string) => proportion(livesWith[id] ?? 0, N);
console.log('\n희귀·초희귀 사건 (모든 인생 중 한 번 이상 겪은 비율)');
for (const id of ['overseas_job_offer', 'compound_arrival', 'compound_death', 'casting_offer', 'trainee_debut', 'political_offer', 'presidential_run', 'lotto_jackpot', 'parents_divorce', 'jeonse_fraud', 'phishing_call', 'phishing_loss', 'courier_offer', 'courier_arrest', 'mil_abuse_start']) {
  listRow(id, everCount(id));
}
listRow('대통령 당선', share(lives, (s) => Boolean(s.ch.flags.president)));

console.log('\n재난·전쟁 (모든 인생 중 한 번 이상 겪은 비율)');
for (const id of ['missile_alert', 'skirmish_border', 'war_outbreak', 'war_outbreak_child', 'war_combat', 'war_kia', 'war_end_unification', 'house_fire', 'workplace_fire', 'fire_death', 'earthquake', 'typhoon', 'banjiha_flood', 'heatwave', 'wildfire', 'crowd_crush', 'random_attack']) {
  listRow(id, everCount(id));
}
listRow('전쟁을 겪음', share(lives, (s) => s.world.war.startYear !== undefined));
listRow('통일을 봄', share(lives, (s) => s.world.unified));

console.log('\n옷·식단·생활 (모든 인생 중 죽을 때 이 태그가 있던 비율)');
for (const flag of ['style_basic', 'style_trendy', 'style_luxury', 'style_comfort', 'diet_healthy', 'diet_junk', 'diet_vegan', 'has_pet']) {
  listRow(flag, share(lives, (s) => Boolean(s.ch.flags[flag])));
}

const causes: Record<string, number> = {};
for (const s of lives) causes[s.ch.death?.cause ?? '?'] = (causes[s.ch.death?.cause ?? '?'] ?? 0) + 1;
console.log('\n사망 원인 상위 (모든 인생 기준)');
for (const [cause, n] of Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 10)) listRow(cause, proportion(n, N));

const never = EVENTS.filter((e) => !eventCount[e.id]).map((e) => e.id);
console.log(`\n이 표본에서 한 번도 일어나지 않은 사건 ${never.length}개 (도달 불가능하다는 뜻은 아니다): ${never.length ? never.join(', ') : '없음'}`);

// ── 종합 판정 ─────────────────────────────────────────────

const pass = checks.every((c) => c.pass);
const passScope = REALITY
  ? `현실 모드 생존 보정 ${checks.length}항목 (기대수명 전체 ±${TOL.e0All}세, 성별 기대수명 ±${TOL.e0Sex}세, 성별 80세 생존 ±${Math.round(TOL.survive80 * 100)}%p, 성별 60세 기대여명 ±${TOL.remaining}년). 출산·혼인·사망 원인·사법·사건 빈도는 참고 지표라 판정하지 않았다`
  : `연출 모드 안전 기준 ${checks.length}항목 (기대수명 전체 ${LIFE_TABLE.e0.all} ±${TOL.e0All}세: 사건 배수가 수명을 무너뜨리지 않았는지). 생명표 보정은 --mode reality에서 판정한다`;
const failed = checks.filter((c) => !c.pass).map((c) => c.label);
console.log(`\n종합 판정: ${pass ? '통과' : `실패 (${failed.join(', ')})`} — ${passScope}.`);

const plain = (m: Metric | Check) => ({ ...m, est: undefined, value: m.est.value, lo: m.est.lo, hi: m.est.hi, n: m.est.n });
writeFileSync(
  new URL('./report.json', import.meta.url),
  JSON.stringify(
    {
      command,
      N,
      mode: MODE,
      seedPrefix: PREFIX,
      seconds: secs,
      version: { engine: pkg.version, save: SAVE_VERSION, events: EVENTS.length, dataSha1: dataHash },
      botPolicy,
      lifeExpectancy: lifeExpectancy(ages(lives)).value,
      pass,
      passScope,
      checks: checks.map(plain),
      metrics: metrics.map(plain),
      fertility: { births: fertility.births, personYears: fertility.personYears, asfr: fertility.asfr },
      eventCount,
      livesWith,
      causes,
      never,
    },
    null,
    2,
  ),
);
if (!pass) process.exit(1);
