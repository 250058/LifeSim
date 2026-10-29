// 작성 중: data/catalog/romance.json 을 사건으로 펼친다.

import type { EventDef, TagDef } from '../schema';

export interface RomanceCatalog {
  tags?: TagDef[];
}

export function expandRomance(data: RomanceCatalog): EventDef[] {
  void data;
  return [];
}
