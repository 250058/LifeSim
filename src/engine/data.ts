// 모든 JSON 데이터를 한곳에서 불러온다. 사건을 추가하려면 /data에 JSON을 넣고
// 아래 목록에 한 줄만 더하면 된다.

import type {
  ActivityDef,
  EventDef,
  JobDef,
  NamesData,
  RegionDef,
  TagDef,
  WorldData,
} from './schema';

import infant from '../../data/events/infant.json';
import elementary from '../../data/events/elementary.json';
import middle from '../../data/events/middle.json';
import high from '../../data/events/high.json';
import school from '../../data/events/school.json';
import youth from '../../data/events/youth.json';
import military from '../../data/events/military.json';
import adult from '../../data/events/adult.json';
import midlife from '../../data/events/midlife.json';
import senior from '../../data/events/senior.json';
import general from '../../data/events/general.json';
import disaster from '../../data/events/disaster.json';
import lifestyle from '../../data/events/lifestyle.json';
import substances from '../../data/events/substances.json';
import work from '../../data/events/work.json';
import schoolViolence from '../../data/arcs/school_violence.json';
import militaryAbuse from '../../data/arcs/military_abuse.json';
import voicePhishing from '../../data/arcs/voice_phishing.json';
import scamCompound from '../../data/arcs/scam_compound.json';
import politics from '../../data/arcs/politics.json';
import war from '../../data/arcs/war.json';

import tagsJson from '../../data/tags.json';
import jobsJson from '../../data/jobs.json';
import regionsJson from '../../data/regions.json';
import namesJson from '../../data/names.json';
import worldJson from '../../data/world.json';
import activitiesJson from '../../data/activities.json';
import { CATALOG_FILES, CATALOG_TAGS } from './catalog';

interface EventFile {
  events: EventDef[];
}

/** 파일 이름 → 사건 목록. 검증 도구가 파일별로 보고할 때 쓴다 */
export const EVENT_FILES: Record<string, EventDef[]> = {
  'events/infant.json': (infant as unknown as EventFile).events,
  'events/elementary.json': (elementary as unknown as EventFile).events,
  'events/middle.json': (middle as unknown as EventFile).events,
  'events/high.json': (high as unknown as EventFile).events,
  'events/school.json': (school as unknown as EventFile).events,
  'events/youth.json': (youth as unknown as EventFile).events,
  'events/military.json': (military as unknown as EventFile).events,
  'events/adult.json': (adult as unknown as EventFile).events,
  'events/midlife.json': (midlife as unknown as EventFile).events,
  'events/senior.json': (senior as unknown as EventFile).events,
  'events/general.json': (general as unknown as EventFile).events,
  'events/disaster.json': (disaster as unknown as EventFile).events,
  'events/lifestyle.json': (lifestyle as unknown as EventFile).events,
  // 성인기의 술·담배·약물 (substances.ts와 짝)
  'events/substances.json': (substances as unknown as EventFile).events,
  'arcs/school_violence.json': (schoolViolence as unknown as EventFile).events,
  'arcs/military_abuse.json': (militaryAbuse as unknown as EventFile).events,
  'arcs/voice_phishing.json': (voicePhishing as unknown as EventFile).events,
  'arcs/scam_compound.json': (scamCompound as unknown as EventFile).events,
  'arcs/politics.json': (politics as unknown as EventFile).events,
  'arcs/war.json': (war as unknown as EventFile).events,
  // 표로 쓴 생활 사건 (병원·몸·밥상·연애·육아)
  ...CATALOG_FILES,
  // 일터: 직업마다 따로 쓰지 않고 job.* 성질(고용 형태·교대·산재 등급)로 고르는 공통 사건 (work.ts와 짝).
  // 맨 끝에 둬서 기존 사건의 추첨 난수 순서를 바꾸지 않는다
  'events/work.json': (work as unknown as EventFile).events,
};

export const EVENTS: EventDef[] = Object.values(EVENT_FILES).flat();
export const EVENT_BY_ID: Map<string, EventDef> = new Map(EVENTS.map((e) => [e.id, e]));

export const TAGS: TagDef[] = [...(tagsJson as unknown as { tags: TagDef[] }).tags, ...CATALOG_TAGS];
export const TAG_BY_ID: Map<string, TagDef> = new Map(TAGS.map((t) => [t.id, t]));

/** data/jobs.json: 직업 정의와 분야·면허·연봉 근거 표 (표의 모양은 work.ts가 안다) */
interface JobsFile {
  jobs: JobDef[];
  fields?: unknown[];
  licenses?: unknown[];
  sources?: Record<string, string>;
}
const jobsFile = jobsJson as unknown as JobsFile;

export const JOBS: JobDef[] = jobsFile.jobs;
export const JOB_BY_ID: Map<string, JobDef> = new Map(JOBS.map((j) => [j.id, j]));
/** 분야·면허·연봉 근거 표 (work.ts가 형식을 정해 읽는다) */
export const JOB_TABLES = {
  fields: jobsFile.fields ?? [],
  licenses: jobsFile.licenses ?? [],
  sources: jobsFile.sources ?? {},
};

// 일터 사건(data/events/work.json)이 쓰는 태그: 계약·체불·산재·부업·훈련 의사 표시
for (const tag of (work as unknown as { tags?: TagDef[] }).tags ?? []) {
  TAGS.push(tag);
  TAG_BY_ID.set(tag.id, tag);
}

export const REGIONS: RegionDef[] = (regionsJson as unknown as { regions: RegionDef[] }).regions;
export const REGION_BY_ID: Map<string, RegionDef> = new Map(REGIONS.map((r) => [r.id, r]));

export const NAMES: NamesData = namesJson as unknown as NamesData;
export const WORLD: WorldData = worldJson as unknown as WorldData;

export const ACTIVITIES: ActivityDef[] = (activitiesJson as unknown as { activities: ActivityDef[] }).activities;
export const ACTIVITY_BY_ID: Map<string, ActivityDef> = new Map(ACTIVITIES.map((a) => [a.id, a]));

export function getEvent(id: string): EventDef {
  const ev = EVENT_BY_ID.get(id);
  if (!ev) throw new Error(`없는 사건: ${id}`);
  return ev;
}
