// 밸런스 시뮬레이터 (npm run sim -- --n 10000 --mode drama)
// 1만 명을 자동으로 살게 해서 평균 수명, 학폭 경험률, 초희귀 사건 발생률 등을
// 보정표와 비교한다. 한 번도 일어나지 않는 사건도 여기서 찾는다.

import { writeFileSync } from 'node:fs';
import { EVENTS } from '../../src/engine/data';
import { HIGH_TYPE_LABEL } from '../../src/engine/format';
import { simulateLife } from '../../src/engine/sim';
import type { GameState, Mode } from '../../src/engine/types';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const N = Number(arg('n', '10000'));
const MODE = arg('mode', 'drama') as Mode;
const PREFIX = arg('seed', 'SIM');

/** 보정표 목표값 */
const TARGET = {
  lifeExpectancy: 83.7,
  lifeExpectancyM: 80.8,
  lifeExpectancyF: 86.6,
  survive80M: 0.644,
  survive80F: 0.822,
  cancerDeathM: 0.245,
  cancerDeathF: 0.152,
  firstMarriageM: 33.9,
  firstMarriageF: 31.6,
};

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

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const males = lives.filter((s) => s.ch.sex === 'M');
const females = lives.filter((s) => s.ch.sex === 'F');
// 생명표의 기대수명은 연속값이므로 '죽은 해의 만 나이'에 0.5를 더해 비교한다
const e0 = (ls: GameState[]) => mean(ls.map((s) => s.ch.age)) + 0.5;
const survive80 = (ls: GameState[]) => ls.filter((s) => s.ch.age >= 80).length / Math.max(1, ls.length);
const cancerShare = (ls: GameState[]) => ls.filter((s) => s.ch.death?.cause === '암').length / Math.max(1, ls.length);
const firstMarriage = (ls: GameState[]) =>
  mean(
    ls
      .map((s) => s.ch.npcs.filter((n) => (n.role === 'spouse' || n.role === 'ex') && n.since !== undefined).map((n) => n.since!))
      .filter((a) => a.length > 0)
      .map((a) => Math.min(...a)),
  );

const lifeAll = e0(lives);
const ok = Math.abs(lifeAll - TARGET.lifeExpectancy) <= 3;

const causes: Record<string, number> = {};
for (const s of lives) causes[s.ch.death?.cause ?? '?'] = (causes[s.ch.death?.cause ?? '?'] ?? 0) + 1;

const row = (label: string, value: string, target?: string) =>
  console.log(`  ${label.padEnd(22)} ${value.padStart(9)}${target ? `   목표 ${target}` : ''}`);

console.log(`\n대한민국 인생 시뮬레이터 · 밸런스 검사`);
console.log(`  ${N.toLocaleString()}명 · ${MODE} 모드 · ${secs.toFixed(1)}초\n`);
console.log('수명 (보정표: 2024 생명표)');
row('기대수명 (전체)', lifeAll.toFixed(1), `${TARGET.lifeExpectancy} ±3  ${ok ? '통과' : '실패'}`);
row('기대수명 (남)', e0(males).toFixed(1), String(TARGET.lifeExpectancyM));
row('기대수명 (여)', e0(females).toFixed(1), String(TARGET.lifeExpectancyF));
row('80세까지 생존 (남)', pct(survive80(males)), pct(TARGET.survive80M));
row('80세까지 생존 (여)', pct(survive80(females)), pct(TARGET.survive80F));
row('암 사망 (남)', pct(cancerShare(males)), pct(TARGET.cancerDeathM));
row('암 사망 (여)', pct(cancerShare(females)), pct(TARGET.cancerDeathF));

console.log('\n인생 경로');
const share = (id: string) => (livesWith[id] ?? 0) / N;
row('학폭 피해 (평생)', pct(share('sv_start')));
row('결혼한 적 있음', pct(lives.filter((s) => s.ch.npcs.some((n) => n.role === 'spouse' || n.role === 'ex')).length / N));
row('평균 초혼 나이 (남)', firstMarriage(males).toFixed(1), String(TARGET.firstMarriageM));
row('평균 초혼 나이 (여)', firstMarriage(females).toFixed(1), String(TARGET.firstMarriageF));
row('이혼 경험', pct(lives.filter((s) => s.ch.flags.divorced).length / N));
row('자녀 수 평균', mean(lives.map((s) => s.ch.npcs.filter((n) => n.role === 'child').length)).toFixed(2), '합계출산율 0.80');
row('대학 졸업', pct(lives.filter((s) => ['university', 'college'].includes(s.ch.edu.degree)).length / N));
row('군필 (남)', pct(males.filter((s) => s.ch.flags.military_done).length / Math.max(1, males.length)));
row('전과', pct(lives.filter((s) => s.ch.flags.criminal_record).length / N));
row('내 집 마련', pct(lives.filter((s) => s.ch.flags.homeowner).length / N));
row('연간 사건 수 평균', (mean(lives.map((s) => Object.values(s.counts).reduce((a, b) => a + b, 0) / Math.max(1, s.ch.age + 1)))).toFixed(2));

console.log('\n고등학교 유형 (18세 이상 산 사람 기준)');
const grown = lives.filter((s) => s.ch.age >= 18);
const highTypes: Record<string, number> = {};
for (const s of grown) {
  const key = s.ch.edu.highType ? HIGH_TYPE_LABEL[s.ch.edu.highType] : '고교 미진학';
  highTypes[key] = (highTypes[key] ?? 0) + 1;
}
for (const [k, n] of Object.entries(highTypes).sort((a, b) => b[1] - a[1])) row(k, pct(n / Math.max(1, grown.length)));
row('자퇴', pct(grown.filter((s) => s.ch.flags.dropout).length / Math.max(1, grown.length)));
row('검정고시 합격', pct(grown.filter((s) => s.ch.flags.ged).length / Math.max(1, grown.length)));
row('수시·실기·특기자로 진학', pct(grown.filter((s) => s.ch.flags.early_admission).length / Math.max(1, grown.length)));

console.log('\n희귀·초희귀 사건 (인생 중 한 번 이상)');
for (const id of ['overseas_job_offer', 'compound_arrival', 'compound_death', 'casting_offer', 'trainee_debut', 'political_offer', 'presidential_run', 'lotto_jackpot', 'parents_divorce', 'jeonse_fraud', 'phishing_loss', 'courier_arrest', 'mil_abuse_start']) {
  row(id, `${(livesWith[id] ?? 0)}명`, pct(share(id)));
}
row('대통령 당선', `${lives.filter((s) => s.ch.flags.president).length}명`);

console.log('\n사망 원인 상위');
for (const [cause, n] of Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 10)) row(cause, pct(n / N));

const never = EVENTS.filter((e) => !eventCount[e.id]).map((e) => e.id);
console.log(`\n한 번도 일어나지 않은 사건: ${never.length ? never.join(', ') : '없음'}`);

writeFileSync(
  new URL('./report.json', import.meta.url),
  JSON.stringify({ N, mode: MODE, lifeExpectancy: lifeAll, pass: ok, eventCount, livesWith, causes, never }, null, 2),
);
if (!ok) process.exit(1);
