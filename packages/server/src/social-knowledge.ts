import { randomUUID } from "node:crypto";
import type { ExtractionResult, SocialKnowledge } from "@rcm/shared";
import type { RcmDatabase } from "./db.js";
import { now } from "./db.js";
import { normalizeEntityName } from "./entities.js";

export type SocialKnowledgeLevel = "aware_of" | "met";

interface EventRow {
  id: string;
  holder: string;
  subject: string;
  action: "establish" | "retract";
  level: SocialKnowledgeLevel | null;
  known_as_json: string;
  evidence_json: string;
  manual: number;
  created_revision: number;
  created_at: number;
}

export interface SocialKnowledgeItem {
  id: string;
  holder: string;
  subject: string;
  level: SocialKnowledgeLevel;
  knownAs: string[];
  evidence: Array<{ messageId: string; quote?: string }>;
  manual: boolean;
  updatedAt: number;
}

const levelRank = (value: SocialKnowledgeLevel): number => value === "met" ? 2 : 1;
const nextEventTime = (db: RcmDatabase, chatId: string): number => Math.max(
  now(),
  Number((db.prepare("SELECT MAX(created_at) value FROM social_knowledge_events WHERE chat_id=?").get(chatId) as { value: number | null }).value ?? 0) + 1,
);
const parseArray = <T>(value: string): T[] => {
  try { return JSON.parse(value) as T[]; }
  catch { return []; }
};

export function listSocialKnowledge(db: RcmDatabase, chatId: string): SocialKnowledgeItem[] {
  const rows = db.prepare(`
    SELECT id,holder,subject,action,level,known_as_json,evidence_json,manual,created_revision,created_at
    FROM social_knowledge_events WHERE chat_id=? AND active=1
    ORDER BY COALESCE(source_end_ordinal,source_start_ordinal,-1),created_revision,created_at,id
  `).all(chatId) as EventRow[];
  const current = new Map<string, SocialKnowledgeItem>();
  for (const row of rows) {
    const key = `${normalizeEntityName(row.holder)}\0${normalizeEntityName(row.subject)}`;
    if (row.action === "retract") { current.delete(key); continue; }
    if (!row.level) continue;
    const previous = current.get(key);
    const knownAs = [...new Set([...(previous?.knownAs ?? []), ...parseArray<string>(row.known_as_json)])];
    const evidence = [...(previous?.evidence ?? []), ...parseArray<Array<{ messageId: string; quote?: string }>[number]>(row.evidence_json)]
      .filter((item, index, items) => items.findIndex((candidate) => candidate.messageId === item.messageId && (candidate.quote ?? "") === (item.quote ?? "")) === index);
    current.set(key, {
      id: row.id,
      holder: row.holder,
      subject: row.subject,
      level: previous && levelRank(previous.level) > levelRank(row.level) ? previous.level : row.level,
      knownAs,
      evidence,
      manual: Boolean(row.manual || previous?.manual),
      updatedAt: row.created_at,
    });
  }
  return [...current.values()].sort((left, right) => left.holder.localeCompare(right.holder) || left.subject.localeCompare(right.subject));
}

function evidenceOrdinals(db: RcmDatabase, chatId: string, evidence: SocialKnowledge["evidence"]): { start: number | null; end: number | null } {
  if (evidence.length === 0) return { start: null, end: null };
  const ids = [...new Set(evidence.map((item) => item.messageId))];
  const row = db.prepare(`SELECT MIN(ordinal) start,MAX(ordinal) end FROM messages WHERE chat_id=? AND message_id IN (${ids.map(() => "?").join(",")})`)
    .get(chatId, ...ids) as { start: number | null; end: number | null };
  return row ?? { start: null, end: null };
}

export function ingestSocialKnowledge(
  db: RcmDatabase,
  chatId: string,
  items: SocialKnowledge[],
  memoryByKey: Map<string, string> = new Map(),
  sourceBatchId?: string,
): number {
  const chat = db.prepare("SELECT revision FROM chats WHERE id=?").get(chatId) as { revision: number } | undefined;
  if (!chat) return 0;
  let inserted = 0;
  for (const item of items) {
    if (normalizeEntityName(item.holder) === normalizeEntityName(item.subject)) continue;
    const current = listSocialKnowledge(db, chatId).find((row) =>
      normalizeEntityName(row.holder) === normalizeEntityName(item.holder)
      && normalizeEntityName(row.subject) === normalizeEntityName(item.subject));
    const knownAs = [...new Set(item.knownAs.map((value) => value.trim()).filter(Boolean))];
    if (current && levelRank(current.level) >= levelRank(item.level)
      && knownAs.every((value) => current.knownAs.some((known) => normalizeEntityName(known) === normalizeEntityName(value)))) continue;
    const range = evidenceOrdinals(db, chatId, item.evidence);
    db.prepare(`
      INSERT INTO social_knowledge_events(
        id,chat_id,holder,subject,action,level,known_as_json,evidence_json,source_memory_id,
        source_batch_id,source_start_ordinal,source_end_ordinal,manual,active,created_revision,created_at
      ) VALUES(?,?,?,?,'establish',?,?,?,?,?,?,?,0,1,?,?)
    `).run(
      randomUUID(), chatId, item.holder, item.subject, item.level, JSON.stringify(knownAs), JSON.stringify(item.evidence),
      item.memoryKey ? memoryByKey.get(item.memoryKey) ?? null : null, sourceBatchId ?? null, range.start, range.end, chat.revision, now(),
    );
    inserted += 1;
  }
  return inserted;
}

