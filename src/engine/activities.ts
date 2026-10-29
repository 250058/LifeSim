// 자유 행동 (GTA식): 시간 포인트·돈·체력을 써서 1년 동안 할 일을 고른다.
// 생애 단계마다 포인트가 다르다. 고3과 직장인은 적고, 대학생과 은퇴자는 많다.

import { evaluate } from './conditions';
import { ACTIVITIES, ACTIVITY_BY_ID, EVENT_BY_ID } from './data';
import { addFlag, applyEffects, removeFlag } from './effects';
import { formatWon, josa, signedWon } from './format';
import { addFriend, alive, changeCloseness, npcAge, partnerOf, spouseOf, startPartner } from './relations';
import { rngFor } from './rng';
import { buildScope, inPrison } from './scope';
import type { ActivityDef } from './schema';
import { TALENT_LABEL } from './text';
import type { Change, GameState, Npc } from './types';

function npcAgeOf(state: GameState, npc: Npc | undefined): number {
  return npc ? npcAge(npc, state.year) : 99;
}

export function timePointsFor(state: GameState): number {
  const ch = state.ch;
  const a = ch.age;
  if (!ch.alive) return 0;
  if (inPrison(state)) return 1;
  if (ch.military.status === 'serving') return 1;
  if (a < 3) return 1;
  if (a <= 6) return 2;
  if (a <= 12) return 4;
  if (a <= 15) return 3;
  if (a <= 17) return 2;
  if (a === 18 && ch.edu.status === 'high') return 1;
  if (a >= 65) return ch.stats.health < 30 ? 3 : 5;
  if (ch.edu.status === 'university') return 5;
  if (ch.career.jobId) return 2;
  return a < 30 ? 5 : 4;
}

export interface ActivityView {
  def: ActivityDef;
  enabled: boolean;
  reason?: string;
  cost: number;
}

/** 지금 나이·상태에서 보이는 활동과 할 수 있는지 여부 */
export function activityViews(state: GameState): ActivityView[] {
  const ch = state.ch;
  const scope = buildScope(state);
  const views: ActivityView[] = [];
  for (const def of ACTIVITIES) {
    if (ch.age < def.age[0] || ch.age > def.age[1]) continue;
    if (def.adult && ch.age < 19) continue;
    if (def.if && !evaluate(def.if, scope)) continue;
    const cost = Math.round((def.cost ?? 0) * state.world.economy.priceIndex);
    let reason: string | undefined;
    if (state.points.left < def.points) reason = '시간이 없다';
    else if (cost > 0 && ch.age < 19) {
      if (ch.family.type === 'facility' || ch.family.wealth <= 1) reason = '형편이 안 된다';
    } else if (cost > 0 && ch.res.cash < cost) reason = '돈이 모자란다';
    views.push({ def, enabled: !reason, reason, cost });
  }
  return views;
}

export interface ActivityResult {
  text: string;
  changes: Change[];
  /** 활동 결과로 체포 같은 카드가 생기면 true */
  queuedCard: boolean;
}

