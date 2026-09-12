import { finalizeMcpAnswer } from "./mcp-answer.js";
import { mcpFacetSearchQuery } from "./mcp-query.js";
import { persistAutomaticActivationObservations, deliveredActivationObservation, type AutomaticActivationObservation } from "./recall-activation.js";
import { stageJobModelOutput } from "./jobs.js";
import { inspectDraftEvidence, describeEvidenceReview } from "./evidence-review.js";
import { emptyPacketManifest, mergePacketManifests, type PacketManifest } from "./packet-manifest.js";
import { queueSourceRecovery, retrieveSourceEvidence, renderSourceEvidence, sourceEvidenceAtomKey } from "./source-evidence.js";
import { trimAutomaticAtom, planAutomaticAtoms, selectCueAnchor, type AutomaticAtomPriority } from "./automatic-packet.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  CompleteJobRequestSchema,
  EpisodeCapsuleResultSchema,
  EpisodeCloseRequestSchema,
  EpisodeStartRequestSchema,
  estimateTokens,
  normalizeSearchTokens,
  FailJobRequestSchema,
  FollowRequestSchema,
  LeaseJobRequestSchema,
  RecallRequestSchema,
  ServerLlmConfigSchema,
  TurnPrepareRequestSchema,
  WorkerControlSchema,
  PrepareReconciliationRequestSchema,
  ReconciliationReviewResolutionSchema,
  RelationshipProjectionResultSchema,
  StorySpineConsolidationResultSchema,
  InitialCalibrationResultSchema,
  LedgerConsistencyResultSchema,
  LandmarkKindSchema,
  ResolvedSetupProjectionSchema,
  ManualLineageApplyRequestSchema,
  ManualLineagePreviewRequestSchema,
  LineageProbeApplyRequestSchema,
  LineageProbeRequestSchema,
  type MemoryContextItem,
  type MemoryToolOpportunity,
  MemoryLanguageSchema,
  RpProfileSchema,
  normalizeStoryTime,
  measureAuxiliaryPrompt,
  splitAuxiliarySource,
  RCM_API_REVISION,
  RCM_SERVER_VERSION,
} from "@rcm/shared";
import {backupServerSettings, type ServerConfig} from "./config.js";
import { openDatabase, type RcmDatabase } from "./db.js";
import { exportCompleteArchive, exportChatArchive, restoreChatArchive, inspectCompleteArchive, previewMemoryTransplant, restoreCompleteArchive, transplantCompleteArchive } from "./backup.js";
import { deleteChats, listAdminChats, listSourceLedger, reprocessChat, resetDerivedChat, saveSecret, saveVoyageKey } from "./admin.js";
import { recanonicalizeSourceLedger } from "./lifecycle.js";
import type { EmbeddingService } from "./embedding.js";
import { attachAuxiliaryPlan, cancelExtractionJobs, enqueueExtractionJobs, enqueueInitialCalibration, enqueueSocialKnowledgeBackfill, failJob, leaseJob, renewJobLease, requeueCancelledMessages, resplitFailedExtractionJob, setJobPipelineStage, type JobPipelineStage } from "./jobs.js";
import { completeExtractionJob, ExtractionValidationError } from "./extraction-completion.js";
import { completeEpisodeJob } from "./episode-completion.js";
import { hardDeleteMessage, hasDerivedState, purgeExpiredContent, syncSnapshot } from "./lifecycle.js";
import { automaticAssociativeCap, automaticHardMemoryLimit, automaticHardTokenCeiling, automaticMemoryLimit, consolidateMemoryPacket, mergeMemoryContextItems, retrieve, type RetrievalCandidateClass, type RetrievalDiagnostics, type RetrievalSelectionRole } from "./retrieval.js";
import { ServerLlmStore } from "./server-llm.js";
declare const __RCM_DISTRIBUTION__: boolean | undefined;
import { ServerExtractionWorker } from "./server-worker.js";
import { compileStorySpine, createStorySpineCompiler, completeStoryConsolidationById, expandArcForMemory, expandArcHits, invalidateStorySpine, listStorySpine, maybeEnqueueStorySpine, storyBudgetLimit, updateStorySpineGroup } from "./story-spine.js";
import { intimacyMilestonePacketType } from "./intimacy-milestones.js";
import { listEntities, mergeEntities, previewEntityMerge } from "./entities.js";
import { normalizeUnitScore } from "./scores.js";
import { listReconciliationReviews, prepareReconciliation, resolveReconciliationReview } from "./reconciliation.js";
import { applyExtractionAuditPatch } from "./extraction-audit.js";
import { changeEpisodeStart, closeEpisodeHold, episodeOverview, previewEpisodeStart, retryEpisode, releaseManualEpisode, startEpisodeHold, syncEpisodeMembership } from "./episodes.js";
import { resolveTurnPerspectives } from "./perspectives.js";
import { hasBufferedSource, ingestionSummary } from "./ingestion-state.js";
import { resolveConflict, type ConflictResolution } from "./conflicts.js";
import { acknowledgeChatLineage, applyManualLineage, applyProbedLineage, chooseChatLineage, declineChatLineage, ensureChatLineage, getChatLineage, previewManualLineage, probeChatLineage, revertChatLineage } from "./lineage.js";
import { listSocialKnowledge, retractSocialKnowledge, setManualSocialKnowledge } from "./social-knowledge.js";
import { fingerprintMatches, parseSourceFingerprintJson } from "./source-fingerprint.js";
import { completeRelationshipProjectionJob, flushRelationshipProjectionQueue, listRelationshipProjections, setRelationshipProjectionOverride } from "./relationship-projections.js";
import { intimacyMilestoneKeys } from "./intimacy-milestones.js";
import { buildRetrievalQuerySignals } from "./retrieval-planner.js";
import { cachedAuxiliaryPage, storeValidatedAuxiliaryPage } from "./auxiliary-page-cache.js";
import { beginInitialCalibration, clearInitialCalibrationDraft, completeInitialCalibrationJob, deleteInitialEntity, initialCalibrationLedger, initialCalibrationRetryInput, initialCalibrationView, resolveInitialCalibrationConfirmation, updateInitialRelationship, upsertInitialEntity } from "./initial-calibration.js";
import { previewRegeneration, applyCanonicalRegeneration, applyEpisodeRegeneration, discardRegeneration, listExtractionBatches, listRegenerations, regenerationRun, startCanonicalRegeneration, startEpisodeRegeneration } from "./regeneration.js";
import { listSourceRanges, rangeMessages } from "./source-ranges.js";
import { applyMemoryGroup, completeMemoryGroupJob, discardMemoryGroup, invalidateChangedMemoryGroups, listMemoryGroups, previewMemoryGroup, startMemoryGroup, ungroupMemories } from "./memory-grouping.js";
import { RetrievalTraceWriter, type RetrievalTraceEvent } from "./retrieval-trace.js";
import { memoryAtomKeys, memoryDetailAtomKey, memoryDialogueAtomKey, memorySummaryAtomKey, physicalOccurrenceAtomKey, relationshipLandmarkAtomKey } from "./memory-atoms.js";
import { accessibleArchiveExists, memoryToolReadiness } from "./memory-tool-readiness.js";
import { parseLandmarkKinds, refreshMemoryFts, RELATIONSHIP_LANDMARK_KINDS } from "./memory-search-document.js";
import { invalidateTranslations, lookupTranslations, translationCacheStats, upsertTranslations } from "./translation-cache.js";
import { buildLedgerConsistencyJob, completeLedgerConsistencyJob, finalizeLedgerConsistencyRun } from "./ledger-consistency.js";
import { VoyageReranker, type EvidenceReranker, RerankerUnavailableError } from "./reranker.js";
import { UpdateService } from "./update-service.js";
import { scheduleManagedRestart } from "./managed-restart.js";

interface Dependencies {
  db: RcmDatabase;
  config: ServerConfig;
  embeddings: EmbeddingService;
  vectorEnabled: boolean;
  llmStore?: ServerLlmStore;
  serverWorker?: ServerExtractionWorker;
  reranker?: EvidenceReranker;
  updateService?: UpdateService;
  restartScheduler?: (config: ServerConfig, targetVersion: string) => unknown;
}

const equalToken = (actual: string, expected: string): boolean => {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

const xmlText = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function lastMatchingIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (predicate(items[index]!)) return index;
  return -1;
}

export function mergePerspectiveFocusLeaderIds(groups: string[][], limit = 8): string[] {
  const merged: string[] = [];
  for (let rank = 0; rank < limit && merged.length < limit; rank += 1) {
    for (const leaders of groups) {
      const id = leaders[rank];
      if (id && !merged.includes(id)) merged.push(id);
      if (merged.length >= limit) break;
    }
  }
  return merged;
}

function injectionManifest(packet: string, manifest: PacketManifest, perspectives: string[], storySpineNodeIds: string[] = []) {
  return { source: packet ? "fresh" as const : "empty" as const, ...mergePacketManifests([manifest]), perspectives, storySpineNodeIds };
}

export function buildMemoryToolOpportunity(
  candidates: MemoryContextItem[],
  injected: MemoryContextItem[],
  manifest: ReturnType<typeof injectionManifest>,
  promptCoveredAtoms: number,
  candidateClasses?: ReadonlyMap<string, RetrievalCandidateClass>,
): MemoryToolOpportunity {
  const injectedKeys = new Set(manifest.atomKeys ?? []);
  const unique = new Map(candidates.map((item) => [item.id, item]));
  const allRows = [...unique.values()].slice(0, 64).map((item) => ({
    memoryId: item.id,
    all: memoryAtomKeys(item),
    unseen: memoryAtomKeys(item).filter((key) => !injectedKeys.has(key)),
  }));
  const injectedIds = new Set(injected.map((item) => item.id));
  const candidateRows = allRows.filter((row) => {
    const candidateClass = candidateClasses?.get(row.memoryId);
    return candidateClass === undefined || candidateClass === "core" || candidateClass === "continuity";
  });
  const recall = candidateRows.filter((row) => row.unseen.length > 0);
  const followCandidates = allRows.filter((row) => injectedIds.has(row.memoryId) && row.unseen.length > 0)
    .slice(0, 32).map((row) => ({ memoryId: row.memoryId, atomKeys: row.unseen.slice(0, 128) }));
  return {
    recallCandidateMemoryIds: recall.map((row) => row.memoryId),
    recallCandidateAtomKeys: [...new Set(recall.flatMap((row) => row.unseen))].slice(0, 512),
    followCandidates,
    excluded: {
      alreadyInjectedAtoms: candidateRows.reduce((sum, row) => sum + row.all.filter((key) => injectedKeys.has(key)).length, 0),
      promptCoveredAtoms,
      noUnseenAtoms: allRows.filter((row) => row.unseen.length === 0).length,
      directGrounding: allRows.length - candidateRows.length,
      perspectiveBlocked: 0,
    },
  };
}

function opportunityTurnIsCurrent(db: RcmDatabase, chatId: string, latestMessageId: string | undefined): boolean {
  if (!latestMessageId) return false;
  const row = db.prepare(`SELECT message_id FROM messages WHERE chat_id=? AND lifecycle IN ('pending','committed','client_pruned')
    AND host_visibility='active' ORDER BY ordinal DESC LIMIT 1`).get(chatId) as { message_id: string } | undefined;
  return row?.message_id === latestMessageId;
}

