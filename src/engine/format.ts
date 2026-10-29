// 표시용 서식: 돈(만·억 단위), 한국어 조사, 생애 단계 이름.

import type { HighType, StageId } from './types';

const MINUS = '−';

/** 1370000000 → '13억 7,000만 원', 52000 → '5만 2,000원' */
export function formatWon(value: number): string {
  const n = Math.round(value);
  const sign = n < 0 ? MINUS : '';
  const abs = Math.abs(n);
  if (abs >= 1e8) {
    const eok = Math.floor(abs / 1e8);
    const man = Math.round((abs % 1e8) / 1e4);
    if (man === 10000) return `${sign}${(eok + 1).toLocaleString('ko-KR')}억 원`;
    return man > 0
      ? `${sign}${eok.toLocaleString('ko-KR')}억 ${man.toLocaleString('ko-KR')}만 원`
      : `${sign}${eok.toLocaleString('ko-KR')}억 원`;
  }
  if (abs >= 1e4) {
    const man = Math.floor(abs / 1e4);
    const rest = abs % 1e4;
    return rest > 0
      ? `${sign}${man.toLocaleString('ko-KR')}만 ${rest.toLocaleString('ko-KR')}원`
      : `${sign}${man.toLocaleString('ko-KR')}만 원`;
  }
  return `${sign}${abs.toLocaleString('ko-KR')}원`;
}

/** 큰 금액을 짧게: 13억 7,000만 → '13.7억', 3,200만 → '3,200만' */
export function formatWonShort(value: number): string {
  const n = Math.round(value);
  const sign = n < 0 ? MINUS : '';
  const abs = Math.abs(n);
  if (abs >= 1e8) {
    const eok = abs / 1e8;
    return `${sign}${eok >= 100 ? Math.round(eok).toLocaleString('ko-KR') : eok.toFixed(1).replace(/\.0$/, '')}억`;
  }
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString('ko-KR')}만`;
  return `${sign}${abs.toLocaleString('ko-KR')}원`;
}

export function signedWon(value: number): string {
  return value > 0 ? `+${formatWon(value)}` : formatWon(value);
}

// ── 조사 ────────────────────────────────────────────────

/** 마지막 글자의 받침. 없으면 0, ㄹ이면 8 (한글 종성 인덱스) */
function finalConsonant(word: string): number {
  const last = word.trim().slice(-1);
  if (!last) return 0;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28;
  // 숫자는 읽는 소리 기준: 0영 1일 3삼 6육 7칠 8팔 은 받침이 있다
  const digit: Record<string, number> = { '0': 21, '1': 8, '3': 16, '6': 1, '7': 8, '8': 8 };
  if (last in digit) return digit[last];
  return 0;
}

const PAIRS: Record<string, [string, string]> = {
  // [받침 있을 때, 없을 때]
  '이/가': ['이', '가'],
  '을/를': ['을', '를'],
  '은/는': ['은', '는'],
  '과/와': ['과', '와'],
  '와/과': ['과', '와'],
  '이랑/랑': ['이랑', '랑'],
  '아/야': ['아', '야'],
  '이나/나': ['이나', '나'],
  '이라/라': ['이라', '라'],
  '이라고/라고': ['이라고', '라고'],
  '이에요/예요': ['이에요', '예요'],
  '이었다/였다': ['이었다', '였다'],
  '으로/로': ['으로', '로'],
  '로/으로': ['으로', '로'],
};

/** 단어 뒤에 맞는 조사를 붙인다. josa('민지', '이/가') → '민지가' */
export function josa(word: string, pair: string): string {
  const forms = PAIRS[pair];
  if (!forms) return word + pair;
  const jong = finalConsonant(word);
  if (pair === '으로/로' || pair === '로/으로') {
    // ㄹ 받침 뒤에는 '로'
    return word + (jong !== 0 && jong !== 8 ? '으로' : '로');
  }
  return word + (jong !== 0 ? forms[0] : forms[1]);
}

export const JOSA_PATTERN = Object.keys(PAIRS)
  .sort((a, b) => b.length - a.length)
  .map((p) => p.replace('/', '\\/'))
  .join('|');

/** 단독 조사 → 짝. 템플릿에 '{지인}이 '처럼 한 글자만 써도 고쳐 준다 */
export const SINGLE_TO_PAIR: Record<string, string> = {
  이: '이/가',
  가: '이/가',
  을: '을/를',
  를: '을/를',
  은: '은/는',
  는: '은/는',
  과: '과/와',
  와: '과/와',
};

// ── 생애 단계 ────────────────────────────────────────────

export const STAGES: { id: StageId; label: string; from: number; to: number }[] = [
  { id: 'infant', label: '영유아', from: 0, to: 6 },
  { id: 'elementary', label: '초등', from: 7, to: 12 },
  { id: 'middle', label: '중등', from: 13, to: 15 },
  { id: 'high', label: '고등', from: 16, to: 18 },
  { id: 'youth', label: '청년', from: 19, to: 29 },
  { id: 'adult', label: '장년', from: 30, to: 49 },
  { id: 'midlife', label: '중년', from: 50, to: 64 },
  { id: 'senior', label: '노년', from: 65, to: 200 },
];

export function stageOf(age: number): StageId {
  for (const s of STAGES) if (age >= s.from && age <= s.to) return s.id;
  return 'senior';
}

export function stageLabel(id: StageId): string {
  return STAGES.find((s) => s.id === id)?.label ?? id;
}

// ── 고등학교 유형 ────────────────────────────────────────

export const HIGH_TYPE_LABEL: Record<HighType, string> = {
  general: '일반고',
  foreign: '외고·국제고',
  autonomous: '자사고',
  gifted: '영재학교',
  science: '과학고',
  arts: '예술고',
  sports: '체육고',
  vocational: '특성화고',
  meister: '마이스터고',
  alternative: '대안학교',
};

/** 특목고·자사고·영재학교: 내신 경쟁이 세고 수능에 강하다 */
export const ELITE_HIGH: HighType[] = ['foreign', 'autonomous', 'gifted', 'science'];

