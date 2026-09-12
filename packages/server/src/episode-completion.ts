import { randomUUID } from "node:crypto";
import { extractionAuditDraftForJob, type EpisodeCapsuleResult, type ExtractionAuditSubmission, type ExtractionDraftResult, type ExtractionResult, type ReconciliationSubmission } from "@rcm/shared";
import type { RcmDatabase } from "./db.js";
import { now } from "./db.js";
import { normalizeKeyDialogueDisplaySpans, normalizeStandaloneKeyDialogues, validateExtractionSources, ingestExtraction } from "./ingest.js";
import { markJobComplete } from "./jobs.js";
import { ExtractionValidationError } from "./extraction-completion.js";
import { staleTranscriptBlocks } from "./episodes.js";
import { flushRelationshipProjectionQueue } from "./relationship-projections.js";
import { applyExtractionAuditPatch, recordExtractionAudit } from "./extraction-audit.js";
import { fingerprintMatches, type SourceFingerprintItem } from "./source-fingerprint.js";
import { lockInitialCalibration } from "./initial-calibration.js";
import { applyReconciliation } from "./reconciliation.js";
import { enqueueFinalLedgerConsistency } from "./ledger-consistency.js";
import { maybeEnqueueStorySpine } from "./story-spine.js";

function containedMemoryIds(db: RcmDatabase, chatId: string, sourceIds: Set<string>): string[] {
  const rows = db.prepare("SELECT memory_id,message_id FROM evidence_spans WHERE chat_id=? AND memory_id IS NOT NULL").all(chatId) as Array<{ memory_id: string; message_id: string }>;
  const byMemory = new Map<string, string[]>();
  for (const row of rows) byMemory.set(row.memory_id, [...(byMemory.get(row.memory_id) ?? []), row.message_id]);
  return [...byMemory].filter(([, ids]) => ids.length > 0 && ids.every((id) => sourceIds.has(id))).map(([id]) => id);
}

function filterSections(sourceIds: Set<string>, result: EpisodeCapsuleResult): EpisodeCapsuleResult["sections"] {
  return result.sections.map((section) => ({
    ...section,
    sourceMessageIds: section.sourceMessageIds.filter((id) => sourceIds.has(id)),
    evidence: section.evidence.filter((item) => sourceIds.has(item.messageId)),
    keyDialogues: section.keyDialogues.filter((item) => sourceIds.has(item.messageId)),
  })).filter((section) => section.sourceMessageIds.length > 0 && section.evidence.length > 0);
}

