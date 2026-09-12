import type { RcmDatabase } from "./db.js";

/**
 * Delete every chat-scoped derived record while preserving the source message
 * ledger, chat configuration and lineage row. Reset, reprocess and lineage
 * revert share this registry so new derived tables cannot drift between paths.
 */
export function deleteDerivedRows(db: RcmDatabase, chatId: string, options: { preserveInitialCalibration?: boolean } = {}): void {
  db.prepare("DELETE FROM memory_fts WHERE chat_id=?").run(chatId);
  db.prepare("DELETE FROM memory_detail_fts WHERE chat_id=?").run(chatId);
  for (const table of [
    "source_passages", "extraction_audits", "item_access", "atom_relations", "recall_logs", "conflicts", "jobs", "reconciliation_items", "memory_recall_events",
    "relationship_projection_queue", "relationship_projections", "relationship_events",
    "physical_intimacy_milestones", "promise_events", "promises", "social_knowledge_events",
    "entity_scene_presence", "entity_prominence", "beliefs", "assertions", "memory_edges",
    "episode_sections", "episode_messages", "episodes", "evidence_spans", "memory_dialogues", "memory_details", "memories",
    "extraction_batches", "regeneration_runs", "story_spine_nodes",
    "embedding_failures", "embedding_items", "embedding_blocks",
  ]) db.prepare(`DELETE FROM ${table} WHERE chat_id=?`).run(chatId);
  if (options.preserveInitialCalibration) {
    db.prepare("DELETE FROM relationship_baselines WHERE chat_id=? AND source<>'setup'").run(chatId);
    db.prepare("DELETE FROM entities WHERE chat_id=? AND origin NOT IN ('setup','manual') AND user_managed=0").run(chatId);
  } else {
    db.prepare("DELETE FROM relationship_baselines WHERE chat_id=?").run(chatId);
    db.prepare("DELETE FROM entities WHERE chat_id=?").run(chatId);
    db.prepare("DELETE FROM initial_calibrations WHERE chat_id=?").run(chatId);
  }
}
