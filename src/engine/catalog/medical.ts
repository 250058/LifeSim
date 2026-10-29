// 작성 중: data/catalog/medical.json 을 사건으로 펼친다.

import type { EventDef, TagDef } from '../schema';

export interface MedicalCatalog {
  tags?: TagDef[];
}

export function expandMedical(data: MedicalCatalog): EventDef[] {
  void data;
  return [];
}
