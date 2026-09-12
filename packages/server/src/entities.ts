import type { ExtractionResult } from "@rcm/shared";
import type { RcmDatabase } from "./db.js";
import { refreshMemoryFts } from "./memory-search-document.js";

export const normalizeEntityName = (value: string): string => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export interface EntityItem {
  id: string;
  key: string;
  name: string;
  displayName: string;
  type: string;
  aliases: string[];
  origin: string;
  setupProminence: string;
  source: Array<{ sourceIndex: number; quote: string }>;
  userManaged: boolean;
}

export interface EntityMergePreview {
  revision: number;
  source: EntityItem;
  target: EntityItem;
  preservedAliases: string[];
  affected: { memories: number; relationships: number; beliefs: number; promises: number };
  busy: boolean;
}

export function listEntities(db: RcmDatabase, chatId: string): EntityItem[] {
  const rows = db.prepare(`SELECT id,entity_key AS key,name,CASE WHEN display_name='' THEN name ELSE display_name END AS displayName,
    type,origin,setup_prominence AS setupProminence,source_json AS source,user_managed AS userManaged
    FROM entities WHERE chat_id=? ORDER BY displayName COLLATE NOCASE`).all(chatId) as Array<Omit<EntityItem, "aliases" | "source" | "userManaged"> & { source: string; userManaged: number }>;
  const aliases = db.prepare("SELECT alias FROM aliases WHERE entity_id=? ORDER BY alias COLLATE NOCASE");
  return rows.map((row) => ({ ...row, source: parseJson(row.source, []), userManaged: row.userManaged === 1,
    aliases: (aliases.all(row.id) as Array<{ alias: string }>).map((item) => item.alias) }));
}

export function entityDisplayName(db: RcmDatabase, chatId: string, value: string): string {
  const normalized = normalizeEntityName(value);
  const entity = listEntities(db, chatId).find((item) => [item.key, item.name, item.displayName, ...item.aliases].some((candidate) => normalizeEntityName(candidate) === normalized));
  return entity?.displayName ?? value;
}

export interface ResolvedEntityIdentity {
  canonical: string;
  variants: string[];
  ambiguous: boolean;
}

/** Resolve identity-bearing ledger fields without guessing ambiguous aliases. */
export function buildEntityIdentityResolver(db: RcmDatabase, chatId: string): (value: string) => ResolvedEntityIdentity {
  const byValue = new Map<string, EntityItem[]>();
  for (const entity of listEntities(db, chatId)) {
    for (const value of [entity.id, entity.key, entity.name, entity.displayName, ...entity.aliases]) {
      const key = normalizeEntityName(value);
      const matches = byValue.get(key) ?? [];
      if (!matches.some((item) => item.id === entity.id)) matches.push(entity);
      byValue.set(key, matches);
    }
  }
  return (value: string): ResolvedEntityIdentity => {
    const matches = byValue.get(normalizeEntityName(value)) ?? [];
    if (matches.length !== 1) return { canonical: value, variants: [value], ambiguous: matches.length > 1 };
    const entity = matches[0]!;
    return {
      canonical: entity.name,
      variants: [...new Set([entity.id, entity.key, entity.name, entity.displayName, ...entity.aliases])],
      ambiguous: false,
    };
  };
}