export function setManualSocialKnowledge(
  db: RcmDatabase,
  chatId: string,
  input: { holder: string; subject: string; level: SocialKnowledgeLevel; knownAs: string[]; previousHolder?: string; previousSubject?: string },
): SocialKnowledgeItem[] {
  const chat = db.prepare("SELECT revision FROM chats WHERE id=?").get(chatId) as { revision: number } | undefined;
  if (!chat) throw new Error("Chat not found");
  if (normalizeEntityName(input.holder) === normalizeEntityName(input.subject)) throw new Error("Holder and subject must differ");
  const ordinal = (db.prepare("SELECT MAX(ordinal) ordinal FROM messages WHERE chat_id=?").get(chatId) as { ordinal: number | null }).ordinal;
  const timestamp = nextEventTime(db, chatId);
  const previousHolder = input.previousHolder?.trim() || input.holder.trim();
  const previousSubject = input.previousSubject?.trim() || input.subject.trim();
  db.transaction(() => {
    if (listSocialKnowledge(db, chatId).some((item) => normalizeEntityName(item.holder) === normalizeEntityName(previousHolder) && normalizeEntityName(item.subject) === normalizeEntityName(previousSubject))) {
      db.prepare(`INSERT INTO social_knowledge_events(id,chat_id,holder,subject,action,level,known_as_json,evidence_json,source_start_ordinal,source_end_ordinal,manual,active,created_revision,created_at)
        VALUES(?,?,?,?,'retract',NULL,'[]','[]',?,?,1,1,?,?)`)
        .run(randomUUID(), chatId, previousHolder, previousSubject, ordinal, ordinal, chat.revision, timestamp);
    }
    db.prepare(`
      INSERT INTO social_knowledge_events(id,chat_id,holder,subject,action,level,known_as_json,evidence_json,source_start_ordinal,source_end_ordinal,manual,active,created_revision,created_at)
      VALUES(?,?,?,?,'establish',?,?,'[]',?,?,1,1,?,?)
    `).run(randomUUID(), chatId, input.holder.trim(), input.subject.trim(), input.level, JSON.stringify([...new Set(input.knownAs.map((value) => value.trim()).filter(Boolean))]), ordinal, ordinal, chat.revision, timestamp + 1);
  })();
  return listSocialKnowledge(db, chatId);
}

export function retractSocialKnowledge(db: RcmDatabase, chatId: string, holder: string, subject: string): SocialKnowledgeItem[] {
  const chat = db.prepare("SELECT revision FROM chats WHERE id=?").get(chatId) as { revision: number } | undefined;
  if (!chat) throw new Error("Chat not found");
  const ordinal = (db.prepare("SELECT MAX(ordinal) ordinal FROM messages WHERE chat_id=?").get(chatId) as { ordinal: number | null }).ordinal;
  db.prepare(`
    INSERT INTO social_knowledge_events(id,chat_id,holder,subject,action,level,known_as_json,evidence_json,source_start_ordinal,source_end_ordinal,manual,active,created_revision,created_at)
    VALUES(?,?,?,?,'retract',NULL,'[]','[]',?,?,1,1,?,?)
  `).run(randomUUID(), chatId, holder, subject, ordinal, ordinal, chat.revision, nextEventTime(db, chatId));
  return listSocialKnowledge(db, chatId);
}

export function socialOnlyResult(result: ExtractionResult): ExtractionResult {
  return {
    language: "en",
    entities: result.entities,
    memories: [], assertions: [], beliefs: [], relationshipEvents: [], promises: [],
    socialKnowledge: result.socialKnowledge,
  };
}

export function invalidateSocialKnowledgeEvidence(db: RcmDatabase, chatId: string, messageIds: Iterable<string>): number {
  const targets = new Set(messageIds);
  if (targets.size === 0) return 0;
  const activeMessages = new Set((db.prepare(`
    SELECT message_id FROM messages WHERE chat_id=? AND lifecycle IN ('committed','client_pruned') AND host_visibility IN ('active','all_before')
  `).all(chatId) as Array<{ message_id: string }>).map((row) => row.message_id));
  const rows = db.prepare("SELECT id,evidence_json FROM social_knowledge_events WHERE chat_id=? AND active=1 AND manual=0").all(chatId) as Array<{ id: string; evidence_json: string }>;
  let changed = 0;
  for (const row of rows) {
    const evidence = parseArray<{ messageId: string }>(row.evidence_json);
    if (!evidence.some((item) => targets.has(item.messageId))) continue;
    if (evidence.some((item) => activeMessages.has(item.messageId))) continue;
    changed += db.prepare("UPDATE social_knowledge_events SET active=0 WHERE id=? AND active=1").run(row.id).changes;
  }
  return changed;
}
