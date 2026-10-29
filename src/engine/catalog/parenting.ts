// 작성 중: data/catalog/parenting.json 을 사건으로 펼친다.

import type { EventDef, TagDef } from '../schema';

export interface ParentingCatalog {
  tags?: TagDef[];
}

export function expandParenting(data: ParentingCatalog): EventDef[] {
  void data;
  return [];
}
