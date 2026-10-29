// 피임 (검토 R-013): 지금 쓰는 방법과 그 기록이 유효한 기간을 태그로 들고,
// 같은 노출에서 임신으로 이어질 위험 배수를 이 파일 한곳에서 정한다.
//
// 이 표를 읽는 곳 (세 경로가 같은 배수를 쓴다):
//  - activities.ts   모텔 데이트·해피타임: 부부는 임신 카드, 연인은 '늦어지는 날짜' 카드가 걸리는 확률
//  - adult.json      pregnancy 사건의 가중치 보정 (조건식으로 같은 규칙을 적었다. 테스트가 서로 맞춰 본다)
//  - romance.json    rom_pregnancy_scare의 두 줄·한 줄: 노출 때 이 표로 정한 임신 여부(ctx.conceived)를 따른다
//                    (romance.ts가 선택지를 결과별로 나눈다)
//
// 방법 (센 것부터)과 기간:
//   permanent   정관수술 med_vasectomy (남성 주인공 본인). 영구: 사라지지 않는다
//   longActing  자궁 내 장치·피하 이식 rom_larc. 사용 중: 장치를 둔 동안. 종류에 따라 3~10년이라 태그 5년으로 묶었다
//   pill        경구피임약 rom_pill_use. 사용 중: 먹는 동안. 1년 뒤에도 계속 먹는 사람이 67%라 태그 2년 (게임 근사)
//   condom      콘돔 습관 rom_safe. 습관: 1년 뒤에도 계속 쓰는 사람이 43%뿐이라 3년 뒤 흐려진다 (게임 근사)
//   none        기록된 방법이 없다
// 기간은 태그의 duration(romance.json·medical.json)이 정하고 연말 결산이 지운다. 기간이 끝나면 none으로 돌아간다.
// 같은 방법을 다시 고르면(장치를 새로 넣는다, 콘돔을 다시 챙기기로 한다) 그때부터 기간을 새로 잡는다 (renewsOnAdd).
// 사용 중인 방법은 그만두는 선택(예: 피임약을 쉬고 콘돔으로)으로 끝난다. 임신 준비(rom_trying)를 고르면 되돌릴 수 있는
// 방법을 모두 그만두고, 아이가 태어나면 피임약·장치 기록이 끝난다 (catalog/romance.ts·adult.json이 지운다).
// 그래서 임신 준비가 끝나도 예전 방법이 저절로 돌아오지 않는다. 다시 쓰려면 다시 골라야 한다.
//
// 위험 배수 = 일반적인 사용(typical use)에서 첫 1년 안에 임신하는 비율 ÷ 피임하지 않을 때의 비율(85%).
// 같은 노출이면 '방법 없음'의 확률에 이 배수를 곱한다. 1년 내내 규칙적으로 노출돼 기본 확률이 0.85인 경우
// 결과가 그 방법의 실패율과 같아지는 근사다. 사건의 기본 확률은 방법을 기록하지 않은 사람들의 평균(일부는 피임한다)으로
// 맞춘 값이라, 기록된 방법이 있을 때만 배수를 곱한다. 어떤 방법도 위험을 0으로 만들지 않는다.
//
// 출처 (일반 사용 첫해 실패율):
//   Trussell J, Aiken ARA, Micks E, Guthrie KA. Efficacy, safety, and personal considerations.
//   In: Hatcher RA et al., eds. Contraceptive Technology, 21st ed. Ayer Company Publishers; 2018.
//   (미국 CDC 'Contraceptive Effectiveness' 표가 같은 값을 쓴다)
//   피임 안 함 85% · 남성용 콘돔 13% · 경구피임약 7% · 구리 자궁 내 장치 0.8% · 호르몬 자궁 내 장치 0.1~0.4%
//   · 피하 이식 0.1% · 정관수술 0.15%. 자궁 내 장치·피하 이식은 그 사이 0.4%로 묶었다.
// 출처 (1년 뒤 계속 쓰는 비율): Trussell J. Contraceptive failure in the United States.
//   Contraception 2011;83(5):397-404. 콘돔 43% · 피임약 67% · 자궁 내 장치 78~80% · 피하 이식 84%.
//
// 게임은 '어떤 방법을 쓰는 중인가'와 '언제까지 유효한가'만 안다. 사용법·용량은 다루지 않는다.
// 아직 없는 것: 여성 불임 수술, 여성 주인공의 배우자가 받은 정관수술, 주사·패치·링(따로 고르는 장면이 없다),
// 질외사정·주기법, 해마다 확률로 그만두는 일(지금은 고정 기간), 주기 안의 시기.
//
// 누구의 방법인가: 여성 주인공의 약·장치, 남성 주인공의 정관수술, 콘돔 습관은 본인 것이라 짝이 바뀌어도 남는다.
// 남성 주인공에게 피임약·장치는 상대가 쓰는 방법이라 그 상대에게만 해당한다 (검토 R-020). 기록할 때 그 상대의
// 인물 ID를 태그에 남기고(owner), 지금 짝이 그 사람일 때만 센다. 연인이 배우자가 되어도 같은 사람이라 이어진다.
// 주인을 남기기 전의 옛 기록은 누구 것인지 모르므로, 지금 짝과의 관계가 시작된 뒤(배우자는 혼인 뒤)의 기록만 센다.
// 새 짝에게 예전 사람의 방법을 붙이지 않는 쪽을 골랐다. 사귈 때 시작해 결혼 뒤에도 이어 먹은 약은 그 사이 덜 세지만,
// 옛 기록의 기간(최대 5년)이 끝나면 사라지는 차이다.
//
// adult.json의 pregnancy 사건은 이 파일의 판단을 조건식 값 family.contraception(scope.ts)으로 읽는다. 태그를
// 직접 읽지 않으므로 주인 확인과 임신 준비 규칙이 활동 경로와 같다.
//
// 이 파일은 타입 말고는 아무것도 불러오지 않는다: data.ts → catalog/romance.ts가 이 표를 읽는데,
// 여기서 relations.ts 같은 모듈을 부르면 data.ts로 되돌아가는 순환이 생긴다.

