// 표로 쓴 사건 목록을 펼쳐 엔진에 넘긴다. 목록마다 쓰는 태그도 함께 들고 온다.
// 새 목록을 더하려면 data/catalog/에 JSON, 여기에 펼치는 함수를 한 줄 더한다.

import type { EventDef, TagDef } from '../schema';
import physiology from '../../../data/catalog/physiology.json';
import medical from '../../../data/catalog/medical.json';
import nutrition from '../../../data/catalog/nutrition.json';
import romance from '../../../data/catalog/romance.json';
import parenting from '../../../data/catalog/parenting.json';
import { expandPhysiology, type PhysiologyCatalog } from './physiology';
import { expandMedical, type MedicalCatalog } from './medical';
import { expandNutrition, type NutritionCatalog } from './nutrition';
import { expandRomance, type RomanceCatalog } from './romance';
import { expandParenting, type ParentingCatalog } from './parenting';

const SOURCES = {
  'catalog/physiology.json': [physiology as unknown as PhysiologyCatalog, expandPhysiology],
  'catalog/medical.json': [medical as unknown as MedicalCatalog, expandMedical],
  'catalog/nutrition.json': [nutrition as unknown as NutritionCatalog, expandNutrition],
  'catalog/romance.json': [romance as unknown as RomanceCatalog, expandRomance],
  'catalog/parenting.json': [parenting as unknown as ParentingCatalog, expandParenting],
} as const;

export const CATALOG_FILES: Record<string, EventDef[]> = {};
export const CATALOG_TAGS: TagDef[] = [];

for (const [file, [data, expand]] of Object.entries(SOURCES)) {
  CATALOG_FILES[file] = (expand as (d: unknown) => EventDef[])(data);
  CATALOG_TAGS.push(...((data as { tags?: TagDef[] }).tags ?? []));
}