export function completeEpisodeJob(
  db: RcmDatabase,
  jobId: string,
  workerId: string,
  result: EpisodeCapsuleResult,
  reconciliation?: ReconciliationSubmission,
  audit?: ExtractionAuditSubmission,
): { chatId: string; warnings: string[]; pendingReconciliations: number } {
  const job = db.prepare("SELECT chat_id,payload_json FROM jobs WHERE id=? AND lease_owner=? AND status='leased'").get(jobId, workerId) as
    | { chat_id: string; payload_json: string }
    | undefined;
  if (!job) throw Object.assign(new Error("Lease not found"), { code: "LEASE_NOT_FOUND" });
  const payload = JSON.parse(job.payload_json) as { sourceMessageIds?: string[]; sourceFingerprint?: SourceFingerprintItem[]; episodeId?: string; postExtractionReview?: boolean; batchId?: string; backfillRunId?: string };
  const sourceMessageIds = payload.sourceMessageIds ?? [];
  const episodeId = payload.episodeId ?? "";
  const sourceSet = new Set(sourceMessageIds);
  if (payload.sourceFingerprint?.length && !fingerprintMatches(db, job.chat_id, payload.sourceFingerprint)) {
    db.transaction(() => {
      db.prepare("UPDATE extraction_audits SET status='stale',error='Source fingerprint changed',updated_at=? WHERE job_id=?").run(now(), jobId);
      db.prepare("UPDATE jobs SET status='done',lease_owner=NULL,leased_until=NULL,last_error='Source fingerprint changed before completion',updated_at=? WHERE id=?").run(now(), jobId);
      db.prepare("UPDATE episodes SET status='failed',last_error='Source changed; reprocess required',updated_at=? WHERE id=?").run(now(), episodeId);
      for (const id of sourceMessageIds) db.prepare("UPDATE messages SET extraction_state=CASE WHEN host_visibility IN ('active','all_before') THEN 'pending' ELSE 'blocked' END,updated_at=? WHERE chat_id=? AND message_id=?").run(now(), job.chat_id, id);
    })();
    return { chatId: job.chat_id, warnings: ["원문이 변경되어 오래된 에피소드 추출·검수 결과를 적용하지 않았습니다."], pendingReconciliations: 0 };
  }
  if (sourceMessageIds.length > 0) {
    const placeholders = sourceMessageIds.map(() => "?").join(",");
    const available = db.prepare(`SELECT count(*) AS count FROM messages WHERE chat_id=? AND message_id IN (${placeholders}) AND host_visibility IN ('active','all_before') AND content IS NOT NULL`)
      .get(job.chat_id, ...sourceMessageIds) as { count: number };
    if (available.count !== sourceMessageIds.length) throw Object.assign(new Error("보류 구간의 원문 가시성이 변경되었습니다."), { code: "EPISODE_SOURCE_CHANGED" });
  }
  let extraction: ExtractionResult = {
    language: "en",
    entities: result.entities,
    sourcePassages: result.sourcePassages,
    memories: [{ ...result.capsule, key: `episode:${episodeId}`, type: "episode" }],
    assertions: result.assertions,
    beliefs: result.beliefs,
    relationshipEvents: result.relationshipEvents,
    promises: result.promises,
    socialKnowledge: result.socialKnowledge,
    relationshipBaselines: result.relationshipBaselines,
    physicalIntimacy: result.physicalIntimacy,
  };
  const prepared = normalizeKeyDialogueDisplaySpans(db, job.chat_id, sourceMessageIds, extraction);
  const draft = extractionAuditDraftForJob({ kind: "episode", episode: { episodeId } as any }, result);
  const validationErrors = validateExtractionSources(db, job.chat_id, sourceMessageIds, prepared);
  if (validationErrors.length) throw new ExtractionValidationError(validationErrors);
  if (payload.postExtractionReview && (!audit?.patch || audit.error)) {
    throw new Error(audit?.error ? `Extraction audit failed: ${audit.error}` : "Worker did not provide the requested extraction audit");
  }
  let auditedDraft: ExtractionDraftResult = draft;
  if (audit?.patch) {
    const audited = applyExtractionAuditPatch(db, job.chat_id, sourceMessageIds, draft, audit.patch);
    if (!audited.result.memories.some((memory) => memory.key === `episode:${episodeId}`)) {
      throw new Error("Extraction audit removed the required episode parent without an explicit pending decision");
    }
    auditedDraft = audited.result;
  }
  const sections = filterSections(sourceSet, result).map((section) => ({
    ...section,
    keyDialogues: normalizeStandaloneKeyDialogues(db, job.chat_id, sourceMessageIds, section.keyDialogues),
  }));
  let pendingReconciliations = 0;
  db.transaction(() => {
    if (audit?.patch) {
      const pendingRefs = audit.patch.keepPendingItemRefs ?? [];
      recordExtractionAudit(db, job.chat_id, jobId, sourceMessageIds, draft, audit, pendingRefs.length ? "pending_review" : "applied", undefined, payload.sourceFingerprint);
      pendingReconciliations += pendingRefs.length;
    }
    const reconciled = applyReconciliation(db, job.chat_id, jobId, sourceMessageIds, auditedDraft, reconciliation);
    pendingReconciliations += reconciled.pending;
    extraction = normalizeKeyDialogueDisplaySpans(db, job.chat_id, sourceMessageIds, reconciled.result);
    const previousChildren = containedMemoryIds(db, job.chat_id, sourceSet);
    ingestExtraction(db, job.chat_id, extraction, jobId, payload.batchId);
    if (payload.batchId) db.prepare("UPDATE extraction_batches SET status='applied',draft_json=?,final_json=?,audit_patch_json=?,updated_at=? WHERE id=?").run(JSON.stringify(prepared), JSON.stringify(extraction), audit?.patch ? JSON.stringify(audit.patch) : null, now(), payload.batchId);
    lockInitialCalibration(db, job.chat_id);
    const parent = db.prepare("SELECT id FROM memories WHERE chat_id=? AND memory_key=?").get(job.chat_id, `episode:${episodeId}`) as { id: string };
    const children = previousChildren.filter((id) => id !== parent.id);
    if (children.length > 0) {
      const placeholders = children.map(() => "?").join(",");
      db.prepare(`UPDATE memories SET capsule_parent_id=?,updated_at=? WHERE id IN (${placeholders})`).run(parent.id, now(), ...children);
      db.prepare(`DELETE FROM memory_fts WHERE memory_id IN (${placeholders})`).run(...children);
      for (const id of children) db.prepare("DELETE FROM embedding_items WHERE kind='memory' AND source_id=?").run(id);
    }
    db.prepare("DELETE FROM episode_sections WHERE episode_id=?").run(episodeId);
    const insert = db.prepare(`
      INSERT INTO episode_sections(id,episode_id,chat_id,ordinal,title,summary,source_message_ids_json,evidence_json,key_dialogues_json,token_count,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `);
    sections.forEach((section, index) => insert.run(
      randomUUID(), episodeId, job.chat_id, index, section.title, section.summary,
      JSON.stringify(section.sourceMessageIds), JSON.stringify(section.evidence), JSON.stringify(section.keyDialogues),
      Math.max(1, Math.ceil(section.summary.length / 3.5)), now(),
    ));
    staleTranscriptBlocks(db, job.chat_id, sourceMessageIds);
    db.prepare(`
      UPDATE episodes SET title=?,summary=?,status='capsuled',resolution='capsule',memory_id=?,last_error=NULL,end_revision=(SELECT revision FROM chats WHERE id=?),updated_at=?
      WHERE id=? AND chat_id=?
    `).run(extraction.memories[0]?.title ?? result.capsule.title, extraction.memories[0]?.content ?? result.capsule.content, parent.id, job.chat_id, now(), episodeId, job.chat_id);
    if (!markJobComplete(db, jobId, workerId)) throw new Error("Lease not found while completing episode");
  })();
  const finalLedger = payload.backfillRunId ? enqueueFinalLedgerConsistency(db, job.chat_id, payload.backfillRunId) : undefined;
  if (!finalLedger || finalLedger.state === "not_needed") {
    flushRelationshipProjectionQueue(db, job.chat_id, payload.backfillRunId);
  }
  maybeEnqueueStorySpine(db, job.chat_id, payload.backfillRunId);
  return { chatId: job.chat_id, warnings: [], pendingReconciliations };
}