import type { Character, FlagInfo, GameState, Npc } from './types';

export type ContraMethod = 'none' | 'condom' | 'pill' | 'longActing' | 'permanent';

/** 기록이 유지되는 방식: 습관(흐려진다), 사용 중(그만두거나 기간이 끝나면 끝), 영구 */
export type ContraKind = 'none' | 'habit' | 'current' | 'permanent';

export interface MethodInfo {
  label: string;
  /** 이 방법을 뜻하는 태그 */
  flag?: string;
  kind: ContraKind;
  /** 일반적인 사용에서 첫 1년 안에 임신하는 비율 (위 출처) */
  typicalFailure: number;
  /** 여성이 쓰는 방법: 남성 주인공에게는 상대의 방법이다 */
  womanUses?: boolean;
  /** 남성 주인공 본인만 가질 수 있는 방법 */
  manOnly?: boolean;
}

/** 피임하지 않을 때 1년 안에 임신하는 비율 */
export const NO_METHOD_FAILURE = 0.85;

export const METHOD_INFO: Record<ContraMethod, MethodInfo> = {
  none: { label: '기록된 피임 없음', kind: 'none', typicalFailure: NO_METHOD_FAILURE },
  condom: { label: '콘돔 습관', flag: 'rom_safe', kind: 'habit', typicalFailure: 0.13 },
  pill: { label: '경구피임약', flag: 'rom_pill_use', kind: 'current', typicalFailure: 0.07, womanUses: true },
  longActing: { label: '자궁 내 장치·피하 이식', flag: 'rom_larc', kind: 'current', typicalFailure: 0.004, womanUses: true },
  permanent: { label: '정관수술', flag: 'med_vasectomy', kind: 'permanent', typicalFailure: 0.0015, manOnly: true },
};

/** 센 것부터 (둘 이상 기록돼 있으면 가장 센 방법 하나로 본다) */
export const METHOD_ORDER: readonly ContraMethod[] = ['permanent', 'longActing', 'pill', 'condom'];

/** 모든 방법 (none 포함) */
export const CONTRA_METHODS: readonly ContraMethod[] = ['none', 'condom', 'pill', 'longActing', 'permanent'];

