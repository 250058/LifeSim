// 화면에만 쓰는 이름표

import type { EconomyPhase, Mode, SchoolStatus, StatKey } from '../engine/types';

export const STAT_LABEL: Record<StatKey, string> = {
  health: '건강',
  stamina: '체력',
  intelligence: '지능',
  looks: '외모',
  sociability: '사교',
  happiness: '행복',
};

export const MODE_INFO: Record<Mode, { label: string; desc: string }> = {
  reality: { label: '현실', desc: '실제 통계 그대로. 대부분 평범하게 산다' },
  drama: { label: '드라마', desc: '인생마다 큰 사건 한두 개' },
  makjang: { label: '막장', desc: '희귀한 사건이 쏟아진다' },
};

export const ECONOMY_LABEL: Record<EconomyPhase, string> = {
  boom: '호황',
  normal: '보통',
  recession: '불황',
  crisis: '위기',
};

export const SCHOOL_LABEL: Record<SchoolStatus, string> = {
  none: '미취학',
  kindergarten: '유치원',
  elementary: '초등학생',
  middle: '중학생',
  high: '고등학생',
  university: '대학생',
  graduated: '졸업',
  dropout: '중퇴',
};

export const GROUP_LABEL: Record<string, string> = {
  growth: '성장',
  social: '사람',
  money: '돈',
  life: '생활',
  risk: '위험',
};

/** 학년: 7세 입학 기준 */
export function gradeLabel(status: SchoolStatus, age: number): string | null {
  if (status === 'elementary') return `초${Math.min(6, Math.max(1, age - 6))}`;
  if (status === 'middle') return `중${Math.min(3, Math.max(1, age - 12))}`;
  if (status === 'high') return `고${Math.min(3, Math.max(1, age - 15))}`;
  return null;
}

/** 숫자를 원형 번호로 (선택지 ①②③④) */
export function circled(n: number): string {
  return String.fromCharCode(0x2460 + n);
}
