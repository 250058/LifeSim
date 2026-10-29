// 사건 데이터 검증 (npm run validate)
// 없는 태그·사건 참조, 조건식 문법 오류, 확률 오류, 생애 단계별 사건 수를 확인한다.

import { eventsPerStage, eventStats, validateData } from '../../src/engine/validate';

const issues = validateData();
const errors = issues.filter((i) => i.level === 'error');
const warns = issues.filter((i) => i.level === 'warn');

for (const i of issues) console.log(`${i.level === 'error' ? '✗' : '!'} ${i.where}: ${i.message}`);

const { total, byType } = eventStats();
console.log(`\n사건 ${total}개 (${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ')})`);
console.log('생애 단계별 사건 수:');
let stageOk = true;
for (const [stage, n] of Object.entries(eventsPerStage())) {
  if (n < 3) stageOk = false;
  console.log(`  ${stage.padEnd(4)} ${String(n).padStart(3)}${n < 3 ? '  ← 3개 미만' : ''}`);
}
console.log(`\n오류 ${errors.length}개, 경고 ${warns.length}개`);
if (errors.length > 0 || total < 30 || !stageOk) process.exit(1);