/** 딩크: 따로 기록된 방법이 없어도 피임한다고 본다 (pregnancy 사건의 기존 배수) */
export const CHILDFREE_RISK = 0.1;
/** 임신 준비: 피임을 멈추고 시기를 맞춘다 (pregnancy 사건의 기존 배수) */
export const TRYING_BOOST = 1.5;

/** 같은 노출에서 이 방법을 쓸 때의 임신 위험 배수 (방법 없음 = 1) */
export function methodRisk(m: ContraMethod): number {
  return METHOD_INFO[m].typicalFailure / NO_METHOD_FAILURE;
}

/** 지금 짝 (배우자가 먼저) */
function mateOf(ch: Character): Npc | undefined {
  const live = (role: Npc['role']) => ch.npcs.find((n) => n.alive && !n.missing && n.role === role);
  return live('spouse') ?? live('partner');
}

/** 태그 → 방법 */
const METHOD_BY_FLAG = new Map(CONTRA_METHODS.filter((m) => METHOD_INFO[m].flag).map((m) => [METHOD_INFO[m].flag!, m]));

/** 남성 주인공에게 이 태그는 상대가 쓰는 방법인가 (주인을 인물 ID로 남긴다) */
function partnerUses(state: GameState, flagId: string): boolean {
  const m = METHOD_BY_FLAG.get(flagId);
  return m !== undefined && Boolean(METHOD_INFO[m].womanUses) && state.ch.sex === 'M';
}

/** 이 방법의 기록이 지금 짝과의 노출에 해당하는가 */
function appliesNow(state: GameState, m: ContraMethod, mate: Npc | undefined): boolean {
  const info = METHOD_INFO[m];
  const flag = info.flag ? state.ch.flags[info.flag] : undefined;
  if (!flag) return false;
  if (info.manOnly && state.ch.sex !== 'M') return false;
  if (!partnerUses(state, info.flag!)) return true;
  // 남성 주인공의 피임약·장치는 상대의 것: 기록한 그 사람이 지금 짝일 때만
  if (flag.owner !== undefined) return mate?.id === flag.owner;
  // 주인이 없는 옛 기록: 지금 짝과의 관계가 시작되기 전 기록이면 다른 사람의 것일 수 있어 세지 않는다
  if (!mate || mate.since === undefined) return true;
  return flag.since >= mate.since;
}

// ── 기록 남기기 (effects.ts addFlag가 부른다) ─────────────────

/** 습관·사용 중인 방법: 다시 고르면 그때부터 기간을 새로 잡는다 (정관수술은 영구라 해당 없음) */
export const RENEWABLE_FLAGS: readonly string[] = METHOD_ORDER.filter((m) => {
  const k = METHOD_INFO[m].kind;
  return k === 'habit' || k === 'current';
}).map((m) => METHOD_INFO[m].flag!);

/** 임신 준비를 고르거나 아이가 태어나면 끝나는 기록 */
export const STOP_WHEN_TRYING: readonly string[] = RENEWABLE_FLAGS;
export const STOP_AT_BIRTH: readonly string[] = METHOD_ORDER.filter((m) => METHOD_INFO[m].kind === 'current').map((m) => METHOD_INFO[m].flag!);

/** 이미 있어도 다시 붙이면 기간을 새로 잡는 태그인가 */
export function renewsOnAdd(flagId: string): boolean {
  return RENEWABLE_FLAGS.includes(flagId);
}

/**
 * 피임 태그를 붙일 때의 기록. 남성 주인공에게 상대가 쓰는 방법이면 지금 짝(배우자가 먼저)의 인물 ID를 남긴다.
 * 짝이 없으면 주인을 남기지 않는다 (옛 기록처럼 읽힌다). 피임 태그가 아니면 base를 그대로 돌려준다.
 */
export function stampContraFlag(state: GameState, flagId: string, base: FlagInfo): FlagInfo {
  if (!partnerUses(state, flagId)) return base;
  const mate = mateOf(state.ch);
  return mate ? { ...base, owner: mate.id } : base;
}

// ── 옛 저장 ─────────────────────────────────────────────

/** 검토 R-013 수정 전 rom_vasectomy '수술을 받는다'의 결과 문장 (그때는 정관수술을 rom_safe로 남겼다) */
const OLD_VASECTOMY_RESULT = '생각보다 금방 끝났다. 이틀 동안 얼음찜질을';

