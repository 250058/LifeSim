// 사망 화면: 인생 연표, 묘비명, 업적, 남긴 재산.
// 묘비명은 태그와 직업이 남긴 조각을 이어 붙인다: "교실에서도, 막사에서도, 병상에서도 버텼다"

import { JOB_BY_ID, REGION_BY_ID, TAG_BY_ID } from './data';
import { DEGREE_LABEL } from './career';
import { alive, spouseOf } from './relations';
import { netWorth } from './scope';
import type { GameState, LifeSummary } from './types';

const HARDSHIP = [
  'bullying_victim',
  'bullying_overcome',
  'hazing_victim',
  'compound_survivor',
  'criminal_record',
  'credit_default',
  'cancer_survivor',
  'phishing_victim',
  'jeonse_victim',
  'industrial_injury',
  'raised_in_facility',
];

export function epitaph(state: GameState): string {
  const ch = state.ch;
  const phrases: { text: string; priority: number }[] = [];
  for (const id of Object.keys(ch.flags)) {
    const tag = TAG_BY_ID.get(id);
    if (tag?.epitaph) phrases.push({ text: tag.epitaph, priority: tag.priority ?? 1 });
  }
  for (const h of ch.career.history) {
    const job = JOB_BY_ID.get(h.jobId);
    if (job?.epitaph && (h.toAge ?? ch.age) - h.fromAge >= 3) phrases.push({ text: job.epitaph, priority: 4 });
  }
  const unique = [...new Map(phrases.map((p) => [p.text, p])).values()]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 3);

  const kids = alive(ch, 'child').length + ch.npcs.filter((n) => n.role === 'child' && !n.alive).length;
  const everMarried = ch.npcs.some((n) => n.role === 'spouse' || n.role === 'ex');
  const hardship = HARDSHIP.some((h) => ch.flags[h]);

  if (unique.length > 0) {
    const verb = hardship ? '버텼다' : everMarried && kids > 0 ? '사랑했다' : ch.stats.happiness >= 65 ? '웃었다' : '살아냈다';
    return `${unique.map((p) => p.text).join(', ')} ${verb}`;
  }
  if (ch.age >= 100) return '백 년을 살고도 하루가 아쉬웠다';
  if (ch.age < 10) return '짧았지만 사랑받았다';
  if (ch.age < 30) return '하고 싶은 일이 아직 많았다';
  if (everMarried && kids >= 2) return '아이들 웃음소리 속에 살았다';
  if (netWorth(state) >= 1_000_000_000 * state.world.economy.priceIndex) return '벌 만큼 벌고, 다 두고 갔다';
  if (ch.stats.happiness >= 70) return '대체로 웃으며 살았다';
  return '평범하게, 끝까지 살았다';
}

export function achievements(state: GameState): string[] {
  const ch = state.ch;
  const list: string[] = [];
  const pi = state.world.economy.priceIndex;
  if (ch.edu.degree === 'university' || ch.edu.degree === 'college') list.push(`${DEGREE_LABEL[ch.edu.degree]}`);
  if (ch.flags.military_done) list.push('만기 전역');
  if (ch.career.history.length > 0) list.push('첫 월급');
  if (ch.npcs.some((n) => n.role === 'spouse' || n.role === 'ex')) list.push('결혼');
  if (ch.npcs.some((n) => n.role === 'child')) list.push('부모가 되다');
  for (const id of Object.keys(ch.flags)) {
    const tag = TAG_BY_ID.get(id);
    if (tag?.achievement) list.push(tag.name);
  }
  const nw = netWorth(state);
  if (nw >= 1_000_000_000 * pi) list.push('10억 자산');
  else if (nw >= 100_000_000 * pi) list.push('억대 자산');
  if (ch.age >= 100) list.push('백 세 인생');
  else if (ch.age >= 80) list.push('여든을 넘기다');
  return list;
}

export function buildSummary(state: GameState): LifeSummary {
  const ch = state.ch;
  const highlights = state.log
    .filter((e) => e.kind === 'birth' || e.kind === 'death' || ((e.kind === 'event' || e.kind === 'milestone') && (e.impact ?? 0) >= 20))
    .slice(-14);
  const visibleTags = Object.keys(ch.flags)
    .map((id) => TAG_BY_ID.get(id))
    .filter((t) => t?.visible)
    .map((t) => t!.name);
  const lastJob = ch.career.history[ch.career.history.length - 1];
  return {
    name: ch.surname + ch.given,
    sex: ch.sex,
    region: REGION_BY_ID.get(ch.birthRegion)?.short ?? ch.birthRegion,
    birthYear: ch.birthYear,
    deathYear: ch.death?.year ?? state.year,
    age: ch.age,
    cause: ch.death?.cause ?? '알 수 없음',
    epitaph: epitaph(state),
    achievements: achievements(state),
    tags: visibleTags,
    netWorth: netWorth(state),
    highlights,
    job: lastJob?.title,
    degree: DEGREE_LABEL[ch.edu.degree],
    spouse: spouseOf(ch)?.name,
    children: ch.npcs.filter((n) => n.role === 'child').length,
    seed: state.seed,
    mode: state.mode,
  };
}
