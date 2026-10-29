// 사건 데이터 안의 조건식. 데이터에 코드를 넣지 않기 위해 eval을 쓰지 않고
// 아주 작은 식 언어만 해석한다.
//
//   money.debt > 30000000
//   stats.intelligence > 70 && !flags.unemployed
//   world.economy == 'recession' || (age >= 50 && family.wealth <= 2)
//
// 지원: 경로(a.b.c), 숫자, 문자열('...' / "..."), true/false,
//       비교(> >= < <= == !=), 논리(! && ||), 괄호

export type Scope = Record<string, unknown>;
type Fn = (scope: Scope) => unknown;

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'path'; v: string[] }
  | { t: 'op'; v: string };

const OPS = ['>=', '<=', '==', '!=', '&&', '||', '>', '<', '!', '(', ')'];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    // 음수 리터럴: 앞이 값이 아닐 때의 '-'
    const prev = tokens[tokens.length - 1];
    const negAllowed = !prev || (prev.t === 'op' && prev.v !== ')');
    if (c === '-' && negAllowed && /[0-9]/.test(src[i + 1] ?? '')) {
      const m = /^-[0-9][0-9_]*(\.[0-9]+)?/.exec(src.slice(i));
      if (m) {
        tokens.push({ t: 'num', v: Number(m[0].replace(/_/g, '')) });
        i += m[0].length;
        continue;
      }
    }
    if (op) {
      tokens.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9][0-9_]*(\.[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new Error(`숫자를 읽을 수 없음: ${src}`);
      tokens.push({ t: 'num', v: Number(m[0].replace(/_/g, '')) });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error(`따옴표가 닫히지 않음: ${src}`);
      tokens.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*/.exec(src.slice(i));
      if (!m) throw new Error(`이름을 읽을 수 없음: ${src}`);
      if (m[0] === 'true' || m[0] === 'false') tokens.push({ t: 'bool', v: m[0] === 'true' });
      else tokens.push({ t: 'path', v: m[0].split('.') });
      i += m[0].length;
      continue;
    }
    throw new Error(`알 수 없는 문자 '${c}': ${src}`);
  }
  return tokens;
}

function lookup(scope: Scope, path: string[]): unknown {
  let cur: unknown = scope;
  for (const key of path) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function compare(op: string, a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return op === '!=' ? a !== b : false;
  switch (op) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '>':
      return (a as number) > (b as number);
    case '>=':
      return (a as number) >= (b as number);
    case '<':
      return (a as number) < (b as number);
    case '<=':
      return (a as number) <= (b as number);
  }
  return false;
}

class Parser {
  private pos = 0;
  readonly paths: string[][] = [];
  constructor(
    private tokens: Token[],
    private src: string,
  ) {}

  parse(): Fn {
    const fn = this.or();
    if (this.pos < this.tokens.length) throw new Error(`해석하지 못한 부분이 남음: ${this.src}`);
    return fn;
  }

  private peekOp(v: string): boolean {
    const t = this.tokens[this.pos];
    return t !== undefined && t.t === 'op' && t.v === v;
  }

  private or(): Fn {
    let left = this.and();
    while (this.peekOp('||')) {
      this.pos++;
      const l = left;
      const r = this.and();
      left = (s) => Boolean(l(s)) || Boolean(r(s));
    }
    return left;
  }

  private and(): Fn {
    let left = this.not();
    while (this.peekOp('&&')) {
      this.pos++;
      const l = left;
      const r = this.not();
      left = (s) => Boolean(l(s)) && Boolean(r(s));
    }
    return left;
  }

  private not(): Fn {
    if (this.peekOp('!')) {
      this.pos++;
      const inner = this.not();
      return (s) => !inner(s);
    }
    return this.cmp();
  }

  private cmp(): Fn {
    const left = this.value();
    const t = this.tokens[this.pos];
    if (t && t.t === 'op' && ['>', '>=', '<', '<=', '==', '!='].includes(t.v)) {
      this.pos++;
      const right = this.value();
      const op = t.v;
      return (s) => compare(op, left(s), right(s));
    }
    return left;
  }

  private value(): Fn {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error(`식이 갑자기 끝남: ${this.src}`);
    switch (t.t) {
      case 'num':
      case 'str':
      case 'bool': {
        const v = t.v;
        return () => v;
      }
      case 'path': {
        const p = t.v;
        this.paths.push(p);
        return (s) => lookup(s, p);
      }
      case 'op':
        if (t.v === '(') {
          const inner = this.or();
          if (!this.peekOp(')')) throw new Error(`괄호가 닫히지 않음: ${this.src}`);
          this.pos++;
          return inner;
        }
    }
    throw new Error(`예상하지 못한 '${(t as { v: unknown }).v}': ${this.src}`);
  }
}

const cache = new Map<string, { fn: Fn; paths: string[][] }>();

function compile(src: string): { fn: Fn; paths: string[][] } {
  let hit = cache.get(src);
  if (!hit) {
    const parser = new Parser(tokenize(src), src);
    const fn = parser.parse();
    hit = { fn, paths: parser.paths };
    cache.set(src, hit);
  }
  return hit;
}

export function evaluate(src: string, scope: Scope): boolean {
  return Boolean(compile(src).fn(scope));
}

/** 검증 도구용: 식이 참조하는 경로 목록. 문법 오류면 예외 */
export function referencedPaths(src: string): string[][] {
  return compile(src).paths;
}