export function createApp(dependencies: Dependencies): Hono {
  const { db, config, embeddings, vectorEnabled } = dependencies;
  const llmStore = dependencies.llmStore ?? new ServerLlmStore(db, config.secretsPath, config.llmApiKeys ?? {}, config.llmTimeoutMs);
  embeddings.setTimeoutMs(llmStore.config.embeddingTimeoutMs);
  const serverWorker = dependencies.serverWorker ?? new ServerExtractionWorker(db, llmStore, embeddings, config.leaseSeconds);
  const reranker = dependencies.reranker ?? new VoyageReranker({ apiKey: () => config.voyageApiKey,
    endpoint: config.rerankEndpoint, model: config.rerankModel, timeoutMs: llmStore.config.rerankTimeoutMs });
  const retrievalTrace = new RetrievalTraceWriter(db, {
    mode: config.retrievalTrace,
    path: config.retrievalTracePath,
    maxEvents: config.retrievalTraceMaxEvents,
    maxAgeDays: config.retrievalTraceMaxAgeDays,
  });
  const app = new Hono();
  const updateService = dependencies.updateService ?? new UpdateService(config);
  const restartScheduler = dependencies.restartScheduler ?? scheduleManagedRestart;
  let managedRestartScheduled = false;
  const serverInstanceId = (db.prepare("SELECT value FROM server_meta WHERE key='instance_id'").get() as { value: string }).value;
  app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "Authorization", "X-RCM-Plugin-Version"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }));
  app.get("/v1/health", (context) => {
    const health = {
      ok: true, version: RCM_SERVER_VERSION, apiRevision: RCM_API_REVISION, instanceId: serverInstanceId,
      vectorEnabled, embeddingReady: embeddings.ready, embedding: embeddings.status, reranker: reranker.status, serverTranslationCache: true, completeMemoryBackup: true,
      serverLlm: llmStore.publicConfig, serverWorker: serverWorker.status, capabilities: { stateReconciliationV2: true, stateReconciliationV3: true, pipelineProgressV2: true, providerJsonMode: true, pipelineRetryStatus: true, landmarkAuditPatches: true, manualTimelineMemory: true, storyOverviewEditing: true, turnMemoryToolOpportunity: true, relationshipLandmarks: true, physicalIntimacyAutoInject: true, recallPortfolioV2: true, mcpAtomDelta: true, memoryToolReadiness: true, initialCalibration: true, initialRelationshipProjection: true, relationshipProjectionCursor: true, offscreenPromises: true, extractionAudit: true, atomAccess: true, beliefLifecycle: true, reconciliationReview: true, messageVisibility: true, sourceRangeOrganization: true, stagedMemoryGrouping: true, perspectiveResolution: true, ingestionState: true, relationshipScaleV2: true, qualitativeRelationships: true, memoryDetails: true, intimacyMilestones: true, npcProminence: true, adaptiveExtraction: true, multilingualCanonicalMemory: true, extractionGrouping: true, promptCoverageSuppression: true, durableLedger: true, chatLineage: true, manualLineageTransfer: true, sourceLedgerInspection: true, dashboardLineageProbe: true, readOnlyLineageProbe: true, recallCoverage: true, socialKnowledge: true, lineageAcknowledgement: true, packetContractV2: true, physicalIntimacy: true, typedLandmarks: true, resolvedRelationshipBaseline: true, manualLedgerEditing: true, memoryToolControl: true, shortMemoryRefs: true, multiGenerationLineage: true, quoteReviewRemoved: true, injectionManifest: true, ledgerHistory: true, typedSexMilestones: true, deepRecall: true, aspectProvenance: true, creativeUnknownStates: true, retrievalPlannerV2: true, extractionBatches: true, episodeRegeneration: true, canonicalSuffixRegeneration: true, fullColdStartSync: true, storySpine: true, storySpineV2: true, memoryBudgetPresets: true, holderMemoryTraces: true, canonicalSourceNormalization: true, editProtection: true, cognitiveActivation: true, serverServiceTier: true, ...(retrievalTrace.dashboardAvailable ? { retrievalDiagnostics: true } : {}) },
    };
    Object.assign(health.capabilities, {
      chatOperationLifecycleV2: true,
      mcpEvidenceRerank: true,
      turnLineageDiscovery: true,
      ledgerConsistencyBarrier: true,
      canonicalLedgerIdentity: true,
      repairDiagnosticsV2: true,
      operationRunAccounting: true,
      persistentBackfillResult: true,
      mcpCompactEvidence: true,
      managedServerRestart: true,
    });
    return context.json(health);
  });
  app.use("/v1/*", async (context, next) => {
    const token = context.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!equalToken(token, config.token)) return context.json({ error: "Unauthorized" }, 401);
    await next();
  });
  app.post("/v1/translations/cache/lookup", async (context) => {
    const body = await context.req.json() as { keys?: unknown };
    const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === "string" && key.length <= 512).slice(0, 500) : [];
    return context.json({ items: lookupTranslations(db, keys) });
  });
  app.post("/v1/translations/cache/upsert", async (context) => {
    const body = await context.req.json() as { items?: unknown };
    if (!Array.isArray(body.items) || body.items.length > 500) return context.json({ error: "items must be an array of up to 500 translations" }, 400);
    const items = body.items.filter((item: any) => item && ["key", "serverInstanceId", "chatId", "kind", "itemId", "sourceHash", "provider", "sourceLanguage", "targetLanguage", "translated"]
      .every((field) => typeof item[field] === "string"));
    if (items.length !== body.items.length) return context.json({ error: "Invalid translation cache item" }, 400);
    upsertTranslations(db, items);
    return context.json({ ok: true, ...translationCacheStats(db) });
  });
  app.post("/v1/translations/cache/invalidate", async (context) => {
    const body = await context.req.json() as Record<string, unknown>;
    const match = Object.fromEntries(["serverInstanceId", "chatId", "kind", "itemId", "itemIdPrefix"]
      .flatMap((key) => typeof body[key] === "string" ? [[key, body[key]]] : []));
    return context.json({ ok: true, removed: invalidateTranslations(db, match) });
  });
  app.get("/v1/translations/cache/stats", (context) => context.json(translationCacheStats(db)));
  app.delete("/v1/translations/cache", (context) => {
    const removed = db.prepare("DELETE FROM translation_cache").run().changes;
    return context.json({ ok: true, removed });
  });
  app.get("/v1/chats/:id/memory-tools/readiness", (context) => context.json(memoryToolReadiness(db, context.req.param("id"))));

  app.post("/v1/turn/prepare", async (context) => {
    const prepareStartedAt = performance.now();
    const syncTimings: Record<string, number> = {};
    let syncPhaseStartedAt = prepareStartedAt;
    const finishSyncPhase = (name: string): void => {
      const finishedAt = performance.now();
      syncTimings[name] = finishedAt - syncPhaseStartedAt;
      syncPhaseStartedAt = finishedAt;
    };
    const requestBody = await context.req.text();
    finishSyncPhase("requestBodyReadMs");
    const parsed = TurnPrepareRequestSchema.parse(JSON.parse(requestBody));
    finishSyncPhase("requestParseMs");
    const lineage = ensureChatLineage(db, parsed, true);
    finishSyncPhase("lineageMs");
    const shouldQueueInherited = parsed.tokenBudget > 0 && !parsed.deferExtraction
      && lineage.status === "inherited" && Number(lineage.inheritedCounts?.pendingReextraction ?? 0) > 0;
    const effectiveBackfillApproved = parsed.backfillApproved === true && parsed.serverInstanceId === serverInstanceId;
    const sync = syncSnapshot(db, { ...parsed, backfillApproved: effectiveBackfillApproved });
    finishSyncPhase("snapshotMs");
    const requestedExtractionReview = parsed.postExtractionReview ?? false;
    db.prepare("UPDATE chats SET post_extraction_review=?,updated_at=? WHERE id=?").run(requestedExtractionReview ? 1 : 0, Date.now(), parsed.chatId);
    const effectiveExtractionReview = parsed.extractionReviewOverride ?? requestedExtractionReview;
    const languageState = db.prepare("SELECT memory_language,pending_memory_language,ingestion_state FROM chats WHERE id=?").get(parsed.chatId) as { memory_language: "en" | "ko" | "ja" | "zh"; pending_memory_language: "en" | "ko" | "ja" | "zh" | null; ingestion_state: string };
    let initialCalibration = initialCalibrationView(db, parsed.chatId);
    const visibleOpeningMessages = parsed.messages.filter((message) => !message.disabled && message.role !== "system");
    const isTrueNewRootOpening = initialCalibration.status === "unseeded" && visibleOpeningMessages.length <= 2;
    const continuingColdStart = initialCalibration.status === "awaiting_setup" && initialCalibration.origin === "cold_start";
    const mayStartInitialCalibration = parsed.forceBackfill || continuingColdStart || isTrueNewRootOpening;
    const operationRunId = parsed.forceBackfill || continuingColdStart ? randomUUID() : undefined;
    if (lineage.status !== "inherited" && mayStartInitialCalibration && (parsed.resolvedSetup || parsed.forceBackfill) && ["unseeded", "awaiting_setup"].includes(initialCalibration.status)) {
      initialCalibration = beginInitialCalibration(db, parsed.chatId, parsed.forceBackfill || continuingColdStart ? "cold_start" : "new_root", parsed.resolvedSetup, {
        confirmationRequired: parsed.forceBackfill || continuingColdStart,
        forceBackfill: parsed.forceBackfill || continuingColdStart,
        extractionReview: continuingColdStart ? undefined : effectiveExtractionReview,
      });
      if (parsed.resolvedSetup && initialCalibration.status === "unseeded"
        && enqueueInitialCalibration(db, parsed.chatId, parsed.resolvedSetup, parsed.identityHints ?? {}, operationRunId)) {
        serverWorker.wake();
        initialCalibration = initialCalibrationView(db, parsed.chatId);
      }
    }
    finishSyncPhase("calibrationMs");
    const inheritedQueued = shouldQueueInherited
      ? enqueueExtractionJobs(db, parsed.chatId, parsed.profile, true, parsed.includeUserMessages !== false, parsed.extractionGroupTurns ?? 6, "ledger", effectiveExtractionReview, undefined, operationRunId)
      : 0;
    finishSyncPhase("inheritedEnqueueMs");
    syncEpisodeMembership(db, parsed.chatId);
    finishSyncPhase("episodeMembershipMs");
    // Keep the pre-enqueue freshness signal without computing dashboard token statistics.
    const bufferedSource = hasBufferedSource(db, parsed.chatId, languageState.ingestion_state);
    finishSyncPhase("ingestionMs");
    const deferExtraction = parsed.deferExtraction || ["ambiguous", "choice_required"].includes(lineage.status) || (!parsed.forceBackfill && languageState.ingestion_state !== "managed");
    const queued = inheritedQueued + (!deferExtraction
      ? enqueueExtractionJobs(db, parsed.chatId, parsed.profile, parsed.forceBackfill, parsed.includeUserMessages !== false, parsed.extractionGroupTurns ?? 6, "current", effectiveExtractionReview)
      : 0);
    finishSyncPhase("extractionEnqueueMs");
    const projectionQueued = flushRelationshipProjectionQueue(db, parsed.chatId);
    finishSyncPhase("projectionQueueMs");
    if (queued > 0 || projectionQueued > 0) serverWorker.wake();
    if (queued > 0) setTimeout(() => void embeddings.indexPending(parsed.chatId), 1_500);
    finishSyncPhase("workerWakeMs");
    purgeExpiredContent(db);
    finishSyncPhase("maintenanceMs");
    const traceRequestId = parsed.traceContext?.requestId ?? randomUUID();
    if (parsed.tokenBudget === 0) {
      return context.json({
        apiRevision: RCM_API_REVISION,
        serverInstanceId,
        chatRevision: sync.revision,
        profile: parsed.profile,
        memoryLanguage: languageState.memory_language,
        pendingMemoryLanguage: languageState.pending_memory_language,
        requiresLanguageReprocess: languageState.pending_memory_language !== null,
        packet: "",
        stableAnchors: "",
        estimatedTokens: 0,
        selected: [],
        injectionManifest: { source: "empty", perspectives: [], memoryIds: [], detailIds: [], atomKeys: [], storySpineNodeIds: [], relationshipPairs: [], beliefIds: [], assertionIds: [], promiseIds: [], intimacyMilestoneIds: [] },
        memoryToolsAvailable: memoryToolReadiness(db, parsed.chatId).available,
        memoryToolOpportunity: { recallCandidateMemoryIds: [], recallCandidateAtomKeys: [], followCandidates: [], excluded: { alreadyInjectedAtoms: 0, promptCoveredAtoms: 0, noUnseenAtoms: 0, directGrounding: 0, perspectiveBlocked: 0 } },
        perspectiveResolution: { perspectives: [], source: "unresolved", unresolved: false },
        omissionReason: "budget_zero",
        retrievalTrace: { enabled: retrievalTrace.isChatEnabled(parsed.chatId), requestId: traceRequestId },
        initialCalibration,
        lineage,
        sync: {
          inserted: sync.inserted,
          revised: sync.revised,
          pruned: sync.pruned,
          deleted: sync.deleted,
          truncated: sync.truncated,
        },
      });
    }
    const syncFinishedAt = performance.now();
    const querySignals = parsed.querySignals?.length
      ? parsed.querySignals
      : [{ kind: "focus" as const, text: parsed.query, weight: 1 }];
    const retrievalSignals = buildRetrievalQuerySignals(db, parsed.chatId, querySignals, languageState.memory_language);
    const semantic = await embeddings.searchManyDetailed(retrievalSignals, parsed.chatId);
    const embeddingFinishedAt = performance.now();
    const perspectiveQuery = querySignals.map((signal) => signal.text).join("\n");
    const perspectiveResolution = resolveTurnPerspectives(db, parsed, perspectiveQuery);
    const requestedPromptIds = [...new Set(parsed.promptSourceMessageIds ?? [])].slice(-512);
    const trustedPromptSourceMessageIds = requestedPromptIds.length === 0 ? [] : (db.prepare(`
      SELECT message_id FROM messages
      WHERE chat_id=? AND message_id IN (${requestedPromptIds.map(() => "?").join(",")})
        AND lifecycle='committed' AND host_visibility='active' AND content IS NOT NULL
      ORDER BY ordinal
    `).all(parsed.chatId, ...requestedPromptIds) as Array<{ message_id: string }>).map((row) => row.message_id);
    const activeMemoryCount = (db.prepare("SELECT count(*) AS count FROM memories WHERE chat_id=? AND active=1").get(parsed.chatId) as { count: number }).count;
    const retrievalPerspectives = perspectiveResolution.perspectives.length ? perspectiveResolution.perspectives : activeMemoryCount > 0 ? ["__shared__"] : [];
    // Guidance and the shared XML root are added after perspective retrieval.
    // Reserve their cost up front instead of letting N perspective-local caps
    // silently overflow the actual injection budget.
    const activeTurnPerspectives = perspectiveResolution.perspectives.filter((name) => name !== "__shared__");
    const maximumStoryBudget = storyBudgetLimit(parsed.tokenBudget);
    const storyProbe = compileStorySpine(db, parsed.chatId, activeTurnPerspectives, semantic.storyScores, maximumStoryBudget);
    const arcExpansion = expandArcHits(db, parsed.chatId, activeTurnPerspectives, semantic.storyScores);
    // Retrieval competes against the full packet budget. Story overlap is
    // known only after leaf memories are selected; reserving the unsuppressed
    // Story probe here would strand that recovered space. The final compiler
    // trims the lowest-priority memories against the actual compact Story.
    const storyBudget = storyProbe.tokens;
    const retrievalBudget = Math.max(0, parsed.tokenBudget - Math.min(320, Math.floor(parsed.tokenBudget * 0.08)));
    const hardTokenCeiling = automaticHardTokenCeiling(parsed.tokenBudget);
    // Each perspective searches against the full candidate budget. The final
    // compiler performs the one global trim, so adding a second protagonist
    // cannot halve recall depth before duplicate memories are merged.
    const perPerspective = Math.max(128, retrievalBudget);
    const perspectiveSections: Array<{ name: string; data: string }> = [];
    const anchors: string[] = [];
    const selected = new Map<string, MemoryContextItem>();
    const perspectiveSelections: MemoryContextItem[][] = [];
    const structuredManifests: PacketManifest[] = [];
    const eligibleAtoms = new Map<string, MemoryContextItem>();
    const directAtomKeys = new Set<string>();
    const automaticAtomPriorities = new Map<string, AutomaticAtomPriority>();
    const automaticAssociationSources = new Map<string, string>();
    const selectedCandidateClasses = new Map<string, RetrievalCandidateClass>();
    const selectedRoles = new Map<string, RetrievalSelectionRole>();
    const candidateClassPriority: Record<RetrievalCandidateClass, number> = { unclassified: 0, associative: 1, continuity: 2, core: 3 };
    const retrievalDiagnostics: RetrievalDiagnostics[] = [];
    const recentMemoryIds = new Set<string>();
    const perspectiveFocusLeaderIds: string[][] = [];
    const continuityBridgeIds: string[] = [];
    const activationByPerspective: Array<{ perspective: string; observations: AutomaticActivationObservation[] }> = [];
    for (const perspective of retrievalPerspectives) {
      const result = retrieve(db, {
        chatId: parsed.chatId,
        query: parsed.query,
        querySignals: retrievalSignals,
        perspective,
        tokenBudget: perPerspective,
        deferAutomaticBudget: true,
        structuredBudgetScale: 1 / Math.max(1, retrievalPerspectives.length),
        hardTokenCeiling: automaticHardTokenCeiling(perPerspective),
        semanticScores: semantic.scores,
        semanticHits: semantic.hits,
        semanticAtomHits: semantic.atomHits,
        semanticViewScores: semantic.viewScores,
        arcMemoryScores: arcExpansion.memoryScores,
        arcDetailScores: arcExpansion.detailScores,
        arcDialogueIds: arcExpansion.dialogueIds,
        arcExpansionDiagnostics: arcExpansion.diagnostics,
        promptSourceMessageIds: trustedPromptSourceMessageIds,
        activePerspectives: retrievalPerspectives.filter((name) => name !== "__shared__"),
        collectDiagnostics: retrievalTrace.enabled,
      });
      if (result.perspectiveData) {
        const name = perspective === "__shared__" ? "shared" : perspective;
        perspectiveSections.push({ name, data: result.perspectiveData });
        structuredManifests.push(result.structuredManifest);
      }
      if (result.stableAnchors) anchors.push(result.stableAnchors);
      perspectiveSelections.push(result.selected);
      for (const item of result.eligibleCandidates) {
        const existing = eligibleAtoms.get(item.id);
        eligibleAtoms.set(item.id, existing ? mergeMemoryContextItems(existing, item) : item);
      }
      result.directAtomKeys.forEach((key) => directAtomKeys.add(key));
      for (const [id, via] of Object.entries(result.automaticAssociationSources ?? {})) automaticAssociationSources.set(id, via);
      for (const [key, priority] of Object.entries(result.automaticAtomPriorities ?? {})) {
        const old = automaticAtomPriorities.get(key);
        automaticAtomPriorities.set(key, old ? { focus: Math.max(old.focus, priority.focus), cue: Math.max(old.cue, priority.cue),
          scene: Math.max(old.scene, priority.scene), semantic: Math.max(old.semantic, priority.semantic),
          cueViews: Object.fromEntries([...new Set([...Object.keys(old.cueViews ?? {}), ...Object.keys(priority.cueViews ?? {})])]
            .map((view) => [view, Math.max(old.cueViews?.[view] ?? 0, priority.cueViews?.[view] ?? 0)])),
          connection: Math.max(old.connection ?? 0, priority.connection ?? 0),
          connectionViaMemoryId: (old.connection ?? 0) >= (priority.connection ?? 0) ? old.connectionViaMemoryId : priority.connectionViaMemoryId,
          connectionEvidence: (old.connection ?? 0) >= (priority.connection ?? 0) ? old.connectionEvidence : priority.connectionEvidence,
          sourceMessageIds: [...new Set([...old.sourceMessageIds, ...priority.sourceMessageIds])] } : priority);
      }
      for (const item of result.selected) {
        const existing = selected.get(item.id);
        selected.set(item.id, existing ? mergeMemoryContextItems(existing, item) : item);
        const candidateClass = result.selectedCandidateClasses[item.id] ?? "unclassified";
        const currentClass = selectedCandidateClasses.get(item.id);
        if (!currentClass || candidateClassPriority[candidateClass] > candidateClassPriority[currentClass]) selectedCandidateClasses.set(item.id, candidateClass);
        const role = result.selectedRoles[item.id];
        if (role === "serendipity" || !selectedRoles.has(item.id)) selectedRoles.set(item.id, role ?? "filler");
      }
      result.recentMemoryIds.forEach((id) => recentMemoryIds.add(id));
      perspectiveFocusLeaderIds.push(result.focusLeaderIds);
      activationByPerspective.push({ perspective, observations: result.activationObservations });
      for (const id of result.continuityBridgeIds) if (!continuityBridgeIds.includes(id)) continuityBridgeIds.push(id);
      if (result.diagnostics) retrievalDiagnostics.push(result.diagnostics);
    }
    const retrievalFinishedAt = performance.now();
    const focusLeaderIds = mergePerspectiveFocusLeaderIds(perspectiveFocusLeaderIds);
    // A shared focus scene does not consume the unexpected-memory slot merely
    // because another perspective reached it by association.
    for (const id of focusLeaderIds) selectedRoles.set(id, "focus");
    for (const [id, candidateClass] of selectedCandidateClasses) if (candidateClass === "core"
      && ["association", "serendipity"].includes(selectedRoles.get(id) ?? "")) selectedRoles.set(id, "core");
    const selectedItems = focusLeaderIds.flatMap((id) => selected.has(id) ? [selected.get(id)!] : []);
    const selectedIds = new Set(selectedItems.map((item) => item.id));
    const offsets = perspectiveSelections.map(() => 0);
    const finalMemoryLimit = 64;
    const finalHardMemoryLimit = finalMemoryLimit;
    const associativeCap = automaticAssociativeCap(parsed.tokenBudget);
    let selectedAssociative = selectedItems.filter((item) => selectedCandidateClasses.get(item.id) === "associative").length;
    let selectedSerendipity = selectedItems.filter((item) => selectedRoles.get(item.id) === "serendipity").length;
    while (selectedItems.length < finalMemoryLimit) {
      let advanced = false;
      for (let index = 0; index < perspectiveSelections.length && selectedItems.length < finalMemoryLimit; index += 1) {
        const items = perspectiveSelections[index]!;
        while (offsets[index]! < items.length) {
          const local = items[offsets[index]!]!;
          offsets[index] = offsets[index]! + 1;
          advanced = true;
          if (selectedIds.has(local.id)) continue;
          const merged = selected.get(local.id);
          if (!merged) continue;
          const candidateClass = selectedCandidateClasses.get(local.id) ?? "unclassified";
          if (candidateClass === "associative" && selectedAssociative >= associativeCap) continue;
          if (selectedRoles.get(local.id) === "serendipity" && selectedSerendipity >= 1) continue;
          selectedIds.add(local.id);
          selectedItems.push(merged);
          if (candidateClass === "associative") selectedAssociative += 1;
          if (selectedRoles.get(local.id) === "serendipity") selectedSerendipity += 1;
          break;
        }
      }
      if (!advanced) break;
    }
    for (const id of continuityBridgeIds) {
      if (selectedItems.length >= finalHardMemoryLimit || selectedIds.has(id)) continue;
      const item = selected.get(id);
      if (!item) continue;
      selectedIds.add(id);
      selectedItems.push(item);
    }
    const renderStory = createStorySpineCompiler(db, parsed.chatId, activeTurnPerspectives, semantic.storyScores, storyBudget, retrievalTrace.enabled);
    // Trim only removes atoms. Resolve their original support IDs once, then
    // recompute exclusions from the atoms still present on every render.
    const dialogueSupportIds = new Map<MemoryContextItem["keyDialogues"][number], string>();
    const dialogueSupportQuery = db.prepare("SELECT id FROM memory_dialogues WHERE chat_id=? AND memory_id=? AND message_id=? AND text=? LIMIT 1");
    for (const item of selectedItems) for (const dialogue of item.keyDialogues) {
      const row = dialogueSupportQuery.get(parsed.chatId, item.id, dialogue.messageId, dialogue.text) as { id: string } | undefined;
      if (row) dialogueSupportIds.set(dialogue, `dialogue:${row.id}`);
    }
    const compileStoryForSelection = () => {
      const excluded = new Set(selectedItems.flatMap((item) => [`memory:${item.id}`, ...item.details.map((detail) => `detail:${detail.id}`)]));
      for (const item of selectedItems) for (const dialogue of item.keyDialogues) {
        const supportId = dialogueSupportIds.get(dialogue);
        if (supportId) excluded.add(supportId);
      }
      return renderStory(excluded);
    };
    let finalStory = compileStoryForSelection();
    const sourceEvidence = retrieveSourceEvidence(db, parsed.chatId, retrievalSignals.filter((signal) => signal.kind !== "scene").map((signal) => signal.text).join("\n"),
      activeTurnPerspectives, parsed.tokenBudget, trustedPromptSourceMessageIds, semantic.sourceHits?.filter((hit) => hit.score >= 0.72 && (hit.viewIndex === undefined || retrievalSignals[hit.viewIndex]?.kind !== "scene")));
    let deliveredSources = sourceEvidence.items;
    let emittedManifest = emptyPacketManifest();
    const rebuildPacket = () => {
      emittedManifest = mergePacketManifests(structuredManifests);
      const body = consolidateMemoryPacket(db, parsed.chatId, bufferedSource, perspectiveSections, selectedItems, "recall", "context", [...recentMemoryIds].filter((id) => selectedItems.some((item) => item.id === id)), activeTurnPerspectives, finalStory.xml, emittedManifest);
      const deliveredText = selectedItems.flatMap((item) => [
        ...item.details.filter((detail) => emittedManifest.atomKeys.includes(memoryDetailAtomKey(detail))).map((detail) => detail.text),
        ...item.keyDialogues.filter((dialogue) => emittedManifest.atomKeys.includes(memoryDialogueAtomKey(item.id, dialogue))).map((dialogue) => dialogue.text),
      ]);
      deliveredSources = sourceEvidence.items.filter((source) => !deliveredText.some((text) => text.includes(source.quote)));
      const sourceXml = renderSourceEvidence(deliveredSources);
      if (!sourceXml) return body;
      return (body || "<rp_memory_context></rp_memory_context>").replace("</rp_memory_context>", `${sourceXml}</rp_memory_context>`);
    };
    let packet = rebuildPacket();
    const focusLeaderIdSet = new Set(focusLeaderIds);
    const continuityBridgeIdSet = new Set(continuityBridgeIds);
    const cueAnchorKeys = new Set<string>();
    const atomPolicy = { priorities: automaticAtomPriorities, focusIds: focusLeaderIdSet, continuityIds: continuityBridgeIdSet,
      roles: selectedRoles, associationSources: automaticAssociationSources, cueAnchorKeys };
    const atomDecisions = planAutomaticAtoms(selectedItems, directAtomKeys, atomPolicy);
    const cueAnchor = selectCueAnchor(atomDecisions, automaticAtomPriorities,
      new Map(retrievalSignals.flatMap((signal, index) => signal.kind === "cue" ? [[index, signal.weight]] : [])));
    if (cueAnchor) {
      cueAnchorKeys.add(cueAnchor.decision.atomKey);
      cueAnchor.decision.cueAnchor = true;
      cueAnchor.decision.cueViewIndex = cueAnchor.cueViewIndex;
    }
    const removeAt = (index: number): void => {
      const removed = selectedItems.splice(index, 1)[0];
      for (const decision of atomDecisions) if (decision.memoryId === removed?.id && decision.outcome === "retained") decision.outcome = "memory_removed";
      finalStory = compileStoryForSelection();
      packet = rebuildPacket();
    };
    while (selectedItems.length > 0 && estimateTokens(packet) > hardTokenCeiling) {
      if (trimAutomaticAtom(selectedItems, directAtomKeys, false, atomPolicy, atomDecisions, "hard_ceiling")) {
        finalStory = compileStoryForSelection(); packet = rebuildPacket(); continue;
      }
      if (trimAutomaticAtom(selectedItems, directAtomKeys, true, atomPolicy, atomDecisions)) {
        finalStory = compileStoryForSelection(); packet = rebuildPacket(); continue;
      }
      const continuityIndex = lastMatchingIndex(selectedItems, (item) => continuityBridgeIdSet.has(item.id));
      const nonFocusIndex = lastMatchingIndex(selectedItems, (item) => !focusLeaderIdSet.has(item.id));
      const index = continuityIndex >= 0 ? continuityIndex : nonFocusIndex >= 0 ? nonFocusIndex : selectedItems.length - 1;
      removeAt(index);
    }
    // Enforce the same ceiling even if a pathological metadata-only packet remains.
    while (estimateTokens(packet) > hardTokenCeiling && perspectiveSections.length) {
      perspectiveSections.pop(); structuredManifests.pop(); packet = rebuildPacket();
    }
    if (estimateTokens(packet) > hardTokenCeiling && finalStory.xml) {
      finalStory = { ...finalStory, xml: "", nodeIds: [], tokens: 0 }; packet = rebuildPacket();
    }
    if (parsed.memoryReferenceMode === "none") packet = packet.replace(/\s+id="[^"]+"/g, "");
    const assemblyFinishedAt = performance.now();
    const finalSelectedIds = new Set(selectedItems.map((item) => item.id));
    const finalManifest = { ...injectionManifest(packet, emittedManifest, perspectiveSections.map((item) => item.name), finalStory.nodeIds), sourceEvidenceIds: deliveredSources.map((item) => item.id) };
    finalManifest.atomKeys.push(...deliveredSources.map(sourceEvidenceAtomKey));
    const deliveredActivationAtoms = new Set(finalManifest.atomKeys);
    const completedTurn = Number((db.prepare("SELECT completed_turn_count FROM chats WHERE id=?").get(parsed.chatId) as { completed_turn_count?: number } | undefined)?.completed_turn_count ?? 0);
    for (const entry of activationByPerspective) persistAutomaticActivationObservations(
      db,
      parsed.chatId,
      entry.perspective,
      completedTurn,
      entry.observations.flatMap((observation) => {
        if (!finalSelectedIds.has(observation.memoryId)) return [];
        const delivered = deliveredActivationObservation(observation, deliveredActivationAtoms);
        return delivered ? [delivered] : [];
      }),
    );
    const stableAnchors = [...new Set(anchors)].join("\n");
    const finalCandidateClassCounts = { core: 0, associative: 0, continuity: 0, unclassified: 0 };
    for (const item of selectedItems) finalCandidateClassCounts[selectedCandidateClasses.get(item.id) ?? "unclassified"] += 1;
    const finalRoleCounts: Record<RetrievalSelectionRole, number> = { focus: 0, core: 0, continuity: 0, association: 0, serendipity: 0, filler: 0 };
    for (const item of selectedItems) finalRoleCounts[selectedRoles.get(item.id) ?? "filler"] += 1;
    const promptCoveredAtoms = new Set([
      ...retrievalDiagnostics.flatMap((item) => item.promptCoveredMemoryIds),
      ...retrievalDiagnostics.flatMap((item) => item.promptCoveredDetailIds),
      ...retrievalDiagnostics.flatMap((item) => item.promptCoveredDialogueIds),
    ]).size;
    const toolOpportunity = buildMemoryToolOpportunity([...eligibleAtoms.values()], selectedItems, finalManifest, promptCoveredAtoms, selectedCandidateClasses);
    toolOpportunity.archiveSearchAvailable = accessibleArchiveExists(db, parsed.chatId, activeTurnPerspectives);
    const response = context.json({
      apiRevision: RCM_API_REVISION,
      serverInstanceId,
      chatRevision: sync.revision,
      profile: parsed.profile,
      memoryLanguage: languageState.memory_language,
      pendingMemoryLanguage: languageState.pending_memory_language,
      requiresLanguageReprocess: languageState.pending_memory_language !== null,
      packet,
      stableAnchors,
      estimatedTokens: estimateTokens(packet),
      selected: selectedItems,
      injectionManifest: finalManifest,
      memoryToolsAvailable: memoryToolReadiness(db, parsed.chatId).available,
      memoryToolOpportunity: toolOpportunity,
      perspectiveResolution,
      initialCalibration: initialCalibrationView(db, parsed.chatId),
      lineage,
      omissionReason: packet ? undefined : activeMemoryCount === 0 ? "no_memories" : perspectiveResolution.unresolved ? "unresolved_perspective" : "no_relevance",
      sync: {
        inserted: sync.inserted,
        revised: sync.revised,
        pruned: sync.pruned,
        deleted: sync.deleted,
        truncated: sync.truncated,
      },
      retrievalTrace: { enabled: retrievalTrace.isChatEnabled(parsed.chatId), requestId: traceRequestId },
    });
    const deliveredAtomSet = new Set(finalManifest.atomKeys);
    const atomPreservation = atomDecisions.map((decision) => ({ ...decision,
      delivered: deliveredAtomSet.has(decision.atomKey),
      priority: automaticAtomPriorities.get(decision.atomKey),
    }));
    const normalizedPacket = packet.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ");
    const recoveryCandidates = sourceEvidence.recoveryCandidates.flatMap((candidate) => {
      const missingPhrases = candidate.matchedPhrases.filter((phrase) => !normalizedPacket.includes(phrase));
      if (candidate.matchedPhrases.length && !missingPhrases.length) return [];
      return [{ ...candidate, matchedPhrases: missingPhrases }];
    });
    if (queueSourceRecovery(db, parsed.chatId, recoveryCandidates, retrievalSignals.filter((signal) => signal.kind !== "scene").map((signal) => signal.text).join("\n"))) serverWorker.wake();
    const roleTokens: Record<string, number> = {};
    for (const atom of atomPreservation) if (atom.delivered) roleTokens[atom.role] = (roleTokens[atom.role] ?? 0) + atom.tokens;
    // Recovery enqueue/worker startup is still synchronous response work.
    // Include it in finalization rather than stopping the clock at serialization.
    const finalizedAt = performance.now();
    const timings = {
      syncMs: syncFinishedAt - prepareStartedAt,
      embeddingMs: embeddingFinishedAt - syncFinishedAt,
      retrievalMs: retrievalFinishedAt - embeddingFinishedAt,
      assemblyMs: assemblyFinishedAt - retrievalFinishedAt,
      finalizeMs: finalizedAt - assemblyFinishedAt,
      totalMs: finalizedAt - prepareStartedAt,
    };
    if (typeof __RCM_DISTRIBUTION__ === "undefined" || !__RCM_DISTRIBUTION__) void retrievalTrace.record({
      atomPreservation, roleTokens,
      timings,
      syncTimings,
      requestBytes: Buffer.byteLength(requestBody, "utf8"),
      id: traceRequestId,
      kind: "automatic_search",
      semanticAtomHits: [...(semantic.atomHits ?? new Map())],
      semanticSourceHits: semantic.sourceHits ?? [],
      sourceEvidenceIds: deliveredSources.map((item) => item.id),
      chatId: parsed.chatId,
      traceContext: parsed.traceContext,
      query: parsed.query,
      querySignals: retrievalSignals,
      tokenBudget: parsed.tokenBudget,
      chatRevision: sync.revision,
      perspectives: retrievalPerspectives,
      promptSourceMessageIds: trustedPromptSourceMessageIds,
      selectedIds: selectedItems.map((item) => item.id),
      selection: {
        classCounts: finalCandidateClassCounts,
        roleCounts: finalRoleCounts,
        associativeCap,
        focusLeaderIds: focusLeaderIds.filter((id) => selectedItems.some((item) => item.id === id)),
        continuityBridgeIds: continuityBridgeIds.filter((id) => selectedItems.some((item) => item.id === id)),
        overflowSlotUsed: selectedItems.length > finalMemoryLimit,
      },
      budget: {
        requestedPreset: parsed.memoryBudgetPreset,
        actualTokenBudget: parsed.tokenBudget,
        targetBudget: parsed.tokenBudget,
        hardTokenCeiling,
        storyMaximum: maximumStoryBudget,
        storyReserved: storyBudget,
        storyUsed: finalStory.tokens,
        retrievalBudget,
        finalMemoryLimit,
        finalHardMemoryLimit,
        finalPacketTokens: estimateTokens(packet),
        fillRatio: Number((estimateTokens(packet) / Math.max(1, parsed.tokenBudget)).toFixed(4)),
        overflowTokens: Math.max(0, estimateTokens(packet) - parsed.tokenBudget),
        estimatorHeadroomTokens: Math.max(0, estimateTokens(packet) - parsed.tokenBudget),
      },
      story: {
        ...finalStory.diagnostics,
        semanticCandidateCount: semantic.storyScores?.size ?? 0,
        nodes: finalStory.diagnostics.nodes.map((node) => ({
          ...node,
          semanticHitKind: semantic.storyHits?.get(node.id)?.kind,
          semanticHitScore: semantic.storyHits?.get(node.id)?.score,
        })),
      },
      overlap: {
        promptSourceMessageCount: trustedPromptSourceMessageIds.length,
        promptCoveredMemoryIds: [...new Set(retrievalDiagnostics.flatMap((item) => item.promptCoveredMemoryIds))],
        promptCoveredDetailIds: [...new Set(retrievalDiagnostics.flatMap((item) => item.promptCoveredDetailIds))],
        promptCoveredDialogueIds: [...new Set(retrievalDiagnostics.flatMap((item) => item.promptCoveredDialogueIds))],
        storySuppressedBeatCount: finalStory.diagnostics.suppressedBeatCount,
      },
      continuity: {
        bridgeMemoryIds: [...new Set(retrievalDiagnostics.flatMap((item) => item.bridgeMemoryIds))],
        supplementMemoryIds: [...new Set(retrievalDiagnostics.flatMap((item) => item.continuitySupplementIds))],
        recentMemoryIds: [...recentMemoryIds].filter((id) => selectedItems.some((item) => item.id === id)),
      },
      manifest: finalManifest,
      toolOpportunity,
      packet,
      retrievals: retrievalDiagnostics,
    });
    return response;
  });

  app.get("/v1/chats/:id/lineage", (context) => context.json(getChatLineage(db, context.req.param("id"))));
  app.get("/v1/chats/:id/story-spine", (context) => context.json(listStorySpine(db, context.req.param("id"))));
  app.patch("/v1/chats/:id/story-spine/:groupId", async (context) => {
    const body = await context.req.json() as { pinned?: boolean; hidden?: boolean; summary?: string };
    if (!updateStorySpineGroup(db, context.req.param("id"), context.req.param("groupId"), body)) {
      return context.json({ error: "Story spine group not found or read-only" }, 404);
    }
    void embeddings.indexPending(context.req.param("id"));
    return context.json({ ok: true, ...listStorySpine(db, context.req.param("id")) });
  });
  app.post("/v1/chats/:id/story-spine/rebuild", (context) => {
    const chatId = context.req.param("id");
    invalidateStorySpine(db, chatId);
    const queued = maybeEnqueueStorySpine(db, chatId);
    if (queued) serverWorker.wake();
    void embeddings.indexPending(chatId);
    return context.json({ ok: true, queued, ...listStorySpine(db, chatId) });
  });
  app.get("/v1/chats/:id/initial-calibration", (context) => context.json(initialCalibrationLedger(db, context.req.param("id"))));
  app.post("/v1/chats/:id/initial-calibration/confirm", (context) => {
    try {
      const chatId = context.req.param("id");
      const pending = resolveInitialCalibrationConfirmation(db, chatId, "confirm");
      const chat = db.prepare("SELECT profile,include_user_messages,extraction_group_turns FROM chats WHERE id=?").get(chatId) as { profile: "companion" | "simulation"; include_user_messages: number; extraction_group_turns: number };
      const queuedJobs = enqueueExtractionJobs(db, chatId, chat.profile, pending.forceBackfill, chat.include_user_messages === 1, chat.extraction_group_turns, pending.forceBackfill ? "ledger" : "current", pending.extractionReview, undefined, pending.backfillRunId);
      if (queuedJobs) serverWorker.wake();
      return context.json({ ok: true, queuedJobs, calibration: initialCalibrationLedger(db, chatId) });
    } catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
  app.post("/v1/chats/:id/initial-calibration/skip", (context) => {
    try {
      const chatId = context.req.param("id");
      const pending = resolveInitialCalibrationConfirmation(db, chatId, "skip");
      const chat = db.prepare("SELECT profile,include_user_messages,extraction_group_turns FROM chats WHERE id=?").get(chatId) as { profile: "companion" | "simulation"; include_user_messages: number; extraction_group_turns: number };
      const queuedJobs = enqueueExtractionJobs(db, chatId, chat.profile, pending.forceBackfill, chat.include_user_messages === 1, chat.extraction_group_turns, pending.forceBackfill ? "ledger" : "current", pending.extractionReview, undefined, pending.backfillRunId);
      if (queuedJobs) serverWorker.wake();
      return context.json({ ok: true, queuedJobs, calibration: initialCalibrationLedger(db, chatId) });
    } catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
  app.post("/v1/chats/:id/initial-calibration/retry", async (context) => {
    try {
      const chatId = context.req.param("id");
      const body = await context.req.json().catch(() => ({})) as { resolvedSetup?: unknown; identityHints?: unknown };
      const setupResult = body.resolvedSetup === undefined ? undefined : ResolvedSetupProjectionSchema.safeParse(body.resolvedSetup);
      if (setupResult && !setupResult.success) return context.json({ error: "resolvedSetup is invalid", issues: setupResult.error.issues }, 400);
      if (body.identityHints !== undefined && (typeof body.identityHints !== "object" || body.identityHints === null || Array.isArray(body.identityHints))) {
        return context.json({ error: "identityHints must be an object" }, 400);
      }
      const retry = setupResult?.success
        ? { projection: setupResult.data, identityHints: (body.identityHints ?? {}) as Record<string, unknown> }
        : initialCalibrationRetryInput(db, chatId);
      const queued = db.transaction(() => {
        clearInitialCalibrationDraft(db, chatId);
        if (setupResult?.success) db.prepare(`UPDATE initial_calibrations SET setup_json=?,setup_fingerprint=?,updated_at=? WHERE chat_id=?`)
          .run(JSON.stringify(retry.projection), retry.projection.fingerprint, Date.now(), chatId);
        if (!enqueueInitialCalibration(db, chatId, retry.projection, retry.identityHints, retry.backfillRunId)) throw new Error("Initial calibration is already queued");
        return true;
      })();
      if (queued) serverWorker.wake();
      return context.json({ ok: true, queued, calibration: initialCalibrationLedger(db, chatId) });
    } catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
  app.post("/v1/chats/:id/initial-calibration/entities", async (context) => {
    try {
      const body = await context.req.json() as { displayName?: string; aliases?: string[]; prominence?: "primary" | "supporting" | "reference" };
      const id = upsertInitialEntity(db, context.req.param("id"), { displayName: body.displayName ?? "", aliases: body.aliases, prominence: body.prominence });
      return context.json({ ok: true, id, calibration: initialCalibrationLedger(db, context.req.param("id")) });
    } catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.patch("/v1/chats/:id/initial-calibration/entities/:entityId", async (context) => {
    try {
      const body = await context.req.json() as { displayName?: string; aliases?: string[]; prominence?: "primary" | "supporting" | "reference" };
      upsertInitialEntity(db, context.req.param("id"), { id: context.req.param("entityId"), displayName: body.displayName ?? "", aliases: body.aliases, prominence: body.prominence });
      return context.json({ ok: true, calibration: initialCalibrationLedger(db, context.req.param("id")) });
    } catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.delete("/v1/chats/:id/initial-calibration/entities/:entityId", (context) => {
    try {
      const chatId = context.req.param("id");
      const deleted = deleteInitialEntity(db, chatId, context.req.param("entityId"));
      return deleted
        ? context.json({ ok: true, calibration: initialCalibrationLedger(db, chatId) })
        : context.json({ error: "Initial setup entity not found" }, 404);
    } catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
  app.patch("/v1/chats/:id/initial-calibration/relationships/:baselineId", async (context) => {
    try {
      const body = await context.req.json() as { axes?: Record<string, string>; summary?: string };
      updateInitialRelationship(db, context.req.param("id"), context.req.param("baselineId"), { axes: body.axes ?? {}, summary: body.summary ?? "" });
      return context.json({ ok: true, calibration: initialCalibrationLedger(db, context.req.param("id")) });
    } catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
  app.post("/v1/chats/:id/lineage/probe", async (context) => {
    try {
      const body = LineageProbeRequestSchema.parse(await context.req.json());
      const request = {
        ...body,
        chatId: context.req.param("id"),
        messages: [],
        query: "",
        perspectives: [],
        tokenBudget: 0,
        forceBackfill: false,
        deferExtraction: true,
      };
      return context.json(probeChatLineage(db, request));
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post("/v1/chats/:id/lineage/apply", async (context) => {
    try {
      const body = LineageProbeApplyRequestSchema.parse(await context.req.json());
      const request = {
        chatTitle: body.chatTitle,
        characterId: body.characterId,
        profile: body.profile,
        messageVisibility: body.messageVisibility,
        lineageHint: body.lineageHint,
        includeUserMessages: body.includeUserMessages,
        extractionGroupTurns: body.extractionGroupTurns,
        memoryLanguage: body.memoryLanguage,
        canonicalizationPolicy: body.canonicalizationPolicy,
        chatId: context.req.param("id"),
        messages: [],
        query: "",
        perspectives: [],
        tokenBudget: 0,
        forceBackfill: false,
        deferExtraction: true,
      };
      const lineage = applyProbedLineage(db, request, body.parentChatId, body.fingerprint);
      return context.json({ ok: true, lineage, queuedJobs: 0 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return context.json({ error: message }, ["LINEAGE_PROBE_STALE", "LINEAGE_ALREADY_APPLIED", "TARGET_HAS_DERIVED_DATA"].includes(message) ? 409 : 400);
    }
  });
  app.post("/v1/chats/:id/lineage/acknowledge", (context) => context.json({ ok: true, lineage: acknowledgeChatLineage(db, context.req.param("id")) }));
  app.post("/v1/chats/:id/lineage/select", async (context) => {
    try {
      const body = LineageProbeApplyRequestSchema.parse(await context.req.json());
      const chatId = context.req.param("id");
      const lineage = chooseChatLineage(db, chatId, body.parentChatId, { ...body, chatId, messages: [], query: '', perspectives: [],
        tokenBudget: 0, forceBackfill: false, deferExtraction: true }, body.fingerprint);
      const chat = db.prepare("SELECT profile,include_user_messages,extraction_group_turns FROM chats WHERE id=?").get(chatId) as { profile: "companion" | "simulation"; include_user_messages: number; extraction_group_turns: number };
      const queuedJobs = enqueueExtractionJobs(db, chatId, chat.profile, true, Boolean(chat.include_user_messages), chat.extraction_group_turns, "ledger");
      if (queuedJobs) serverWorker.wake();
      return context.json({ ...lineage, queuedJobs });
    }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.post("/v1/chats/:id/lineage/decline", async (context) => {
    try {
      const body = await context.req.json() as { fingerprint?: string };
      if (!body.fingerprint) return context.json({ error: "fingerprint is required" }, 400);
      return context.json({ ok: true, lineage: declineChatLineage(db, context.req.param("id"), body.fingerprint) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return context.json({ error: message }, message === "LINEAGE_PROBE_STALE" ? 409 : 400);
    }
  });
  app.post("/v1/chats/:id/lineage/revert", (context) => {
    const chatId = context.req.param("id");
    revertChatLineage(db, chatId);
    const chat = db.prepare("SELECT profile,include_user_messages,extraction_group_turns FROM chats WHERE id=?").get(chatId) as { profile: "companion" | "simulation"; include_user_messages: number; extraction_group_turns: number };
    const queued = enqueueExtractionJobs(db, chatId, chat.profile, true, Boolean(chat.include_user_messages), chat.extraction_group_turns);
    if (queued) serverWorker.wake();
    return context.json({ ok: true, lineage: getChatLineage(db, context.req.param("id")) });
  });
  app.post("/v1/chats/:id/lineage/preview", async (context) => {
    try {
      const body = ManualLineagePreviewRequestSchema.parse(await context.req.json());
      return context.json(previewManualLineage(db, context.req.param("id"), body.parentChatId, body.targetMessageInventory, body.target));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return context.json({ error: message }, 400);
    }
  });
  app.post("/v1/chats/:id/lineage/inherit", async (context) => {
    try {
      const body = ManualLineageApplyRequestSchema.parse(await context.req.json());
      const chatId = context.req.param("id");
      const lineage = applyManualLineage(db, chatId, body.parentChatId, body.fingerprint, body.targetMessageInventory, body.replaceDerived, body.target);
      return context.json({ ok: true, lineage, queuedJobs: 0 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return context.json({ error: message }, ["TARGET_HAS_DERIVED_DATA", "TARGET_INVENTORY_REQUIRED", "LINEAGE_PREVIEW_STALE"].includes(message) ? 409 : 400);
    }
  });
  app.post("/v1/chats/:id/memory-transplant/preview", async (context) => {
    const body = await context.req.json() as { sourceChatId?: string };
    if (!body.sourceChatId) return context.json({ error: "sourceChatId is required" }, 400);
    try { return context.json(previewMemoryTransplant(db, body.sourceChatId, context.req.param("id"))); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.post("/v1/chats/:id/memory-transplant", async (context) => {
    const body = await context.req.json() as { sourceChatId?: string; fingerprint?: string; replaceDerived?: boolean };
    if (!body.sourceChatId || !body.fingerprint) return context.json({ error: "sourceChatId and fingerprint are required" }, 400);
    const targetChatId = context.req.param("id");
    const preview = previewMemoryTransplant(db, body.sourceChatId, targetChatId);
    if (preview.fingerprint !== body.fingerprint) return context.json({ error: "TRANSPLANT_PREVIEW_STALE" }, 409);
    if (preview.requiresReplacement && !body.replaceDerived) return context.json({ error: "TARGET_HAS_DERIVED_DATA" }, 409);
    const wasPaused = serverWorker.status.state === "paused";
    serverWorker.pause("Transplanting memory from a server chat");
    try {
      const result = transplantCompleteArchive(db, exportCompleteArchive(db), body.sourceChatId, targetChatId);
      void embeddings.indexPending(targetChatId);
      return context.json({ ok: true, ...result });
    } finally { if (!wasPaused) serverWorker.resume("server-chat-transplant"); }
  });

  app.post("/v1/jobs/lease", async (context) => {
    const body = LeaseJobRequestSchema.parse(await context.req.json());
    if (llmStore.config.engine === "server") return context.json({ job: null });
    return context.json({ job: attachAuxiliaryPlan(db, leaseJob(db, body.workerId, config.leaseSeconds), {
      maxInputTokens: llmStore.config.maxInputTokens, maxOutputTokens: llmStore.config.maxOutputTokens, llmTimeoutMs: llmStore.config.llmTimeoutMs,
    }) });
  });
  app.post("/v1/jobs/:id/draft", async (context) => {
    const body = await context.req.json() as { workerId?: string; output?: string; storyValidationReason?: string };
    if (typeof body.workerId !== "string" || typeof body.output !== "string") return context.json({ error: "Invalid draft" }, 400);
    const ok = stageJobModelOutput(db, context.req.param("id"), body.output, body.workerId,
      typeof body.storyValidationReason === "string" ? body.storyValidationReason : undefined);
    return ok ? context.json({ ok: true }) : context.json({ error: "Lease not found" }, 409);
  });
  app.post("/v1/jobs/:id/renew", async (context) => {
    const body = await context.req.json() as { workerId?: string };
    if (typeof body.workerId !== "string" || !body.workerId) return context.json({ error: "Invalid lease renewal" }, 400);
    return renewJobLease(db, context.req.param("id"), body.workerId, config.leaseSeconds)
      ? context.json({ ok: true })
      : context.json({ error: "Lease not found" }, 409);
  });
  app.post("/v1/jobs/:id/progress", async (context) => {
    const body = await context.req.json() as { workerId?: string; stage?: string; repairDelta?: number; llmCallStats?: { total?: unknown; repairs?: unknown; byPurpose?: unknown }; llmCallDiagnostic?: { purpose?: unknown; attempt?: unknown; outcome?: unknown; at?: unknown; error?: unknown } };
    const allowed = new Set<JobPipelineStage>(["queued", "first_extraction", "post_extraction_audit", "state_reconciliation", "ledger_consistency", "relationship_projection", "story_consolidation", "storing", "complete", "failed"]);
    if (!body.workerId || !allowed.has(body.stage as JobPipelineStage)) return context.json({ error: "Invalid pipeline progress" }, 400);
    const repairDelta = Math.min(1, Math.max(0, Math.trunc(Number(body.repairDelta ?? 0))));
    const llmCallStats = body.llmCallStats && Number.isInteger(Number(body.llmCallStats.total)) && Number(body.llmCallStats.total) >= 0
      ? { total: Number(body.llmCallStats.total), repairs: Math.max(0, Number(body.llmCallStats.repairs) || 0), byPurpose: (body.llmCallStats.byPurpose as Record<string, number> | undefined) ?? {} }
      : undefined;
    const rawDiagnostic = body.llmCallDiagnostic;
    const llmCallDiagnostic = rawDiagnostic && typeof rawDiagnostic.purpose === "string" && /^[a-z_]{1,80}$/.test(rawDiagnostic.purpose)
      && Number.isInteger(Number(rawDiagnostic.attempt)) && ["started", "succeeded", "failed"].includes(String(rawDiagnostic.outcome))
      ? { purpose: rawDiagnostic.purpose, attempt: Number(rawDiagnostic.attempt), outcome: String(rawDiagnostic.outcome) as "started" | "succeeded" | "failed", at: Math.max(0, Number(rawDiagnostic.at) || Date.now()),
        ...(typeof rawDiagnostic.error === "string" ? { error: rawDiagnostic.error.slice(0, 300) } : {}) } : undefined;
    const ok = setJobPipelineStage(db, context.req.param("id"), body.stage as JobPipelineStage, body.workerId, repairDelta, llmCallStats, llmCallDiagnostic);
    return ok ? context.json({ ok: true }) : context.json({ error: "Lease not found" }, 409);
  });
  app.post("/v1/jobs/:id/complete", async (context) => {
    const body = CompleteJobRequestSchema.parse(await context.req.json());
    const job = db.prepare(`SELECT j.type,j.chat_id,j.payload_json,j.attempts,c.profile,c.memory_language FROM jobs j JOIN chats c ON c.id=j.chat_id
      WHERE j.id=? AND j.lease_owner=? AND j.status='leased'`).get(context.req.param("id"), body.workerId) as { type: string; chat_id: string; payload_json: string; attempts: number; profile: any; memory_language: any } | undefined;
    if (!job) return context.json({ error: "Lease not found" }, 409);
    const expectedLanguage = (JSON.parse(job.payload_json || "{}") as { memoryLanguage?: string }).memoryLanguage ?? job.memory_language;
    if (job.type !== 'memory_group' && job.type !== "relationship_projection" && job.type !== "initial_calibration" && job.type !== "story_consolidation" && job.type !== "ledger_consistency" && (body.result as { language?: unknown } | null)?.language !== expectedLanguage) {
      return context.json({ error: `Canonical language must be ${expectedLanguage}` }, 400);
    }
    const completed = job.type === 'memory_group' ? completeMemoryGroupJob(db, context.req.param('id'), body.workerId, body.result) : job.type === "episode"
      ? completeEpisodeJob(db, context.req.param("id"), body.workerId, EpisodeCapsuleResultSchema.parse(body.result), body.reconciliation, body.audit)
      : job.type === "initial_calibration"
        ? completeInitialCalibrationJob(db, context.req.param("id"), body.workerId, InitialCalibrationResultSchema.parse(body.result))
      : job.type === "relationship_projection"
        ? completeRelationshipProjectionJob(db, context.req.param("id"), body.workerId, RelationshipProjectionResultSchema.parse(body.result))
      : job.type === "story_consolidation"
        ? completeStoryConsolidationById(db, context.req.param("id"), body.workerId, StorySpineConsolidationResultSchema.parse(body.result))
      : job.type === "ledger_consistency"
        ? completeLedgerConsistencyJob(db, buildLedgerConsistencyJob({ id: context.req.param("id"), chatId: job.chat_id, profile: job.profile, memoryLanguage: job.memory_language,
          attempt: job.attempts, payload: JSON.parse(job.payload_json) }), body.workerId, LedgerConsistencyResultSchema.parse(body.result))
        : completeExtractionJob(db, context.req.param("id"), body.workerId, body.result as any, body.reconciliation, body.audit);
    if (job.type === "ledger_consistency") {
      finalizeLedgerConsistencyRun(db, completed.chatId, String((JSON.parse(job.payload_json) as { backfillRunId?: string }).backfillRunId ?? ""));
    }
    void embeddings.indexPending(completed.chatId);
    return context.json({ ok: true, warnings: completed.warnings, pendingReconciliations: completed.pendingReconciliations });
  });
  app.post("/v1/jobs/:id/reconciliation/prepare", async (context) => {
    const body = PrepareReconciliationRequestSchema.parse(await context.req.json());
    const job = db.prepare("SELECT chat_id,payload_json FROM jobs WHERE id=? AND lease_owner=? AND status='leased'").get(context.req.param("id"), body.workerId) as { chat_id: string; payload_json: string } | undefined;
    if (!job) return context.json({ error: "Lease not found" }, 409);
    const jobPayload = JSON.parse(job.payload_json) as { sourceMessageIds?: string[]; auxiliaryBudget?: { maxInputTokens?: number }; serverLlmSnapshot?: { maxInputTokens?: number } };
    const sourceMessageIds = jobPayload.sourceMessageIds ?? [];
    const preparedResult = body.audit?.patch ? applyExtractionAuditPatch(db, job.chat_id, sourceMessageIds, body.result, body.audit.patch).result : body.result;
    if (body.audit?.patch?.keepPendingItemRefs.some((ref) => !ref.startsWith("dialogue:"))) return context.json({ required: false, blocked: true });
    const evidenceIssues = inspectDraftEvidence(db, job.chat_id, sourceMessageIds, preparedResult);
    if (evidenceIssues.some((issue) => issue.blocking)) return context.json({ required: false, candidateSetHash: "", blocked: true, groundingDraft: preparedResult, evidenceIssues });
    if ((jobPayload as any).regenerationRunId) return context.json({ required: false, groundingDraft: preparedResult, evidenceIssues });
    const maxInputTokens = jobPayload.auxiliaryBudget?.maxInputTokens ?? jobPayload.serverLlmSnapshot?.maxInputTokens ?? 80_000;
    const prepared = prepareReconciliation(db, job.chat_id, preparedResult, maxInputTokens);
    (jobPayload as any).auxiliaryPromptParts = prepared.parts?.map((part) => ({ purpose: "reconciliation", systemPrompt: part.systemPrompt, userPrompt: part.userPrompt })) ?? [];
    db.prepare("UPDATE jobs SET payload_json=?,updated_at=? WHERE id=? AND lease_owner=? AND status='leased'").run(JSON.stringify(jobPayload), Date.now(), context.req.param("id"), body.workerId);
    const parts = prepared.parts?.map((part) => ({ ...part, cachedResult: cachedAuxiliaryPage(jobPayload as any, "reconciliation", part.systemPrompt, part.userPrompt) }));
    return context.json({ required: prepared.required, candidateSetHash: prepared.candidateSetHash, systemPrompt: prepared.systemPrompt,
      userPrompt: prepared.userPrompt, parts, ...(evidenceIssues.length ? { groundingDraft: preparedResult, evidenceIssues } : {}) });
  });
  app.get("/v1/update/status", async (context) => {
    const refresh = context.req.query("refresh") === "1";
    return context.json(refresh ? await updateService.check() : updateService.status());
  });
  app.post("/v1/update/stage", async (context) => {
    try { return context.json(await updateService.stageServer()); }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
  app.post("/v1/update/apply", (context) => {
    if (managedRestartScheduled) return context.json({ error: "A server restart is already scheduled" }, 409);
    if (serverWorker.status.activeCalls > 0) return context.json({ error: "보조 모델 처리가 끝난 뒤 업데이트해 주세요." }, 409);
    const status = updateService.status();
    const targetVersion = updateService.restartTargetVersion();
    if (!status.restartRequired || !targetVersion) return context.json({ error: "No staged server update is ready" }, 409);
    if (!status.canApplyAutomatically) return context.json({ error: "Automatic restart is unavailable for this installation" }, 409);
    try {
      restartScheduler(config, targetVersion);
      managedRestartScheduled = true;
      return context.json({ accepted: true, targetVersion });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });
  app.post("/v1/jobs/:id/validated-auxiliary-part", async (context) => {
    const body = await context.req.json() as Record<string, unknown>;
    if (typeof body.workerId !== "string" || typeof body.systemPrompt !== "string" || typeof body.userPrompt !== "string" ||
      !["initial_calibration", "ledger_consistency", "reconciliation"].includes(String(body.purpose))) return context.json({ error: "Invalid validated auxiliary page" }, 400);
    try {
      const key = storeValidatedAuxiliaryPage(db, context.req.param("id"), body.workerId, { purpose: body.purpose as any,
        systemPrompt: body.systemPrompt, userPrompt: body.userPrompt, result: body.result });
      return context.json({ ok: true, key });
    } catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
  app.post("/v1/jobs/:id/fail", async (context) => {
    const body = FailJobRequestSchema.parse(await context.req.json());
    const failedJob = db.prepare("SELECT chat_id,type,payload_json FROM jobs WHERE id=? AND lease_owner=? AND status='leased'").get(context.req.param("id"), body.workerId) as { chat_id: string; type: string; payload_json: string } | undefined;
    const result = failJob(db, context.req.param("id"), body.workerId, body.error);
    if (result?.status === "failed" && failedJob?.type === "ledger_consistency") {
      finalizeLedgerConsistencyRun(db, failedJob.chat_id, String((JSON.parse(failedJob.payload_json) as { backfillRunId?: string }).backfillRunId ?? ""));
    }
    return result ? context.json({ ok: true, ...result }) : context.json({ error: "Lease not found" }, 409);
  });

  app.post("/v1/chats/:id/recall", async (context) => {
    const handlerStarted = performance.now();
    const body = RecallRequestSchema.parse(await context.req.json());
    const aspectQueries = body.aspects ?? [];
    // A short event scope keeps dependent facets such as "the reply" anchored
    // without copying every requested detail into every embedding query.
    const anchoredAspectQueries = aspectQueries.map(aspect=>mcpFacetSearchQuery(body.query,aspect));
    const embeddingStarted = performance.now();
    const semanticResults = await embeddings.searchBatchDetailed([body.query, ...anchoredAspectQueries], context.req.param("id"));
    const embeddingMs = performance.now() - embeddingStarted;
    const retrievalStarted = performance.now();
    const semantic = semanticResults[0]!;
    const aspectSemantic = semanticResults.slice(1);
    const aspectSemanticHits = new Map(aspectQueries.map((aspect, index) => [aspect, aspectSemantic[index]?.hits ?? new Map()]));
    const aspectSemanticAtomHits = new Map(aspectQueries.map((aspect, index) => [aspect, aspectSemantic[index]?.atomHits ?? new Map([...(aspectSemantic[index]?.hits ?? [])].map(([id, hit]) => [id, [hit]]))]));
    const aspectSemanticScores = new Map(aspectQueries.map((aspect, index) => [aspect, aspectSemantic[index]?.scores ?? new Map()]));
    const storyScores = new Map(semantic.storyScores ?? []);
    for (const result of aspectSemantic) for (const [id, score] of result.storyScores ?? []) {
      storyScores.set(id, Math.max(storyScores.get(id) ?? 0, score));
    }
    const arcExpansion = expandArcHits(db, context.req.param("id"), body.activePerspectives?.length ? body.activePerspectives : [body.perspective], storyScores);
    let result = retrieve(db, {
      chatId: context.req.param("id"), query: body.query, perspective: body.perspective,
      intent: body.intent, tokenBudget: body.tokenBudget, semanticScores: semantic.scores, semanticHits: semantic.hits,
        semanticAtomHits: semantic.atomHits,
      aspectSemanticScores, aspectSemanticHits, aspectSemanticAtomHits,
      arcMemoryScores: arcExpansion.memoryScores,
      arcDetailScores: arcExpansion.detailScores,
      arcDialogueIds: arcExpansion.dialogueIds,
      arcExpansionDiagnostics: arcExpansion.diagnostics,
      reinforce: true, deferReinforcement: true, mcpCandidatesOnly: true, aspects: undefined, excludeMemoryIds: [],
      excludeMemorySignatures: [],
      alreadyPresentMemoryIds: body.alreadyPresentMemoryIds,
      alreadyPresentAtomKeys: [],
      excludeAtomKeys: [],
      promptSourceMessageIds: body.promptSourceMessageIds,
      activePerspectives: body.activePerspectives,
      collectDiagnostics: retrievalTrace.enabled,
    });
    const deliverySource = "search" as const;
    const opportunityCurrent = opportunityTurnIsCurrent(db, context.req.param("id"), body.traceContext?.latestMessageId);
    const retrievalMs = performance.now() - retrievalStarted;
    const finalizationStarted = performance.now();
    let finalized: Awaited<ReturnType<typeof finalizeMcpAnswer>>;
    try {
      finalized = await finalizeMcpAnswer(db, context.req.param("id"), result, {
        archiveView: ["narrator", "omniscient", "omniscient narrator"].includes(body.perspective.trim().toLowerCase()),
        query: body.query, aspects: body.aspects,
        tokenBudget: body.tokenBudget, perspectives: body.activePerspectives?.length ? body.activePerspectives : [body.perspective],
        promptIds: body.promptSourceMessageIds, excludedAtoms: [...(body.alreadyPresentAtomKeys ?? []), ...(body.excludeAtomKeys ?? [])],
        excludedSourceRanges: body.excludeSourceRanges,
        semantic: semanticResults, referenceMemoryId: body.referenceMemoryId, reranker,
      });
    } catch (error) {
      const rerankMs = performance.now() - finalizationStarted;
      const timings = { embeddingMs, retrievalMs, rerankMs, finalizationMs: rerankMs, serverMs: performance.now() - handlerStarted };
      const kind = error instanceof RerankerUnavailableError ? error.kind : "unexpected";
      if (typeof __RCM_DISTRIBUTION__ === "undefined" || !__RCM_DISTRIBUTION__) await retrievalTrace.record({ id: body.traceContext?.requestId ?? randomUUID(), kind:"mcp_search", chatId:context.req.param("id"),
        traceContext:body.traceContext, query:body.query, aspects:body.aspects, intent:body.intent, outcome:"communication_failure",
        failureStage:"rerank", failureKind:kind, timings, elapsedMs:timings.serverMs });
      return context.json({ error:"MCP evidence verification service unavailable", code:"MCP_RERANK_UNAVAILABLE", failureKind:kind, timings }, 503);
    }
    const timings = { embeddingMs, retrievalMs, rerankMs: finalized.rerank.elapsedMs,
      rerankCalls: finalized.rerank.calls, spanRerankMs: finalized.sourceSpans.elapsedMs,
      spanRerankCalls: finalized.sourceSpans.calls, finalizationMs: performance.now() - finalizationStarted,
      serverMs: performance.now() - handlerStarted };
    const traceRequestId = body.traceContext?.requestId ?? randomUUID();
    if (typeof __RCM_DISTRIBUTION__ === "undefined" || !__RCM_DISTRIBUTION__) await retrievalTrace.record({
      id: traceRequestId,
      kind: "mcp_search",
      timings, elapsedMs: timings.serverMs,
      answers: result.answers,
      chatId: context.req.param("id"),
      traceContext: body.traceContext,
      query: body.query,
      aspects: body.aspects,
      intent: body.intent,
      promptSourceMessageIds: body.promptSourceMessageIds,
      excludedMemoryIds: body.excludeMemoryIds,
      alreadyPresentMemoryIds: body.alreadyPresentMemoryIds,
      alreadyPresentAtomKeys: body.alreadyPresentAtomKeys,
      excludedAtomKeys: body.excludeAtomKeys,
      excludedSourceRanges: body.excludeSourceRanges,
      deliveredAtomKeys: result.deliveredAtomKeys,
      deliveredSourceRanges: result.deliveredSourceRanges,
      deliverySource,
      newAtomCount: result.deliveredAtomKeys.filter(key => ![...(body.alreadyPresentAtomKeys ?? []), ...(body.excludeAtomKeys ?? [])].includes(key)).length,
      opportunityCurrent,
      opportunityCandidateIds: body.opportunityMemoryIds,
      selectedIds: result.selected.map((item) => item.id),
      coverage: result.coverage,
      packet: result.packet,
      retrieval: result.diagnostics,
    });
    const followableMemoryIds = result.mcpFollowableMemoryIds ?? [];
    const { diagnostics: _diagnostics, eligibleCandidates: _eligible, mcpSearchEnvelopes: _envelopes,
      mcpFollowableMemoryIds: _followable, directAtomKeys: _direct, structuredManifest: _structured, ...publicResult } = result;
    const opportunityError = !opportunityCurrent && (result.deliveredAtomKeys?.length ?? 0) === 0 ? "stale_turn" : undefined;
    return context.json({ ...publicResult, timings, followableMemoryIds, deliverySource, newAtomCount: result.deliveredAtomKeys.filter(key => ![...(body.alreadyPresentAtomKeys ?? []), ...(body.excludeAtomKeys ?? [])].includes(key)).length, ...(opportunityError ? { opportunityError } : {}) });
  });
  app.post("/v1/chats/:id/follow", async (context) => {
    const handlerStarted = performance.now();
    const body = FollowRequestSchema.parse(await context.req.json());
    const seed = db.prepare("SELECT title,content FROM memories WHERE id=? AND chat_id=? AND active=1").get(body.memoryId, context.req.param("id")) as
      | { title: string; content: string }
      | undefined;
    if (!seed) return context.json({ error: "Memory not found" }, 404);
    const arcExpansion = expandArcForMemory(db, context.req.param("id"), body.memoryId, [body.perspective]);
    const query = body.focus || seed.title;
    const aspectQueries = body.aspects ?? [];
    const embeddingStarted = performance.now();
    const semanticResults = await embeddings.searchBatchDetailed([query, ...aspectQueries.map(aspect=>mcpFacetSearchQuery(query,aspect))], context.req.param("id"));
    const embeddingMs = performance.now() - embeddingStarted;
    const retrievalStarted = performance.now();
    const semantic = semanticResults[0]!;
    const aspectSemantic = semanticResults.slice(1);
    const aspectSemanticHits = new Map(aspectQueries.map((aspect, index) => [aspect, aspectSemantic[index]?.hits ?? new Map()]));
    const aspectSemanticAtomHits = new Map(aspectQueries.map((aspect, index) => [aspect, aspectSemantic[index]?.atomHits ?? new Map([...(aspectSemantic[index]?.hits ?? [])].map(([id, hit]) => [id, [hit]]))]));
    const aspectSemanticScores = new Map(aspectQueries.map((aspect, index) => [aspect, aspectSemantic[index]?.scores ?? new Map()]));
    let result = retrieve(db, {
      chatId: context.req.param("id"), query, perspective: body.perspective,
      intent: body.intent, tokenBudget: body.tokenBudget, seedMemoryId: body.memoryId, followAllDetails: !body.focus?.trim() && !body.aspects?.length,
      semanticScores: semantic.scores, semanticHits: semantic.hits, semanticAtomHits: semantic.atomHits,
      aspectSemanticScores, aspectSemanticHits, aspectSemanticAtomHits, aspects: undefined,
      reinforce: true, deferReinforcement: true, mcpCandidatesOnly: true, excludeMemoryIds: [],
      arcMemoryScores: arcExpansion.memoryScores,
      arcDetailScores: arcExpansion.detailScores,
      arcDialogueIds: arcExpansion.dialogueIds,
      arcExpansionDiagnostics: arcExpansion.diagnostics,
      excludeMemorySignatures: [],
      alreadyPresentAtomKeys: [],
      excludeAtomKeys: [],
      promptSourceMessageIds: body.promptSourceMessageIds,
      activePerspectives: body.activePerspectives,
      collectDiagnostics: retrievalTrace.enabled,
    });
    let deliverySource: "search" | "opportunity_fallback" = "search";
    const opportunityCurrent = opportunityTurnIsCurrent(db, context.req.param("id"), body.traceContext?.latestMessageId);
    const retrievalMs = performance.now() - retrievalStarted;
    const finalizationStarted = performance.now();
    let finalized: Awaited<ReturnType<typeof finalizeMcpAnswer>>;
    try {
      finalized = await finalizeMcpAnswer(db, context.req.param("id"), result, {
        archiveView: ["narrator", "omniscient", "omniscient narrator"].includes(body.perspective.trim().toLowerCase()),
        query: body.focus ?? "", aspects: body.aspects,
        tokenBudget: body.tokenBudget, perspectives: body.activePerspectives?.length ? body.activePerspectives : [body.perspective],
        promptIds: body.promptSourceMessageIds, excludedAtoms: [...(body.alreadyPresentAtomKeys ?? []), ...(body.excludeAtomKeys ?? [])],
        excludedSourceRanges: body.excludeSourceRanges,
        semantic: semanticResults, seedMemoryId: body.memoryId, reranker,
      });
    } catch (error) {
      const rerankMs = performance.now() - finalizationStarted;
      const timings = { embeddingMs, retrievalMs, rerankMs, finalizationMs: rerankMs, serverMs: performance.now() - handlerStarted };
      const kind = error instanceof RerankerUnavailableError ? error.kind : "unexpected";
      if (typeof __RCM_DISTRIBUTION__ === "undefined" || !__RCM_DISTRIBUTION__) await retrievalTrace.record({ id: body.traceContext?.requestId ?? randomUUID(), kind:"mcp_search", chatId:context.req.param("id"),
        traceContext:body.traceContext, query, aspects:body.aspects, intent:body.intent, memoryId:body.memoryId,
        outcome:"communication_failure", failureStage:"rerank", failureKind:kind, timings, elapsedMs:timings.serverMs });
      return context.json({ error:"MCP evidence verification service unavailable", code:"MCP_RERANK_UNAVAILABLE", failureKind:kind, timings }, 503);
    }
    const timings = { embeddingMs, retrievalMs, rerankMs: finalized.rerank.elapsedMs,
      rerankCalls: finalized.rerank.calls, spanRerankMs: finalized.sourceSpans.elapsedMs,
      spanRerankCalls: finalized.sourceSpans.calls, finalizationMs: performance.now() - finalizationStarted,
      serverMs: performance.now() - handlerStarted };
    const traceRequestId = body.traceContext?.requestId ?? randomUUID();
    if (typeof __RCM_DISTRIBUTION__ === "undefined" || !__RCM_DISTRIBUTION__) await retrievalTrace.record({
      id: traceRequestId,
      kind: "mcp_search",
      timings, elapsedMs: timings.serverMs,
      answers: result.answers,
      chatId: context.req.param("id"),
      traceContext: body.traceContext,
      query,
      aspects: body.aspects,
      intent: body.intent,
      memoryId: body.memoryId,
      focus: body.focus,
      alreadyPresentAtomKeys: body.alreadyPresentAtomKeys,
      excludedAtomKeys: body.excludeAtomKeys,
      excludedSourceRanges: body.excludeSourceRanges,
      deliveredAtomKeys: result.deliveredAtomKeys,
      deliveredSourceRanges: result.deliveredSourceRanges,
      deliverySource,
      newAtomCount: result.deliveredAtomKeys.filter(key => ![...(body.alreadyPresentAtomKeys ?? []), ...(body.excludeAtomKeys ?? [])].includes(key)).length,
      opportunityCurrent,
      opportunityCandidateIds: body.opportunityMemoryIds,
      selectedIds: result.selected.map((item) => item.id),
      packet: result.packet,
      retrieval: result.diagnostics,
    });
    const followableMemoryIds = result.mcpFollowableMemoryIds ?? [];
    const { diagnostics: _diagnostics, eligibleCandidates: _eligible, mcpSearchEnvelopes: _envelopes,
      mcpFollowableMemoryIds: _followable, directAtomKeys: _direct, structuredManifest: _structured, ...publicResult } = result;
    const opportunityError = !opportunityCurrent && (result.deliveredAtomKeys?.length ?? 0) === 0 ? "stale_turn" : undefined;
    return context.json({ ...publicResult, timings, followableMemoryIds, deliverySource, newAtomCount: result.deliveredAtomKeys.filter(key => ![...(body.alreadyPresentAtomKeys ?? []), ...(body.excludeAtomKeys ?? [])].includes(key)).length, ...(opportunityError ? { opportunityError } : {}) });
  });

  if (typeof __RCM_DISTRIBUTION__ === "undefined" || !__RCM_DISTRIBUTION__) app.post("/v1/diagnostics/retrieval-events", async (context) => {
    if (!retrievalTrace.enabled) return context.body(null, 204);
    const body = await context.req.json().catch(() => undefined) as RetrievalTraceEvent | undefined;
    if (!body || typeof body.id !== "string" || typeof body.chatId !== "string"
      || !["automatic_injection", "mcp_delivery", "tool_exposure"].includes(body.kind)) {
      return context.json({ error: "Invalid retrieval trace event" }, 400);
    }
    await retrievalTrace.record(body);
    return context.body(null, 204);
  });

  app.get("/v1/admin/chats", (context) => context.json({ items: listAdminChats(db, retrievalTrace.dashboardAvailable) }));
  if (typeof __RCM_DISTRIBUTION__ === "undefined" || !__RCM_DISTRIBUTION__) app.put("/v1/admin/chats/:id/retrieval-diagnostics", async (context) => {
    if (!retrievalTrace.dashboardAvailable) return context.json({ error: "Not found" }, 404);
    const body = await context.req.json().catch(() => undefined) as { enabled?: unknown } | undefined;
    if (typeof body?.enabled !== "boolean") return context.json({ error: "enabled must be boolean" }, 400);
    try {
      retrievalTrace.setChatEnabled(context.req.param("id"), body.enabled);
      return context.json({ ok: true, enabled: retrievalTrace.isChatEnabled(context.req.param("id")) });
    } catch {
      return context.json({ error: "Chat not found" }, 404);
    }
  });
  app.get("/v1/admin/chats/:id/source-ledger", (context) => {
    try {
      return context.json(listSourceLedger(
        db,
        context.req.param("id"),
        Number(context.req.query("offset") ?? 0),
        Number(context.req.query("limit") ?? 50),
        context.req.query("includeContent") === "true",
      ));
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.get("/v1/admin/server-llm", (context) => context.json({ config: llmStore.publicConfig, worker: serverWorker.status }));
  app.post("/v1/admin/auxiliary/translation-plan", async (context) => {
    const body = await context.req.json().catch(() => undefined) as { systemPrompt?: unknown; items?: unknown } | undefined;
    if (typeof body?.systemPrompt !== "string" || !Array.isArray(body.items)) return context.json({ error: "systemPrompt and items are required" }, 400);
    const systemPrompt = body.systemPrompt;
    const items = body.items.flatMap((item) => item && typeof item === "object" && typeof (item as any).id === "string" && typeof (item as any).text === "string"
      ? [{ id: String((item as any).id), text: String((item as any).text) }] : []);
    if (items.length !== body.items.length || items.length > 10_000) return context.json({ error: "Invalid translation items" }, 400);
    const budget = { maxInputTokens: llmStore.config.maxInputTokens, maxOutputTokens: llmStore.config.maxOutputTokens };
    const render = (batch: Array<{ id: string; partIndex: number; partCount: number; text: string }>) => JSON.stringify({ items: batch });
    const available = budget.maxInputTokens - estimateTokens(JSON.stringify([{ role: "system", content: systemPrompt }, { role: "user", content: JSON.stringify({ items: [] }) }]));
    if (available < 1) return context.json({ error: "Translation instruction exceeds the configured input budget", budget }, 422);
    const expanded = items.flatMap((item) => {
      let tokenTarget = Math.max(1, available - estimateTokens(JSON.stringify({ id: item.id, partIndex: 0, partCount: 1, text: "" })));
      let pieces = splitAuxiliarySource(item.text, estimateTokens, tokenTarget);
      while (pieces.some((part) => !measureAuxiliaryPrompt([{ role: "system", content: systemPrompt },
        { role: "user", content: render([{ id: item.id, partIndex: 0, partCount: pieces.length, text: part.text }]) }], estimateTokens, budget).fits)) {
        if (tokenTarget === 1) throw new Error(`Translation item ${item.id} cannot fit the configured input budget`);
        tokenTarget = Math.max(1, Math.floor(tokenTarget * .75));
        pieces = splitAuxiliarySource(item.text, estimateTokens, tokenTarget);
      }
      return pieces.map((part, partIndex) => ({ id: item.id, partIndex, partCount: pieces.length, text: part.text }));
    });
    const batches: typeof expanded[] = [];
    let current: typeof expanded = [];
    for (const item of expanded) {
      const trial = [...current, item];
      const measured = measureAuxiliaryPrompt([{ role: "system", content: systemPrompt }, { role: "user", content: render(trial) }], estimateTokens, budget);
      if (!measured.fits && current.length) {
        batches.push(current);
        const solo = measureAuxiliaryPrompt([{ role: "system", content: systemPrompt }, { role: "user", content: render([item]) }], estimateTokens, budget);
        if (!solo.fits) return context.json({ error: `Translation item ${item.id} cannot fit the configured input budget`, budget }, 422);
        current = [item];
      }
      else if (!measured.fits) return context.json({ error: `Translation item ${item.id} cannot fit the configured input budget`, budget }, 422);
      else current = trial;
    }
    if (current.length) batches.push(current);
    return context.json({ budget, estimatedItems: items.length, plannedParts: batches.length, parts: batches.map((batch, index) => {
      const userPrompt = render(batch);
      const measurement = measureAuxiliaryPrompt([{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], estimateTokens, budget);
      return { index, systemPrompt, userPrompt, items: batch.map(({ id, partIndex, partCount }) => ({ id, partIndex, partCount })), estimatedInputTokens: measurement.estimatedInputTokens };
    }) });
  });
  app.put("/v1/admin/server-llm", async (context) => {
    const input = ServerLlmConfigSchema.parse(await context.req.json());
    const publicConfig = llmStore.update(input);
    embeddings.setTimeoutMs(publicConfig.embeddingTimeoutMs);
    if (reranker instanceof VoyageReranker) reranker.setTimeoutMs(publicConfig.rerankTimeoutMs);
    config.embeddingTimeoutMs = publicConfig.embeddingTimeoutMs;
    config.rerankTimeoutMs = publicConfig.rerankTimeoutMs;
    config.llmTimeoutMs = publicConfig.llmTimeoutMs;
    serverWorker.configChanged();
    return context.json({ ok: true, config: publicConfig, worker: serverWorker.status });
  });
  app.delete("/v1/admin/server-llm-key", (context) => {
    llmStore.clearKey();
    if (config.llmApiKeys) delete config.llmApiKeys[llmStore.config.provider];
    serverWorker.pause("Server LLM API key removed");
    return context.json({ ok: true, config: llmStore.publicConfig, worker: serverWorker.status });
  });
  app.post("/v1/worker/heartbeat", async (context) => {
    const body = WorkerControlSchema.parse(await context.req.json());
    serverWorker.heartbeat(body.workerId);
    return context.json({ ok: true, worker: body.chatId ? serverWorker.statusForChat(body.chatId) : serverWorker.status });
  });
  app.post("/v1/worker/resume", async (context) => {
    const body = WorkerControlSchema.parse(await context.req.json());
    return context.json({ ok: true, worker: serverWorker.resume(body.workerId) });
  });
  app.post("/v1/worker/pause", (context) => context.json({ ok: true, worker: serverWorker.pause() }));
  app.put("/v1/admin/voyage-key", async (context) => {
    const body = await context.req.json() as { apiKey?: unknown };
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) return context.json({ error: "apiKey is required" }, 400);
    await embeddings.validateAndSetApiKey(apiKey);
    saveVoyageKey(config.secretsPath, apiKey);
    config.voyageApiKey = apiKey;
    embeddings.warm();
    return context.json({ ok: true, embedding: embeddings.status });
  });
  app.delete("/v1/admin/voyage-key", (context) => {
    saveVoyageKey(config.secretsPath, null);
    config.voyageApiKey = "";
    embeddings.clearApiKey();
    return context.json({ ok: true, embedding: embeddings.status });
  });

  app.delete("/v1/chats/:id/derived", (context) => {
    try {
      const ok = resetDerivedChat(db, embeddings, context.req.param("id"));
      return ok ? context.json({ ok }) : context.json({ error: "Chat not found" }, 404);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });
  app.post("/v1/chats/:id/reprocess", async (context) => {
    try {
      const chatId = context.req.param("id");
      const body = await context.req.json().catch(() => ({})) as {
        activatePendingMemoryLanguage?: unknown;
        extractionReviewOverride?: unknown;
        resolvedSetup?: unknown;
        identityHints?: unknown;
        expectedSourceMessages?: unknown;
      };
      if (body.activatePendingMemoryLanguage !== undefined && typeof body.activatePendingMemoryLanguage !== "boolean") return context.json({ error: "activatePendingMemoryLanguage must be boolean" }, 400);
      if (body.extractionReviewOverride !== undefined && typeof body.extractionReviewOverride !== "boolean") return context.json({ error: "extractionReviewOverride must be boolean" }, 400);
      if (body.expectedSourceMessages !== undefined && (!Number.isInteger(body.expectedSourceMessages) || Number(body.expectedSourceMessages) < 0)) return context.json({ error: "expectedSourceMessages must be a non-negative integer" }, 400);
      const setupResult = body.resolvedSetup === undefined ? undefined : ResolvedSetupProjectionSchema.safeParse(body.resolvedSetup);
      if (setupResult && !setupResult.success) return context.json({ error: "resolvedSetup is invalid", issues: setupResult.error.issues }, 400);
      if (body.identityHints !== undefined && (typeof body.identityHints !== "object" || body.identityHints === null || Array.isArray(body.identityHints))) {
        return context.json({ error: "identityHints must be an object" }, 400);
      }
      const chat = db.prepare("SELECT profile,include_user_messages,extraction_group_turns FROM chats WHERE id=?").get(chatId) as
        | { profile: "companion" | "simulation"; include_user_messages: number; extraction_group_turns: number }
        | undefined;
      if (!chat) return context.json({ error: "Chat not found" }, 404);
      if (body.expectedSourceMessages !== undefined) {
        const stored = db.prepare(`SELECT COUNT(*) count FROM messages WHERE chat_id=? AND content IS NOT NULL AND lifecycle IN ('committed','pending')`).get(chatId) as { count: number };
        if (stored.count !== body.expectedSourceMessages) {
          return context.json({
            error: `Full source synchronization is incomplete: expected ${body.expectedSourceMessages}, stored ${stored.count}.`,
            code: "SOURCE_LEDGER_INCOMPLETE",
            expectedSourceMessages: body.expectedSourceMessages,
            storedSourceMessages: stored.count,
          }, 409);
        }
      }
      const calibrationBefore = initialCalibrationView(db, chatId);
      const needsCalibration = ["unseeded", "awaiting_setup", "failed"].includes(calibrationBefore.status);
      if (["queued", "awaiting_confirmation"].includes(calibrationBefore.status)) {
        return context.json({ error: "Initial calibration is already in progress", code: "INITIAL_CALIBRATION_IN_PROGRESS", calibration: calibrationBefore }, 409);
      }
      if (needsCalibration && !setupResult?.success) {
        return context.json({
          error: "Rendered setup is required before the first cold start. Run one normal chat request, then try rebuilding again.",
          code: "INITIAL_SETUP_REQUIRED",
          calibration: calibrationBefore,
        }, 409);
      }
      recanonicalizeSourceLedger(db, chatId);
      const pendingMessages = reprocessChat(db, embeddings, chatId, body.activatePendingMemoryLanguage === true);
      if (needsCalibration && setupResult?.success) {
        const operationRunId = randomUUID();
        beginInitialCalibration(db, chatId, "cold_start", setupResult.data, {
          confirmationRequired: true,
          forceBackfill: true,
          extractionReview: body.extractionReviewOverride as boolean | undefined,
        });
        const queued = enqueueInitialCalibration(
          db,
          chatId,
          setupResult.data,
          (body.identityHints ?? {}) as Record<string, unknown>,
          operationRunId,
        );
        if (queued) serverWorker.wake();
        const language = db.prepare("SELECT memory_language,pending_memory_language FROM chats WHERE id=?").get(chatId) as { memory_language: string; pending_memory_language: string | null };
        return context.json({
          ok: true,
          pendingMessages,
          queuedJobs: queued ? 1 : 0,
          awaitingCalibration: true,
          calibration: initialCalibrationView(db, chatId),
          memoryLanguage: language.memory_language,
          pendingMemoryLanguage: language.pending_memory_language,
        });
      }
      const queuedJobs = enqueueExtractionJobs(db, chatId, chat.profile, true, chat.include_user_messages !== 0, chat.extraction_group_turns, "ledger", body.extractionReviewOverride as boolean | undefined, undefined, randomUUID());
      if (queuedJobs > 0) serverWorker.wake();
      const language = db.prepare("SELECT memory_language,pending_memory_language FROM chats WHERE id=?").get(chatId) as { memory_language: string; pending_memory_language: string | null };
      return context.json({ ok: true, pendingMessages, queuedJobs, memoryLanguage: language.memory_language, pendingMemoryLanguage: language.pending_memory_language });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });
  app.delete("/v1/chats/:id", (context) => {
    try {
      const deletedChats = deleteChats(db, embeddings, [context.req.param("id")]);
      return deletedChats ? context.json({ ok: true, deletedChats }) : context.json({ error: "Chat not found" }, 404);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });
  app.delete("/v1/characters/:id", (context) => {
    const chatIds = (db.prepare("SELECT id FROM chats WHERE character_id=?").all(context.req.param("id")) as Array<{ id: string }>).map((row) => row.id);
    try {
      const deletedChats = deleteChats(db, embeddings, chatIds);
      return deletedChats ? context.json({ ok: true, deletedChats }) : context.json({ error: "Character not found" }, 404);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.get("/v1/chats/:id/social-knowledge", (context) => {
    const chatId = context.req.param("id");
    const jobs = db.prepare(`SELECT status,COUNT(*) count FROM jobs WHERE chat_id=? AND type='social_backfill' GROUP BY status`).all(chatId) as Array<{ status: string; count: number }>;
    return context.json({ items: listSocialKnowledge(db, chatId), jobs: Object.fromEntries(jobs.map((row) => [row.status, row.count])) });
  });
  app.put("/v1/chats/:id/social-knowledge", async (context) => {
    try {
      const body = await context.req.json() as { holder?: unknown; subject?: unknown; level?: unknown; knownAs?: unknown; previousHolder?: unknown; previousSubject?: unknown };
      const holder = typeof body.holder === "string" ? body.holder.trim() : "";
      const subject = typeof body.subject === "string" ? body.subject.trim() : "";
      if (!holder || !subject || !["aware_of", "met"].includes(String(body.level))) return context.json({ error: "holder, subject, and a valid level are required" }, 400);
      const knownAs = Array.isArray(body.knownAs) ? body.knownAs.filter((value): value is string => typeof value === "string") : [];
      const previousHolder = typeof body.previousHolder === "string" ? body.previousHolder.trim() : undefined;
      const previousSubject = typeof body.previousSubject === "string" ? body.previousSubject.trim() : undefined;
      if ((previousHolder && !previousSubject) || (!previousHolder && previousSubject)) return context.json({ error: "previousHolder and previousSubject must be provided together" }, 400);
      return context.json({ items: setManualSocialKnowledge(db, context.req.param("id"), { holder, subject, level: body.level as "aware_of" | "met", knownAs, previousHolder, previousSubject }) });
    } catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.delete("/v1/chats/:id/social-knowledge", async (context) => {
    try {
      const body = await context.req.json() as { holder?: unknown; subject?: unknown };
      const holder = typeof body.holder === "string" ? body.holder.trim() : "";
      const subject = typeof body.subject === "string" ? body.subject.trim() : "";
      if (!holder || !subject) return context.json({ error: "holder and subject are required" }, 400);
      return context.json({ items: retractSocialKnowledge(db, context.req.param("id"), holder, subject) });
    } catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.post("/v1/chats/:id/social-knowledge/backfill", async (context) => {
    try {
      const body = await context.req.json().catch(() => ({})) as { extractionReviewOverride?: unknown };
      if (body.extractionReviewOverride !== undefined && typeof body.extractionReviewOverride !== "boolean") return context.json({ error: "extractionReviewOverride must be boolean" }, 400);
      const queuedJobs = enqueueSocialKnowledgeBackfill(db, context.req.param("id"), body.extractionReviewOverride as boolean | undefined);
      if (queuedJobs) serverWorker.wake();
      return context.json({ ok: true, queuedJobs });
    } catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });

  app.get("/v1/chats/:id/extraction-audits", (context) => {
    const items = db.prepare(`SELECT id,job_id AS jobId,status,source_message_ids_json AS sourceMessageIds,source_fingerprint_json AS sourceFingerprint,source_revision AS sourceRevision,
      draft_json AS draft,patch_json AS patch,error,usage_json AS usage,attempts,created_at AS createdAt,updated_at AS updatedAt
      FROM extraction_audits WHERE chat_id=? ORDER BY updated_at DESC`).all(context.req.param("id")) as Array<Record<string, any>>;
    return context.json({ items: items.map((item) => {
      const sourceMessageIds = JSON.parse(item.sourceMessageIds || "[]");
      const draft = JSON.parse(item.draft);
      return { ...item, sourceMessageIds, sourceFingerprint: JSON.parse(item.sourceFingerprint || "[]"), draft,
        patch: item.patch ? JSON.parse(item.patch) : undefined, usage: JSON.parse(item.usage || "{}"),
        ...(["pending_review", "failed"].includes(item.status) ? { evidenceReview: describeEvidenceReview(db, context.req.param("id"), item.jobId, draft, sourceMessageIds) } : {}) };
    }) });
  });
  app.get("/v1/chats/:id/extraction-batches", (context) => context.json({ items: listExtractionBatches(db, context.req.param("id")) }));
  app.post("/v1/chats/:id/extraction-batches/:batchId/preview-regeneration", async (context) => {
    const body = await context.req.json() as { canonical?: boolean };
    return context.json(previewRegeneration(db, context.req.param("id"), context.req.param("batchId"), body.canonical === true));
  });
  app.get('/v1/chats/:id/memory-organization', (context) => {
    const chatId = context.req.param('id');
    invalidateChangedMemoryGroups(db, chatId);
    const legacyHolds = db.prepare(`SELECT e.id,e.start_ordinal,e.end_ordinal FROM episodes e WHERE e.chat_id=? AND e.resolution IS NOT 'group'
      AND e.status IN ('holding','queued','processing','failed') AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.chat_id=e.chat_id AND j.type='episode'
        AND json_extract(j.payload_json,'$.episodeId')=e.id AND json_extract(j.payload_json,'$.batchId') IS NOT NULL)`).all(chatId);
    return context.json({ ranges: listSourceRanges(db, chatId), groups: listMemoryGroups(db, chatId), regenerations: listRegenerations(db, chatId), legacyHolds });
  });
  app.get('/v1/chats/:id/source-ranges/:batchId', (context) => {
    const chatId = context.req.param('id');
    const range = listSourceRanges(db, chatId).find((row) => row.id === context.req.param('batchId'));
    if (!range) return context.json({ error: '원문 구간을 찾을 수 없어' }, 404);
    return context.json({ ...range, messages: rangeMessages(db, chatId).filter((row) => range.sourceMessageIds.includes(row.id)) });
  });
  for (const operation of ['preview', 'create'] as const) app.post(`/v1/chats/:id/memory-groups/${operation}`, async (context) => {
    try {
      const body = await context.req.json() as { batchIds?: unknown; postExtractionReview?: unknown };
      if (!Array.isArray(body.batchIds) || !body.batchIds.every((id) => typeof id === 'string') || typeof body.postExtractionReview !== 'boolean') return context.json({ error: '묶음 ID와 재검수 선택을 확인해 줘' }, 400);
      const chatId = context.req.param('id');
      if (operation === 'preview') return context.json(previewMemoryGroup(db, chatId, body.batchIds, body.postExtractionReview));
      const result = startMemoryGroup(db, chatId, body.batchIds, body.postExtractionReview);
      serverWorker.wake();
      return context.json(result, 202);
    } catch (error: any) { return context.json({ error: error.message, code: error.code }, 409); }
  });
  for (const operation of ['apply', 'ungroup', 'discard', 'retry'] as const) app.post(`/v1/chats/:id/memory-groups/:groupId/${operation}`, (context) => {
    const chatId = context.req.param('id'), groupId = context.req.param('groupId');
    try {
      if (operation === 'apply') applyMemoryGroup(db, chatId, groupId);
      else if (operation === 'ungroup') ungroupMemories(db, chatId, groupId);
      else if (operation === 'discard') discardMemoryGroup(db, chatId, groupId);
      else {
        if (!listMemoryGroups(db, chatId).find((row) => row.id === groupId)?.canRetry) return context.json({ error: '자동으로 더 진행할 수 없어. 원문과 중간 결과를 확인해 줘' }, 409);
        const changed = db.prepare("UPDATE jobs SET status='queued',attempts=0,last_error=NULL,updated_at=? WHERE chat_id=? AND type='memory_group' AND status='failed' AND json_extract(payload_json,'$.episodeId')=?").run(Date.now(), chatId, groupId);
        if (!changed.changes) return context.json({ error: '다시 시도할 실패 단계가 없어' }, 409);
        serverWorker.wake();
      }
      if (operation === 'apply' || operation === 'ungroup') void embeddings.indexPending(chatId);
      return context.json({ ok: true });
    } catch (error: any) { return context.json({ error: error.message, code: error.code }, 409); }
  });
  app.post("/v1/chats/:id/extraction-batches/:batchId/regenerate-episode", async (context) => {
    try {
      const body = await context.req.json().catch(() => ({})) as { postExtractionReview?: unknown };
      if (body.postExtractionReview !== undefined && typeof body.postExtractionReview !== "boolean") return context.json({ error: "postExtractionReview must be boolean" }, 400);
      const chat = db.prepare("SELECT post_extraction_review FROM chats WHERE id=?").get(context.req.param("id")) as { post_extraction_review: number } | undefined;
      if (!chat) return context.json({ error: "Chat not found" }, 404);
      const result = startEpisodeRegeneration(db, context.req.param("id"), context.req.param("batchId"), body.postExtractionReview === undefined ? chat.post_extraction_review !== 0 : body.postExtractionReview);
      serverWorker.wake();
      return context.json({ ok: true, ...result }, 202);
    } catch (error: any) { return context.json({ error: error?.message ?? String(error), code: error?.code }, error?.code === "BATCH_NOT_FOUND" ? 404 : 409); }
  });
  app.post("/v1/chats/:id/extraction-batches/:batchId/regenerate-canonical", async (context) => {
    try {
      const body = await context.req.json().catch(() => ({})) as { postExtractionReview?: unknown };
      if (body.postExtractionReview !== undefined && typeof body.postExtractionReview !== "boolean") return context.json({ error: "postExtractionReview must be boolean" }, 400);
      const chat = db.prepare("SELECT post_extraction_review FROM chats WHERE id=?").get(context.req.param("id")) as { post_extraction_review: number } | undefined;
      if (!chat) return context.json({ error: "Chat not found" }, 404);
      const result = startCanonicalRegeneration(db, context.req.param("id"), context.req.param("batchId"), body.postExtractionReview === undefined ? chat.post_extraction_review !== 0 : body.postExtractionReview);
      serverWorker.wake();
      return context.json({ ok: true, ...result }, 202);
    } catch (error: any) { return context.json({ error: error?.message ?? String(error), code: error?.code }, error?.code === "BATCH_NOT_FOUND" ? 404 : 409); }
  });
  app.get("/v1/chats/:id/regenerations/:runId", (context) => {
    try { return context.json(regenerationRun(db, context.req.param("id"), context.req.param("runId"))); }
    catch (error: any) { return context.json({ error: error?.message ?? String(error), code: error?.code }, 404); }
  });
  app.post("/v1/chats/:id/regenerations/:runId/apply", (context) => {
    try {
      const mode = (regenerationRun(db, context.req.param("id"), context.req.param("runId")) as any).mode;
      const result = mode === "canonical_suffix"
        ? applyCanonicalRegeneration(db, context.req.param("id"), context.req.param("runId"))
        : applyEpisodeRegeneration(db, context.req.param("id"), context.req.param("runId"));
      void embeddings.indexPending(context.req.param("id"));
      return context.json({ ok: true, ...result });
    } catch (error: any) { return context.json({ error: error?.message ?? String(error), code: error?.code }, 409); }
  });
  app.delete("/v1/chats/:id/regenerations/:runId", (context) => {
    try { discardRegeneration(db, context.req.param("id"), context.req.param("runId")); return context.json({ ok: true }); }
    catch (error: any) { return context.json({ error: error?.message ?? String(error), code: error?.code }, 409); }
  });
  app.post("/v1/chats/:id/extraction-audits/:auditId/retry", (context) => {
    const chatId = context.req.param("id");
    const audit = db.prepare("SELECT id,job_id,status,source_message_ids_json,source_fingerprint_json,draft_json,patch_json FROM extraction_audits WHERE id=? AND chat_id=?").get(context.req.param("auditId"), chatId) as
      | { id: string; job_id: string; status: string; source_message_ids_json: string; source_fingerprint_json: string; draft_json: string; patch_json: string | null }
      | undefined;
    if (!audit) return context.json({ error: "Extraction audit not found" }, 404);
    if (!["pending_review", "failed"].includes(audit.status)) return context.json({ error: "Extraction audit is not retryable" }, 409);
    const sourceMessageIds = JSON.parse(audit.source_message_ids_json || "[]") as string[];
    const expectedFingerprint = parseSourceFingerprintJson(audit.source_fingerprint_json || "[]");
    if (!expectedFingerprint || (sourceMessageIds.length > 0 && expectedFingerprint.length !== sourceMessageIds.length) || !fingerprintMatches(db, chatId, expectedFingerprint)) {
      db.prepare("UPDATE extraction_audits SET status='stale',error='Source fingerprint is no longer current',updated_at=? WHERE id=?").run(Date.now(), audit.id);
      return context.json({ error: "Source fingerprint is no longer current" }, 409);
    }
    const pending = db.prepare("SELECT id FROM jobs WHERE chat_id=? AND status IN ('queued','leased') AND json_extract(payload_json,'$.retryOfAuditId')=?").get(chatId, audit.id) as { id: string } | undefined;
    if (pending) return context.json({ ok: true, jobId: pending.id });
    const originalJob = db.prepare("SELECT status,payload_json FROM jobs WHERE id=?").get(audit.job_id) as { status: string; payload_json: string } | undefined;
    const originalPayload = JSON.parse(originalJob?.payload_json ?? "{}");
    let retryDraft = JSON.parse(audit.draft_json);
    const issues = inspectDraftEvidence(db, chatId, sourceMessageIds, retryDraft);
    const sourceRecovery = originalJob?.status === "done" || originalPayload.sourceRecovery === true;
    // Applied state must never be replayed to repair a citation. Historical core
    // evidence needs a targeted correction against the stored item, not ingestion.
    if (sourceRecovery && issues.some((issue) => issue.blocking)) return context.json({ error: "이미 적용된 상태의 근거는 개별 수정이 필요합니다. 중복 누적을 막기 위해 전체 재시도를 하지 않았습니다." }, 409);
    if (sourceRecovery) {
      const pendingRefs: string[] = JSON.parse(audit.patch_json ?? "{}")?.keepPendingItemRefs ?? [];
      const passages = (retryDraft.sourcePassages ?? []).filter((_item: unknown, index: number) => pendingRefs.includes(`source:${index}`)
        || issues.some((issue) => issue.path.startsWith(`sourcePassages[${index}]`)));
      for (const [memoryIndex, memory] of (retryDraft.memories ?? []).entries()) for (const [dialogueIndex, dialogue] of (memory.keyDialogues ?? []).entries()) {
        if (pendingRefs.includes(`dialogue:${memory.key}:${dialogue.messageId}:${dialogueIndex}`) || issues.some((issue) => issue.path.startsWith(`memories[${memoryIndex}].keyDialogues[${dialogueIndex}]`))) passages.push({
          messageId: dialogue.messageId, quote: dialogue.text, speaker: dialogue.speaker, epistemic: "stated", access: dialogue.access ?? [],
        });
      }
      if (!passages.length) return context.json({ error: "자동으로 다시 확인할 발췌가 없습니다. 보류된 항목의 진단을 확인해 주세요." }, 409);
      retryDraft = { language: retryDraft.language, entities: [], memories: [], stateObservations: [], sourcePassages: passages };
    }
    const timestamp = Date.now();
    const jobId = randomUUID();
    db.transaction(() => {
      db.prepare(`INSERT INTO jobs(id,chat_id,type,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,'audit_retry','queued',?,0,?,?)`)
        .run(jobId, chatId, JSON.stringify({ ...originalPayload, sourceMessageIds, sourceFingerprint: expectedFingerprint, auditDraft: retryDraft, sourceRecovery, retryOfAuditId: audit.id, retryOfJobId: audit.job_id, llmCallStats: { total: 0, repairs: 0, byPurpose: {} }, postExtractionReview: true }), timestamp, timestamp);
    })();
    serverWorker.wake();
    return context.json({ ok: true, jobId });
  });

  app.get("/v1/chats/:id/memories", (context) => {
    const chatId = context.req.param("id");
    const items = db.prepare(`
      SELECT m.id,m.type,m.title,m.content,m.participants_json,m.known_by_json,m.perspective,m.story_time,m.story_time_normalized,m.locations_json,m.landmark,m.landmark_kinds_json,m.evidence_json,
        m.salience,m.strength,m.recall_count,m.pinned,m.active,m.capsule_parent_id,m.source_batch_id AS sourceBatchId,m.user_managed AS userManaged,m.created_revision,m.created_at,m.updated_at,
        (SELECT MIN(msg.ordinal) FROM evidence_spans e JOIN messages msg ON msg.chat_id=e.chat_id AND msg.message_id=e.message_id WHERE e.memory_id=m.id) AS source_ordinal,
        (SELECT msg.event_time FROM evidence_spans e JOIN messages msg ON msg.chat_id=e.chat_id AND msg.message_id=e.message_id WHERE e.memory_id=m.id ORDER BY msg.ordinal LIMIT 1) AS source_event_time
      FROM memories m WHERE m.chat_id=? ORDER BY CASE WHEN source_ordinal IS NULL THEN 0 ELSE 1 END,CASE WHEN source_ordinal IS NULL THEN m.created_at END DESC,source_ordinal DESC,m.created_revision DESC
    `).all(chatId) as Array<Record<string, unknown> & { id: string }>;
    const dialogueQuery = db.prepare("SELECT speaker,text,message_id AS messageId,kind FROM memory_dialogues WHERE memory_id=? ORDER BY ordinal");
    const detailQuery = db.prepare(`SELECT id,detail_key AS key,kind,text,participants_json AS participants,known_by_json AS knownBy,locations_json AS locations,
      epistemic,salience,retention_class AS retention,evidence_json AS evidence,source_start_ordinal AS sourceOrdinal
      FROM memory_details WHERE memory_id=? AND active=1 ORDER BY COALESCE(source_start_ordinal,2147483647),created_at`);
    return context.json({ items: items.map((item) => {
      let locations: string[] = [];
      let landmarkKinds: unknown[] = [];
      try { locations = JSON.parse(String(item.locations_json ?? "[]")) as string[]; } catch { locations = []; }
      try { landmarkKinds = JSON.parse(String(item.landmark_kinds_json ?? "[]")) as unknown[]; } catch { landmarkKinds = []; }
      const { locations_json: _locationsJson, landmark_kinds_json: _landmarkKindsJson, ...rest } = item;
      const episode = db.prepare("SELECT id,status,resolution,source_tokens FROM episodes WHERE memory_id=? LIMIT 1").get(item.id) as any;
      const sections = episode ? db.prepare("SELECT id,ordinal,title,summary,source_message_ids_json AS sourceMessageIds,key_dialogues_json AS keyDialogues FROM episode_sections WHERE episode_id=? ORDER BY ordinal").all(episode.id).map((section: any) => ({
        ...section,
        sourceMessageIds: JSON.parse(section.sourceMessageIds || "[]"),
        keyDialogues: JSON.parse(section.keyDialogues || "[]"),
      })) : [];
      const details = (detailQuery.all(item.id) as Array<Record<string, any>>).map((detail) => ({ ...detail,
        participants: JSON.parse(detail.participants || "[]"), knownBy: JSON.parse(detail.knownBy || "[]"),
        locations: JSON.parse(detail.locations || "[]"), evidence: JSON.parse(detail.evidence || "[]"),
      }));
      return { ...rest, locations, landmarkKinds, landmark: item.landmark === 1, keyDialogues: dialogueQuery.all(item.id), details, detailCount: details.length, episode, sections };
    }) });
  });
  app.get("/v1/chats/:id/messages", (context) => context.json({ items: db.prepare(`
    SELECT message_id,role,ordinal,content,lifecycle,host_visibility,visible,event_time,generation_id,extraction_state,updated_at
    FROM messages WHERE chat_id=? ORDER BY ordinal
  `).all(context.req.param("id")) }));
  app.get("/v1/chats/:id/memory-details/search", (context) => {
    const chatId = context.req.param("id");
    const query = String(context.req.query("q") ?? "").trim();
    if (!query) return context.json({ error: "q is required" }, 400);
    const limit = Math.min(50, Math.max(1, Number(context.req.query("limit") ?? 20) || 20));
    const language = (db.prepare("SELECT memory_language FROM chats WHERE id=?").get(chatId) as { memory_language?: "en" | "ko" | "ja" | "zh" } | undefined)?.memory_language;
    const tokens = normalizeSearchTokens(query, language).slice(0, 16);
    if (!tokens.length) return context.json({ items: [] });
    const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" OR ");
    try {
      const rows = db.prepare(`SELECT d.id,d.memory_id AS memoryId,d.detail_key AS key,d.kind,d.text,d.participants_json AS participants,
        d.known_by_json AS knownBy,d.locations_json AS locations,d.epistemic,d.salience,d.retention_class AS retention,
        d.evidence_json AS evidence,d.source_start_ordinal AS sourceOrdinal,bm25(memory_detail_fts) AS rank
        FROM memory_detail_fts JOIN memory_details d ON d.id=memory_detail_fts.detail_id
        JOIN memories m ON m.id=d.memory_id AND m.active=1
        WHERE memory_detail_fts MATCH ? AND memory_detail_fts.chat_id=? AND d.active=1 ORDER BY rank LIMIT ?`).all(match, chatId, limit) as Array<Record<string, any>>;
      return context.json({ items: rows.map((row) => ({ ...row, participants: JSON.parse(row.participants || "[]"), knownBy: JSON.parse(row.knownBy || "[]"), locations: JSON.parse(row.locations || "[]"), evidence: JSON.parse(row.evidence || "[]") })) });
    } catch { return context.json({ items: [] }); }
  });
  app.get("/v1/chats/:id/evidence", (context) => {
    const chatId = context.req.param("id");
    const memoryId = String(context.req.query("memoryId") ?? "").trim();
    const detailId = String(context.req.query("detailId") ?? "").trim();
    if (!memoryId && !detailId) return context.json({ error: "memoryId or detailId is required" }, 400);
    let evidence: Array<{ messageId: string; quote?: string }> = [];
    if (detailId) {
      const row = db.prepare("SELECT evidence_json FROM memory_details WHERE id=? AND chat_id=?").get(detailId, chatId) as { evidence_json: string } | undefined;
      if (!row) return context.json({ error: "Memory detail not found" }, 404);
      evidence = JSON.parse(row.evidence_json || "[]");
    } else {
      const exists = db.prepare("SELECT 1 FROM memories WHERE id=? AND chat_id=?").get(memoryId, chatId);
      if (!exists) return context.json({ error: "Memory not found" }, 404);
      evidence = db.prepare("SELECT message_id AS messageId,quote FROM evidence_spans WHERE chat_id=? AND memory_id=? ORDER BY created_at").all(chatId, memoryId) as Array<{ messageId: string; quote?: string }>;
    }
    const items = evidence.map((item) => {
      const source = db.prepare("SELECT role,ordinal,content,lifecycle,host_visibility AS hostVisibility FROM messages WHERE chat_id=? AND message_id=?").get(chatId, item.messageId) as Record<string, any> | undefined;
      return { ...item, source: source ? { ...source, messageId: item.messageId } : null };
    });
    return context.json({ explicitEvidence: true, items });
  });
  app.delete("/v1/chats/:id/messages/:messageId", (context) => context.json({
    ok: hardDeleteMessage(db, context.req.param("id"), context.req.param("messageId")),
  }));
  app.patch("/v1/chats/:id", async (context) => {
    const body = await context.req.json() as { profile?: unknown; includeUserMessages?: unknown; memoryLanguage?: unknown; backfill?: boolean; extractionReviewOverride?: unknown };
    const chatId = context.req.param("id");
    const previous = db.prepare("SELECT profile,include_user_messages,memory_language,pending_memory_language FROM chats WHERE id=?").get(chatId) as { profile: string; include_user_messages: number; memory_language: string; pending_memory_language: string | null } | undefined;
    if (!previous) return context.json({ error: "Chat not found" }, 404);
    if (body.includeUserMessages !== undefined && typeof body.includeUserMessages !== "boolean") return context.json({ error: "includeUserMessages must be boolean" }, 400);
    if (body.extractionReviewOverride !== undefined && typeof body.extractionReviewOverride !== "boolean") return context.json({ error: "extractionReviewOverride must be boolean" }, 400);
    const profile = body.profile === undefined ? RpProfileSchema.parse(previous.profile) : RpProfileSchema.parse(body.profile);
    const includeUserMessages = body.includeUserMessages === undefined ? previous.include_user_messages === 1 : body.includeUserMessages === true;
    const memoryLanguage = body.memoryLanguage === undefined ? undefined : MemoryLanguageSchema.parse(body.memoryLanguage);
    const shouldBackfill = body.backfill === true && body.profile !== undefined && previous.profile === "companion" && profile === "simulation";
    if (body.profile === undefined && body.includeUserMessages === undefined && memoryLanguage === undefined) return context.json({ error: "No supported changes" }, 400);
    db.transaction(() => {
      db.prepare("UPDATE chats SET profile=?,include_user_messages=?,updated_at=? WHERE id=?").run(profile, includeUserMessages ? 1 : 0, Date.now(), chatId);
      if (memoryLanguage !== undefined) {
        if (memoryLanguage === previous.memory_language) db.prepare("UPDATE chats SET pending_memory_language=NULL WHERE id=?").run(chatId);
        else if (hasDerivedState(db, chatId)) db.prepare("UPDATE chats SET pending_memory_language=? WHERE id=?").run(memoryLanguage, chatId);
        else db.prepare("UPDATE chats SET memory_language=?,pending_memory_language=NULL WHERE id=?").run(memoryLanguage, chatId);
      }
      if (shouldBackfill) {
        db.prepare("UPDATE messages SET extraction_state='pending' WHERE chat_id=? AND lifecycle='committed' AND host_visibility IN ('active','all_before') AND content IS NOT NULL").run(chatId);
      }
    })();
    if (shouldBackfill) {
      enqueueExtractionJobs(db, chatId, profile, true, includeUserMessages, 4, "current", body.extractionReviewOverride as boolean | undefined);
      setTimeout(() => void embeddings.indexPending(chatId), 1_500);
    }
    const languageState = db.prepare("SELECT memory_language,pending_memory_language FROM chats WHERE id=?").get(chatId) as { memory_language: string; pending_memory_language: string | null };
    return context.json({ ok: true, profile, includeUserMessages, memoryLanguage: languageState.memory_language, pendingMemoryLanguage: languageState.pending_memory_language, requiresLanguageReprocess: languageState.pending_memory_language !== null });
  });
  app.put("/v1/chats/:id/title", async (context) => {
    const body = await context.req.json() as { chatTitle?: unknown };
    const chatTitle = typeof body.chatTitle === "string" ? body.chatTitle.trim().slice(0, 240) : "";
    if (!chatTitle) return context.json({ error: "chatTitle is required" }, 400);
    const result = db.prepare("UPDATE chats SET chat_title=?,updated_at=? WHERE id=?").run(chatTitle, Date.now(), context.req.param("id"));
    return result.changes ? context.json({ ok: true, chatTitle }) : context.json({ error: "Chat not found" }, 404);
  });
  app.post("/v1/chats/:id/memories", async (context) => {
    const chatId = context.req.param("id");
    const body = await context.req.json() as {
      title?: unknown; content?: unknown; storyTime?: unknown; participants?: unknown; landmarkKinds?: unknown;
    };
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const title = typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : content.replace(/\s+/g, " ").slice(0, 80);
    const storyTime = typeof body.storyTime === "string" ? body.storyTime.trim() : "";
    const participants = Array.isArray(body.participants)
      ? [...new Set(body.participants.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean))].slice(0, 16)
      : [];
    const landmarks = Array.isArray(body.landmarkKinds) ? body.landmarkKinds : [];
    if (!content || content.length > 20_000 || !title || title.length > 500) return context.json({ error: "Manual memory title or content is invalid" }, 400);
    if (storyTime.length > 240) return context.json({ error: "storyTime must be a string up to 240 characters" }, 400);
    if (!Array.isArray(body.participants) || participants.length !== body.participants.length) return context.json({ error: "participants must contain up to 16 non-empty names" }, 400);
    const parsedLandmarks = LandmarkKindSchema.array().max(12).safeParse(landmarks);
    if (!parsedLandmarks.success) return context.json({ error: "Invalid landmarkKinds", issues: parsedLandmarks.error.issues }, 400);
    const chat = db.prepare("SELECT revision FROM chats WHERE id=?").get(chatId) as { revision: number } | undefined;
    if (!chat) return context.json({ error: "Chat not found" }, 404);
    const id = randomUUID();
    const timestamp = Date.now();
    const memoryKey = `manual:${id}`;
    db.prepare(`INSERT INTO memories(
      id,chat_id,memory_key,type,title,content,participants_json,known_by_json,perspective,story_time,story_time_normalized,locations_json,
      landmark,landmark_kinds_json,evidence_json,salience,strength,retention_class,atom_access_version,source_batch_id,user_managed,
      created_revision,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?,?)`).run(
      id, chatId, memoryKey, parsedLandmarks.data.length ? "relationship" : "episode", title, content,
      JSON.stringify(participants), JSON.stringify(participants), null, storyTime || null, normalizeStoryTime(storyTime) ?? null, "[]",
      parsedLandmarks.data.length ? 1 : 0, JSON.stringify(parsedLandmarks.data), "[]", .7, .7,
      parsedLandmarks.data.length ? "durable" : "arc", 0, chat.revision, timestamp, timestamp,
    );
    refreshMemoryFts(db, id);
    void embeddings.indexPending(chatId);
    return context.json({ ok: true, id, memoryKey }, 201);
  });
  app.patch("/v1/chats/:id/memories/:memoryId", async (context) => {
    const body = await context.req.json() as Record<string, unknown>;
    const allowed = ["title", "content", "salience", "strength", "pinned", "active", "storyTime", "locations", "landmark", "landmarkKinds"] as const;
    const updates = allowed.filter((key) => body[key] !== undefined);
    if (updates.length === 0) return context.json({ error: "No supported changes" }, 400);
    if (["salience", "strength"].some((key) => body[key] !== undefined && (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0 || Number(body[key]) > 1))) {
      return context.json({ error: "salience and strength must be finite numbers from 0 to 1" }, 400);
    }
    if (body.storyTime !== undefined && body.storyTime !== null && (typeof body.storyTime !== "string" || body.storyTime.length > 240)) {
      return context.json({ error: "storyTime must be a string up to 240 characters" }, 400);
    }
    if (body.locations !== undefined && (!Array.isArray(body.locations) || body.locations.length > 12 || body.locations.some((value) => typeof value !== "string" || !value.trim() || value.length > 240))) {
      return context.json({ error: "locations must be an array of up to 12 non-empty strings" }, 400);
    }
    const landmarkKindNames = new Set(["confession","relationship_change","first_met","romantic_relationship_established","engagement","marriage","separation","romantic_relationship_ended","reunion","divorce","anniversary_basis","betrayal","death","identity_reveal","status_change","boundary_change","intimacy_milestone","other"]);
    const relationshipLandmarkNames = new Set(["first_met","romantic_relationship_established","engagement","marriage","separation","romantic_relationship_ended","reunion","divorce","anniversary_basis"]);
    if (body.landmarkKinds !== undefined && (!Array.isArray(body.landmarkKinds) || body.landmarkKinds.length > 12 || body.landmarkKinds.some((entry: any) => !entry || !landmarkKindNames.has(entry.kind)
      || entry.kind === "other" && (typeof entry.label !== "string" || !entry.label.trim())
      || relationshipLandmarkNames.has(entry.kind) && (!Array.isArray(entry.pair) || entry.pair.length !== 2 || entry.pair.some((name: unknown) => typeof name !== "string" || !name.trim()))))) return context.json({ error: "Invalid landmarkKinds" }, 400);
    const columns: Record<(typeof allowed)[number], string> = { title: "title", content: "content", salience: "salience", strength: "strength", pinned: "pinned", active: "active", storyTime: "story_time", locations: "locations_json", landmark: "landmark", landmarkKinds: "landmark_kinds_json" };
    const values = updates.map((key) => key === "pinned" || key === "active" || key === "landmark"
      ? (body[key] ? 1 : 0)
      : key === "locations" || key === "landmarkKinds" ? JSON.stringify(body[key])
        : key === "storyTime" ? (body.storyTime || null)
          : key === "salience" || key === "strength" ? normalizeUnitScore(Number(body[key])) : body[key]);
    const result = db.transaction(() => {
      const normalizedUpdate = updates.includes("storyTime") ? ",story_time_normalized=?" : "";
      const changed = db.prepare(`UPDATE memories SET ${updates.map((key) => `${columns[key]}=?`).join(",")}${normalizedUpdate},user_managed=1,updated_at=? WHERE id=? AND chat_id=?`).run(
        ...values, ...(updates.includes("storyTime") ? [normalizeStoryTime(body.storyTime) ?? null] : []), Date.now(), context.req.param("memoryId"), context.req.param("id"),
      );
      if (changed.changes === 1 && (updates.includes("title") || updates.includes("content") || updates.includes("locations") || updates.includes("landmarkKinds"))) refreshMemoryFts(db, context.req.param("memoryId"));
      return changed;
    })();
    if (result.changes === 1) {
      if (body.active === false) embeddings.removeMemory(context.req.param("memoryId"));
      else if (updates.includes("title") || updates.includes("content") || updates.includes("locations") || updates.includes("landmarkKinds") || body.active === true) void embeddings.indexPending(context.req.param("id"));
    }
    return result.changes === 1
      ? context.json({ ok: true })
      : context.json({ error: "Memory not found" }, 404);
  });
  app.delete("/v1/chats/:id/memories/:memoryId", (context) => {
    const chatId = context.req.param("id");
    const memoryId = context.req.param("memoryId");
    const result = db.transaction(() => {
      db.prepare("DELETE FROM memory_fts WHERE memory_id=? AND chat_id=?").run(memoryId, chatId);
      return db.prepare("DELETE FROM memories WHERE id=? AND chat_id=?").run(memoryId, chatId).changes;
    })();
    if (result === 1) embeddings.removeMemory(memoryId);
    return context.json({ ok: result === 1 });
  });
  app.get("/v1/chats/:id/relationships", (context) => {
    const chatId = context.req.param("id");
    const events = (db.prepare(`SELECT id,from_entity AS "from",to_entity AS "to",changes_json AS changes,reason,evidence_json AS evidence,
      source_memory_id AS sourceMemoryId,source_detail_id AS sourceDetailId,source_start_ordinal AS sourceOrdinal,created_revision AS createdRevision
      FROM relationship_events WHERE chat_id=? AND active=1 ORDER BY COALESCE(source_start_ordinal,2147483647),created_at`).all(chatId) as Array<Record<string, any>>)
      .map((event) => ({ ...event, changes: JSON.parse(event.changes || "[]"), evidence: JSON.parse(event.evidence || "[]") }));
    return context.json({ items: listRelationshipProjections(db, chatId), events });
  });
  app.get("/v1/chats/:id/physical-intimacy", (context) => {
    const items = db.prepare(`SELECT p.id,p.participant_a AS participantA,p.participant_b AS participantB,p.milestone_key AS milestoneKey,p.act,p.custom_label AS customLabel,
      p.initiator,p.interaction_context AS interactionContext,p.circumstance,p.evidence_json AS evidence,p.source_memory_id AS sourceMemoryId,
      m.title AS sourceMemoryTitle,p.auto_inject AS autoInject,p.manual_override AS manualOverride,
      'milestone' AS status,p.source_start_ordinal AS sourceOrdinal,p.created_revision AS createdRevision
      FROM physical_intimacy_milestones p LEFT JOIN memories m ON m.id=p.source_memory_id WHERE p.chat_id=? AND p.active=1
      ORDER BY COALESCE(p.source_start_ordinal,2147483647),p.created_at,p.milestone_key`).all(context.req.param("id")) as Array<Record<string, any>>;
    return context.json({ items: items.map((item) => ({ ...item, autoInject: item.autoInject === 1, manualOverride: item.manualOverride === 1 })) });
  });
  app.post("/v1/chats/:id/physical-intimacy", async (context) => {
    const chatId = context.req.param("id");
    const body = await context.req.json() as { participantA?: string; participantB?: string; act?: string; customLabel?: string; initiator?: string; interactionContext?: string; circumstance?: string; sourceMessageId?: string; autoInject?: boolean };
    const participantA = body.participantA?.trim() ?? "";
    const participantB = body.participantB?.trim() ?? "";
    const act = body.act?.trim() ?? "";
    const customLabel = body.customLabel?.trim() || null;
    const allowedActs = new Set(["hand_holding", "embrace", "cuddling", "forehead_kiss", "cheek_kiss", "hand_kiss", "lip_kiss", "deep_kiss", "sexual_touch", "manual_sex", "oral_sex", "vaginal_sex", "anal_sex", "other"]);
    if (!participantA || !participantB || participantA.localeCompare(participantB, undefined, { sensitivity: "base" }) === 0) return context.json({ error: "서로 다른 참여자 두 명을 선택하세요." }, 400);
    if (!allowedActs.has(act) || (act === "other" && !customLabel)) return context.json({ error: "스킨십 종류를 확인하세요." }, 400);
    const contextValue = ["mutual", "initiated", "coerced", "nonconsensual", "ambiguous"].includes(body.interactionContext ?? "") ? body.interactionContext! : "ambiguous";
    const chat = db.prepare("SELECT revision FROM chats WHERE id=?").get(chatId) as { revision: number } | undefined;
    if (!chat) return context.json({ error: "Chat not found" }, 404);
    const source = body.sourceMessageId
      ? db.prepare("SELECT message_id,ordinal FROM messages WHERE chat_id=? AND message_id=? AND lifecycle IN ('committed','client_pruned') AND host_visibility IN ('active','all_before')").get(chatId, body.sourceMessageId) as { message_id: string; ordinal: number } | undefined
      : undefined;
    if (body.sourceMessageId && !source) return context.json({ error: "연결할 수 있는 활성 원문을 찾지 못했습니다." }, 400);
    const ordinal = source?.ordinal ?? (db.prepare("SELECT MAX(ordinal) ordinal FROM messages WHERE chat_id=? AND lifecycle IN ('committed','client_pruned')").get(chatId) as { ordinal: number | null }).ordinal;
    const revision = chat.revision + 1;
    const pair = [participantA, participantB].sort((left, right) => left.localeCompare(right));
    const inserted: string[] = [];
    db.transaction(() => {
      for (const milestoneKey of intimacyMilestoneKeys(act)) {
        const existing = db.prepare("SELECT id,active FROM physical_intimacy_milestones WHERE chat_id=? AND participant_a=? AND participant_b=? AND milestone_key=?").get(chatId, pair[0], pair[1], milestoneKey) as { id: string; active: number } | undefined;
        if (existing?.active === 1) continue;
        const id = existing?.id ?? randomUUID();
        db.prepare(`INSERT INTO physical_intimacy_milestones(id,chat_id,participant_a,participant_b,milestone_key,act,custom_label,initiator,interaction_context,circumstance,evidence_json,source_memory_id,source_start_ordinal,auto_inject,manual_override,deleted_by_user,active,created_revision,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,1,?,?) ON CONFLICT(chat_id,participant_a,participant_b,milestone_key) DO UPDATE SET
            act=excluded.act,custom_label=excluded.custom_label,initiator=excluded.initiator,interaction_context=excluded.interaction_context,
            circumstance=excluded.circumstance,evidence_json=excluded.evidence_json,source_start_ordinal=excluded.source_start_ordinal,auto_inject=excluded.auto_inject,
            manual_override=1,deleted_by_user=0,active=1,
            created_revision=excluded.created_revision,created_at=excluded.created_at`).run(id, chatId, pair[0], pair[1], milestoneKey, act, customLabel,
          body.initiator?.trim() || null, contextValue, body.circumstance?.trim() || null, JSON.stringify(source ? [{ messageId: source.message_id }] : []), null, ordinal, body.autoInject === false ? 0 : 1, revision, Date.now());
        inserted.push(id);
      }
      db.prepare("UPDATE chats SET revision=?,updated_at=? WHERE id=?").run(revision, Date.now(), chatId);
    })();
    return inserted.length ? context.json({ ok: true, id: inserted[0], inserted }) : context.json({ error: "해당 최초 마일스톤이 이미 기록되어 있습니다.", code: "DUPLICATE_LEDGER_ITEM" }, 409);
  });
  app.patch("/v1/chats/:id/physical-intimacy/:itemId", async (context) => {
    const chatId = context.req.param("id");
    const itemId = context.req.param("itemId");
    const current = db.prepare("SELECT * FROM physical_intimacy_milestones WHERE id=? AND chat_id=? AND active=1").get(itemId, chatId) as any;
    if (!current) return context.json({ error: "기록을 찾지 못했습니다." }, 404);
    const body = await context.req.json() as { participantA?: string; participantB?: string; act?: string; customLabel?: string; initiator?: string; interactionContext?: string; circumstance?: string; sourceMessageId?: string; autoInject?: boolean };
    const participantA = body.participantA?.trim() || current.participant_a;
    const participantB = body.participantB?.trim() || current.participant_b;
    const act = body.act?.trim() || current.act;
    const customLabel = Object.hasOwn(body, "customLabel") ? body.customLabel?.trim() || null : current.custom_label;
    if (participantA.localeCompare(participantB, undefined, { sensitivity: "base" }) === 0 || (act === "other" && !customLabel)) return context.json({ error: "입력값을 확인하세요." }, 400);
    if (!intimacyMilestoneKeys(act).includes(current.milestone_key)) return context.json({ error: "이 실제 행위는 현재 최초 마일스톤 종류와 맞지 않습니다. 기존 행을 삭제하고 새 최초 행위로 추가하세요." }, 400);
    const sourceWasEdited = Object.hasOwn(body, "sourceMessageId");
    const source = body.sourceMessageId
      ? db.prepare("SELECT message_id,ordinal FROM messages WHERE chat_id=? AND message_id=? AND lifecycle IN ('committed','client_pruned') AND host_visibility IN ('active','all_before')").get(chatId, body.sourceMessageId) as { message_id: string; ordinal: number } | undefined
      : undefined;
    if (body.sourceMessageId && !source) return context.json({ error: "연결할 수 있는 활성 원문을 찾지 못했습니다." }, 400);
    const chat = db.prepare("SELECT revision FROM chats WHERE id=?").get(chatId) as { revision: number };
    const revision = chat.revision + 1;
    const ordinal = sourceWasEdited
      ? source?.ordinal ?? (db.prepare("SELECT MAX(ordinal) ordinal FROM messages WHERE chat_id=?").get(chatId) as { ordinal: number | null }).ordinal
      : current.source_start_ordinal;
    const contextValue = ["mutual", "initiated", "coerced", "nonconsensual", "ambiguous"].includes(body.interactionContext ?? "") ? body.interactionContext! : current.interaction_context;
    const pair = [participantA, participantB].sort((left, right) => left.localeCompare(right));
    db.transaction(() => {
      const semanticEdit = ["participantA", "participantB", "act", "customLabel", "initiator", "interactionContext", "circumstance", "sourceMessageId"].some((key) => Object.hasOwn(body, key));
      db.prepare(`UPDATE physical_intimacy_milestones SET participant_a=?,participant_b=?,act=?,custom_label=?,initiator=?,interaction_context=?,circumstance=?,
        evidence_json=?,source_start_ordinal=?,auto_inject=?,manual_override=CASE WHEN ? THEN 1 ELSE manual_override END,deleted_by_user=0,created_revision=? WHERE id=?`).run(pair[0], pair[1], act, customLabel,
        Object.hasOwn(body, "initiator") ? body.initiator?.trim() || null : current.initiator,
        contextValue, Object.hasOwn(body, "circumstance") ? body.circumstance?.trim() || null : current.circumstance,
        sourceWasEdited ? JSON.stringify(source ? [{ messageId: source.message_id }] : []) : current.evidence_json,
        ordinal, body.autoInject === undefined ? current.auto_inject : body.autoInject ? 1 : 0, semanticEdit ? 1 : 0, revision, itemId);
      db.prepare("UPDATE chats SET revision=?,updated_at=? WHERE id=?").run(revision, Date.now(), chatId);
    })();
    if (current.source_memory_id) { refreshMemoryFts(db, current.source_memory_id); void embeddings.indexPending(chatId); }
    return context.json({ ok: true, id: itemId });
  });
  app.delete("/v1/chats/:id/physical-intimacy/:itemId", (context) => {
    const chatId = context.req.param("id");
    const chat = db.prepare("SELECT revision FROM chats WHERE id=?").get(chatId) as { revision: number } | undefined;
    if (!chat) return context.json({ error: "Chat not found" }, 404);
    const current = db.prepare("SELECT source_memory_id FROM physical_intimacy_milestones WHERE id=? AND chat_id=? AND active=1").get(context.req.param("itemId"), chatId) as { source_memory_id: string | null } | undefined;
    const revision = chat.revision + 1;
    const changed = db.transaction(() => {
      const result = db.prepare("UPDATE physical_intimacy_milestones SET active=0,manual_override=1,deleted_by_user=1,created_revision=? WHERE id=? AND chat_id=? AND active=1").run(revision, context.req.param("itemId"), chatId).changes;
      if (result) db.prepare("UPDATE chats SET revision=?,updated_at=? WHERE id=?").run(revision, Date.now(), chatId);
      return result;
    })();
    if (changed && current?.source_memory_id) { refreshMemoryFts(db, current.source_memory_id); void embeddings.indexPending(chatId); }
    return changed ? context.json({ ok: true }) : context.json({ error: "기록을 찾지 못했습니다." }, 404);
  });
  app.get("/v1/chats/:id/entities", (context) => {
    const chatId = context.req.param("id");
    const prominence = new Map((db.prepare("SELECT entity_name,tier,scene_count,durable_links,pinned FROM entity_prominence WHERE chat_id=?").all(chatId) as Array<Record<string, any>>)
      .map((row) => [String(row.entity_name).toLocaleLowerCase(), { tier: row.tier, sceneCount: row.scene_count, durableLinks: row.durable_links, pinned: row.pinned === 1 }]));
    return context.json({ items: listEntities(db, chatId).map((entity) => ({ ...entity, ...(prominence.get(entity.name.toLocaleLowerCase()) ?? { tier: "incidental", sceneCount: 0, durableLinks: 0, pinned: false }) })) });
  });
  app.patch("/v1/chats/:id/entities/:entityId/prominence", async (context) => {
    const chatId = context.req.param("id");
    const entity = db.prepare("SELECT name FROM entities WHERE id=? AND chat_id=?").get(context.req.param("entityId"), chatId) as { name: string } | undefined;
    if (!entity) return context.json({ error: "Entity not found" }, 404);
    const body = await context.req.json() as { pinned?: unknown };
    if (typeof body.pinned !== "boolean") return context.json({ error: "pinned must be boolean" }, 400);
    db.prepare(`INSERT INTO entity_prominence(chat_id,entity_name,tier,scene_count,durable_links,pinned,updated_at) VALUES(?,?,?,0,0,?,?)
      ON CONFLICT(chat_id,entity_name) DO UPDATE SET pinned=excluded.pinned,tier=CASE WHEN excluded.pinned=1 THEN 'core' ELSE CASE WHEN entity_prominence.scene_count>=4 AND entity_prominence.durable_links>0 THEN 'core' WHEN entity_prominence.scene_count>=2 OR entity_prominence.durable_links>0 THEN 'recurring' ELSE 'incidental' END END,updated_at=excluded.updated_at`)
      .run(chatId, entity.name, body.pinned ? "core" : "incidental", body.pinned ? 1 : 0, Date.now());
    return context.json({ ok: true });
  });
  app.post("/v1/chats/:id/entities/merge-preview", async (context) => {
    const body = await context.req.json() as { sourceId?: string; targetId?: string };
    if (!body.sourceId || !body.targetId) return context.json({ error: "sourceId and targetId are required" }, 400);
    try { return context.json(previewEntityMerge(db, context.req.param("id"), body.sourceId, body.targetId)); }
    catch (error: any) {
      const status = error?.code === "ENTITY_NOT_FOUND" ? 404 : 400;
      return context.json({ error: error instanceof Error ? error.message : String(error), code: error?.code }, status);
    }
  });
  app.post("/v1/chats/:id/entities/merge", async (context) => {
    const body = await context.req.json() as { sourceId?: string; targetId?: string; revision?: number };
    if (!body.sourceId || !body.targetId || !Number.isInteger(body.revision)) return context.json({ error: "sourceId, targetId, and preview revision are required" }, 400);
    try { return context.json({ ok: true, ...mergeEntities(db, context.req.param("id"), body.sourceId, body.targetId, body.revision) }); }
    catch (error: any) {
      const status = error?.code === "ENTITY_MERGE_BUSY" || error?.code === "ENTITY_MERGE_STALE" ? 409 : error?.code === "ENTITY_NOT_FOUND" ? 404 : 400;
      return context.json({ error: error instanceof Error ? error.message : String(error), code: error?.code }, status);
    }
  });
  app.get("/v1/chats/:id/reconciliation-reviews", (context) => context.json({ items: listReconciliationReviews(db, context.req.param("id")) }));
  app.patch("/v1/chats/:id/reconciliation-reviews/:reviewId", async (context) => {
    const body = ReconciliationReviewResolutionSchema.parse(await context.req.json());
    resolveReconciliationReview(db, context.req.param("id"), context.req.param("reviewId"), body);
    void embeddings.indexPending(context.req.param("id"));
    return context.json({ ok: true });
  });
  app.get("/v1/chats/:id/episodes/active", (context) => context.json(episodeOverview(db, context.req.param("id"))));
  app.post("/v1/chats/:id/episodes/:episodeId/release", (context) => {
    try {
      releaseManualEpisode(db, context.req.param("id"), context.req.param("episodeId"));
      serverWorker.wake();
      return context.json({ ok: true, ...episodeOverview(db, context.req.param("id")) });
    } catch (error: any) { return context.json({ error: error.message }, 409); }
  });
  app.post("/v1/chats/:id/episodes/:episodeId/retry", (context) => {
    const automatic = db.prepare("SELECT 1 FROM jobs WHERE chat_id=? AND type='episode' AND json_extract(payload_json,'$.episodeId')=? AND json_extract(payload_json,'$.batchId') IS NOT NULL")
      .get(context.req.param('id'), context.req.param('episodeId'));
    if (!automatic) return context.json({ error: '수동 보류는 해제한 뒤 원문 구간에서 정리해 줘' }, 409);
    retryEpisode(db, context.req.param("id"), context.req.param("episodeId"));
    serverWorker.wake();
    return context.json({ ok: true, ...episodeOverview(db, context.req.param("id")) });
  });
  app.post("/v1/chats/:id/backfill-runs/:runId/acknowledge", (context) => {
    const chatId = context.req.param("id");
    const runId = context.req.param("runId");
    const exists = db.prepare("SELECT 1 FROM jobs WHERE chat_id=? AND json_extract(payload_json,'$.backfillRunId')=? LIMIT 1").get(chatId, runId);
    if (!exists) return context.json({ error: "Backfill run not found" }, 404);
    db.prepare("INSERT INTO server_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(`backfill_ack:${chatId}:${runId}`, String(Date.now()));
    return context.json({ ok: true });
  });
  app.get("/v1/chats/:id/status", (context) => {
    const chatId = context.req.param("id");
    const jobs = db.prepare(`SELECT
      SUM(CASE WHEN status IN ('queued','leased') THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='failed' AND type IN ('extract','audit_retry','episode','social_backfill','initial_calibration') THEN 1 ELSE 0 END) AS blockingFailed,
      SUM(CASE WHEN status='failed' AND type IN ('ledger_consistency','relationship_projection','story_consolidation') THEN 1 ELSE 0 END) AS advisoryFailed
      FROM jobs WHERE chat_id=?`).get(chatId) as { queued: number | null; failed: number | null; blockingFailed: number | null; advisoryFailed: number | null };
    const pendingReconciliations = (db.prepare("SELECT count(*) AS count FROM reconciliation_items WHERE chat_id=? AND status='pending'").get(chatId) as { count: number }).count;
    const pendingExtractionAudits = (db.prepare("SELECT count(*) AS count FROM extraction_audits WHERE chat_id=? AND status IN ('pending_review','failed')").get(chatId) as { count: number }).count;
    const ingestion = ingestionSummary(db, chatId);
    const embeddingJobs = db.prepare(`SELECT
      SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
      FROM embedding_blocks WHERE chat_id=?`).get(chatId) as { pending: number | null; failed: number | null };
    const sourceProgress = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN extraction_state IN ('done','encapsulated','skipped_policy') THEN 1 ELSE 0 END) processed
      FROM messages WHERE chat_id=? AND lifecycle IN ('committed','client_pruned') AND host_visibility IN ('active','all_before') AND content IS NOT NULL`).get(chatId) as { total: number; processed: number | null };
    const derivedCounts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM memories WHERE chat_id=? AND active=1) memories,
      (SELECT COUNT(*) FROM memory_details WHERE chat_id=? AND active=1) details,
      (SELECT COUNT(*) FROM relationship_projection_queue WHERE chat_id=?) projectionPairs`).get(chatId, chatId, chatId) as { memories: number; details: number; projectionPairs: number };
    const latestBackfill = db.prepare(`SELECT json_extract(payload_json,'$.backfillRunId') runId,created_at createdAt
      FROM jobs WHERE chat_id=? AND type IN ('initial_calibration','extract','episode','ledger_consistency','relationship_projection','story_consolidation')
        AND json_extract(payload_json,'$.backfillRunId') IS NOT NULL
      ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(chatId) as { runId: string; createdAt: number } | undefined;
    const groupProgress = (latestBackfill?.runId
      ? db.prepare(`SELECT COUNT(*) total,
          SUM(CASE WHEN status IN ('done','archived') THEN 1 ELSE 0 END) processed,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed
          FROM jobs WHERE chat_id=? AND type IN ('extract','episode','social_backfill') AND json_extract(payload_json,'$.backfillRunId')=?`).get(chatId, latestBackfill.runId)
      : db.prepare(`SELECT COUNT(*) total,
          SUM(CASE WHEN status IN ('done','archived') THEN 1 ELSE 0 END) processed,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed
          FROM jobs WHERE chat_id=? AND type IN ('extract','episode','social_backfill')`).get(chatId)) as { total: number | null; processed: number | null; failed: number | null };
    const downstreamJobs = (latestBackfill?.runId ? db.prepare(`SELECT
      COUNT(CASE WHEN type='relationship_projection' THEN 1 END) projectionTotal,
      SUM(CASE WHEN type='relationship_projection' AND status IN ('done','failed','archived') THEN 1 ELSE 0 END) projectionProcessed,
      SUM(CASE WHEN type='relationship_projection' AND status IN ('queued','leased') THEN 1 ELSE 0 END) projectionJobs,
      SUM(CASE WHEN type='relationship_projection' AND status='failed' THEN 1 ELSE 0 END) projectionFailed,
      COUNT(CASE WHEN type='story_consolidation' THEN 1 END) storyTotal,
      SUM(CASE WHEN type='story_consolidation' AND status IN ('done','failed','archived') THEN 1 ELSE 0 END) storyProcessed,
      SUM(CASE WHEN type='story_consolidation' AND status IN ('queued','leased') THEN 1 ELSE 0 END) storyJobs,
      SUM(CASE WHEN type='story_consolidation' AND status='failed' THEN 1 ELSE 0 END) storyFailed
      FROM jobs WHERE chat_id=? AND json_extract(payload_json,'$.backfillRunId')=?`).get(chatId, latestBackfill.runId)
      : { projectionTotal: 0, projectionProcessed: 0, projectionJobs: 0, projectionFailed: 0, storyTotal: 0, storyProcessed: 0, storyJobs: 0, storyFailed: 0 }) as { projectionTotal: number | null; projectionProcessed: number | null; projectionJobs: number | null; projectionFailed: number | null; storyTotal: number | null; storyProcessed: number | null; storyJobs: number | null; storyFailed: number | null };
    const taskProgress = db.prepare(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN status IN ('done','archived') THEN 1 ELSE 0 END) processed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed
      FROM jobs WHERE chat_id=? AND type IN ('extract','episode','social_backfill','audit_retry','ledger_consistency','relationship_projection','story_consolidation')`).get(chatId) as { total: number; processed: number | null; failed: number | null };
    const activePipeline = db.prepare(`SELECT COALESCE(json_extract(payload_json,'$.pipelineStage'),json_extract(payload_json,'$.operationStage')) stage,
      json_extract(payload_json,'$.pipelineRetryAttempt') retryAttempt,
      json_extract(payload_json,'$.pipelineMaxAttempts') retryMax,
      CASE WHEN type='extract' THEN json_extract(payload_json,'$.operationStageOrdinal') END groupOrdinal,
      CASE WHEN type='extract' THEN json_extract(payload_json,'$.operationStageTotal') END groupTotal
      FROM jobs WHERE chat_id=? AND status IN ('leased','queued')${latestBackfill?.runId ? " AND json_extract(payload_json,'$.backfillRunId')=?" : ""}
      ORDER BY status='leased' DESC,CASE WHEN json_extract(payload_json,'$.pipelineStage')='retrying' THEN 0 ELSE 1 END,created_at,rowid LIMIT 1`).get(...(latestBackfill?.runId ? [chatId, latestBackfill.runId] : [chatId])) as { stage: string | null; retryAttempt: number | null; retryMax: number | null; groupOrdinal: number | null; groupTotal: number | null } | undefined;
    const ledgerProgress = latestBackfill?.runId
      ? db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN status IN ('done','failed','archived') THEN 1 ELSE 0 END) processed,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed
          FROM jobs WHERE chat_id=? AND type='ledger_consistency' AND json_extract(payload_json,'$.backfillRunId')=?`).get(chatId, latestBackfill.runId) as { total: number; processed: number | null; failed: number | null }
      : { total: 0, processed: 0, failed: 0 };
    const ledgerBarrierActive = Boolean(latestBackfill?.runId && db.prepare(`SELECT 1 FROM jobs WHERE chat_id=? AND type IN ('extract','episode','ledger_consistency')
      AND status IN ('queued','leased') AND json_extract(payload_json,'$.backfillRunId')=? LIMIT 1`).get(chatId, latestBackfill.runId));
    const callProgress = latestBackfill?.runId ? db.prepare(`SELECT
      SUM(COALESCE(json_extract(payload_json,'$.llmCallStats.total'),0)) total,
      SUM(COALESCE(json_extract(payload_json,'$.llmCallStats.repairs'),0)) repairs,
      SUM(CASE WHEN status IN ('queued','leased') THEN 1 ELSE 0 END) active
      FROM jobs WHERE chat_id=? AND json_extract(payload_json,'$.backfillRunId')=?`).get(chatId, latestBackfill.runId) as { total: number | null; repairs: number | null; active: number | null }
      : { total: 0, repairs: 0, active: 0 };
    const acknowledged = latestBackfill?.runId ? Boolean(db.prepare("SELECT 1 FROM server_meta WHERE key=?").get(`backfill_ack:${chatId}:${latestBackfill.runId}`)) : true;
    const calibration = initialCalibrationView(db, chatId);
    const calibrationPending = ["unseeded", "awaiting_setup", "queued", "awaiting_confirmation"].includes(calibration.status);
    return context.json({
      queuedJobs: Number(jobs.queued ?? 0), failedJobs: Number(jobs.failed ?? 0), blockingFailedJobs: Number(jobs.blockingFailed ?? 0), advisoryFailedJobs: Number(jobs.advisoryFailed ?? 0), pendingReviews: pendingReconciliations + pendingExtractionAudits,
      pendingReconciliations,
      ...ingestion,
      pendingEmbeddings: Number(embeddingJobs.pending ?? 0), failedEmbeddings: Number(embeddingJobs.failed ?? 0),
      progress: { processedMessages: Number(sourceProgress.processed ?? 0), totalMessages: sourceProgress.total,
        processedGroups: Number(groupProgress.processed ?? 0), totalGroups: Number(groupProgress.total ?? 0), failedGroups: Number(groupProgress.failed ?? 0),
        memories: derivedCounts.memories, details: derivedCounts.details,
        pendingRelationshipPairs: derivedCounts.projectionPairs, pendingRelationshipProjectionJobs: Number(downstreamJobs.projectionJobs ?? 0),
        processedTasks: Number(taskProgress.processed ?? 0), totalTasks: Number(taskProgress.total ?? 0), failedTasks: Number(taskProgress.failed ?? 0), activeStage: activePipeline?.stage ?? undefined,
        retryAttempt: Number(activePipeline?.retryAttempt ?? 0) || undefined, retryMax: Number(activePipeline?.retryMax ?? 0) || undefined,
        activeGroupOrdinal: Number(activePipeline?.groupOrdinal ?? 0) || undefined, activeGroupTotal: Number(activePipeline?.groupTotal ?? 0) || undefined,
        ledgerProcessed: Number(ledgerProgress.processed ?? 0), ledgerTotal: Number(ledgerProgress.total ?? 0), ledgerFailed: Number(ledgerProgress.failed ?? 0), downstreamWaiting: ledgerBarrierActive,
        relationshipProcessed: Number(downstreamJobs.projectionProcessed ?? 0), relationshipTotal: Number(downstreamJobs.projectionTotal ?? 0), relationshipFailed: Number(downstreamJobs.projectionFailed ?? 0),
        storyProcessed: Number(downstreamJobs.storyProcessed ?? 0), storyTotal: Number(downstreamJobs.storyTotal ?? 0), storyPending: Number(downstreamJobs.storyJobs ?? 0), storyFailed: Number(downstreamJobs.storyFailed ?? 0),
        llmCalls: Number(callProgress.total ?? 0), repairCalls: Number(callProgress.repairs ?? 0), runComplete: Boolean(latestBackfill?.runId && Number(callProgress.active ?? 0) === 0 && !calibrationPending), acknowledged,
        backfillRunId: latestBackfill?.runId },
      initialCalibration: calibration,
      worker: serverWorker.statusForChat(chatId),
      episode: (episodeOverview(db, chatId) as any).active,
      lineage: getChatLineage(db, chatId),
    });
  });
  app.patch("/v1/chats/:id/relationships", async (context) => {
    const body = await context.req.json() as Record<string, unknown>;
    const from = String(body.from ?? "").trim();
    const to = String(body.to ?? "").trim();
    if (!from || !to) return context.json({ error: "from and to are required" }, 400);
    const chatId = context.req.param("id");
    try {
      const item = setRelationshipProjectionOverride(db, chatId, from, to, body);
      if (flushRelationshipProjectionQueue(db, chatId) > 0) serverWorker.wake();
      return context.json({ ok: true, item });
    }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.get("/v1/chats/:id/world-state", (context) => {
    const chatId = context.req.param("id");
    const atRevision = Number(context.req.query("atRevision"));
    const atOrdinal = Number(context.req.query("atOrdinal"));
    const hasRevision = Number.isInteger(atRevision) && atRevision >= 0;
    const hasOrdinal = Number.isInteger(atOrdinal) && atOrdinal >= 0;
    const clauses = ["chat_id=?"];
    const values: Array<string | number> = [chatId];
    if (hasRevision) {
      clauses.push("valid_from_revision<=?", "(valid_to_revision IS NULL OR valid_to_revision>=?)");
      values.push(atRevision, atRevision);
    } else clauses.push("valid_to_revision IS NULL");
    if (hasOrdinal) {
      clauses.push("(valid_from_ordinal IS NULL OR valid_from_ordinal<=?)", "(valid_to_ordinal IS NULL OR valid_to_ordinal>=?)");
      values.push(atOrdinal, atOrdinal);
    }
    const includeHistory = context.req.query("includeHistory") === "true";
    return context.json({
      at: { revision: hasRevision ? atRevision : null, ordinal: hasOrdinal ? atOrdinal : null },
      assertions: db.prepare(`SELECT * FROM assertions WHERE ${clauses.join(" AND ")}`).all(...values),
      beliefs: db.prepare("SELECT * FROM beliefs WHERE chat_id=? AND active=1").all(chatId),
      promises: db.prepare("SELECT * FROM promises WHERE chat_id=?").all(chatId),
      ...(includeHistory ? {
        endedAssertions: db.prepare("SELECT * FROM assertions WHERE chat_id=? AND valid_to_revision IS NOT NULL ORDER BY COALESCE(valid_to_ordinal,2147483647) DESC,created_at DESC").all(chatId),
        endedBeliefs: db.prepare("SELECT * FROM beliefs WHERE chat_id=? AND active=0 AND (source IS NULL OR source NOT LIKE 'user_deleted:%') ORDER BY COALESCE(valid_to_ordinal,2147483647) DESC,created_at DESC").all(chatId),
        userDeletedBeliefs: db.prepare("SELECT * FROM beliefs WHERE chat_id=? AND active=0 AND source LIKE 'user_deleted:%' ORDER BY created_at DESC").all(chatId),
        promiseHistory: db.prepare("SELECT * FROM promise_events WHERE chat_id=? ORDER BY COALESCE(source_ordinal,2147483647),created_at").all(chatId),
      } : {}),
    });
  });
  app.post("/v1/chats/:id/world-state", async (context) => {
    const chatId = context.req.param("id");
    const body = await context.req.json() as { kind?: string; subject?: string; predicate?: string; holder?: string; promisor?: string; promisee?: string; value?: string; confidence?: number; polarity?: string; status?: string; content?: string; scope?: string; scheduledFor?: string; statusReason?: string; sourceMessageId?: string };
    const kind = body.kind;
    const required = kind === "assertion" ? [body.subject, body.predicate, body.value] : kind === "belief" ? [body.holder, body.subject, body.predicate, body.value] : kind === "promise" ? [body.promisor, body.promisee, body.content] : [];
    if (!kind || required.length === 0 || required.some((value) => !value?.trim())) return context.json({ error: "필수 영문 정본 필드를 입력하세요." }, 400);
    const confidence = Math.max(0, Math.min(1, Number(body.confidence ?? (kind === "belief" ? 0.7 : 1))));
    const source = body.sourceMessageId ? db.prepare("SELECT message_id,ordinal FROM messages WHERE chat_id=? AND message_id=? AND lifecycle IN ('committed','client_pruned') AND host_visibility IN ('active','all_before')").get(chatId, body.sourceMessageId) as { message_id: string; ordinal: number } | undefined : undefined;
    if (body.sourceMessageId && !source) return context.json({ error: "연결할 수 있는 활성 원문을 찾지 못했습니다." }, 400);
    const ordinal = source?.ordinal ?? (db.prepare("SELECT MAX(ordinal) ordinal FROM messages WHERE chat_id=? AND lifecycle IN ('committed','client_pruned')").get(chatId) as { ordinal: number | null }).ordinal;
    const evidence = JSON.stringify(source ? [{ messageId: source.message_id }] : []);
    const chat = db.prepare("SELECT revision FROM chats WHERE id=?").get(chatId) as { revision: number } | undefined;
    if (!chat) return context.json({ error: "Chat not found" }, 404);
    const duplicate = kind === "assertion"
      ? db.prepare("SELECT id FROM assertions WHERE chat_id=? AND subject=? COLLATE NOCASE AND predicate=? COLLATE NOCASE AND valid_to_revision IS NULL").get(chatId, body.subject!.trim(), body.predicate!.trim()) as { id: string } | undefined
      : kind === "belief"
        ? db.prepare("SELECT id FROM beliefs WHERE chat_id=? AND holder=? COLLATE NOCASE AND subject=? COLLATE NOCASE AND predicate=? COLLATE NOCASE AND active=1").get(chatId, body.holder!.trim(), body.subject!.trim(), body.predicate!.trim()) as { id: string } | undefined
        : db.prepare("SELECT id FROM promises WHERE chat_id=? AND promisor=? COLLATE NOCASE AND promisee=? COLLATE NOCASE AND content=? COLLATE NOCASE").get(chatId, body.promisor!.trim(), body.promisee!.trim(), body.content!.trim()) as { id: string } | undefined;
    if (duplicate) return context.json({ error: "같은 활성 장부 항목이 이미 있습니다.", code: "DUPLICATE_LEDGER_ITEM", existingId: duplicate.id }, 409);
    const id = randomUUID();
    const revision = chat.revision + 1;
    db.transaction(() => {
      if (kind === "assertion") db.prepare(`INSERT INTO assertions(id,chat_id,subject,predicate,value,confidence,valid_from_revision,valid_from_ordinal,source_memory_id,evidence_json,retention_class,created_at) VALUES(?,?,?,?,?,?,?,?,NULL,?,'durable',?)`).run(id, chatId, body.subject!.trim(), body.predicate!.trim(), body.value!.trim(), confidence, revision, ordinal, evidence, Date.now());
      else if (kind === "belief") db.prepare(`INSERT INTO beliefs(id,chat_id,holder,subject,predicate,value,polarity,confidence,source,evidence_json,active,status,retention_class,created_revision,valid_from_ordinal,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,'user_overridden','durable',?,?,?)`).run(id, chatId, body.holder!.trim(), body.subject!.trim(), body.predicate!.trim(), body.value!.trim(), body.polarity ?? "believes", confidence, "manual", evidence, revision, ordinal, Date.now());
      else {
        const key = `manual:${randomUUID()}`;
        const status = ["open", "kept", "broken", "released", "offscreen"].includes(body.status ?? "") ? body.status! : "open";
        const scope = ["future", "recurring"].includes(body.scope ?? "") ? body.scope! : "future";
        db.prepare(`INSERT INTO promises(id,chat_id,promise_key,promisor,promisee,content,status,scheduled_for,status_reason,source_memory_id,retention_scope,updated_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?)`).run(id, chatId, key, body.promisor!.trim(), body.promisee!.trim(), body.content!.trim(), status, body.scheduledFor?.trim() || null, body.statusReason?.trim() || null, scope, revision, Date.now());
        db.prepare(`INSERT INTO promise_events(id,chat_id,promise_id,promise_key,promisor,promisee,content,status,scheduled_for,status_reason,source_memory_id,source_ordinal,created_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`).run(randomUUID(), chatId, id, key, body.promisor!.trim(), body.promisee!.trim(), body.content!.trim(), status, body.scheduledFor?.trim() || null, body.statusReason?.trim() || null, ordinal, revision, Date.now());
      }
      db.prepare("UPDATE chats SET revision=?,updated_at=? WHERE id=?").run(revision, Date.now(), chatId);
    })();
    return context.json({ ok: true, id }, 201);
  });
  app.patch("/v1/chats/:id/world-state", async (context) => {
    const body = await context.req.json() as {
      kind?: string; id?: string; subject?: string; predicate?: string; holder?: string; promisor?: string; promisee?: string;
      value?: string; confidence?: number; polarity?: string; status?: string; content?: string; scheduledFor?: string; statusReason?: string;
    };
    const chatId = context.req.param("id");
    if (!body.kind || !body.id) return context.json({ error: "kind and id are required" }, 400);
    for (const key of ["subject", "predicate", "holder", "promisor", "promisee", "value", "content"] as const) {
      if (body[key] !== undefined && !body[key]?.trim()) return context.json({ error: `${key} must not be empty` }, 400);
    }
    if (body.confidence !== undefined && (!Number.isFinite(body.confidence) || body.confidence < 0 || body.confidence > 1)) {
      return context.json({ error: "confidence must be between 0 and 1" }, 400);
    }
    if (body.polarity !== undefined && !["believes", "suspects", "denies", "knows", "heard"].includes(body.polarity)) return context.json({ error: "unsupported polarity" }, 400);
    if (body.status !== undefined && !["open", "kept", "broken", "released", "offscreen", "invalidated"].includes(body.status)) return context.json({ error: "unsupported promise status" }, 400);
    const chat = db.prepare("SELECT revision FROM chats WHERE id=?").get(chatId) as { revision: number } | undefined;
    if (!chat) return context.json({ error: "Chat not found" }, 404);
    const revision = chat.revision + 1;
    let changed = 0;
    let updatedItem: Record<string, unknown> | undefined;
    db.transaction(() => {
      if (body.kind === "assertion") {
        const current = db.prepare("SELECT * FROM assertions WHERE id=? AND chat_id=?").get(body.id, chatId) as Record<string, unknown> | undefined;
        if (!current) return;
        db.prepare("UPDATE assertions SET valid_to_revision=? WHERE id=?").run(revision - 1, body.id);
        const nextId = randomUUID();
        db.prepare(`
          INSERT INTO assertions(id,chat_id,subject,predicate,value,confidence,valid_from_revision,source_memory_id,evidence_json,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)
        `).run(nextId, chatId, body.subject?.trim() ?? current.subject, body.predicate?.trim() ?? current.predicate, body.value?.trim() ?? current.value,
          Math.max(0, Math.min(1, Number(body.confidence ?? current.confidence))), revision, null, "[]", Date.now());
        changed = 1;
        updatedItem = db.prepare("SELECT * FROM assertions WHERE id=?").get(nextId) as Record<string, unknown>;
      } else if (body.kind === "belief") {
        changed = db.prepare(`UPDATE beliefs SET holder=COALESCE(?,holder),subject=COALESCE(?,subject),predicate=COALESCE(?,predicate),value=COALESCE(?,value),confidence=COALESCE(?,confidence),polarity=COALESCE(?,polarity),status='user_overridden',active=1 WHERE id=? AND chat_id=?`).run(
          body.holder?.trim() ?? null, body.subject?.trim() ?? null, body.predicate?.trim() ?? null, body.value?.trim() ?? null,
          body.confidence === undefined ? null : body.confidence, body.polarity ?? null, body.id, chatId,
        ).changes;
        if (changed) updatedItem = db.prepare("SELECT * FROM beliefs WHERE id=? AND chat_id=?").get(body.id, chatId) as Record<string, unknown>;
      } else if (body.kind === "promise") {
        changed = db.prepare(`UPDATE promises SET promisor=COALESCE(?,promisor),promisee=COALESCE(?,promisee),content=COALESCE(?,content),status=COALESCE(?,status),scheduled_for=COALESCE(?,scheduled_for),status_reason=COALESCE(?,status_reason),updated_revision=? WHERE id=? AND chat_id=?`).run(
          body.promisor?.trim() ?? null, body.promisee?.trim() ?? null, body.content?.trim() ?? null, body.status ?? null, body.scheduledFor?.trim() ?? null, body.statusReason?.trim() ?? null, revision, body.id, chatId,
        ).changes;
        if (changed) {
          updatedItem = db.prepare("SELECT * FROM promises WHERE id=? AND chat_id=?").get(body.id, chatId) as Record<string, unknown>;
          const sourceOrdinal = (db.prepare("SELECT MAX(ordinal) AS ordinal FROM messages WHERE chat_id=?").get(chatId) as { ordinal: number | null }).ordinal;
          db.prepare(`INSERT INTO promise_events(id,chat_id,promise_id,promise_key,promisor,promisee,content,status,scheduled_for,status_reason,source_memory_id,source_ordinal,created_revision,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`).run(
            randomUUID(), chatId, body.id, updatedItem.promise_key, updatedItem.promisor, updatedItem.promisee,
            updatedItem.content, updatedItem.status, updatedItem.scheduled_for, updatedItem.status_reason, sourceOrdinal, revision, Date.now(),
          );
        }
      }
      if (changed) db.prepare("UPDATE chats SET revision=?,updated_at=? WHERE id=?").run(revision, Date.now(), chatId);
    })();
    return changed ? context.json({ ok: true, item: updatedItem }) : context.json({ error: "State item not found or unsupported kind" }, 404);
  });
  app.delete("/v1/chats/:id/world-state/:kind/:itemId", (context) => {
    const chatId = context.req.param("id");
    const kind = context.req.param("kind");
    const itemId = context.req.param("itemId");
    if (!["assertion", "belief", "promise"].includes(kind)) return context.json({ error: "unsupported kind" }, 400);
    const chat = db.prepare("SELECT revision FROM chats WHERE id=?").get(chatId) as { revision: number } | undefined;
    if (!chat) return context.json({ error: "Chat not found" }, 404);
    const revision = chat.revision + 1;
    let changed = 0;
    db.transaction(() => {
      if (kind === "assertion") changed = db.prepare("UPDATE assertions SET valid_to_revision=? WHERE id=? AND chat_id=? AND valid_to_revision IS NULL").run(revision - 1, itemId, chatId).changes;
      else if (kind === "belief") {
        const sourceOrdinal = (db.prepare("SELECT MAX(ordinal) AS ordinal FROM messages WHERE chat_id=?").get(chatId) as { ordinal: number | null }).ordinal;
        changed = db.prepare(`UPDATE beliefs SET active=0,valid_to_ordinal=COALESCE(valid_to_ordinal,?),
          source=CASE WHEN source LIKE 'user_deleted:%' THEN source ELSE 'user_deleted:' || COALESCE(source,'') END
          WHERE id=? AND chat_id=? AND active=1`).run(sourceOrdinal, itemId, chatId).changes;
      }
      else changed = db.prepare("DELETE FROM promises WHERE id=? AND chat_id=?").run(itemId, chatId).changes;
      if (changed) db.prepare("UPDATE chats SET revision=?,updated_at=? WHERE id=?").run(revision, Date.now(), chatId);
    })();
    return changed ? context.json({ ok: true }) : context.json({ error: "State item not found" }, 404);
  });
  app.get("/v1/chats/:id/conflicts", (context) => context.json({ items: db.prepare("SELECT * FROM conflicts WHERE chat_id=? AND kind<>'static_projection_changed' ORDER BY created_at DESC").all(context.req.param("id")) }));
  app.get("/v1/chats/:id/jobs", (context) => {
    const chatId = context.req.param("id");
    const ingestion = ingestionSummary(db, chatId);
    return context.json({
      items: db.prepare(`
        SELECT id,type,status,attempts,leased_until,last_error,payload_json,created_at,updated_at FROM jobs
        WHERE chat_id=? AND status<>'archived' ORDER BY created_at DESC,rowid DESC LIMIT 200
      `).all(chatId),
      cancelledMessages: (db.prepare("SELECT count(*) AS count FROM messages WHERE chat_id=? AND extraction_state='cancelled'").get(chatId) as { count: number }).count,
      ...ingestion,
    });
  });
  app.post("/v1/chats/:id/jobs/retry-failed", (context) => {
    const chatId = context.req.param("id");
    const retriedRunIds = (db.prepare(`SELECT DISTINCT json_extract(payload_json,'$.backfillRunId') runId FROM jobs
      WHERE chat_id=? AND status='failed' AND json_extract(payload_json,'$.backfillRunId') IS NOT NULL`).all(chatId) as Array<{ runId: string }>).map((row) => row.runId);
    const result = db.transaction(() => {
      const failed = db.prepare("SELECT id,payload_json FROM jobs WHERE chat_id=? AND status='failed'").all(chatId) as Array<{ id: string; payload_json: string }>;
      const update = db.prepare(`UPDATE jobs SET status='queued',attempts=0,payload_json=?,lease_owner=NULL,leased_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='failed'`);
      let changes = 0;
      for (const job of failed) {
        const payload = JSON.parse(job.payload_json || "{}") as Record<string, unknown>;
        payload.repairBudgetUsed = false;
        payload.pipelineRepairCount = 0;
        changes += update.run(JSON.stringify(payload), Date.now(), job.id).changes;
      }
      return { changes };
    })();
    if (db.prepare("SELECT 1 FROM jobs WHERE chat_id=? AND type='initial_calibration' AND status='queued'").get(chatId)) {
      db.prepare("UPDATE initial_calibrations SET status='queued',last_error=NULL,updated_at=? WHERE chat_id=?").run(Date.now(), chatId);
    }
    for (const runId of retriedRunIds) db.prepare("DELETE FROM server_meta WHERE key=?").run(`backfill_ack:${chatId}:${runId}`);
    if (result.changes > 0) serverWorker.wake();
    return context.json({ ok: true, retried: result.changes });
  });
  app.post("/v1/chats/:id/jobs/:jobId/resplit", (context) => {
    try {
      const result = resplitFailedExtractionJob(db, context.req.param("id"), context.req.param("jobId"));
      if (result.queued > 0) serverWorker.wake();
      return context.json({ ok: true, ...result });
    } catch (error) {
      const code = (error as { code?: string }).code;
      return context.json({ error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) }, code === "ATOMIC_TURN_TOO_LARGE" ? 409 : 400);
    }
  });
  app.delete("/v1/chats/:id/jobs/completed", (context) => {
    const result = db.prepare(`
      UPDATE jobs SET status='archived',lease_owner=NULL,leased_until=NULL,updated_at=?
      WHERE chat_id=? AND status IN ('done','completed','cancelled','superseded')
    `).run(Date.now(), context.req.param("id"));
    return context.json({ ok: true, archivedJobs: result.changes });
  });
  app.delete("/v1/chats/:id/jobs", (context) => context.json({ ok: true, ...cancelExtractionJobs(db, context.req.param("id")) }));
  app.post("/v1/chats/:id/jobs/requeue-cancelled", (context) => context.json({
    ok: true, restoredMessages: requeueCancelledMessages(db, context.req.param("id")),
  }));
  app.get("/v1/chats/:id/recall-logs", (context) => context.json({ items: db.prepare(`
    SELECT id,query,perspective,selected_json,elapsed_ms,created_at FROM recall_logs
    WHERE chat_id=? ORDER BY created_at DESC LIMIT 200
  `).all(context.req.param("id")) }));
  app.post("/v1/chats/:id/source-sync", async (context) => {
    const body = TurnPrepareRequestSchema.parse(await context.req.json());
    if (body.chatId !== context.req.param("id")) return context.json({ error: "chatId does not match route" }, 400);
    const stats = syncSnapshot(db, { ...body, deferExtraction: true, tokenBudget: 0, forceBackfill: false });
    return context.json({ ok: true, stats });
  });
  app.patch("/v1/chats/:id/conflicts/:conflictId", async (context) => {
    const body = await context.req.json() as { resolution?: ConflictResolution };
    if (!body.resolution || !["accept_incoming", "keep_existing", "acknowledged"].includes(body.resolution)) {
      return context.json({ error: "unsupported conflict resolution" }, 400);
    }
    return context.json({ ok: true, ...resolveConflict(db, context.req.param("id"), context.req.param("conflictId"), body.resolution) });
  });
  app.delete("/v1/chats/:id/conflicts/:conflictId", (context) => {
    const result = db.prepare("DELETE FROM conflicts WHERE id=? AND chat_id=? AND status='resolved'").run(context.req.param("conflictId"), context.req.param("id"));
    return result.changes === 1 ? context.json({ ok: true }) : context.json({ error: "Resolved conflict not found" }, 404);
  });

  app.post("/v1/export", async (context) => {
    const body = await context.req.json() as { pluginSettings?: unknown; serverUrl?: string; serverToken?: string; chatId?:string; chatSettings?:any };
    const wasPaused = serverWorker.status.state === "paused";
    serverWorker.pause("Creating a consistent backup");
    try {
      const archive = body.chatId ? exportChatArchive(db,body.chatId,body.chatSettings) : exportCompleteArchive(db, {
        pluginSettings: body.pluginSettings,
        serverUrl: typeof body.serverUrl === "string" ? body.serverUrl : undefined,
        serverToken: config.token,
        serverSettings:backupServerSettings(config),
        secrets: existsSync(config.secretsPath) ? readFileSync(config.secretsPath, "utf8") : "",
        voyageApiKey: config.voyageApiKey || undefined,
        llmApiKeys: llmStore.backupApiKeys(),
      });
      context.header("Content-Type", "application/zip");
      context.header("Content-Disposition", `attachment; filename="rcm-${body.chatId ? "chat" : "complete"}-backup-${Date.now()}.zip"`);
      return context.body(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer);
    } finally {
      if (!wasPaused) serverWorker.resume("backup-export");
    }
  });
  app.post("/v1/import/inspect", async (context) => {
    const inspection = inspectCompleteArchive(new Uint8Array(await context.req.arrayBuffer()));
    return context.json(inspection);
  });
  app.post("/v1/import/restore", async (context) => {
    if (serverWorker.status.activeCalls > 0) return context.json({error:"보조 모델 처리가 끝난 뒤 복원해주세요."},409);
    const wasPaused = serverWorker.status.state === "paused";
    serverWorker.pause("Restoring a complete backup");
    const previousArchive = exportCompleteArchive(db);
    const previousSecrets = existsSync(config.secretsPath) ? readFileSync(config.secretsPath, "utf8") : undefined;
    try {
      const archive = new Uint8Array(await context.req.arrayBuffer());
      const staged = openDatabase(":memory:").db;
      try {
        restoreCompleteArchive(staged, archive);
        const integrity = staged.pragma("integrity_check") as Array<{ integrity_check?: string }>;
        const foreignKeyErrors = staged.pragma("foreign_key_check") as unknown[];
        if (integrity.some((row) => row.integrity_check !== "ok") || foreignKeyErrors.length > 0) {
          throw new Error("Backup failed staged SQLite integrity validation");
        }
      } finally {
        staged.close();
      }
      const result = restoreCompleteArchive(db, archive);
      const liveIntegrity = db.pragma("integrity_check") as Array<{ integrity_check?: string }>;
      const liveForeignKeyErrors = db.pragma("foreign_key_check") as unknown[];
      if (liveIntegrity.some((row) => row.integrity_check !== "ok") || liveForeignKeyErrors.length > 0) {
        throw new Error("Restored SQLite database failed integrity validation");
      }
      if (typeof result.privateData.secrets === "string") writeFileSync(config.secretsPath, result.privateData.secrets, "utf8");
      if (typeof result.privateData.serverToken === "string") saveSecret(config.secretsPath,"RCM_TOKEN",config.token);
      for (const [name,value] of Object.entries(result.privateData.serverSettings??{})) {
        if (!Object.hasOwn(backupServerSettings(config),name) || typeof value!=="string" || /[\r\n]/u.test(value)) throw new Error("Invalid backed up server preference");
        saveSecret(config.secretsPath,name as `RCM_${string}`,value);
      }
      if (typeof result.privateData.voyageApiKey === "string") saveVoyageKey(config.secretsPath, result.privateData.voyageApiKey);
      for (const [provider, key] of Object.entries(result.privateData.llmApiKeys ?? {})) {
        if (typeof key === "string") saveSecret(config.secretsPath, `RCM_LLM_API_KEY_${provider.toUpperCase()}`, key);
      }
      return context.json({ ok: true, manifest: result.inspection.manifest, connection: result.inspection.privateData, pluginSettings: result.privateData.pluginSettings,
        vectorsRestored: result.vectorsRestored, restartRequired: true });
    } catch (error) {
      restoreCompleteArchive(db, previousArchive);
      if (previousSecrets !== undefined) writeFileSync(config.secretsPath, previousSecrets, "utf8");
      else if (existsSync(config.secretsPath)) unlinkSync(config.secretsPath);
      if (!wasPaused) serverWorker.resume("backup-restore-rollback");
      throw error;
    }
  });
  app.post("/v1/import/chat",async(context)=>{
    if (serverWorker.status.activeCalls > 0) return context.json({error:"보조 모델 처리가 끝난 뒤 복원해주세요."},409);
    const wasPaused=serverWorker.status.state==="paused";
    serverWorker.pause("Restoring one chat backup");
    try {
      const result=restoreChatArchive(db,new Uint8Array(await context.req.arrayBuffer()));
      return context.json({ok:true,...result,serverInstanceId:serverInstanceId});
    } finally {if(!wasPaused)serverWorker.resume("chat-backup-restore");}
  });
  app.post("/v1/import/transplant", async (context) => {
    if (serverWorker.status.activeCalls > 0) return context.json({error:"보조 모델 처리가 끝난 뒤 복원해주세요."},409);
    const sourceChatId = context.req.query("sourceChatId") ?? "";
    const targetChatId = context.req.query("targetChatId") ?? "";
    if (!sourceChatId || !targetChatId) return context.json({ error: "sourceChatId and targetChatId are required" }, 400);
    const wasPaused = serverWorker.status.state === "paused";
    serverWorker.pause("Transplanting memory into the current chat");
    try {
      const result = transplantCompleteArchive(db, new Uint8Array(await context.req.arrayBuffer()), sourceChatId, targetChatId);
      void embeddings.indexPending(targetChatId);
      return context.json({ ok: true, chatId: targetChatId, ...result });
    } finally {
      if (!wasPaused) serverWorker.resume("backup-transplant");
    }
  });

  app.onError((error, context) => {
    const code = typeof (error as any)?.code === "string" ? (error as any).code : "REQUEST_FAILED";
    const summary = error instanceof ExtractionValidationError
      ? error.summary
      : code === "LEASE_NOT_FOUND" ? "처리 작업의 임대가 만료되었습니다."
          : "요청을 처리하지 못했습니다.";
    console.error(`[RCM] Request failed code=${code}`);
    const status = code === "LEASE_NOT_FOUND" ? 409 : 400;
    return context.json({
      error: error instanceof Error ? error.message : String(error), code, summary,
      ...(error instanceof ExtractionValidationError ? { issues: error.issues } : {}),
    }, status);
  });
  return app;
}
