// 시드 기반 난수. 같은 시드 = 같은 인생.
//
// 난수를 한 줄기로 쓰면 선택 하나만 달라져도 이후 인생 전체가 뒤섞인다.
// 그래서 용도마다 이름표(label)를 붙여 독립된 줄기를 만든다.
// 예: rngFor(seed, 'events', 17) 은 17세의 사건 추첨에만 쓰인다.

/** cyrb128: 문자열 → 128비트 해시 */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(label: string) {
    [this.a, this.b, this.c, this.d] = cyrb128(label);
    // 초기 상태를 충분히 섞는다
    for (let i = 0; i < 12; i++) this.next();
  }

  /** sfc32: [0, 1) 균등 난수 */
  next(): number {
    this.a |= 0;
    this.b |= 0;
    this.c |= 0;
    this.d |= 0;
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** min 이상 max 이하 정수 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** 가중치 추첨. 가중치 합이 0이면 undefined */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T | undefined {
    let total = 0;
    for (const item of items) total += Math.max(0, weight(item));
    if (total <= 0) return undefined;
    let r = this.next() * total;
    for (const item of items) {
      r -= Math.max(0, weight(item));
      if (r < 0) return item;
    }
    return items[items.length - 1];
  }

  /** 정규분포 (Box-Muller) */
  normal(mean = 0, sd = 1): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}

export function rngFor(seed: string, ...labels: (string | number)[]): Rng {
  return new Rng([seed, ...labels].join('|'));
}

const SEED_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 헷갈리는 0/O, 1/I 제외

/** 공유하기 쉬운 8자리 시드. 예: K7Q2-9XMA */
export function randomSeed(source: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) s += '-';
    s += SEED_ALPHABET[Math.floor(source() * SEED_ALPHABET.length)];
  }
  return s;
}

/** 사용자가 입력한 시드를 정리한다. 빈 문자열이면 null */
export function normalizeSeed(input: string): string | null {
  const s = input.trim().toUpperCase().replace(/\s+/g, '');
  return s.length > 0 ? s.slice(0, 32) : null;
}
