// 생리적 현상: 상황(contexts) × 현상(phenomena) 짝 + 생애 단계별 현상(stages).
// 현상의 tags와 상황의 tags가 하나라도 겹치면 한 장면이 된다 (only·not으로 좁힌다).

import type { EventDef, TagDef } from '../schema';
import type { Sex } from '../types';
import { and, choice, makeEvent, overlap, type ChoiceRow, type Fx } from './build';

interface Context {
  id: string;
  name: string;
  tags: string[];
  age?: [number, number];
  if?: string;
  lead: string;
  loud?: string;
  seen?: string;
  exit?: ChoiceRow;
  fx?: Fx;
}

interface Phenomenon {
  id: string;
  name: string;
  tags: string[];
  age?: [number, number];
  sex?: Sex;
  if?: string;
  notice: 'loud' | 'seen' | 'hidden';
  w?: number;
  only?: string[];
  not?: string[];
  scene: string;
  choices: ChoiceRow[];
}

interface Stage {
  id: string;
  group: string;
  sex?: Sex;
  age: [number, number];
  if?: string;
  title: string;
  zoom?: string;
  text: string;
  choices: ChoiceRow[];
}

export interface PhysiologyCatalog {
  tags?: TagDef[];
  contexts: Context[];
  phenomena: Phenomenon[];
  stages: Stage[];
}

function fits(p: Phenomenon, c: Context): boolean {
  if (p.only) return p.only.includes(c.id);
  if (p.not?.includes(c.id)) return false;
  return p.tags.some((t) => c.tags.includes(t));
}

export function expandPhysiology(data: PhysiologyCatalog): EventDef[] {
  const out: EventDef[] = [];
  for (const p of data.phenomena) {
    for (const c of data.contexts) {
      if (!fits(p, c)) continue;
      const age = overlap(p.age, c.age);
      if (!age) continue;
      const reaction = p.notice === 'loud' ? c.loud : p.notice === 'seen' ? c.seen : undefined;
      const choices = p.choices.map((row) => choice(row, '', c.fx));
      if (c.exit) choices.push(choice(c.exit));
      out.push(
        makeEvent({
          id: `phys_${p.id}_${c.id}`,
          pool: 'physiology',
          title: p.name,
          zoom: c.name,
          text: [c.lead, p.scene, reaction].filter(Boolean).join(' '),
          age,
          sex: p.sex,
          if: and(c.if, p.if),
          w: p.w ?? 0.5,
          group: p.id,
          impact: 3,
          choices,
        }),
      );
    }
  }
  for (const s of data.stages) {
    out.push(
      makeEvent({
        id: `phys_${s.id}`,
        pool: 'physiology',
        title: s.title,
        zoom: s.zoom,
        text: s.text,
        age: s.age,
        sex: s.sex,
        if: s.if,
        w: 0.8,
        group: s.group,
        impact: 6,
        choices: s.choices.map((row) => choice(row)),
      }),
    );
  }
  return out;
}
