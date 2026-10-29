// 하단 탭 아이콘. 선 굵기와 크기를 하나로 맞춘 인라인 SVG

const common = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** 일력: 한 장 넘기기 */
export function IconYear() {
  return (
    <svg {...common}>
      <rect x="4" y="5" width="16" height="15" rx="1.5" />
      <path d="M4 9h16M8 3v4M16 3v4" />
      <path d="M12 12v5M9.5 14.5h5" />
    </svg>
  );
}

export function IconActivity() {
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function IconPeople() {
  return (
    <svg {...common}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M15.8 14.2c2.3.2 3.9 1.8 4.4 4.8" />
    </svg>
  );
}

/** 원화 기호 */
export function IconWon() {
  return (
    <svg {...common}>
      <path d="M4 6l3.5 12L12 8l4.5 10L20 6" />
      <path d="M3 11h18M3 14h18" />
    </svg>
  );
}

export function IconBook() {
  return (
    <svg {...common}>
      <path d="M4 5.5C6.5 4.5 9.5 4.5 12 6v13c-2.5-1.5-5.5-1.5-8-.5z" />
      <path d="M20 5.5c-2.5-1-5.5-1-8 .5v13c2.5-1.5 5.5-1.5 8-.5z" />
    </svg>
  );
}

export function IconClose() {
  return (
    <svg {...common} width={20} height={20}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
