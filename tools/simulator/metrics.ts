// 시뮬레이터 지표 계산 (순수 함수). run.ts가 쓰고, tests/records-metrics.test.ts가 작은 가짜 자료로 검산한다.
// 추정값은 모두 표본 수(분모가 되는 사람 수)와 95% 신뢰구간을 함께 가진다.

/** 95% 양측 정규 분위수 */
export const Z95 = 1.959964;

export interface Estimate {
  /** 점추정 */
  value: number;
  /** 95% 신뢰구간 */
  lo: number;
  hi: number;
  /** 표본 수 */
  n: number;
}

/** 비율 k/n과 Wilson 95% 신뢰구간. 0%·100% 근처나 작은 표본에서도 구간이 [0, 1]을 벗어나지 않는다 */
export function proportion(k: number, n: number, z = Z95): Estimate {
  if (n <= 0) return { value: NaN, lo: 0, hi: 1, n: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // 0명·전원일 때 한쪽 끝은 정확히 0·1이다 (부동소수점 오차로 0.9999…가 되지 않게)
  return { value: p, lo: k <= 0 ? 0 : Math.max(0, center - half), hi: k >= n ? 1 : Math.min(1, center + half), n };
}

function sampleVariance(xs: readonly number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1);
}

/** 평균과 95% 신뢰구간 (정규 근사, 표본 분산은 n−1로 나눈다). 두 명 미만이면 구간을 정할 수 없다 */
export function meanEstimate(xs: readonly number[], z = Z95): Estimate {
  const n = xs.length;
  if (n === 0) return { value: NaN, lo: NaN, hi: NaN, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { value: mean, lo: -Infinity, hi: Infinity, n };
  const half = z * Math.sqrt(sampleVariance(xs) / n);
  return { value: mean, lo: mean - half, hi: mean + half, n };
}

/**
 * x세 생존율 S(x): 태어난 사람 중 x세 생일을 맞은 비율. finalAges는 죽은 해의 만 나이다
 * (게임은 그해를 다 살고 연말에 죽으므로 마지막 나이가 x 이상이면 x세에 닿았다).
 */
export function survival(finalAges: readonly number[], x: number): Estimate {
  return proportion(finalAges.filter((a) => a >= x).length, finalAges.length);
}

/**
 * x세 기대여명 e(x): x세에 닿은 사람이 그 뒤로 더 산 햇수의 평균. 생명표처럼 죽음은
 * 마지막 해의 가운데로 본다(+0.5). x = 0이면 출생 시 기대수명이다.
 */
export function lifeExpectancy(finalAges: readonly number[], x = 0): Estimate {
  return meanEstimate(finalAges.filter((a) => a >= x).map((a) => a - x + 0.5));
}

/** 여성 한 명의 출산 이력: 마지막 나이와 아이를 낳은 나이들 (쌍둥이면 같은 나이가 두 번) */
export interface MotherHistory {
  finalAge: number;
  birthAges: readonly number[];
}

export interface FertilityEstimate extends Estimate {
  /** 가임 연령에 태어난 아이 수 */
  births: number;
  /** 가임 연령 여성 인년 */
  personYears: number;
  /** 나이별 출산율 f(a) */
  asfr: Record<number, number>;
}

/**
 * 합계출산율 근사: 나이별 출산율의 합 Σ f(a) (a = from…to, 기본 15~49세).
 * f(a) = a세에 낳은 아이 수 / a세를 산 여성 인년. 그해 연말에 죽어도 그 나이는 1년을 산 것으로 센다.
 * 일찍 죽은 여성은 산 나이까지만 분모에 들어가므로 '여성 한 명당 평균 자녀 수'와 다른 값이다.
 * 신뢰구간은 여성마다 Σ 1/P(a)(낳은 나이마다)를 기여분으로 보고 여성 사이의 분산으로 구한다
 * (한 사람이 여러 번 낳는 상관을 반영한다).
 */
export function fertilityRate(mothers: readonly MotherHistory[], from = 15, to = 49, z = Z95): FertilityEstimate {
  const exposure = (a: number) => mothers.filter((m) => m.finalAge >= a).length;
  const py: Record<number, number> = {};
  for (let a = from; a <= to; a++) py[a] = exposure(a);
  // 가임 연령 안, 살아 있던 나이의 출산만 센다
  const counted = mothers.map((m) => m.birthAges.filter((a) => a >= from && a <= to && a <= m.finalAge));

  const birthsAt: Record<number, number> = {};
  for (const ages of counted) for (const a of ages) birthsAt[a] = (birthsAt[a] ?? 0) + 1;
  const asfr: Record<number, number> = {};
  let tfr = 0;
  let births = 0;
  let personYears = 0;
  for (let a = from; a <= to; a++) {
    asfr[a] = py[a] > 0 ? (birthsAt[a] ?? 0) / py[a] : 0;
    tfr += asfr[a];
    births += birthsAt[a] ?? 0;
    personYears += py[a];
  }

  const n = mothers.length;
  let lo = NaN;
  let hi = NaN;
  if (n >= 2) {
    const contrib = counted.map((ages) => ages.reduce((s, a) => s + 1 / py[a], 0));
    const half = z * Math.sqrt(n * sampleVariance(contrib));
    lo = Math.max(0, tfr - half);
    hi = tfr + half;
  }
  return { value: tfr, lo, hi, n, births, personYears, asfr };
}

export interface CheckResult {
  /** 95% 신뢰구간이 허용 범위 [목표 − 허용, 목표 + 허용]과 겹친다 */
  pass: boolean;
  /** 점추정이 허용 범위 안이다 */
  inside: boolean;
}

/**
 * 허용 오차 판정. 95% 신뢰구간이 '목표 ± 허용'과 겹치면 통과한다: 표본 오차만으로는 떨어지지 않고,
 * 표본이 클수록 허용 오차 그대로 판정하게 된다. 표본이 없으면 통과하지 않는다.
 */
export function checkWithin(est: Estimate, target: number, tol: number): CheckResult {
  if (est.n === 0 || Number.isNaN(est.value)) return { pass: false, inside: false };
  const lo = target - tol;
  const hi = target + tol;
  return { pass: est.hi >= lo && est.lo <= hi, inside: est.value >= lo && est.value <= hi };
}
