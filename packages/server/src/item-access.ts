import type { RcmDatabase } from "./db.js";

export const NARRATOR_ARCHIVE_HOLDER = "__narrator_archive__";

export type ItemAccessKind = "detail" | "dialogue" | "promise" | "physical_milestone" | "atom_relation";

export interface ItemAccessScope {
  explicit: boolean;
  narratorOnly: boolean;
  holders: string[];
}

const key = (kind: ItemAccessKind, id: string): string => `${kind}:${id}`;
const normalized = (value: string): string => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();

export interface ItemAccessRow { item_kind: ItemAccessKind; item_id: string; holder: string; evidence_json: string }

/** Keep kind and ID as index constraints; a long OR across pairs scans every
 * access row in the chat. Yield bounded batches so evidence validation can
 * remain the caller's responsibility. */
export function* readItemAccessBatches(db: RcmDatabase, chatId: string,
  items: Array<{ kind: ItemAccessKind; id: string }>): Generator<ItemAccessRow[]> {
  const byKind = new Map<ItemAccessKind, Set<string>>();
  for (const item of items) {
    const ids = byKind.get(item.kind) ?? new Set<string>();
    ids.add(item.id);
    byKind.set(item.kind, ids);
  }
  for (const [kind, ids] of byKind) {
    const unique = [...ids];
    for (let offset = 0; offset < unique.length; offset += 300) {
      const batch = unique.slice(offset, offset + 300);
      yield db.prepare(`SELECT item_kind,item_id,holder,evidence_json FROM item_access
        WHERE chat_id=? AND item_kind=? AND item_id IN (${batch.map(() => "?").join(",")}) AND active=1`)
        .all(chatId, kind, ...batch) as ItemAccessRow[];
    }
  }
}

export function loadItemAccess(
  db: RcmDatabase,
  chatId: string,
  items: Array<{ kind: ItemAccessKind; id: string }>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const rows of readItemAccessBatches(db, chatId, items)) {
    for (const row of rows) {
      const itemKey = key(row.item_kind, row.item_id);
      result.set(itemKey, [...(result.get(itemKey) ?? []), row.holder]);
    }
  }
  return result;
}

export function resolveItemAccess(
  access: Map<string, string[]>,
  kind: ItemAccessKind,
  id: string,
  fallback: string[] = [],
): ItemAccessScope {
  const rows = access.get(key(kind, id));
  if (!rows) return { explicit: false, narratorOnly: false, holders: [...new Set(fallback)] };
  const holders = [...new Set(rows.filter((holder) => holder !== NARRATOR_ARCHIVE_HOLDER))];
  return { explicit: true, narratorOnly: holders.length === 0, holders };
}

export function visibleTo(scope: ItemAccessScope, viewer: string, archive = false): boolean {
  if (archive) return true;
  if (scope.narratorOnly) return false;
  return scope.holders.some((holder) => normalized(holder) === normalized(viewer));
}

export function deactivateItemAccess(db: RcmDatabase, chatId: string, kind: ItemAccessKind, ids: string[]): void {
  if (!ids.length) return;
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    db.prepare(`UPDATE item_access SET active=0 WHERE chat_id=? AND item_kind=? AND item_id IN (${batch.map(() => "?").join(",")})`)
      .run(chatId, kind, ...batch);
  }
}

export function deactivateItemAccessByEvidence(db: RcmDatabase, chatId: string, messageIds: string[]): void {
  const unique = [...new Set(messageIds)];
  for (let offset = 0; offset < unique.length; offset += 300) {
    const batch = unique.slice(offset, offset + 300);
    if (!batch.length) continue;
    db.prepare(`UPDATE item_access SET active=0 WHERE chat_id=? AND active=1 AND EXISTS(
      SELECT 1 FROM json_each(item_access.evidence_json)
      WHERE json_extract(value,'$.messageId') IN (${batch.map(() => "?").join(",")})
    )`).run(chatId, ...batch);
  }
}