/**
 * 옛 저장 바로잡기: 정관수술 태그(med_vasectomy)가 생기기 전에는 rom_vasectomy에서 수술을 받아도 피임 습관
 * (rom_safe, 5년)만 남았다. 그 카드의 기록에 수술 결과 문장이 있고 그 나이에 붙은 rom_safe가 있으면 정관수술로 바꾼다.
 * 같은 카드의 '콘돔을 챙긴다'도 rom_safe를 남겼으므로 결과 문장으로 둘을 가른다. 기록(log)이 없으면 그대로 둔다.
 * 고칠 것이 없으면 아무것도 하지 않으므로 몇 번을 불러도 같다.
 */
export function repairOldVasectomy(state: GameState): void {
  const ch = state.ch;
  if (ch.sex !== 'M' || ch.flags.med_vasectomy || !state.counts?.rom_vasectomy) return;
  const entry = (state.log ?? []).find((e) => e.text?.startsWith(OLD_VASECTOMY_RESULT));
  if (!entry) return;
  ch.flags.med_vasectomy = { since: entry.age };
  if (ch.flags.rom_safe?.since === entry.age) delete ch.flags.rom_safe;
}

/**
 * 지금 노출에 적용되는 방법. 둘 이상이면 가장 센 것. 임신 준비 중(rom_trying)이면 되돌릴 수 있는 방법은
 * 멈춘 것으로 본다 (정관수술은 그대로).
 */
export function contraceptionMethod(state: GameState, mate: Npc | undefined = mateOf(state.ch)): ContraMethod {
  const trying = Boolean(state.ch.flags.rom_trying);
  for (const m of METHOD_ORDER) {
    if (trying && METHOD_INFO[m].kind !== 'permanent') continue;
    if (appliesNow(state, m, mate)) return m;
  }
  return 'none';
}

/**
 * 부부의 임신 위험 배수: 방법의 배수에 딩크(배수와 0.1 중 작은 쪽)와 임신 준비(× 1.5)를 더한다.
 * adult.json pregnancy 사건의 보정과 같은 규칙이다. 모텔·해피타임의 부부 경로도 이 값을 쓴다.
 */
export function pregnancyRisk(state: GameState, mate?: Npc): number {
  const flags = state.ch.flags;
  let r = methodRisk(contraceptionMethod(state, mate ?? mateOf(state.ch)));
  if (flags.rom_childfree) r = Math.min(r, CHILDFREE_RISK);
  if (flags.rom_trying) r *= TRYING_BOOST;
  return r;
}

// ── 나이에 따른 가임력 ───────────────────────────────────
// 노출 한 번이 임신으로 이어질 가능성은 여성의 나이에 따라 준다. 한 주기에 임신할 확률은 30세 약 20%, 40세 약 5%
// (미국생식의학회 ASRM 환자 안내 'Age and Fertility', 2012). 32세 무렵부터 서서히, 37세 이후 빠르게 준다
// (ACOG·ASRM 위원회 의견 589호 'Female age-related fertility decline', 2014). 30세 이하를 1로 둔 배수다.
// 모텔·해피타임의 노출 경로가 쓴다. pregnancy 사건은 출산 시기 선택까지 담은 자기 나이 곡선을 따로 쓴다.

export const FECUNDITY_BY_AGE: readonly [number, number][] = [
  [30, 1],
  [32, 0.92],
  [35, 0.7],
  [37, 0.52],
  [40, 0.25],
  [42, 0.13],
  [44, 0.06],
];

/** 여성 나이의 가임력 배수 (사이 나이는 선형 보간, 30세 이하 1, 44세 이상은 끝값) */
export function fecundity(womanAge: number): number {
  const pts = FECUNDITY_BY_AGE;
  if (womanAge <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x0, y0] = pts[i - 1];
    if (womanAge <= x1) return y0 + ((y1 - y0) * (womanAge - x0)) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}

