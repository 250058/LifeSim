// 작성 중: data/catalog/nutrition.json 을 사건으로 펼친다.

import type { EventDef, TagDef } from '../schema';

export interface NutritionCatalog {
  tags?: TagDef[];
}

export function expandNutrition(data: NutritionCatalog): EventDef[] {
  void data;
  return [];
}