export function previewEntityMerge(db: RcmDatabase, chatId: string, sourceId: string, targetId: string): EntityMergePreview {
  if (sourceId === targetId) throw Object.assign(new Error("Source and target entities must differ"), { code: "ENTITY_MERGE_SAME" });
  const entities = listEntities(db, chatId);
  const source = entities.find((item) => item.id === sourceId);
  const target = entities.find((item) => item.id === targetId);
  if (!source || !target) throw Object.assign(new Error("Entity not found"), { code: "ENTITY_NOT_FOUND" });
  const revision = (db.prepare("SELECT revision FROM chats WHERE id=?").get(chatId) as { revision: number } | undefined)?.revision;
  if (revision === undefined) throw Object.assign(new Error("Chat not found"), { code: "ENTITY_NOT_FOUND" });
  const names = new Set([source.key, source.name, ...source.aliases].map(normalizeEntityName));
  const contains = (value: string): boolean => names.has(normalizeEntityName(value));
  const memories = (db.prepare("SELECT participants_json,known_by_json,perspective FROM memories WHERE chat_id=?").all(chatId) as Array<{ participants_json: string; known_by_json: string; perspective: string | null }>).filter((row) =>
    [...JSON.parse(row.participants_json), ...JSON.parse(row.known_by_json), row.perspective].some((value) => typeof value === "string" && contains(value)),
  ).length;
  const relationshipRows = (db.prepare("SELECT from_entity,to_entity FROM relationship_events WHERE chat_id=? AND active=1").all(chatId) as Array<{ from_entity: string; to_entity: string }>)
    .filter((row) => contains(row.from_entity) || contains(row.to_entity));
  const relationships = new Set(relationshipRows.map((row) => `${normalizeEntityName(row.from_entity)}\0${normalizeEntityName(row.to_entity)}`)).size;
  const beliefs = (db.prepare("SELECT holder,subject FROM beliefs WHERE chat_id=? AND active=1").all(chatId) as Array<{ holder: string; subject: string }>).filter((row) => contains(row.holder) || contains(row.subject)).length;
  const promises = (db.prepare("SELECT promisor,promisee FROM promises WHERE chat_id=?").all(chatId) as Array<{ promisor: string; promisee: string }>).filter((row) => contains(row.promisor) || contains(row.promisee)).length;
  const aliases = [...new Set([target.name, ...target.aliases, source.name, source.key, ...source.aliases])].filter((value) => normalizeEntityName(value) !== normalizeEntityName(target.name));
  return { revision, source, target, preservedAliases: aliases, affected: { memories, relationships, beliefs, promises }, busy: Boolean(db.prepare("SELECT 1 FROM jobs WHERE chat_id=? AND status='leased' AND leased_until>? LIMIT 1").get(chatId, Date.now())) };
}

export function canonicalizeExtraction(db: RcmDatabase, chatId: string, source: ExtractionResult): ExtractionResult {
  const result = structuredClone(source);
  const known = listEntities(db, chatId);
  const aliasMap = new Map<string, EntityItem>();
  // Entity UUIDs are internal storage identifiers. They are never intended as
  // canonical prose, but defensively resolve them when an older prompt or a
  // provider response leaks one into an identity-bearing field.
  for (const entity of known) for (const value of [entity.id, entity.key, entity.name, entity.displayName, ...entity.aliases]) aliasMap.set(normalizeEntityName(value), entity);
  const replacements = new Map<string, string>();
  result.entities = result.entities.map((entity) => {
    const existing = [entity.key, entity.name, ...entity.aliases].map((value) => aliasMap.get(normalizeEntityName(value))).find(Boolean);
    if (!existing) {
      for (const value of [entity.key, entity.name, ...entity.aliases]) replacements.set(normalizeEntityName(value), entity.name);
      return entity;
    }
    for (const value of [entity.key, entity.name, ...entity.aliases]) replacements.set(normalizeEntityName(value), existing.name);
    return { key: existing.key, name: existing.name, type: existing.type, aliases: [...new Set([...existing.aliases, entity.name, ...entity.aliases])] };
  }).filter((entity, index, items) => items.findIndex((candidate) => candidate.key === entity.key) === index);
  const canonical = (value: string): string => replacements.get(normalizeEntityName(value)) ?? aliasMap.get(normalizeEntityName(value))?.name ?? value;
  for (const memory of result.memories) {
    memory.participants = memory.participants.map(canonical);
    memory.knownBy = memory.knownBy.map(canonical);
    if (memory.perspective) memory.perspective = canonical(memory.perspective);
    for (const landmark of memory.landmarkKinds ?? []) {
      if (landmark.pair) landmark.pair = [canonical(landmark.pair[0]), canonical(landmark.pair[1])];
    }
    if (memory.witnesses) for (const witness of memory.witnesses) witness.name = canonical(witness.name);
    if (memory.keyDialogues) for (const dialogue of memory.keyDialogues) {
      dialogue.speaker = canonical(dialogue.speaker);
      if (dialogue.access) for (const grant of dialogue.access) grant.holder = canonical(grant.holder);
    }
    for (const detail of memory.details ?? []) {
      detail.participants = detail.participants.map(canonical);
      detail.knownBy = detail.knownBy.map(canonical);
      if (detail.access) for (const grant of detail.access) grant.holder = canonical(grant.holder);
    }
  }
  for (const assertion of result.assertions) assertion.subject = canonical(assertion.subject);
  for (const relation of result.atomRelations ?? []) for (const grant of relation.access) grant.holder = canonical(grant.holder);
  for (const belief of result.beliefs) { belief.holder = canonical(belief.holder); belief.subject = canonical(belief.subject); }
  for (const event of result.relationshipEvents ?? []) { event.from = canonical(event.from); event.to = canonical(event.to); }
  for (const promise of result.promises) {
    promise.promisor = canonical(promise.promisor);
    promise.promisee = canonical(promise.promisee);
    if (promise.access) for (const grant of promise.access) grant.holder = canonical(grant.holder);
  }
  for (const item of result.socialKnowledge ?? []) { item.holder = canonical(item.holder); item.subject = canonical(item.subject); }
  for (const item of result.relationshipBaselines ?? []) { item.from = canonical(item.from); item.to = canonical(item.to); }
  for (const item of result.physicalIntimacy ?? []) {
    item.participants = [canonical(item.participants[0]), canonical(item.participants[1])];
    if (item.initiator) item.initiator = canonical(item.initiator);
    if (item.access) for (const grant of item.access) grant.holder = canonical(grant.holder);
  }
  return result;
}