export function performActivity(state: GameState, id: string): ActivityResult | null {
  const def = ACTIVITY_BY_ID.get(id);
  const view = activityViews(state).find((v) => v.def.id === id);
  if (!def || !view || !view.enabled || state.phase !== 'action') return null;
  const ch = state.ch;
  state.points.left -= def.points;
  state.actions[id] = (state.actions[id] ?? 0) + 1;
  const rng = rngFor(state.seed, 'act', ch.age, id, state.actions[id]);
  const changes: Change[] = [];
  const ctx: Record<string, string> = {};
  let text = def.log ?? def.desc;
  let queuedCard = false;

  if (view.cost > 0 && ch.age >= 19) {
    ch.res.cash -= view.cost;
    changes.push({ text: `현금 −${formatWon(view.cost)}`, sign: 'bad' });
  }
  applyEffects(state, def.effects, { ctx, rng, changes });

  for (const d of def.discover ?? []) {
    const t = ch.talents.find((x) => x.key === d.talent && !x.discovered);
    if (t && rng.chance(d.chance)) {
      t.discovered = true;
      changes.push({ text: `숨은 재능 발견: ${TALENT_LABEL[t.key]}`, sign: 'good' });
      text = `${TALENT_LABEL[t.key]}에 소질이 있다는 걸 알았다. 하면 할수록 손에 붙는다.`;
    }
  }

  switch (def.special) {
    case 'friend': {
      const friends = alive(ch, 'friend');
      if (friends.length < 5 && rng.chance(0.35)) {
        const f = addFriend(state, rng);
        changes.push({ text: `새 친구: ${f.name}`, sign: 'good' });
        text = `${josa(f.name, '와/과')} 친해졌다.`;
      } else if (friends.length > 0) {
        const f = rng.pick(friends);
        f.closeness = Math.min(100, f.closeness + 10);
        text = `${josa(f.name, '와/과')} 시간을 보냈다.`;
      }
      break;
    }
    case 'dating': {
      if (partnerOf(ch) || spouseOf(ch)) break;
      const p = 0.22 + (ch.stats.looks + ch.stats.sociability - 100) / 250;
      if (rng.chance(Math.max(0.05, Math.min(0.6, p)))) {
        const partner = startPartner(state, rng);
        changes.push({ text: `연인: ${partner.name}`, sign: 'good' });
        text = `소개팅에서 만난 ${josa(partner.name, '와/과')} 사귀기로 했다.`;
      } else {
        text = '애프터 신청은 읽고 답이 없었다.';
      }
      break;
    }
    case 'date':
      changeCloseness(ch, partnerOf(ch) ? 'partner' : 'spouse', 8);
      break;
    case 'family':
      changeCloseness(ch, 'parents', 6);
      changeCloseness(ch, 'spouse', 6);
      changeCloseness(ch, 'child', 6);
      changeCloseness(ch, 'grandparent', 6);
      break;
    case 'parttime': {
      const earned = Math.round(state.world.economy.minWage * 936 * rng.float(0.6, 1));
      ch.res.cash += earned;
      changes.push({ text: `현금 ${signedWon(earned)}`, sign: 'good' });
      if (ch.edu.status === 'high' || ch.edu.status === 'middle') ch.edu.grade = Math.max(0, ch.edu.grade - 2);
      break;
    }
    case 'theft': {
      if (rng.chance(0.75)) {
        const gain = Math.round(rng.int(3, 50) * 10_000);
        ch.res.cash += gain;
        changes.push({ text: `현금 ${signedWon(gain)}`, sign: 'good' });
        text = '아무도 보지 않았다. 심장이 한참 동안 빨리 뛰었다.';
      } else {
        text = '계산대 직원과 눈이 마주쳤다. 일단 도망쳤다.';
      }
      if (rng.chance(0.25)) {
        state.queue.push({ eventId: 'arrested', ctx: { crime: 'theft', 혐의: '절도' } });
        queuedCard = true;
      }
      break;
    }
    case 'gamble': {
      const stake = Math.round(Math.max(0, ch.res.cash) * 0.3);
      if (stake <= 0) {
        text = '충전할 돈이 없다.';
        break;
      }
      const delta = rng.chance(0.4) ? Math.round(stake * rng.float(0.5, 1.5)) : -Math.round(stake * rng.float(0.5, 1));
      ch.res.cash += delta;
      changes.push({ text: `현금 ${signedWon(delta)}`, sign: delta > 0 ? 'good' : 'bad' });
      text = delta > 0 ? '땄다. 한 번만 더 하면 두 배다.' : '잃었다. 본전만 찾으면 그만둔다.';
      if (rng.chance(0.15)) addFlag(state, 'gambling_addict', changes);
      if (rng.chance(0.04)) {
        state.queue.push({ eventId: 'arrested', ctx: { crime: 'gambling', 혐의: '도박' } });
        queuedCard = true;
      }
      break;
    }
    case 'counsel': {
      if (ch.flags.bullying_victim && rng.chance(0.4)) {
        removeFlag(state, 'bullying_victim', changes);
        addFlag(state, 'bullying_overcome', changes);
        text = '"그건 네 잘못이 아니었어." 그 말을 오래 붙들고 있었다.';
      } else if (ch.flags.hazing_victim && rng.chance(0.3)) {
        removeFlag(state, 'hazing_victim', changes);
        text = '군대 얘기를 처음으로 끝까지 했다. 밤에 덜 깬다.';
      }
      break;
    }
    case 'checkup':
      addFlag(state, 'checked_up', changes);
      break;
    case 'certificate':
      if (rng.chance(0.3 + ch.stats.intelligence / 250)) {
        addFlag(state, 'certified', changes);
        text = '합격. 자격증이 나왔다.';
      } else {
        text = '두 문제 차이로 떨어졌다.';
      }
      break;
    case 'drink':
      if (rng.chance(0.12)) addFlag(state, 'heavy_drinker', changes);
      break;
    case 'motel':
    case 'intimacy': {
      // 성인 커플만 (활동 조건 family.partnerAdult). 묘사는 하지 않고 관계만 가까워진다
      const married = Boolean(spouseOf(ch));
      changeCloseness(ch, married ? 'spouse' : 'partner', def.special === 'motel' ? 8 : 6);
      const kids = alive(ch, 'child').length;
      const femaleAge = ch.sex === 'F' ? ch.age : npcAgeOf(state, married ? spouseOf(ch) : partnerOf(ch));
      if (femaleAge <= 44) {
        if (married && kids < 3 && rng.chance(0.06)) {
          state.queue.push({ eventId: 'pregnancy', ctx: {} });
          queuedCard = true;
        } else if (!married && rng.chance(0.03) && EVENT_BY_ID.has('rom_pregnancy_scare')) {
          state.queue.push({ eventId: 'rom_pregnancy_scare', ctx: {} });
          queuedCard = true;
        }
      }
      break;
    }
    case 'shopping':
      // 옷장 스타일이 아직 없으면 쇼핑하면서 하나가 정해진다
      if (!ch.flags.style_basic && !ch.flags.style_trendy && !ch.flags.style_luxury && !ch.flags.style_comfort) {
        addFlag(state, rng.chance(0.6) ? 'style_trendy' : 'style_basic', changes);
      }
      break;
    case 'diet': {
      // 배달·외식비를 아낀다
      const saved = Math.round(rng.int(30, 80) * 10_000 * state.world.economy.priceIndex);
      ch.res.cash += saved;
      changes.push({ text: `식비 절약 ${signedWon(saved)}`, sign: 'good' });
      if (ch.flags.diet_junk) {
        if (rng.chance(0.5)) {
          removeFlag(state, 'diet_junk', changes);
          text = '배달앱을 지웠다. 냉장고에 채소가 생겼다.';
        }
      } else if (!ch.flags.diet_healthy && rng.chance(0.35)) {
        addFlag(state, 'diet_healthy', changes);
        text = '저염식이 입에 붙었다. 건강검진 수치가 좋아졌다.';
      }
      break;
    }
    case 'foodie':
      if (!ch.flags.diet_junk && rng.chance(ch.flags.diet_healthy ? 0.06 : 0.12)) {
        removeFlag(state, 'diet_healthy', changes);
        addFlag(state, 'diet_junk', changes);
        text = '야식이 습관이 됐다. 바지가 끼기 시작했다.';
      }
      break;
  }

  if (ch.edu.status !== 'none' && id === 'study') {
    ch.edu.studyThisYear += 1;
  }

  return { text, changes, queuedCard };
}