// ── 임신 걱정 (rom_pregnancy_scare) ─────────────────────────
// 늦어지는 날짜는 임신일 수도, 아닐 수도 있다. 방법 없이 노출된 뒤의 걱정 중 35%가 실제 임신이다
// (romance.json 걱정 카드의 기본 가중치 한 줄 65 : 두 줄 35). 임신이 아닌 걱정(주기가 흔들린 경우)은 방법과
// 상관없이 생긴다고 본다. 노출 한 번에 대해 (가임력 = 위 나이 배수)
//   임신        = 기본 확률 × 0.35 × 방법 배수 × 가임력
//   임신 아닌 걱정 = 기본 확률 × 0.65
//   걱정 카드    = 둘의 합,  그중 두 줄 = 임신 ÷ 걱정 카드
// 임신 여부는 노출 때 정해 카드 문맥(ctx.conceived)에 남기고, 걱정 카드는 그 결과를 따른다. 그래서 저장·재개 뒤에도
// 같은 결과가 나온다. 문맥에 결과가 없으면(옛 저장, 콘돔이 찢어졌는데 넘어간 경우처럼 방법 없이 노출된 경로)
// 카드의 기본 가중치 65 : 35를 쓴다. 콘돔이 찢어진 카드는 그 앞에서 여성 나이의 가임력만큼만 걱정 카드로 보내고
// 나머지는 바로 '한 줄'로 보낸다 (undecidedScareShare, catalog/romance.ts scareByAge). 그래서 그 경로도 나이를 따른다.

/** 방법 없이 노출된 뒤 생긴 걱정 중 실제 임신의 비율 */
export const SCARE_POSITIVE_SHARE = 0.35;

/** 노출 한 번이 실제 임신으로 이어질 확률 (걱정 카드 경로) */
export function scarePregnancyChance(base: number, m: ContraMethod, fertility = 1): number {
  return base * SCARE_POSITIVE_SHARE * methodRisk(m) * fertility;
}

/** 노출 한 번 뒤에 임신 걱정 카드가 걸릴 확률 */
export function scareChance(base: number, m: ContraMethod, fertility = 1): number {
  return scarePregnancyChance(base, m, fertility) + base * (1 - SCARE_POSITIVE_SHARE);
}

/** 걱정 카드 가운데 실제 임신(두 줄)의 비율 */
export function scarePositiveShare(m: ContraMethod, fertility = 1): number {
  return scarePregnancyChance(1, m, fertility) / scareChance(1, m, fertility);
}

/**
 * 노출 때 결과를 정해 두지 못한 경로(예: 콘돔이 찢어졌는데 넘어간 카드의 실패)에서 걱정 카드로 보낼 몫.
 * 그 걱정 카드는 기본 가중치(두 줄 35%)를 쓰므로, 이 몫만큼만 걱정 카드로 보내고 나머지는 바로 '한 줄'로 보내면
 * 늦어진 날짜 중 실제 임신의 비율이 이 나이·방법의 scarePositiveShare와 같아진다. 30세 이하·방법 없음이면 1.
 */
export function undecidedScareShare(fertility: number, m: ContraMethod = 'none'): number {
  return scarePositiveShare(m, fertility) / SCARE_POSITIVE_SHARE;
}

/** 노출 한 번의 결과: 걱정 없음 / 임신이 아닌 걱정 / 임신 */
export type ScareDraw = 'none' | 'false' | 'pregnant';

/** 균등 난수 u 하나로 정한다: u가 임신 확률보다 작으면 임신, 그다음 걱정 확률까지는 임신이 아닌 걱정 */
export function drawScare(u: number, base: number, m: ContraMethod, fertility = 1): ScareDraw {
  if (u < scarePregnancyChance(base, m, fertility)) return 'pregnant';
  if (u < scareChance(base, m, fertility)) return 'false';
  return 'none';
}

/** 카드 문맥: 노출 때의 방법 (ctx.contra)과 임신 여부 (ctx.conceived = 'yes' | 'no') */
export const CONTRA_CTX = 'contra';
export const CONCEIVED_CTX = 'conceived';

/** 선택지 조건: 노출 때 정해진 임신 여부. unknown은 문맥에 결과가 없는 경우 */
export function conceivedIf(v: 'yes' | 'no' | 'unknown'): string {
  const key = `ctx.${CONCEIVED_CTX}`;
  if (v === 'unknown') return `${key} != 'yes' && ${key} != 'no'`;
  return `${key} == '${v}'`;
}