const replaceJsonNames = (value: string, sourceNames: Set<string>, target: string): string => {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return value; }
  if (!Array.isArray(parsed)) return value;
  return JSON.stringify([...new Set(parsed.map((item) => typeof item === "string" && sourceNames.has(normalizeEntityName(item)) ? target : item))]);
};

const replaceLandmarkPairNames = (value: string, sourceNames: Set<string>, target: string): string => {
  let parsed: Array<Record<string, unknown>>;
  try { parsed = JSON.parse(value) as Array<Record<string, unknown>>; } catch { return value; }
  if (!Array.isArray(parsed)) return value;
  let changed = false;
  for (const landmark of parsed) if (Array.isArray(landmark.pair)) {
    landmark.pair = landmark.pair.map((item) => {
      if (typeof item !== "string" || !sourceNames.has(normalizeEntityName(item))) return item;
      changed = true;
      return target;
    });
  }
  return changed ? JSON.stringify(parsed) : value;
};

export function mergeEntities(db: RcmDatabase, chatId: string, sourceId: string, targetId: string, expectedRevision?: number): { source: string; target: string } {
  if (sourceId === targetId) throw Object.assign(new Error("Source and target entities must differ"), { code: "ENTITY_MERGE_SAME" });
  const active = db.prepare("SELECT 1 FROM jobs WHERE chat_id=? AND status='leased' AND leased_until>? LIMIT 1").get(chatId, Date.now());
  if (active) throw Object.assign(new Error("Pause the active extraction before merging entities"), { code: "ENTITY_MERGE_BUSY" });
  const getEntity = db.prepare("SELECT id,entity_key,name,display_name,type FROM entities WHERE id=? AND chat_id=?");
  const source = getEntity.get(sourceId, chatId) as { id: string; entity_key: string; name: string; display_name: string | null; type: string } | undefined;
  const target = getEntity.get(targetId, chatId) as { id: string; entity_key: string; name: string; display_name: string | null; type: string } | undefined;
  if (!source || !target) throw Object.assign(new Error("Entity not found"), { code: "ENTITY_NOT_FOUND" });
  const revision = (db.prepare("SELECT revision FROM chats WHERE id=?").get(chatId) as { revision: number }).revision;
  if (expectedRevision !== undefined && expectedRevision !== revision) throw Object.assign(new Error("Derived data changed after preview; review the merge again"), { code: "ENTITY_MERGE_STALE" });
  const sourceAliases = (db.prepare("SELECT alias FROM aliases WHERE entity_id=?").all(source.id) as Array<{ alias: string }>).map((row) => row.alias);
  const sourceNames = new Set([source.entity_key, source.name, source.display_name || source.name, ...sourceAliases].map(normalizeEntityName));
  const matches = (value: string): boolean => sourceNames.has(normalizeEntityName(value));

  return db.transaction(() => {
    // A merge is an explicit user identity decision. Keep the chosen target
    // through later derived-memory rebuilds even when it originated in a
    // transcript rather than the setup ledger.
    db.prepare("UPDATE entities SET user_managed=1,display_name=CASE WHEN display_name='' THEN name ELSE display_name END WHERE id=? AND chat_id=?")
      .run(target.id, chatId);
    const aliasInsert = db.prepare("INSERT OR IGNORE INTO aliases(entity_id,alias,normalized) VALUES(?,?,?)");
    for (const alias of [source.name, source.entity_key, source.display_name || source.name, ...sourceAliases]) aliasInsert.run(target.id, alias, normalizeEntityName(alias));

    for (const [table, columns] of [
      ["promises", ["promisor", "promisee"]],
      ["beliefs", ["holder", "subject"]], ["assertions", ["subject"]], ["memory_dialogues", ["speaker"]],
      ["social_knowledge_events", ["holder", "subject"]],
      ["relationship_events", ["from_entity", "to_entity"]],
    ] as Array<[string, string[]]>) {
      for (const column of columns) {
        const rows = db.prepare(`SELECT rowid AS id,${column} AS value FROM ${table} WHERE chat_id=?`).all(chatId) as Array<{ id: number; value: string | null }>;
        const update = db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`);
        for (const row of rows) if (row.value && matches(row.value)) update.run(target.name, row.id);
      }
    }

    const accessRows = db.prepare("SELECT id,item_kind,item_id,holder,basis,evidence_json,confidence,active FROM item_access WHERE chat_id=?").all(chatId) as Array<{
      id: string; item_kind: string; item_id: string; holder: string; basis: string; evidence_json: string; confidence: number; active: number;
    }>;
    for (const row of accessRows) if (row.holder !== "__narrator_archive__" && matches(row.holder)) {
      const duplicate = db.prepare("SELECT id,evidence_json,confidence,active FROM item_access WHERE chat_id=? AND item_kind=? AND item_id=? AND holder=? AND id<>?")
        .get(chatId, row.item_kind, row.item_id, target.name, row.id) as { id: string; evidence_json: string; confidence: number; active: number } | undefined;
      if (duplicate) {
        const evidence = [...new Map([...parseJson<Array<{ messageId: string; quote?: string }>>(duplicate.evidence_json, []), ...parseJson<Array<{ messageId: string; quote?: string }>>(row.evidence_json, [])]
          .map((entry) => [`${entry.messageId}\0${entry.quote ?? ""}`, entry])).values()];
        db.prepare("UPDATE item_access SET evidence_json=?,active=?,confidence=? WHERE id=?")
          .run(JSON.stringify(evidence), Math.max(row.active, duplicate.active), Math.max(row.confidence, duplicate.confidence), duplicate.id);
        db.prepare("DELETE FROM item_access WHERE id=?").run(row.id);
      } else db.prepare("UPDATE item_access SET holder=? WHERE id=?").run(target.name, row.id);
    }

    const memories = db.prepare("SELECT id,participants_json,known_by_json,perspective,landmark_kinds_json FROM memories WHERE chat_id=?").all(chatId) as Array<{ id: string; participants_json: string; known_by_json: string; perspective: string | null; landmark_kinds_json: string }>;
    const updateMemory = db.prepare("UPDATE memories SET participants_json=?,known_by_json=?,perspective=?,landmark_kinds_json=? WHERE id=?");
    for (const memory of memories) {
      const participants = replaceJsonNames(memory.participants_json, sourceNames, target.name);
      const knownBy = replaceJsonNames(memory.known_by_json, sourceNames, target.name);
      const perspective = memory.perspective && matches(memory.perspective) ? target.name : memory.perspective;
      const landmarkKinds = replaceLandmarkPairNames(memory.landmark_kinds_json, sourceNames, target.name);
      if (participants !== memory.participants_json || knownBy !== memory.known_by_json || perspective !== memory.perspective || landmarkKinds !== memory.landmark_kinds_json) {
        updateMemory.run(participants, knownBy, perspective, landmarkKinds, memory.id);
        refreshMemoryFts(db, memory.id);
      }
    }
    const details = db.prepare("SELECT id,participants_json,known_by_json FROM memory_details WHERE chat_id=?").all(chatId) as Array<{ id: string; participants_json: string; known_by_json: string }>;
    for (const detail of details) db.prepare("UPDATE memory_details SET participants_json=?,known_by_json=?,updated_at=? WHERE id=?").run(
      replaceJsonNames(detail.participants_json, sourceNames, target.name), replaceJsonNames(detail.known_by_json, sourceNames, target.name), Date.now(), detail.id,
    );

    const baselines = db.prepare("SELECT id,from_entity,to_entity FROM relationship_baselines WHERE chat_id=? AND (from_entity=? OR to_entity=?)").all(chatId, source.name, source.name) as Array<{ id: string; from_entity: string; to_entity: string }>;
    for (const baseline of baselines) {
      const from = matches(baseline.from_entity) ? target.name : baseline.from_entity;
      const to = matches(baseline.to_entity) ? target.name : baseline.to_entity;
      const conflict = db.prepare("SELECT id FROM relationship_baselines WHERE chat_id=? AND from_entity=? AND to_entity=? AND id<>?").get(chatId, from, to, baseline.id) as { id: string } | undefined;
      if (from === to || conflict) db.prepare("DELETE FROM relationship_baselines WHERE id=?").run(baseline.id);
      else db.prepare("UPDATE relationship_baselines SET from_entity=?,to_entity=? WHERE id=?").run(from, to, baseline.id);
    }

    db.prepare("DELETE FROM relationship_projections WHERE chat_id=? AND (from_entity IN (?,?) OR to_entity IN (?,?))").run(chatId, source.name, target.name, source.name, target.name);
    db.prepare("DELETE FROM relationship_projection_queue WHERE chat_id=? AND (from_entity IN (?,?) OR to_entity IN (?,?))").run(chatId, source.name, target.name, source.name, target.name);

    const milestones = db.prepare("SELECT * FROM physical_intimacy_milestones WHERE chat_id=? AND (participant_a=? OR participant_b=? OR initiator=?) ORDER BY COALESCE(source_start_ordinal,2147483647),created_at").all(chatId, source.name, source.name, source.name) as Array<Record<string, any>>;
    const physicalMemoryIds = new Set<string>(milestones.flatMap((milestone) => milestone.source_memory_id ? [String(milestone.source_memory_id)] : []));
    for (const milestone of milestones) {
      const pair = [matches(milestone.participant_a) ? target.name : milestone.participant_a, matches(milestone.participant_b) ? target.name : milestone.participant_b].sort((left, right) => left.localeCompare(right));
      if (pair[0] === pair[1]) { db.prepare("DELETE FROM physical_intimacy_milestones WHERE id=?").run(milestone.id); continue; }
      const conflict = db.prepare("SELECT id,source_memory_id,source_start_ordinal,created_at,manual_override FROM physical_intimacy_milestones WHERE chat_id=? AND participant_a=? AND participant_b=? AND milestone_key=? AND id<>? ORDER BY manual_override DESC,COALESCE(source_start_ordinal,2147483647),created_at LIMIT 1")
        .get(chatId, pair[0], pair[1], milestone.milestone_key, milestone.id) as { id: string; source_memory_id: string | null; source_start_ordinal: number | null; created_at: number; manual_override: number } | undefined;
      if (conflict?.source_memory_id) physicalMemoryIds.add(conflict.source_memory_id);
      const conflictWins = conflict && (Number(conflict.manual_override) > Number(milestone.manual_override ?? 0)
        || Number(conflict.manual_override) === Number(milestone.manual_override ?? 0) && Number(conflict.source_start_ordinal ?? Number.MAX_SAFE_INTEGER) <= Number(milestone.source_start_ordinal ?? Number.MAX_SAFE_INTEGER));
      if (conflictWins) db.prepare("DELETE FROM physical_intimacy_milestones WHERE id=?").run(milestone.id);
      else {
        if (conflict) db.prepare("DELETE FROM physical_intimacy_milestones WHERE id=?").run(conflict.id);
        db.prepare("UPDATE physical_intimacy_milestones SET participant_a=?,participant_b=?,initiator=? WHERE id=?").run(pair[0], pair[1], milestone.initiator && matches(milestone.initiator) ? target.name : milestone.initiator, milestone.id);
      }
    }
    for (const memoryId of physicalMemoryIds) refreshMemoryFts(db, memoryId);

    const presence = db.prepare("SELECT scene_key,created_at FROM entity_scene_presence WHERE chat_id=? AND entity_name=? COLLATE NOCASE").all(chatId, source.name) as Array<{ scene_key: string; created_at: number }>;
    for (const row of presence) db.prepare("INSERT OR IGNORE INTO entity_scene_presence(chat_id,entity_name,scene_key,created_at) VALUES(?,?,?,?)").run(chatId, target.name, row.scene_key, row.created_at);
    db.prepare("DELETE FROM entity_scene_presence WHERE chat_id=? AND entity_name=? COLLATE NOCASE").run(chatId, source.name);
    const sourceProminence = db.prepare("SELECT durable_links,pinned FROM entity_prominence WHERE chat_id=? AND entity_name=? COLLATE NOCASE").get(chatId, source.name) as { durable_links: number; pinned: number } | undefined;
    const targetProminence = db.prepare("SELECT durable_links,pinned FROM entity_prominence WHERE chat_id=? AND entity_name=? COLLATE NOCASE").get(chatId, target.name) as { durable_links: number; pinned: number } | undefined;
    const sceneCount = (db.prepare("SELECT COUNT(*) count FROM entity_scene_presence WHERE chat_id=? AND entity_name=? COLLATE NOCASE").get(chatId, target.name) as { count: number }).count;
    const durableLinks = Number(sourceProminence?.durable_links ?? 0) + Number(targetProminence?.durable_links ?? 0);
    const pinned = Number(Boolean(sourceProminence?.pinned || targetProminence?.pinned));
    const tier = pinned || (sceneCount >= 4 && durableLinks > 0) ? "core" : sceneCount >= 2 || durableLinks > 0 ? "recurring" : "incidental";
    db.prepare(`INSERT INTO entity_prominence(chat_id,entity_name,tier,scene_count,durable_links,pinned,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(chat_id,entity_name) DO UPDATE SET tier=excluded.tier,scene_count=excluded.scene_count,durable_links=excluded.durable_links,pinned=excluded.pinned,updated_at=excluded.updated_at`)
      .run(chatId, target.name, tier, sceneCount, durableLinks, pinned, Date.now());
    db.prepare("DELETE FROM entity_prominence WHERE chat_id=? AND entity_name=? COLLATE NOCASE").run(chatId, source.name);
    for (const passage of db.prepare("SELECT id,speaker,access_json FROM source_passages WHERE chat_id=?").all(chatId) as Array<{id:string;speaker:string|null;access_json:string}>) {
      const grants = (JSON.parse(passage.access_json) as Array<{holder:string}>).map((grant) => ({ ...grant, holder: matches(grant.holder) ? target.name : grant.holder }));
      db.prepare("UPDATE source_passages SET speaker=?,access_json=? WHERE id=?").run(passage.speaker && matches(passage.speaker) ? target.name : passage.speaker, JSON.stringify(grants), passage.id);
    }
    // Consolidate duplicate source observations before changing the holder key.
    db.prepare(`DELETE FROM memory_recall_events WHERE chat_id=? AND holder=? AND EXISTS (
      SELECT 1 FROM memory_recall_events other WHERE other.chat_id=? AND other.holder=?
      AND other.memory_id=memory_recall_events.memory_id AND other.source_batch_id=memory_recall_events.source_batch_id)`).run(chatId, source.name, chatId, target.name);
    db.prepare("UPDATE memory_recall_events SET holder=? WHERE chat_id=? AND holder=?").run(target.name, chatId, source.name);
    const traces = db.prepare("SELECT mt.* FROM memory_traces mt JOIN memories m ON m.id=mt.memory_id WHERE m.chat_id=? AND mt.character_name=?").all(chatId, source.name) as Array<Record<string, any>>;
    for (const trace of traces) {
      db.prepare(`INSERT INTO memory_traces(memory_id,character_name,strength,salience,recall_count,last_recalled_revision,last_recalled_turn_seq,detail_level,distortion_type)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(memory_id,character_name) DO UPDATE SET strength=MAX(strength,excluded.strength),salience=MAX(salience,excluded.salience),recall_count=MAX(recall_count,excluded.recall_count),last_recalled_revision=MAX(last_recalled_revision,excluded.last_recalled_revision),last_recalled_turn_seq=MAX(COALESCE(last_recalled_turn_seq,excluded.last_recalled_turn_seq),COALESCE(excluded.last_recalled_turn_seq,last_recalled_turn_seq)),detail_level=CASE WHEN detail_level='clear' OR excluded.detail_level='clear' THEN 'clear' ELSE detail_level END`).run(
        trace.memory_id, target.name, trace.strength, trace.salience, trace.recall_count, trace.last_recalled_revision, trace.last_recalled_turn_seq, trace.detail_level, trace.distortion_type,
      );
    }
    db.prepare("DELETE FROM memory_traces WHERE character_name=? AND memory_id IN (SELECT id FROM memories WHERE chat_id=?)").run(source.name, chatId);

    db.prepare("UPDATE relationship_events SET active=0 WHERE chat_id=? AND from_entity=? AND to_entity=?").run(chatId, target.name, target.name);
    const projectionPairs = db.prepare("SELECT DISTINCT from_entity AS 'from',to_entity AS 'to' FROM relationship_events WHERE chat_id=? AND active=1 AND (from_entity=? OR to_entity=?)").all(chatId, target.name, target.name) as Array<{ from: string; to: string }>;
    for (const pair of projectionPairs) db.prepare(`INSERT INTO relationship_projection_queue(chat_id,from_entity,to_entity,queued_at,mode) VALUES(?,?,?,?,'replay')
      ON CONFLICT(chat_id,from_entity,to_entity) DO UPDATE SET queued_at=excluded.queued_at,mode='replay'`).run(chatId, pair.from, pair.to, Date.now());

    const beliefs = db.prepare("SELECT id,holder,subject,predicate FROM beliefs WHERE chat_id=? AND active=1 ORDER BY created_revision DESC,created_at DESC").all(chatId) as Array<{ id: string; holder: string; subject: string; predicate: string }>;
    const seenBeliefs = new Set<string>();
    for (const belief of beliefs) {
      const key = `${belief.holder}\0${belief.subject}\0${belief.predicate}`;
      if (seenBeliefs.has(key)) db.prepare("UPDATE beliefs SET active=0 WHERE id=?").run(belief.id); else seenBeliefs.add(key);
    }
    db.prepare("DELETE FROM entities WHERE id=? AND chat_id=?").run(source.id, chatId);
    return { source: source.name, target: target.name };
  })();
}
