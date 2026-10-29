// 사법 기록: 처분 이력은 ch.legal.records 한 곳에만 쌓는다. 전과 여부·재범 판정·채용 영향·통계는
// 모두 이 파일의 함수로 계산해서, 시뮬레이터 통계·화면 태그·채용(career.ts)이 같은 정의를 쓴다.
//
//   처분            전과    채용 (배수는 게임 보정값, 기간 구조만 법에서 가져왔다)
//   기소유예        아니다  영향 없음
//   소년보호처분    아니다  영향 없음 (소년법 32조 6항: 장래 신상에 영향을 주지 않는다)
//   벌금            맞다    실효(2년, 형실효법 7조) 전까지 ×0.9. 일반 범죄의 벌금은 공무원 결격이 아니다
//   집행유예        맞다    유예 기간 중 ×0.65. 공공 부문은 유예가 끝나고 2년까지 결격 (국가공무원법 33조 4호)
//   실형            맞다    실효(출소 뒤 5년, 3년 넘는 형은 10년) 전까지 ×0.45, 그 뒤에도 공백 때문에 ×0.8.
//                           공공 부문은 출소 뒤 5년까지 결격 (33조 3호)
//
// records 필드가 생기기 전의 저장에는 판결 종류가 없다. 없는 과거를 만들어 넣지 않고, 그런 판결은
// 예전 규칙 그대로 둔다: 전과 태그가 있으면 채용 ×0.45, 벌금(태그 없음)은 영향 없음.

import type { Character } from './types';

/** 처분 종류: 기소유예, 소년보호처분, 벌금, 집행유예, 실형 */
export type SentenceKind = 'suspended_prosecution' | 'juvenile' | 'fine' | 'probation' | 'prison';

export interface SentenceRecord {
  /** 처분을 받은 나이 */
  age: number;
  /** justice.ts CRIMES의 id */
  crime: string;
  kind: SentenceKind;
  /** 벌금 (원, 선고한 해의 명목액) */
  amount?: number;
  /** 선고한 징역 (개월) */
  months?: number;
  /** 벌금이 실효되는 나이, 집행유예가 끝나는 나이, 실형은 출소 나이 */
  until?: number;
}

/** 전과(유죄 판결)로 치는 처분 */
export const CONVICTION_KINDS: readonly SentenceKind[] = ['fine', 'probation', 'prison'];

/** 결격 사유를 따지는 직업: 공무원·교사·부사관·공기업·변호사 (국가공무원법 33조, 군인사법 10조, 변호사법 5조) */
export const BARRED_JOBS: readonly string[] = ['civil_servant', 'teacher', 'nco', 'public_tech', 'lawyer'];

/** 기록이 남아 있는 동안의 채용 배수 */
const HIRE_FACTOR = { fine: 0.9, probation: 0.65, prison: 0.45 } as const;
/** 실형은 기록이 실효된 뒤에도 경력 공백이 남는다 */
const PRISON_AFTER_EXPIRY = 0.8;
/** 판결 종류를 모르는 기존 저장의 전과 태그 (예전 규칙) */
const LEGACY_FACTOR = 0.45;

/** 형 실효 기간 (형실효법 7조): 벌금 2년, 3년 이하 징역 5년, 3년 넘는 징역 10년 */
export const FINE_EXPIRY_YEARS = 2;

type LegalWithRecords = Character['legal'] & { records?: SentenceRecord[] };

/** 처분 이력. 기존 저장에는 필드가 없으므로 빈 목록으로 읽는다 */
export function sentenceRecords(ch: Character): readonly SentenceRecord[] {
  return (ch.legal as LegalWithRecords).records ?? [];
}

export function addSentence(ch: Character, record: SentenceRecord): void {
  const legal = ch.legal as LegalWithRecords;
  (legal.records ??= []).push(record);
}

function isConviction(r: SentenceRecord): boolean {
  return CONVICTION_KINDS.includes(r.kind);
}

/**
 * 유죄 판결 수 (재범 판정에 쓴다). 기소유예·소년보호처분은 세지 않는다.
 * 기존 저장은 records 없이 convictions만 있으므로 둘 중 큰 값을 쓴다.
 */
export function convictionCount(ch: Character): number {
  return Math.max(ch.legal.convictions, sentenceRecords(ch).filter(isConviction).length);
}

/** 전과: 벌금 이상 유죄 판결이 한 번이라도 있다. 통계·화면·채용이 모두 이 정의를 쓴다 */
export function hasCriminalRecord(ch: Character): boolean {
  return convictionCount(ch) > 0 || Boolean(ch.flags.criminal_record);
}

/**
 * 판결 종류를 모르는 예전 전과 태그인가. 예전 코드는 벌금에 태그를 붙이지 않았으므로,
 * 첫 처분 기록보다 먼저 붙은 태그는 집행유예나 실형에서 왔다.
 */
function legacyTagged(ch: Character): boolean {
  const tag = ch.flags.criminal_record;
  if (!tag) return false;
  const first = Math.min(...sentenceRecords(ch).map((r) => r.age));
  return tag.since < first;
}

/** 실형을 산 적이 있는가 (기존 저장의 태그는 예전처럼 실형으로 본다) */
export function servedPrison(ch: Character): boolean {
  return sentenceRecords(ch).some((r) => r.kind === 'prison') || legacyTagged(ch);
}

/** 실형 기록이 실효되는 나이 */
function prisonExpiry(r: SentenceRecord): number {
  const release = r.until ?? r.age;
  return release + ((r.months ?? 0) > 36 ? 10 : 5);
}

/** 처분 한 건의 채용 배수 */
function factorOf(r: SentenceRecord, age: number): number {
  switch (r.kind) {
    case 'fine':
      return age < (r.until ?? r.age + FINE_EXPIRY_YEARS) ? HIRE_FACTOR.fine : 1;
    case 'probation':
      return age < (r.until ?? r.age + 2) ? HIRE_FACTOR.probation : 1;
    case 'prison':
      return age < prisonExpiry(r) ? HIRE_FACTOR.prison : PRISON_AFTER_EXPIRY;
    default:
      return 1;
  }
}

/** 사법 기록 때문에 붙는 채용 배수 (1 = 영향 없음). 여러 건이면 가장 무거운 한 건만 본다 */
export function recordHireFactor(ch: Character): number {
  let f = legacyTagged(ch) ? LEGACY_FACTOR : 1;
  for (const r of sentenceRecords(ch)) f = Math.min(f, factorOf(r, ch.age));
  return f;
}

/** 결격 기간이라 이 직업에 지원할 수 없는가 */
export function barredFromJob(ch: Character, jobId: string): boolean {
  if (!BARRED_JOBS.includes(jobId)) return false;
  return sentenceRecords(ch).some(
    (r) =>
      (r.kind === 'probation' && ch.age < (r.until ?? r.age + 2) + 2) ||
      (r.kind === 'prison' && ch.age < (r.until ?? r.age) + 5),
  );
}
