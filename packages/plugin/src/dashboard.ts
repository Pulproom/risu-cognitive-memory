declare const __RCM_DISTRIBUTION__: boolean;
import { RCM_API_REVISION, RCM_PLUGIN_VERSION, compareNumericVersions, compareStoryTimes, estimateTokens, joinDialogueSpans, validateCanonicalRemovalRule, type CanonicalRemovalRule, type ChatLineageStatus, type LineageProbeRequest, type LineageProbeResponse, type ManualLineagePreview, type MemoryLanguage, type RpProfile, type ServerLlmPublicConfig, type ServerWorkerStatus, type TurnPrepareRequest } from "@rcm/shared";
import { SERVER_STATUS_TIMEOUT_MS, type ServerClient } from "./api-client.js";
import { makePrepareRequest, readCurrentContext, readOptionalCurrentContext } from "./context.js";
import { addLog, isChatMemoryEnabled, saveSettings, serverScopeKey, CACHE_KEY, loadStoredJson, saveStoredJson } from "./settings.js";
import type { ActivityProgress, InitialCalibrationActivity, PluginSettings, RuntimeState } from "./types.js";
import { drainWorker, reconcileAutomaticServerPause } from "./worker.js";
import { MEMORY_ICON, updateWorkerMenuButton } from "./attention.js";
import { createOrganizationView, memoryOrganization, toggleOrganizationRange, type OrganizationData } from './memory-organization.js';
import { subscribeActivity } from "./activity.js";
import { clearTranslationCache, invalidateTranslationCache, readCachedTranslations, translateRecords, translationCacheStats, type TranslationCacheStats } from "./translation.js";
import { inheritLineageSettings } from "./lineage-settings.js";
import {exportChatSettings,restoreChatSettings} from "./backup-settings.js";
import { describeServerConnectionIssue, isServerConfigured, noteServerConnectionFailure, noteServerConnectionSuccess, SERVER_RESPONSE_DELAYED, type ServerConnectionIssue } from "./connection.js";
import { installServerUpdate, pluginUpdateNeeded, refreshUpdateStatus } from "./updates.js";

export type Tab = "overview" | "initial" | "story" | "timeline" | "relationships" | "world" | "reviews" | "conflicts" | "operations" | "data" | "settings";

export function mergeCompleteBackupSettings(current: PluginSettings, restored: unknown): PluginSettings {
  if (!restored || typeof restored !== "object" || (restored as { settingsRevision?: unknown }).settingsRevision !== 20) return current;
  return { ...(restored as PluginSettings), serverUrl: current.serverUrl, serverToken: current.serverToken };
}

/** PocketRisu may transfer request buffers across a window boundary and detach them. */
export function backupRequestBody(bytes: ArrayBuffer): ArrayBuffer {
  return bytes.slice(0);
}
type NavGroupId = "home" | "memory" | "people" | "world" | "manage";
type NavItem = { tab: Tab; label: string };
type NavGroup = { id: NavGroupId; label: string; icon: string; defaultTab: Tab; items: NavItem[] };
type ActionState = { kind: "success" | "error"; message: string };
type AttentionFilter = "all" | "duplicate" | "conflict" | "audit";
type AttentionViewState = { selectedId: string; query: string; filter: AttentionFilter; mobileDetail: boolean };
type WorldEditor = { kind: "assertion" | "belief" | "promise"; id?: string; mode: "create" | "edit" | "delete" };
type WorldKind = "assertions" | "beliefs" | "promises";
type WorldViewState = {
  selectedId: string;
  query: string;
  filter: "current" | "history" | "all" | "open" | "completed";
  holder: string;
  mobileDetail: boolean;
};
type IntimacyEditor = { id?: string; participantA?: string; participantB?: string };
type SocialEditor = { holder: string; subject: string; level: string; knownAs: string; editing: boolean };
type PeopleViewState = {
  selectedId: string;
  query: string;
  prominence: "all" | "primary" | "supporting" | "reference";
  editing: boolean;
  mobileDetail: boolean;
  management: "" | "merge";
};
export type TimelineDetailMode = "translation" | "canonical" | "compare";
export type TimelineViewState = {
  query: string;
  landmarkOnly: boolean;
  pinnedOnly: boolean;
  includeInactive: boolean;
  detailMode: TimelineDetailMode;
  editing: boolean;
  creating: boolean;
  mobileDetail: boolean;
  sortOrder?: "ascending" | "descending";
};
export type StoryViewState = {
  selectedGroupId: string;
  query: string;
  indexOpen: boolean;
  detailMode: TimelineDetailMode;
  expandedMemoryId: string;
  editingOverview?: boolean;
  overviewDraft?: string;
};

type StoryOverviewBackup = RuntimeState["settings"]["storyOverviewBackups"][string];
export type HostChatInventoryItem = { characterId: string; characterName: string; chatId: string; chatTitle: string; messageCount: number };
type DataConfirmation = { action: "rebuild" | "delete"; chatId: string; acknowledged?: boolean };
type ServerInspector = {
  chatId: string;
  loading?: boolean;
  error?: string;
  memories: any[];
  storySpine: any;
  relationships: any[];
  assertions: any[];
  beliefs: any[];
  promises: any[];
  endedAssertions: any[];
  endedBeliefs: any[];
  userDeletedBeliefs: any[];
  promiseHistory: any[];
  reconciliationReviews: any[];
  conflicts: any[];
  ledger?: { items: any[]; total: number; offset: number; limit: number; includesContent: boolean };
};
type DataViewState = {
  inventoryStatus: "idle" | "loading" | "ready" | "unavailable";
  inventory: HostChatInventoryItem[];
  query: string;
  filter: "all" | "current" | "other";
  confirmation?: DataConfirmation;
  inspector?: ServerInspector;
  inheritanceOpen: boolean;
  inheritanceQuery: string;
  inheritanceSourceId?: string;
  inheritancePreview?: ManualLineagePreview;
  inheritanceReplacementAcknowledged?: boolean;
  inheritanceError?: string;
  backupExportPhase?: "creating" | "downloading";
  backupExportChatId?: string;
  backupExportError?: string;
};

export function koreanTranslationEnabled(autoTranslate: boolean, display: RuntimeState["settings"]["translationDisplay"], canonicalLanguage: MemoryLanguage): boolean {
  return canonicalLanguage !== "ko" && autoTranslate && display !== "en";
}

export function resolveTranslationPreference(canonicalLanguage: MemoryLanguage, previous: boolean, checked: boolean): boolean {
  return canonicalLanguage === "ko" ? previous : checked;
}

export function filterTimelineMemories(memories: any[], view: Pick<TimelineViewState, "landmarkOnly" | "pinnedOnly" | "includeInactive">): any[] {
  return memories.filter((memory) => (view.includeInactive || memory.active !== false)
    && (!view.landmarkOnly || Boolean(memory.landmark))
    && (!view.pinnedOnly || Boolean(memory.pinned))).sort((left, right) => {
      const compared = compareStoryTimes(left.story_time ?? left.storyTime, right.story_time ?? right.storyTime);
      if (compared !== null && compared !== 0) return compared;
      const leftHasTime = Boolean(String(left.story_time ?? left.storyTime ?? "").trim());
      const rightHasTime = Boolean(String(right.story_time ?? right.storyTime ?? "").trim());
      if (leftHasTime !== rightHasTime) return leftHasTime ? -1 : 1;
      return Number(left.created_revision ?? left.created_at ?? 0) - Number(right.created_revision ?? right.created_at ?? 0);
    });
}

export function dashboardThemeFromColor(value: string, prefersDark: boolean): "dark" | "light" {
  const normalized = value.trim().toLowerCase();
  const hex = normalized.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  const channels = hex
    ? (hex.length === 3 ? [...hex].map((part) => parseInt(part + part, 16)) : [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)))
    : normalized.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/)?.slice(1, 4).map(Number);
  if (!channels || channels.length < 3 || channels.some((channel) => !Number.isFinite(channel))) return prefersDark ? "dark" : "light";
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const unit = channel / 255;
    return unit <= .03928 ? unit / 12.92 : ((unit + .055) / 1.055) ** 2.4;
  });
  return .2126 * red + .7152 * green + .0722 * blue < .32 ? "dark" : "light";
}

export interface DashboardData {
  chatId?: string;
  health?: {
    ok: boolean;
    version: string;
    apiRevision: number;
    instanceId: string;
    vectorEnabled: boolean;
    embeddingReady: boolean;
    embedding?: { configured: boolean; ready: boolean; model: string; dimension: number; pendingBlocks: number; failedBlocks: number; lastError?: string };
    serverLlm?: ServerLlmPublicConfig;
    serverWorker?: ServerWorkerStatus;
    capabilities?: { recallPortfolioV2?: boolean; mcpAtomDelta?: boolean; memoryToolReadiness?: boolean; initialCalibration?: boolean; initialRelationshipProjection?: boolean; relationshipProjectionCursor?: boolean; offscreenPromises?: boolean; extractionAudit?: boolean; atomAccess?: boolean; beliefLifecycle?: boolean; reconciliationReview?: boolean; perspectiveResolution?: boolean; ingestionState?: boolean; qualitativeRelationships?: boolean; memoryDetails?: boolean; intimacyMilestones?: boolean; npcProminence?: boolean; adaptiveExtraction?: boolean; multilingualCanonicalMemory?: boolean; extractionGrouping?: boolean; promptCoverageSuppression?: boolean; durableLedger?: boolean; chatLineage?: boolean; manualLineageTransfer?: boolean; sourceLedgerInspection?: boolean; dashboardLineageProbe?: boolean; readOnlyLineageProbe?: boolean; recallCoverage?: boolean; socialKnowledge?: boolean; lineageAcknowledgement?: boolean; packetContractV2?: boolean; physicalIntimacy?: boolean; typedLandmarks?: boolean; resolvedRelationshipBaseline?: boolean; manualLedgerEditing?: boolean; memoryToolControl?: boolean; shortMemoryRefs?: boolean; multiGenerationLineage?: boolean; injectionManifest?: boolean; ledgerHistory?: boolean; typedSexMilestones?: boolean; deepRecall?: boolean; aspectProvenance?: boolean; creativeUnknownStates?: boolean; retrievalPlannerV2?: boolean; extractionBatches?: boolean; episodeRegeneration?: boolean; canonicalSuffixRegeneration?: boolean; storySpine?: boolean; storySpineV2?: boolean; memoryBudgetPresets?: boolean; holderMemoryTraces?: boolean; canonicalSourceNormalization?: boolean; editProtection?: boolean; cognitiveActivation?: boolean; serverServiceTier?: boolean; chatOperationLifecycleV2?: boolean; turnLineageDiscovery?: boolean; ledgerConsistencyBarrier?: boolean; canonicalLedgerIdentity?: boolean; providerJsonMode?: boolean; stateReconciliationV3?: boolean; pipelineRetryStatus?: boolean; repairDiagnosticsV2?: boolean; operationRunAccounting?: boolean; persistentBackfillResult?: boolean; retrievalDiagnostics?: boolean };
  };
  memories: any[];
  storySpine: any;
  messages: any[];
  relationships: any[];
  relationshipEvents: any[];
  physicalIntimacy: any[];
  entities: any[];
  socialKnowledge: any[];
  socialKnowledgeJobs: Record<string, number>;
  assertions: any[];
  beliefs: any[];
  promises: any[];
  endedAssertions: any[];
  endedBeliefs: any[];
  userDeletedBeliefs: any[];
  promiseHistory: any[];
  conflicts: any[];
  reconciliationReviews: any[];
  extractionAudits: any[];
  jobs: any[];
  cancelledMessages: number;
  waitingForAssistant: number;
  bufferedMessages: number;
  bufferedTurns: number;
  bufferedSourceTokens: number;
  extractionGroupTurns: number;
  recoverableMessages: number;
  historicalBackfillMessages: number;
  ingestionState?: "historical_pending" | "managed" | "cleared";
  recallLogs: any[];
  adminChats: any[];
  lineage?: ChatLineageStatus;
  initialCalibration?: any;
  coldStartProgress?: ActivityProgress;
  jobsError?: string;
  adminError?: string;
  contextError?: string;
  error?: string;
  connectionIssue?: ServerConnectionIssue;
}

const emptyData = (): DashboardData => ({
  memories: [], storySpine: { overview: null, currentProgress: [], arcs: [] }, messages: [], relationships: [], relationshipEvents: [], physicalIntimacy: [], entities: [], socialKnowledge: [], socialKnowledgeJobs: {}, assertions: [], beliefs: [], promises: [], endedAssertions: [], endedBeliefs: [], userDeletedBeliefs: [], promiseHistory: [], conflicts: [], reconciliationReviews: [], extractionAudits: [], jobs: [], cancelledMessages: 0, waitingForAssistant: 0, bufferedMessages: 0, bufferedTurns: 0, bufferedSourceTokens: 0, extractionGroupTurns: 6, recoverableMessages: 0, historicalBackfillMessages: 0, recallLogs: [], adminChats: [], initialCalibration: { status: "unseeded", entities: [], relationships: [], locked: false, confirmationRequired: false },
});

type DashboardChatDataset = "memories" | "messages" | "relationships" | "world" | "conflicts" | "jobs" | "recallLogs" | "entities" | "reviews" | "lineage" | "socialKnowledge" | "physicalIntimacy" | "status" | "audits" | "initialCalibration" | "storySpine";

const ALL_DASHBOARD_DATASETS: DashboardChatDataset[] = [
  "memories", "messages", "relationships", "world", "conflicts", "jobs", "recallLogs", "entities",
  "reviews", "lineage", "socialKnowledge", "physicalIntimacy", "status", "audits", "initialCalibration", "storySpine",
];

export function dashboardDatasetsForTab(tab: Tab): DashboardChatDataset[] {
  const byTab: Record<Tab, DashboardChatDataset[]> = {
    overview: ["memories", "relationships", "world", "conflicts", "jobs", "lineage", "status", "initialCalibration"],
    initial: ["entities", "initialCalibration", "status"],
    story: ["memories", "storySpine", "status"],
    timeline: ["memories", "messages", "status"],
    relationships: ["relationships", "entities", "socialKnowledge", "physicalIntimacy", "initialCalibration", "status"],
    world: ["world", "messages", "status"],
    reviews: ["conflicts", "reviews", "audits", "status"],
    conflicts: ["conflicts", "status"],
    operations: ["jobs", "status"],
    data: ["status"],
    settings: ["status"],
  };
  return [...byTab[tab]];
}

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export const dashboardNavigation = (reviewPending = false): NavGroup[] => [
  { id: "home", label: "홈", icon: "overview", defaultTab: "overview", items: [] },
  { id: "memory", label: "기억", icon: "timeline", defaultTab: "timeline", items: [
    { tab: "timeline", label: "타임라인" }, { tab: "story", label: "줄거리" },
  ] },
  { id: "people", label: "인물", icon: "relationships", defaultTab: "initial", items: [
    { tab: "initial", label: "인물 목록" }, { tab: "relationships", label: "관계" },
  ] },
  { id: "world", label: "세계", icon: "world", defaultTab: "world", items: [] },
  { id: "manage", label: "관리", icon: "operations", defaultTab: "reviews", items: [
    { tab: "reviews", label: `상태 확인${reviewPending ? " · !" : ""}` },
    { tab: "operations", label: "처리 상태" },
    { tab: "data", label: "데이터" }, { tab: "settings", label: "설정" },
  ] },
];

export function dashboardNavGroup(tab: Tab): NavGroupId {
  return dashboardNavigation().find((group) => group.defaultTab === tab || group.items.some((item) => item.tab === tab))?.id ?? "home";
}

export function dashboardSecondaryNavigation(group: NavGroup, activeTab: Tab): string {
  return group.items.map((item) => `<button data-action="tab" data-tab="${item.tab}" aria-current="${activeTab === item.tab ? "page" : "false"}"><span>${item.label}</span></button>`).join("");
}

export function dashboardChatContext(current?: Pick<NonNullable<RuntimeState["current"]>, "characterName" | "chatTitle">): { character: string; chat: string } {
  return { character: current?.characterName || "활성 채팅 없음", chat: current?.chatTitle || "" };
}

export function dashboardTopbarWorkState(
  activity: string,
  connectionIssue?: ServerConnectionIssue,
): { kind: "warn" | "error"; text: string } | undefined {
  if (connectionIssue) return {
    kind: connectionIssue.kind === "unconfigured" ? "warn" : "error",
    text: connectionIssue.kind === "unconfigured" ? "서버 연결 필요" : "연결 확인 필요",
  };
  return activity ? { kind: "warn", text: activity } : undefined;
}

export function dashboardChatProfileControl(profile: RpProfile, disabled = false): string {
  return `<label class="field chat-profile-setting"><span>채팅 유형</span><select data-action="set-profile-select" ${disabled ? "disabled" : ""}><option value="companion" ${profile === "companion" ? "selected" : ""}>Companion</option><option value="simulation" ${profile === "simulation" ? "selected" : ""}>World Simulation</option></select><small class="muted">유형을 바꾸면 필요한 과거 기록 처리 여부를 먼저 확인합니다.</small></label>`;
}

export type ExtractionReviewChoice = boolean | undefined;

/** Choose whether a Companion → Simulation transition also reprocesses past records. */
export async function chooseSimulationBackfill(
  estimatedTokens: number,
): Promise<boolean | undefined> {
  if (typeof document === "undefined" || typeof window === "undefined") return undefined;
  const dialog = document.createElement("dialog");
  dialog.className = "review-choice-dialog";
  dialog.setAttribute("aria-labelledby", "simulation-backfill-title");
  dialog.innerHTML = `<div class="review-choice-dialog__body"><h2 id="simulation-backfill-title">World Simulation으로 변경</h2><p>유형만 바꾸거나, 과거 기록을 다시 추출해 World Simulation 기억까지 준비할 수 있습니다.</p><fieldset class="review-choice-options"><legend>과거 기록 처리</legend><label><input type="radio" name="simulation-backfill" value="type-only" checked><span><strong>유형만 변경</strong><small>앞으로의 대화부터 World Simulation 방식으로 처리합니다.</small></span></label><label><input type="radio" name="simulation-backfill" value="backfill"><span><strong>과거 기록 다시 추출</strong><small>과거 원문 약 ${escapeHtml(estimatedTokens.toLocaleString())} 입력 토큰을 처리합니다. 호출량과 비용이 늘어날 수 있습니다.</small></span></label></fieldset><div class="actions"><button class="btn btn--primary" type="button" value="apply">변경</button><button class="btn" type="button" value="cancel">취소</button></div></div>`;
  document.body.append(dialog);
  try {
    return await new Promise<boolean | undefined>((resolve) => {
      let settled = false;
      const settle = (choice: boolean | undefined) => {
        if (settled) return;
        settled = true;
        resolve(choice);
      };
      dialog.addEventListener("click", (event) => {
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[value]");
        if (!button) return;
        if (button.value === "apply") {
          const checked = dialog.querySelector<HTMLInputElement>('input[name="simulation-backfill"]:checked');
          dialog.close(checked?.value ?? "type-only");
          return;
        }
        dialog.returnValue = "cancel";
        dialog.close();
      });
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        dialog.returnValue = "cancel";
        dialog.close();
      });
      dialog.addEventListener("close", () => settle(dialog.returnValue === "backfill" ? true : dialog.returnValue === "type-only" ? false : undefined), { once: true });
      dialog.showModal();
    });
  } finally {
    dialog.remove();
  }
}

export function withExtractionReviewOverride<T extends Record<string, unknown>>(
  payload: T,
  extractionReviewOverride: boolean,
): T & { extractionReviewOverride: boolean } {
  return { ...payload, extractionReviewOverride };
}

export async function syncCompleteSourceLedger(
  client: Pick<ServerClient, "request">,
  context: NonNullable<RuntimeState["current"]>,
): Promise<{ expectedSourceMessages: number; serverInstanceId: string }> {
  if (context.snapshotScope !== "full" || context.snapshot.length !== context.sourceMessageCount) {
    throw new Error(`전체 원문을 불러오지 못했습니다 (${context.snapshot.length}/${context.sourceMessageCount}). 다시 시도해 주세요.`);
  }
  await client.request(`/v1/chats/${encodeURIComponent(context.chatId)}/source-sync`, {
    method: "POST",
    body: JSON.stringify(makePrepareRequest(context, 0, { deferExtraction: true })),
  }, 120_000);
  return { expectedSourceMessages: context.sourceMessageCount, serverInstanceId: "" };
}

/** Start a browser download and retain the object URL until Chromium consumes it. */
export function triggerBackupDownload(
  blob: Blob,
  filename: string,
  documentRef: Pick<Document, "createElement" | "body"> = document,
  urlApi: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
  scheduleCleanup: (callback: () => void) => unknown = (callback) => setTimeout(callback, 10_000),
): void {
  const url = urlApi.createObjectURL(blob);
  const anchor = documentRef.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  documentRef.body.append(anchor);
  anchor.click();
  scheduleCleanup(() => {
    anchor.remove();
    urlApi.revokeObjectURL(url);
  });
}

/** Shared themed messages; native dialog supplies focus trapping and Escape. */
export async function confirmDashboard(message: string, notice = false, labels: { confirm?: string; cancel?: string; title?: string } = {}): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "review-choice-dialog";
  dialog.setAttribute("aria-labelledby", "rcm-message-title");
  dialog.innerHTML = `<div class="review-choice-dialog__body"><h2 id="rcm-message-title">${escapeHtml(labels.title ?? (notice ? "RCM 안내" : "작업 확인"))}</h2><p style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(message)}</p><div class="actions"><button type="button" class="btn btn--primary" value="confirm" ${notice ? "autofocus" : ""}>${escapeHtml(labels.confirm ?? "확인")}</button>${notice ? "" : `<button type="button" class="btn" value="cancel" autofocus>${escapeHtml(labels.cancel ?? "취소")}</button>`}</div></div>`;
  document.body.append(dialog);
  try {
    return await new Promise<boolean>((resolve) => {
      // PocketRisu's plugin iframe can disallow form submission, including
      // method="dialog". Close explicitly so pointer and keyboard activation work.
      dialog.addEventListener("click", (event) => {
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[value]");
        if (button) dialog.close(button.value);
      });
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
      dialog.showModal();
    });
  } finally { dialog.remove(); }
}

async function alertDashboard(message: string): Promise<void> {
  await confirmDashboard(message, true);
}

export type ChatBackupImportChoice = "original" | "current" | undefined;

/** Choose the only meaningful destinations for a single-chat backup. */
export async function chooseChatBackupImport(canTransplant: boolean): Promise<ChatBackupImportChoice> {
  const dialog = document.createElement("dialog");
  dialog.className = "review-choice-dialog";
  dialog.setAttribute("aria-labelledby", "rcm-chat-backup-title");
  dialog.innerHTML = `<div class="review-choice-dialog__body"><h2 id="rcm-chat-backup-title">채팅 백업 불러오기</h2><p>이 백업을 어디에 복원할까요?</p><div class="actions"><button type="button" class="btn btn--primary" value="original">원래 채팅에 복원</button>${canTransplant ? '<button type="button" class="btn" value="current">현재 채팅으로 기억 이식</button>' : ""}<button type="button" class="btn" value="cancel" autofocus>취소</button></div></div>`;
  document.body.append(dialog);
  try {
    return await new Promise<ChatBackupImportChoice>((resolve) => {
      dialog.addEventListener("click", (event) => {
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[value]");
        if (button) dialog.close(button.value);
      });
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "original" || dialog.returnValue === "current" ? dialog.returnValue : undefined), { once: true });
      dialog.showModal();
    });
  } finally { dialog.remove(); }
}

const RELEASE_NOTES_ACK_KEY = "rcm.product-release-notes.v2";

export function releaseNotesAcknowledged(value: unknown, version: string): boolean {
  return !!value && typeof value === "object" && (value as { version?: unknown }).version === version;
}

export function releaseNotesForVersion(version: string): string | undefined {
  const releases: Record<string, string[]> = {
    "1.0.0": ["Risu Cognitive Memory의 첫 정식 릴리스입니다."],
  };
  return releases[version]?.map((line) => `• ${line}`).join("\n");
}

export function formatReleaseNotes(value: string): string {
  return value.replaceAll("\r", "").split("\n").map((line) => line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*[-*]\s+/, "• ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1"))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function completedProductReleaseNotice(
  status: RuntimeState["updateStatus"],
  currentPluginVersion = RCM_PLUGIN_VERSION,
): { version: string; message: string } | undefined {
  if (!status?.configured || status.error || status.available || status.restartRequired || pluginUpdateNeeded(status, currentPluginVersion)) return undefined;
  const version = status.latestVersion;
  if (!version || compareNumericVersions(version, currentPluginVersion) < 0) return undefined;
  const notes = formatReleaseNotes(status.latestReleaseNotes ?? "")
    || releaseNotesForVersion(version)
    || `RCM ${version} 업데이트가 완료되었습니다.`;
  const message = status.notesUrl ? `${notes}\n\n자세한 내용: ${status.notesUrl}` : notes;
  return { version, message };
}

async function showCompletedProductReleaseNotice(state: RuntimeState): Promise<void> {
  const notice = completedProductReleaseNotice(state.updateStatus);
  if (!notice) return;
  const acknowledgement = await loadStoredJson<{ version?: string }>(RELEASE_NOTES_ACK_KEY);
  if (releaseNotesAcknowledged(acknowledgement, notice.version)) return;
  const acknowledged = await confirmDashboard(notice.message, true, { title: `RCM ${notice.version} 업데이트`, confirm: "확인" });
  if (acknowledged) await saveStoredJson(RELEASE_NOTES_ACK_KEY, { version: notice.version });
}

/** Ask once for an expensive bulk operation without changing the saved default. */
export async function chooseExtractionReviewOverride(
  title: string,
  detail: string,
  defaultEnabled: boolean,
): Promise<ExtractionReviewChoice> {
  const defaultText = defaultEnabled ? "켜짐" : "꺼짐";
  if (typeof document === "undefined" || typeof window === "undefined") return undefined;
  const dialog = document.createElement("dialog");
  dialog.className = "review-choice-dialog";
  dialog.setAttribute("aria-labelledby", "review-choice-title");
  dialog.innerHTML = `<div class="review-choice-dialog__body"><h2 id="review-choice-title">${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p><fieldset class="review-choice-options"><legend>추출 방식</legend><label><input type="radio" name="review-mode" value="basic" ${defaultEnabled ? "" : "checked"}><span><strong>기본 추출</strong><small>한 번의 추출 결과를 바로 상태 대조에 사용합니다.</small></span></label><label><input type="radio" name="review-mode" value="review" ${defaultEnabled ? "checked" : ""}><span><strong>재검수 추가</strong><small>Gemini 3.7 Flash급 이상의 모델에서는 보통 필요하지 않습니다. 기억 묶음마다 호출이 1회 추가되며 추가 보완이나 재시도 시 더 늘 수 있습니다.</small></span></label></fieldset><p class="muted">이 선택은 이번 작업에만 적용되며 설정의 전역 기본값(${defaultText})은 바뀌지 않습니다.</p><div class="actions"><button class="btn btn--primary" type="button" value="start">시작</button><button class="btn" type="button" value="cancel">취소</button></div></div>`;
  document.body.append(dialog);
  try {
    return await new Promise<ExtractionReviewChoice>((resolve) => {
      let settled = false;
      const settle = (choice: ExtractionReviewChoice) => {
        if (settled) return;
        settled = true;
        resolve(choice);
      };
      dialog.addEventListener("click", (event) => {
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[value]");
        if (!button) return;
        const value = button.value;
        if (value === "start") {
          event.preventDefault();
          const checked = dialog.querySelector<HTMLInputElement>('input[name="review-mode"]:checked');
          dialog.close(checked?.value ?? "basic");
          return;
        }
        dialog.returnValue = value;
        dialog.close();
      });
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        dialog.returnValue = "cancel";
        dialog.close();
      });
      dialog.addEventListener("close", () => {
        settle(dialog.returnValue === "review" ? true : dialog.returnValue === "basic" ? false : undefined);
      });
      dialog.showModal();
    });
  } finally {
    dialog.remove();
  }
}

export function episodeRegenerationComparisonText(preview: any): string {
  const counts = preview?.counts ?? {};
  const describe = (value: any) => (value?.memories ?? []).map((memory: any, index: number) => {
    const details = (memory.details ?? []).map((item: any) => `  · ${item.text}`).join("\n");
    const dialogue = (memory.keyDialogues ?? []).map((item: any) => `  “${item.text}” — ${item.speaker}`).join("\n");
    return `${index + 1}. ${memory.title}\n${memory.content}${details ? `\n${details}` : ""}${dialogue ? `\n${dialogue}` : ""}`;
  }).join("\n\n") || "(에피소드 없음)";
  return `기존: 에피소드 ${counts.before?.memories ?? 0}, 세부 ${counts.before?.details ?? 0}, 대사 ${counts.before?.dialogues ?? 0}\n\n${describe(preview?.before)}\n\n──────── 새 후보 ────────\n새 후보: 에피소드 ${counts.after?.memories ?? 0}, 세부 ${counts.after?.details ?? 0}, 대사 ${counts.after?.dialogues ?? 0}\n\n${describe(preview?.after)}`;
}

export function canonicalRegenerationComparisonText(preview: any): string {
  const before = preview?.counts?.before ?? {}, after = preview?.counts?.after ?? {}, diff = preview?.diff ?? {};
  const delta = (key: string) => `+${diff[key]?.added ?? 0}/-${diff[key]?.removed ?? 0}`;
  const titles = (items: unknown) => Array.isArray(items) && items.length ? items.map((item) => `· ${String(item)}`).join("\n") : "(없음)";
  return `기존 이후 정본: 기억 ${before.memories ?? 0}, 세부 ${before.details ?? 0}, belief ${before.beliefs ?? 0}, 약속 ${before.promises ?? 0}\n새 후보: 기억 ${after.memories ?? 0}, 세부 ${after.details ?? 0}, belief ${after.beliefs ?? 0}, 약속 ${after.promises ?? 0}\n변화: 기억 ${delta("memories")}, 세부 ${delta("details")}, belief ${delta("beliefs")}, 약속 ${delta("promises")} · 변경 묶음 ${preview?.changedBatchCount ?? 0}개\n\n기존 주요 에피소드\n${titles(preview?.highlights?.before)}\n\n새 주요 에피소드\n${titles(preview?.highlights?.after)}`;
}

const parseJson = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === "string" ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};

const formatTime = (value: unknown): string => {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleString() : "—";
};

const formatRelativeTime = (value: unknown): string => {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return "아직 없음";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1_000));
  if (seconds < 60) return "방금 전";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}일 전` : new Date(time).toLocaleDateString();
};

const icon = (name: string): string => {
  const paths: Record<string, string> = {
    overview: '<path d="M4 5h7v6H4zM13 5h7v10h-7zM4 13h7v6H4zM13 17h7v2h-7z"/>',
    timeline: '<path d="M6 3v18M6 7h8M6 12h12M6 17h9"/>',
    relationships: '<circle cx="7" cy="7" r="3"/><circle cx="17" cy="8" r="3"/><circle cx="12" cy="17" r="3"/><path d="m9.7 8.2 4.5-.5m1.1 3-2 3.6m-3.2.2-1.8-4.8"/>',
    world: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18"/>',
    conflicts: '<path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/>',
    reviews: '<path d="M5 4h14v16H5zM8 8h8M8 12h5"/><path d="m14 16 2 2 4-5"/>',
    operations: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="10" cy="18" r="1.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.4.25.74.6 1 .99.25.4.4.85.4 1.32V11h.2v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    refresh: '<path d="M20 6v5h-5M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 9m2 6.5A7 7 0 0 0 18 15l2-3"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    edit: '<path d="M4 20h4l11-11-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
    save: '<path d="M4.5 5h15v14h-15z"/><path d="M7.5 5v5h8V5M8 19v-6h8v6"/>',
    download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    delete: '<path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7M10 11v6m4-6v6"/>',
    "arrow-right": '<path d="M5 12h14M15 8l4 4-4 4"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] ?? paths.overview}</svg>`;
};

const status = (kind: "ok" | "warn" | "error", text: string): string =>
  `<span class="status status--${kind}">${icon(kind === "ok" ? "check" : kind === "warn" ? "clock" : "error")}<span>${escapeHtml(text)}</span></span>`;

type HomeMessageTone = "neutral" | "success" | "warning" | "danger";

function homeMessage(options: {
  title: string;
  bodyHtml?: string;
  actionsHtml?: string;
  tone?: HomeMessageTone;
  iconName?: string;
  role?: "status" | "alert";
  className?: string;
  detailsHtml?: string;
  disclosureLabel?: string;
}): string {
  const tone = options.tone ?? "neutral";
  const iconName = options.iconName ?? (tone === "danger" ? "error" : tone === "success" ? "check" : "clock");
  const className = options.className ? ` ${options.className}` : "";
  const content = `<span class="home-message__icon">${icon(iconName)}</span><div class="home-message__body"><strong>${escapeHtml(options.title)}</strong>${options.bodyHtml ?? ""}</div>`;
  if (options.detailsHtml !== undefined) {
    return `<details class="home-message home-message--${tone} home-message--disclosure${className}"${options.role ? ` role="${options.role}"` : ""}><summary>${content}<span class="home-message__disclosure">${escapeHtml(options.disclosureLabel ?? "상태 보기")}</span></summary><div class="home-message__details">${options.detailsHtml}</div></details>`;
  }
  return `<section class="home-message home-message--${tone}${className}" role="${options.role ?? (tone === "danger" ? "alert" : "status")}">${content}${options.actionsHtml ? `<div class="home-message__actions">${options.actionsHtml}</div>` : ""}</section>`;
}

export function updateNotice(state: RuntimeState): string {
  if (state.updateApplying) return homeMessage({
    title: state.updateApplying.error ? "서버 업데이트를 확인해 주세요" : `RCM ${state.updateApplying.targetVersion} 업데이트 중`,
    bodyHtml: `<p>${escapeHtml(state.updateApplying.error ?? "새 서버를 적용하고 다시 연결하고 있습니다. 잠시만 기다려 주세요.")}</p>`,
    tone: state.updateApplying.error ? "warning" : "neutral",
  });
  const update = state.updateStatus;
  const pluginUpdate = pluginUpdateNeeded(update);
  if (!update?.configured || (!update.available && !update.restartRequired && !pluginUpdate && !update.error)) return "";
  if (update.restartRequired) return homeMessage({
    title: "서버 업데이트가 준비되었습니다",
    bodyHtml: `<p>RCM ${escapeHtml(update.stagedVersion ?? update.latestServerVersion ?? "새 버전")} 적용을 마치려면 ${update.canApplyAutomatically ? "아래 버튼을 눌러 주세요" : "이번에는 서버를 다시 시작해 주세요"}. 사용자 설정과 기억 데이터는 유지됩니다.${pluginUpdate ? " 서버 설치가 끝나면 Risu 플러그인 메뉴의 + 버튼으로 플러그인도 업데이트해 주세요." : ""}</p>`,
    actionsHtml: update.canApplyAutomatically ? '<button class="btn btn--primary" data-action="stage-server-update">서버 업데이트 설치</button>' : undefined,
    tone: "warning",
  });
  if (update.available) return homeMessage({
    title: `RCM ${update.latestVersion ?? update.latestServerVersion ?? "새 버전"} 업데이트`,
    bodyHtml: pluginUpdate
      ? "<p>서버 업데이트를 먼저 설치한 뒤 Risu 플러그인 메뉴의 + 버튼으로 플러그인도 업데이트해 주세요.</p>"
      : "<p>새 서버 버전을 설치할 수 있습니다. 이 릴리스에는 플러그인 업데이트가 필요하지 않습니다.</p>",
    actionsHtml: update.canStageServer ? `<button class="btn btn--primary" data-action="stage-server-update">${update.canApplyAutomatically ? "서버 업데이트 설치" : "서버 업데이트 준비"}</button>` : '<button class="home-message__action-link" data-action="tab" data-tab="settings" data-settings-section="server">설치 방법 보기 <span aria-hidden="true">→</span></button>',
    tone: "neutral",
  });
  if (pluginUpdate) return homeMessage({
    title: `RCM ${update.latestPluginVersion} 플러그인 업데이트 필요`,
    bodyHtml: "<p>서버 업데이트가 완료되었습니다. Risu 플러그인 메뉴의 + 버튼으로 플러그인 업데이트를 진행해 주세요.</p>",
    tone: "warning",
  });
  return homeMessage({ title: "업데이트 확인에 실패했습니다", bodyHtml: `<p>${escapeHtml(update.error ?? "업데이트 정보를 읽지 못했습니다.")}</p>`, tone: "warning" });
}

const styles = `
:root{color-scheme:dark;--rcm-bg:var(--risu-theme-bgcolor,#282a36);--rcm-surface:var(--risu-theme-darkbg,#21222c);--rcm-selected:var(--risu-theme-selected,#44475a);--rcm-border:var(--risu-theme-darkborderc,#4b5563);--rcm-accent:var(--risu-theme-borderc,#6272a4);--rcm-text:var(--risu-theme-textcolor,#f5f5f5);--rcm-muted:color-mix(in srgb,var(--rcm-text) 68%,var(--rcm-bg));--rcm-danger:var(--risu-theme-draculared,#ef4444);--rcm-success:#22c55e;--rcm-warning:#f59e0b;font-family:var(--risu-font-family,Arial,system-ui,sans-serif);font-size:13px;background:var(--rcm-bg);color:var(--rcm-text)}
*{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--rcm-muted) 28%,transparent) transparent}*::-webkit-scrollbar{width:8px;height:8px}*::-webkit-scrollbar-track{background:transparent}*::-webkit-scrollbar-thumb{min-height:40px;border:2px solid transparent;border-radius:999px;background:color-mix(in srgb,var(--rcm-muted) 25%,transparent);background-clip:padding-box}*:hover::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--rcm-muted) 48%,transparent);background-clip:padding-box}
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--rcm-bg);color:var(--rcm-text)}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}.app{height:100%;display:grid;grid-template-rows:50px minmax(0,1fr)}.topbar{display:flex;align-items:center;gap:10px;padding:0 12px;border-bottom:1px solid var(--rcm-border);background:var(--rcm-surface)}.brand{min-width:0;display:flex;align-items:baseline;gap:8px}.brand strong{font-size:14px}.brand span{color:var(--rcm-muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.topbar__spacer{flex:1}.shell{min-height:0;display:grid;grid-template-columns:184px minmax(0,1fr)}.sidebar{min-height:0;overflow-y:auto;padding:10px 8px;border-right:1px solid var(--rcm-border);background:var(--rcm-surface)}.nav{display:grid;gap:3px}.nav button{min-height:38px;display:flex;align-items:center;gap:9px;width:100%;border:1px solid transparent;border-radius:6px;padding:8px 9px;background:transparent;color:var(--rcm-muted);text-align:left}.nav button:hover{background:var(--rcm-selected);color:var(--rcm-text)}.nav button[aria-current=page]{border-color:var(--rcm-border);background:var(--rcm-selected);color:var(--rcm-text)}svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}.main{min-width:0;min-height:0;overflow:auto;padding:16px}.page{max-width:1240px;margin:0 auto}.pagehead{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}.pagehead__copy{min-width:0}.pagehead h1{font-size:20px;line-height:1.3;margin:0 0 3px}.pagehead p{margin:0;color:var(--rcm-muted);max-width:72ch}.pagehead__actions{margin-left:auto;display:flex;gap:7px;flex-wrap:wrap}.panel{border:1px solid var(--rcm-border);border-radius:8px;background:var(--rcm-surface)}.panel+.panel{margin-top:12px}.panel__head{display:flex;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid var(--rcm-border)}.panel__head h2{font-size:14px;margin:0}.panel__head span{color:var(--rcm-muted);font-size:12px}.panel__body{padding:12px}.statusbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--rcm-border);border-radius:8px;background:var(--rcm-surface);margin-bottom:12px}.status{display:inline-flex;align-items:center;gap:5px;border:1px solid currentColor;border-radius:999px;padding:3px 7px;font-weight:600;font-size:12px}.status svg{width:14px;height:14px}.status--ok{color:var(--rcm-success)}.status--warn{color:var(--rcm-warning)}.status--error{color:var(--rcm-danger)}.summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--rcm-border);border-radius:8px;overflow:hidden;background:var(--rcm-surface);margin-bottom:12px}.summary__item{padding:12px;border-right:1px solid var(--rcm-border)}.summary__item:last-child{border-right:0}.summary__item span{display:block;color:var(--rcm-muted);font-size:12px;margin-bottom:3px}.summary__item strong{font-size:18px}.split{display:grid;grid-template-columns:minmax(300px,.9fr) minmax(340px,1.1fr);min-height:480px}.split__list{min-width:0;border-right:1px solid var(--rcm-border)}.split__detail{min-width:0}.toolbar{display:flex;align-items:center;gap:8px;padding:10px;border-bottom:1px solid var(--rcm-border);flex-wrap:wrap}.search{position:relative;min-width:180px;flex:1}.search svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--rcm-muted);width:15px}.search input{width:100%;padding-left:32px}.rows{max-height:62vh;overflow:auto}.row{width:100%;display:grid;gap:4px;padding:10px 12px;border:0;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 70%,transparent);background:transparent;text-align:left}.row:hover,.row.is-selected{background:var(--rcm-selected)}.row__top{display:flex;gap:8px;align-items:center}.row__top strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row__meta{display:flex;gap:7px;flex-wrap:wrap;color:var(--rcm-muted);font-size:12px}.row__body{color:var(--rcm-muted);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.detail{padding:14px}.detail h2{margin:0 0 4px;font-size:16px}.detail__meta{display:flex;gap:7px;flex-wrap:wrap;color:var(--rcm-muted);font-size:12px;margin-bottom:14px}.field{display:grid;gap:5px;margin-bottom:11px}.field>span,.field>label{font-size:12px;font-weight:600;color:var(--rcm-muted)}input,select,textarea{width:100%;border:1px solid var(--rcm-border);border-radius:6px;background:var(--rcm-bg);padding:8px 10px;outline:none}textarea{min-height:100px;resize:vertical;line-height:1.5}input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid var(--rcm-accent);outline-offset:2px}.formgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}.actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:12px}.btn{min-height:36px;border:1px solid var(--rcm-border);border-radius:6px;padding:7px 12px;background:var(--rcm-surface);color:var(--rcm-text);font-weight:600}.btn:hover{background:var(--rcm-selected)}.btn--primary{background:var(--rcm-selected)}.btn--primary:hover{background:var(--rcm-accent)}.btn--danger{color:var(--rcm-danger)}.btn--icon{width:34px;height:34px;padding:7px;display:grid;place-items:center}.btn--icon svg{width:18px;height:18px}.segmented{display:inline-flex;gap:2px;padding:4px;border:1px solid var(--rcm-border);border-radius:8px;background:var(--rcm-bg)}.segmented button{min-height:32px;border:0;border-radius:6px;padding:5px 10px;background:transparent;color:var(--rcm-muted);font-weight:600}.segmented button[aria-pressed=true]{background:var(--rcm-selected);color:var(--rcm-text)}.notice{display:flex;align-items:flex-start;gap:9px;padding:11px 12px;border:1px solid var(--rcm-warning);border-radius:8px;color:var(--rcm-text);background:color-mix(in srgb,var(--rcm-warning) 9%,var(--rcm-surface));margin-bottom:12px}.notice svg{color:var(--rcm-warning)}.notice__actions{margin-left:auto}.tablewrap{overflow:auto}.table{width:100%;border-collapse:collapse}.table th,.table td{padding:9px 10px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 70%,transparent);text-align:left;vertical-align:top}.table th{position:sticky;top:0;background:var(--rcm-surface);color:var(--rcm-muted);font-size:12px;z-index:1}.table tbody tr:hover{background:var(--rcm-selected)}.mono{font-family:Consolas,ui-monospace,monospace;font-size:12px;word-break:break-all}.muted{color:var(--rcm-muted)}.empty{padding:28px 16px;text-align:center;color:var(--rcm-muted)}.evidence{margin-top:14px;border-top:1px solid var(--rcm-border);padding-top:12px}.evidence details{border:1px solid var(--rcm-border);border-radius:6px;padding:8px;margin-top:7px;background:var(--rcm-bg)}.evidence summary{cursor:pointer;font-weight:600}.evidence blockquote{margin:8px 0 0;padding:10px 12px;border:0;border-radius:6px;background:color-mix(in srgb,var(--rcm-selected) 34%,transparent);color:var(--rcm-muted)}.graph{overflow:auto;padding:12px}.graph svg{width:620px;height:390px;display:block;margin:auto}.graph .edge{stroke:var(--rcm-border);stroke-width:2}.graph .node{fill:var(--rcm-selected);stroke:var(--rcm-accent);stroke-width:1.5}.graph text{fill:var(--rcm-text);font:600 12px Arial,system-ui,sans-serif;text-anchor:middle;dominant-baseline:middle}.graph .edge-label{fill:var(--rcm-muted);font-size:10px}.log{display:grid;grid-template-columns:150px 70px minmax(0,1fr);gap:8px;padding:8px 10px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 60%,transparent)}.log__level{text-transform:uppercase;font-size:11px;font-weight:700}.log__level--error{color:var(--rcm-danger)}.log__level--warn{color:var(--rcm-warning)}.packet{white-space:pre-wrap;max-height:300px;overflow:auto;border:1px solid var(--rcm-border);border-radius:6px;background:var(--rcm-bg);padding:10px;font-family:Consolas,ui-monospace,monospace;font-size:12px}.loading{opacity:.65;pointer-events:none}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
button:disabled,input:disabled,select:disabled{opacity:.55;cursor:not-allowed}.btn:disabled:hover{background:var(--rcm-surface)}
.change-list{margin:8px 0 0;padding-left:20px;color:var(--rcm-text);line-height:1.5}.change-list li+li{margin-top:3px}.technical{margin-top:10px;color:var(--rcm-muted)}.technical summary{cursor:pointer;font-weight:600}.technical .packet{margin-top:8px;max-height:180px;text-align:left}
.graph .edge--unknown{stroke-dasharray:5 5;opacity:.7}.graph-legend{display:flex;gap:14px;justify-content:center;padding:0 12px 12px;color:var(--rcm-muted);font-size:12px}.graph-legend span{display:inline-flex;align-items:center;gap:6px}.graph-legend i{display:inline-block;width:24px;border-top:2px solid var(--rcm-border)}.graph-legend .unknown{border-top-style:dashed}.review-copy{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}.review-copy blockquote{margin:5px 0 0;padding:9px 10px;border:1px solid var(--rcm-border);border-radius:6px;background:var(--rcm-bg);white-space:pre-wrap}.review-score{font-variant-numeric:tabular-nums}.review-resolved{opacity:.72}
.graph{overflow:hidden}.graph svg{width:min(620px,100%);height:auto;aspect-ratio:620/390}.tablelink{border:0;padding:0;background:transparent;color:var(--rcm-text);font-weight:600;text-decoration:underline;text-decoration-color:var(--rcm-accent);text-underline-offset:3px}.score-band{display:block;margin-top:2px;color:var(--rcm-muted);font-weight:400;white-space:nowrap}
.btn{display:inline-flex;align-items:center;justify-content:center}.topbar__state{flex:none}[hidden]{display:none!important}.panel__head{flex-wrap:wrap}.panel__head>span{min-width:0;flex:1 1 220px}.panel__head>.btn{margin-left:auto;white-space:nowrap}
.canonical-copy{display:block;margin-top:3px;color:var(--rcm-muted);font-size:11px;font-weight:400}.translation{margin:0 0 14px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--rcm-accent) 55%,var(--rcm-border));border-radius:6px;background:color-mix(in srgb,var(--rcm-accent) 8%,var(--rcm-bg));line-height:1.5}.translation p{margin:5px 0}.translation__error{display:block;color:var(--rcm-danger);font-size:12px}.reference-translation{display:block;margin-top:7px;padding-top:7px;border-top:1px dashed var(--rcm-border);color:var(--rcm-muted);line-height:1.45}.landmark{color:var(--rcm-warning);font-weight:700}.field--check{padding:9px 0}.field--check input{width:auto;margin-right:6px}.settings-section{padding:4px 0}.settings-section+.settings-section{margin-top:18px;padding-top:18px;border-top:1px solid var(--rcm-border)}.settings-section h3{margin:0 0 10px;font-size:13px}.settings-subhead{margin:18px 0 10px;padding-top:14px;border-top:1px solid var(--rcm-border);font-size:12px;font-weight:650}.activity-line{min-width:170px}.skeleton{display:grid;gap:8px;padding:16px}.skeleton span{height:12px;border-radius:4px;background:color-mix(in srgb,var(--rcm-text) 10%,var(--rcm-surface))}.new-data{position:sticky;top:0;z-index:4;margin:0 0 8px}
.timeline-split{height:max(560px,calc(100vh - 132px));min-height:0}.timeline-split .split__list{display:grid;grid-template-rows:auto minmax(0,1fr);min-height:0}.timeline-split .split__detail{min-height:0;overflow:auto}.timeline-split .rows{max-height:none;min-height:0}.graph text{stroke:none;paint-order:normal;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;font-weight:600}.graph .edge-label{font-size:11px;font-variant-numeric:tabular-nums}.chat-label{display:grid;gap:3px;min-width:180px}.chat-label strong{font-weight:650}.chat-label small{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--rcm-muted);font:11px Consolas,ui-monospace,monospace}.table-actions{display:grid;grid-template-columns:repeat(3,minmax(138px,1fr));gap:7px;min-width:442px}.table-actions .btn{width:100%;white-space:nowrap}.data-intents{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0 0 12px;border:1px solid var(--rcm-border);border-radius:8px;background:var(--rcm-surface)}.data-intents>div{padding:11px 12px}.data-intents>div+div{border-left:1px solid var(--rcm-border)}.data-intents dt{font-weight:650;margin-bottom:3px}.data-intents dd{margin:0;color:var(--rcm-muted);line-height:1.45}
.capsule-children{border-bottom:1px solid var(--rcm-border);background:color-mix(in srgb,var(--rcm-selected) 28%,transparent)}.capsule-children>summary{min-height:36px;padding:9px 12px;color:var(--rcm-muted);cursor:pointer;font-size:12px;font-weight:600}.capsule-children .row{padding-left:22px;background:color-mix(in srgb,var(--rcm-bg) 40%,transparent)}
.merge-preview{margin-top:14px;padding-top:14px;border-top:1px solid var(--rcm-border)}.merge-preview h3{margin:0 0 6px}.impact-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:12px 0;border-block:1px solid var(--rcm-border)}.impact-grid div{padding:9px 10px}.impact-grid div+div{border-left:1px solid var(--rcm-border)}.impact-grid dt{color:var(--rcm-muted);font-size:11px}.impact-grid dd{margin:3px 0 0;font-size:17px;font-weight:700}.review-switch{margin-bottom:12px}.duplicate-review{padding:12px}.duplicate-review+.duplicate-review{border-top:1px solid var(--rcm-border)}.compare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:10px 0;border-block:1px solid var(--rcm-border)}.compare__item{padding:10px}.compare__item+.compare__item{border-left:1px solid var(--rcm-border)}.compare__item h3{margin:0 0 7px;font-size:12px;color:var(--rcm-muted)}.compare__item p{white-space:pre-wrap;line-height:1.5;margin:5px 0}.review-reason{padding:8px 10px;border:1px solid color-mix(in srgb,var(--rcm-warning) 55%,var(--rcm-border));border-radius:6px;background:color-mix(in srgb,var(--rcm-warning) 7%,transparent)}
.record-actions{display:flex;gap:6px;white-space:nowrap}.record-actions .btn{min-height:32px;padding:5px 9px}.world-editor{padding:14px;border-top:1px solid var(--rcm-border);background:color-mix(in srgb,var(--rcm-selected) 22%,var(--rcm-surface))}.world-editor__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}.world-editor__head p,.world-editor>div>p{margin:4px 0 0}.world-editor textarea{min-height:86px}
.timeline-split .rows{overflow-x:hidden}.timeline-split .row{min-width:0;overflow:hidden}.timeline-split .row__top,.timeline-split .row__meta,.timeline-split .row__body{min-width:0}.timeline-split .row__meta span{min-width:0;overflow-wrap:anywhere}.table th,.table td{vertical-align:middle}.field input:not([type=checkbox]),.field select,.search input{height:36px;min-height:36px}.relationship-reason{display:grid;gap:5px;margin-bottom:16px}.relationship-reason p{margin:0;line-height:1.5}
.relationship-tabs{margin-bottom:12px}.relationship-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.relationship-toolbar__person{display:flex;align-items:center;gap:8px}.relationship-toolbar__person label{color:var(--rcm-muted);font-size:12px;font-weight:650;white-space:nowrap}.relationship-toolbar select{min-width:160px}.relationship-ledger{overflow:hidden}.relationship-group{border-bottom:1px solid var(--rcm-border)}.relationship-group:last-child{border-bottom:0}.relationship-group>summary{display:flex;align-items:center;gap:9px;min-height:48px;padding:10px 14px;cursor:pointer;list-style:none}.relationship-group>summary::-webkit-details-marker{display:none}.relationship-group>summary::before{content:"›";color:var(--rcm-muted);font-size:20px;line-height:1;transform:rotate(0);transition:transform 180ms cubic-bezier(.22,1,.36,1)}.relationship-group[open]>summary::before{transform:rotate(90deg)}.relationship-group__name{font-size:15px;font-weight:750}.relationship-group__count{color:var(--rcm-muted);font-size:12px}.relationship-group__state{margin-left:auto;color:var(--rcm-muted);font-size:11px}.relationship-row{border-top:1px solid color-mix(in srgb,var(--rcm-border) 72%,transparent)}.relationship-row__button{display:grid;grid-template-columns:minmax(120px,.32fr) minmax(220px,1fr) auto;align-items:center;gap:14px;width:100%;min-height:66px;padding:11px 14px;border:0;background:transparent;color:var(--rcm-text);text-align:left;cursor:pointer}.relationship-row__button:hover{background:color-mix(in srgb,var(--rcm-selected) 58%,transparent)}.relationship-row.is-selected>.relationship-row__button{background:var(--rcm-selected)}.relationship-row__person{font-size:14px;font-weight:720}.relationship-row__summary{min-width:0;color:var(--rcm-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.relationship-signals{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap}.relationship-signal{display:inline-flex;gap:4px;align-items:center;padding:3px 6px;border:1px solid var(--rcm-border);border-radius:999px;color:var(--rcm-muted);font-size:11px;white-space:nowrap}.relationship-signal b{color:var(--rcm-text);font-weight:650}.relationship-detail{padding:16px 18px 18px;background:color-mix(in srgb,var(--rcm-selected) 32%,var(--rcm-bg));border-top:1px solid var(--rcm-border)}.relationship-detail__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.relationship-detail__head h2{margin:0;font-size:17px}.relationship-detail__meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px;color:var(--rcm-muted);font-size:11px}.relationship-detail__actions{display:flex;align-items:center;gap:6px}.relationship-detail__actions .record-menu{flex:0 0 auto}.relationship-detail__actions .record-menu__items{min-width:190px}.axis-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:16px}.axis-group{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-block:1px solid var(--rcm-border)}.axis-group>strong{grid-column:1/-1;padding:8px 0 5px;color:var(--rcm-muted);font-size:11px}.axis-chip{display:grid;gap:3px;padding:9px 8px 9px 0}.axis-chip b{font-size:11px;color:var(--rcm-muted)}.axis-chip span{font-weight:700}.axis-chip small{color:var(--rcm-muted)}.axis-chip[data-override=true]::after{content:"수동";width:max-content;padding:1px 4px;border:1px solid var(--rcm-warning);border-radius:999px;font-size:9px;color:var(--rcm-warning)}.relationship-editor{padding:2px 0}.relationship-editor__head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}.relationship-editor__head h2{margin:0;font-size:17px}.relationship-editor__actions{display:flex;gap:6px}.relationship-axis-editor{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:14px 0}.relationship-axis-editor .field{margin:0;padding:10px;border:1px solid var(--rcm-border);border-radius:7px}.relationship-axis-editor legend{padding:0 4px;color:var(--rcm-text);font-weight:700}.relationship-network{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--rcm-border);border-radius:8px;overflow:hidden;background:var(--rcm-surface)}.relationship-network__lane+ .relationship-network__lane{border-left:1px solid var(--rcm-border)}.relationship-network__head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:13px 14px;border-bottom:1px solid var(--rcm-border)}.relationship-network__head h2{margin:0;font-size:14px}.relationship-network__head span{color:var(--rcm-muted);font-size:11px}.relationship-network__row{display:grid;grid-template-columns:minmax(110px,.35fr) minmax(0,1fr) auto;align-items:center;gap:12px;width:100%;min-height:62px;padding:10px 14px;border:0;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 72%,transparent);background:transparent;color:var(--rcm-text);text-align:left}.relationship-network__row:last-child{border-bottom:0}.relationship-network__row:hover{background:var(--rcm-selected)}.relationship-network__row strong{font-size:13px}.relationship-network__row p{min-width:0;margin:0;color:var(--rcm-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.relationship-network__row>span{color:var(--rcm-accent);font-size:18px}.relationship-empty{padding:24px 14px;color:var(--rcm-muted);text-align:center}.history-list{padding:10px 12px}.history-list .row{padding-inline:0}.history-badge{display:inline-flex;border:1px solid var(--rcm-border);border-radius:999px;padding:2px 6px;color:var(--rcm-muted);font-size:11px}.injection-list{display:flex;gap:6px;flex-wrap:wrap}.injection-list span{border:1px solid var(--rcm-border);border-radius:999px;padding:3px 7px;background:var(--rcm-bg)}
.data-summary{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:9px 12px;margin-bottom:10px;border-block:1px solid var(--rcm-border);color:var(--rcm-muted)}.data-summary strong{color:var(--rcm-text);font-variant-numeric:tabular-nums}.data-toolbar{display:grid;grid-template-columns:minmax(240px,1fr) 190px auto;gap:8px;align-items:center;margin-bottom:12px}.data-group .panel__head{align-items:baseline}.record-actions{white-space:normal;flex-wrap:wrap}.record-actions .btn{flex:1 1 132px}.record-actions--compact{display:inline-flex;flex-wrap:nowrap;white-space:nowrap}.record-actions--compact .btn{flex:0 0 auto}.inline-confirm{margin-top:10px;padding:12px;border:1px solid var(--rcm-warning);border-radius:6px;background:color-mix(in srgb,var(--rcm-warning) 8%,var(--rcm-bg));white-space:normal}.inline-confirm p{margin:5px 0 8px;color:var(--rcm-muted);line-height:1.45}.confirm-check{display:flex;align-items:center;gap:7px}.confirm-check input{width:auto}.transfer-panel{margin-bottom:12px}.transfer-preview{padding-top:12px;border-top:1px solid var(--rcm-border)}.transfer-preview h3{margin:0 0 8px}.transfer-preview dl{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-block:1px solid var(--rcm-border)}.transfer-preview dl>div{padding:8px}.transfer-preview dt{font-size:11px;color:var(--rcm-muted)}.transfer-preview dd{margin:3px 0 0}.server-inspector{margin-bottom:12px}.server-inspector .panel__head .btn{margin-left:auto}.inspector-section{padding:12px}.inspector-section+.inspector-section{border-top:1px solid var(--rcm-border)}.inspector-section h3{margin:0 0 9px;font-size:13px}.inspector-section details{padding:7px 0}.inspector-section details+details{border-top:1px solid color-mix(in srgb,var(--rcm-border) 70%,transparent)}.inspector-section summary{cursor:pointer;font-weight:650}.inspector-section details p{max-width:72ch;white-space:pre-wrap}.ledger-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px}.ledger-toolbar .actions{margin:0}.ledger-reveal{padding:10px 0}.ledger-content{min-width:320px;white-space:pre-wrap;line-height:1.45}
.story-overview p,.story-progress p,.story-arc p{max-width:78ch;white-space:pre-wrap;line-height:1.6}.story-sequence>details+details{margin-top:10px;border-top:1px solid var(--rcm-border)}.story-sequence>details>summary{padding:10px 0;cursor:pointer;font-weight:650}.story-sequence>details>div{padding:0 0 12px}.story-archive{display:grid;gap:10px}.story-archive__head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:2px 2px 0}.story-archive__head h2{margin:0}.story-archive__head span{color:var(--rcm-muted);font-size:12px}.story-arc>summary{display:flex;align-items:center;padding:12px;cursor:pointer;list-style-position:inside}.story-arc>summary span{display:inline-grid;gap:3px}.story-arc>summary small{color:var(--rcm-muted);font-weight:400}.story-flows,.story-segments{margin-top:14px;border-top:1px solid var(--rcm-border);padding-top:10px}.story-flows>summary,.story-segments summary{cursor:pointer;font-weight:650}.story-flows section,.story-segments details>div{padding:8px 10px}.story-links{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:12px}.story-links>span{color:var(--rcm-muted);font-size:12px}.btn--quiet{min-height:30px;padding:4px 8px;font-weight:500}
.story-overview-editor{display:grid;gap:12px;min-width:0}.story-overview-editor__head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.story-overview-editor__head h2{margin:0}.story-overview-editor__head small{display:block;margin-top:5px;color:var(--rcm-muted)}.story-overview-editor__head>div:last-child{display:flex;gap:8px}.story-overview-editor textarea{width:100%;min-height:220px;resize:vertical;line-height:1.65}
.lineage-path{margin-bottom:12px}.lineage-path__row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.lineage-path__node{min-height:30px;padding:5px 8px;border:1px solid var(--rcm-border);border-radius:6px;background:var(--rcm-bg);color:var(--rcm-text)}.lineage-path__node.is-missing{color:var(--rcm-muted);border-style:dashed}.lineage-path__edge{display:inline-grid;gap:1px;justify-items:center;color:var(--rcm-muted);font-size:10px}.lineage-path__edge b{font-size:15px;line-height:1}.lineage-path details>summary{cursor:pointer;color:var(--rcm-muted)}
.review-choice-dialog{width:560px;max-width:calc(100vw - 28px);border:1px solid var(--rcm-border);border-radius:9px;padding:0;background:var(--rcm-surface);color:var(--rcm-text);box-shadow:0 20px 60px #0008}.review-choice-dialog::backdrop{background:#0009}.review-choice-dialog__body{padding:18px;min-width:0;overflow-wrap:anywhere}.review-choice-dialog h2{margin:0 0 10px;font-size:17px}.review-choice-dialog p{line-height:1.5}.review-choice-dialog{max-height:calc(100dvh - 28px);overflow:auto}.review-choice-dialog .actions{display:flex;gap:8px;flex-wrap:wrap}.review-choice-dialog .btn{min-height:44px}.review-choice-dialog .actions{justify-content:flex-end}
.review-choice-options{display:grid;gap:8px;min-inline-size:0;margin:16px 0;padding:0;border:0}.review-choice-options legend{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.review-choice-options label{display:grid;grid-template-columns:16px minmax(0,1fr);align-items:start;gap:10px;min-height:58px;padding:11px 12px;border:1px solid var(--rcm-border);border-radius:8px;cursor:pointer;background:color-mix(in srgb,var(--rcm-surface) 90%,var(--rcm-selected))}.review-choice-options label:has(input:checked){border-color:var(--rcm-accent);background:color-mix(in srgb,var(--rcm-accent) 8%,var(--rcm-surface))}.review-choice-options input[type="radio"]{width:16px;height:16px;min-width:16px;margin:3px 0 0;padding:0;accent-color:var(--rcm-accent)}.review-choice-options label>span{min-width:0}.review-choice-options span,.review-choice-options strong,.review-choice-options small{display:block}.review-choice-options small{margin-top:3px;color:var(--rcm-muted);line-height:1.45}
.section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:13px 14px;border-bottom:1px solid var(--rcm-border)}.section-head h2{margin:0 0 3px;font-size:14px}.section-head p{margin:0;line-height:1.45}.ledger-row{padding:12px 14px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 70%,transparent)}.ledger-row__main{display:grid;grid-template-columns:minmax(150px,.7fr) minmax(220px,1.3fr) minmax(110px,.45fr);gap:12px;align-items:end}.ledger-row__meta{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:9px}.ledger-row .field{margin-bottom:0}.ledger-technical{min-width:0;color:var(--rcm-muted)}.ledger-technical summary{cursor:pointer;font-size:12px}.ledger-technical code{display:block;max-width:72ch;margin-top:6px;overflow-wrap:anywhere}.inline-create{display:grid;grid-template-columns:minmax(180px,.65fr) minmax(240px,1.35fr) auto;gap:10px;padding:12px 14px}.initial-relationship-editor{padding:12px 14px}.history-group>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;cursor:pointer}.history-group+.history-group{border-top:1px solid var(--rcm-border)}.history-group blockquote{margin:8px 0;padding-left:10px;border-left:2px solid var(--rcm-accent);color:var(--rcm-muted)}
@media(max-width:900px){.summary{grid-template-columns:repeat(3,minmax(0,1fr))}.summary__item:nth-child(3){border-right:0}.summary__item:nth-child(n+4){border-top:1px solid var(--rcm-border)}.split{grid-template-columns:minmax(260px,.8fr) minmax(320px,1.2fr)}}
@media(max-width:720px){.app{grid-template-rows:48px 46px minmax(0,1fr)}.shell{display:contents}.sidebar{grid-row:2;border-right:0;border-bottom:1px solid var(--rcm-border);padding:5px 7px;overflow-x:auto;overflow-y:hidden}.nav{display:flex;min-width:max-content}.nav button{width:auto;min-height:34px}.main{grid-row:3;padding:10px}.brand span{display:none}.pagehead{align-items:center}.pagehead p{display:none}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.summary__item,.summary__item:nth-child(3){border-right:1px solid var(--rcm-border);border-top:1px solid var(--rcm-border)}.summary__item:nth-child(-n+2){border-top:0}.summary__item:nth-child(even){border-right:0}.split{display:block;min-height:0}.split__list{border-right:0}.split__detail{border-top:1px solid var(--rcm-border)}.rows{max-height:36vh}.formgrid{grid-template-columns:1fr}.table thead{display:none}.table,.table tbody,.table tr,.table td{display:block;width:100%}.table tr{border-bottom:1px solid var(--rcm-border);padding:7px}.table td{border:0;padding:4px 6px;display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px}.table td::before{content:attr(data-label);color:var(--rcm-muted);font-size:12px;font-weight:600}.graph text{font-size:18px}.graph .edge-label{font-size:14px}.log{grid-template-columns:1fr;gap:2px}.notice{display:grid}.notice__actions{margin-left:0}.btn{min-height:44px}.field input:not([type=checkbox]),.field select,.search input{height:44px;min-height:44px}.nav button{min-height:36px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}
@media(max-width:720px){.relationship-page.is-mobile-detail>.pagehead,.relationship-page.is-mobile-detail>.relationship-tabs,.relationship-page.is-mobile-detail>.relationship-toolbar{display:none}.relationship-toolbar{align-items:stretch}.relationship-toolbar__person{flex:1}.relationship-toolbar__person select{min-width:0;width:100%}.relationship-row__button{grid-template-columns:minmax(90px,.35fr) minmax(0,1fr);gap:8px;padding:11px 12px}.relationship-signals{grid-column:1/-1;justify-content:flex-start;padding-left:calc(35% + 4px)}.relationship-ledger.is-mobile-detail>.relationship-group{display:none}.relationship-ledger.is-mobile-detail>.relationship-group:has(.relationship-row.is-selected){display:block;border:0}.relationship-ledger.is-mobile-detail>.relationship-group:has(.relationship-row.is-selected)>summary,.relationship-ledger.is-mobile-detail>.relationship-group:has(.relationship-row.is-selected)>.relationship-row:not(.is-selected){display:none}.relationship-ledger:not(.is-mobile-detail) .relationship-detail{display:none}.relationship-detail{padding:12px}.relationship-detail__head{align-items:center}.relationship-detail__head h2{font-size:16px}.relationship-detail__actions{gap:4px}.axis-groups{grid-template-columns:1fr}.relationship-axis-editor{grid-template-columns:1fr}.relationship-network{grid-template-columns:1fr}.relationship-network__lane+.relationship-network__lane{border-left:0;border-top:1px solid var(--rcm-border)}.relationship-network__row{grid-template-columns:minmax(90px,.35fr) minmax(0,1fr) auto}.relationship-editor__head{position:sticky;top:-12px;z-index:2;padding:10px 0;background:var(--rcm-bg)}.relationship-editor__actions .btn{min-height:40px}}
@media(max-width:720px){.review-copy,.compare{grid-template-columns:1fr}.compare__item+.compare__item{border-left:0;border-top:1px solid var(--rcm-border)}.review-list .rows{max-height:none;overflow:visible}.review-list .actions .btn{flex:1 1 140px}.timeline-split{height:auto}.timeline-split .rows{max-height:48vh}.table-actions{grid-template-columns:1fr;min-width:0}.chat-label{min-width:0}.data-intents{grid-template-columns:1fr}.data-intents>div+div{border-left:0;border-top:1px solid var(--rcm-border)}.impact-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.impact-grid div:nth-child(3){border-left:0}.impact-grid div:nth-child(n+3){border-top:1px solid var(--rcm-border)}.data-toolbar{grid-template-columns:1fr}.data-summary{gap:9px 14px}.transfer-preview dl{grid-template-columns:1fr 1fr}.record-actions{display:grid;grid-template-columns:1fr}.record-actions .btn{width:100%}.record-actions--compact{display:inline-flex;grid-template-columns:none}.record-actions--compact .btn{width:auto;min-height:44px}.panel__head{align-items:flex-start}.panel__head h2{flex:1 1 130px}.panel__head>span{order:3;flex-basis:100%}.panel__head>.btn{margin-left:0}.server-inspector .panel__head .btn{margin-left:0}}
@media(max-width:720px){.section-head{align-items:stretch;flex-direction:column}.ledger-row__main,.inline-create{grid-template-columns:1fr}.ledger-row__meta{align-items:stretch;flex-direction:column}.ledger-row__meta .actions{display:grid;grid-template-columns:1fr 1fr;width:100%}.history-group>summary{align-items:flex-start;flex-direction:column}}
.record-menu{position:relative;flex:1 1 96px}.record-menu>summary{list-style:none;text-align:center}.record-menu>summary::-webkit-details-marker{display:none}.record-menu__items{position:absolute;right:0;z-index:5;display:grid;gap:5px;min-width:150px;padding:6px;margin-top:4px;border:1px solid var(--rcm-border);border-radius:6px;background:var(--rcm-surface);box-shadow:0 10px 28px color-mix(in srgb,#000 22%,transparent)}.record-menu__items .btn{width:100%;text-align:left}
.mobile-only{display:none}
@media(max-width:720px){.mobile-only{display:inline-flex}}
`;

const dashboardStyles = `
.social-workspace-v2>header .actions{display:flex;align-items:center;gap:6px}.social-workspace-v2>header .record-menu{display:inline-block}
.relation-tension-label{display:block;margin-top:14px;color:var(--rcm-text);font-size:13px;font-weight:700}
@media(max-width:760px){.relationships-page:has(.relations-workspace-v2.has-selection)>.relations-toolbar-v2{display:none}}
:root{color-scheme:light dark;font-family:var(--risu-font-family,Pretendard,"Noto Sans KR",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif);letter-spacing:-.01em}.app{grid-template-rows:64px minmax(0,1fr)}
.topbar{padding:0 32px;gap:10px;background:color-mix(in srgb,var(--rcm-bg) 90%,var(--rcm-surface));border-color:color-mix(in srgb,var(--rcm-border) 62%,transparent)}
.chat-context{min-width:0;display:flex;align-items:center;gap:9px}.chat-context strong{max-width:min(42vw,520px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.chat-context>span{color:var(--rcm-muted)}.chat-context__title{max-width:min(28vw,360px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.topbar__state .status{border:0;padding-inline:5px;font-weight:550}
.shell{grid-template-columns:224px minmax(0,1fr)}.sidebar{display:flex;flex-direction:column;overflow:hidden;padding:24px 14px 16px;background:color-mix(in srgb,var(--rcm-surface) 94%,var(--rcm-bg));border-color:color-mix(in srgb,var(--rcm-border) 62%,transparent)}
.product{display:flex;align-items:center;gap:11px;min-height:40px;margin:0 10px 34px;color:var(--rcm-text);text-decoration:none;cursor:pointer}.product__mark{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:color-mix(in srgb,var(--rcm-success) 13%,var(--rcm-surface));color:color-mix(in srgb,var(--rcm-success) 76%,var(--rcm-text))}.product__mark svg{width:18px;height:18px}.product>span:last-child{display:grid;gap:2px;min-width:0}.product strong{font-size:15px;line-height:1.1}.product small{color:var(--rcm-muted);font-size:10px;white-space:nowrap}
.nav{gap:5px}.nav button{min-height:44px;border:0;border-radius:10px;padding:10px 12px;gap:12px;font-weight:590;transition:background .18s ease-out,color .18s ease-out,transform .18s ease-out}.nav button:hover{background:color-mix(in srgb,var(--rcm-selected) 54%,transparent)}.nav button:active{transform:scale(.985)}.nav button svg{width:18px;height:18px}.nav button[aria-current=page]{background:color-mix(in srgb,var(--rcm-success) 12%,var(--rcm-surface));color:var(--rcm-text);box-shadow:none}.nav button[aria-current=page] svg{color:color-mix(in srgb,var(--rcm-success) 74%,var(--rcm-text))}
.sidebar__chat{display:grid;gap:4px;margin-top:auto;padding:14px 10px 2px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 58%,transparent);min-width:0}.sidebar__chat span{color:var(--rcm-muted);font-size:10px}.sidebar__chat strong,.sidebar__chat small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sidebar__chat strong{font-size:12px}.sidebar__chat small{color:var(--rcm-muted);font-size:11px}
.main{position:relative;padding:24px clamp(28px,4vw,58px) 22px;background:color-mix(in srgb,var(--rcm-bg) 97%,var(--rcm-surface));scrollbar-gutter:stable}.page{width:min(1180px,100%);margin:0 auto}.secondary-nav,.world-tabs{display:flex;gap:5px;max-width:1180px;margin:0 auto 18px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 70%,transparent)}.secondary-nav[hidden]{display:none!important}.secondary-nav button,.world-tabs button{min-height:38px;border:0;border-bottom:2px solid transparent;padding:7px 12px;background:transparent;color:var(--rcm-muted);font-weight:600}.secondary-nav button:hover,.world-tabs button:hover{color:var(--rcm-text)}.secondary-nav button[aria-current=page],.world-tabs button[aria-selected=true]{border-bottom-color:var(--rcm-accent);color:var(--rcm-text)}
.page[data-tab=overview]{height:100%}.home-page{min-height:100%;display:grid;grid-template-rows:auto auto auto minmax(260px,1fr) auto;gap:0}.home-page:has(.home-alerts:not(:empty)){grid-template-rows:auto auto auto auto minmax(246px,1fr) auto}.home-alerts{display:grid;gap:10px;margin-bottom:14px}.home-alerts:empty{display:none}.home-alerts>.panel{margin:0}.home-alerts>.panel+.panel{margin-top:0}.home-message{--home-message-tone:var(--rcm-accent);border:1px solid color-mix(in srgb,var(--rcm-border) 72%,transparent);border-radius:8px;background:color-mix(in srgb,var(--home-message-tone) 5%,var(--rcm-surface))}.home-message:not(details),.home-message>summary{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:start;gap:10px;padding:13px 14px}.home-message>summary{cursor:pointer;list-style:none}.home-message>summary::-webkit-details-marker{display:none}.home-message--success{--home-message-tone:var(--rcm-success)}.home-message--warning{--home-message-tone:var(--rcm-warning)}.home-message--danger{--home-message-tone:var(--rcm-danger);border-color:color-mix(in srgb,var(--rcm-danger) 62%,var(--rcm-border))}.home-message__icon{display:grid;place-items:center;width:20px;height:20px;color:color-mix(in srgb,var(--home-message-tone) 82%,var(--rcm-text))}.home-message__icon svg{width:17px;height:17px}.home-message__body{min-width:0;display:grid;gap:3px}.home-message__body>strong{font-size:13px;line-height:1.4}.home-message__body>p{max-width:72ch;margin:0;color:var(--rcm-muted);font-size:12px;line-height:1.5}.home-message__actions{align-self:center;display:flex;gap:7px;margin-left:auto}.home-message__actions select{min-width:180px}.home-message__disclosure{align-self:center;margin-left:auto;color:color-mix(in srgb,var(--home-message-tone) 76%,var(--rcm-text));font-size:11px;font-weight:700}.home-message__details{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 22px;padding:1px 14px 14px 44px}.home-message__details .status{min-width:0;border:0;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 45%,transparent);border-radius:0;padding:8px 0;background:transparent;color:var(--rcm-text);font-size:12px;font-weight:600}.home-message__details .status svg{width:15px;height:15px}.home-message__details .status--ok svg{color:var(--rcm-success)}.home-message__details .status--warn svg{color:var(--rcm-warning)}.home-message__details .status--error svg{color:var(--rcm-danger)}
.home-message__action-link{min-height:32px;display:inline-flex;align-items:center;gap:5px;border:0;padding:5px 0;background:transparent;color:color-mix(in srgb,var(--home-message-tone) 76%,var(--rcm-text));font-size:11px;font-weight:700;white-space:nowrap}.home-message__action-link:hover{text-decoration:underline;text-underline-offset:3px}.home-message__action-link:active{color:var(--rcm-text)}.home-message__action-link span{font-size:13px;font-weight:500}.home-message__details>.home-message__action-link{grid-column:1/-1;justify-self:start;margin-top:3px}
.home-message__body{word-break:keep-all;overflow-wrap:anywhere}
.home-heading{display:flex;align-items:flex-end;gap:24px;margin-bottom:18px}.home-heading h1{margin:0;font-size:28px;line-height:1.2;letter-spacing:-.035em}.home-eyebrow{margin:0 0 6px;color:var(--rcm-muted);font-size:11px;font-weight:700;letter-spacing:.04em}.home-profile{margin-left:auto;color:var(--rcm-muted);font-size:11px;white-space:nowrap}
.home-backfill__meta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:2px;color:var(--rcm-text);font-size:11px;font-variant-numeric:tabular-nums}.home-backfill__hint{color:var(--rcm-muted);font-size:11px;line-height:1.45}.home-backfill__details{min-width:0;max-width:100%;color:var(--rcm-muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere}.home-backfill__details summary{cursor:pointer;font-weight:650;padding:6px 0}.home-backfill__details p{margin:4px 0 0;color:var(--rcm-muted)}.home-backfill__action{white-space:nowrap}
.home-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin:20px 0 24px}.home-metrics>div{min-width:0;display:grid;justify-items:start;gap:2px;min-height:58px;padding:0 20px}.home-metrics>div:first-child{padding-left:0}.home-metrics>div:last-child{padding-right:0}.home-metrics>div+div{border-left:1px solid color-mix(in srgb,var(--rcm-border) 58%,transparent)}.home-metrics span{color:var(--rcm-muted);font-size:11px}.home-metrics strong{font-size:22px;line-height:1.2;font-variant-numeric:tabular-nums;letter-spacing:-.03em}.home-metrics small{color:color-mix(in srgb,var(--rcm-muted) 75%,transparent);font-size:9px}
.home-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(300px,.8fr);gap:44px;min-height:0;align-items:start}.home-section{min-width:0;padding:0}.home-section__head{min-height:36px;display:flex;align-items:baseline;gap:12px;margin-bottom:9px}.home-section__head h2{margin:0;font-size:15px;letter-spacing:-.02em}.home-section__head p{margin:0;color:var(--rcm-muted);font-size:10px}.home-link{margin-left:auto;border:0;padding:4px 0;background:transparent;color:color-mix(in srgb,var(--rcm-success) 72%,var(--rcm-text));font-size:10px;font-weight:700}.home-link:hover{text-decoration:underline;text-underline-offset:4px}
.home-memory-list{display:grid;border-top:1px solid color-mix(in srgb,var(--rcm-border) 58%,transparent)}.home-memory{width:100%;min-width:0;display:grid;grid-template-columns:82px minmax(0,1fr) auto 14px;align-items:start;gap:16px;min-height:62px;border:0;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 50%,transparent);padding:12px 2px;background:transparent;text-align:left;transition:background .18s ease-out}.home-memory:hover{background:color-mix(in srgb,var(--rcm-selected) 35%,transparent)}.home-memory__when{overflow:hidden;color:var(--rcm-muted);font-size:9px;font-variant-numeric:tabular-nums;text-overflow:ellipsis}.home-memory__copy{min-width:0;display:grid;gap:3px}.home-memory__copy strong,.home-memory__copy>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.home-memory__copy strong{font-size:12px}.home-memory__copy>span{color:var(--rcm-muted);font-size:10px;line-height:1.5}.home-memory small{max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--rcm-muted);font-size:9px;text-transform:uppercase}.home-memory__arrow{color:var(--rcm-muted);font-size:16px}
.home-token{display:flex;align-items:baseline;gap:7px;margin-top:5px;font-variant-numeric:tabular-nums}.home-token strong{font-size:30px;line-height:1;letter-spacing:-.04em}.home-token span{color:var(--rcm-muted);font-size:10px}.home-progress{height:6px;margin:12px 0 8px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--rcm-text) 8%,transparent)}.home-progress span{display:block;width:100%;height:100%;border-radius:inherit;background:color-mix(in srgb,var(--rcm-success) 72%,var(--rcm-text));transform-origin:left;transition:transform .24s cubic-bezier(.22,1,.36,1)}.home-injection-meta{display:flex;justify-content:space-between;gap:12px;margin-bottom:11px;color:var(--rcm-muted);font-size:9px}.home-injection-facts{display:grid;grid-template-columns:1fr auto;margin:0}.home-injection-facts div{display:contents}.home-injection-facts dt,.home-injection-facts dd{padding:6px 0;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 50%,transparent)}.home-injection-facts dt{color:var(--rcm-muted);font-size:10px}.home-injection-facts dd{margin:0;font-size:10px;font-weight:700;text-align:right}
.home-disclosure{margin-top:8px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 50%,transparent)}.home-disclosure>summary{display:flex;justify-content:space-between;padding:10px 2px;cursor:pointer;list-style:none;color:var(--rcm-muted);font-size:10px;font-weight:650}.home-disclosure>summary::-webkit-details-marker{display:none}.home-disclosure[open]>summary{color:var(--rcm-text)}.home-disclosure[open]>summary span{transform:rotate(45deg)}.home-disclosure>summary span{font-size:15px;font-weight:400;transition:transform .18s ease-out}.home-disclosure>div{animation:home-reveal .18s cubic-bezier(.22,1,.36,1)}.home-manifest{display:grid;grid-template-columns:repeat(3,1fr);margin:0 0 10px}.home-manifest div{padding:6px 8px}.home-manifest dt{color:var(--rcm-muted);font-size:9px}.home-manifest dd{margin:2px 0 0;font-weight:700}.home-empty{padding:14px 4px;color:var(--rcm-muted);font-size:11px}.home-injection-empty{min-height:116px;display:grid;align-content:center;gap:4px;padding:14px 0;border-block:1px solid color-mix(in srgb,var(--rcm-border) 50%,transparent)}.home-injection-empty strong{font-size:13px}.home-injection-empty p{max-width:34ch;margin:0;color:var(--rcm-muted);font-size:12px;line-height:1.5}
.home-workflow{display:grid;grid-template-columns:minmax(240px,.65fr) minmax(260px,1.6fr) auto;align-items:center;gap:28px;min-height:72px;padding:16px 0 0;margin-top:16px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 58%,transparent)}.home-workflow__copy{display:flex;align-items:center;gap:10px}.home-workflow__icon{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:color-mix(in srgb,var(--rcm-success) 10%,transparent);color:color-mix(in srgb,var(--rcm-success) 68%,var(--rcm-text))}.home-workflow__copy>div{display:grid;gap:2px}.home-workflow__copy strong{font-size:12px}.home-workflow__copy span{color:var(--rcm-muted);font-size:10px}.home-workflow__progress{display:grid;grid-template-columns:minmax(90px,1fr) auto;align-items:center;gap:9px}.home-workflow__steps{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(20px,1fr));gap:6px;height:auto!important;background:transparent!important;overflow:visible!important}.home-workflow__steps i{height:6px;border-radius:999px;background:color-mix(in srgb,var(--rcm-text) 8%,transparent)}.home-workflow__steps i.is-done{background:color-mix(in srgb,var(--rcm-success) 72%,var(--rcm-text))}.home-workflow__progress small{color:var(--rcm-muted);font-size:9px}
@keyframes home-reveal{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:1040px){.shell{grid-template-columns:76px minmax(0,1fr)}.sidebar{padding:18px 10px}.product{justify-content:center;margin-inline:0}.product>span:last-child,.nav button span,.sidebar__chat{display:none}.nav button{justify-content:center;padding:10px}.main{padding-inline:28px}.home-grid{gap:24px}.home-workflow{grid-template-columns:minmax(200px,1fr) minmax(160px,.7fr)}}
@media(max-width:760px){.app{width:100%;max-width:100vw;overflow:hidden;grid-template-rows:54px minmax(0,1fr);padding-bottom:66px}.topbar{padding:0 12px}.topbar__state{display:none}.chat-context strong{max-width:48vw}.chat-context__title{max-width:28vw}.shell{display:block;min-width:0}.sidebar{position:fixed;inset:auto 0 0;z-index:30;height:66px;display:block;padding:7px 8px;border:1px solid color-mix(in srgb,var(--rcm-border) 70%,transparent);border-width:1px 0 0}.product,.sidebar__chat{display:none}.nav{display:grid;grid-template-columns:repeat(5,1fr);min-width:0;gap:2px}.nav button{width:100%;min-height:50px;display:grid;place-items:center;gap:1px;padding:4px;border-radius:7px;font-size:10px}.nav button span{display:block}.nav button[aria-current=page]{box-shadow:none}.main{width:100vw;max-width:100vw;height:100%;overflow-x:hidden;padding:14px 14px 20px}.page,.home-page,.home-grid,.home-section{width:100%;max-width:100%;min-width:0}.secondary-nav{position:sticky;top:-14px;z-index:8;overflow-x:auto;margin:-14px -14px 14px;padding:5px 10px 0;background:var(--rcm-bg)}.secondary-nav button{flex:0 0 auto;min-height:42px}.page[data-tab=overview]{height:auto}.home-page{min-height:0;display:block}.home-heading{margin-bottom:14px}.home-heading h1{font-size:24px}.home-profile{display:none}.home-alerts{gap:8px;margin-bottom:12px}.home-message:not(details),.home-message>summary{grid-template-columns:20px minmax(0,1fr);padding:12px}.home-message__actions,.home-message__disclosure{grid-column:2;width:100%;margin-left:0}.home-message__actions .btn,.home-message__actions select{width:100%;min-height:44px}.home-message__action-link{min-height:44px}.home-message__details{grid-template-columns:1fr;padding:1px 12px 12px 42px}.home-health{margin-bottom:18px}.home-health>summary{padding-inline:12px}.home-health__details{padding-left:12px}.home-metrics{min-width:0;grid-template-columns:repeat(5,minmax(78px,1fr));overflow-x:auto;margin-bottom:24px}.home-metrics>div{display:grid;gap:2px;justify-items:start;min-width:78px;padding-inline:12px}.home-grid{display:block}.home-section{margin-bottom:28px}.home-memory{grid-template-columns:minmax(0,1fr) 14px;min-height:66px;gap:10px}.home-memory__when,.home-memory small{display:none}.home-workflow{grid-template-columns:1fr;margin-top:4px;padding:14px 2px;gap:13px}.home-workflow__progress{padding-left:41px}}
@media(max-width:460px){.chat-context>span[aria-hidden]{display:none}.chat-context strong{max-width:52vw}.chat-context__title{max-width:26vw}.home-heading p{display:none}.home-injection-meta span:last-child{display:none}.home-health__more{display:none}}
@media(max-width:760px){.home-metrics{grid-template-columns:repeat(5,minmax(0,1fr));overflow:visible}.home-metrics>div{min-width:0;padding-inline:8px}.home-metrics span,.home-metrics small{line-height:1.25}.home-metrics strong{font-size:20px}}
:root{font-size:14px}.sidebar{padding-top:18px}.product{margin-bottom:14px}.product small,.sidebar__chat span{font-size:11px}.sidebar__chat strong{font-size:13px}.sidebar__chat small{font-size:12px}.home-eyebrow,.home-profile{font-size:12px}.home-health>summary strong{font-size:14px}.home-health>summary small,.home-health__more{font-size:12px}.home-health__details{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 22px;padding:2px 18px 16px 72px}.home-health__details .status{min-width:0;border:0;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 45%,transparent);border-radius:0;padding:8px 0;background:transparent;color:var(--rcm-text);font-size:12px;font-weight:600}.home-health__details .status svg{width:15px;height:15px}.home-health__details .status--ok svg{color:var(--rcm-success)}.home-health__details .status--warn svg{color:var(--rcm-warning)}.home-health__details .status--error svg{color:var(--rcm-danger)}.home-metrics span{font-size:12px}.home-metrics strong{font-size:23px}.home-metrics small{font-size:11px}.home-section__head h2{font-size:16px}.home-section__head p,.home-link{font-size:12px}.home-memory__when{font-size:11px}.home-memory__copy strong{font-size:13px}.home-memory__copy>span{font-size:12px}.home-memory small{font-size:11px}.home-token span{font-size:12px}.home-injection-meta{font-size:11px}.home-injection-facts dt,.home-injection-facts dd{font-size:12px}.home-disclosure>summary{font-size:12px}.home-manifest dt{font-size:11px}.home-workflow{grid-template-columns:minmax(240px,.65fr) minmax(260px,1.6fr)}.home-workflow__copy strong{font-size:13px}.home-workflow__copy span{font-size:12px}.home-workflow__progress small{font-size:11px}.home-packet-details{margin:10px 0 2px;border-block:1px solid color-mix(in srgb,var(--rcm-border) 52%,transparent)}.home-packet-details>summary{min-height:52px;display:flex;align-items:center;gap:12px;padding:9px 2px;cursor:pointer;list-style:none}.home-packet-details>summary::-webkit-details-marker{display:none}.home-packet-details>summary>span:first-child{min-width:0;display:grid;gap:2px}.home-packet-details>summary strong{font-size:12px}.home-packet-details>summary small{overflow:hidden;color:var(--rcm-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.home-packet-details>summary>span:last-child{margin-left:auto;color:var(--rcm-muted);font-size:16px;font-weight:400;transition:transform .18s ease-out}.home-packet-details[open]>summary>span:last-child{transform:rotate(45deg)}.home-packet-body{margin-bottom:10px;padding:12px 14px;background:color-mix(in srgb,var(--rcm-surface) 52%,transparent);animation:home-reveal .18s cubic-bezier(.22,1,.36,1)}.home-packet-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px;color:var(--rcm-muted);font-size:11px}.home-packet-meta span:first-child{font-weight:650;color:var(--rcm-text)}.home-packet-body pre{max-height:260px;overflow:auto;margin:0;padding:0;border:0;background:transparent;color:var(--rcm-muted);font:12px/1.6 Consolas,ui-monospace,monospace;white-space:pre-wrap}.chat-profile-setting{grid-column:1/-1}.chat-profile-control{justify-self:start;margin-top:1px}.chat-profile-control button{min-width:132px}
@media(max-width:1040px){.sidebar{padding-top:14px}.product{margin-bottom:12px}.home-workflow{grid-template-columns:minmax(200px,1fr) minmax(160px,.7fr)}}
@media(max-width:760px){.sidebar{padding:7px 8px}.nav button{font-size:11px}.home-health__details{grid-template-columns:1fr;padding:2px 12px 14px}.home-workflow{grid-template-columns:1fr}.home-packet-body{padding:11px 12px}.chat-profile-control{width:100%}.chat-profile-control button{flex:1;min-width:0;min-height:44px}}
:root[data-rcm-theme=dark]{color-scheme:dark;--rcm-bg:oklch(.17 .018 255);--rcm-surface:oklch(.205 .02 255);--rcm-selected:oklch(.265 .022 255);--rcm-border:oklch(.34 .025 255);--rcm-accent:oklch(.67 .12 155);--rcm-text:oklch(.94 .012 255);--rcm-muted:oklch(.7 .018 255)}
:root[data-rcm-theme=light]{color-scheme:light;--rcm-bg:oklch(.965 .008 255);--rcm-surface:oklch(.99 .006 255);--rcm-selected:oklch(.92 .018 255);--rcm-border:oklch(.82 .02 255);--rcm-accent:oklch(.5 .13 155);--rcm-text:oklch(.22 .018 255);--rcm-muted:oklch(.48 .02 255)}
.page:has(.people-page),.page:has(.relationships-page){height:calc(100vh - 166px)}
.people-page,.relationships-page{height:100%;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr)}
.people-notice{min-height:48px;display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:10px 13px;border:1px solid color-mix(in srgb,var(--rcm-warning) 55%,var(--rcm-border));border-radius:9px;background:color-mix(in srgb,var(--rcm-warning) 7%,var(--rcm-surface))}.people-notice>svg{color:var(--rcm-warning)}.people-notice>div:not(.people-notice__actions){min-width:0;display:grid;gap:2px}.people-notice span{color:var(--rcm-muted);font-size:11px}.people-notice__actions{margin-left:auto;display:flex;gap:6px}.people-notice.is-error{border-color:color-mix(in srgb,var(--rcm-danger) 55%,var(--rcm-border))}.people-notice.is-error>svg{color:var(--rcm-danger)}
.people-workspace{min-height:0;display:grid;grid-template-columns:minmax(0,1fr);overflow:hidden;border:1px solid color-mix(in srgb,var(--rcm-border) 76%,transparent);border-radius:12px;background:color-mix(in srgb,var(--rcm-surface) 88%,var(--rcm-bg))}.people-workspace.has-selection{grid-template-columns:minmax(300px,34%) minmax(0,66%)}.people-list,.people-detail{min-width:0;min-height:0}.people-list{display:grid;grid-template-rows:auto minmax(0,1fr)}.people-detail{overflow:auto;border-left:1px solid color-mix(in srgb,var(--rcm-border) 68%,transparent);background:color-mix(in srgb,var(--rcm-bg) 74%,var(--rcm-surface))}
.people-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 12px;padding:15px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 58%,transparent)}.people-toolbar>div:first-child{display:flex;align-items:baseline;gap:8px}.people-toolbar h1{margin:0;font-size:20px;letter-spacing:-.025em}.people-toolbar>div:first-child>span{color:var(--rcm-muted);font-size:11px}.people-toolbar__actions{display:flex;gap:6px}.people-search{position:relative;grid-column:1/-1}.people-search>svg{position:absolute;left:11px;top:50%;width:15px;transform:translateY(-50%);color:var(--rcm-muted)}.people-search input{height:40px;padding-left:35px;border-radius:8px;background:color-mix(in srgb,var(--rcm-bg) 72%,var(--rcm-surface))}.people-filters{grid-column:1/-1;display:flex;gap:6px;flex-wrap:wrap}.people-filters button{min-height:32px;border:1px solid color-mix(in srgb,var(--rcm-border) 74%,transparent);border-radius:999px;padding:4px 11px;background:transparent;color:var(--rcm-muted);font-weight:650}.people-filters button:hover{color:var(--rcm-text);background:color-mix(in srgb,var(--rcm-selected) 50%,transparent)}.people-filters button[aria-pressed=true]{border-color:color-mix(in srgb,var(--rcm-accent) 70%,var(--rcm-border));background:color-mix(in srgb,var(--rcm-accent) 12%,var(--rcm-surface));color:var(--rcm-text)}
.people-list__scroll{min-height:0;overflow:auto}.people-group{border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.people-group:last-child{border-bottom:0}.people-group>summary{min-height:46px;display:flex;align-items:center;gap:7px;padding:0 15px;cursor:pointer;list-style:none;background:color-mix(in srgb,var(--rcm-selected) 26%,transparent)}.people-group>summary::-webkit-details-marker{display:none}.people-group>summary::before{content:"›";font-size:18px;color:var(--rcm-muted);transition:transform .16s cubic-bezier(.22,1,.36,1)}.people-group[open]>summary::before{transform:rotate(90deg)}.people-group>summary strong{font-size:13px}.people-group>summary span{color:var(--rcm-muted);font-size:11px}.person-row{width:100%;min-height:64px;display:grid;grid-template-columns:34px minmax(0,1fr) 54px 58px;align-items:center;gap:11px;padding:9px 15px;border:0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 36%,transparent);background:transparent;color:var(--rcm-text);text-align:left}.person-row:hover{background:color-mix(in srgb,var(--rcm-selected) 42%,transparent)}.person-row.is-selected{background:color-mix(in srgb,var(--rcm-accent) 12%,var(--rcm-selected))}.person-monogram,.person-reader__monogram{display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--rcm-border) 70%,transparent);border-radius:50%;background:color-mix(in srgb,var(--rcm-selected) 62%,var(--rcm-surface));font-weight:750}.person-monogram{width:34px;height:34px;font-size:11px}.person-copy{min-width:0;display:grid;gap:3px}.person-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.person-copy small{overflow:hidden;color:var(--rcm-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.person-prominence{width:max-content;padding:2px 6px;border:1px solid color-mix(in srgb,var(--rcm-border) 72%,transparent);border-radius:999px;color:var(--rcm-muted);font-size:10px}.person-relation-count{color:var(--rcm-muted);font-size:10px;text-align:right}.people-empty{padding:32px 16px;color:var(--rcm-muted);text-align:center}
.person-reader,.person-editor{width:min(820px,100%);min-height:100%;margin:0 auto;padding:27px clamp(22px,4vw,52px) 48px}.person-reader__head{display:flex;align-items:center;gap:13px;padding-bottom:22px}.person-reader__head>div:not(.person-reader__actions){min-width:0;display:grid;gap:3px}.person-reader__head>div>span{color:color-mix(in srgb,var(--rcm-accent) 74%,var(--rcm-text));font-size:11px;font-weight:700}.person-reader__head h2{margin:0;font-size:22px;letter-spacing:-.025em}.person-reader__monogram{width:48px;height:48px}.person-reader__actions{margin-left:auto;display:flex;align-items:center;gap:6px}.people-back{display:none;min-width:40px}.person-facts{display:grid;grid-template-columns:2fr 1fr;margin:0;padding:12px 0;border-block:1px solid color-mix(in srgb,var(--rcm-border) 52%,transparent)}.person-facts>div{padding:5px 14px}.person-facts>div:first-child{padding-left:0;border-right:1px solid color-mix(in srgb,var(--rcm-border) 45%,transparent)}.person-facts dt{color:var(--rcm-muted);font-size:10px}.person-facts dd{margin:4px 0 0;font-weight:680}.person-reader__section{padding-top:28px}.person-reader__section>header{display:flex;align-items:center;gap:10px;margin-bottom:8px}.person-reader__section h3{margin:0;font-size:15px}.person-reader__section>header .btn{margin-left:auto}.person-relations{border-top:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.person-relations>button{width:100%;min-height:66px;display:grid;grid-template-columns:minmax(110px,.35fr) minmax(0,1fr);align-items:center;gap:16px;padding:11px 0;border:0;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 38%,transparent);background:transparent;color:var(--rcm-text);text-align:left}.person-relations>button:hover{background:color-mix(in srgb,var(--rcm-selected) 32%,transparent)}.person-relations strong{font-size:12px}.person-relations span{overflow:hidden;color:var(--rcm-muted);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.person-editor__body{display:grid;gap:4px;padding-top:22px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 52%,transparent)}.people-disclosure{margin:8px 0 14px;padding:10px 0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 42%,transparent)}.people-disclosure summary{cursor:pointer;color:var(--rcm-muted);font-size:12px}.people-disclosure code{display:block;margin-top:9px;color:var(--rcm-muted)}
@media(max-width:1040px){.people-workspace.has-selection{grid-template-columns:minmax(0,1fr)}.people-workspace.has-selection .people-list{display:none}.people-detail{border-left:0}.people-back{display:inline-flex}}
@media(max-width:760px){.page:has(.people-page),.page:has(.relationships-page){height:auto}.people-page,.relationships-page{height:auto;display:block}.people-workspace{border:0;border-radius:0;background:transparent}.people-toolbar{padding:2px 0 12px;border-bottom:0}.people-toolbar h1{font-size:19px}.people-toolbar__actions .btn{min-width:44px;padding-inline:10px}.people-search input{height:44px}.people-filters{overflow-x:auto;flex-wrap:nowrap;padding-bottom:2px}.people-filters button{min-height:38px;flex:none}.people-list__scroll{overflow:visible;border-top:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.people-group>summary{padding-inline:2px;background:transparent}.person-row{grid-template-columns:36px minmax(0,1fr) auto;padding-inline:2px}.person-relation-count{display:none}.person-reader,.person-editor{padding:6px 0 28px}.person-reader__head{position:sticky;top:-14px;z-index:9;margin:0 -14px;padding:10px 14px 14px;background:color-mix(in srgb,var(--rcm-bg) 94%,var(--rcm-surface));backdrop-filter:blur(12px)}.person-reader__monogram{display:none}.person-reader__head h2{font-size:18px}.person-reader__actions .btn:first-child{min-width:44px}.person-facts{grid-template-columns:1fr 1fr}.person-reader__section{padding-top:22px}.person-relations>button{grid-template-columns:1fr;padding:12px 0;gap:5px}.person-relations span{white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}.people-notice{align-items:flex-start;flex-wrap:wrap}.people-notice__actions{width:100%;margin-left:27px}.people-notice__actions .btn{flex:1}}
.relationships-page{grid-template-rows:auto minmax(0,1fr)}.relations-toolbar-v2{display:flex;align-items:center;gap:20px;margin-bottom:13px}.relations-toolbar-v2>div:first-child{display:flex;align-items:baseline;gap:8px}.relations-toolbar-v2 h1{margin:0;font-size:23px;letter-spacing:-.035em}.relations-toolbar-v2>div:first-child>span{color:var(--rcm-muted);font-size:11px}.relations-toolbar-v2>.segmented{margin-left:auto}.relations-workspace-v2{min-height:0;display:grid;grid-template-columns:minmax(0,1fr);overflow:hidden;border:1px solid color-mix(in srgb,var(--rcm-border) 76%,transparent);border-radius:12px;background:color-mix(in srgb,var(--rcm-surface) 88%,var(--rcm-bg))}.relations-workspace-v2.has-selection{grid-template-columns:minmax(310px,35%) minmax(0,65%)}.relations-list-v2{min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr)}.relations-filters-v2{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:14px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 56%,transparent)}.relations-filters-v2 label{position:relative}.relations-filters-v2 label svg{position:absolute;left:11px;top:50%;width:15px;transform:translateY(-50%);color:var(--rcm-muted)}.relations-filters-v2 input{height:40px;padding-left:35px;border-radius:8px;background:color-mix(in srgb,var(--rcm-bg) 72%,var(--rcm-surface))}.relations-filters-v2 select{width:auto;min-width:120px;height:40px}.relations-filters-v2>button{grid-column:1/-1;justify-self:start;min-height:32px;border:1px solid color-mix(in srgb,var(--rcm-border) 72%,transparent);border-radius:999px;padding:4px 11px;background:transparent;color:var(--rcm-muted);font-weight:650}.relations-filters-v2>button[aria-pressed=true]{border-color:color-mix(in srgb,var(--rcm-accent) 70%,var(--rcm-border));background:color-mix(in srgb,var(--rcm-accent) 12%,var(--rcm-surface));color:var(--rcm-text)}.relations-list-v2__scroll{min-height:0;overflow:auto}.relation-group-v2{border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 46%,transparent)}.relation-group-v2:last-child{border-bottom:0}.relation-group-v2>summary{min-height:44px;display:flex;align-items:center;gap:7px;padding:0 14px;cursor:pointer;list-style:none;background:color-mix(in srgb,var(--rcm-selected) 25%,transparent)}.relation-group-v2>summary::-webkit-details-marker{display:none}.relation-group-v2>summary::before{content:"›";font-size:18px;color:var(--rcm-muted);transition:transform .16s ease-out}.relation-group-v2[open]>summary::before{transform:rotate(90deg)}.relation-group-v2>summary span{color:var(--rcm-muted);font-size:11px}.relation-row-v2{width:100%;min-height:82px;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:12px 14px;border:0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 34%,transparent);background:transparent;color:var(--rcm-text);text-align:left}.relation-row-v2:hover{background:color-mix(in srgb,var(--rcm-selected) 42%,transparent)}.relation-row-v2.is-selected{background:color-mix(in srgb,var(--rcm-accent) 11%,var(--rcm-selected))}.relation-row-v2__main{min-width:0;display:grid;gap:5px}.relation-row-v2__main strong{font-size:13px}.relation-row-v2__main i,.relation-reader-v2 h2 i{color:var(--rcm-muted);font-style:normal}.relation-row-v2__main small{overflow:hidden;color:var(--rcm-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.relation-row-v2__main small .canonical-copy{display:none}.relation-row-v2__signals{display:grid;justify-items:end;gap:2px}.relation-row-v2__signals span{color:var(--rcm-muted);font-size:9px}.relation-row-v2__signals b{color:var(--rcm-text);font-weight:650}.relations-detail-v2{min-width:0;min-height:0;overflow:auto;border-left:1px solid color-mix(in srgb,var(--rcm-border) 64%,transparent);background:color-mix(in srgb,var(--rcm-bg) 76%,var(--rcm-surface))}.relation-reader-v2{width:min(840px,100%);min-height:100%;margin:0 auto;padding:25px clamp(22px,4vw,48px) 48px}.relation-reader-v2>header,.relation-editor-v2>header{display:flex;align-items:center;gap:12px;padding-bottom:20px}.relation-reader-v2>header>div:nth-child(2),.relation-editor-v2>header>div:first-child{min-width:0;display:grid;gap:3px}.relation-reader-v2>header span,.relation-editor-v2>header span{color:color-mix(in srgb,var(--rcm-accent) 74%,var(--rcm-text));font-size:11px;font-weight:700}.relation-reader-v2 h2,.relation-editor-v2 h2{margin:0;font-size:21px;letter-spacing:-.025em}.relation-reader-v2__actions{margin-left:auto;display:flex;gap:6px}.relations-back{display:none;min-width:40px}.relation-summary-v2{padding:16px 0 20px;border-block:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.relation-summary-v2 p{margin:0;font-size:15px;line-height:1.7}.relation-summary-v2 .canonical-copy{display:block;margin-top:6px;color:var(--rcm-muted);font-size:12px}.relation-summary-v2 ul{margin:12px 0 0;padding-left:18px;color:var(--rcm-muted);font-size:12px}.relation-axis-v2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 28px;padding:25px 0}.relation-axis-v2__item{display:grid;grid-template-columns:minmax(74px,.45fr) minmax(60px,1fr) auto;align-items:center;gap:10px}.relation-axis-v2__item>span{display:flex;justify-content:space-between;gap:6px}.relation-axis-v2__item b{font-size:12px}.relation-axis-v2__item small{color:var(--rcm-muted);font-size:9px}.relation-axis-v2__item>div{height:4px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--rcm-text) 8%,transparent)}.relation-axis-v2__item>div i{display:block;height:100%;border-radius:inherit;background:color-mix(in srgb,var(--rcm-accent) 68%,var(--rcm-text))}.relation-axis-v2__item>strong{min-width:50px;font-size:10px;text-align:right}.relation-axis-v2__item[data-override=true]>strong::after{content:" · 수정";color:var(--rcm-muted);font-weight:500}.relation-section-v2{padding:22px 0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.relation-section-v2>header{display:flex;align-items:center;gap:8px;margin-bottom:8px}.relation-section-v2 h3{margin:0;font-size:14px}.relation-section-v2>header>span{color:var(--rcm-muted);font-size:11px}.relation-section-v2>header>.btn{margin-left:auto}.relation-change-v2,.milestone-v2{display:grid;gap:7px;padding:13px 0;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 36%,transparent)}.relation-change-v2:last-child,.milestone-v2:last-child{border-bottom:0}.relation-change-v2>div,.milestone-v2>div{display:flex;align-items:center;gap:7px}.relation-change-v2 span,.milestone-v2 span{padding:2px 6px;border-radius:999px;background:color-mix(in srgb,var(--rcm-selected) 52%,transparent);font-size:10px}.relation-change-v2 small,.milestone-v2 small{margin-left:auto;color:var(--rcm-muted);font-size:10px}.relation-change-v2 p,.milestone-v2 p{margin:0;color:var(--rcm-muted);font-size:12px;line-height:1.6}.milestone-v2>div:last-child .btn{margin-left:auto}.relation-disclosure-v2{border-top:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.relation-disclosure-v2>summary{min-height:46px;display:flex;align-items:center;cursor:pointer;color:var(--rcm-muted);font-size:12px;font-weight:650}.relation-disclosure-v2[open]>summary{color:var(--rcm-text)}.relation-disclosure-v2>div{padding:4px 0 18px}.relation-baseline-v2{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.relation-baseline-v2 span{display:grid;gap:3px;padding:8px;background:color-mix(in srgb,var(--rcm-selected) 30%,transparent);font-size:11px}.relation-baseline-v2 b{color:var(--rcm-muted);font-size:9px}.relations-empty{padding:36px 16px;color:var(--rcm-muted);text-align:center}.relation-editor-v2{padding:0}.relation-editor-v2>header .actions{margin-left:auto}.relation-intimacy-form,.social-editor-v2{margin:10px 0 18px;padding:16px;border-radius:9px;background:color-mix(in srgb,var(--rcm-selected) 28%,transparent)}
.social-workspace-v2{min-height:0;overflow:auto;border:1px solid color-mix(in srgb,var(--rcm-border) 76%,transparent);border-radius:12px;background:color-mix(in srgb,var(--rcm-surface) 88%,var(--rcm-bg))}.social-workspace-v2>header{display:flex;align-items:center;gap:12px;padding:15px 17px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 52%,transparent)}.social-workspace-v2>header>div:first-child{display:flex;align-items:baseline;gap:8px}.social-workspace-v2 h2{margin:0;font-size:18px}.social-workspace-v2>header span{color:var(--rcm-muted);font-size:11px}.social-workspace-v2>header .actions{margin-left:auto}.social-editor-v2{margin:16px}.social-list-v2{padding:0 17px}.social-group-v2{border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 44%,transparent)}.social-group-v2>summary{min-height:46px;display:flex;align-items:center;gap:7px;cursor:pointer;list-style:none}.social-group-v2>summary::-webkit-details-marker{display:none}.social-group-v2>summary::before{content:"›";font-size:17px;color:var(--rcm-muted)}.social-group-v2[open]>summary::before{transform:rotate(90deg)}.social-group-v2>summary span{color:var(--rcm-muted);font-size:11px}.social-group-v2 article{display:grid;grid-template-columns:minmax(150px,.4fr) minmax(0,1fr) auto;align-items:center;gap:16px;min-height:62px;padding:10px 2px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 32%,transparent)}.social-group-v2 article>div:first-child{display:grid;gap:3px}.social-group-v2 article>div:first-child span,.social-group-v2 article p{color:var(--rcm-muted);font-size:11px}.social-group-v2 article p{margin:0}.social-group-v2 article>div:last-child{display:flex;gap:4px}.social-workspace-v2>.relation-disclosure-v2{margin:8px 17px 0}.merge-preview{margin-top:14px;padding:14px;border-radius:8px;background:color-mix(in srgb,var(--rcm-warning) 7%,var(--rcm-surface))}
@media(max-width:1040px){.relations-workspace-v2.has-selection{grid-template-columns:minmax(0,1fr)}.relations-workspace-v2.has-selection .relations-list-v2{display:none}.relations-detail-v2{border-left:0}.relations-back{display:inline-flex}}
@media(max-width:760px){.relations-toolbar-v2{align-items:flex-start;flex-wrap:wrap;margin-bottom:12px}.relations-toolbar-v2 h1{font-size:20px}.relations-toolbar-v2>.segmented{width:100%;margin-left:0}.relations-toolbar-v2>.segmented button{flex:1;min-height:40px}.relations-workspace-v2,.social-workspace-v2{border:0;border-radius:0;background:transparent}.relations-filters-v2{grid-template-columns:minmax(0,1fr) auto;padding:0 0 12px;border-bottom:0}.relations-filters-v2 input,.relations-filters-v2 select{height:44px}.relations-list-v2__scroll{overflow:visible;border-top:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.relation-group-v2>summary{padding-inline:2px;background:transparent}.relation-row-v2{grid-template-columns:minmax(0,1fr);padding-inline:2px}.relation-row-v2__signals{display:flex;justify-content:flex-start;gap:7px}.relations-detail-v2{overflow:visible}.relation-reader-v2{padding:0 0 30px}.relation-reader-v2>header,.relation-editor-v2>header{position:sticky;top:-14px;z-index:9;margin:0 -14px;padding:10px 14px 14px;background:color-mix(in srgb,var(--rcm-bg) 94%,var(--rcm-surface));backdrop-filter:blur(12px)}.relation-reader-v2 h2,.relation-editor-v2 h2{font-size:17px}.relation-reader-v2__actions>.btn{min-height:44px}.relation-axis-v2{grid-template-columns:1fr;gap:14px;padding-block:22px}.relation-summary-v2{padding-top:14px}.relation-baseline-v2{grid-template-columns:repeat(2,minmax(0,1fr))}.social-workspace-v2>header{padding:6px 0 12px}.social-editor-v2{margin:8px 0 16px;padding:14px 10px}.social-list-v2{padding:0}.social-group-v2 article{grid-template-columns:minmax(0,1fr) auto;gap:6px 12px}.social-group-v2 article p{grid-column:1/-1;grid-row:2}.social-workspace-v2>.relation-disclosure-v2{margin-inline:0}.relation-intimacy-form .formgrid,.social-editor-v2.formgrid{grid-template-columns:1fr}}
.page:has(.timeline-page){height:calc(100vh - 166px)}.timeline-page{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr)}.timeline-page>.pagehead{margin-bottom:14px}.timeline-split{height:auto;min-height:0;display:grid;grid-template-columns:minmax(300px,34%) minmax(0,66%);overflow:hidden;border:1px solid color-mix(in srgb,var(--rcm-border) 76%,transparent);border-radius:12px;background:var(--rcm-surface)}
.timeline-split .split__list{min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);border-right:1px solid color-mix(in srgb,var(--rcm-border) 72%,transparent);background:color-mix(in srgb,var(--rcm-surface) 88%,var(--rcm-bg))}.timeline-split .split__detail{min-height:0;overflow:hidden;background:color-mix(in srgb,var(--rcm-bg) 76%,var(--rcm-surface))}.timeline-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px 12px;padding:14px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 64%,transparent)}.timeline-toolbar .search{grid-column:1/-1}.timeline-toolbar .search input{border-radius:8px;background:color-mix(in srgb,var(--rcm-bg) 72%,var(--rcm-surface))}.timeline-count{align-self:center;color:var(--rcm-muted);font-size:12px;font-variant-numeric:tabular-nums}.timeline-filters{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}.timeline-filters button{min-height:30px;border:1px solid color-mix(in srgb,var(--rcm-border) 75%,transparent);border-radius:999px;padding:4px 10px;background:transparent;color:var(--rcm-muted);font-size:12px;font-weight:650}.timeline-filters button:hover{color:var(--rcm-text);background:color-mix(in srgb,var(--rcm-selected) 55%,transparent)}.timeline-filters button[aria-pressed=true]{border-color:color-mix(in srgb,var(--rcm-accent) 70%,var(--rcm-border));background:color-mix(in srgb,var(--rcm-accent) 13%,var(--rcm-surface));color:var(--rcm-text)}
.timeline-split .rows{min-height:0;max-height:none;overflow:auto}.timeline-split .row{min-height:86px;gap:7px;padding:13px 15px;border-bottom-color:color-mix(in srgb,var(--rcm-border) 48%,transparent);transition:background .16s ease-out}.timeline-split .row:hover{background:color-mix(in srgb,var(--rcm-selected) 42%,transparent)}.timeline-split .row.is-selected{background:color-mix(in srgb,var(--rcm-selected) 74%,var(--rcm-surface))}.timeline-split .row__top{justify-content:space-between}.timeline-split .row__top strong{font-size:13px;letter-spacing:-.015em}.row__signals{display:flex;align-items:center;gap:5px}.memory-signal{color:color-mix(in srgb,var(--rcm-accent) 74%,var(--rcm-text));font-size:10px;font-weight:700}.memory-signal--pin,.memory-signal--inactive{padding:2px 5px;border:1px solid color-mix(in srgb,var(--rcm-border) 70%,transparent);border-radius:999px;color:var(--rcm-muted);font-size:9px}.timeline-split .row__meta{font-size:11px}.timeline-split .row__body{-webkit-line-clamp:1;font-size:12px}.capsule-children{border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.capsule-children>summary{padding:8px 15px;color:var(--rcm-muted);font-size:11px;cursor:pointer}.capsule-children .row{padding-left:28px;background:color-mix(in srgb,var(--rcm-bg) 24%,transparent)}.timeline-empty{display:grid;place-items:center;align-content:center;gap:5px;min-height:220px;padding:24px;text-align:center;color:var(--rcm-muted)}.timeline-empty strong{color:var(--rcm-text)}
.memory-reader{height:100%;min-height:0;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;background:transparent}.memory-reader__head{grid-row:1;z-index:2;display:flex;align-items:flex-start;gap:18px;padding:20px 24px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 58%,transparent);background:color-mix(in srgb,var(--rcm-surface) 62%,var(--rcm-bg))}.memory-reader__title{min-width:0;flex:1;display:grid;gap:5px}.memory-reader__title>span{color:color-mix(in srgb,var(--rcm-accent) 72%,var(--rcm-text));font-size:11px;font-weight:720}.memory-reader__title h2{margin:0;font-size:20px;line-height:1.35;letter-spacing:-.025em}.memory-reader__meta{display:flex;flex-wrap:wrap;gap:6px 12px;color:var(--rcm-muted);font-size:11px}.memory-reader__actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}.memory-view-switch{padding:3px;border-color:color-mix(in srgb,var(--rcm-border) 70%,transparent);background:transparent}.memory-view-switch button{min-height:30px}.memory-back{display:none;border:0;padding:3px;background:transparent;color:var(--rcm-muted);font-weight:650}.memory-reader__body{grid-row:3;min-height:0;overflow:auto;padding:30px clamp(24px,5vw,64px)}.memory-reading,.memory-compare{max-width:760px;margin:0 auto}.memory-reading p,.memory-compare p{margin:0;font-size:16px;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere}.memory-compare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));max-width:960px;border:1px solid color-mix(in srgb,var(--rcm-border) 64%,transparent);border-radius:10px;overflow:hidden}.memory-compare article{min-width:0;padding:22px}.memory-compare article+article{border-left:1px solid color-mix(in srgb,var(--rcm-border) 64%,transparent)}.memory-compare h3{margin:6px 0 15px;font-size:16px}.memory-compare p{font-size:14px;line-height:1.75}.memory-reading__label{color:var(--rcm-muted);font-size:11px;font-weight:700}.memory-translation-state{max-width:760px;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 auto 18px;padding:10px 12px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 55%,transparent);color:var(--rcm-muted);font-size:12px}.memory-key-dialogue,.memory-section,.memory-editor{max-width:760px;margin:30px auto 0}.memory-key-dialogue{padding-top:24px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 52%,transparent)}.memory-key-dialogue h3{margin:0 0 12px;font-size:13px}.memory-key-dialogue blockquote{margin:0;padding:13px 0;border:0;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 45%,transparent)}.memory-key-dialogue blockquote strong{font-size:11px;color:var(--rcm-muted)}.memory-key-dialogue blockquote p{margin:4px 0 0;line-height:1.65}.memory-copy__canonical{display:block;margin-top:6px;color:var(--rcm-muted);font-weight:400;line-height:1.55}.memory-section{margin-top:14px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 52%,transparent)}.memory-section+.memory-section{margin-top:0}.memory-section>summary{min-height:42px;display:flex;align-items:center;cursor:pointer;color:var(--rcm-muted);font-size:12px;font-weight:650}.memory-section[open]>summary{color:var(--rcm-text)}.memory-section details{padding:10px 0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 42%,transparent)}.memory-section p{line-height:1.65}.memory-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0 0 10px}.memory-facts div{padding:8px 10px}.memory-facts dt{color:var(--rcm-muted);font-size:10px}.memory-facts dd{margin:4px 0 0;font-weight:700}.memory-inactive{grid-row:2;display:flex;align-items:center;gap:8px;padding:9px 24px;background:color-mix(in srgb,var(--rcm-warning) 8%,transparent);color:var(--rcm-muted);font-size:12px}.memory-inactive svg{color:var(--rcm-warning)}.memory-editor{margin-top:0}.memory-editor__advanced{margin:10px 0 18px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 55%,transparent);padding-top:12px}.memory-editor__advanced summary{cursor:pointer;color:var(--rcm-muted);font-weight:650}.memory-editor__advanced[open]>summary{margin-bottom:14px}.memory-reader__pager{grid-row:4;min-height:58px;display:flex;align-items:center;justify-content:space-between;padding:10px 24px 12px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 52%,transparent)}.memory-reader__pager .btn{border:0;background:transparent;color:var(--rcm-muted)}.memory-reader__mobile-actions{display:none}.memory-actions-menu{position:relative}.memory-actions-menu>summary{list-style:none}.memory-actions-menu>summary::-webkit-details-marker{display:none}.memory-actions-menu__items{position:absolute;right:0;z-index:10;min-width:190px;display:grid;gap:4px;margin-top:5px;padding:7px;border:1px solid var(--rcm-border);border-radius:8px;background:var(--rcm-surface);box-shadow:0 16px 38px color-mix(in srgb,oklch(.08 .01 255) 34%,transparent)}.memory-actions-menu__items .btn{width:100%;justify-content:flex-start;background:transparent}.memory-actions-menu__items .btn:hover{background:var(--rcm-selected)}
@media(max-width:1040px) and (min-width:761px){.timeline-split{grid-template-columns:320px minmax(0,1fr)}.memory-reader__head{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:18px}.memory-reader__actions{grid-row:1;max-width:none;justify-content:flex-end}.memory-reader__title{grid-row:2}.memory-reader__body{padding:24px}.memory-compare{grid-template-columns:1fr}.memory-compare article+article{border-left:0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 64%,transparent)}}
@media(max-width:760px){.page:has(.timeline-page){height:auto}.timeline-page{height:auto;display:block}.timeline-page>.pagehead{margin-bottom:12px}.timeline-split{display:block;border:0;border-radius:0;background:transparent}.timeline-split .split__list{display:grid;border:0;background:transparent}.timeline-split .split__detail{display:none;overflow:visible;background:transparent}.timeline-page.is-mobile-detail>.pagehead{display:none}.timeline-page.is-mobile-detail .split__list{display:none}.timeline-page.is-mobile-detail .split__detail{display:block}.timeline-toolbar{padding:0 0 12px;border:0}.timeline-filters{justify-content:flex-start}.timeline-filters button{min-height:36px}.timeline-split .rows{max-height:none;overflow:visible;border-top:1px solid color-mix(in srgb,var(--rcm-border) 55%,transparent)}.timeline-split .row{min-height:88px;padding-inline:4px}.capsule-children>summary{padding-inline:4px}.capsule-children .row{padding-left:18px}.memory-reader{height:auto;display:block}.memory-reader__head{position:sticky;top:-14px;z-index:12;align-items:center;gap:10px;margin:0 -14px;padding:10px 14px;background:color-mix(in srgb,var(--rcm-bg) 94%,var(--rcm-surface));backdrop-filter:blur(12px)}.memory-back{min-width:44px;min-height:44px;display:inline-flex;align-items:center;gap:4px}.memory-reader__title>span,.memory-reader__meta{display:none}.memory-reader__title h2{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.memory-reader__actions{display:none}.memory-reader.is-editing .memory-reader__title{display:none}.memory-reader.is-editing .memory-reader__actions{display:flex;flex:none;margin-left:auto;gap:6px}.memory-reader.is-editing .memory-reader__actions .btn{min-height:44px;padding-inline:11px}.memory-reader__body{overflow:visible;padding:24px 2px 108px}.memory-reading p{font-size:15px;line-height:1.85}.memory-compare{display:block;border:0}.memory-compare article{padding:16px 0}.memory-compare article+article{border-left:0;border-top:1px solid var(--rcm-border)}.memory-key-dialogue{margin-top:24px}.memory-section{margin-top:12px}.memory-facts{grid-template-columns:repeat(2,minmax(0,1fr))}.memory-editor .formgrid{grid-template-columns:1fr}.memory-reader__pager{padding:8px 0 18px}.memory-reader__mobile-actions{position:fixed;inset:auto 0 66px;z-index:20;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;padding:8px 12px calc(8px + env(safe-area-inset-bottom));border-top:1px solid color-mix(in srgb,var(--rcm-border) 65%,transparent);background:color-mix(in srgb,var(--rcm-bg) 94%,var(--rcm-surface));backdrop-filter:blur(12px)}.memory-reader__mobile-actions>.btn,.memory-reader__mobile-actions>.memory-actions-menu>.btn{width:100%;min-height:44px}.memory-reader__mobile-actions .memory-actions-menu__items{position:fixed;right:12px;bottom:122px}.memory-compare-toggle{display:none}.memory-inactive{margin-inline:-14px;padding-inline:16px}.memory-reader.is-editing .memory-reader__pager,.memory-reader.is-editing .memory-reader__mobile-actions{display:none}}
@media(max-width:760px){.memory-reader__body{padding-bottom:24px}.memory-reader__pager{margin-bottom:calc(72px + env(safe-area-inset-bottom))}.memory-reader.is-editing .memory-reader__body{padding-bottom:24px}}
.record-menu--icon{flex:0 0 auto}.record-menu--icon>summary{width:34px;height:34px;padding:7px}.record-actions .btn--icon{width:34px;height:34px;padding:7px}.person-prominence,.person-relation-count{min-height:24px;display:inline-flex;align-items:center;justify-content:center;padding:3px 8px;border:1px solid color-mix(in srgb,var(--rcm-border) 72%,transparent);border-radius:999px;color:var(--rcm-muted);font-size:11px;font-weight:650;white-space:nowrap}.person-row{grid-template-columns:34px minmax(0,1fr) 58px 72px}.people-disclosure{margin:8px 0 0;padding:0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 42%,transparent)}.people-disclosure>summary{min-height:44px;display:flex;align-items:center}.disclosure-form-body{padding:4px 0 16px}.disclosure-form-body .field:last-child{margin-bottom:0}.person-management{width:min(820px,100%);min-height:100%;margin:0 auto;padding:27px clamp(22px,4vw,52px) 48px}.merge-form{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto;align-items:end;gap:12px}.merge-form .field{margin:0}.merge-form__arrow{align-self:center;margin-top:18px;color:var(--rcm-muted);font-size:18px}.relation-edit-stack{display:grid;gap:0}.milestone-management{margin-top:22px}.milestone-editor-row{min-height:58px;display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 36%,transparent)}.milestone-editor-row:last-child{border-bottom:0}.milestone-editor-row>div:first-child{min-width:0;display:grid;gap:4px}.milestone-editor-row small{color:var(--rcm-muted);font-size:10px}.milestone-editor-row .record-actions{margin-left:auto}.milestone-v2__head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.milestone-v2__meta{margin-left:auto!important}.social-workspace-v2{display:grid;grid-template-columns:minmax(0,1fr)}.social-workspace-v2.has-editor{grid-template-columns:minmax(310px,38%) minmax(0,62%)}.social-master-v2{min-width:0;min-height:0;overflow:auto}.social-master-v2>header{display:flex;align-items:center;gap:12px;padding:15px 17px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 52%,transparent)}.social-master-v2>header>div:first-child{display:flex;align-items:baseline;gap:8px}.social-master-v2>header .actions{margin:0 0 0 auto}.social-master-v2>header .actions>.btn--icon,.social-master-v2>header .record-menu--icon{flex:0 0 34px}.social-detail-v2{min-width:0;border-left:1px solid color-mix(in srgb,var(--rcm-border) 64%,transparent);background:color-mix(in srgb,var(--rcm-bg) 76%,var(--rcm-surface))}.social-editor-v2{width:min(720px,100%);margin:0 auto;padding:25px clamp(22px,4vw,48px);border-radius:0;background:transparent}.social-editor-v2>header{display:flex;align-items:center;gap:12px;padding-bottom:20px}.social-editor-v2>header>div:first-child{min-width:0;display:grid;gap:3px}.social-editor-v2>header span{color:color-mix(in srgb,var(--rcm-accent) 74%,var(--rcm-text));font-size:11px;font-weight:700}.social-editor-v2>header h2{margin:0;font-size:20px}.social-editor-v2>header .actions{margin:0 0 0 auto}.social-direction{display:grid!important;grid-template-columns:auto auto minmax(0,1fr);align-items:center;gap:6px!important}.social-direction>span{color:var(--rcm-muted);font-size:11px}.social-direction>i{color:var(--rcm-accent);font-style:normal}.social-direction>strong{font-size:12px}.social-direction>em{grid-column:1/-1;color:var(--rcm-muted);font-size:10px;font-style:normal}.social-group-v2:last-child{border-bottom:0}.relation-intimacy-form .actions{justify-content:flex-end}.relationship-editor.relation-editor-v2{padding-bottom:4px}
@media(max-width:1040px){.social-workspace-v2.has-editor{grid-template-columns:minmax(0,1fr)}.social-workspace-v2.has-editor .social-master-v2{display:none}.social-detail-v2{border-left:0}}
@media(max-width:760px){.btn--icon,.record-menu--icon>summary,.record-actions .btn--icon{width:44px;height:44px;min-width:44px;padding:11px}.person-row{grid-template-columns:36px minmax(0,1fr) auto}.person-management{padding:6px 0 28px}.person-management>.person-reader__head{position:sticky;top:-14px;z-index:9;margin:0 -14px;padding:10px 14px 14px;background:color-mix(in srgb,var(--rcm-bg) 94%,var(--rcm-surface));backdrop-filter:blur(12px)}.merge-form{grid-template-columns:1fr}.merge-form__arrow{display:none}.milestone-v2__meta{width:100%;margin-left:0!important}.social-direction{grid-template-columns:auto auto minmax(0,1fr)}.memory-reader__mobile-actions{display:flex;align-items:center;justify-content:flex-end}.memory-reader__mobile-actions>.btn:not(.btn--icon){width:auto;margin-right:auto}.memory-reader__mobile-actions>.btn--icon,.memory-reader__mobile-actions>.memory-actions-menu{width:44px;flex:0 0 44px}.memory-reader__mobile-actions>.memory-actions-menu>.btn{width:44px}.memory-reader.is-editing .memory-reader__actions .btn--icon{width:44px;padding:11px}}
`;

const interactionStyles = `
/* Shared interaction contracts: selection, icon actions, readable ledgers, and restrained motion. */
.segmented button[aria-selected=true]{background:var(--rcm-selected);color:var(--rcm-text);box-shadow:inset 0 -2px color-mix(in srgb,var(--rcm-accent) 76%,var(--rcm-text))}
.view-switch{padding:3px;border-color:color-mix(in srgb,var(--rcm-border) 70%,transparent);background:transparent}.view-switch button{min-height:30px}.view-switch button[aria-pressed=true],.view-switch button[aria-selected=true]{background:var(--rcm-selected);color:var(--rcm-text);box-shadow:none}
.detail-back.btn,.memory-back,.relations-back{width:44px;height:44px;min-width:44px;min-height:44px;flex:0 0 44px;border:0;border-radius:8px;padding:0;background:transparent;color:var(--rcm-muted);font-size:24px;font-weight:400;line-height:1}.detail-back:hover,.memory-back:hover,.relations-back:hover{background:color-mix(in srgb,var(--rcm-selected) 58%,transparent);color:var(--rcm-text)}.memory-back span{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.btn--icon,.record-menu--icon>summary,.record-actions .btn--icon{width:34px;height:34px;min-width:34px;min-height:34px;flex:0 0 34px;padding:7px}
.person-row__chips{display:flex;min-width:0;align-items:center;justify-content:flex-end;gap:5px;white-space:nowrap}.person-row{grid-template-columns:34px minmax(0,1fr) auto}
.person-importance{min-width:0;margin:0 0 11px;padding:0;border:0}.person-importance legend{margin-bottom:5px;color:var(--rcm-muted);font-size:12px;font-weight:600}.person-importance>div{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px;padding:3px;border:1px solid var(--rcm-border);border-radius:8px;background:var(--rcm-bg)}.person-importance label{position:relative;min-width:0}.person-importance input{position:absolute;width:1px;height:1px;margin:-1px;opacity:0}.person-importance span{min-height:34px;display:grid;place-items:center;border-radius:6px;color:var(--rcm-muted);font-size:12px;font-weight:650;cursor:pointer}.person-importance input:checked+span{background:var(--rcm-selected);color:var(--rcm-text)}.person-importance input:focus-visible+span{outline:2px solid var(--rcm-accent);outline-offset:2px}
.social-master-v2{display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden}.social-filters-v2{grid-template-columns:minmax(0,1fr) auto}.social-filter-actions{display:flex;align-items:center;gap:6px}.social-filter-actions .record-menu{flex:0 0 auto}.social-list-v2{min-height:0;padding:0;overflow:auto}.social-group-v2{border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 46%,transparent)}.social-group-v2>summary{min-height:44px;padding:0 14px;background:color-mix(in srgb,var(--rcm-selected) 25%,transparent)}.social-group-v2>summary::before{font-size:18px}.social-group-v2>.social-row-v2{min-height:82px;padding:12px 14px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 34%,transparent)}.social-row-v2:hover{background:color-mix(in srgb,var(--rcm-selected) 42%,transparent)}.social-row-v2 .record-actions{justify-content:flex-end;flex-wrap:nowrap}.social-row-v2 .record-actions .btn{flex:none}
.person-row,.relation-row-v2,.social-row-v2{transition:background-color .16s cubic-bezier(.22,1,.36,1),color .16s cubic-bezier(.22,1,.36,1)}
.people-group>summary::before,.relation-group-v2>summary::before,.social-group-v2>summary::before{transition:transform .16s cubic-bezier(.22,1,.36,1)}
@keyframes ledger-row-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}
.people-group[open] .person-row,.relation-group-v2[open] .relation-row-v2,.social-group-v2[open] .social-row-v2{animation:ledger-row-in .16s cubic-bezier(.22,1,.36,1) both}
@media(min-width:761px){.relations-toolbar-v2>div:first-child>span,.relation-group-v2>summary span,.social-group-v2>summary span{font-size:12px}.relation-row-v2__main strong{font-size:14px}.relation-row-v2__main small{font-size:12px}.relation-row-v2__signals span{font-size:11px}.relation-reader-v2>header span,.relation-editor-v2>header span,.social-editor-v2>header span{font-size:12px}.relation-axis-v2__item b{font-size:13px}.relation-axis-v2__item small{font-size:11px}.relation-axis-v2__item>strong{font-size:12px}.relation-change-v2 span,.milestone-v2 span{font-size:11px}.relation-change-v2 small,.milestone-v2 small{font-size:11px}.relation-change-v2 p,.milestone-v2 p{font-size:13px}.social-direction>span,.social-group-v2 article p{font-size:12px}.social-direction>strong{font-size:14px}.social-direction>em{font-size:11px}}
@media(max-width:760px){.btn--icon,.record-menu--icon>summary,.record-actions .btn--icon{width:44px;height:44px;min-width:44px;min-height:44px;flex-basis:44px;padding:11px}.person-row{grid-template-columns:36px minmax(0,1fr) auto;gap:8px}.person-row__chips{gap:4px}.person-prominence,.person-relation-count{padding-inline:6px}.person-relation-count{display:inline-flex}.person-editor .people-back,.person-management .people-back,.memory-reader.is-editing .memory-back{display:none}.person-reader:not(.person-editor){padding-bottom:108px}.person-reader>.person-reader__head>.person-reader__actions,.relation-reader-v2>header>.relation-reader-v2__actions{position:fixed;right:12px;bottom:66px;z-index:20;display:flex;align-items:center;gap:7px;padding:8px 0 calc(8px + env(safe-area-inset-bottom))}.person-reader>.person-reader__head>.person-reader__actions::before,.relation-reader-v2>header>.relation-reader-v2__actions::before{content:"";position:fixed;right:0;bottom:66px;left:0;z-index:-1;height:calc(60px + env(safe-area-inset-bottom));border-top:1px solid color-mix(in srgb,var(--rcm-border) 65%,transparent);background:color-mix(in srgb,var(--rcm-bg) 94%,var(--rcm-surface));backdrop-filter:blur(12px)}.person-reader>.person-reader__head>.person-reader__actions .btn,.person-reader>.person-reader__head>.person-reader__actions .record-menu>summary,.relation-reader-v2>header>.relation-reader-v2__actions .btn,.relation-reader-v2>header>.relation-reader-v2__actions .record-menu>summary,.memory-reader__mobile-actions>.btn--icon,.memory-reader__mobile-actions>.record-menu--icon>summary{border-color:transparent;background:transparent}.person-reader>.person-reader__head>.person-reader__actions .record-menu__items,.relation-reader-v2>header>.relation-reader-v2__actions .record-menu__items{top:auto;right:0;bottom:52px;margin:0}.relation-reader-v2{padding-bottom:108px}.social-master-v2{overflow:visible}.social-filters-v2{padding-bottom:12px}.social-list-v2{overflow:visible;border-top:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.social-group-v2>summary{padding-inline:2px;background:transparent}.social-group-v2>.social-row-v2{padding:12px 2px}}
@media(max-width:760px){.person-reader>.person-reader__head,.relation-reader-v2>header{backdrop-filter:none}}
@media(min-width:761px){.main:has(.timeline-page),.main:has(.people-page){overflow:hidden}}
@media(max-width:760px){.main,.people-detail{overflow-x:hidden}.person-reader,.person-editor,.relation-reader-v2{padding-left:6px;padding-right:6px}.main .btn--icon:not(.btn--primary),.main .record-menu--icon>summary,.main .btn--icon.btn--primary{border-color:transparent}.person-importance span{min-height:44px}.milestone-v2__meta{width:auto;margin-left:auto!important;white-space:nowrap}}
.page:has(.world-page){height:calc(100vh - 118px)}.world-page{height:100%;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr)}.world-tabs{width:100%}
.world-workspace{min-height:0;display:grid;grid-template-columns:minmax(0,1fr);overflow:hidden;border:1px solid color-mix(in srgb,var(--rcm-border) 76%,transparent);border-radius:12px;background:color-mix(in srgb,var(--rcm-surface) 88%,var(--rcm-bg))}.world-workspace.has-detail{grid-template-columns:minmax(330px,38%) minmax(0,62%)}.world-list{min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr)}.world-toolbar{display:grid;gap:10px;padding:14px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 56%,transparent)}.world-toolbar__title{display:flex;align-items:baseline;gap:8px}.world-toolbar__title h1{margin:0;font-size:19px;letter-spacing:-.025em}.world-toolbar__title>span{color:var(--rcm-muted);font-size:11px}.world-toolbar__title>.btn{margin-left:auto}.world-search-line{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}.world-search{position:relative;min-width:0}.world-search svg{position:absolute;left:11px;top:50%;width:15px;transform:translateY(-50%);color:var(--rcm-muted)}.world-search input{height:40px;padding-left:35px;border-radius:8px;background:color-mix(in srgb,var(--rcm-bg) 72%,var(--rcm-surface))}.world-holder{width:clamp(168px,21vw,238px);height:40px;border-radius:8px}.world-filters{display:flex;align-items:center;gap:6px;overflow-x:auto}.world-filters button{min-height:30px;flex:none;border:1px solid color-mix(in srgb,var(--rcm-border) 72%,transparent);border-radius:999px;padding:4px 10px;background:transparent;color:var(--rcm-muted);font-weight:650}.world-filters button[aria-pressed=true]{border-color:color-mix(in srgb,var(--rcm-accent) 70%,var(--rcm-border));background:color-mix(in srgb,var(--rcm-accent) 12%,var(--rcm-surface));color:var(--rcm-text)}.world-list__scroll{min-height:0;overflow:auto}.world-group{border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 46%,transparent)}.world-group:last-child{border-bottom:0}.world-group>header{min-height:42px;display:flex;align-items:center;gap:7px;padding:0 14px;background:color-mix(in srgb,var(--rcm-selected) 25%,transparent)}.world-group>header strong{min-width:0;overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.world-group>header span{color:var(--rcm-muted);font-size:11px}.world-flat-list .world-row:first-child{border-top:0}.world-row{width:100%;min-height:78px;display:grid;grid-template-columns:34px minmax(0,1fr) 12px;align-items:center;gap:11px;padding:11px 14px;border:0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 34%,transparent);background:transparent;color:var(--rcm-text);text-align:left}.world-row:hover{background:color-mix(in srgb,var(--rcm-selected) 42%,transparent)}.world-row.is-selected{background:color-mix(in srgb,var(--rcm-accent) 11%,var(--rcm-selected))}.world-row__mark{width:34px;height:34px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--rcm-border) 65%,transparent);border-radius:50%;background:color-mix(in srgb,var(--rcm-selected) 58%,var(--rcm-surface));color:var(--rcm-muted);font-size:11px;font-weight:750}.world-row__mark svg{width:15px}.world-row__mark.is-promise{color:color-mix(in srgb,var(--rcm-warning) 72%,var(--rcm-text))}.world-row__copy{min-width:0;display:grid;gap:3px}.world-row__copy>span{min-width:0;display:flex;align-items:center;gap:7px}.world-row__copy strong{min-width:0;overflow:hidden;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.world-row__copy em{flex:none;max-width:48%;overflow:hidden;padding:2px 6px;border-radius:999px;background:color-mix(in srgb,var(--rcm-selected) 52%,transparent);color:var(--rcm-muted);font-size:10px;font-style:normal;text-overflow:ellipsis;white-space:nowrap}.world-row__copy p{margin:0;overflow:hidden;color:var(--rcm-muted);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.world-row__copy small{color:var(--rcm-muted);font-size:10px}.world-row>span:last-child{color:var(--rcm-muted);font-size:18px}.world-empty{padding:36px 16px;color:var(--rcm-muted);text-align:center}
.world-detail{min-width:0;min-height:0;overflow:auto;border-left:1px solid color-mix(in srgb,var(--rcm-border) 64%,transparent);background:color-mix(in srgb,var(--rcm-bg) 76%,var(--rcm-surface))}.world-reader,.world-editor,.world-delete{width:min(820px,100%);min-height:100%;margin:0 auto;padding:25px clamp(22px,4vw,48px) 48px}.world-reader>header,.world-editor>header{display:flex;align-items:center;gap:12px;padding-bottom:20px}.world-reader>header>div:nth-child(2),.world-editor>header>div:nth-child(2){min-width:0;display:grid;gap:3px}.world-reader__kicker,.world-editor>header span{color:color-mix(in srgb,var(--rcm-accent) 74%,var(--rcm-text));font-size:11px;font-weight:700}.world-reader h2,.world-editor h2,.world-delete h2{margin:0;font-size:21px;letter-spacing:-.025em}.world-reader>header p{margin:0;color:var(--rcm-muted);font-size:11px}.world-reader__actions{margin-left:auto;display:flex;align-items:center;gap:6px}.world-back{display:none;width:44px;height:44px;min-width:44px;border:0;border-radius:8px;padding:0;background:transparent;color:var(--rcm-muted);font-size:24px}.world-back:hover{background:color-mix(in srgb,var(--rcm-selected) 58%,transparent);color:var(--rcm-text)}.world-copy{padding:22px 0;border-block:1px solid color-mix(in srgb,var(--rcm-border) 50%,transparent);font-size:16px;font-weight:650;line-height:1.8;white-space:pre-wrap}.world-copy .canonical-copy,.world-copy>small{display:block;margin-top:8px;color:var(--rcm-muted);font-size:12px;font-weight:400;line-height:1.6}.world-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0;padding:15px 0}.world-meta>div{padding:2px 13px}.world-meta>div:first-child{padding-left:0}.world-meta>div+div{border-left:1px solid color-mix(in srgb,var(--rcm-border) 40%,transparent)}.world-meta dt{color:var(--rcm-muted);font-size:10px}.world-meta dd{margin:4px 0 0;font-size:13px;font-weight:680}.world-related{display:grid;gap:5px;margin-top:22px;padding:13px 14px;border-radius:8px;background:color-mix(in srgb,var(--rcm-accent) 8%,var(--rcm-surface))}.world-related span{color:var(--rcm-muted);font-size:10px}.world-related strong{font-size:12px;line-height:1.55}.world-disclosures{margin-top:18px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 46%,transparent)}.world-disclosure+.world-disclosure{border-top:1px solid color-mix(in srgb,var(--rcm-border) 46%,transparent)}.world-disclosure>summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--rcm-muted);font-size:12px;font-weight:650}.world-disclosure[open]>summary{color:var(--rcm-text)}.world-disclosure>div{padding:2px 0 16px}.world-disclosure p{margin:0;color:var(--rcm-muted);line-height:1.6}.world-history-row{display:grid;gap:4px;padding:11px 0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 34%,transparent)}.world-history-row:first-child{border-top:0}.world-history-row small{color:var(--rcm-muted);font-size:10px}.world-history-row strong{font-size:12px}.world-history-row p{font-size:12px}.world-editor__body{padding-top:22px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 50%,transparent)}.world-editor textarea{min-height:120px}.world-editor .world-disclosure{margin-top:8px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 46%,transparent)}.world-delete{display:grid;align-content:center;justify-items:start}.world-delete>p{color:var(--rcm-muted)}
@media(max-width:1040px){.world-workspace.has-detail{grid-template-columns:minmax(0,1fr)}.world-workspace.has-detail.show-detail .world-list{display:none}.world-workspace.has-detail:not(.show-detail) .world-detail{display:none}.world-detail{border-left:0}.world-back{display:inline-grid;place-items:center}}
@media(min-width:761px){.main:has(.world-page){overflow:hidden}.world-row__copy strong{font-size:14px}.world-row__copy p{font-size:13px}.world-reader__kicker,.world-editor>header span{font-size:12px}}
@media(max-width:760px){.page:has(.world-page){height:auto}.world-page{height:auto;display:block}.world-tabs{position:sticky;top:-14px;z-index:8;width:auto;overflow-x:auto;margin:-14px -14px 14px;padding:5px 10px 0;background:var(--rcm-bg)}.world-tabs button{flex:0 0 auto;min-height:42px}.world-workspace{border:0;border-radius:0;background:transparent}.world-toolbar{padding:0 0 12px;border-bottom:0}.world-toolbar__title h1{font-size:19px}.world-search-line{grid-template-columns:minmax(0,1fr)}.world-search input,.world-holder{width:100%;height:44px}.world-filters button{min-height:36px}.world-list__scroll{overflow:visible;border-top:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.world-group>header{padding-inline:2px;background:transparent}.world-row{min-height:82px;padding-inline:2px}.world-row__copy p{white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}.world-detail{overflow:visible}.world-page.is-mobile-detail>.world-tabs{display:none}.world-reader,.world-editor,.world-delete{padding:0 4px 104px}.world-reader>header,.world-editor>header{position:sticky;top:-14px;z-index:9;margin:0 -14px;padding:10px 14px 14px;background:color-mix(in srgb,var(--rcm-bg) 94%,var(--rcm-surface))}.world-reader h2,.world-editor h2{font-size:17px}.world-reader>header p{display:none}.world-reader__actions{position:fixed;right:12px;bottom:66px;z-index:20;padding:8px 0 calc(8px + env(safe-area-inset-bottom))}.world-reader__actions::before{content:"";position:fixed;right:0;bottom:66px;left:0;z-index:-1;height:calc(60px + env(safe-area-inset-bottom));border-top:1px solid color-mix(in srgb,var(--rcm-border) 65%,transparent);background:color-mix(in srgb,var(--rcm-bg) 94%,var(--rcm-surface))}.world-reader__actions .btn{border-color:transparent;background:transparent}.world-copy{padding-block:19px;font-size:15px}.world-meta{grid-template-columns:repeat(2,minmax(0,1fr))}.world-meta>div{padding:7px 10px}.world-meta>div:nth-child(3){grid-column:1/-1;padding-left:0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 40%,transparent);border-left:0}.world-editor>header>.world-back{display:none}.world-editor .world-reader__actions{position:static;margin-left:auto;padding:0}.world-editor .world-reader__actions::before{content:none}.world-editor__body{padding-top:18px}.world-editor .formgrid{grid-template-columns:1fr}.world-delete{min-height:60vh;padding-inline:4px}}
/* One page grammar: section navigation, page heading, then a bordered work surface. */
.people-page__intro>.pagehead,.world-page>.pagehead{margin-bottom:14px}.people-toolbar{grid-template-columns:auto minmax(0,1fr);align-items:center}.people-search{grid-column:1/-1}.people-toolbar__count{color:var(--rcm-muted);font-size:11px;font-weight:650}.people-filters{grid-column:auto;justify-content:flex-end;flex-wrap:nowrap;overflow-x:auto}.relationships-page>.relations-toolbar-v2{min-height:auto;display:flex;align-items:flex-start;gap:20px;margin-bottom:14px}.relationships-page>.relations-toolbar-v2>.pagehead__copy{display:block}.relationships-page>.relations-toolbar-v2 h1{margin:0 0 3px;font-size:20px;line-height:1.3;letter-spacing:normal}.relationships-page>.relations-toolbar-v2>.pagehead__copy p{display:block}.relations-toolbar-v2>.pagehead__actions{margin-left:auto}.relations-toolbar-v2>.pagehead__actions .segmented{margin:0}
.page:has(.world-page){height:calc(100vh - 110px)}.world-page{grid-template-rows:auto auto minmax(0,1fr)}.world-toolbar{grid-template-columns:auto minmax(0,1fr);align-items:center}.world-search-line{grid-column:1/-1}.world-toolbar__count{color:var(--rcm-muted);font-size:11px;font-weight:650}.world-filters{justify-content:flex-end}
/* A single overview disclosure reveals both the manifest and its read-only packet. */
.home-packet-details{margin:10px 0 2px;border-block:1px solid color-mix(in srgb,var(--rcm-border) 52%,transparent)}.home-packet-details>header{min-height:52px;display:flex;align-items:center;padding:9px 2px}.home-packet-details>header>span{min-width:0;display:grid;gap:2px}.home-packet-details>header strong{font-size:12px}.home-packet-details>header small{overflow:hidden;color:var(--rcm-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}
/* Timeline disclosures reuse the same quiet hierarchy as the story reader. */
.memory-section>summary,.memory-subsection>summary{list-style:none}.memory-section>summary::-webkit-details-marker,.memory-subsection>summary::-webkit-details-marker{display:none}.memory-section>summary{min-height:48px;gap:8px;font-size:13px;font-weight:700}.memory-section>summary>span{min-width:0}.memory-section>summary>small{margin-left:auto;color:var(--rcm-muted);font-size:10px;font-weight:650}.memory-section>summary::after{content:"›";margin-left:4px;color:var(--rcm-muted);font-size:18px;font-weight:400;transition:transform .16s cubic-bezier(.22,1,.36,1)}.memory-section[open]>summary::after{transform:rotate(90deg)}.memory-section:has(>.memory-subsection)[open]{position:relative;padding-bottom:7px}.memory-section:has(>.memory-subsection)[open]::before{content:"";position:absolute;top:56px;bottom:13px;left:4px;width:1px;background:color-mix(in srgb,var(--rcm-border) 62%,transparent)}.memory-section>.memory-subsection{margin-left:20px;padding:0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 34%,transparent)}.memory-subsection>summary{min-height:52px;display:flex;align-items:center;gap:10px;padding:0 3px;color:var(--rcm-text);font-size:12px;font-weight:650;cursor:pointer}.memory-subsection>summary::before{content:"";width:5px;height:5px;flex:0 0 5px;border-radius:50%;background:color-mix(in srgb,var(--rcm-muted) 72%,var(--rcm-bg))}.memory-subsection>summary>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.memory-subsection>summary>small{margin-left:auto;color:var(--rcm-muted);font-size:10px;font-weight:500;white-space:nowrap}.memory-subsection>summary::after{content:"+";color:var(--rcm-muted);font-size:15px;font-weight:400;transition:transform .16s cubic-bezier(.22,1,.36,1)}.memory-subsection[open]>summary::before{background:var(--rcm-accent)}.memory-subsection[open]>summary::after{transform:rotate(45deg)}.memory-subsection>p,.memory-subsection>blockquote{margin:0 3px 16px 18px;color:var(--rcm-muted);font-size:12px;line-height:1.7;white-space:pre-wrap}.memory-subsection>blockquote{padding:12px 14px;border:0;border-radius:8px;background:color-mix(in srgb,var(--rcm-selected) 30%,transparent)}.memory-subsection>.muted{display:block;margin:-8px 3px 16px 18px;font-size:10px}
@media(max-width:760px){.people-page__intro>.pagehead,.world-page>.pagehead{margin-bottom:12px}.people-page.is-mobile-detail>.people-page__intro,.world-page.is-mobile-detail>.pagehead{display:none}.people-toolbar{grid-template-columns:auto minmax(0,1fr);padding-top:0}.people-toolbar__count{align-self:center}.world-tabs{margin-bottom:0}.world-toolbar{grid-template-columns:auto minmax(0,1fr);padding-top:0}.world-toolbar__count{align-self:center}.world-filters{justify-content:flex-start}.relationships-page>.relations-toolbar-v2{align-items:center;flex-wrap:wrap}.relationships-page>.relations-toolbar-v2>.pagehead__copy p{display:none}.relations-toolbar-v2>.pagehead__actions{width:100%;margin-left:0}.relations-toolbar-v2>.pagehead__actions .segmented{width:100%}.relations-toolbar-v2>.pagehead__actions .segmented button{flex:1;min-height:40px}.memory-reader__head{align-items:center;padding-right:calc(20px + env(safe-area-inset-right))}.memory-reader__title{flex:1}.memory-reader__mobile-actions{position:static;inset:auto;z-index:auto;flex:0 0 auto;display:flex;align-items:center;gap:4px;margin-left:auto;padding:0;border:0;background:transparent;backdrop-filter:none}.memory-mobile-view-switch{flex:0 0 auto;padding:3px}.memory-mobile-view-switch button{min-width:43px;min-height:36px;padding-inline:8px}.memory-reader__mobile-actions>.btn--icon,.memory-reader__mobile-actions>.memory-actions-menu,.memory-reader__mobile-actions>.memory-actions-menu>summary{width:44px;height:44px;min-width:44px;min-height:44px;flex-basis:44px}.memory-reader__mobile-actions>.memory-actions-menu{padding:0}.memory-reader__mobile-actions>.btn--icon,.memory-reader__mobile-actions>.memory-actions-menu>summary{padding:11px;border-color:var(--rcm-border);background:var(--rcm-surface)}.memory-reader__mobile-actions>.btn--icon:hover,.memory-reader__mobile-actions>.memory-actions-menu>summary:hover{background:var(--rcm-selected)}.memory-reader__mobile-actions .memory-actions-menu__items{position:absolute;top:calc(100% + 6px);right:0;bottom:auto}.memory-reader__body{padding-bottom:28px}.memory-reader.is-editing .memory-reader__mobile-actions{display:none}.memory-subsection>summary{min-height:54px}.memory-subsection>summary>span{white-space:normal}.memory-section>summary{min-height:50px}}
@media(prefers-reduced-motion:reduce){.people-group[open] .person-row,.relation-group-v2[open] .relation-row-v2,.social-group-v2[open] .social-row-v2{animation:none}}
`;

const storyStyles = `
.page:has(.story-page){height:calc(100vh - 118px);padding:0}.main:has(.story-page){overflow:hidden}.story-page{height:100%;min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--rcm-bg)}
.story-toolbar{min-height:72px;display:flex;align-items:center;gap:18px;padding:12px clamp(24px,4vw,52px);border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 58%,transparent)}.story-toolbar>div:first-child{min-width:0}.story-toolbar h1{margin:0;font-size:23px;line-height:1.2;letter-spacing:-.04em}.story-toolbar p{margin:4px 0 0;color:var(--rcm-muted);font-size:12px}.story-toolbar__actions{display:flex;align-items:center;gap:7px;margin-left:auto}.story-language button{min-width:54px}.story-toolbar .record-menu{flex:none}.story-toolbar .record-menu__items{min-width:190px}
.story-workspace{min-width:0;min-height:0;display:grid;grid-template-columns:minmax(0,1fr);overflow:hidden}.story-page.has-index .story-workspace{grid-template-columns:286px minmax(0,1fr)}
.story-index{min-width:0;min-height:0;display:grid;grid-template-rows:auto auto minmax(0,1fr);border-right:1px solid color-mix(in srgb,var(--rcm-border) 66%,transparent);background:color-mix(in srgb,var(--rcm-surface) 80%,var(--rcm-bg));animation:story-index-in .18s cubic-bezier(.22,1,.36,1) both}.story-index>header{min-height:66px;display:flex;align-items:center;gap:10px;padding:10px 13px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 56%,transparent)}.story-index>header>div{min-width:0;flex:1}.story-index>header strong{display:block;font-size:14px}.story-index>header span{display:block;margin-top:2px;color:var(--rcm-muted);font-size:11px}.story-index__back{display:none;width:44px;height:44px;border:0;background:transparent;color:var(--rcm-muted);font-size:24px}.story-index__search{position:relative;display:block;margin:13px}.story-index__search svg{position:absolute;top:50%;left:11px;width:15px;transform:translateY(-50%);color:var(--rcm-muted)}.story-index__search input{height:40px;padding-left:35px;border-radius:8px;background:color-mix(in srgb,var(--rcm-bg) 72%,var(--rcm-surface))}.story-index__list{min-width:0;min-height:0;overflow:auto;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--rcm-border) 70%,transparent) transparent}.story-index__row{min-height:80px;width:100%;display:grid;grid-template-columns:30px minmax(0,1fr) 17px;align-items:center;gap:9px;padding:11px 13px;border:0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent);background:transparent;color:var(--rcm-text);text-align:left;transition:background-color .16s cubic-bezier(.22,1,.36,1)}.story-index__row:hover{background:color-mix(in srgb,var(--rcm-selected) 46%,transparent)}.story-index__row.is-selected{background:color-mix(in srgb,var(--rcm-accent) 11%,var(--rcm-selected))}.story-index__row>span:first-child{color:var(--rcm-muted);font-size:10px;font-variant-numeric:tabular-nums}.story-index__row>span:nth-child(2){min-width:0}.story-index__row small,.story-index__row em{display:block;overflow:hidden;color:var(--rcm-muted);font-size:10px;font-style:normal;text-overflow:ellipsis;white-space:nowrap}.story-index__row strong{display:block;margin:3px 0;overflow:hidden;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.story-index__row strong small{display:inline;margin-left:5px}.story-index__row>b{color:var(--rcm-muted);font-size:18px}.story-index__empty{min-height:160px}
.story-reader{min-width:0;min-height:0;display:grid;grid-template-rows:minmax(0,1fr) auto;overflow:hidden}.story-reader__scroll{height:100%;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--rcm-border) 70%,transparent) transparent}
.story-summary{width:min(1120px,calc(100% - 64px));display:grid;grid-template-columns:minmax(0,1.8fr) minmax(250px,.9fr);gap:clamp(32px,5vw,72px);margin:0 auto;padding:30px 0 24px}.story-summary h2{margin:0 0 9px;font-size:13px}.story-summary p,.story-summary li{margin:0;color:var(--rcm-muted);font-size:13px;line-height:1.75}.story-summary p>span,.story-summary li>span{display:block}.story-canonical{display:block;margin-top:7px;color:var(--rcm-muted);font-size:11px;font-weight:400;line-height:1.65}.story-summary__remaining{padding-left:clamp(22px,3vw,42px);border-left:1px solid color-mix(in srgb,var(--rcm-border) 58%,transparent)}.story-summary__remaining ul{margin:0;padding-left:17px}.story-summary__remaining li+li{margin-top:5px}
.story-rail-wrap{width:min(1160px,calc(100% - 44px));display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:14px;margin:0 auto;padding:8px 0 26px}.story-rail{position:relative;min-width:0;display:grid;grid-template-columns:repeat(4,minmax(120px,1fr))}.story-rail::before{content:"";position:absolute;top:12px;right:12.5%;left:12.5%;height:1px;background:color-mix(in srgb,var(--rcm-border) 82%,transparent)}.story-stop{position:relative;min-width:0;display:grid;justify-items:center;gap:2px;padding:0 10px;border:0;background:transparent;color:var(--rcm-muted)}.story-stop i{z-index:1;width:11px;height:11px;margin:7px 0 8px;border:2px solid var(--rcm-bg);border-radius:50%;background:color-mix(in srgb,var(--rcm-muted) 65%,var(--rcm-bg));box-shadow:0 0 0 1px color-mix(in srgb,var(--rcm-border) 82%,transparent);transition:transform .17s cubic-bezier(.22,1,.36,1),background-color .17s ease}.story-stop strong{overflow:hidden;max-width:100%;color:var(--rcm-muted);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.story-stop strong small{display:none}.story-stop small{font-size:10px}.story-stop:hover i{transform:scale(1.18)}.story-stop.is-selected i{background:var(--rcm-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--rcm-accent) 14%,transparent),0 0 0 4px var(--rcm-accent)}.story-stop.is-selected strong{color:var(--rcm-accent)}.story-all{padding-inline:9px;border-color:transparent;font-size:11px}.story-all span{font-size:16px}
.story-chapter{width:min(1060px,calc(100% - 64px));margin:0 auto;padding:34px 0 54px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 60%,transparent);animation:story-reader-in .19s cubic-bezier(.22,1,.36,1) both}.story-chapter>header{display:flex;align-items:flex-end;gap:20px}.story-chapter>header>div:first-child{min-width:0}.story-chapter>header>div>span{display:block;color:var(--rcm-accent);font-size:12px;font-weight:760;letter-spacing:.04em}.story-chapter h2{margin:7px 0 0;font-size:clamp(30px,3.1vw,42px);font-weight:760;line-height:1.08;letter-spacing:-.055em}.story-chapter h2 small{margin-left:8px;color:var(--rcm-muted);font-size:.4em;font-weight:520;letter-spacing:-.01em}.story-chapter>header p{margin:9px 0 0;color:var(--rcm-muted);font-size:11px}.story-chapter>header>div:last-child{display:flex;gap:5px;margin-left:auto}.story-chapter>header>div:last-child .btn{width:34px;height:34px;min-width:34px;min-height:34px;padding:0;border-color:transparent;font-size:21px}
.story-reading{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(310px,.85fr);gap:clamp(44px,7vw,92px);padding:28px 0 30px}.story-prose>p{max-width:68ch;margin:0;color:color-mix(in srgb,var(--rcm-text) 78%,var(--rcm-muted));font-size:16px;line-height:1.9;white-space:pre-wrap;word-break:keep-all}.story-prose>p>span{display:block}.story-prose .story-canonical{margin-top:14px;padding-top:13px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent);font-size:12px;line-height:1.75}.story-beats{margin:0;padding:0;list-style:none}.story-beats li{position:relative;min-height:63px;display:grid;grid-template-columns:28px minmax(0,1fr);gap:11px;padding-bottom:16px}.story-beats li:not(:last-child)::after{content:"";position:absolute;top:27px;bottom:0;left:13px;width:1px;background:color-mix(in srgb,var(--rcm-border) 66%,transparent)}.story-beats li>span{z-index:1;width:28px;height:28px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--rcm-border) 90%,transparent);border-radius:50%;background:var(--rcm-bg);color:var(--rcm-accent);font-size:10px;font-weight:720}.story-beats p{margin:2px 0 0;color:var(--rcm-muted);font-size:13px;line-height:1.65}.story-beats p>span{display:block}.story-beats .story-canonical{margin-top:4px;font-size:11px}
.story-disclosures{border-top:1px solid color-mix(in srgb,var(--rcm-border) 52%,transparent)}.story-disclosures>details+details{border-top:1px solid color-mix(in srgb,var(--rcm-border) 42%,transparent)}.story-disclosures>details>summary{min-height:46px;display:flex;align-items:center;color:var(--rcm-muted);font-size:12px;font-weight:650;cursor:pointer}.story-disclosures>details[open]>summary{color:var(--rcm-text)}.story-disclosures>details>div{padding:2px 0 18px}.story-disclosures section,.story-disclosures details details{padding:10px 0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 36%,transparent)}.story-disclosures h4{margin:0 0 5px;font-size:12px}.story-disclosures p,.story-disclosures li{color:var(--rcm-muted);font-size:12px;line-height:1.65}.story-disclosures ol{margin:7px 0 0;padding-left:18px}
.story-memories{padding-top:22px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 55%,transparent)}.story-memories h3{margin:0 0 12px;font-size:13px}.story-memories h3 span{margin-left:4px;color:var(--rcm-muted);font-size:11px;font-weight:520}.story-memory-track{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 18px}.story-memory{min-width:0}.story-memory>button{position:relative;width:100%;min-height:72px;display:grid;grid-template-columns:12px minmax(0,1fr);align-content:center;gap:1px 7px;padding:9px 0;border:0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 50%,transparent);background:transparent;color:var(--rcm-text);text-align:left}.story-memory>button::before{content:"";position:absolute;top:14px;right:-18px;left:7px;height:1px;background:color-mix(in srgb,var(--rcm-border) 58%,transparent)}.story-memory:last-child>button::before{right:calc(100% - 7px)}.story-memory>button i{z-index:1;grid-row:1/4;width:8px;height:8px;margin-top:1px;border:2px solid var(--rcm-bg);border-radius:50%;background:var(--rcm-muted);box-shadow:0 0 0 1px var(--rcm-muted)}.story-memory.is-open>button i{background:var(--rcm-accent);box-shadow:0 0 0 1px var(--rcm-accent)}.story-memory>button small,.story-memory>button span{color:var(--rcm-muted);font-size:10px}.story-memory>button strong{overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.story-memory.is-open{grid-column:1/-1}.story-memory__preview{display:grid;grid-template-columns:minmax(160px,.42fr) minmax(0,1fr) auto;align-items:center;gap:20px;padding:15px 17px;border:1px solid color-mix(in srgb,var(--rcm-border) 70%,transparent);border-radius:8px;background:color-mix(in srgb,var(--rcm-surface) 78%,var(--rcm-bg));animation:story-reader-in .17s cubic-bezier(.22,1,.36,1) both}.story-memory__preview strong{display:block;font-size:13px}.story-memory__preview small{display:block;margin-top:3px;color:var(--rcm-muted);font-size:10px}.story-memory__preview p{margin:0;color:var(--rcm-muted);font-size:12px;line-height:1.65}.story-memory__preview .btn{border-color:transparent;color:var(--rcm-accent);font-size:11px;white-space:nowrap}.story-memory__preview svg{width:14px}.story-memory-empty{margin:0;color:var(--rcm-muted);font-size:12px}
.story-pager{width:min(1060px,calc(100% - 64px));display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:0 auto;padding:12px 0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 50%,transparent);background:var(--rcm-bg)}.story-pager button{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:8px 0;border:0;background:transparent;color:var(--rcm-muted);text-align:left}.story-pager button:last-child{text-align:right}.story-pager small{grid-column:1;font-size:10px}.story-pager strong{overflow:hidden;color:var(--rcm-text);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.story-pager strong small{display:none}.story-pager b{grid-column:2;grid-row:1/3;align-self:center;font-size:18px}.story-empty{min-height:260px;display:grid;place-items:center;align-content:center;gap:5px;padding:24px;color:var(--rcm-muted);text-align:center}.story-empty strong{color:var(--rcm-text)}
.page:has(.story-page){height:calc(100vh - 166px)}
.story-page>.pagehead{margin-bottom:14px}.story-page>.pagehead .record-menu{flex:none}.story-page>.pagehead .story-language button{min-width:54px}
.story-stop{align-content:start}.story-stop strong{min-height:32px;display:-webkit-box;overflow:hidden;white-space:normal;text-align:center;line-height:1.35;-webkit-box-orient:vertical;-webkit-line-clamp:2}.story-all{display:inline-flex;align-items:center;justify-content:center;gap:9px;background:transparent!important}.story-all:hover{background:color-mix(in srgb,var(--rcm-selected) 42%,transparent)!important}.story-chapter>header>div:last-child .btn{background:transparent}.story-chapter>header>div:last-child .btn:hover{background:color-mix(in srgb,var(--rcm-selected) 42%,transparent)}
.story-disclosures>details>summary{display:grid;grid-template-columns:minmax(0,1fr) auto 18px;gap:8px}.story-disclosures>details>summary small{min-width:22px;color:var(--rcm-muted);font-size:10px;text-align:right}.story-disclosures>details>summary::after{content:"›";justify-self:end;font-size:18px;transform:rotate(90deg);transition:transform .16s cubic-bezier(.22,1,.36,1)}.story-disclosures>details[open]>summary::after{transform:rotate(-90deg)}.story-disclosures>details>div{padding:0 0 18px}
.story-flow{display:grid!important;grid-template-columns:minmax(110px,.28fr) minmax(0,1fr);gap:9px 22px;padding:16px 0!important;border-top:1px solid color-mix(in srgb,var(--rcm-border) 36%,transparent)!important}.story-flow:first-child{border-top:0!important}.story-flow>header{display:grid;align-content:start;gap:3px}.story-flow>header span{font-size:12px;font-weight:720}.story-flow>header small{color:var(--rcm-muted);font-size:10px}.story-flow>p{margin:0!important;line-height:1.7}.story-flow>ol{grid-column:2;margin:2px 0 0!important;padding:0!important;list-style:none}.story-flow>ol li{display:grid;grid-template-columns:20px minmax(0,1fr);gap:9px;padding:7px 0}.story-flow>ol i{width:20px;height:20px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--rcm-border) 76%,transparent);border-radius:50%;color:var(--rcm-accent);font-size:9px;font-style:normal}
.story-segment{padding:0!important}.story-segment>summary{min-height:48px;display:grid!important;grid-template-columns:28px minmax(0,1fr) 18px;align-items:center;gap:10px;padding:0!important}.story-segment>summary>span{color:var(--rcm-muted);font-size:10px;font-variant-numeric:tabular-nums}.story-segment>summary>strong{overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.story-segment>summary>strong small{display:none}.story-segment>summary>b{justify-self:end;color:var(--rcm-muted);font-size:18px;transform:rotate(90deg);transition:transform .16s cubic-bezier(.22,1,.36,1)}.story-segment[open]>summary>b{transform:rotate(-90deg)}.story-segment>div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 18px;padding:0 0 15px 38px!important}.story-segment>div p{margin:0!important}.story-segment>div small{align-self:end;color:var(--rcm-muted);font-size:10px;white-space:nowrap}
.story-memory.is-open{grid-column:auto}.story-memory-previews{margin-top:12px}.story-memory__preview{grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:18px;padding:16px 0;border:0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 45%,transparent);border-radius:0;background:transparent}.story-memory__preview p{font-size:13px;line-height:1.75}.story-memory__preview .btn{align-self:center}.story-memory__preview[hidden]{display:none}.story-pager strong{grid-column:1;grid-row:2}
@keyframes story-index-in{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}@keyframes story-reader-in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:1040px){.story-page.has-index .story-workspace{grid-template-columns:minmax(0,1fr)}.story-page.has-index .story-reader{display:none}.story-index{border-right:0}.story-index__back{display:block}.story-index__close{display:none}.story-reading{grid-template-columns:minmax(0,1fr);gap:28px}.story-memory__preview{grid-template-columns:minmax(150px,.38fr) minmax(0,1fr)}.story-memory__preview .btn{grid-column:2;justify-self:start}}
@media(max-width:760px){.page:has(.story-page){height:auto;padding:0}.main:has(.story-page){overflow-x:hidden;overflow-y:auto}.story-page{height:auto;display:block}.story-page>.pagehead{align-items:center}.story-page>.pagehead__actions{gap:4px}.story-page>.pagehead .story-language button{min-width:48px;min-height:36px;padding-inline:9px}.story-page>.pagehead .record-menu__items{position:fixed;right:12px;bottom:76px;left:12px}.story-workspace{display:block;overflow:visible}.story-index{min-height:calc(100vh - 184px);margin:0 -14px}.story-index>header{min-height:58px;padding-inline:10px}.story-index__search{margin:10px 12px}.story-index__search input{height:44px}.story-index__list{overflow:visible}.story-reader{display:block;overflow:visible}.story-reader__scroll{height:auto;overflow:visible}.story-summary{width:100%;grid-template-columns:minmax(0,1fr);gap:17px;padding:21px 0 17px}.story-summary p,.story-summary li{font-size:13px;line-height:1.7}.story-summary__remaining{padding:15px 0 0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 50%,transparent);border-left:0}.story-rail-wrap{width:calc(100% + 28px);display:block;margin-inline:-14px;padding:4px 0 18px}.story-rail{display:flex;overflow-x:auto;padding:0 14px 7px;scrollbar-width:none;scroll-snap-type:x proximity}.story-rail::-webkit-scrollbar{display:none}.story-rail::before{right:14px;left:14px}.story-stop{min-width:148px;scroll-snap-align:center}.story-all{min-height:38px;margin:4px 14px 0 auto}.story-chapter{width:100%;padding:26px 0 94px}.story-chapter>header{align-items:center}.story-chapter h2{font-size:29px}.story-chapter h2 small{display:block;margin:5px 0 0;font-size:12px}.story-chapter>header>div:last-child{display:none}.story-reading{gap:27px;padding:22px 0 25px}.story-prose>p{font-size:15px;line-height:1.85}.story-flow{grid-template-columns:minmax(0,1fr);gap:8px}.story-flow>ol{grid-column:1}.story-segment>div{grid-template-columns:minmax(0,1fr);padding-left:38px!important}.story-memory-track{grid-template-columns:minmax(0,1fr)}.story-memory>button{min-height:68px}.story-memory>button::before{right:calc(100% - 7px)}.story-memory__preview{grid-template-columns:minmax(0,1fr);gap:11px;padding:14px 0}.story-memory__preview .btn{grid-column:auto;justify-self:start;min-height:38px;padding:0}.story-pager{position:sticky;bottom:0;z-index:7;width:calc(100% + 28px);margin:28px -14px 0;padding:10px 14px calc(10px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--rcm-bg) 96%,var(--rcm-surface))}.story-compare-toggle{display:none}}
@media(max-width:430px){.story-language button{min-width:43px;padding-inline:7px;font-size:11px}.story-chapter h2{font-size:27px}.story-pager{gap:12px}}
@media(min-width:761px){.story-memory__preview{grid-template-columns:minmax(0,1fr) auto}.story-memory__preview .btn{grid-column:auto;justify-self:end}}
@media(max-width:760px){.story-page>.pagehead .pagehead__actions{gap:4px}}
.story-segment{display:grid!important;gap:8px;padding:14px 0!important;border-top:1px solid color-mix(in srgb,var(--rcm-border) 36%,transparent)!important}.story-segment:first-child{border-top:0!important}.story-segment>header{display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:baseline;gap:10px}.story-segment>header>span{color:var(--rcm-muted);font-size:10px;font-variant-numeric:tabular-nums}.story-segment>header>strong{min-width:0;font-size:12px;line-height:1.45}.story-segment>header>strong small{display:none}.story-segment>header>small{color:var(--rcm-muted);font-size:10px;white-space:nowrap}.story-segment>p{margin:0 0 0 38px!important;color:var(--rcm-muted);font-size:12px;line-height:1.7}
.story-memories h3{margin-bottom:18px}.story-memory-track{position:relative;display:grid;grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:minmax(190px,1fr);gap:0;overflow-x:auto;padding:0 0 20px;scrollbar-width:none}.story-memory-track::-webkit-scrollbar{display:none}.story-memory{position:relative;min-width:0}.story-memory:not(:last-child)::after{content:"";position:absolute;top:5px;left:50%;z-index:0;width:100%;height:1px;background:color-mix(in srgb,var(--rcm-border) 72%,transparent)}.story-memory>button{min-height:80px;display:grid;grid-template-columns:minmax(0,1fr);justify-items:center;align-content:start;gap:3px;padding:0 14px;border:0;text-align:center}.story-memory>button::before{content:none}.story-memory>button i{grid-row:auto;width:9px;height:9px;margin:1px 0 8px}.story-memory>button strong{max-width:100%;display:-webkit-box;overflow:hidden;white-space:normal;line-height:1.35;-webkit-box-orient:vertical;-webkit-line-clamp:2}.story-memory-previews{margin-top:0}.story-memory__preview{padding:12px 0 22px;border:0;background:transparent}.story-memory__preview p{max-width:72ch}.story-memory__preview .btn{padding-inline:10px}
@media(max-width:760px){.story-all{width:max-content;display:flex;margin:7px 14px 0 auto}.story-page>.pagehead .record-menu__items{position:absolute;top:calc(100% + 6px);right:0;bottom:auto;left:auto;width:min(230px,calc(100vw - 28px));min-width:190px}.story-segment>header{grid-template-columns:28px minmax(0,1fr)}.story-segment>header>small{grid-column:2}.story-memory-track{grid-auto-flow:row;grid-auto-columns:auto;grid-template-columns:minmax(0,1fr);overflow:visible;padding-bottom:16px}.story-memory:not(:last-child)::after{top:8px;bottom:-8px;left:4px;width:1px;height:auto}.story-memory>button{min-height:68px;grid-template-columns:12px minmax(0,1fr);justify-items:start;align-content:center;gap:1px 8px;padding:8px 0;text-align:left}.story-memory>button i{z-index:1;grid-row:1/4;margin:1px 0 0}.story-memory>button strong{display:block;white-space:normal}.story-memory__preview{padding:8px 0 22px}.story-memory__preview .btn{min-height:40px;justify-self:end;padding:7px 10px}.story-memory-previews{margin-top:2px}}
[data-drag-scroll]{cursor:grab;overscroll-behavior-x:contain;scroll-snap-type:none;touch-action:pan-y}[data-drag-scroll].is-dragging{cursor:grabbing;user-select:none}[data-drag-scroll].is-dragging *{pointer-events:none}
.story-flow>p,.story-flow>ol,.story-flow>ol li,.story-flow>p>span,.story-flow>ol li>span{min-width:0;max-width:100%;word-break:normal;overflow-wrap:anywhere;white-space:normal}.story-flow .story-canonical{white-space:normal;word-break:normal;overflow-wrap:anywhere}.story-flow>ol li>.story-canonical{grid-column:2}
@media(min-width:761px){.story-rail{display:grid;grid-auto-flow:column;grid-auto-columns:clamp(152px,calc((100% - 64px)/5),202px);grid-template-columns:none;overflow-x:auto;padding-bottom:8px;scrollbar-width:none}.story-rail::-webkit-scrollbar{display:none}.story-rail::before{content:none}.story-stop:not(:last-child)::after{content:"";position:absolute;top:12px;left:50%;z-index:0;width:100%;height:1px;background:color-mix(in srgb,var(--rcm-border) 82%,transparent)}.story-memory-track{grid-auto-columns:clamp(164px,calc((100% - 56px)/5),202px)}}
@media(max-width:760px){.story-rail{scroll-snap-type:none}.story-rail::before{content:none}.story-stop{min-width:138px;scroll-snap-align:none}.story-stop:not(:last-child)::after{content:"";position:absolute;top:12px;left:50%;z-index:0;width:100%;height:1px;background:color-mix(in srgb,var(--rcm-border) 82%,transparent)}.story-reader{min-height:calc(100svh - 158px);display:flex;flex-direction:column}.story-reader__scroll{min-height:0;flex:1}.story-chapter{padding-bottom:38px}.story-pager{position:static;flex:none;margin:0 -14px;padding:10px 14px calc(10px + env(safe-area-inset-bottom))}.story-memory-track>.story-memory__preview{grid-column:1;padding:4px 0 22px 20px}.story-memory-previews:empty{display:none}}
.relation-tension-label{display:block;margin-top:18px;color:var(--rcm-text);font-size:12px}.relation-summary-v2 ul{display:grid;gap:8px;margin-top:8px}.relation-summary-v2 li{line-height:1.55}.relation-summary-v2 li>span{display:block}.relation-summary-v2 li>.canonical-copy{margin-top:3px;color:var(--rcm-muted);font-size:11px}
.relation-axis-v2__item>.relation-axis-scale{height:5px;display:block;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--rcm-text) 9%,transparent)}.relation-axis-scale i{width:100%;display:block;height:100%;border-radius:inherit;background:color-mix(in srgb,var(--rcm-muted) 45%,transparent);transform-origin:left;transition:transform .18s cubic-bezier(.22,1,.36,1)}.relation-axis-v2__item[data-tone=positive] .relation-axis-scale i{background:color-mix(in srgb,var(--rcm-accent) 78%,var(--rcm-text))}.relation-axis-v2__item[data-tone=negative] .relation-axis-scale i{background:color-mix(in srgb,var(--rcm-danger) 78%,var(--rcm-text))}.relation-axis-v2__item[data-tone=mixed] .relation-axis-scale i{background:color-mix(in srgb,var(--rcm-warning) 80%,var(--rcm-text))}
.relation-person-link{margin:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-weight:inherit;letter-spacing:inherit;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:4px;cursor:pointer}.relation-person-link:hover{color:var(--rcm-accent);text-decoration-color:currentColor}.relation-person-link:focus-visible{border-radius:3px}
.relation-section-v2{padding:20px 0}.relation-section-v2>header{margin-bottom:10px}.relation-change-v2,.milestone-v2{gap:8px;padding:14px 0}.relation-change-v2__meta{align-items:center!important}.relation-change-v2__meta>.relation-change-v2__chips{display:flex;flex-wrap:wrap;gap:5px;padding:0;border-radius:0;background:transparent}.relation-change-v2__chips>span,.milestone-v2__head>span{padding:2px 7px;border:1px solid color-mix(in srgb,var(--rcm-border) 72%,transparent);border-radius:999px;background:color-mix(in srgb,var(--rcm-selected) 42%,transparent);color:var(--rcm-text);font-size:10px;font-weight:650}.relation-change-v2__meta>small{font-variant-numeric:tabular-nums}.relation-change-v2 p,.milestone-v2 p{margin:0;color:var(--rcm-muted);font-size:13px;line-height:1.7}.relation-change-v2 p>span,.milestone-v2 p>span{display:block;padding:0;border-radius:0;background:transparent}.relation-change-v2 p>.canonical-copy,.milestone-v2 p>.canonical-copy{margin-top:5px;color:var(--rcm-muted);font-size:11px}.relation-section-v2>.relation-change-v2:last-of-type{border-bottom:0}.relation-more-changes-v2>div>.relation-change-v2:last-child{border-bottom:0}
.relation-milestones-v2{padding:0}.relation-milestones-v2>summary,.relation-disclosure-v2>summary{min-height:52px;display:flex;align-items:center;gap:7px;cursor:pointer;color:var(--rcm-muted);font-size:13px;font-weight:680;list-style:none}.relation-milestones-v2>summary::-webkit-details-marker,.relation-disclosure-v2>summary::-webkit-details-marker{display:none}.relation-milestones-v2>summary>span,.relation-disclosure-v2>summary>span{display:inline-flex;align-items:center;gap:6px}.relation-milestones-v2>summary small,.relation-disclosure-v2>summary small{color:var(--rcm-muted);font-size:10px;font-weight:560}.relation-milestones-v2>summary::after,.relation-disclosure-v2>summary::after{content:"›";margin-left:auto;font-size:18px;transition:transform .16s ease}.relation-milestones-v2[open]>summary,.relation-disclosure-v2[open]>summary{color:var(--rcm-text)}.relation-milestones-v2[open]>summary::after,.relation-disclosure-v2[open]>summary::after{transform:rotate(90deg)}.relation-milestones-v2>div{padding-bottom:12px}.relation-disclosure-v2>div{display:grid;gap:10px;padding:4px 0 20px}.relation-disclosure-v2>div>p{margin:0;padding:10px 12px;border-radius:7px;background:color-mix(in srgb,var(--rcm-selected) 28%,transparent);color:var(--rcm-muted);font-size:12px;line-height:1.65}.relation-disclosure-v2>div>p>span{display:block}.relation-disclosure-v2>div>p>.canonical-copy{margin-top:5px;font-size:11px}
.no-active-home__description{margin:5px 0 0;color:var(--rcm-muted);font-size:12px}.no-active-home__body{min-height:170px;display:grid;place-items:center;align-content:center;gap:7px;padding:28px 18px;text-align:center}.no-active-home__body>strong{font-size:15px}.no-active-home__body>p{max-width:68ch;margin:0;color:var(--rcm-muted);font-size:12px;line-height:1.65}.no-active-home__body>.actions{justify-content:center;margin-top:10px}
@media(prefers-reduced-motion:reduce){.story-index,.story-chapter,.story-memory__preview{animation:none}}
`;

const managementStyles = `
.page:has(.management-page){height:calc(100vh - 166px)}
.management-page{min-height:100%;color:var(--rcm-text);font-size:14px}
.manage-pagehead{min-height:72px;display:flex;align-items:flex-start;gap:18px;padding:4px 0 17px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 54%,transparent)}
.manage-pagehead>div:first-child{min-width:0}.manage-pagehead h1{margin:0;font-size:22px;line-height:1.3;letter-spacing:-.035em}.manage-pagehead p{max-width:72ch;margin:5px 0 0;color:var(--rcm-muted);font-size:13px;line-height:1.5}.manage-page-actions{display:flex;align-items:center;gap:7px;margin-left:auto}
.attention-page{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr)}.attention-workspace{min-height:0;display:grid;grid-template-columns:minmax(320px,35%) minmax(0,65%);overflow:hidden;border:1px solid color-mix(in srgb,var(--rcm-border) 72%,transparent);border-radius:11px;background:color-mix(in srgb,var(--rcm-surface) 86%,var(--rcm-bg))}.attention-list-pane{min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);border-right:1px solid color-mix(in srgb,var(--rcm-border) 58%,transparent)}.attention-toolbar{display:grid;gap:9px;padding:14px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 52%,transparent)}.attention-search{position:relative}.attention-search svg{position:absolute;left:11px;top:50%;width:15px;transform:translateY(-50%);color:var(--rcm-muted)}.attention-search input{height:40px;padding-left:35px;background:color-mix(in srgb,var(--rcm-bg) 72%,var(--rcm-surface))}.attention-filters{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}.attention-filters::-webkit-scrollbar{display:none}.attention-filters button{min-height:31px;flex:none;border:1px solid color-mix(in srgb,var(--rcm-border) 72%,transparent);border-radius:999px;padding:4px 10px;background:transparent;color:var(--rcm-muted);font-size:12px;font-weight:650}.attention-filters button[aria-pressed=true]{border-color:color-mix(in srgb,var(--rcm-accent) 75%,var(--rcm-border));background:color-mix(in srgb,var(--rcm-accent) 12%,var(--rcm-surface));color:var(--rcm-text)}.attention-list{min-height:0;overflow:auto}.attention-row{width:100%;min-height:88px;display:grid;grid-template-columns:30px minmax(0,1fr) 16px;align-items:center;gap:10px;padding:12px 14px;border:0;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 42%,transparent);background:transparent;color:var(--rcm-text);text-align:left}.attention-row:hover{background:color-mix(in srgb,var(--rcm-selected) 46%,transparent)}.attention-row.is-selected{background:color-mix(in srgb,var(--rcm-accent) 12%,var(--rcm-selected))}.attention-mark{width:28px;height:28px;display:grid;place-items:center;border-radius:50%;background:color-mix(in srgb,var(--rcm-warning) 12%,transparent);color:var(--rcm-warning)}.attention-mark svg{width:15px}.attention-row-copy{min-width:0;display:grid;gap:3px}.attention-row-copy>span{display:flex;align-items:center;gap:7px}.attention-type{color:var(--rcm-accent);font-size:11px;font-style:normal;font-weight:720}.attention-row time{margin-left:auto;color:var(--rcm-muted);font-size:10px}.attention-row strong,.attention-row p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.attention-row strong{font-size:13px}.attention-row p{margin:0;color:var(--rcm-muted);font-size:12px}.attention-row>svg{width:15px;color:var(--rcm-muted)}
.attention-detail{min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:color-mix(in srgb,var(--rcm-bg) 72%,var(--rcm-surface))}.attention-detail-head{display:flex;align-items:flex-start;gap:12px;padding:20px clamp(20px,3.5vw,46px) 17px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.attention-detail-head>div{min-width:0;flex:1}.attention-detail-head h2{margin:5px 0 0;font-size:19px;line-height:1.35}.attention-detail-head p{margin:5px 0 0;color:var(--rcm-muted);font-size:12px;line-height:1.5}.attention-back{display:none}.attention-detail-body{min-height:0;overflow:auto;padding:22px clamp(20px,3.5vw,46px) 28px}.attention-detail-body section+section,.attention-detail-body details{margin-top:20px}.attention-detail-body h3{margin:0 0 8px;font-size:13px}.attention-compare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.attention-compare>section{margin:0!important;padding:15px;border:1px solid color-mix(in srgb,var(--rcm-border) 62%,transparent);border-radius:8px;background:color-mix(in srgb,var(--rcm-surface) 72%,transparent)}.attention-compare p{margin:0;color:var(--rcm-text);line-height:1.65}.attention-compare small{display:block;margin-top:9px;color:var(--rcm-muted);line-height:1.45}.attention-error{display:flex;gap:10px;padding:13px;border:1px solid color-mix(in srgb,var(--rcm-danger) 58%,var(--rcm-border));border-radius:8px;background:color-mix(in srgb,var(--rcm-danger) 7%,var(--rcm-surface))}.attention-error p{margin:4px 0 0;color:var(--rcm-muted)}.attention-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-block:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.attention-facts>div{padding:12px 10px}.attention-facts dt{color:var(--rcm-muted);font-size:11px}.attention-facts dd{margin:4px 0 0;font-weight:680}.attention-decision{display:flex;justify-content:flex-end;gap:7px;flex-wrap:wrap;padding:12px clamp(20px,3.5vw,46px) calc(12px + env(safe-area-inset-bottom));border-top:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent);background:color-mix(in srgb,var(--rcm-bg) 94%,var(--rcm-surface))}
.operations-page,.data-management-page{padding-bottom:32px}.operations-page>.pagehead,.data-management-page>.pagehead{min-height:72px;padding:4px 0 17px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 54%,transparent)}.operations-page>.statusbar,.data-management-page>.notice{margin-top:14px}.operations-page .panel__head h2,.data-management-page .panel__head h2{font-size:15px}.operations-page .table td,.data-management-page .table td{font-size:13px;line-height:1.45}
.operation-state{min-height:70px;display:flex;align-items:flex-start;gap:12px;padding:17px 2px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.operation-state>div{min-width:0;flex:1}.operation-state strong{display:block}.operation-state p{margin:3px 0 0;color:var(--rcm-muted);font-size:12px}.operation-state>span:last-child{color:var(--rcm-muted);font-size:11px}.operation-dot{width:10px;height:10px;flex:none;margin-top:5px;border-radius:50%;background:var(--rcm-muted)}.operation-dot.is-idle{background:var(--rcm-success);box-shadow:0 0 0 4px color-mix(in srgb,var(--rcm-success) 12%,transparent)}.operation-dot.is-running{background:var(--rcm-warning);box-shadow:0 0 0 4px color-mix(in srgb,var(--rcm-warning) 12%,transparent)}.operation-dot.is-paused{background:var(--rcm-danger);box-shadow:0 0 0 4px color-mix(in srgb,var(--rcm-danger) 10%,transparent)}.operation-section{margin-top:24px}.operation-section>header{display:flex;align-items:baseline;gap:8px;padding-bottom:9px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.operation-section h2{margin:0;font-size:15px}.operation-section header span{color:var(--rcm-muted);font-size:11px}.operation-row{min-height:68px;display:grid;grid-template-columns:76px minmax(0,1fr) 100px minmax(0,auto);align-items:center;gap:12px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 40%,transparent)}.operation-row strong{display:block;font-size:13px}.operation-row p{margin:3px 0 0;color:var(--rcm-muted);font-size:12px}.operation-row time{color:var(--rcm-muted);font-size:11px;text-align:right}.operation-label{width:max-content;min-height:25px;display:inline-flex;align-items:center;padding:0 8px;border:1px solid var(--rcm-border);border-radius:999px;color:var(--rcm-muted);font-size:11px;font-weight:680}.operation-label.is-queued,.operation-label.is-leased{border-color:color-mix(in srgb,var(--rcm-warning) 52%,var(--rcm-border));color:var(--rcm-warning)}.operation-label.is-failed{border-color:color-mix(in srgb,var(--rcm-danger) 52%,var(--rcm-border));color:var(--rcm-danger)}.operation-label.is-completed,.operation-label.is-done{border-color:color-mix(in srgb,var(--rcm-success) 52%,var(--rcm-border));color:var(--rcm-success)}${typeof __RCM_DISTRIBUTION__ === "undefined" || !__RCM_DISTRIBUTION__ ? ".diagnostic-section{margin-top:28px;border-block:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.diagnostic-section>summary{min-height:58px;display:grid;grid-template-columns:24px auto minmax(0,1fr) 20px;align-items:center;gap:8px;cursor:pointer}.diagnostic-section>summary small{color:var(--rcm-muted)}.diagnostic-section>summary>span:last-child{font-size:18px;transition:transform .16s ease}.diagnostic-section[open]>summary>span:last-child{transform:rotate(90deg)}.diagnostic-section>div{padding:0 0 18px 32px}.diagnostic-section h3{margin:14px 0 8px;font-size:12px}.diagnostic-section .log{font-size:12px}" : ""}
.settings-page{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr)}.settings-layout{min-height:0;display:grid;grid-template-columns:225px minmax(0,1fr)}.settings-nav{padding:14px 12px 14px 0;border-right:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.settings-nav button{width:100%;min-height:58px;display:grid;grid-template-columns:minmax(0,1fr) 18px;align-items:center;padding:9px 12px;border:0;border-radius:8px;background:transparent;color:var(--rcm-muted);text-align:left}.settings-nav button:hover{background:color-mix(in srgb,var(--rcm-selected) 46%,transparent);color:var(--rcm-text)}.settings-nav button[aria-current=page]{background:var(--rcm-selected);color:var(--rcm-text)}.settings-nav strong,.settings-nav small{display:block}.settings-nav strong{font-size:13px}.settings-nav small{margin-top:3px;color:var(--rcm-muted);font-size:11px}.settings-nav svg{grid-column:2;grid-row:1;width:15px}.settings-panel{min-width:0;min-height:0;overflow:auto;padding:25px clamp(26px,5vw,68px) 90px}.setting-section-copy{padding-bottom:18px}.setting-section-copy h2{margin:0;font-size:20px;letter-spacing:-.025em}.setting-section-copy p{margin:5px 0 0;color:var(--rcm-muted);font-size:13px}.setting-group{padding:21px 0}.setting-group+.setting-group{border-top:1px solid color-mix(in srgb,var(--rcm-border) 42%,transparent)}.setting-group h3{margin:0 0 14px;color:var(--rcm-text);font-size:14px}.setting-group .formgrid{gap:4px 20px}.setting-group .field{min-width:0;margin-bottom:15px}.setting-group .field>span{color:var(--rcm-text);font-size:13px;font-weight:680}.setting-group .field small{font-size:12px;line-height:1.5}.setting-group .field--check{padding:10px 0}.setting-group .field--check>span{display:flex;align-items:center;gap:8px}.setting-group .field--check input{width:auto}.settings-injection{padding:13px 15px;border-radius:8px;background:color-mix(in srgb,var(--rcm-selected) 42%,transparent)}.settings-injection p{margin:0;line-height:1.55}.settings-injection p+p{margin-top:5px}.settings-advanced{margin-top:2px}.settings-advanced>summary{min-height:48px;display:flex;align-items:center;cursor:pointer;color:var(--rcm-text);font-size:13px;font-weight:680}.settings-advanced>div{padding:5px 0 2px}.settings-save{position:sticky;bottom:-90px;display:flex;justify-content:flex-end;gap:8px;margin:28px 0 -90px;padding:11px 0 calc(11px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--rcm-bg) 95%,var(--rcm-surface))}.settings-save .btn{min-width:108px}.settings-save .notice{margin:0 auto 0 0}.settings-server-status{margin-bottom:15px}
@media(max-width:1040px){.attention-workspace{grid-template-columns:minmax(290px,40%) minmax(0,60%)}.attention-compare{grid-template-columns:1fr}.settings-layout{grid-template-columns:200px minmax(0,1fr)}.settings-panel{padding-inline:30px}}
@media(max-width:760px){.page:has(.management-page){height:auto}.management-page{font-size:14px}.manage-pagehead{min-height:auto;padding:3px 0 14px}.manage-pagehead h1{font-size:20px}.manage-pagehead p{font-size:12px}.attention-page{display:block}.attention-workspace{display:block;overflow:visible;border:0;border-radius:0;background:transparent}.attention-list-pane{border-right:0}.attention-list{overflow:visible;border-top:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.attention-detail{display:none}.attention-page.is-mobile-detail .manage-pagehead,.attention-page.is-mobile-detail .attention-list-pane{display:none}.attention-page.is-mobile-detail .attention-detail{display:grid;min-height:calc(100vh - 176px);margin:0 -14px}.attention-detail-head{position:sticky;top:40px;z-index:7;padding:12px 14px;background:color-mix(in srgb,var(--rcm-bg) 94%,var(--rcm-surface));backdrop-filter:blur(12px)}.attention-detail-head h2{font-size:17px}.attention-back{display:inline-grid;place-items:center;width:40px;height:40px;border:0;background:transparent;color:var(--rcm-text)}.attention-detail-body{overflow:visible;padding:18px 14px 24px}.attention-decision{position:sticky;bottom:66px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));padding:9px 14px calc(9px + env(safe-area-inset-bottom))}.attention-decision .btn{min-height:42px;padding-inline:8px}.settings-page{display:block}.settings-layout{display:block}.settings-nav{display:flex;overflow-x:auto;margin:0 -14px;padding:3px 14px 10px;border-right:0;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent);scrollbar-width:none}.settings-nav::-webkit-scrollbar{display:none}.settings-nav button{min-width:max-content;min-height:40px;display:block;padding:7px 11px}.settings-nav button small,.settings-nav button svg{display:none}.settings-panel{overflow:visible;padding:20px 0 104px}.setting-section-copy{padding-bottom:12px}.setting-group{padding:17px 0}.setting-group .formgrid{grid-template-columns:1fr}.settings-save{position:fixed;right:14px;bottom:66px;left:14px;z-index:8;margin:0;padding:9px 0 calc(9px + env(safe-area-inset-bottom))}.settings-save .btn{width:100%;min-height:44px}.settings-save .notice{display:none}.operations-page .pagehead,.data-management-page .pagehead{flex-wrap:wrap}.operations-page .pagehead__actions,.data-management-page .pagehead__actions{width:100%;margin-left:0}.operations-page .pagehead__actions .btn{flex:1}}
@media(max-width:760px){.operation-state{align-items:flex-start}.operation-state>span:last-child{display:none}.operation-row{grid-template-columns:70px minmax(0,1fr) auto;gap:8px;padding:10px 0}.operation-row time{grid-column:2;text-align:left}.operation-row>.btn{grid-column:3;grid-row:1/3}${typeof __RCM_DISTRIBUTION__ === "undefined" || !__RCM_DISTRIBUTION__ ? ".diagnostic-section>summary{grid-template-columns:22px auto 18px}.diagnostic-section>summary small{display:none}.diagnostic-section>div{padding-left:0}.diagnostic-section .log{grid-template-columns:1fr 60px}.diagnostic-section .log>span:last-child{grid-column:1/-1}" : ""}}
.main:has(.management-page){overflow:hidden}
.page:has(.management-page){height:calc(100vh - 167px)}
.management-page>.pagehead{min-height:0;margin-bottom:14px;padding:0;border:0}
.management-page>.pagehead h1{font-size:20px;line-height:1.3;letter-spacing:normal}
.management-page>.pagehead p{font-size:14px;line-height:normal}
.operations-page,.data-management-page{height:100%;overflow:auto;padding:0 2px 24px 0;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--rcm-border) 72%,transparent) transparent}
.operations-actions-desktop{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.operations-actions-mobile{display:none}
.operation-dot.is-error{background:var(--rcm-danger);box-shadow:0 0 0 4px color-mix(in srgb,var(--rcm-danger) 10%,transparent)}
.worker-error-notice{border-color:color-mix(in srgb,var(--rcm-danger) 62%,var(--rcm-border));background:color-mix(in srgb,var(--rcm-danger) 7%,var(--rcm-surface))}.worker-error-notice .home-message__details{grid-template-columns:minmax(0,1fr);gap:8px}.worker-error-code{display:block;max-width:72ch;color:var(--rcm-muted);font:11px/1.5 Consolas,ui-monospace,monospace;white-space:normal;overflow-wrap:anywhere}.worker-error-notice .home-message__action-link{justify-self:start;font-size:12px;font-weight:680}
.operations-page>.pagehead,.data-management-page>.pagehead{min-height:0;padding:0;border:0}
.attention-editor{margin-top:22px!important;border-block:1px solid color-mix(in srgb,var(--rcm-border) 54%,transparent);color:var(--rcm-text)}
.attention-editor>summary{min-height:52px;display:flex;align-items:center;gap:10px;padding:0 2px;cursor:pointer;list-style:none;font-size:13px;font-weight:680}
.attention-editor>summary:focus-visible{outline:2px solid var(--rcm-accent);outline-offset:2px;border-radius:6px}
.attention-editor>summary::-webkit-details-marker{display:none}.attention-editor>summary>span:last-child{margin-left:auto;color:var(--rcm-muted);font-size:18px;transition:transform .16s cubic-bezier(.22,1,.36,1)}.attention-editor[open]>summary>span:last-child{transform:rotate(90deg)}
.attention-editor .reconciliation-edit{display:grid;gap:2px;padding:16px 0 5px}.attention-editor .field{margin-bottom:13px}.attention-editor textarea{min-height:126px}
.attention-detail-body>.technical{margin-top:22px!important;border-block:1px solid color-mix(in srgb,var(--rcm-border) 54%,transparent);color:var(--rcm-text)}.attention-detail-body>.technical>summary{min-height:52px;display:flex;align-items:center;padding:0 2px;cursor:pointer;font-size:13px;font-weight:680}.attention-detail-body>.technical>summary::after{content:"›";margin-left:auto;color:var(--rcm-muted);font-size:18px;transition:transform .16s cubic-bezier(.22,1,.36,1)}.attention-detail-body>.technical[open]>summary::after{transform:rotate(90deg)}.attention-detail-body>.technical>summary:focus-visible{outline:2px solid var(--rcm-accent);outline-offset:2px;border-radius:6px}.attention-detail-body>.technical .packet{margin:0 0 14px;max-height:220px}
.data-management-page>.pagehead .pagehead__actions{align-items:flex-start}.data-import{display:inline-flex;align-items:center;gap:7px}.data-import svg{width:16px}
.data-metrics{min-height:56px;display:flex;align-items:center;overflow-x:auto;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 46%,transparent);scrollbar-width:none}.data-metrics::-webkit-scrollbar{display:none}.data-metrics span{flex:none;padding:0 16px;border-right:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent);color:var(--rcm-muted);font-size:12px;white-space:nowrap}.data-metrics span:first-child{padding-left:2px}.data-metrics span:last-child{border-right:0}.data-metrics strong{margin-left:5px;color:var(--rcm-text);font-size:14px;font-variant-numeric:tabular-nums}
.data-toolbar{display:grid;grid-template-columns:minmax(230px,1fr) 142px max-content;align-items:center;gap:8px;margin:0;padding:16px 0 12px}.data-search{position:relative}.data-search svg{position:absolute;top:50%;left:11px;width:15px;transform:translateY(-50%);color:var(--rcm-muted)}.data-search input{height:40px;padding-left:35px}.data-toolbar select,.data-inventory{height:40px}.data-toolbar .data-inventory{margin:0;white-space:nowrap}
.data-ledger{border-top:1px solid color-mix(in srgb,var(--rcm-border) 62%,transparent)}.data-columns,.data-row{display:grid;grid-template-columns:minmax(145px,1.25fr) 82px minmax(100px,.8fr) minmax(108px,.9fr) 48px 62px 112px;align-items:center;gap:8px}.data-columns{min-height:36px;color:var(--rcm-muted);font-size:12px;font-weight:680}.data-entry{border-top:1px solid color-mix(in srgb,var(--rcm-border) 42%,transparent)}.data-row{min-height:76px}.data-chat,.data-row>span{min-width:0}.data-chat strong,.data-chat small,.data-row>span>strong,.data-row>span>small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.data-chat>strong{font-size:14px}.data-chat small,.data-row>span>small{margin-top:3px;color:var(--rcm-muted);font-size:11px}.data-row>span{color:var(--rcm-muted);font-size:12px;line-height:1.45}.data-row>span>strong{color:var(--rcm-text);font-size:13px}.data-action-cell{min-width:0}.data-actions{display:flex;justify-content:flex-end;gap:4px}.data-actions .record-menu{width:34px;height:34px}.data-actions .record-menu>summary{width:34px;height:34px}.data-unregistered{display:block;color:var(--rcm-muted);font-size:12px;text-align:right}.data-entry>.inline-confirm{margin:0 0 14px}.data-footnote{margin:10px 2px 0;color:var(--rcm-muted);font-size:12px}
.settings-page{grid-template-rows:auto minmax(0,1fr)}.settings-layout{min-height:0}.settings-panel{min-height:0;display:grid;grid-template-rows:minmax(0,1fr) auto;overflow:hidden;padding:0}.settings-scroll{min-width:0;min-height:0;overflow:auto;padding:24px clamp(26px,5vw,64px) 26px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--rcm-border) 72%,transparent) transparent}.settings-scroll>form,.settings-scroll>[data-settings-voyage]{max-width:780px}.setting-section-copy{padding-bottom:17px}.setting-section-copy h2{font-size:20px}.setting-section-copy p{font-size:13px}.setting-group{padding:20px 0}.setting-group .formgrid{grid-template-columns:repeat(2,minmax(0,1fr));gap:3px 28px}.setting-group .field{margin-bottom:14px}.setting-group .field--check{align-content:start;padding:9px 0}.settings-page .chat-profile-setting{grid-column:auto}.settings-page .chat-profile-setting select{max-width:290px}.settings-connection{min-height:58px;display:flex;align-items:center;gap:11px;padding:11px 0 14px;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 44%,transparent)}.settings-connection__mark{width:30px;height:30px;display:grid;place-items:center;border-radius:50%;background:color-mix(in srgb,var(--rcm-success) 12%,transparent);color:var(--rcm-success)}.settings-connection.is-pending .settings-connection__mark{background:color-mix(in srgb,var(--rcm-warning) 10%,transparent);color:var(--rcm-warning)}.settings-connection.is-error .settings-connection__mark{background:color-mix(in srgb,var(--rcm-danger) 10%,transparent);color:var(--rcm-danger)}.settings-connection__mark svg{width:16px}.settings-connection>div{min-width:0}.settings-connection strong,.settings-connection small{display:block}.settings-connection strong{font-size:13px}.settings-connection small{margin-top:3px;color:var(--rcm-muted);font-size:12px}.settings-save{position:static;min-height:58px;display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:0;padding:10px clamp(26px,5vw,64px) calc(10px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--rcm-bg) 95%,var(--rcm-surface))}.settings-save .notice{margin:0 auto 0 0}.settings-save .btn{min-width:108px}.settings-advanced:not([open])>div{display:none}
.settings-recent-grid>.field>small{min-height:36px}
.settings-regex-toolbar{display:flex;align-items:flex-end;gap:14px;margin:8px 0 0;padding-top:15px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 42%,transparent)}.settings-regex-toolbar>div{min-width:0;display:grid;gap:3px}.settings-regex-toolbar strong{font-size:12px;font-weight:680}.settings-regex-toolbar span{color:var(--rcm-muted);font-size:12px;line-height:1.45}.settings-regex-toolbar>.btn{min-width:max-content;margin-left:auto}.settings-regex-disclosure{margin-top:8px;border-block:1px solid color-mix(in srgb,var(--rcm-border) 42%,transparent)}.settings-regex-disclosure>summary{min-height:48px;display:flex;align-items:center;gap:8px;padding:0 2px;cursor:pointer;list-style:none}.settings-regex-disclosure>summary::-webkit-details-marker{display:none}.settings-regex-disclosure>summary::before{content:"›";color:var(--rcm-muted);font-size:18px;line-height:1;transition:transform .16s ease}.settings-regex-disclosure[open]>summary::before{transform:rotate(90deg)}.settings-regex-summary{min-width:0;display:flex;align-items:baseline;gap:8px}.settings-regex-summary strong{font-size:12px;font-weight:650}.settings-regex-summary small{color:var(--rcm-muted);font-size:11px}.settings-regex-body{padding:1px 0 14px}.settings-regex-list{display:grid;gap:8px}.settings-regex-rule{display:grid;grid-template-columns:24px minmax(118px,160px) 82px minmax(220px,1fr) 34px;align-items:end;gap:10px;padding:10px 11px;border:1px solid color-mix(in srgb,var(--rcm-border) 70%,transparent);border-radius:8px;background:color-mix(in srgb,var(--rcm-surface) 55%,var(--rcm-bg))}.settings-regex-rule .field{min-width:0;margin:0}.settings-regex-enabled{align-self:end;height:36px;display:grid;place-items:center}.settings-regex-enabled input{width:auto;margin:0}.settings-regex-enabled span{display:none}.settings-regex-remove{align-self:end;width:34px;height:36px;min-height:36px;border-color:transparent;background:transparent;color:var(--rcm-muted)}.settings-regex-remove:hover,.settings-regex-remove:focus-visible{background:color-mix(in srgb,var(--rcm-danger) 10%,transparent);color:var(--rcm-danger)}.settings-regex-flags input{font-family:Consolas,ui-monospace,monospace}.settings-regex-pattern input{font-family:var(--risu-font-family,Arial,system-ui,sans-serif)}.settings-regex-pattern input::placeholder{color:var(--rcm-muted);font-family:inherit;font-weight:400;opacity:.72}.settings-regex-empty{padding:16px 12px;color:var(--rcm-muted);font-size:12px;text-align:center}.settings-regex-note{margin:10px 0 0;color:var(--rcm-muted);font-size:12px;line-height:1.5}.settings-regex-note code{color:var(--rcm-text);font-family:Consolas,ui-monospace,monospace}.settings-cache-row{height:36px;display:flex;align-items:center;gap:8px}.settings-cache-row>.muted{font-variant-numeric:tabular-nums}.settings-cache-clear{width:36px;height:36px;color:var(--rcm-muted)}.settings-cache-clear:hover,.settings-cache-clear:focus-visible{background:color-mix(in srgb,var(--rcm-danger) 10%,transparent);color:var(--rcm-danger)}
.settings-save .notice{align-items:center;padding:5px 0;border:0;background:transparent}.settings-save .notice[role=status] svg{color:var(--rcm-success)}.settings-save .notice[role=alert] svg{color:var(--rcm-danger)}
@media(max-width:1040px){.data-columns,.data-row{grid-template-columns:minmax(132px,1.15fr) 74px minmax(92px,.78fr) minmax(102px,.86fr) 42px 56px 108px;gap:7px}.settings-scroll{padding-inline:28px}.settings-save{padding-inline:28px}.setting-group .formgrid{gap-inline:20px}}
@media(max-width:760px){.pagehead{min-height:44px}.secondary-nav button,.world-tabs button{min-height:44px}.world-tabs{margin-bottom:14px}}
@media(max-width:480px){.data-management-page>.pagehead{flex-direction:column;align-items:stretch!important;gap:10px}.data-management-page>.pagehead .pagehead__actions{margin-left:0!important;width:100%!important;justify-content:flex-start}.data-management-page>.pagehead h1{white-space:nowrap}}
@media(max-width:760px){.main:has(.management-page){overflow-x:hidden;overflow-y:auto}.management-page>.pagehead{margin-bottom:12px}.management-page>.pagehead p{display:none}.operations-page,.data-management-page{height:auto;overflow:visible;padding-right:0}.attention-page.is-mobile-detail>.pagehead,.attention-page.is-mobile-detail .attention-list-pane{display:none}.attention-back{width:44px;height:44px}.attention-filters button{min-height:36px}.attention-editor>summary{min-height:52px}.data-management-page>.pagehead{align-items:center;flex-wrap:nowrap}.data-management-page>.pagehead .pagehead__actions{width:auto;margin-left:auto}.data-import{width:44px;height:44px;justify-content:center;padding:0}.data-import span{display:none}.data-metrics{width:100%;min-height:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));overflow:visible;margin-inline:0;padding:8px 0}.data-metrics span{min-width:0;display:flex;align-items:baseline;gap:4px;padding:7px 10px;white-space:normal}.data-metrics span:first-child{padding-left:10px}.data-metrics span:nth-child(3n){border-right:0}.data-metrics span:nth-child(n+4){border-top:1px solid color-mix(in srgb,var(--rcm-border) 38%,transparent)}.data-metrics strong{margin-left:0}.data-toolbar{grid-template-columns:minmax(0,1fr) minmax(0,1fr);padding:14px 0 12px}.data-search{grid-column:1/-1}.data-search input,.data-toolbar select,.data-inventory{height:44px}.data-columns{display:none}.data-entry{padding:14px 0}.data-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px 18px;min-height:0}.data-chat{grid-column:1/-1}.data-row>span::before{content:attr(data-label);display:block;margin-bottom:2px;color:var(--rcm-muted);font-size:10px}.data-row>span{font-size:12px}.data-action-cell{grid-column:1/-1}.data-actions{justify-content:flex-end}.data-actions .btn,.data-actions .record-menu,.data-actions .record-menu>summary{width:44px;height:44px}.data-unregistered{text-align:left}.data-entry>.inline-confirm{margin:12px 0 0}.data-footnote{margin-top:12px;font-size:12px;line-height:1.55}.settings-page{display:block}.settings-layout{display:block}.settings-panel{display:block;overflow:visible}.settings-scroll{overflow:visible;padding:20px 0 96px}.settings-scroll>form,.settings-scroll>[data-settings-voyage]{max-width:none}.setting-group .formgrid{grid-template-columns:minmax(0,1fr)}.settings-page .chat-profile-setting select{max-width:none}.settings-save{position:fixed;right:14px;bottom:66px;left:14px;z-index:8;min-height:62px;padding:9px 0 calc(9px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--rcm-bg) 95%,var(--rcm-surface))}.settings-save .btn{width:100%;min-height:44px}.settings-save .notice{display:none}.settings-nav button{min-height:44px}.attention-decision .btn{min-height:44px}}
@media(max-width:760px){.settings-recent-grid>.field>small{min-height:0}.settings-regex-disclosure>summary{min-height:52px}.settings-regex-summary{display:grid;gap:2px}.settings-regex-toolbar{align-items:center;flex-wrap:nowrap}.settings-regex-toolbar>div{flex:1}.settings-regex-toolbar>.btn{width:auto;min-height:36px;margin-left:auto;padding-inline:10px}.settings-regex-rule{grid-template-columns:minmax(0,1fr) 70px;gap:10px;padding:12px}.settings-regex-enabled{grid-column:1;grid-row:1;height:44px;display:flex;align-items:center;justify-content:flex-start;gap:8px}.settings-regex-enabled span{display:inline;color:var(--rcm-text);font-size:12px;font-weight:650}.settings-regex-remove{grid-column:2;grid-row:1;justify-self:end;width:44px;height:44px}.settings-regex-name{grid-column:1;grid-row:2}.settings-regex-flags{grid-column:2;grid-row:2}.settings-regex-pattern{grid-column:1/-1;grid-row:3}.settings-cache-row{height:44px}.settings-cache-clear{width:44px;height:44px}}
@media(max-width:760px){.attention-search input,.attention-filters button{min-height:44px}}
@media(max-width:760px){.management-page>.pagehead{min-height:44px}}
@media(max-width:760px){.operations-page>.pagehead{align-items:center;flex-wrap:nowrap}.operations-page>.pagehead .pagehead__actions{width:auto;margin-left:auto}.operations-actions-desktop{display:none}.operations-actions-mobile{display:block;width:44px;height:44px}.operations-actions-mobile>summary{width:44px;height:44px}.operations-actions-mobile .record-menu__items{right:0;left:auto}}
@media(max-width:760px){.worker-error-notice .home-message__details{gap:10px}}
.attention-toolbar{grid-template-columns:auto minmax(0,1fr);align-items:center}.attention-search{grid-column:1/-1}.attention-toolbar__count{color:var(--rcm-muted);font-size:11px;font-weight:650}.attention-filters{justify-content:flex-end}.attention-detail{grid-template-rows:auto auto minmax(0,1fr)}.attention-detail:has(>.attention-decision)>.attention-detail-body{grid-row:3}.attention-detail>.attention-decision{grid-row:2;border-top:0;border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}
.attention-editor__hint{margin:2px 0 6px;color:var(--rcm-muted);font-size:12px;line-height:1.5}.data-import{border-color:var(--rcm-border);background:var(--rcm-surface)}.data-import:hover{background:var(--rcm-selected)}.data-actions .record-menu__items{right:0;left:auto;min-width:176px}.data-actions .record-menu__items .btn{width:100%;height:auto;min-height:36px;justify-content:flex-start;white-space:nowrap}.operations-actions-mobile .record-menu__items{width:max-content;min-width:226px;max-width:calc(100vw - 28px)}.operations-actions-mobile .record-menu__items .btn{white-space:nowrap}
.topbar__state .status{color:var(--rcm-muted)}.topbar__state .status--ok svg{color:var(--rcm-accent)}.topbar__state .status--warn svg{color:color-mix(in srgb,var(--rcm-warning) 78%,var(--rcm-text))}.topbar__state .status--error svg{color:color-mix(in srgb,var(--rcm-danger) 78%,var(--rcm-text))}
.settings-panel{display:block}.settings-scroll{height:100%}.settings-save-action__icon{display:none}.settings-save-action__label{display:inline}
@media(max-width:760px){.attention-toolbar{padding:0 0 12px;border-bottom:0}.attention-search input{height:44px}.attention-toolbar__count{align-self:center}.attention-filters{justify-content:flex-start}.attention-filters button{min-height:36px}.attention-detail{grid-template-rows:auto auto minmax(0,1fr)}.attention-decision{position:static;grid-template-columns:repeat(2,minmax(0,1fr));padding:9px 14px}.data-import{width:auto;height:44px;padding:0 12px;border-color:transparent;background:color-mix(in srgb,var(--rcm-selected) 72%,transparent)}.data-actions>.btn,.data-actions>.record-menu,.data-actions>.record-menu>summary{width:44px;height:44px}.data-actions .record-menu__items .btn{width:100%;height:auto;min-height:44px}.settings-save-action{width:44px;height:44px;min-width:44px;min-height:44px;padding:11px}.settings-save-action__icon{display:grid;place-items:center}.settings-save-action__label{display:none}.settings-scroll{padding-bottom:24px}}
.relation-more-changes-v2{margin:7px 0 0 12px;border-top:1px solid color-mix(in srgb,var(--rcm-border) 38%,transparent)}.relation-more-changes-v2>summary{min-height:42px;display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--rcm-muted);font-size:12px;font-weight:650;list-style:none}.relation-more-changes-v2>summary::-webkit-details-marker{display:none}.relation-more-changes-v2>summary>span{display:inline-flex;align-items:center;gap:6px}.relation-more-changes-v2>summary small{font-size:10px;font-weight:540}.relation-more-changes-v2>summary::after{content:"›";margin-left:auto;font-size:16px;transition:transform .16s ease}.relation-more-changes-v2[open]>summary::after{transform:rotate(90deg)}.relation-more-changes-v2>div{padding-bottom:4px}
.operation-progress{margin-top:14px;padding:14px 2px 16px;border-block:1px solid color-mix(in srgb,var(--rcm-border) 48%,transparent)}.operation-progress>header{display:flex;align-items:flex-start;gap:12px}.operation-progress>header>div{min-width:0;flex:1}.operation-progress>header strong{display:block;font-size:14px}.operation-progress>header p{margin:3px 0 0;color:var(--rcm-muted);font-size:12px}.operation-progress>header>b{color:var(--rcm-accent);font-size:13px}.operation-progress>div{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));margin-top:13px}.operation-progress>div>span{padding:0 14px;border-left:1px solid color-mix(in srgb,var(--rcm-border) 42%,transparent)}.operation-progress>div>span:first-child{padding-left:22px;border-left:0}.operation-progress small,.operation-progress>div strong{display:block}.operation-progress small{color:var(--rcm-muted);font-size:10px}.operation-progress>div strong{margin-top:3px;font-size:13px;font-variant-numeric:tabular-nums}.operation-phase.is-run strong{color:var(--rcm-accent)}.operation-phase.is-warn strong,.operation-label.is-retrying{color:var(--rcm-warning)}.operation-phase.is-done strong{color:var(--rcm-success)}.operation-history{border-bottom:1px solid color-mix(in srgb,var(--rcm-border) 40%,transparent)}.operation-history>summary{min-height:48px;display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--rcm-muted);font-size:12px;font-weight:680;list-style:none}.operation-history>summary::-webkit-details-marker{display:none}.operation-history>summary::after{content:"›";margin-left:auto;font-size:18px;transition:transform .16s ease}.operation-history[open]>summary::after{transform:rotate(90deg)}.operation-label.is-completed,.operation-label.is-done,.operation-label.is-cancelled,.operation-label.is-superseded{border-color:color-mix(in srgb,var(--rcm-border) 72%,transparent);background:color-mix(in srgb,var(--rcm-selected) 38%,transparent);color:var(--rcm-muted)}.settings-provider>h3{display:flex;align-items:baseline;gap:5px}.settings-provider>h3 .muted{font-size:11px;font-weight:540}
.operation-progress.is-warn{border-color:color-mix(in srgb,var(--rcm-warning) 48%,var(--rcm-border))}.operation-progress>footer{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;padding:12px 14px 0;border-top:1px solid color-mix(in srgb,var(--rcm-border) 42%,transparent)}
.data-import{display:inline-flex;align-items:center;justify-content:center}@media(max-width:760px){.data-management-page>.pagehead .pagehead__actions>.btn{height:44px;min-height:44px}}
@media(max-width:760px){.operation-progress>div{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 0}.operation-progress>div>span{padding-inline:10px;min-width:0}.operation-progress>div>span:nth-child(odd){padding-left:0;border-left:0}.operation-progress>footer .btn{min-height:44px}.operation-history>summary{min-height:52px}.relation-more-changes-v2>summary{min-height:52px}}
@media(prefers-reduced-motion:reduce){.attention-row{transition:none}}
`;

function pageHeader(title: string, description: string, actions = ""): string {
  return `<header class="pagehead"><div class="pagehead__copy"><h1>${escapeHtml(title)}</h1>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div><div class="pagehead__actions">${actions}</div></header>`;
}

export function estimateBackfillAuxiliaryCalls(state: RuntimeState, data: Pick<DashboardData, "initialCalibration">): {
  initialCalls: number;
  storyCalls: number;
  extractionGroups: number;
  groupTurns: number;
  reviewIncluded: boolean;
} {
  const context = state.current;
  if (!context) return { initialCalls: 0, storyCalls: 0, extractionGroups: 0, groupTurns: 4, reviewIncluded: false };
  const visibleAssistantTurns = context.messageVisibility?.filter((message) => message.visibility === "active" && message.role === "assistant").length;
  const completedTurns = visibleAssistantTurns === undefined
    ? Math.ceil(Math.max(0, context.sourceActiveMessageCount) / 2)
    : visibleAssistantTurns;
  const groupTurns = Math.min(50, Math.max(1, Math.round(context.extractionGroupTurns || 6)));
  const extractionGroups = completedTurns > 0 ? Math.ceil(completedTurns / groupTurns) : 0;
  const segmentCalls = Math.min(extractionGroups, Math.max(
    Math.floor(extractionGroups / 4),
    Math.floor(Math.max(0, context.estimatedSourceTokens) / 40_000),
  ));
  const arcCalls = Math.floor(segmentCalls / 4);
  const overviewCalls = arcCalls;
  const initialStatus = data.initialCalibration?.status ?? "unseeded";
  const initialCalibrationCalls = ["unseeded", "awaiting_setup", "failed"].includes(initialStatus) ? 1 : 0;
  const reviewIncluded = state.settings.postExtractionReview;
  return {
    initialCalls: initialCalibrationCalls,
    storyCalls: segmentCalls + arcCalls + overviewCalls,
    extractionGroups,
    groupTurns,
    reviewIncluded,
  };
}

export function shouldOfferBackfill(state: RuntimeState, data: DashboardData): boolean {
  const context = state.current;
  if (!context || !isChatMemoryEnabled(state.settings, context.chatId) || context.sourceActiveMessageCount === 0) return false;
  const serverInventoryKnown = Boolean(data.health?.ok) && !data.adminError;
  const serverChat = data.adminChats.find((chat) => chat.id === context.chatId);
  if (serverChat) return serverChat.ingestionState === "historical_pending" && Number(serverChat.historicalBackfillMessages ?? 0) > 0;
  return serverInventoryKnown && context.sourceActiveMessageCount > 10;
}

export const BACKFILL_SETUP_CAPTURE_MESSAGE = [
  "먼저 인물 설정을 가져와야 합니다.",
  "",
  "채팅에서 메시지를 한 번 전송해 주세요. 보내기 버튼이 녹색 원으로 바뀌면 생성을 취소해도 됩니다.",
  "그다음 이 화면으로 돌아와 ‘과거 대화로 기억 생성’을 다시 눌러 주세요.",
].join("\n");

export function capturedSetupForBackfill(state: RuntimeState, chatId: string): NonNullable<RuntimeState["lastResolvedSetup"]>["projection"] | undefined {
  return state.lastResolvedSetup?.chatId === chatId ? state.lastResolvedSetup.projection : undefined;
}

function requireChatMemoryEnabled(state: RuntimeState, chatId: string): void {
  if (!isChatMemoryEnabled(state.settings, chatId)) {
    throw new Error("현재 채팅에서 RCM이 꺼져 있어 새 기억 작업을 만들 수 없습니다. Settings에서 이 채팅의 RCM을 먼저 켜세요.");
  }
}

export function clearDeletedChatState(state: RuntimeState, chatId: string, clearActivation = true): void {
  for (const scope of Object.keys(state.settings.backfillApproved)) if (scope.endsWith(`:${chatId}`)) delete state.settings.backfillApproved[scope];
  if (clearActivation) {
    delete state.settings.chatEnabled[chatId];
    delete state.settings.chatCatchUpPending[chatId];
    delete state.settings.memoryLanguages[chatId];
    delete state.settings.storyOverviewBackups[chatId];
  }
  invalidateRestoredChatState(state,chatId);
  if(state.current?.chatId===chatId)state.current.backfillApproved=false;
}

function invalidateRestoredChatState(state: RuntimeState,chatId:string):void {
  delete state.cache[chatId];
  if (state.current?.chatId === chatId) {
    state.lastPrepare = undefined;
    state.lastInjection = undefined;
    state.automaticTurnPacket = undefined;
    state.activeModelRequest = undefined;
    state.lastPromptValidation = undefined;
    state.statusSummary = { queuedJobs: 0, failedJobs: 0, pendingReviews: 0, pendingEmbeddings: 0, failedEmbeddings: 0 };
  }
}

export function syncReviewActivity(state: RuntimeState, data: Pick<DashboardData, "reconciliationReviews"> & { extractionAudits?: any[] }): void {
  const pendingReconciliations = data.reconciliationReviews.filter((item) => item.status === "pending").length;
  const pendingAudits = (data.extractionAudits ?? []).filter((item) => item.status === "pending_review" || item.status === "failed").length;
  const pendingReviews = pendingReconciliations + pendingAudits;
  const current = state.statusSummary;
  if (current?.pendingReconciliations === pendingReconciliations
    && current?.pendingReviews === pendingReviews) return;
  state.statusSummary = {
    ...(current ?? { queuedJobs: 0, failedJobs: 0, pendingEmbeddings: 0, failedEmbeddings: 0 }),
    pendingReconciliations,
    pendingReviews,
  };
  state.publishStatusSummary?.();
}

export function reviewBadgeVisible(state: RuntimeState): boolean {
  return (state.statusSummary?.pendingReviews ?? 0) > 0
    && (state.statusSummary?.queuedJobs ?? 0) === 0
    && !state.currentJob
    && (state.serverWorker?.activeCalls ?? 0) === 0;
}

export async function pauseWorkerForQueueMutation(
  state: RuntimeState,
  client: ServerClient,
  dependencies: { persist?: typeof saveSettings; updateMenu?: typeof updateWorkerMenuButton } = {},
): Promise<void> {
  if (state.settings.workerPaused) return;
  if (state.settings.extractionEngine === "server") state.serverWorker = await client.pauseServerWorker();
  state.settings.workerPaused = true;
  await (dependencies.persist ?? saveSettings)(state.settings);
  await (dependencies.updateMenu ?? updateWorkerMenuButton)(state);
  state.publishActivity?.();
}

export async function closeDashboardContainer(
  state: RuntimeState,
  hideContainer: () => Promise<void> = () => risuai.hideContainer(),
): Promise<void> {
  // The floating widget lives in PocketRisu's host document while this code
  // runs inside the plugin iframe. Restore it before the host hides/throttles
  // the iframe, otherwise the follow-up host call may never become visible.
  try {
    await state.setStatusWidgetHidden?.(false);
  } catch (error) {
    addLog(state.logs, "warn", `Status widget restore failed while closing dashboard: ${String(error)}`);
  }
  await hideContainer();
}

function backfillNotice(state: RuntimeState, data: DashboardData): string {
  const lineageNotice = lineageProbeNotice(state);
  if (lineageNotice) return lineageNotice;
  const context = state.current;
  if (context && !isChatMemoryEnabled(state.settings, context.chatId)) return homeMessage({
    title: "현재 채팅에서 RCM이 꺼져 있습니다",
    bodyHtml: "<p>기존 기억은 보존되며 새 동기화·추출·과거 기억 생성·기억 도구 호출은 만들지 않습니다.</p>",
  });
  if (!context || !shouldOfferBackfill(state, data)) return "";
  const serverMissing = Boolean(data.health?.ok) && !data.adminError && !data.adminChats.some((chat) => chat.id === context.chatId);
  const serverChat = data.adminChats.find((chat) => chat.id === context.chatId);
  const pocketCount = Number(context.sourceMessageCount);
  const syncedCount = Number(serverChat?.messages ?? 0);
  const title = "과거 대화를 기억으로 정리할까요?";
  const detail = serverMissing
    ? "현재 Risu 채팅 전체를 처음 동기화해 기억·관계·세계 사실을 만듭니다."
    : "서버에 아직 없는 과거 원문을 가져와 기억·관계·세계 사실을 만듭니다.";
  const calls = estimateBackfillAuxiliaryCalls(state, data);
  return homeMessage({
    title,
    bodyHtml: `<p>${detail}</p><div class="home-backfill__meta"><span>Risu 원문 ${pocketCount.toLocaleString()}개</span><span>서버 ${syncedCount.toLocaleString()}개</span><span>원문 약 ${context.estimatedSourceTokens.toLocaleString()}토큰</span><span>기억 정리 약 ${calls.extractionGroups.toLocaleString()}묶음</span></div><p>기억 정리 외에 상태 대조·관계·줄거리 정리에도 보조 모델을 호출합니다. 전체 호출 수는 추출 결과에 따라 늘어납니다.</p><details class="home-backfill__details"><summary>예상 호출 구성 보기</summary><p>${calls.groupTurns}턴씩 기억 정리 · 기본 약 ${calls.extractionGroups.toLocaleString()}회<br>초기 장부 ${calls.initialCalls}회 · 줄거리 정리 약 ${calls.storyCalls.toLocaleString()}회<br>상태 대조: 필요한 묶음마다 추가<br>관계 상태·마지막 장부 대조: 추출 결과에 따라 추가<br>재검수: 선택 시 묶음마다 1회 추가${calls.reviewIncluded ? " · 현재 기본값 켜짐" : ""}<br>형식·근거 보완, 이어서 추출, 재시도는 필요할 때 추가됩니다.</p><p>원문 토큰은 실제 전송량이나 청구량이 아닙니다. 진행 화면에서 후처리를 포함한 실제 호출 수를 확인할 수 있습니다.</p></details><small class="home-backfill__hint">로어북에 과거 줄거리 요약이 있다면 잠시 끈 뒤 시작해 주세요.</small>`,
    actionsHtml: '<button class="btn btn--primary home-backfill__action" data-action="approve-backfill">과거 대화로 기억 생성</button>',
  });
}

function lineageProbeNotice(state: RuntimeState): string {
  const probe = state.lineageProbe;
  if (probe?.status !== "ready" || !probe.result || probe.result.status === "none") return "";
  const candidates = probe.result.candidates;
  const selected = probe.selectedParentId ?? candidates[0]?.chatId ?? "";
  const choice = probe.result.status === "ambiguous"
    ? `<select data-action="select-probe-source">${candidates.map((item) => `<option value="${escapeHtml(item.chatId)}" ${selected === item.chatId ? "selected" : ""}>${escapeHtml(item.title || item.chatId)}</option>`).join("")}</select>`
    : "";
  return homeMessage({
    title: "기존 채팅에서 복사되거나 분기된 기록을 찾았습니다",
    bodyHtml: `<p>${candidates.length === 1 ? `${escapeHtml(candidates[0]!.title || candidates[0]!.chatId)} · 공통 원문 ${candidates[0]!.sharedMessages.toLocaleString()}개` : "이어받을 원본을 선택하세요."}</p>`,
    actionsHtml: `${choice}<button class="btn btn--primary" data-action="apply-probed-lineage" data-parent-id="${escapeHtml(selected)}">기억 이어받기</button>`,
  });
}

const lineageProbeFlights = new Map<string, Promise<void>>();

function lineageProbePayload(context: NonNullable<Awaited<ReturnType<typeof readOptionalCurrentContext>>["context"]>): LineageProbeRequest {
  const request = makePrepareRequest(context, 0, { deferExtraction: true });
  return {
    chatTitle: request.chatTitle,
    characterId: request.characterId,
    profile: request.profile,
    messageVisibility: request.messageVisibility ?? [],
    lineageHint: request.lineageHint,
    canonicalizationPolicy: request.canonicalizationPolicy,
    includeUserMessages: request.includeUserMessages,
    extractionGroupTurns: request.extractionGroupTurns,
    memoryLanguage: request.memoryLanguage,
  };
}

async function probeDashboardLineage(state: RuntimeState, client: ServerClient, context: NonNullable<Awaited<ReturnType<typeof readOptionalCurrentContext>>["context"]>): Promise<void> {
  if (!isChatMemoryEnabled(state.settings, context.chatId)) return;
  const projection = context.messageVisibility ?? [];
  const last = projection.at(-1);
  const key = `${state.settings.serverUrl.replace(/\/$/, "")}:${context.chatId}:${projection.length}:${last?.id ?? ""}:${last?.contentHash ?? ""}:${context.lineageHint?.parentChatId ?? ""}:${context.lineageHint?.forkMessageId ?? ""}:${context.lineageHint?.markerMessageId ?? ""}`;
  if (state.lineageProbe?.key === key && state.lineageProbe.status === "ready") return;
  const existing = lineageProbeFlights.get(key);
  if (existing) return existing;
  state.lineageProbe = { key, status: "checking" };
  const flight = (async () => {
    try {
      const result = await client.request<LineageProbeResponse>(`/v1/chats/${encodeURIComponent(context.chatId)}/lineage/probe`, { method: "POST", body: JSON.stringify(lineageProbePayload(context)) }, 15_000);
      state.lineageProbe = { key, status: "ready", result, selectedParentId: result.candidates[0]?.chatId };
    } catch (error) {
      state.lineageProbe = { key, status: "failed", error: String(error) };
    } finally {
      lineageProbeFlights.delete(key);
    }
  })();
  lineageProbeFlights.set(key, flight);
  return flight;
}

export function pendingBufferNotice(data: DashboardData): string {
  if (data.ingestionState !== "managed" || (data.bufferedMessages <= 0 && data.waitingForAssistant <= 0)) return "";
  const tokens = data.bufferedSourceTokens >= 1_000 ? `${(data.bufferedSourceTokens / 1_000).toFixed(1)}k` : data.bufferedSourceTokens.toLocaleString();
  return `<div class="notice" role="status">${icon("clock")}<div><strong>정리 가능한 턴 ${data.bufferedTurns}/${data.extractionGroupTurns} · 약 ${tokens} tokens</strong></div></div>`;
}

function workerAttentionNotice(state: RuntimeState, linkToQueue = false): string {
  const attention = state.settings.workerAttention;
  if (!attention) return "";
  return homeMessage({
    title: "기억 처리가 오류로 멈췄습니다.",
    bodyHtml: `<p>${formatTime(attention.at)} · 처리 상태를 확인한 뒤 직접 재개하세요.</p>`,
    detailsHtml: `<code class="worker-error-code">${escapeHtml(attention.message)}</code>${linkToQueue ? '<button class="home-message__action-link" data-action="tab" data-tab="operations">처리 상태에서 보기 <span aria-hidden="true">→</span></button>' : ""}`,
    disclosureLabel: "오류 내용",
    tone: "danger",
    role: "alert",
    className: "worker-error-notice",
  });
}

export function initialCalibrationNotice(data: Pick<DashboardData, "initialCalibration">): string {
  const calibration = data.initialCalibration;
  if (calibration?.status === "queued") return homeMessage({
    title: "초기 장부를 만들고 있습니다",
    bodyHtml: "<p>설정 원문에서 인물과 초기 관계를 먼저 정리합니다. 완료되면 확인을 요청할게요.</p>",
  });
  if (calibration?.status === "awaiting_confirmation") return homeMessage({
    title: "초기 장부 확인이 필요합니다",
    bodyHtml: "<p>분석된 인물과 초기 관계를 확인하면 과거 기억 생성을 이어서 시작합니다.</p>",
    actionsHtml: '<button class="home-message__action-link" data-action="open-initial-calibration">초기 장부 확인 <span aria-hidden="true">→</span></button>',
    tone: "warning",
  });
  if (calibration?.status === "awaiting_setup") return homeMessage({
    title: "인물 설정을 먼저 가져와 주세요",
    bodyHtml: "<p>채팅에 메시지를 한 번 보내고 전송 버튼이 녹색 원으로 돌아오면, 기억 홈에서 ‘과거 대화로 기억 생성’을 다시 눌러 주세요.</p>",
    tone: "warning",
  });
  if (calibration?.status === "failed") return homeMessage({
    title: "초기 장부를 만들지 못했습니다",
    bodyHtml: `<p>${escapeHtml(calibration.lastError ?? "초기 설정 분석을 다시 시도하거나 건너뛸 수 있습니다.")}</p>`,
    actionsHtml: '<button class="home-message__action-link" data-action="open-initial-calibration">초기 장부에서 확인 <span aria-hidden="true">→</span></button>',
    tone: "danger",
  });
  return "";
}

export function dashboardLiveDataSignature(summary: RuntimeState["statusSummary"]): string {
  return JSON.stringify({ progress: summary?.progress, initialCalibration: summary?.initialCalibration?.status });
}

export function overview(state: RuntimeState, data: DashboardData, translations: Map<string, string> = new Map()): string {
  const queued = data.jobs.filter((job) => ["queued", "leased"].includes(job.status)).length;
  const blockingFailed = data.jobs.filter((job) => job.status === "failed" && job.type === "extract").length;
  const advisoryFailed = data.jobs.filter((job) => job.status === "failed" && job.type !== "extract").length;
  const failed = blockingFailed + advisoryFailed;
  const health = data.health?.ok ? status("ok", `서버 · ${data.health.version}`) : status("warn", data.connectionIssue?.title ?? "서버 연결 확인 필요");
  const vector = data.health?.embeddingReady
    ? status("ok", `임베딩 · ${data.health.embedding?.model ?? "Context 4"} 준비됨`)
    : status("warn", data.health?.embedding?.configured && data.health?.vectorEnabled ? "임베딩 준비 중" : "텍스트 검색 사용 중");
  const currentChatId = state.current?.chatId ?? "";
  const currentInstanceId = data.health?.instanceId;
  const liveInjection = state.lastInjection?.chatId === currentChatId
    && (!currentInstanceId || state.lastPrepare?.serverInstanceId === currentInstanceId) ? state.lastInjection : undefined;
  const cachedState = state.cache[currentChatId];
  const compatibleCache = cachedState && (!currentInstanceId || cachedState.serverInstanceId === currentInstanceId) ? cachedState : undefined;
  const cachedPacket = compatibleCache?.lastPacket ?? "";
  const packet = liveInjection?.packet ?? cachedPacket;
  const manifest = liveInjection?.manifest ?? compatibleCache?.lastInjectionManifest;
  const injectionAt = liveInjection?.at ?? compatibleCache?.lastInjectionAt;
  const packetTokens = liveInjection ? liveInjection.injectedTokens : packet ? estimateTokens(packet) : 0;
  const hardTokenCeiling = liveInjection ? Math.floor(liveInjection.requestedBudget * 115 / 100) : 0;
  const packetTitle = liveInjection ? "실제 주입 패킷" : "마지막 준비 패킷 · 캐시";
  const injectionReceipt = liveInjection
    ? liveInjection.evidenceInjected === true ? "기억 근거와 안내를 전달했습니다."
      : liveInjection.guidanceInjected === true ? "이번에는 기억 근거 없이 안내만 전달했습니다."
        : liveInjection.guidanceInjected === false && liveInjection.evidenceInjected === false ? "이번에는 RCM 내용을 전달하지 않았습니다."
          : "이번 주입의 포함 상태를 기록하지 않은 이전 실행입니다."
    : packet || manifest ? "이전 주입 내역입니다. 이번 전송의 포함 상태는 확인할 수 없습니다." : "";
  const packetMeta = liveInjection
    ? `${packetTokens.toLocaleString()} tokens · ${formatTime(injectionAt)}`
    : `${packetTokens.toLocaleString()} tokens 추정${injectionAt ? ` · ${formatTime(injectionAt)}` : ""}`;
  const sourceLabels: Record<string, string> = { fresh: "새로 검색", reused: "같은 요청 재사용", fallback: "서버 장애 시 안정 앵커", empty: "주입 없음" };
  const chatEnabled = state.current ? isChatMemoryEnabled(state.settings, state.current.chatId) : false;
  const validation = state.lastPromptValidation?.chatId === currentChatId ? state.lastPromptValidation : undefined;
  const validationCopy = !state.current ? "활성 채팅 없음"
    : !chatEnabled ? "현재 채팅에서 RCM 꺼짐"
      : validation?.status === "marker_present" ? "[[RCM]] 표식 확인됨"
        : validation?.status === "existing_context" ? "기존 RCM 패킷 확인됨"
          : validation?.status === "marker_missing" ? "표식 누락 — 전송 중단"
            : "이번 실행에서 아직 모델 요청 없음";
  const queueState = data.jobsError ? status("error", "작업 큐 확인 필요") : queued ? status("warn", `작업 대기 · ${queued}건`) : status("ok", "대기 작업 없음");
  const resolvedPerspectives = state.lastPrepare?.perspectiveResolution?.perspectives ?? state.perspectiveStatus?.perspectives ?? [];
  const perspectiveState = state.perspectiveStatus?.unresolved
    ? status("warn", "관점 확인 필요")
    : resolvedPerspectives.length ? status("ok", `관점 · ${resolvedPerspectives.join(" · ")}`) : "";
  const chatState = state.current ? status("ok", `채팅 · ${state.current.chatTitle || state.current.characterName}`) : "";
  const statusItems = `${health}${vector}${chatState}${perspectiveState}${status(validation?.status === "marker_missing" ? "error" : chatEnabled ? "ok" : "warn", validationCopy)}${state.settings.workerPaused ? status("warn", "처리 일시정지") : state.workerBusy ? status("warn", "기억 처리 중") : ""}${queueState}${blockingFailed ? status("error", `추출 실패 ${blockingFailed}건`) : ""}${advisoryFailed ? status("warn", `부가 정리 실패 ${advisoryFailed}건`) : ""}`;
  const pendingConflicts = data.conflicts.filter((item) => item.status === "pending").length;
  const conflictAction = pendingConflicts
    ? `<button class="home-message__action-link" data-action="tab" data-tab="reviews" data-attention-filter="conflict">충돌 ${pendingConflicts}건 확인 <span aria-hidden="true">→</span></button>`
    : "";
  const needsAttention = Boolean(data.connectionIssue) || !data.health?.ok || failed > 0 || validation?.status === "marker_missing" || state.settings.workerPaused || pendingConflicts > 0;
  const backfillPending = shouldOfferBackfill(state, data);
  const hasDerivedData = data.memories.length + data.relationships.length + data.assertions.length + data.promises.length > 0;
  const processing = queued > 0 || state.workerBusy;
  const pendingState = backfillPending || !hasDerivedData || processing || data.bufferedTurns > 0;
  const healthMode = needsAttention ? "attention" : pendingState ? "pending" : "ready";
  const healthTitle = data.connectionIssue?.title ?? (!data.health?.ok ? "기억 서버를 확인해 주세요"
    : blockingFailed ? `멈춘 기억 추출 ${blockingFailed}건을 확인해 주세요`
      : advisoryFailed ? `완료하지 못한 부가 정리 ${advisoryFailed}건이 있습니다`
      : pendingConflicts ? `확인이 필요한 충돌 ${pendingConflicts}건`
        : backfillPending && !hasDerivedData ? "아직 만들어진 기억이 없습니다"
          : processing ? "기억을 정리하고 있습니다"
            : !hasDerivedData ? "첫 기억을 기다리고 있습니다"
              : data.bufferedTurns > 0 ? "다음 기억 묶음을 기다리고 있습니다"
                : "기억 처리가 정상입니다");
  const healthDetail = data.connectionIssue?.detail ?? (blockingFailed ? "해당 대화 묶음의 1차 추출이 끝나지 않아 이후 기억 추출을 멈췄습니다."
    : advisoryFailed ? "기억 추출은 계속 진행됐습니다. 관계·줄거리·최종 대조 같은 부가 작업은 처리 상태에서 다시 확인할 수 있습니다."
    : queued ? `대기 중 ${queued}건 · 완료된 항목부터 차례로 표시됩니다.`
    : backfillPending && !hasDerivedData ? "과거 대화로 기억을 생성하면 이곳에 채워집니다."
      : !hasDerivedData ? "완료된 RP 턴이 모이면 자동으로 정리합니다."
        : data.bufferedTurns > 0 ? `현재 ${data.bufferedTurns}/${data.extractionGroupTurns || 6}턴이 준비되었습니다.`
          : "처리 가능한 기록은 모두 반영되었습니다.");
  const alerts = `${updateNotice(state)}${lineagePanel(data)}${initialCalibrationNotice(data)}${backfillNotice(state, data)}${data.connectionIssue ? "" : workerAttentionNotice(state, true)}`;
  const recent = data.memories.filter((memory) => !memory.capsule_parent_id).slice(0, 3);
  const recentRows = recent.length ? recent.map((memory) => {
    const title = translations.get(`${memory.id}:title`) ?? memory.title ?? "제목 없는 기억";
    const content = translations.get(`${memory.id}:content`) ?? memory.content ?? "";
    const when = memory.story_time || memory.storyTime || formatRelativeTime(memory.updated_at);
    return `<button class="home-memory" data-action="open-timeline-memory" data-memory-id="${escapeHtml(memory.id)}"><span class="home-memory__when">${escapeHtml(when)}</span><span class="home-memory__copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(content)}</span></span><small>${escapeHtml(memory.type || "memory")}</small><span class="home-memory__arrow" aria-hidden="true">›</span></button>`;
  }).join("") : `<div class="home-empty">${backfillPending ? "과거 대화로 기억을 생성하면 최근 기억이 여기에 표시됩니다." : "첫 기억 묶음이 정리되면 여기에 표시됩니다."}</div>`;
  const targetBudget = liveInjection?.requestedBudget ?? state.settings.memoryBudgets[currentChatId] ?? state.settings.defaultMemoryBudget;
  const injectionProgress = targetBudget > 0 ? Math.min(100, Math.round(packetTokens / targetBudget * 100)) : 0;
  const bufferTarget = Math.max(1, data.extractionGroupTurns || state.current?.extractionGroupTurns || 6);
  const manifestDetails = manifest?.source === "fallback"
    ? '<div class="home-empty">검색이 완료되지 않아 항목별 명세 없음</div>'
    : manifest ? `<dl class="home-manifest"><div><dt>스토리</dt><dd>${manifest.storySpineNodeIds?.length ?? 0}</dd></div><div><dt>기억</dt><dd>${manifest.memoryIds.length}</dd></div><div><dt>세부</dt><dd>${manifest.detailIds.length}</dd></div><div><dt>관계</dt><dd>${manifest.relationshipPairs.length}</dd></div><div><dt>세계 사실</dt><dd>${manifest.assertionIds.length}</dd></div><div><dt>약속</dt><dd>${manifest.promiseIds.length}</dd></div></dl>` : '<div class="home-empty">아직 실제 주입 내역이 없습니다.</div>';
  const budgetTechnical = liveInjection ? `${liveInjection.requestedBudget.toLocaleString()} target · ${hardTokenCeiling.toLocaleString()} max` : "";
  const injectionFacts = [
    ["관점", resolvedPerspectives.join(" · ") || "자동"],
    ["최근 기억", `${manifest?.memoryIds.length ?? 0}개`],
    ["스토리 흐름", `${manifest?.storySpineNodeIds?.length ?? 0}개`],
    ["관계 상태", `${manifest?.relationshipPairs.length ?? 0}쌍`],
  ];
  const workflowSteps = Array.from({ length: bufferTarget }, (_, index) => `<i class="${index < (data.bufferedTurns || 0) ? "is-done" : ""}"></i>`).join("");
  const latestMemoryAt = recent.map((memory) => Number(memory.updated_at ?? 0)).sort((a, b) => b - a)[0] || injectionAt;
  const hasInjection = Boolean(injectionAt && (packet || liveInjection || (manifest && manifest.source !== "empty")));
  const injectionBody = hasInjection ? `<p class="muted">${escapeHtml(injectionReceipt)}</p><div class="home-token"><strong>${packetTokens.toLocaleString()}</strong><span>/ ${targetBudget.toLocaleString()} tokens</span></div><div class="home-progress"><span style="transform:scaleX(${injectionProgress / 100})"></span></div><div class="home-injection-meta"><span>${escapeHtml(sourceLabels[manifest?.source ?? "empty"] ?? "준비됨")}</span><span>${escapeHtml(packetMeta)}</span></div><dl class="home-injection-facts">${injectionFacts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl><details class="home-disclosure"><summary>포함된 항목 전체 <span aria-hidden="true">+</span></summary><div>${manifestDetails}${manifest?.relationshipPairs.length ? `<p class="muted">관계 · ${manifest.relationshipPairs.map((pair) => `${escapeHtml(pair.from)} → ${escapeHtml(pair.to)}`).join(" · ")}</p>` : ""}<section class="home-packet-details"><header><span><strong>패킷 원문</strong><small>${escapeHtml(packetTitle)}</small></span></header><div class="home-packet-body"><div class="home-packet-meta"><span>읽기 전용</span>${budgetTechnical ? `<span>${escapeHtml(budgetTechnical)}</span>` : ""}</div>${packet ? `<pre>${escapeHtml(packet)}</pre>` : '<div class="home-empty">표시할 패킷이 없습니다.</div>'}</div></section></div></details>`
    : '<div class="home-injection-empty"><strong>아직 전달된 기억이 없습니다</strong><p>기억이 만들어진 뒤 메인 모델에 전달된 내용을 보여줍니다.</p></div>';
  const workflow = backfillPending ? "" : `<section class="home-workflow"><div class="home-workflow__copy"><span class="home-workflow__icon">${icon("clock")}</span><div><strong>다음 기억 정리</strong><span>수정 보호가 끝난 RP 턴을 ${bufferTarget}턴 모아 기억으로 정리합니다.</span></div></div><div class="home-workflow__progress"><div class="home-workflow__steps">${workflowSteps}</div><small>${data.bufferedTurns || 0} / ${bufferTarget}턴</small></div></section>`;
  const healthMessage = data.connectionIssue ? homeMessage({
    title: healthTitle,
    bodyHtml: `<p>${escapeHtml(healthDetail)}</p>`,
    actionsHtml: '<button class="home-message__action-link" data-action="tab" data-tab="settings" data-settings-section="server">서버 설정 열기 <span aria-hidden="true">→</span></button>',
    tone: "warning",
  }) : backfillPending ? "" : homeMessage({
    title: healthTitle,
    bodyHtml: `<p>${escapeHtml(healthDetail)}</p>`,
    detailsHtml: `${statusItems}${conflictAction}`,
    disclosureLabel: `상태 ${needsAttention ? "확인" : "보기"}`,
    tone: healthMode === "ready" ? "success" : healthMode === "attention" ? "warning" : "neutral",
  });
  return `<div class="home-page">
    <header class="home-heading"><div><p class="home-eyebrow">기억 상태</p><h1>기억 홈</h1></div>${latestMemoryAt ? `<span class="home-profile">마지막 갱신 ${formatRelativeTime(latestMemoryAt)}</span>` : ""}</header>
    <div class="home-alerts">${alerts}</div>
    ${healthMessage}
    <section class="home-metrics" aria-label="기억 요약">
      <div><span>Risu 원문</span><strong>${Number(state.current?.sourceMessageCount ?? 0).toLocaleString()}</strong><small>현재 채팅 기록</small></div>
      <div><span>기억</span><strong>${data.memories.length.toLocaleString()}</strong><small>정리된 장면</small></div>
      <div><span>관계</span><strong>${data.relationships.length.toLocaleString()}</strong><small>추적 관계</small></div>
      <div><span>세계 사실</span><strong>${data.assertions.length.toLocaleString()}</strong><small>활성 사실</small></div>
      <div><span>열린 약속</span><strong>${data.promises.filter((item) => item.status === "open").length.toLocaleString()}</strong><small>진행 중</small></div>
    </section>
    <div class="home-grid">
      <section class="home-section home-section--memories"><div class="home-section__head"><div><h2>최근 기억</h2><p>가장 최근에 정리된 장면</p></div><button class="home-link" data-action="tab" data-tab="timeline">모두 보기 <span aria-hidden="true">›</span></button></div><div class="home-memory-list">${recentRows}</div></section>
      <section class="home-section home-section--injection"><div class="home-section__head"><div><h2>최근 주입</h2><p>메인 모델에 전달된 기억</p></div></div>${injectionBody}</section>
    </div>
    ${workflow}
  </div>`;
}

function lineagePanel(data: DashboardData): string {
  const lineage = data.lineage;
  if (!lineage || ["none", "reverted", "independent"].includes(lineage.status) || lineage.acknowledgedAt) return "";
  if (lineage.status === "ambiguous" || lineage.status === "choice_required") {
    const candidates = lineage.ambiguousCandidates ?? [];
    const fingerprint = candidates[0]?.fingerprint ?? "";
    return homeMessage({
      title: candidates.length > 1 ? "이어받을 원본 채팅을 선택해 주세요" : "복사된 채팅의 기억을 이어받을까요?",
      bodyHtml: candidates.length > 1
        ? "<p>같은 메시지를 가진 후보가 여러 개입니다.</p>"
        : "<p>원본의 기억을 이어받거나, 이 채팅을 독립적으로 시작할 수 있습니다.</p>",
      actionsHtml: `${candidates.map((item) => `<button class="btn${candidates.length === 1 ? " btn--primary" : ""}" data-action="select-lineage" data-parent-id="${escapeHtml(item.chatId)}">${candidates.length === 1 ? "기억 이어받기" : `${escapeHtml(item.title)} · ${item.sharedMessages}개 일치`}</button>`).join("")}<button class="btn" data-action="decline-lineage" data-fingerprint="${escapeHtml(fingerprint)}">새로 시작</button>`,
      tone: "warning",
    });
  }
  const labels: Record<string, string> = { messages: "원문", memories: "기억", relationships: "관계", assertions: "사실", beliefs: "belief", promises: "약속", socialKnowledge: "지인", physicalIntimacy: "스킨십", pendingReextraction: "자식에서 다시 정리할 원문" };
  const counts = Object.entries(lineage.inheritedCounts ?? {}).filter(([, value]) => value > 0).map(([key, value]) => `${labels[key] ?? key} ${value}`).join(" · ");
  const kind = lineage.kind === "branch" ? "과거 분기" : lineage.kind === "pruned_copy" ? "앞부분을 자른 복사" : "전체 복사";
  return homeMessage({
    title: `${lineage.parentTitle ?? lineage.parentChatId ?? "원본 채팅"}에서 기억을 상속했습니다.`,
    bodyHtml: `<p>${kind}${lineage.forkOrdinal !== undefined ? ` · fork #${lineage.forkOrdinal}` : ""}${counts ? ` · ${escapeHtml(counts)}` : ""}</p>`,
    actionsHtml: '<button class="btn btn--primary" data-action="acknowledge-lineage">확인</button><button class="btn btn--danger" data-action="revert-lineage">상속 취소하고 현재 원문으로 다시 시작</button>',
    tone: "success",
  });
}

export function lineagePath(data: DashboardData): string {
  const ancestry = data.lineage?.ancestry ?? [];
  if (ancestry.length < 2) return "";
  const renderPath = (items: typeof ancestry): string => `<div class="lineage-path__row">${items.map((item, index) => {
    const edge = index === 0 ? "" : `<span class="lineage-path__edge"><b>→</b><span>${item.kind === "branch" ? "분기" : item.kind === "pruned_copy" ? "잘린 복사" : item.detection === "manual_cross_bot" ? "수동 상속" : "복사"}${item.forkOrdinal === undefined ? "" : ` #${item.forkOrdinal}`}</span></span>`;
    const label = item.title || item.chatId;
    const node = item.exists
      ? `<button class="lineage-path__node" data-action="view-server-data" data-chat-id="${escapeHtml(item.chatId)}" title="${escapeHtml(item.chatId)}">${escapeHtml(label)}</button>`
      : `<span class="lineage-path__node is-missing" title="${escapeHtml(item.chatId)}">${escapeHtml(label)} · 원본 서버 자료 없음</span>`;
    return `${edge}${node}`;
  }).join("")}</div>`;
  const path = renderPath(ancestry);
  return `<section class="panel lineage-path"><div class="panel__head"><h2>채팅 계보</h2><span>각 채팅은 상속 시점 이후 독립적으로 진행됩니다.</span></div><div class="panel__body">${ancestry.length > 5 ? `<details><summary>${escapeHtml(ancestry[0]?.title || ancestry[0]?.chatId)} → ${ancestry.length - 2}개 중간 세대 → ${escapeHtml(ancestry.at(-1)?.title || ancestry.at(-1)?.chatId)}</summary>${path}</details>` : path}</div></section>`;
}

export function noActiveChat(data: DashboardData, tab: Tab): string {
  const headings: Record<Exclude<Tab, "data" | "settings">, [string, string]> = {
    overview: ["기억 홈", "현재 채팅의 기억 상태를 확인합니다."],
    initial: ["등장인물", "인물을 찾고 확인합니다."],
    story: ["줄거리", "이야기의 흐름을 한곳에서 읽습니다."],
    timeline: ["타임라인", "기억을 찾고 확인합니다."],
    relationships: ["관계", "인물 사이의 관계를 확인합니다."],
    world: ["세계 상태", "현재 세계의 사실을 확인합니다."],
    reviews: ["상태 확인", "RCM이 자동으로 바꾸지 않은 상태와 충돌을 확인합니다."],
    conflicts: ["충돌", "자동으로 덮어쓰지 않은 사실 충돌을 검토합니다."],
    operations: ["처리 상태", "현재 채팅의 기억 처리와 실패한 작업을 확인합니다."],
  };
  const [title, description] = headings[tab as Exclude<Tab, "data" | "settings">] ?? headings.overview;
  const health = data.health?.ok ? status("ok", `서버 · ${data.health.version}`) : status("error", "서버 연결 확인 필요");
  const vector = data.health?.embeddingReady
    ? status("ok", `임베딩 · ${data.health.embedding?.model ?? "Context 4"} 준비됨`)
    : status("warn", data.health?.embedding?.configured ? "임베딩 확인 필요" : "텍스트 검색 사용 중");
  const detail = data.contextError
    ? `Risu에서 현재 채팅 정보를 읽지 못했습니다: ${data.contextError}`
    : "캐릭터 채팅에 들어가면 이 탭에 해당 채팅의 기억과 작업 상태가 표시됩니다. 서버 연결과 전역 설정은 그대로 유지됩니다.";
  const inactiveMessage = homeMessage({
    title: "활성 채팅이 없습니다",
    bodyHtml: "<p>채팅을 선택하면 기억을 불러옵니다.</p>",
    detailsHtml: `${health}${vector}${status("warn", "활성 채팅 없음")}`,
    disclosureLabel: "상태 보기",
    tone: "neutral",
  });
  return `<div class="home-page no-active-home">
    <header class="home-heading"><div><p class="home-eyebrow">기억 상태</p><h1>${escapeHtml(title)}</h1><p class="no-active-home__description">${escapeHtml(description)}</p></div></header>
    ${inactiveMessage}
    <section class="no-active-home__body"><strong>현재 선택된 채팅이 없습니다.</strong><p>${escapeHtml(detail)}</p><div class="actions"><button class="btn" data-action="tab" data-tab="data">저장된 채팅 보기</button><button class="btn" data-action="tab" data-tab="settings">서버 설정 보기</button></div></section>
  </div>`;
}

const initialAxisValues: Record<string, string[]> = {
  affection: ["unknown", "aversion", "none", "faint", "growing", "established", "strong", "deep", "conflicted"],
  trust: ["unknown", "distrust", "none", "fragile", "developing", "established", "strong", "deep", "conflicted"],
  intimacy: ["unknown", "avoidant", "none", "tentative", "developing", "established", "strong", "deep", "conflicted"],
  fear: ["unknown", "none", "low", "moderate", "high", "extreme"], jealousy: ["unknown", "none", "low", "moderate", "high", "extreme"], hostility: ["unknown", "none", "low", "moderate", "high", "extreme"],
};
const initialAxisLabel: Record<string, string> = { unknown: "알 수 없음", aversion: "반감", distrust: "불신", avoidant: "회피", none: "없음", faint: "희미함", fragile: "불안정", tentative: "조심스러움", growing: "커지는 중", developing: "발전 중", established: "확립됨", strong: "강함", deep: "깊음", conflicted: "복합적·갈등", low: "낮음", moderate: "보통", high: "높음", extreme: "극심함" };

function entityMergePanel(data: DashboardData, mergePreview?: any): string {
  const people = data.entities.filter((entity: any) => ["person", "character"].includes(entity.type));
  if (people.length < 2) return '<div class="people-empty">합칠 수 있는 인물이 없습니다.</div>';
  const options = (selected?: string, excluded?: string) => `<option value="">인물을 선택하세요</option>${people
    .filter((entity: any) => String(entity.id) !== excluded)
    .sort((left: any, right: any) => entityProminence(left) - entityProminence(right) || compareUiText([left.name, right.name]))
    .map((entity: any) => `<option value="${escapeHtml(entity.id)}" ${String(entity.id) === selected ? "selected" : ""}>${escapeHtml(entity.displayName || entity.name)}</option>`).join("")}`;
  return `<article class="person-management"><header class="person-reader__head"><div><span>인물 관리</span><h2>중복 인물 합치기</h2></div><div class="person-reader__actions"><button class="btn btn--icon" type="button" data-action="close-people-management" aria-label="닫기" title="닫기">${icon("close")}</button></div></header><div class="person-editor__body"><form id="entity-merge-form" class="merge-form"><label class="field"><span>합칠 인물</span><select name="sourceId">${options(mergePreview?.source.id, mergePreview?.target.id)}</select></label><span class="merge-form__arrow" aria-hidden="true">→</span><label class="field"><span>남길 인물</span><select name="targetId">${options(mergePreview?.target.id, mergePreview?.source.id)}</select></label><button class="btn btn--primary" type="button" data-action="preview-entity-merge">병합 내용 확인</button></form>${mergePreview ? `<div class="merge-preview"><p><strong>${escapeHtml(mergePreview.source.name)}</strong>의 연결 기록을 <strong>${escapeHtml(mergePreview.target.name)}</strong>으로 합칩니다.</p>${mergePreview.impact ? `<dl class="impact-grid">${Object.entries(mergePreview.impact).slice(0, 4).map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${Number(value)}</dd></div>`).join("")}</dl>` : ""}<div class="actions"><button class="btn" type="button" data-action="cancel-entity-merge">미리보기 닫기</button><button class="btn btn--danger" type="button" data-action="merge-entities-final" data-source-id="${escapeHtml(mergePreview.source.id)}" data-target-id="${escapeHtml(mergePreview.target.id)}" data-revision="${mergePreview.revision}" ${mergePreview.busy ? "disabled" : ""}>인물 합치기</button></div></div>` : ""}</div></article>`;
}

export function initialCalibrationPage(data: DashboardData, view: PeopleViewState, translations: TranslationView = new Map(), display: RuntimeState["settings"]["translationDisplay"] = "en", mergePreview?: any): string {
  const calibration = data.initialCalibration ?? { status: "unseeded", entities: [], relationships: [], locked: false };
  const labels: Record<string, string> = { unseeded: "분석 준비", awaiting_setup: "설정 캡처 대기", queued: "초기 인물 분석 중", awaiting_confirmation: "인물 확인 필요", ready: "준비됨", failed: "초기 분석 실패", inherited: "상속됨", skipped: "초기 분석 건너뜀" };
  const calibrationById = new Map((calibration.entities ?? []).map((item: any) => [String(item.id), item]));
  const calibrationByName = new Map((calibration.entities ?? []).flatMap((item: any) => [item.internalName, item.displayName]
    .filter(Boolean).map((value) => [String(value).normalize("NFKC").trim().toLocaleLowerCase(), item])));
  const seen = new Set<string>();
  const people = [...data.entities.map((entity: any) => {
    const initial = (calibrationById.get(String(entity.id))
      ?? calibrationByName.get(String(entity.name ?? entity.displayName ?? "").normalize("NFKC").trim().toLocaleLowerCase())) as any;
    if (initial) seen.add(String(initial.id));
    return {
      ...entity, ...initial,
      displayName: initial?.displayName || entity.displayName || entity.name,
      internalName: initial?.internalName || entity.name,
      aliases: initial?.aliases ?? entity.aliases ?? [],
      prominence: initial?.prominence || entity.setupProminence || entity.tier || "supporting",
    };
  }), ...(calibration.entities ?? []).filter((item: any) => !seen.has(String(item.id)))];
  const query = view.query.trim().toLocaleLowerCase();
  const visible = people.filter((person: any) => {
    const prominence = ["primary", "supporting", "reference"].includes(person.prominence) ? person.prominence : "supporting";
    if (view.prominence !== "all" && prominence !== view.prominence) return false;
    return true;
  }).sort((left: any, right: any) => entityProminence(left) - entityProminence(right) || compareUiText([left.displayName, right.displayName]));
  const selected = view.selectedId === "__new__" ? { id: "__new__", displayName: "", internalName: "", aliases: [], prominence: "supporting" }
    : people.find((person: any) => String(person.id) === view.selectedId);
  const importance: Record<string, { label: string; order: number }> = { primary: { label: "주요", order: 0 }, supporting: { label: "보조", order: 1 }, reference: { label: "배경", order: 2 } };
  const normalize = (value: unknown) => String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase();
  const namesFor = (person: any) => new Set([person.displayName, person.internalName, person.name, ...(person.aliases ?? [])].map(normalize).filter(Boolean));
  const relationCount = (person: any) => {
    const names = namesFor(person);
    return data.relationships.filter((item) => names.has(normalize(relationshipFrom(item))) || names.has(normalize(relationshipTo(item)))).length;
  };
  const statusControls = calibration.status === "awaiting_confirmation"
    ? '<button class="btn btn--primary" data-action="initial-confirm">기억 생성 시작</button><button class="btn" data-action="initial-retry">다시 분석</button><button class="btn" data-action="initial-skip">건너뛰기</button>'
    : calibration.status === "failed" ? '<button class="btn btn--primary" data-action="initial-retry">다시 분석</button><button class="btn" data-action="initial-skip">건너뛰기</button>' : "";
  const setupNotice = calibration.status === "awaiting_setup"
    ? `<div class="people-notice" role="status">${icon("clock")}<div><strong>다음 모델 요청에서 인물 설정을 가져옵니다.</strong></div></div>`
    : calibration.status === "queued" ? `<div class="people-notice" role="status">${icon("clock")}<div><strong>초기 인물을 정리하고 있습니다.</strong></div></div>`
      : calibration.status === "awaiting_confirmation" ? `<div class="people-notice" role="status">${icon("clock")}<div><strong>인물과 초기 관계를 확인해 주세요.</strong></div><div class="people-notice__actions">${statusControls}</div></div>`
        : calibration.status === "failed" ? `<div class="people-notice is-error" role="alert">${icon("error")}<div><strong>초기 인물을 정리하지 못했습니다.</strong><span>${escapeHtml(calibration.lastError ?? "잠시 후 다시 시도해 주세요.")}</span></div><div class="people-notice__actions">${statusControls}</div></div>` : "";
  const groupHtml = (["primary", "supporting", "reference"] as const).map((key) => {
    const items = visible.filter((person: any) => (importance[person.prominence] ? person.prominence : "supporting") === key);
    if (!items.length) return "";
    const open = key !== "reference" || view.prominence === "reference" || Boolean(query) || items.some((person: any) => String(person.id) === view.selectedId);
    return `<details class="people-group" data-people-group ${open ? "open" : ""}><summary><strong>${importance[key]!.label}</strong><span>${items.length}</span></summary><div>${items.map((person: any) => {
      const aliases = (person.aliases ?? []).filter((alias: string) => normalize(alias) !== normalize(person.displayName));
      const count = relationCount(person);
      return `<button class="person-row ${String(person.id) === view.selectedId ? "is-selected" : ""}" type="button" data-action="select-person" data-person-row data-id="${escapeHtml(person.id)}"><span class="person-monogram">${escapeHtml(String(person.displayName || "?").slice(0, 1).toLocaleUpperCase())}</span><span class="person-copy"><strong>${escapeHtml(person.displayName)}</strong>${aliases.length ? `<small translate="no" class="notranslate">${escapeHtml(aliases.slice(0, 2).join(" · "))}</small>` : ""}</span><span class="person-row__chips"><span class="person-prominence">${importance[key]!.label}</span>${count ? `<span class="person-relation-count">관계 ${count}</span>` : ""}</span></button>`;
    }).join("")}</div></details>`;
  }).join("");
  const editor = selected && view.editing ? `<form class="person-editor" data-entity-id="${escapeHtml(selected.id)}"><header class="person-reader__head"><div><span>${selected.id === "__new__" ? "새 인물" : "인물 수정"}</span><h2>${escapeHtml(selected.displayName || "인물 추가")}</h2></div><div class="person-reader__actions"><button class="btn btn--icon" type="button" data-action="close-person-editor" aria-label="닫기" title="닫기">${icon("close")}</button><button class="btn btn--icon btn--primary" type="button" data-action="${selected.id === "__new__" ? "add-initial-entity" : "save-initial-entity"}" data-id="${escapeHtml(selected.id)}" aria-label="저장" title="저장">${icon("save")}</button></div></header><div class="person-editor__body"><label class="field"><span>표시 이름</span><input name="displayName" value="${escapeHtml(selected.displayName)}" required></label><label class="field"><span>별칭</span><input translate="no" class="notranslate" name="aliases" value="${escapeHtml((selected.aliases ?? []).join(", "))}" placeholder="쉼표로 구분"></label><fieldset class="person-importance"><legend>중요도</legend><div role="radiogroup">${Object.entries(importance).map(([value, item]) => `<label><input type="radio" name="prominence" value="${value}" ${selected.prominence === value ? "checked" : ""}><span>${item.label}</span></label>`).join("")}</div></fieldset>${selected.id === "__new__" || calibration.locked ? "" : `<button class="btn btn--danger" type="button" data-action="delete-initial-entity" data-id="${escapeHtml(selected.id)}" data-name="${escapeHtml(selected.displayName)}">목록에서 삭제</button>`}</div></form>` : "";
  const reader = selected && !view.editing ? (() => {
    const names = namesFor(selected);
    const relations = data.relationships.filter((item) => names.has(normalize(relationshipFrom(item))) || names.has(normalize(relationshipTo(item)))).sort((left, right) => comparePeople(data, relationshipFrom(left), relationshipFrom(right)) || comparePeople(data, relationshipTo(left), relationshipTo(right)));
    const aliases = (selected.aliases ?? []).filter((alias: string) => normalize(alias) !== normalize(selected.displayName));
    return `<article class="person-reader"><header class="person-reader__head"><button class="btn btn--quiet people-back detail-back" type="button" data-action="close-person" aria-label="인물 목록으로">‹</button><span class="person-reader__monogram">${escapeHtml(String(selected.displayName).slice(0, 1).toLocaleUpperCase())}</span><div><span>${importance[selected.prominence]?.label ?? "보조"} 인물</span><h2>${escapeHtml(selected.displayName)}</h2></div><div class="person-reader__actions"><button class="btn btn--icon" type="button" data-action="edit-person" aria-label="인물 수정" title="수정">${icon("edit")}</button></div></header><dl class="person-facts"><div><dt>별칭</dt><dd translate="no" class="notranslate">${escapeHtml(aliases.join(", ") || "없음")}</dd></div><div><dt>중요도</dt><dd>${importance[selected.prominence]?.label ?? "보조"}</dd></div></dl><section class="person-reader__section"><header><h3>관계</h3>${relations.length ? `<button class="btn btn--quiet" type="button" data-action="open-person-relations" data-name="${escapeHtml(selected.displayName)}">전체 보기 ›</button>` : ""}</header>${relations.length ? `<div class="person-relations">${relations.slice(0, 6).map((item) => { const from = relationshipFrom(item); const to = relationshipTo(item); const summary = String(item.summary ?? "관계 요약 대기 중"); return `<button type="button" data-action="open-relationship" data-key="${escapeHtml(`${from}|${to}`)}"><strong>${escapeHtml(from)} → ${escapeHtml(to)}</strong><span>${bilingualCopy(summary, translations.get(`relationship:${from}|${to}:summary`) ?? summary, display)}</span></button>`; }).join("")}</div>` : '<div class="people-empty">기록된 관계가 없습니다.</div>'}</section></article>`;
  })() : "";
  const headerActions = `<button class="btn btn--icon" type="button" data-action="new-person" aria-label="인물 추가" title="인물 추가">${icon("add")}</button><details class="record-menu record-menu--icon"><summary class="btn btn--icon" aria-label="인물 관리 더보기" title="더보기">${icon("more")}</summary><div class="record-menu__items"><button class="btn" type="button" data-action="go-entity-merge">중복 인물 합치기</button>${["ready", "inherited", "skipped"].includes(calibration.status) ? '<button class="btn" type="button" data-action="initial-retry">초기 설정 다시 읽기</button>' : ""}</div></details>`;
  const toolbar = `<div class="people-toolbar"><label class="people-search">${icon("search")}<input type="search" data-action="people-search" value="${escapeHtml(view.query)}" placeholder="이름 또는 별칭 검색" aria-label="인물 검색"></label><span class="people-toolbar__count" data-people-count>${visible.length}명</span><div class="people-filters" role="group" aria-label="중요도 필터">${[["all", "전체"], ["primary", "주요"], ["supporting", "보조"], ["reference", "배경"]].map(([value, label]) => `<button type="button" data-action="people-filter" data-value="${value}" aria-pressed="${view.prominence === value}">${label}</button>`).join("")}</div></div>`;
  const detail = view.management === "merge" ? entityMergePanel(data, mergePreview) : editor || reader;
  const hasDetail = Boolean(selected || view.management);
  return `<div class="people-page ${view.mobileDetail ? "is-mobile-detail" : ""}"><div class="people-page__intro">${pageHeader("등장인물", "인물을 찾고 확인합니다.", headerActions)}${setupNotice}</div><section class="people-workspace ${hasDetail ? "has-selection" : ""}"><div class="people-list">${toolbar}<div class="people-list__scroll" data-preserve-scroll="people-list">${groupHtml || '<div class="people-empty">조건에 맞는 인물이 없습니다.</div>'}<div class="people-empty" data-people-search-empty hidden>검색 결과가 없습니다.</div></div></div>${hasDetail ? `<div class="people-detail">${detail}</div>` : ""}</section></div>`;
}

type TranslationView = Map<string, string>;

const translatedText = (translations: TranslationView, id: string, field: string, fallback: string): string => translations.get(`${id}:${field}`) ?? fallback;

function bilingualCopy(canonical: string, korean: string, display: RuntimeState["settings"]["translationDisplay"]): string {
  if (display === "en") return escapeHtml(canonical);
  if (display === "bilingual") return `<span lang="ko">${escapeHtml(korean)}</span><span class="canonical-copy">${escapeHtml(canonical)}</span>`;
  return escapeHtml(korean);
}

const displayScore = (value: unknown): string => String(Math.round(Number(value) * 1_000) / 1_000);
const compareUiText = (...values: Array<[unknown, unknown]>): number => {
  for (const [left, right] of values) {
    const compared = String(left ?? "").localeCompare(String(right ?? ""), ["ko", "en"], { sensitivity: "base", numeric: true });
    if (compared !== 0) return compared;
  }
  return 0;
};
export function sortSocialKnowledge<T extends { holder?: unknown; subject?: unknown; knownAs?: unknown[] }>(items: T[]): T[] {
  return [...items].sort((left, right) => compareUiText(
    [left.holder, right.holder],
    [left.subject, right.subject],
    [(left.knownAs ?? []).join(" "), (right.knownAs ?? []).join(" ")],
  ));
}

export function shouldDeferDashboardRefresh(forceApply: boolean, formDirty: boolean, activeTab: Tab, hasSelection: boolean): boolean {
  return !forceApply && ((formDirty && ["initial", "story", "timeline", "relationships", "world"].includes(activeTab)) || hasSelection);
}
const relationshipFrom = (item: any): string => String(item?.from ?? item?.from_entity ?? "");
const relationshipTo = (item: any): string => String(item?.to ?? item?.to_entity ?? "");
const relationshipAxis = (item: any, axis: string): { level: string; trend: string } => item?.axes?.[axis] ?? { level: "unknown", trend: "unclear" };
const relationshipLevelKo: Record<string, string> = {
  unknown: "미관측", aversion: "혐오·회피", distrust: "불신", avoidant: "친밀 회피", none: "없음", faint: "희미함", fragile: "불안정", tentative: "조심스러움",
  growing: "커지는 중", developing: "발전 중", established: "확립됨", strong: "강함", deep: "깊음", conflicted: "상충됨", low: "낮음", moderate: "중간", high: "높음", extreme: "극심함",
};
const relationshipTrendKo: Record<string, string> = { rising: "상승", stable: "유지", falling: "하락", volatile: "요동", unclear: "불명" };
const relationshipAxisText = (item: any, axis: string): string => {
  const value = relationshipAxis(item, axis);
  return `${relationshipLevelKo[value.level] ?? value.level} · ${relationshipTrendKo[value.trend] ?? value.trend}`;
};

const memoryTypeKo: Record<string, string> = { episode: "장면", event: "사건", promise: "약속", detail: "세부", memory: "기억" };

const timelineCopy = (canonical: string, translated: string, mode: TimelineDetailMode, translationEnabled: boolean): string => {
  if (!translationEnabled || mode === "canonical") return `<span>${escapeHtml(canonical)}</span>`;
  if (mode === "compare") return `<span lang="ko">${escapeHtml(translated)}</span><small class="memory-copy__canonical">${escapeHtml(canonical)}</small>`;
  return `<span lang="ko">${escapeHtml(translated)}</span>`;
};

function memoryRowContent(memory: any, translations: TranslationView, translationEnabled: boolean): string {
  const title = translationEnabled ? translatedText(translations, memory.id, "title", memory.title) : memory.title;
  const content = translationEnabled ? translatedText(translations, memory.id, "content", memory.content) : memory.content;
  const locations = Array.isArray(memory.locations) ? memory.locations : [];
  return `<span class="row__top"><strong>${escapeHtml(title)}</strong><span class="row__signals">${memory.landmark ? '<span class="memory-signal" aria-label="랜드마크">◆</span>' : ""}${memory.pinned ? '<span class="memory-signal memory-signal--pin">고정</span>' : ""}${memory.active === false ? '<span class="memory-signal memory-signal--inactive">비활성</span>' : ""}</span></span><span class="row__meta"><span>${escapeHtml(memory.episode?.resolution === "group" ? "통합 에피소드" : memoryTypeKo[memory.type] ?? memory.type ?? "기억")}</span>${memory.story_time ? `<span>${escapeHtml(memory.story_time)}</span>` : ""}${locations.length ? `<span>${escapeHtml(locations.join(" · "))}</span>` : ""}</span><span class="row__body">${escapeHtml(content)}</span>`;
}

function memoryRow(memory: any, selectedId: string, translations: TranslationView, translationEnabled: boolean): string {
  return `<button class="row ${memory.id === selectedId ? "is-selected" : ""}" data-action="select-memory" data-translate-memory="${escapeHtml(memory.id)}" data-id="${escapeHtml(memory.id)}" data-landmark="${memory.landmark === true}" data-pinned="${memory.pinned === true}" data-active="${memory.active !== false}">${memoryRowContent(memory, translations, translationEnabled)}</button>`;
}

function memoryActionMenu(memory: any): string {
  return `<details class="memory-actions-menu record-menu--icon"><summary class="btn btn--icon" aria-label="기억 더보기" title="더보기">${icon("more")}</summary><div class="memory-actions-menu__items"><button class="btn" type="button" data-action="toggle-pin" data-id="${escapeHtml(memory.id)}">${memory.pinned ? "고정 해제" : "기억 고정"}</button><button class="btn" type="button" data-action="toggle-memory" data-id="${escapeHtml(memory.id)}">${memory.active === false ? "다시 사용" : "비활성화"}</button><button class="btn" type="button" data-action="related-source" data-id="${escapeHtml(memory.id)}">관련 원문 보기</button><button class="btn btn--danger" type="button" data-action="delete-memory" data-id="${escapeHtml(memory.id)}">영구 삭제</button></div></details>`;
}

/** Presentation only: all content stays in the DOM and expands without another request. */
export function expandableLongContent(label: string, html: string, textLength: number, story = false): string {
  if (textLength <= 1600) return html;
  const disclosure = `<details${story ? "" : ' class="memory-section"'}><summary><span>${escapeHtml(label)}</span><small>전체 보기</small></summary><div>${html}</div></details>`;
  return story ? `<div class="story-disclosures">${disclosure}</div>` : disclosure;
}

function memoryDetail(memory: any, messages: Map<string, any>, translations: TranslationView, view: TimelineViewState, translationEnabled: boolean, sourceLanguage: MemoryLanguage, adjacent: { previous?: string; next?: string }, translationError?: string): string {
  if (!memory) return '<div class="timeline-empty"><strong>표시할 기억이 없습니다.</strong><span>검색이나 필터를 바꿔 보세요.</span></div>';
  const evidence = parseJson<Array<{ messageId?: string; quote?: string }>>(memory.evidence_json, []);
  const displayedDialogues = joinDialogueSpans(Array.isArray(memory.keyDialogues) ? memory.keyDialogues : []);
  const locations = Array.isArray(memory.locations) ? memory.locations : [];
  const landmarkKinds = Array.isArray(memory.landmarkKinds) ? memory.landmarkKinds : [];
  const landmarkKindText = landmarkKinds.map((entry: any) => entry.kind === "other" ? `other:${entry.label ?? ""}` : entry.kind).join(", ");
  const translatedTitle = translatedText(translations, memory.id, "title", memory.title);
  const translatedContent = translatedText(translations, memory.id, "content", memory.content);
  const translationReady = translations.has(`${memory.id}:content`);
  const effectiveMode: TimelineDetailMode = translationEnabled ? view.detailMode : "canonical";
  const title = effectiveMode === "canonical" ? memory.title : translatedTitle;
  const sections = Array.isArray(memory.sections) ? memory.sections : [];
  const details = Array.isArray(memory.details) ? memory.details : [];
  const relationshipEvents = Array.isArray(memory.relationshipEvents) ? memory.relationshipEvents : [];
  const intimacyMilestones = Array.isArray(memory.intimacyMilestones) ? memory.intimacyMilestones : [];
  const modeControls = translationEnabled ? `<div class="segmented view-switch memory-view-switch" role="group" aria-label="기억 표시"><button type="button" data-action="timeline-mode" data-mode="translation" aria-pressed="${effectiveMode === "translation"}">번역</button><button type="button" data-action="timeline-mode" data-mode="canonical" aria-pressed="${effectiveMode === "canonical"}">원문</button><button class="memory-compare-toggle" type="button" data-action="timeline-mode" data-mode="compare" aria-pressed="${effectiveMode === "compare"}">비교</button></div>` : "";
  const translationState = translationEnabled && !translationReady ? `<div class="memory-translation-state" role="status">${translationError ? `<span>번역을 불러오지 못했습니다.</span><button class="btn" type="button" data-action="retry-translation" data-id="${escapeHtml(memory.id)}">다시 시도</button>` : `<span>한국어 번역을 준비하고 있습니다.</span>`}</div>` : "";
  const readingContent = effectiveMode === "compare" && translationEnabled
    ? `<div class="memory-compare"><article><span class="memory-reading__label">번역</span><h3 lang="ko">${escapeHtml(translatedTitle)}</h3><p lang="ko">${escapeHtml(translatedContent)}</p></article><article><span class="memory-reading__label">원문</span><h3 lang="${sourceLanguage}">${escapeHtml(memory.title)}</h3><p lang="${sourceLanguage}">${escapeHtml(memory.content)}</p></article></div>`
    : `<article class="memory-reading"><p lang="${effectiveMode === "translation" ? "ko" : sourceLanguage}">${escapeHtml(effectiveMode === "translation" ? translatedContent : memory.content)}</p></article>`;
  const reading = expandableLongContent("기억 본문", readingContent, Math.max(String(memory.content ?? "").length, String(translatedContent ?? "").length));
  const editor = `<form id="memory-form" class="memory-editor" data-memory-id="${escapeHtml(memory.id)}"><label class="field"><span>제목</span><input name="title" lang="${sourceLanguage}" value="${escapeHtml(memory.title)}"></label><label class="field"><span>내용</span><textarea name="content" lang="${sourceLanguage}" rows="7">${escapeHtml(memory.content)}</textarea></label><div class="formgrid"><label class="field"><span>작중 시간</span><input name="storyTime" value="${escapeHtml(memory.story_time ?? "")}" placeholder="원문에 명시된 날짜와 시간"></label><label class="field"><span>장소</span><input name="locations" value="${escapeHtml(locations.join(", "))}" placeholder="쉼표로 구분"></label></div><details class="memory-editor__advanced"><summary>기억 강도와 랜드마크</summary><div class="formgrid"><label class="field"><span>중요도</span><input name="salience" type="number" min="0" max="1" step="0.001" value="${displayScore(memory.salience)}"></label><label class="field"><span>기억 강도</span><input name="strength" type="number" min="0" max="1" step="0.001" value="${displayScore(memory.strength)}"></label></div><label class="field field--check"><span><input name="landmark" type="checkbox" ${memory.landmark ? "checked" : ""}> 서사 랜드마크</span></label><label class="field"><span>랜드마크 종류</span><input name="landmarkKinds" value="${escapeHtml(landmarkKindText)}" placeholder="confession, intimacy_milestone"></label></details></form>`;
  const keyDialogueContent = `<section class="memory-key-dialogue"><h3>핵심 대사</h3>${displayedDialogues.length ? displayedDialogues.map((item: any) => { const translated = item.sourceIndexes.map((index: number) => translations.get(`${memory.id}:dialogue:${index}`)).filter(Boolean).join(" … ") || item.text; return `<blockquote><strong>${escapeHtml(item.speaker)}</strong><p>${timelineCopy(item.text, translated, effectiveMode, translationEnabled)}</p></blockquote>`; }).join("") : '<p class="muted">저장된 핵심 대사가 없습니다.</p>'}</section>`;
  const keyDialogue = expandableLongContent("핵심 대사", keyDialogueContent, Math.max(displayedDialogues.length > 12 ? 1601 : 0, displayedDialogues.reduce((sum: number, item: any) => sum + String(item.text ?? "").length, 0)));
  const structuredDetails = details.map((detail: any) => `<details class="memory-subsection"><summary><span>${escapeHtml(detail.kind)}</span><small>${escapeHtml(detail.epistemic)}</small></summary><p>${timelineCopy(detail.text, translations.get(`${memory.id}:detail:${detail.id}`) ?? detail.text, effectiveMode, translationEnabled)}</p><small class="muted">인물 ${(detail.participants ?? []).map(escapeHtml).join(" · ") || "없음"} · 장소 ${(detail.locations ?? []).map(escapeHtml).join(" · ") || "없음"}</small></details>`).join("");
  const relationshipDetails = relationshipEvents.map((event: any) => `<details class="memory-subsection"><summary><span>${escapeHtml(event.from)} → ${escapeHtml(event.to)}</span></summary><p>${timelineCopy(event.reason, translations.get(`relationship-event:${event.id}:reason`) ?? event.reason, effectiveMode, translationEnabled)}</p><small class="muted">${(event.changes ?? []).map((change: any) => `${escapeHtml(change.axis)} ${escapeHtml(change.effect)} · ${escapeHtml(change.impact)}`).join(" · ")}</small></details>`).join("");
  const intimacyDetails = intimacyMilestones.map((item: any) => { const circumstance = item.circumstance || "문맥 미기록"; return `<details class="memory-subsection"><summary><span>${escapeHtml(item.milestoneKey)}</span><small>${escapeHtml(item.act)}</small></summary><p>${timelineCopy(circumstance, translations.get(`intimacy:${item.id}:circumstance`) ?? circumstance, effectiveMode, translationEnabled)}</p><small class="muted">${escapeHtml(item.participantA)} · ${escapeHtml(item.participantB)} · ${escapeHtml(item.interactionContext)}</small></details>`; }).join("");
  const evidenceRows = evidence.map((item, index) => { const source = item.messageId ? messages.get(item.messageId) : undefined; const quote = item.quote ?? source?.content ?? "원문 근거를 표시할 수 없습니다."; const translated = translations.get(`${memory.id}:evidence:${index}`) ?? quote; return `<details class="memory-subsection memory-evidence-row"><summary><span>${escapeHtml(item.messageId ?? "알 수 없는 원문")}</span><small>${escapeHtml(source?.lifecycle ?? "없음")}</small></summary><blockquote>${timelineCopy(quote, translated, effectiveMode, translationEnabled)}</blockquote></details>`; }).join("");
  const mobileActions = `<div class="memory-reader__mobile-actions">${translationEnabled ? `<div class="segmented view-switch memory-mobile-view-switch" role="group" aria-label="기억 표시"><button type="button" data-action="timeline-mode" data-mode="translation" aria-pressed="${effectiveMode === "translation"}">번역</button><button type="button" data-action="timeline-mode" data-mode="canonical" aria-pressed="${effectiveMode === "canonical"}">원문</button></div>` : ""}<button class="btn btn--icon" type="button" data-action="edit-memory" aria-label="기억 수정" title="수정">${icon("edit")}</button>${memoryActionMenu(memory)}</div>`;
  return `<div class="memory-reader ${view.editing ? "is-editing" : ""}"><header class="memory-reader__head"><button class="memory-back" type="button" data-action="timeline-back">‹ <span>목록</span></button><div class="memory-reader__title"><span>${escapeHtml(memory.episode?.resolution === "group" ? "통합 에피소드" : memoryTypeKo[memory.type] ?? memory.type ?? "기억")}</span><h2>${escapeHtml(title)}</h2><div class="memory-reader__meta">${memory.story_time ? `<span>${escapeHtml(memory.story_time)}</span>` : ""}${locations.length ? `<span>${escapeHtml(locations.join(" · "))}</span>` : ""}${memory.landmark ? '<span>◆ 랜드마크</span>' : ""}${memory.pinned ? '<span>고정됨</span>' : ""}${memory.active === false ? '<span>비활성</span>' : ""}</div></div><div class="memory-reader__actions">${view.editing ? `<button class="btn btn--icon" type="button" data-action="cancel-memory-edit" aria-label="닫기" title="닫기">${icon("close")}</button><button class="btn btn--icon btn--primary" type="submit" form="memory-form" aria-label="저장" title="저장">${icon("save")}</button>` : `${modeControls}<button class="btn btn--icon" type="button" data-action="edit-memory" aria-label="기억 수정" title="수정">${icon("edit")}</button>${memoryActionMenu(memory)}`}</div>${view.editing ? "" : mobileActions}</header>${memory.active === false ? `<div class="memory-inactive" role="status">${icon("clock")}<span>현재 검색과 자동 주입에서 제외된 기억입니다.</span></div>` : ""}<div class="memory-reader__body">${view.editing ? editor : `${translationState}${reading}${keyDialogue}<details class="memory-section" open><summary><span>기억 정보</span></summary><dl class="memory-facts"><div><dt>생성 버전</dt><dd>${Number(memory.created_revision ?? 0)}</dd></div><div><dt>회상 횟수</dt><dd>${Number(memory.recall_count ?? 0)}회</dd></div><div><dt>중요도</dt><dd>${displayScore(memory.salience)}</dd></div><div><dt>기억 강도</dt><dd>${displayScore(memory.strength)}</dd></div></dl></details>${sections.length ? `<details class="memory-section"><summary><span>장면 구성</span><small>${sections.length}</small></summary>${sections.map((section: any) => `<details class="memory-subsection"><summary><span>${escapeHtml(section.title)}</span><small>원문 ${section.sourceMessageIds?.length ?? 0}</small></summary><p>${escapeHtml(section.summary)}</p></details>`).join("")}</details>` : ""}${structuredDetails || relationshipDetails || intimacyDetails ? `<details class="memory-section"><summary><span>세부기억과 관계 사건</span></summary>${structuredDetails}${relationshipDetails}${intimacyDetails}</details>` : ""}<details class="memory-section"><summary><span>원문 근거</span><small>${evidence.length}</small></summary>${evidenceRows || '<p class="muted">연결된 원문 근거가 없습니다.</p>'}</details>`}</div><nav class="memory-reader__pager" aria-label="기억 이동"><button class="btn" type="button" data-action="timeline-adjacent" data-id="${escapeHtml(adjacent.previous ?? "")}" ${adjacent.previous ? "" : "disabled"}>‹ 이전</button><button class="btn" type="button" data-action="timeline-adjacent" data-id="${escapeHtml(adjacent.next ?? "")}" ${adjacent.next ? "" : "disabled"}>다음 ›</button></nav></div>`;
}

function manualMemoryEditor(): string {
  const landmarkOptions: Array<[string, string]> = [
    ["", "관계 이정표 없음"], ["first_met", "처음 만남"], ["romantic_relationship_established", "연인 관계 성립"],
    ["engagement", "약혼"], ["marriage", "결혼"], ["separation", "별거"],
    ["romantic_relationship_ended", "이별"], ["reunion", "재결합"], ["divorce", "이혼"], ["anniversary_basis", "기념일 기준일"],
  ];
  return `<div class="memory-reader is-editing"><header class="memory-reader__head"><button class="memory-back" type="button" data-action="cancel-manual-memory">‹ <span>목록</span></button><div class="memory-reader__title"><span>사용자 기록</span><h2>타임라인 기억 추가</h2></div><div class="memory-reader__actions"><button class="btn btn--icon" type="button" data-action="cancel-manual-memory" aria-label="닫기" title="닫기">${icon("close")}</button><button class="btn btn--icon btn--primary" type="submit" form="manual-memory-form" aria-label="저장" title="저장">${icon("save")}</button></div></header><div class="memory-reader__body"><form id="manual-memory-form" class="memory-editor"><label class="field"><span>제목 (선택)</span><input name="title" maxlength="500" placeholder="비워두면 기억 내용에서 만듭니다"></label><label class="field"><span>기억 내용</span><textarea name="content" rows="8" maxlength="20000" required></textarea></label><div class="formgrid"><label class="field"><span>작중 시간</span><input name="storyTime" maxlength="240" placeholder="YYYY-MM-DD HH:mm 권장"></label><label class="field"><span>관련 인물</span><input name="participants" placeholder="쉼표로 구분"></label></div><label class="field"><span>관계 이정표</span><select name="landmarkKind">${landmarkOptions.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label><p class="muted">관계 이정표를 고르면 관련 인물 앞의 두 명을 대상 인물로 사용합니다.</p></form></div></div>`;
}

export function timeline(data: DashboardData, selectedId: string, translations: TranslationView, view: TimelineViewState, translationEnabled: boolean, sourceLanguage: MemoryLanguage, translationError?: string): string {
  const messages = new Map(data.messages.map((message) => [message.message_id, message]));
  const allTopLevel = data.memories.filter((memory) => !memory.capsule_parent_id);
  const sort = view.sortOrder === "descending" ? -1 : 1;
  const ordered = (items: any[]) => [...items].sort((left, right) => sort * (compareStoryTimes(left.story_time ?? left.storyTime, right.story_time ?? right.storyTime) ?? (Number(left.created_revision ?? left.created_at ?? 0) - Number(right.created_revision ?? right.created_at ?? 0))));
  const matching = ordered(filterTimelineMemories(data.memories, view));
  const matchingIds = new Set(matching.map((memory) => memory.id));
  const matchingParents = new Set(matching.map((memory) => memory.capsule_parent_id).filter(Boolean));
  const topLevel = ordered(filterTimelineMemories(allTopLevel.filter((memory) => matchingIds.has(memory.id) || matchingParents.has(memory.id)), { ...view, landmarkOnly: false, pinnedOnly: false }));
  const selectedBase = data.memories.find((memory) => memory.id === selectedId) ?? topLevel[0] ?? data.memories[0];
  const selectedDetailIds = new Set((selectedBase?.details ?? []).map((detail: any) => detail.id));
  const selected = selectedBase ? { ...selectedBase,
    relationshipEvents: data.relationshipEvents.filter((event) => event.sourceMemoryId === selectedBase.id || selectedDetailIds.has(event.sourceDetailId)),
    intimacyMilestones: data.physicalIntimacy.filter((item) => item.sourceMemoryId === selectedBase.id),
  } : undefined;
  const selectedIndex = topLevel.findIndex((memory) => memory.id === selected?.id);
  const adjacent = { previous: selectedIndex > 0 ? topLevel[selectedIndex - 1]?.id : undefined, next: selectedIndex >= 0 ? topLevel[selectedIndex + 1]?.id : undefined };
  const rows = topLevel.map((memory) => {
    const children = ordered(filterTimelineMemories(data.memories.filter((candidate) => candidate.capsule_parent_id === memory.id), view));
    return `${memoryRow(memory, selected?.id ?? "", translations, translationEnabled)}${children.length ? `<details class="capsule-children" ${children.some((child) => child.id === selected?.id) ? "open" : ""}><summary>원래 기억 ${children.length}개</summary>${children.map((child) => memoryRow(child, selected?.id ?? "", translations, translationEnabled)).join("")}</details>` : ""}`;
  }).join("");
  const filters = `<div class="timeline-filters" role="group" aria-label="기억 필터"><button type="button" data-action="timeline-filter" data-filter="landmark" aria-pressed="${view.landmarkOnly}">랜드마크</button><button type="button" data-action="timeline-filter" data-filter="pinned" aria-pressed="${view.pinnedOnly}">고정</button><button type="button" data-action="timeline-filter" data-filter="inactive" aria-pressed="${view.includeInactive}">비활성 포함</button></div>`;
  const actions = `<button class="btn" type="button" data-action="timeline-order" aria-pressed="${view.sortOrder === "descending"}">${view.sortOrder === "descending" ? "시간 내림차순" : "시간 오름차순"}</button><button class="btn" type="button" data-action="organization-open">기억 정리</button><button class="btn btn--icon" type="button" data-action="new-manual-memory" aria-label="기억 추가" title="기억 추가">${icon("add")}</button>`;
  return `<div class="timeline-page ${view.mobileDetail ? "is-mobile-detail" : ""}">${pageHeader("타임라인", "기억을 찾고 확인합니다.", actions)}<section class="timeline-split"><div class="split__list"><div class="timeline-toolbar"><label class="search">${icon("search")}<span class="sr-only">기억 검색</span><input id="memory-search" type="search" value="${escapeHtml(view.query)}" placeholder="기억 검색"></label><span class="timeline-count" data-timeline-count>기억 ${topLevel.length}개</span>${filters}</div><div class="rows" id="memory-rows" data-preserve-scroll="timeline-list">${rows || '<div class="timeline-empty"><strong>조건에 맞는 기억이 없습니다.</strong><span>검색어나 필터를 바꿔 보세요.</span></div>'}<div class="timeline-empty" data-timeline-search-empty hidden><strong>검색 결과가 없습니다.</strong><span>다른 단어로 찾아보세요.</span></div></div></div><div class="split__detail">${view.creating ? manualMemoryEditor() : memoryDetail(selected, messages, translations, view, translationEnabled, sourceLanguage, adjacent, translationError)}</div></section></div>`;
}

const storyGroupKey = (group: any, fallback: string): string => String(group?.groupId ?? `${group?.level ?? "story"}:${group?.startOrdinal ?? fallback}:${group?.endOrdinal ?? fallback}`);
const storyTranslationKey = (groupKey: string, field: string, index?: number): string => `story:${groupKey}:${field}${index == null ? "" : `:${index}`}`;

function storyGroups(spine: any): Array<{ group: any; key: string; kind: "arc" | "current"; number: number }> {
  const arcs = (spine?.arcs ?? []).map((group: any, index: number) => ({ group, key: storyGroupKey(group, `arc-${index}`), kind: "arc" as const, number: index + 1 }));
  const current = (spine?.currentProgress ?? []).map((group: any, index: number) => ({ group, key: storyGroupKey(group, `current-${index}`), kind: "current" as const, number: index + 1 }));
  return [...arcs, ...current].sort((left, right) => {
    const leftStart = Number(left.group?.startOrdinal);
    const rightStart = Number(right.group?.startOrdinal);
    const start = (Number.isFinite(leftStart) ? leftStart : Number.MAX_SAFE_INTEGER) - (Number.isFinite(rightStart) ? rightStart : Number.MAX_SAFE_INTEGER);
    if (start !== 0) return start;
    const leftEnd = Number(left.group?.endOrdinal);
    const rightEnd = Number(right.group?.endOrdinal);
    const end = (Number.isFinite(leftEnd) ? leftEnd : Number.MAX_SAFE_INTEGER) - (Number.isFinite(rightEnd) ? rightEnd : Number.MAX_SAFE_INTEGER);
    return end || Number(left.kind === "current") - Number(right.kind === "current") || left.number - right.number;
  });
}

function compareStoryMemories(left: any, right: any): number {
  const byStoryTime = compareStoryTimes(left?.story_time ?? left?.storyTime, right?.story_time ?? right?.storyTime) ?? 0;
  if (byStoryTime !== 0) return byStoryTime;
  return Number(left?.created_revision ?? left?.updated_revision ?? left?.updated_at ?? Number.MAX_SAFE_INTEGER)
    - Number(right?.created_revision ?? right?.updated_revision ?? right?.updated_at ?? Number.MAX_SAFE_INTEGER);
}

function storyTranslationRecords(spine: any): Array<{ kind: string; itemId: string; text: string }> {
  const records: Array<{ kind: string; itemId: string; text: string }> = [];
  const visit = (group: any, fallback: string) => {
    if (!group) return;
    const groupKey = storyGroupKey(group, fallback);
    [["title", group.title], ["summary", group.summary]].forEach(([field, text]) => {
      if (text) records.push({ kind: `story-${field}`, itemId: storyTranslationKey(groupKey, field), text: String(text) });
    });
    (group.beats ?? []).forEach((text: string, index: number) => { if (text) records.push({ kind: "story-beat", itemId: storyTranslationKey(groupKey, "beat", index), text: String(text) }); });
    (group.activeTransitions ?? []).forEach((text: string, index: number) => { if (text) records.push({ kind: "story-transition", itemId: storyTranslationKey(groupKey, "transition", index), text: String(text) }); });
    (group.flows ?? []).forEach((flow: any, flowIndex: number) => {
      const flowKey = storyGroupKey(flow, `${groupKey}:flow-${flowIndex}`);
      [["title", flow.title], ["summary", flow.summary]].forEach(([field, text]) => { if (text) records.push({ kind: `story-flow-${field}`, itemId: storyTranslationKey(flowKey, field), text: String(text) }); });
      (flow.beats ?? []).forEach((text: string, index: number) => { if (text) records.push({ kind: "story-flow-beat", itemId: storyTranslationKey(flowKey, "beat", index), text: String(text) }); });
    });
    (group.segments ?? []).forEach((segment: any, index: number) => visit(segment, `${groupKey}:segment-${index}`));
  };
  visit(spine?.overview, "overview");
  (spine?.arcs ?? []).forEach((group: any, index: number) => visit(group, `arc-${index}`));
  (spine?.currentProgress ?? []).forEach((group: any, index: number) => visit(group, `current-${index}`));
  return records;
}

export function storySpinePage(
  data: DashboardData,
  translations: TranslationView = new Map(),
  view: StoryViewState = { selectedGroupId: "", query: "", indexOpen: false, detailMode: "translation", expandedMemoryId: "" },
  translationEnabled = false,
  sourceLanguage: MemoryLanguage = "en",
  overviewBackup?: StoryOverviewBackup,
): string {
  const spine = data.storySpine ?? { overview: null, currentProgress: [], arcs: [] };
  const groups = storyGroups(spine);
  const pendingRange = data.storySpine?.pendingSourceRange;
  const pendingRangeNotice = Number(pendingRange?.batchCount ?? 0) > 0
    ? `<p class="muted" role="status">아직 묶이지 않은 범위 · 대화 ${Number(pendingRange.startOrdinal ?? 0) + 1}–${Number(pendingRange.endOrdinal ?? 0) + 1} · ${Number(pendingRange.batchCount)}묶음</p>` : "";
  if (!spine.overview && groups.length === 0) return `<div class="story-page">${pageHeader("줄거리", "이야기의 흐름을 한곳에서 읽습니다.")}<div class="story-empty"><strong>아직 정리된 줄거리가 없습니다.</strong><span>이야기가 쌓이면 전체 흐름과 관련 기억이 이곳에 연결됩니다.</span>${pendingRangeNotice}</div></div>`;
  const selected = groups.find((item) => item.key === view.selectedGroupId) ?? groups.at(-1);
  const effectiveMode: TimelineDetailMode = translationEnabled ? view.detailMode : "canonical";
  const translated = (_group: any, groupKey: string, field: string, text: string, index?: number) => translations.get(storyTranslationKey(groupKey, field, index)) ?? text;
  const copy = (group: any, fallback: string, field: string, text: string, index?: number) => {
    const ko = translated(group, fallback, field, text, index);
    if (effectiveMode === "canonical") return `<span lang="${sourceLanguage}">${escapeHtml(text)}</span>`;
    if (effectiveMode === "compare") return `<span lang="ko">${escapeHtml(ko)}</span><small class="story-canonical" lang="${sourceLanguage}">${escapeHtml(text)}</small>`;
    return `<span lang="ko">${escapeHtml(ko)}</span>`;
  };
  const title = (group: any, fallback: string) => {
    const canonical = String(group?.title ?? "이야기 구간");
    const ko = translated(group, fallback, "title", canonical);
    if (effectiveMode === "canonical") return escapeHtml(canonical);
    if (effectiveMode === "compare") return `${escapeHtml(ko)}<small lang="${sourceLanguage}">${escapeHtml(canonical)}</small>`;
    return escapeHtml(ko);
  };
  const selectedIndex = selected ? groups.findIndex((item) => item.key === selected.key) : -1;
  const overview = spine.overview;
  const overviewKey = storyGroupKey(overview, "overview");
  const remainingSource = selected?.group?.activeTransitions?.length ? selected : overview ? { group: overview, key: overviewKey } : undefined;
  const remaining = remainingSource?.group?.activeTransitions ?? [];
  const languageControls = translationEnabled ? `<div class="segmented view-switch story-language" role="group" aria-label="줄거리 표시"><button type="button" data-action="story-mode" data-mode="translation" aria-pressed="${effectiveMode === "translation"}">번역</button><button type="button" data-action="story-mode" data-mode="canonical" aria-pressed="${effectiveMode === "canonical"}">원문</button><button class="story-compare-toggle" type="button" data-action="story-mode" data-mode="compare" aria-pressed="${effectiveMode === "compare"}">비교</button></div>` : "";
  const selectedMenu = selected ? `<button class="btn" type="button" data-action="toggle-story-hidden" data-group-id="${escapeHtml(selected.group.groupId ?? "")}" data-value="${selected.group.hidden ? "false" : "true"}">${selected.group.hidden ? "숨김 해제" : "이 구간 숨기기"}</button>${selected.kind === "arc" ? `<button class="btn" type="button" data-action="toggle-story-pin" data-group-id="${escapeHtml(selected.group.groupId ?? "")}" data-value="${selected.group.pinned ? "false" : "true"}">${selected.group.pinned ? "검색 고정 해제" : "검색 우선 고정"}</button>` : ""}` : "";
  const overviewMenu = overview ? `<button class="btn" type="button" data-action="edit-story-overview">지금까지의 이야기 수정</button>` : "";
  const restoreMenu = overviewBackup && overviewBackup.summary !== String(overview?.summary ?? "") ? `<button class="btn" type="button" data-action="load-story-overview-backup">이전 요약 불러오기</button>` : "";
  const toolbar = pageHeader("줄거리", "이야기의 흐름을 한곳에서 읽습니다.", `${languageControls}<details class="record-menu record-menu--icon"><summary class="btn btn--icon" aria-label="줄거리 더보기" title="더보기">${icon("more")}</summary><div class="record-menu__items">${overviewMenu}${restoreMenu}${selectedMenu}<button class="btn" type="button" data-action="rebuild-story-spine">줄거리 다시 만들기</button></div></details>`);
  const indexRows = groups.map((item, index) => `<button class="story-index__row ${item.key === selected?.key ? "is-selected" : ""}" type="button" data-action="select-story-group" data-story-row data-group-id="${escapeHtml(item.key)}"><span>${String(index + 1).padStart(2, "0")}</span><span><small>${item.kind === "arc" ? `ARC ${String(item.number).padStart(2, "0")}` : "현재 진행"} · 대화 ${Number(item.group.startOrdinal ?? 0) + 1}–${Number(item.group.endOrdinal ?? 0) + 1}</small><strong>${title(item.group, item.key)}</strong><em>${item.group.pinned ? "검색 우선" : item.group.hidden ? "숨김" : item.kind === "current" ? "이어지는 이야기" : "이야기 구간"}</em></span><b>›</b></button>`).join("");
  const indexPanel = view.indexOpen ? `<aside class="story-index"><header><button class="story-index__back" type="button" data-action="toggle-story-index" aria-label="줄거리로 돌아가기">‹</button><div><strong>전체 구간</strong><span>${groups.length}개</span></div><button class="btn btn--icon story-index__close" type="button" data-action="toggle-story-index" aria-label="전체 구간 닫기">${icon("close")}</button></header><label class="story-index__search">${icon("search")}<input type="search" data-action="story-search" value="${escapeHtml(view.query)}" placeholder="제목과 내용 검색" aria-label="이야기 구간 검색"></label><div class="story-index__list" data-preserve-scroll="story-index">${indexRows}<div class="story-empty story-index__empty" data-story-search-empty hidden>검색 결과가 없습니다.</div></div></aside>` : "";
  const overviewEditor = overview ? `<form id="story-overview-form" class="story-overview-editor" data-group-id="${escapeHtml(overview.groupId ?? "")}"><div class="story-overview-editor__head"><div><h2>지금까지의 이야기</h2><small>대화 ${Number(overview.startOrdinal ?? 0) + 1}–${Number(overview.endOrdinal ?? 0) + 1} 범위는 그대로 유지됩니다.</small></div><div><button class="btn" type="button" data-action="cancel-story-overview">취소</button><button class="btn btn--primary" type="submit">저장</button></div></div><textarea name="summary" rows="12" maxlength="120000" required>${escapeHtml(view.overviewDraft ?? String(overview.summary ?? ""))}</textarea></form>` : "";
  const overviewSection = `<section class="story-summary">${view.editingOverview ? overviewEditor : `<div><h2>지금까지의 이야기</h2>${expandableLongContent("전체 요약", `<p>${overview ? copy(overview, overviewKey, "summary", String(overview.summary ?? "")) : '<span class="muted">전체 요약을 준비하고 있습니다.</span>'}</p>`, String(overview?.summary ?? "").length, true)}</div>`}<div class="story-summary__remaining"><h2>남은 흐름</h2>${remaining.length ? `<ul>${remaining.slice(0, 3).map((text: string, index: number) => `<li>${copy(remainingSource?.group, remainingSource?.key ?? overviewKey, "transition", text, index)}</li>`).join("")}</ul>` : '<p class="muted">현재 열린 흐름이 없습니다.</p>'}</div></section>`;
  const rail = `<div class="story-rail-wrap"><div class="story-rail" role="list" aria-label="시간순 이야기 구간" data-drag-scroll data-preserve-scroll="story-rail">${groups.map((item) => `<button class="story-stop ${item.key === selected?.key ? "is-selected" : ""} ${item.kind === "current" ? "is-current" : ""}" type="button" data-action="select-story-group" data-group-id="${escapeHtml(item.key)}" role="listitem"><i></i><strong>${title(item.group, item.key)}</strong><small>${item.kind === "arc" ? `Arc ${item.number}` : "현재"}</small></button>`).join("")}</div><button class="btn btn--quiet story-all" type="button" data-action="toggle-story-index">전체 구간 <span>›</span></button></div>`;
  if (!selected) return `<div class="story-page">${toolbar}<div class="story-layout">${overviewSection}${rail}</div></div>`;
  const group = selected.group;
  const linked = (group.linkedMemoryIds ?? []).map((id: string) => data.memories.find((memory) => memory.id === id)).filter(Boolean)
    .sort((left: any, right: any) => compareStoryMemories(left, right) || compareUiText([left.id, right.id]));
  const memoryItems = linked.map((memory: any) => {
    const expanded = view.expandedMemoryId === memory.id;
    const memoryTitle = effectiveMode === "canonical" ? memory.title : translations.get(`${memory.id}:title`) ?? memory.title;
    return `<div class="story-memory ${expanded ? "is-open" : ""}" data-story-memory-item="${escapeHtml(memory.id)}"><button type="button" data-action="toggle-story-memory" data-memory-id="${escapeHtml(memory.id)}" aria-expanded="${expanded}" aria-controls="story-memory-preview-${escapeHtml(memory.id)}"><i></i><small>${escapeHtml(memory.story_time ?? `#${Number(memory.created_revision ?? 0)}`)}</small><strong>${escapeHtml(memoryTitle)}</strong><span>${escapeHtml(memory.episode?.resolution === "group" ? "통합 에피소드" : memoryTypeKo[memory.type] ?? memory.type ?? "기억")}</span></button></div>`;
  }).join("");
  const memoryPreviews = linked.map((memory: any) => {
    const expanded = view.expandedMemoryId === memory.id;
    const memoryContent = effectiveMode === "canonical" ? memory.content : translations.get(`${memory.id}:content`) ?? memory.content;
    return `<div class="story-memory__preview" id="story-memory-preview-${escapeHtml(memory.id)}" data-story-memory-preview="${escapeHtml(memory.id)}" ${expanded ? "" : "hidden"}><p>${escapeHtml(memoryContent)}</p><button class="btn btn--quiet" type="button" data-action="open-timeline-memory" data-memory-id="${escapeHtml(memory.id)}">타임라인에서 열기 ${icon("arrow-right")}</button></div>`;
  }).join("");
  const flowSections = (group.flows ?? []).map((flow: any, flowIndex: number) => {
    const flowKey = storyGroupKey(flow, `${selected.key}:flow-${flowIndex}`);
    return `<section class="story-flow"><header><span>${escapeHtml(flow.holder || flow.title || "관점")}</span><small>인물 흐름</small></header><p>${copy(flow, flowKey, "summary", String(flow.summary ?? ""))}</p>${flow.beats?.length ? `<ol>${flow.beats.map((beat: string, index: number) => `<li><i>${index + 1}</i>${copy(flow, flowKey, "beat", beat, index)}</li>`).join("")}</ol>` : ""}</section>`;
  }).join("");
  const segmentSections = (group.segments ?? []).map((segment: any, index: number) => { const key = storyGroupKey(segment, `${selected.key}:segment-${index}`); return `<section class="story-segment"><header><span>${String(index + 1).padStart(2, "0")}</span><strong>${title(segment, key)}</strong><small>대화 ${Number(segment.startOrdinal ?? group.startOrdinal ?? 0) + 1}–${Number(segment.endOrdinal ?? group.endOrdinal ?? 0) + 1}</small></header><p>${copy(segment, key, "summary", String(segment.summary ?? ""))}</p></section>`; }).join("");
  const previous = groups[selectedIndex - 1];
  const next = groups[selectedIndex + 1];
  const pager = `<nav class="story-pager" aria-label="이야기 구간 이동">${previous ? `<button type="button" data-action="select-story-group" data-group-id="${escapeHtml(previous.key)}"><small>이전 구간</small><strong>${title(previous.group, previous.key)}</strong></button>` : "<span></span>"}${next ? `<button type="button" data-action="select-story-group" data-group-id="${escapeHtml(next.key)}"><small>다음 구간</small><strong>${title(next.group, next.key)}</strong><b>›</b></button>` : "<span></span>"}</nav>`;
  const reader = `<main class="story-reader"><section class="story-reader__scroll" data-preserve-scroll="story-reader">${pendingRangeNotice}${overviewSection}${rail}<article class="story-chapter"><header><div><span>${selected.kind === "arc" ? `ARC ${String(selected.number).padStart(2, "0")}` : "현재"}</span><h2>${title(group, selected.key)}</h2><p>대화 ${Number(group.startOrdinal ?? 0) + 1}–${Number(group.endOrdinal ?? 0) + 1}${group.pinned ? " · 검색 우선" : ""}${group.hidden ? " · 숨김" : ""}</p></div><div>${previous ? `<button class="btn btn--quiet" type="button" data-action="select-story-group" data-group-id="${escapeHtml(previous.key)}" aria-label="이전 구간">‹</button>` : ""}${next ? `<button class="btn btn--quiet" type="button" data-action="select-story-group" data-group-id="${escapeHtml(next.key)}" aria-label="다음 구간">›</button>` : ""}</div></header>${expandableLongContent("구간 요약과 주요 흐름", `<div class="story-reading"><div class="story-prose"><p>${copy(group, selected.key, "summary", String(group.summary ?? ""))}</p></div>${group.beats?.length ? `<ol class="story-beats">${group.beats.map((beat: string, index: number) => `<li><span>${index + 1}</span><p>${copy(group, selected.key, "beat", beat, index)}</p></li>`).join("")}</ol>` : ""}</div>`, Math.max((group.beats?.length ?? 0) > 12 ? 1601 : 0, String(group.summary ?? "").length + (group.beats ?? []).join("").length), true)}${flowSections || segmentSections ? `<div class="story-disclosures">${flowSections ? `<details><summary><span>인물별 흐름</span><small>${group.flows.length}</small></summary><div>${flowSections}</div></details>` : ""}${segmentSections ? `<details><summary><span>세부 구간</span><small>${group.segments.length}</small></summary><div>${segmentSections}</div></details>` : ""}</div>` : ""}<section class="story-memories"><h3>관련 기억 <span>${linked.length}</span></h3>${memoryItems ? `<div class="story-memory-track" data-drag-scroll data-preserve-scroll="story-memory-track" style="--story-memory-count:${linked.length}">${memoryItems}</div><div class="story-memory-previews">${memoryPreviews}</div>` : '<p class="story-memory-empty">직접 연결된 기억이 없습니다.</p>'}</section></article></section>${pager}</main>`;
  return `<div class="story-page ${view.indexOpen ? "has-index" : ""}">${toolbar}<div class="story-workspace">${indexPanel}${reader}</div></div>`;
}

const sourceMessageOptions = (data: DashboardData, selected?: string): string => data.messages
  .filter((message) => ["committed", "client_pruned"].includes(message.lifecycle) && message.host_visibility === "active")
  .slice(-50).reverse()
  .map((message) => `<option value="${escapeHtml(message.message_id)}" ${message.message_id === selected ? "selected" : ""}>#${Number(message.ordinal)} · ${escapeHtml(message.role)} · ${escapeHtml(String(message.content ?? "").replace(/\s+/g, " ").slice(0, 72))}</option>`).join("");

const relationshipLevels: Record<string, string[]> = {
  affection: ["unknown", "aversion", "none", "faint", "growing", "established", "strong", "deep", "conflicted"],
  trust: ["unknown", "distrust", "none", "fragile", "developing", "established", "strong", "deep", "conflicted"],
  intimacy: ["unknown", "avoidant", "none", "tentative", "developing", "established", "strong", "deep", "conflicted"],
  fear: ["unknown", "none", "low", "moderate", "high", "extreme"],
  jealousy: ["unknown", "none", "low", "moderate", "high", "extreme"],
  hostility: ["unknown", "none", "low", "moderate", "high", "extreme"],
};
const relationshipTrends = ["rising", "stable", "falling", "volatile", "unclear"];
const relationshipAxisLabels: Record<string, string> = { affection: "애정", trust: "신뢰", intimacy: "친밀감", fear: "두려움", jealousy: "질투", hostility: "적대감" };
const relationshipAxisOrder = ["affection", "trust", "intimacy", "fear", "jealousy", "hostility"];
const relationshipLevelWeight: Record<string, number> = { unknown: 0, none: 1, faint: 2, low: 2, tentative: 3, fragile: 3, growing: 4, developing: 4, moderate: 4, established: 5, strong: 6, high: 6, deep: 7, extreme: 7, conflicted: 6, distrust: 6, avoidant: 6, aversion: 7 };

export function relationshipAxisPresentation(axis: string, level: string): { tone: "neutral" | "positive" | "negative" | "mixed"; percent: number } {
  const negativeLevels = new Set(["aversion", "distrust", "avoidant"]);
  const intensityAxes = new Set(["fear", "jealousy", "hostility"]);
  const weight = Math.max(0, relationshipLevelWeight[level] ?? 0);
  const percent = ["unknown", "none"].includes(level) ? 0 : Math.max(14, Math.min(100, Math.round((weight / 7) * 100)));
  const tone = level === "conflicted" ? "mixed"
    : negativeLevels.has(level) || (intensityAxes.has(axis) && percent > 0) ? "negative"
      : percent > 0 ? "positive" : "neutral";
  return { tone, percent };
}

function entityProminence(entity: any): number {
  const value = String(entity?.setupProminence ?? entity?.prominence ?? entity?.tier ?? "supporting").toLocaleLowerCase();
  if (["primary", "major", "main"].includes(value)) return 0;
  if (["reference", "incidental", "background"].includes(value)) return 2;
  return 1;
}

function personProminence(data: DashboardData, name: string): number {
  const normalized = name.normalize("NFKC").toLocaleLowerCase();
  const entity = data.entities.find((item) => [item.name, item.displayName, ...(item.aliases ?? [])]
    .some((value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase() === normalized));
  return entityProminence(entity);
}

function comparePeople(data: DashboardData, left: string, right: string): number {
  return personProminence(data, left) - personProminence(data, right) || compareUiText([left, right]);
}

function relationshipHighlights(item: any, limit = 3): string[] {
  const meaningful = relationshipAxisOrder.filter((axis) => !["unknown", "none"].includes(relationshipAxis(item, axis).level));
  const source = meaningful.length ? meaningful : relationshipAxisOrder;
  return source.slice().sort((left, right) => relationshipLevelWeight[relationshipAxis(item, right).level]! - relationshipLevelWeight[relationshipAxis(item, left).level]!
    || relationshipAxisOrder.indexOf(left) - relationshipAxisOrder.indexOf(right)).slice(0, limit);
}

function relationships(state: RuntimeState, data: DashboardData, selectedKey: string, translations: TranslationView, display: RuntimeState["settings"]["translationDisplay"], mergePreview?: any, intimacyEditor?: IntimacyEditor, section = "state", editing = false, stateView = "list", relationshipPerson = "", mobileDetail = false): string {
  const orderedRelationships = [...data.relationships].sort((left, right) => comparePeople(data, relationshipFrom(left), relationshipFrom(right))
    || comparePeople(data, relationshipTo(left), relationshipTo(right)));
  const selected = orderedRelationships.find((item) => `${relationshipFrom(item)}|${relationshipTo(item)}` === selectedKey) ?? orderedRelationships[0];
  const selectedFrom = relationshipFrom(selected), selectedTo = relationshipTo(selected);
  const activePerson = relationshipPerson || selectedFrom || relationshipFrom(orderedRelationships[0]);
  const axisChipsFor = (item: any) => `<div class="axis-groups"><div class="axis-group"><strong>유대</strong>${["affection", "trust", "intimacy"].map((axis) => { const value = relationshipAxis(item, axis); return `<span class="axis-chip" data-override="${Boolean(item.overrides?.axes?.[axis])}"><b>${relationshipAxisLabels[axis]}</b><span>${escapeHtml(relationshipLevelKo[value.level] ?? value.level)}</span><small>${escapeHtml(relationshipTrendKo[value.trend] ?? value.trend)}</small></span>`; }).join("")}</div><div class="axis-group"><strong>긴장</strong>${["fear", "jealousy", "hostility"].map((axis) => { const value = relationshipAxis(item, axis); return `<span class="axis-chip" data-override="${Boolean(item.overrides?.axes?.[axis])}"><b>${relationshipAxisLabels[axis]}</b><span>${escapeHtml(relationshipLevelKo[value.level] ?? value.level)}</span><small>${escapeHtml(relationshipTrendKo[value.trend] ?? value.trend)}</small></span>`; }).join("")}</div></div>`;
  const axisEditors = selected ? relationshipAxisOrder.map((axis) => {
    const value = relationshipAxis(selected, axis);
    return `<fieldset class="field" data-relationship-axis="${axis}"><legend>${relationshipAxisLabels[axis]}</legend><div class="formgrid"><label><span>상태</span><select name="${axis}Level">${relationshipLevels[axis]!.map((level) => `<option value="${level}" ${value.level === level ? "selected" : ""}>${escapeHtml(relationshipLevelKo[level] ?? level)}</option>`).join("")}</select></label><label><span>변화</span><select name="${axis}Trend">${relationshipTrends.map((trend) => `<option value="${trend}" ${value.trend === trend ? "selected" : ""}>${escapeHtml(relationshipTrendKo[trend] ?? trend)}</option>`).join("")}</select></label></div></fieldset>`;
  }).join("") : "";
  const editor = selected && editing ? `<form id="relationship-form" class="relationship-editor"><div class="relationship-editor__head"><h2>${escapeHtml(selectedFrom)} → ${escapeHtml(selectedTo)} 수정</h2><div class="relationship-editor__actions"><button class="btn btn--primary" type="button" data-action="submit-form">저장</button><button class="btn" type="button" data-action="close-relationship-editor">취소</button></div></div><input type="hidden" name="from" value="${escapeHtml(selectedFrom)}"><input type="hidden" name="to" value="${escapeHtml(selectedTo)}"><label class="field"><span>관계 요약</span><textarea name="summary" rows="3">${escapeHtml(selected.summary ?? "")}</textarea></label><label class="field"><span>미해결 문제</span><input name="activeTensions" value="${escapeHtml((selected.activeTensions ?? []).join(", "))}" placeholder="여러 항목은 쉼표로 구분"></label><div class="relationship-axis-editor">${axisEditors}</div><div class="actions"><button class="btn btn--primary" type="button" data-action="submit-form">저장</button><button class="btn" type="button" data-action="close-relationship-editor">취소</button></div></form>` : "";
  const selectedEvents = selected ? data.relationshipEvents.filter((event) => event.from === selectedFrom && event.to === selectedTo).slice().reverse() : [];
  const effectLabels: Record<string, string> = { increase: "증가", decrease: "감소", reveal: "드러남", complicate: "복잡해짐", resolve: "해소" };
  const impactLabels: Record<string, string> = { minor: "경미", meaningful: "유의미", major: "중대", turning: "전환점" };
  const relationshipEventRows = selectedEvents.map((event) => { const reason = translations.get(`relationship-event:${event.id}:reason`) ?? event.reason; return `<tr><td data-label="변화">${(event.changes ?? []).map((change: any) => `${escapeHtml(relationshipAxisLabels[change.axis] ?? change.axis)} ${escapeHtml(effectLabels[change.effect] ?? change.effect)} · ${escapeHtml(impactLabels[change.impact] ?? change.impact)}`).join(" · ")}</td><td data-label="이유">${bilingualCopy(event.reason, reason, display)}</td><td data-label="시점">${event.sourceOrdinal == null ? "—" : `#${Number(event.sourceOrdinal)}`}</td></tr>`; }).join("");
  const renderSignals = (item: any, limit = 3) => `<span class="relationship-signals">${relationshipHighlights(item, limit).map((axis) => `<span class="relationship-signal"><b>${relationshipAxisLabels[axis]}</b>${escapeHtml(relationshipLevelKo[relationshipAxis(item, axis).level] ?? relationshipAxis(item, axis).level)}</span>`).join("")}</span>`;
  const detail = selected ? (() => {
    const reasonKey = `relationship:${selectedFrom}|${selectedTo}:summary`;
    const translatedTensions = (selected.activeTensions ?? []).map((tension: string, index: number) => bilingualCopy(tension, translations.get(`relationship:${selectedFrom}|${selectedTo}:tension:${index}`) ?? tension, display));
    const hasOverrides = Object.keys(selected.overrides ?? {}).length > 0;
    return `<div class="relationship-detail"><div class="relationship-detail__head"><div><button class="btn btn--quiet mobile-only" type="button" data-action="back-relationship-list">‹ 목록</button><h2>${escapeHtml(selectedFrom)} → ${escapeHtml(selectedTo)}</h2><div class="relationship-detail__meta"><span>${selected.stale ? "업데이트 중" : "현재 상태"}</span><span>근거 ${selected.basisEventIds?.length ?? 0}개</span>${hasOverrides ? '<span class="history-badge">수동 수정</span>' : ""}</div></div><div class="relationship-detail__actions"><button class="btn" type="button" data-action="edit-relationship">수정</button>${hasOverrides ? `<details class="record-menu"><summary class="btn btn--quiet">더보기</summary><div class="record-menu__items"><button class="btn" type="button" data-action="reset-relationship-auto" data-key="${escapeHtml(`${selectedFrom}|${selectedTo}`)}">자동 계산으로 되돌리기</button></div></details>` : ""}</div></div>${editing ? editor : `<div class="relationship-reason"><p>${bilingualCopy(selected.summary ?? "요약 없음", translations.get(reasonKey) ?? selected.summary ?? "요약 없음", display)}</p>${translatedTensions.length ? `<small class="muted">미해결 문제: ${translatedTensions.join(" · ")}</small>` : ""}</div>${axisChipsFor(selected)}<details class="evidence"><summary>최근 변화 ${selectedEvents.length}개</summary>${relationshipEventRows ? `<div class="tablewrap"><table class="table"><thead><tr><th>변화</th><th>이유</th><th>시점</th></tr></thead><tbody>${relationshipEventRows}</tbody></table></div>` : '<div class="empty">기록된 변화가 없습니다.</div>'}</details><details class="evidence"><summary>판단 근거 ${(selected.basisEventIds ?? []).length}개</summary><div class="mono">${(selected.basisEventIds ?? []).map(escapeHtml).join("<br>") || "없음"}</div></details>`}</div>`;
  })() : '<div class="empty">확인할 관계가 없습니다.</div>';
  const grouped = new Map<string, any[]>();
  for (const item of orderedRelationships) {
    const from = relationshipFrom(item);
    const items = grouped.get(from) ?? [];
    items.push(item); grouped.set(from, items);
  }
  const groups = [...grouped.entries()].map(([from, items]) => `<details class="relationship-group" ${from === selectedFrom || grouped.size <= 2 ? "open" : ""}><summary><span class="relationship-group__name">${escapeHtml(from)}</span><span class="relationship-group__count">${items.length}</span><span class="relationship-group__state">${from === selectedFrom ? "선택됨" : ""}</span></summary>${items.map((item) => {
    const to = relationshipTo(item), key = `${from}|${to}`, isSelected = key === `${selectedFrom}|${selectedTo}`;
    const summaryKey = `relationship:${from}|${to}:summary`;
    const rowSummary = display === "en" ? String(item.summary ?? "") : String(translations.get(summaryKey) ?? item.summary ?? "");
    return `<div class="relationship-row ${isSelected ? "is-selected" : ""}"><button class="relationship-row__button" type="button" data-action="select-relationship" data-key="${escapeHtml(key)}" aria-expanded="${isSelected}"><span class="relationship-row__person">${escapeHtml(to)}</span><span class="relationship-row__summary">${escapeHtml(rowSummary || "관계 요약 대기 중")}</span>${renderSignals(item)}</button>${isSelected ? detail : ""}</div>`;
  }).join("")}</details>`).join("");
  const fromPeople = [...grouped.keys()].sort((left, right) => comparePeople(data, left, right));
  const networkPersonOptions = fromPeople.map((name) => `<option value="${escapeHtml(name)}" ${name === activePerson ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
  const networkRow = (item: any, incoming = false) => { const person = incoming ? relationshipFrom(item) : relationshipTo(item); const key = `${relationshipFrom(item)}|${relationshipTo(item)}`; const summaryKey = `relationship:${relationshipFrom(item)}|${relationshipTo(item)}:summary`; const rowSummary = display === "en" ? item.summary : translations.get(summaryKey) ?? item.summary; return `<button class="relationship-network__row" type="button" data-action="select-relationship" data-key="${escapeHtml(key)}"><strong>${escapeHtml(person)}</strong><p>${escapeHtml(rowSummary ?? "관계 요약 대기 중")}</p><span>${incoming ? "←" : "→"}</span></button>`; };
  const outgoing = orderedRelationships.filter((item) => relationshipFrom(item) === activePerson);
  const incoming = orderedRelationships.filter((item) => relationshipTo(item) === activePerson);
  const toolbar = `<div class="relationship-toolbar"><div class="relationship-toolbar__person"><label for="relationship-person">인물</label><select id="relationship-person" data-action="select-relationship-person">${networkPersonOptions}</select></div><button class="btn" type="button" data-action="relationship-state-view" data-view="${stateView === "network" ? "list" : "network"}">${stateView === "network" ? "목록" : "관계망"}</button></div>`;
  const listPanel = `<section class="panel relationship-ledger ${mobileDetail ? "is-mobile-detail" : ""}">${groups || '<div class="empty">아직 확인된 관계가 없습니다.</div>'}</section>`;
  const networkPanel = `<section class="relationship-network"><div class="relationship-network__lane"><div class="relationship-network__head"><h2>${escapeHtml(activePerson)}가 느끼는 관계</h2><span>${outgoing.length}개</span></div>${outgoing.map((item) => networkRow(item)).join("") || '<div class="relationship-empty">기록 없음</div>'}</div><div class="relationship-network__lane"><div class="relationship-network__head"><h2>${escapeHtml(activePerson)}를 향한 관계</h2><span>${incoming.length}개</span></div>${incoming.map((item) => networkRow(item, true)).join("") || '<div class="relationship-empty">기록 없음</div>'}</div></section>`;
  const entityOptions = (selected?: string, excluded?: string) => `<option value="">인물을 선택하세요</option>${data.entities.filter((entity) => entity.id !== excluded).map((entity) => {
    const aliases = (entity.aliases ?? []).filter((alias: string) => alias.toLocaleLowerCase() !== String(entity.name).toLocaleLowerCase());
    return `<option value="${escapeHtml(entity.id)}" ${entity.id === selected ? "selected" : ""}>${escapeHtml(entity.name)}${aliases.length ? ` · ${escapeHtml(aliases.join(", "))}` : ""}</option>`;
  }).join("")}`;
  const preview = mergePreview ? `<div class="merge-preview" role="status"><h3>병합 내용 확인</h3><p><strong>${escapeHtml(mergePreview.source.name)}</strong> 항목은 사라지고 모든 파생 기록이 <strong>${escapeHtml(mergePreview.target.name)}</strong>(으)로 정리됩니다.</p><dl class="impact-grid"><div><dt>기억</dt><dd>${mergePreview.affected.memories}</dd></div><div><dt>관계</dt><dd>${mergePreview.affected.relationships}</dd></div><div><dt>Belief</dt><dd>${mergePreview.affected.beliefs}</dd></div><div><dt>Promise</dt><dd>${mergePreview.affected.promises}</dd></div></dl><p class="muted">보존 별칭: ${escapeHtml(mergePreview.preservedAliases.join(", ") || "없음")} · Risu RP 원문은 변경하지 않고 파생 데이터만 정리합니다.</p>${mergePreview.busy ? `<div class="notice">${icon("clock")}<div><strong>추출 작업이 진행 중입니다</strong><div class="muted">작업이 끝난 뒤 다시 확인하면 합칠 수 있습니다.</div></div></div>` : ""}<div class="actions"><button class="btn btn--danger" type="button" data-action="merge-entities-final" data-source-id="${escapeHtml(mergePreview.source.id)}" data-target-id="${escapeHtml(mergePreview.target.id)}" data-revision="${mergePreview.revision}" ${mergePreview.busy ? "disabled" : ""}>인물 합치기</button><button class="btn" type="button" data-action="cancel-entity-merge">취소</button></div></div>` : "";
  const mergePanel = data.entities.length > 1 ? `<details class="panel"><summary class="panel__head"><h2>인물 관리</h2><span>중복 인물 합치기</span></summary><div class="panel__body"><p class="muted">같은 인물로 갈라진 파생 기록을 한 이름으로 정리합니다.</p><form id="entity-merge-form" class="formgrid"><label class="field"><span>중복으로 생성된 인물</span><small>이 항목은 병합 후 사라집니다.</small><select name="sourceId">${entityOptions(mergePreview?.source.id, mergePreview?.target.id)}</select></label><label class="field"><span>남길 대표 인물</span><small>모든 기록이 이 이름으로 정리됩니다.</small><select name="targetId">${entityOptions(mergePreview?.target.id, mergePreview?.source.id)}</select></label><div class="actions"><button class="btn btn--primary" type="button" data-action="preview-entity-merge">병합 내용 확인</button></div></form>${preview}</div></details>` : "";
  const allSocialItems = sortSocialKnowledge(Array.isArray(data.socialKnowledge) ? data.socialKnowledge : []).sort((left, right) => comparePeople(data, String(left.holder), String(right.holder))
    || comparePeople(data, String(left.subject), String(right.subject)));
  const isIncidentalSocial = (item: any) => personProminence(data, String(item.holder)) === 2 || personProminence(data, String(item.subject)) === 2;
  const socialItems = allSocialItems.filter((item) => !isIncidentalSocial(item));
  const incidentalSocialItems = allSocialItems.filter(isIncidentalSocial);
  const intimacyLabels: Record<string, string> = { hand_holding: "손잡기", embrace: "포옹", cuddling: "껴안고 있기", forehead_kiss: "이마 키스", cheek_kiss: "볼 키스", hand_kiss: "손등 키스", lip_kiss: "입술 키스", deep_kiss: "깊은 키스", sexual_touch: "성적 스킨십", manual_sex: "손을 이용한 성행위", oral_sex: "구강 성교", vaginal_sex: "질 성교", anal_sex: "항문 성교" };
  const milestoneLabels: Record<string, string> = { first_physical_intimacy: "첫 친밀 행위", first_hand_holding: "첫 손잡기", first_embrace: "첫 포옹", first_kiss: "첫 키스 · 비딥", first_deep_kiss: "첫 깊은 키스", first_sexual_touch: "첫 성적 접촉", first_manual_sex: "첫 손을 이용한 성행위", first_oral_sex: "첫 구강 성행위", first_vaginal_sex: "첫 질 성교", first_anal_sex: "첫 항문 성교", first_sex: "첫 성행위 · 구형 기록" };
  const contextLabels: Record<string, string> = { mutual: "상호적", initiated: "한쪽이 시작", coerced: "강요된 상황", nonconsensual: "비합의", ambiguous: "불명확" };
  const physicalIntimacy = (Array.isArray(data.physicalIntimacy) ? [...data.physicalIntimacy] : []).sort((left, right) => comparePeople(data, String(left.participantA), String(right.participantA))
    || comparePeople(data, String(left.participantB), String(right.participantB)) || compareUiText([left.milestoneKey, right.milestoneKey]));
  const intimacyRows = physicalIntimacy.map((item) => { const circumstance = item.circumstance || "문맥 미기록"; const translated = translations.get(`intimacy:${item.id}:circumstance`) ?? circumstance; const initiator = item.initiator === "mutual" ? "상호" : item.initiator; return `<tr><td data-label="인물">${escapeHtml(item.participantA)} · ${escapeHtml(item.participantB)}</td><td data-label="최초 마일스톤"><strong>${escapeHtml(milestoneLabels[item.milestoneKey] ?? item.milestoneKey)}</strong><small class="score-band">실제 행위: ${escapeHtml(item.act === "other" ? item.customLabel || "기타" : intimacyLabels[item.act] || item.act)}</small></td><td data-label="문맥">${escapeHtml(contextLabels[item.interactionContext] ?? item.interactionContext ?? "불명확")}${initiator ? `<small class="score-band">행위자 ${escapeHtml(initiator)}</small>` : ""}</td><td data-label="상황·의도">${bilingualCopy(circumstance, translated, display)}</td><td data-label="시점">${item.sourceOrdinal == null ? "현재" : `#${Number(item.sourceOrdinal)}`}</td><td data-label="관리"><div class="record-actions record-actions--compact"><button class="btn" data-action="edit-intimacy" data-id="${escapeHtml(item.id)}">수정</button><button class="btn btn--danger" data-action="delete-intimacy" data-id="${escapeHtml(item.id)}">삭제</button></div></td></tr>`; }).join("");
  const editingIntimacy = intimacyEditor ? physicalIntimacy.find((item) => item.id === intimacyEditor.id) : undefined;
  const intimacyPersonOptions = (selected?: string) => `<option value="">인물을 선택하세요</option>${[...data.entities].filter((entity) => ["person", "character"].includes(entity.type)).sort((left, right) => entityProminence(left) - entityProminence(right) || compareUiText([left.name, right.name])).map((entity) => `<option value="${escapeHtml(entity.name)}" ${entity.name === selected ? "selected" : ""}>${escapeHtml(entity.name)}</option>`).join("")}`;
  const actOptions = [...Object.keys(intimacyLabels), "other"].map((act) => `<option value="${act}" ${editingIntimacy?.act === act ? "selected" : ""}>${escapeHtml(act === "other" ? "기타 · 직접 입력" : intimacyLabels[act])}</option>`).join("");
  const intimacyForm = intimacyEditor ? `<form id="intimacy-form" data-id="${escapeHtml(intimacyEditor.id ?? "")}"><div class="formgrid"><label class="field"><span>참여자 1</span><select name="participantA" required>${intimacyPersonOptions(editingIntimacy?.participantA)}</select></label><label class="field"><span>참여자 2</span><select name="participantB" required>${intimacyPersonOptions(editingIntimacy?.participantB)}</select></label><label class="field"><span>실제 행위</span><select name="act">${actOptions}</select></label><label class="field"><span>기타 행위명</span><input name="customLabel" value="${escapeHtml(editingIntimacy?.customLabel ?? "")}" placeholder="기타를 선택했을 때 입력"></label><label class="field"><span>행위자</span><select name="initiator"><option value="">명시되지 않음</option><option value="mutual" ${editingIntimacy?.initiator === "mutual" ? "selected" : ""}>상호적</option>${intimacyPersonOptions(editingIntimacy?.initiator).replace('<option value="">인물을 선택하세요</option>', "")}</select></label><label class="field"><span>상황</span><select name="interactionContext">${Object.entries(contextLabels).map(([key, label]) => `<option value="${key}" ${editingIntimacy?.interactionContext === key ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label></div><label class="field"><span>당시 상황과 의도</span><textarea name="circumstance">${escapeHtml(editingIntimacy?.circumstance ?? "")}</textarea></label><details><summary>원문 근거 연결</summary><label class="field"><span>최근 활성 원문</span><select name="sourceMessageId"><option value="">연결하지 않고 현재 시점에 기록</option>${sourceMessageOptions(data)}</select></label></details><div class="actions"><button class="btn btn--primary" type="button" data-action="submit-form">${intimacyEditor.id ? "저장" : "마일스톤 추가"}</button><button class="btn" type="button" data-action="cancel-intimacy">취소</button></div></form>` : "";
  const intimacyPanel = `<section class="panel"><div class="panel__head"><h2>친밀 마일스톤</h2><button class="btn" data-action="new-intimacy">추가</button></div><div class="panel__body">${intimacyForm}<div class="tablewrap"><table class="table"><thead><tr><th>인물</th><th>최초 마일스톤</th><th>상황</th><th>당시 맥락</th><th>시점</th><th>관리</th></tr></thead><tbody>${intimacyRows}</tbody></table></div>${intimacyRows ? "" : '<div class="empty">아직 확인된 친밀 마일스톤이 없습니다.</div>'}</div></section>`;
  const socialJobs = data.socialKnowledgeJobs ?? {};
  const socialRow = (item: any, incidental = false) => `<tr data-social-row data-incidental="${incidental}"><td data-label="아는 사람">${escapeHtml(item.holder)}</td><td data-label="대상">${escapeHtml(item.subject)}${incidental ? '<small class="score-band">일회성 NPC 포함</small>' : ""}</td><td data-label="상태">${item.level === "met" ? "만난 적 있음" : "존재를 알고 있음"}</td><td data-label="알고 있는 이름">${escapeHtml((item.knownAs ?? []).join(", ") || "—")}</td><td data-label="관리"><div class="record-actions record-actions--compact"><button class="btn" data-action="edit-social" data-holder="${escapeHtml(item.holder)}" data-subject="${escapeHtml(item.subject)}" data-level="${escapeHtml(item.level)}" data-known-as="${escapeHtml((item.knownAs ?? []).join(", "))}">수정</button><button class="btn btn--danger" data-action="delete-social" data-holder="${escapeHtml(item.holder)}" data-subject="${escapeHtml(item.subject)}">삭제</button></div></td></tr>`;
  const socialRows = socialItems.map((item) => socialRow(item)).join("");
  const incidentalSocialRows = incidentalSocialItems.map((item) => socialRow(item, true)).join("");
  const socialBusy = Number(socialJobs.queued ?? 0) + Number(socialJobs.leased ?? 0);
  const chatEnabled = state.current ? isChatMemoryEnabled(state.settings, state.current.chatId) : false;
  let socialPanel = !data.health?.capabilities?.socialKnowledge
    ? `<section class="panel"><div class="panel__head"><h2>지인 관계</h2></div><div class="empty">서버 업데이트가 필요합니다.</div></section>`
    : `<section class="panel"><div class="panel__head"><h2>지인 관계</h2></div><div class="panel__body"><div class="actions"><input class="search" data-action="social-search" placeholder="이름·상태 검색"><button class="btn" data-action="new-social">추가</button><button class="btn" data-action="backfill-social" ${socialBusy ? "disabled" : ""}>${socialBusy ? `원문 확인 중 · ${socialBusy}묶음` : "기존 기록 찾기"}</button></div><form id="social-form" class="formgrid" hidden><label class="field"><span>알고 있는 사람</span><input name="holder" required></label><label class="field"><span>대상 인물</span><input name="subject" required></label><label class="field"><span>상태</span><select name="level"><option value="aware_of">존재를 알고 있음</option><option value="met">만난 적 있음</option></select></label><label class="field"><span>알고 있는 이름·직함</span><input name="knownAs" placeholder="쉼표로 구분"></label><div class="actions"><button class="btn btn--primary" type="button" data-action="submit-form">저장</button><button class="btn" data-action="cancel-social">취소</button></div></form><div class="tablewrap"><table class="table"><thead><tr><th>아는 사람</th><th>대상</th><th>상태</th><th>알고 있는 이름</th><th>관리</th></tr></thead><tbody>${socialRows}</tbody></table></div>${socialRows ? "" : '<div class="empty">아직 확인된 지인 관계가 없습니다.</div>'}${incidentalSocialRows ? `<details data-incidental-social><summary>배경 인물 기록 ${incidentalSocialItems.length}개</summary><div class="tablewrap"><table class="table"><tbody>${incidentalSocialRows}</tbody></table></div></details>` : ""}</div></section>`;
  if (!chatEnabled) socialPanel = socialPanel
    .replace('data-action="backfill-social"', 'data-action="backfill-social" disabled aria-disabled="true"')
    .replace("기존 기록 찾기", "RCM을 켜야 사용 가능");
  const normalizedSection = section === "evidence" ? "state" : section;
  const navigation = `<div class="segmented relationship-tabs" role="tablist" aria-label="관계 정보 구분">${[["state", "관계 상태"], ["intimacy", "친밀 마일스톤"], ["acquaintances", "지인 관계"]].map(([key, label]) => `<button role="tab" data-action="relationship-section" data-section="${key}" aria-selected="${normalizedSection === key}" aria-pressed="${normalizedSection === key}">${label}</button>`).join("")}</div>`;
  const statePanel = `${toolbar}${stateView === "network" ? networkPanel : listPanel}`;
  const acquaintancesPanel = `${socialPanel}${mergePanel}`;
  const content = normalizedSection === "intimacy" ? intimacyPanel : normalizedSection === "acquaintances" ? acquaintancesPanel : statePanel;
  return `<div class="relationship-page ${mobileDetail && normalizedSection === "state" && stateView === "list" ? "is-mobile-detail" : ""}">${pageHeader("관계", "")}${navigation}${content}</div>`;
}

export function relationshipsV2(state: RuntimeState, data: DashboardData, selectedKey: string, translations: TranslationView, display: RuntimeState["settings"]["translationDisplay"], _mergePreview?: any, intimacyEditor?: IntimacyEditor, section = "state", editing = false, _stateView = "list", relationshipPerson = "", mobileDetail = false, queryText = "", intimacyOnly = false, socialEditor?: SocialEditor): string {
  const allRelationships = [...data.relationships].sort((left, right) => comparePeople(data, relationshipFrom(left), relationshipFrom(right)) || comparePeople(data, relationshipTo(left), relationshipTo(right)));
  const pairMilestones = (from: string, to: string) => (data.physicalIntimacy ?? []).filter((item: any) => {
    const pair = [String(item.participantA), String(item.participantB)];
    return pair.includes(from) && pair.includes(to);
  });
  const query = queryText.trim().toLocaleLowerCase();
  const filtered = allRelationships.filter((item) => {
    const from = relationshipFrom(item), to = relationshipTo(item);
    if (relationshipPerson && from !== relationshipPerson && to !== relationshipPerson) return false;
    if (intimacyOnly && pairMilestones(from, to).length === 0) return false;
    return true;
  });
  const selected = filtered.find((item) => `${relationshipFrom(item)}|${relationshipTo(item)}` === selectedKey);
  const selectedFrom = relationshipFrom(selected), selectedTo = relationshipTo(selected);
  const hasIntimacyRecords = (data.physicalIntimacy ?? []).length > 0;
  const personNames = [...new Set(allRelationships.flatMap((item) => [relationshipFrom(item), relationshipTo(item)]))].filter(Boolean).sort((a, b) => comparePeople(data, a, b));
  const personOptions = `<option value="">모든 인물</option>${personNames.map((name) => `<option value="${escapeHtml(name)}" ${relationshipPerson === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
  const renderSignals = (item: any) => `<span class="relation-row-v2__signals">${relationshipHighlights(item, 3).map((axis) => `<span><b>${relationshipAxisLabels[axis]}</b> ${escapeHtml(relationshipLevelKo[relationshipAxis(item, axis).level] ?? relationshipAxis(item, axis).level)}</span>`).join("")}</span>`;
  const grouped = new Map<string, any[]>();
  filtered.forEach((item) => { const from = relationshipFrom(item); grouped.set(from, [...(grouped.get(from) ?? []), item]); });
  const relationGroups = [...grouped.entries()].map(([from, items]) => `<details class="relation-group-v2" data-relationship-group ${relationshipPerson || grouped.size < 4 || Boolean(query) || items.some((item) => `${relationshipFrom(item)}|${relationshipTo(item)}` === selectedKey) ? "open" : ""}><summary><strong>${escapeHtml(from)}</strong><span>${items.length}</span></summary>${items.map((item) => {
    const to = relationshipTo(item), key = `${from}|${to}`, isSelected = key === selectedKey;
    const translated = translations.get(`relationship:${from}|${to}:summary`) ?? item.summary ?? "";
    return `<button class="relation-row-v2 ${isSelected ? "is-selected" : ""}" type="button" data-action="select-relationship" data-relationship-row data-key="${escapeHtml(key)}" aria-expanded="${isSelected}"><span class="relation-row-v2__main"><strong>${escapeHtml(from)} <i>→</i> ${escapeHtml(to)}</strong><small>${bilingualCopy(item.summary ?? "아직 요약 없음", translated || "아직 요약 없음", display)}</small></span>${renderSignals(item)}</button>`;
  }).join("")}</details>`).join("");

  const axisView = (item: any) => `<div class="relation-axis-v2">${relationshipAxisOrder.map((axis) => { const value = relationshipAxis(item, axis); const presentation = relationshipAxisPresentation(axis, value.level); return `<div class="relation-axis-v2__item" data-override="${Boolean(item.overrides?.axes?.[axis])}" data-tone="${presentation.tone}"><span><b>${relationshipAxisLabels[axis]}</b><small>${escapeHtml(relationshipTrendKo[value.trend] ?? value.trend)}</small></span><div class="relation-axis-scale" aria-hidden="true"><i style="transform:scaleX(${presentation.percent / 100})"></i></div><strong>${escapeHtml(relationshipLevelKo[value.level] ?? value.level)}</strong></div>`; }).join("")}</div>`;
  const selectedEvents = selected ? data.relationshipEvents.filter((event) => event.from === selectedFrom && event.to === selectedTo).slice().reverse() : [];
  const relationshipLandmarkLabels: Record<string, string> = {
    first_met: "처음 만난 날", romantic_relationship_established: "연인이 된 날", engagement: "약혼", marriage: "결혼",
    separation: "별거", romantic_relationship_ended: "헤어진 날", reunion: "재결합", divorce: "이혼", anniversary_basis: "기념일 기준일",
  };
  const relationshipLandmarkKinds = new Set(Object.keys(relationshipLandmarkLabels));
  const selectedPairNames = new Set<string>([selectedFrom, selectedTo].map((name) => String(name).normalize("NFKC").trim().toLocaleLowerCase()));
  const relationshipLandmarks = selected ? (data.memories ?? []).flatMap((memory: any) => (memory.landmarkKinds ?? []).flatMap((landmark: any) => {
    if (!relationshipLandmarkKinds.has(landmark.kind) || !Array.isArray(landmark.pair) || landmark.pair.length !== 2) return [];
    const pair = new Set<string>(landmark.pair.map((name: unknown) => String(name).normalize("NFKC").trim().toLocaleLowerCase()));
    if (pair.size !== selectedPairNames.size || [...pair].some((name) => !selectedPairNames.has(name))) return [];
    return [{ memory, landmark }];
  })) : [];
  const relationshipLandmarkRows = relationshipLandmarks.map(({ memory, landmark }: any) => `<article class="milestone-v2 relationship-landmark-v2"><div class="milestone-v2__head"><strong>${escapeHtml(relationshipLandmarkLabels[landmark.kind] ?? landmark.label ?? landmark.kind)}</strong><span>${escapeHtml(landmark.storyTime ?? memory.story_time ?? "날짜 미기록")}</span></div><p>${escapeHtml(memory.title ?? "연결된 기억")}</p><button class="btn btn--quiet" type="button" data-action="open-timeline-memory" data-memory-id="${escapeHtml(memory.id)}">타임라인에서 열기 ${icon("arrow-right")}</button></article>`).join("");
  const relationshipLandmarkSection = `<details class="relation-section-v2 relation-milestones-v2"><summary><span>관계 이정표 <small>${relationshipLandmarks.length}</small></span></summary><div>${relationshipLandmarkRows || '<div class="relations-empty">기록된 관계 이정표가 없습니다.</div>'}</div></details>`;
  const effectLabels: Record<string, string> = { increase: "증가", decrease: "감소", reveal: "드러남", complicate: "복잡해짐", resolve: "해소" };
  const impactLabels: Record<string, string> = { minor: "작은 변화", meaningful: "뚜렷한 변화", major: "큰 변화", turning: "전환점" };
  const eventCard = (event: any) => `<article class="relation-change-v2"><div class="relation-change-v2__meta"><span class="relation-change-v2__chips">${(event.changes ?? []).map((change: any) => `<span>${escapeHtml(relationshipAxisLabels[change.axis] ?? change.axis)} ${escapeHtml(effectLabels[change.effect] ?? change.effect)}</span>`).join("") || "<span>관계 변화</span>"}</span><small>${escapeHtml(impactLabels[(event.changes ?? [])[0]?.impact] ?? "변화")}${event.sourceOrdinal == null ? "" : ` · #${Number(event.sourceOrdinal)}`}</small></div><p>${bilingualCopy(event.reason, translations.get(`relationship-event:${event.id}:reason`) ?? event.reason, display)}</p></article>`;
  const recentEventCards = selectedEvents.slice(0, 3).map(eventCard).join("");
  const olderEventCards = selectedEvents.slice(3).map(eventCard).join("");
  const initial = (data.initialCalibration?.relationships ?? []).find((item: any) => item.from === selectedFrom && item.to === selectedTo);
  const editingInitialBaseline = data.initialCalibration?.status === "awaiting_confirmation" && Boolean(initial);
  const axisEditors = selected ? relationshipAxisOrder.map((axis) => {
    const value = editingInitialBaseline ? { level: initial?.axes?.[axis] ?? "unknown", trend: "unclear" } : relationshipAxis(selected, axis);
    const trendEditor = editingInitialBaseline ? "" : `<label><span>변화</span><select name="${axis}Trend">${relationshipTrends.map((trend) => `<option value="${trend}" ${value.trend === trend ? "selected" : ""}>${escapeHtml(relationshipTrendKo[trend] ?? trend)}</option>`).join("")}</select></label>`;
    return `<fieldset class="field" data-relationship-axis="${axis}"><legend>${relationshipAxisLabels[axis]}</legend><div class="formgrid"><label><span>상태</span><select name="${axis}Level">${relationshipLevels[axis]!.map((level) => `<option value="${level}" ${value.level === level ? "selected" : ""}>${escapeHtml(relationshipLevelKo[level] ?? level)}</option>`).join("")}</select></label>${trendEditor}</div></fieldset>`;
  }).join("") : "";
  const editorSummary = editingInitialBaseline ? initial?.summary ?? "" : selected?.summary ?? "";
  const relationshipEditor = selected && editing ? `<form id="relationship-form" class="relationship-editor relation-editor-v2" ${editingInitialBaseline ? `data-initial-baseline-id="${escapeHtml(initial.id)}"` : ""}><header><div><span>${editingInitialBaseline ? "초기 관계 수정" : "관계 수정"}</span><h2>${escapeHtml(selectedFrom)} → ${escapeHtml(selectedTo)}</h2></div><div class="actions"><button class="btn btn--icon" type="button" data-action="close-relationship-editor" aria-label="닫기" title="닫기">${icon("close")}</button><button class="btn btn--icon btn--primary" type="button" data-action="submit-form" aria-label="저장" title="저장">${icon("save")}</button></div></header><input type="hidden" name="from" value="${escapeHtml(selectedFrom)}"><input type="hidden" name="to" value="${escapeHtml(selectedTo)}"><label class="field"><span>관계 요약</span><textarea name="summary" rows="4">${escapeHtml(editorSummary)}</textarea></label>${editingInitialBaseline ? '<p class="muted">확인 전 수정은 앞으로 변화가 쌓일 초기 관계로 저장됩니다.</p>' : `<label class="field"><span>남은 갈등</span><input name="activeTensions" value="${escapeHtml((selected.activeTensions ?? []).join(", "))}" placeholder="여러 항목은 쉼표로 구분"></label>`}<div class="relationship-axis-editor">${axisEditors}</div></form>` : "";

  const intimacyLabels: Record<string, string> = { hand_holding: "손잡기", embrace: "포옹", cuddling: "껴안고 있기", forehead_kiss: "이마 키스", cheek_kiss: "볼 키스", hand_kiss: "손등 키스", lip_kiss: "입술 키스", deep_kiss: "깊은 키스", sexual_touch: "성적 스킨십", manual_sex: "손을 이용한 성행위", oral_sex: "구강 성교", vaginal_sex: "질 성교", anal_sex: "항문 성교" };
  const milestoneLabels: Record<string, string> = { first_physical_intimacy: "첫 친밀 행위", first_hand_holding: "첫 손잡기", first_embrace: "첫 포옹", first_kiss: "첫 키스", first_deep_kiss: "첫 깊은 키스", first_sexual_touch: "첫 성적 접촉", first_manual_sex: "첫 손을 이용한 성행위", first_oral_sex: "첫 구강 성행위", first_vaginal_sex: "첫 질 성교", first_anal_sex: "첫 항문 성교", first_sex: "첫 성행위" };
  const contextLabels: Record<string, string> = { mutual: "상호적", initiated: "한쪽이 시작", coerced: "강요된 상황", nonconsensual: "비합의", ambiguous: "불명확" };
  const milestones = selected ? pairMilestones(selectedFrom, selectedTo) : [];
  const editingIntimacy = intimacyEditor ? (data.physicalIntimacy ?? []).find((item: any) => item.id === intimacyEditor.id) : undefined;
  const intimacyPersonOptions = (value?: string) => `<option value="">인물을 선택하세요</option>${data.entities.filter((entity) => ["person", "character"].includes(entity.type)).sort((a, b) => entityProminence(a) - entityProminence(b) || compareUiText([a.name, b.name])).map((entity) => `<option value="${escapeHtml(entity.name)}" ${entity.name === value ? "selected" : ""}>${escapeHtml(entity.name)}</option>`).join("")}`;
  const actOptions = [...Object.keys(intimacyLabels), "other"].map((act) => `<option value="${act}" ${editingIntimacy?.act === act ? "selected" : ""}>${escapeHtml(act === "other" ? "기타" : intimacyLabels[act])}</option>`).join("");
  const intimacyForm = intimacyEditor ? `<form id="intimacy-form" class="relation-intimacy-form" data-id="${escapeHtml(intimacyEditor.id ?? "")}"><div class="formgrid"><label class="field"><span>참여자 1</span><select name="participantA" required>${intimacyPersonOptions(editingIntimacy?.participantA ?? intimacyEditor.participantA)}</select></label><label class="field"><span>참여자 2</span><select name="participantB" required>${intimacyPersonOptions(editingIntimacy?.participantB ?? intimacyEditor.participantB)}</select></label><label class="field"><span>행위</span><select name="act">${actOptions}</select></label><label class="field"><span>기타 행위명</span><input name="customLabel" value="${escapeHtml(editingIntimacy?.customLabel ?? "")}"></label><label class="field"><span>행위자</span><select name="initiator"><option value="">명시되지 않음</option><option value="mutual" ${editingIntimacy?.initiator === "mutual" ? "selected" : ""}>상호</option>${intimacyPersonOptions(editingIntimacy?.initiator).replace('<option value="">인물을 선택하세요</option>', "")}</select></label><label class="field"><span>상황</span><select name="interactionContext">${Object.entries(contextLabels).map(([key, label]) => `<option value="${key}" ${editingIntimacy?.interactionContext === key ? "selected" : ""}>${label}</option>`).join("")}</select></label></div><label class="field"><span>당시 상황과 의도</span><textarea name="circumstance">${escapeHtml(editingIntimacy?.circumstance ?? "")}</textarea></label><label class="field field--check"><span><input name="autoInject" type="checkbox" ${editingIntimacy?.autoInject === false ? "" : "checked"}> 자동 주입에 포함</span><small>끄면 기록은 남고, 기억 도구로 찾을 수 있습니다.</small></label><details class="people-disclosure"><summary>원문 근거 연결</summary><div class="disclosure-form-body"><label class="field"><span>최근 활성 원문</span><select name="sourceMessageId"><option value="">현재 시점에 기록</option>${sourceMessageOptions(data)}</select></label></div></details><div class="actions"><button class="btn btn--icon" type="button" data-action="cancel-intimacy" aria-label="닫기" title="닫기">${icon("close")}</button><button class="btn btn--icon btn--primary" type="button" data-action="submit-form" aria-label="저장" title="저장">${icon("save")}</button></div></form>` : "";
  const milestoneRows = milestones.map((item: any) => `<article class="milestone-v2"><div class="milestone-v2__head"><strong>${escapeHtml(milestoneLabels[item.milestoneKey] ?? item.milestoneKey)}</strong><span>${escapeHtml(item.act === "other" ? item.customLabel || "기타" : intimacyLabels[item.act] ?? item.act)}</span><small class="milestone-v2__meta">${item.sourceOrdinal == null ? "현재" : `#${Number(item.sourceOrdinal)}`} · ${escapeHtml(contextLabels[item.interactionContext] ?? item.interactionContext ?? "불명확")}${item.autoInject === false ? " · 자동 주입 제외" : ""}</small></div><p>${bilingualCopy(item.circumstance || "상황 미기록", translations.get(`intimacy:${item.id}:circumstance`) ?? item.circumstance ?? "상황 미기록", display)}</p></article>`).join("");
  const milestoneEditorRows = milestones.map((item: any) => `<article class="milestone-editor-row"><div><strong>${escapeHtml(milestoneLabels[item.milestoneKey] ?? item.milestoneKey)}</strong><small>${item.sourceOrdinal == null ? "현재" : `#${Number(item.sourceOrdinal)}`} · ${escapeHtml(contextLabels[item.interactionContext] ?? item.interactionContext ?? "불명확")}${item.autoInject === false ? " · 자동 주입 제외" : ""}</small></div><div class="record-actions"><button class="btn btn--icon" type="button" data-action="edit-intimacy" data-id="${escapeHtml(item.id)}" aria-label="마일스톤 수정" title="수정">${icon("edit")}</button><button class="btn btn--icon btn--danger" type="button" data-action="delete-intimacy" data-id="${escapeHtml(item.id)}" aria-label="마일스톤 삭제" title="삭제">${icon("delete")}</button></div></article>`).join("");
  const milestoneManagement = selected && editing ? `<section class="relation-section-v2 milestone-management"><header><h3>친밀 마일스톤</h3><span>${milestones.length}</span><button class="btn btn--icon" type="button" data-action="new-intimacy" data-a="${escapeHtml(selectedFrom)}" data-b="${escapeHtml(selectedTo)}" aria-label="마일스톤 추가" title="추가">${icon("add")}</button></header>${intimacyForm}${milestoneEditorRows || '<div class="relations-empty">기록된 마일스톤이 없습니다.</div>'}</section>` : "";
  const initialTranslationKey = initial ? `initial-relationship:${initial.id ?? `${selectedFrom}|${selectedTo}`}:summary` : "";
  const initialView = initial ? `<details class="relation-disclosure-v2"><summary><span>처음 설정된 관계</span></summary><div><p>${bilingualCopy(initial.summary || "요약 없음", translations.get(initialTranslationKey) ?? initial.summary ?? "요약 없음", display)}</p><div class="relation-baseline-v2">${relationshipAxisOrder.map((axis) => `<span><b>${relationshipAxisLabels[axis]}</b>${escapeHtml(initialAxisLabel[initial.axes?.[axis]] ?? initial.axes?.[axis] ?? "알 수 없음")}</span>`).join("")}</div></div></details>` : "";
  const eventHistory = olderEventCards ? `<details class="relation-more-changes-v2"><summary><span>이전 변화 <small>${selectedEvents.length - 3}</small></span></summary><div>${olderEventCards}</div></details>` : "";
  const detail = selected ? `<article class="relation-reader-v2">${relationshipEditor ? `<div class="relation-edit-stack">${relationshipEditor}${milestoneManagement}</div>` : `<header><button class="btn btn--quiet relations-back" type="button" data-action="back-relationship-list">‹</button><div><span>${selected.stale ? "업데이트 중" : "관계 상태"}</span><h2><button class="relation-person-link" type="button" data-action="open-relationship-person" data-person-name="${escapeHtml(selectedFrom)}">${escapeHtml(selectedFrom)}</button> <i>→</i> <button class="relation-person-link" type="button" data-action="open-relationship-person" data-person-name="${escapeHtml(selectedTo)}">${escapeHtml(selectedTo)}</button></h2></div><div class="relation-reader-v2__actions"><button class="btn btn--icon" data-action="edit-relationship" aria-label="관계 수정" title="수정">${icon("edit")}</button>${Object.keys(selected.overrides ?? {}).length ? `<details class="record-menu record-menu--icon"><summary class="btn btn--icon" aria-label="관계 더보기" title="더보기">${icon("more")}</summary><div class="record-menu__items"><button class="btn" data-action="reset-relationship-auto" data-key="${escapeHtml(`${selectedFrom}|${selectedTo}`)}">수동 수정 해제</button></div></details>` : ""}</div></header><section class="relation-summary-v2"><p>${bilingualCopy(selected.summary ?? "아직 요약 없음", translations.get(`relationship:${selectedFrom}|${selectedTo}:summary`) ?? selected.summary ?? "아직 요약 없음", display)}</p>${(selected.activeTensions ?? []).length ? `<strong class="relation-tension-label">남은 갈등</strong><ul>${selected.activeTensions.map((item: string, index: number) => `<li>${bilingualCopy(item, translations.get(`relationship:${selectedFrom}|${selectedTo}:tension:${index}`) ?? item, display)}</li>`).join("")}</ul>` : ""}</section>${axisView(selected)}<section class="relation-section-v2"><header><h3>최근 변화</h3><span>${selectedEvents.length}</span></header>${recentEventCards || '<div class="relations-empty">아직 기록된 변화가 없습니다.</div>'}${eventHistory}</section>${relationshipLandmarkSection}<details class="relation-section-v2 relation-milestones-v2"><summary><span>친밀 마일스톤 <small>${milestones.length}</small></span></summary><div>${milestoneRows || '<div class="relations-empty">기록된 마일스톤이 없습니다.</div>'}</div></details>${initialView}<details class="relation-disclosure-v2"><summary><span>판단 근거 <small>${selected.basisEventIds?.length ?? 0}</small></span></summary><div>${selectedEvents.filter((event) => (selected.basisEventIds ?? []).includes(event.id)).map((event) => `<p>${bilingualCopy(event.reason, translations.get(`relationship-event:${event.id}:reason`) ?? event.reason, display)}</p>`).join("") || '<p class="muted">연결된 변화 기록을 찾을 수 없습니다.</p>'}</div></details>`}</article>` : "";
  const toolbarCount = section === "acquaintances" ? (data.socialKnowledge ?? []).length : filtered.length;
  const toolbar = `<header class="pagehead relations-toolbar-v2"><div class="pagehead__copy"><h1>관계</h1><p><span ${section === "acquaintances" ? "data-social-count" : "data-relationship-count"}>${toolbarCount}개</span>의 관계 기록</p></div><div class="pagehead__actions"><div class="segmented view-switch relations-view-switch" role="tablist" aria-label="관계 정보"><button role="tab" data-action="relationship-section" data-section="state" aria-selected="${section !== "acquaintances"}">관계 상태</button><button role="tab" data-action="relationship-section" data-section="acquaintances" aria-selected="${section === "acquaintances"}">지인 관계</button></div></div></header>`;
  const relationFilters = `<div class="relations-filters-v2"><label>${icon("search")}<input type="search" data-action="relationship-search" value="${escapeHtml(queryText)}" placeholder="인물 또는 관계 검색" aria-label="관계 검색"></label><select data-action="select-relationship-person" aria-label="인물 선택">${personOptions}</select>${hasIntimacyRecords ? `<button type="button" data-action="relationship-filter" aria-pressed="${intimacyOnly}">마일스톤 있음</button>` : ""}</div>`;
  const stateContent = `<section class="relations-workspace-v2 ${selected ? "has-selection" : ""} ${mobileDetail ? "is-mobile-detail" : ""}" role="tabpanel" aria-label="관계 상태"><div class="relations-list-v2">${relationFilters}<div class="relations-list-v2__scroll" data-preserve-scroll="relationship-list">${relationGroups || '<div class="relations-empty">조건에 맞는 관계가 없습니다.</div>'}<div class="relations-empty" data-relationship-search-empty hidden>검색 결과가 없습니다.</div></div></div>${selected ? `<div class="relations-detail-v2">${detail}</div>` : ""}</section>`;

  const socialJobs = data.socialKnowledgeJobs ?? {}, socialBusy = Number(socialJobs.queued ?? 0) + Number(socialJobs.leased ?? 0);
  const chatEnabled = state.current ? isChatMemoryEnabled(state.settings, state.current.chatId) : false;
  const social = [...(data.socialKnowledge ?? [])].sort((left: any, right: any) => comparePeople(data, String(left.holder), String(right.holder))
    || comparePeople(data, String(left.subject), String(right.subject))
    || compareUiText([(left.knownAs ?? []).join(" "), (right.knownAs ?? []).join(" ")]));
  const socialGroups = new Map<string, any[]>(); social.forEach((item: any) => socialGroups.set(String(item.holder), [...(socialGroups.get(String(item.holder)) ?? []), item]));
  const openSocialGroups = socialGroups.size < 4;
  const socialRows = [...socialGroups.entries()].map(([holder, items]) => `<details class="social-group-v2" data-social-group ${openSocialGroups ? "open" : ""}><summary><strong>${escapeHtml(holder)}</strong><span>${items.length}</span></summary>${items.map((item) => `<article class="social-row-v2" data-social-row><div class="social-direction"><span>${escapeHtml(holder)}</span><i aria-hidden="true">→</i><strong>${escapeHtml(item.subject)}</strong><em>${item.level === "met" ? "만난 적 있음" : "존재를 알고 있음"}</em></div><p>${escapeHtml((item.knownAs ?? []).join(" · ") || "알고 있는 이름 없음")}</p><div class="record-actions"><button class="btn btn--icon" data-action="edit-social" data-holder="${escapeHtml(item.holder)}" data-subject="${escapeHtml(item.subject)}" data-level="${escapeHtml(item.level)}" data-known-as="${escapeHtml((item.knownAs ?? []).join(", "))}" aria-label="지인 관계 수정" title="수정">${icon("edit")}</button><button class="btn btn--icon btn--danger" data-action="delete-social" data-holder="${escapeHtml(item.holder)}" data-subject="${escapeHtml(item.subject)}" aria-label="지인 관계 삭제" title="삭제">${icon("delete")}</button></div></article>`).join("")}</details>`).join("");
  const socialBackfill = `<button class="btn" data-action="backfill-social" ${socialBusy || !chatEnabled ? "disabled" : ""}>${socialBusy ? `다시 찾는 중 · ${socialBusy}` : !chatEnabled ? "RCM을 켜야 사용 가능" : "지인 관계 다시 찾기"}</button>`;
  const socialEditorPanel = socialEditor ? `<aside class="social-detail-v2"><form id="social-form" class="social-editor-v2" data-original-holder="${escapeHtml(socialEditor.editing ? socialEditor.holder : "")}" data-original-subject="${escapeHtml(socialEditor.editing ? socialEditor.subject : "")}"><header><div><span>${socialEditor.editing ? "지인 관계 수정" : "새 지인 관계"}</span><h2>${socialEditor.editing ? `${escapeHtml(socialEditor.holder)} → ${escapeHtml(socialEditor.subject)}` : "지인 관계 추가"}</h2></div><div class="actions"><button class="btn btn--icon" type="button" data-action="cancel-social" aria-label="닫기" title="닫기">${icon("close")}</button><button class="btn btn--icon btn--primary" type="button" data-action="submit-form" aria-label="저장" title="저장">${icon("save")}</button></div></header><div class="formgrid"><label class="field"><span>알고 있는 사람</span><input name="holder" value="${escapeHtml(socialEditor.holder)}" required></label><label class="field"><span>대상 인물</span><input name="subject" value="${escapeHtml(socialEditor.subject)}" required></label><label class="field"><span>상태</span><select name="level"><option value="aware_of" ${socialEditor.level === "aware_of" ? "selected" : ""}>존재를 알고 있음</option><option value="met" ${socialEditor.level === "met" ? "selected" : ""}>만난 적 있음</option></select></label><label class="field"><span>알고 있는 이름·직함</span><input name="knownAs" value="${escapeHtml(socialEditor.knownAs)}" placeholder="쉼표로 구분"></label></div></form></aside>` : "";
  const socialContent = !data.health?.capabilities?.socialKnowledge ? '<div class="relations-empty">이 기능을 사용하려면 서버를 업데이트해 주세요.</div>' : `<section class="social-workspace-v2 ${socialEditor ? "has-editor" : ""}" role="tabpanel" aria-label="지인 관계"><div class="social-master-v2"><div class="relations-filters-v2 social-filters-v2"><label>${icon("search")}<input type="search" data-action="social-search" placeholder="인물 또는 지인 관계 검색" aria-label="지인 관계 검색"></label><div class="social-filter-actions"><button class="btn btn--icon" data-action="new-social" aria-label="지인 관계 추가" title="추가">${icon("add")}</button><details class="record-menu record-menu--icon"><summary class="btn btn--icon" aria-label="지인 관계 더보기" title="더보기">${icon("more")}</summary><div class="record-menu__items">${socialBackfill}</div></details></div></div><div class="social-list-v2 relations-list-v2__scroll" data-preserve-scroll="social-list">${socialRows || '<div class="relations-empty"><p>아직 지인 관계가 없습니다.</p></div>'}<div class="relations-empty" data-social-search-empty hidden>검색 결과가 없습니다.</div></div></div>${socialEditorPanel}</section>`;
  return `<div class="relationships-page">${toolbar}${section === "acquaintances" ? socialContent : stateContent}</div>`;
}

function renderEvidenceIssues(item: any): string {
  const draft = item.draft ?? {};
  const review = item.evidenceReview;
  const issues = review?.issues ?? [];
    const sources = new Map<string, any>((review?.sourceMessages ?? []).map((source: any) => [source.id, source]));
    const evidenceRows = issues.map((issue: any, index: number) => {
      const source = sources.get(issue.messageId);
      const parts = String(issue.path).replace(/\[(\d+)\]/g, ".$1").split(".");
      let candidate: any = draft;
      let owner: any = draft;
      for (const part of parts) { if (candidate?.speaker || candidate?.access) owner = candidate; candidate = candidate?.[part]; }
      if (candidate?.speaker || candidate?.access) owner = candidate;
      const access = (owner?.access ?? []).map((grant: any) => grant.holder).join(", ") || "확인 필요";
      const affected = owner?.holder ?? owner?.speaker ?? owner?.subject ?? "확인 필요";
      return `<details class="memory-subsection memory-evidence-row"><summary><span>근거 ${index + 1} · ${issue.blocking ? "누적 상태 확인 필요" : "발췌 제외"}</span><small>${issue.reason === "access_unverified" ? "접근 범위 확인 필요" : issue.reason === "source_unavailable" ? "원문 참조 확인 필요" : issue.reason === "source_range_unverified" ? "원문 위치 확인 필요" : "원문과 발췌 불일치"}</small></summary><div class="panel__body"><p>영향 인물 ${escapeHtml(affected)}</p><p>발언자 ${escapeHtml(owner?.speaker ?? "서술 / 미지정")} · 접근 범위 ${escapeHtml(access)}</p><p><strong>후보 발췌</strong></p><blockquote>${escapeHtml(issue.quote ?? "발췌 없음")}</blockquote><p><strong>대응 원문</strong> ${source ? `${escapeHtml(source.role)} · ${Number(source.ordinal) + 1}번째 메시지` : "현재 참조로 원문을 확인할 수 없음"}</p>${source ? `<pre class="packet">${escapeHtml(source.content)}</pre>` : ""}</div></details>`;
    }).join("");

 return evidenceRows;
}

function reviewPage(data: DashboardData, translations: TranslationView, display: RuntimeState["settings"]["translationDisplay"]): string {
  const pendingAudits = data.extractionAudits.filter((item) => item.status === "pending_review" || item.status === "failed");
  const auditRows = pendingAudits.map((item) => {
    const draft = item.draft ?? {};
    const counts = [
      `기억 ${(draft.memories ?? []).length}`,
      `belief ${(draft.beliefs ?? []).length}`,
      `약속 ${(draft.promises ?? []).length}`,
      `친밀 행위 ${(draft.physicalIntimacy ?? []).length}`,
    ].join(" · ");
    const source = (item.sourceMessageIds ?? []).join(", ") || "원문 범위 없음";
    const processingCopy = item.evidenceReview?.blocking === false
      ? "확인되지 않은 발췌만 보류합니다. 마지막 확정 기억과 다른 기억 처리는 계속됩니다."
      : "누적 상태에 영향을 줄 수 있는 후보를 보존했습니다. 마지막 확정 기억으로 대화를 계속할 수 있습니다.";
    return `<article class="duplicate-review"><div class="row__top"><strong>추출 묶음 재검수</strong>${status("warn", item.status === "failed" ? "검수 호출 실패" : "검수 대기")}</div><div class="row__meta"><span>${escapeHtml(counts)}</span><span>시도 ${Number(item.attempts ?? 1)}회</span><span>${formatTime(item.updatedAt)}</span></div><p class="muted">${processingCopy}</p>${item.error ? `<div class="notice" role="alert">${icon("error")}<div>${escapeHtml(item.error)}</div></div>` : ""}<details><summary>원문 범위와 1차 초안 보기</summary><div class="panel__body"><p class="mono">${escapeHtml(source)}</p><pre class="mono">${escapeHtml(JSON.stringify(draft, null, 2))}</pre></div></details>${renderEvidenceIssues(item)}<div class="actions"><button class="btn btn--primary" data-action="retry-extraction-audit" data-id="${escapeHtml(item.id)}">다시 확인 · 보조 모델 호출</button></div></article>`;
  }).join("");
  const recentAudits = data.extractionAudits.filter((item) => !["pending_review", "failed"].includes(item.status)).slice(0, 20);
  const auditContent = `<div class="statusbar">${pendingAudits.length ? status("warn", `${pendingAudits.length}개 추출 검수 필요`) : status("ok", "추출 검수 완료")}<span class="muted">실패한 초안은 삭제되지 않으며 마지막 확정 기억만 RP에 사용됩니다.</span></div><section class="panel review-list">${auditRows || '<div class="empty">재검수가 필요한 추출 묶음이 없습니다.</div>'}</section>${recentAudits.length ? `<details class="panel"><summary class="panel__head"><h2>최근 추출 검수</h2><span>최근 ${recentAudits.length}개</span></summary><div class="panel__body">${recentAudits.map((item) => `<div class="row__meta"><strong>${escapeHtml(item.jobId)}</strong><span>${escapeHtml(item.status)}</span><span>${formatTime(item.updatedAt)}</span></div>`).join("")}</div></details>` : ""}`;
  const duplicatePending = data.reconciliationReviews.filter((item) => item.status === "pending");
  const duplicateRows = duplicatePending.map((item) => {
    const incoming = item.incoming ?? {};
    const recommendation = item.decision?.decision ? `${item.decision.decision}${item.decision.reason ? ` · ${item.decision.reason}` : ""}` : "판정 실패";
    const recommendedTarget = item.candidates.find((candidate: any) => candidate.id === item.decision?.targetId) ?? item.candidates[0];
    const canonical = incoming.content ?? incoming.value ?? incoming.title ?? JSON.stringify(incoming);
    const candidateCopy = recommendedTarget?.value?.content ?? recommendedTarget?.value?.value ?? recommendedTarget?.value?.title ?? "비교할 기존 항목이 없습니다.";
    const incomingTranslation = translations.get(`reconciliation:${item.id}:incoming`);
    const candidateTranslation = translations.get(`reconciliation:${item.id}:candidate`);
    const referenceTranslation = (id: string, value?: string) => display === "en" ? "" : `<small class="reference-translation review-ko" data-translation-id="${escapeHtml(id)}">참고 번역, 저장되지 않음 · ${escapeHtml(value ?? "번역 준비 중")}</small>`;
    const editFields = item.itemKind === "memory"
      ? `<label class="field"><span>Canonical title · 기억 정본</span><input name="canonicalTitle" value="${escapeHtml(incoming.title ?? "")}"></label><label class="field"><span>Canonical content · 기억 정본</span><textarea name="canonicalContent">${escapeHtml(incoming.content ?? "")}</textarea></label>`
      : `<label class="field"><span>Canonical value/content · 기억 정본</span><textarea name="canonicalValue">${escapeHtml(incoming.value ?? incoming.content ?? "")}</textarea></label>`;
    return `<article class="duplicate-review" data-reconciliation-id="${escapeHtml(item.id)}"><div class="row__top"><strong>${escapeHtml(item.itemRef)}</strong>${status("warn", "중복 검토 필요")}</div><div class="row__meta"><span>${escapeHtml(item.itemKind)}</span><span>${formatTime(item.createdAt)}</span></div><div class="compare"><div class="compare__item"><h3>새로 추출된 후보</h3><p>${escapeHtml(canonical)}</p>${referenceTranslation(`reconciliation:${item.id}:incoming`, incomingTranslation)}<small class="muted">시간 ${escapeHtml(incoming.storyTime ?? "명시 없음")} · 장소 ${escapeHtml((incoming.locations ?? []).join(", ") || "명시 없음")} · knownBy ${escapeHtml((incoming.knownBy ?? []).join(", ") || "—")}</small></div><div class="compare__item"><h3>기존 장부 후보</h3><p>${escapeHtml(candidateCopy)}</p>${referenceTranslation(`reconciliation:${item.id}:candidate`, candidateTranslation)}<small class="muted">target ${escapeHtml(recommendedTarget?.id ?? "없음")}</small></div></div><p class="review-reason"><strong>모델 추천</strong> ${escapeHtml(recommendation)}${item.error ? `<br><span class="muted">자동 적용하지 않은 이유: ${escapeHtml(item.error)}</span>` : ""}</p><details><summary>기억 정본 수정</summary><form class="reconciliation-edit" data-review-id="${escapeHtml(item.id)}">${editFields}<p class="muted">한국어 참고 번역은 읽기 전용이며 저장 시 선택한 언어의 정본만 적용됩니다.</p></form></details><div class="actions"><button class="btn btn--primary" data-action="resolve-reconciliation" data-resolution="merge" data-id="${escapeHtml(item.id)}" data-target-id="${escapeHtml(recommendedTarget?.id ?? "")}" ${recommendedTarget ? "" : "disabled"}>추천대로 병합</button><button class="btn" data-action="resolve-reconciliation" data-resolution="distinct" data-id="${escapeHtml(item.id)}">별도 항목으로 저장</button><button class="btn" data-action="resolve-reconciliation" data-resolution="update" data-id="${escapeHtml(item.id)}" data-target-id="${escapeHtml(recommendedTarget?.id ?? "")}" ${recommendedTarget ? "" : "disabled"}>새 정보로 갱신</button><button class="btn btn--danger" data-action="resolve-reconciliation" data-resolution="discard" data-id="${escapeHtml(item.id)}">폐기</button></div></article>`;
  }).join("");
  const recent = data.reconciliationReviews.filter((item) => item.status !== "pending").slice(0, 20);
  const duplicateContent = `<div class="statusbar">${duplicatePending.length ? status("warn", `${duplicatePending.length}개 검토 필요`) : status("ok", "중복 검토 완료")}<span class="muted">모호하거나 충돌하는 후보는 검색·관계·embedding에서 제외된 채 보존됩니다.</span></div><section class="panel review-list">${duplicateRows || '<div class="empty">검토할 중복 후보가 없습니다.</div>'}</section>${recent.length ? `<details class="panel"><summary class="panel__head"><h2>최근 자동 정리</h2><span>최근 ${recent.length}개</span></summary><div class="panel__body">${recent.map((item) => `<div class="row__meta"><strong>${escapeHtml(item.itemRef)}</strong><span>${escapeHtml(item.status)}</span><span>${formatTime(item.resolvedAt ?? item.createdAt)}</span></div>`).join("")}</div></details>` : ""}`;
  return `${pageHeader("Review", "검수 실패 초안과 자동 병합하지 않은 중복 후보를 확인합니다.")}${auditContent}${duplicateContent}`;
}

const worldPredicateLabels: Record<string, string> = {
  located_in: "위치", controls: "통제", owns: "소유", is_open: "개방 상태", status: "상태",
  intends_to_leave: "떠날 의도", knows_about: "알고 있는 사실", trusts: "신뢰 판단",
};
const worldPolarityLabels: Record<string, string> = { believes: "믿음", suspects: "의심", denies: "부정", knows: "확신", heard: "전해 들음" };
const worldBeliefStatusLabels: Record<string, string> = { active: "현재", superseded: "이전 인식", disputed: "상충", pending_review: "확인 필요", user_overridden: "수동 수정", deleted: "삭제됨" };
const worldPromiseStatusLabels: Record<string, string> = { open: "이행 전", kept: "이행됨", broken: "파기됨", released: "의무 해제", offscreen: "시점 경과", invalidated: "근거 무효" };

const worldPredicateLabel = (value: unknown): string => worldPredicateLabels[String(value)] ?? String(value ?? "속성").replaceAll("_", " ");
const worldConfidence = (value: unknown): string => Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : "—";
const worldCurrentKey = (item: any): string => `current:${String(item.id ?? item.promise_key ?? "")}`;
const worldHistoryKey = (item: any, index: number): string => `history:${String(item.id ?? item.promise_key ?? index)}:${index}`;

function worldEditorPanel(data: DashboardData, editor?: WorldEditor): string {
  if (!editor) return "";
  const collection = editor.kind === "assertion" ? data.assertions : editor.kind === "belief" ? data.beliefs : data.promises;
  const item = editor.mode === "create" ? {} : collection.find((value) => String(value.id) === editor.id);
  if (!item) return "";
  const label = editor.kind === "assertion" ? "세계 상태" : editor.kind === "belief" ? "인물의 인식" : "약속";
  const canonical = editor.kind === "promise" ? item.content : item.value;
  if (editor.mode === "delete") return `<article class="world-delete" role="alert"><span class="world-reader__kicker">${escapeHtml(label)} 삭제</span><h2>${escapeHtml(canonical || "선택한 기록")}</h2><p>이 기록을 RCM 장부에서 삭제합니다.</p><div class="actions"><button class="btn" type="button" data-action="cancel-world-edit">취소</button><button class="btn btn--danger" type="button" data-action="confirm-delete-world" data-kind="${editor.kind}" data-id="${escapeHtml(editor.id)}">삭제</button></div></article>`;
  const confidence = `<label class="field"><span>확신도</span><input name="confidence" type="number" min="0" max="1" step="0.01" value="${Number(item.confidence ?? .7).toFixed(2)}"></label>`;
  const fields = editor.kind === "assertion"
    ? `<div class="formgrid"><label class="field"><span>대상</span><input name="subject" value="${escapeHtml(item.subject)}" required></label><label class="field"><span>속성</span><input name="predicate" value="${escapeHtml(item.predicate)}" required></label></div><label class="field"><span>내용</span><textarea name="value" required>${escapeHtml(item.value)}</textarea></label>${confidence}`
    : editor.kind === "belief"
      ? `<div class="formgrid"><label class="field"><span>관점 인물</span><input name="holder" value="${escapeHtml(item.holder)}" required></label><label class="field"><span>대상</span><input name="subject" value="${escapeHtml(item.subject)}" required></label><label class="field"><span>속성</span><input name="predicate" value="${escapeHtml(item.predicate)}" required></label><label class="field"><span>인식</span><select name="polarity">${["believes", "suspects", "denies", "knows", "heard"].map((value) => `<option value="${value}" ${item.polarity === value ? "selected" : ""}>${worldPolarityLabels[value]}</option>`).join("")}</select></label></div><label class="field"><span>내용</span><textarea name="value" required>${escapeHtml(item.value)}</textarea></label>${confidence}`
      : `<div class="formgrid"><label class="field"><span>약속한 인물</span><input name="promisor" value="${escapeHtml(item.promisor)}" required></label><label class="field"><span>상대</span><input name="promisee" value="${escapeHtml(item.promisee)}" required></label><label class="field"><span>상태</span><select name="status">${Object.entries(worldPromiseStatusLabels).map(([value, text]) => `<option value="${value}" ${item.status === value ? "selected" : ""}>${text}</option>`).join("")}</select></label><label class="field"><span>예정 시점</span><input name="scheduledFor" value="${escapeHtml(item.scheduled_for ?? "")}" placeholder="예: 화요일 점심"></label></div><label class="field"><span>약속 내용</span><textarea name="content" required>${escapeHtml(item.content)}</textarea></label><label class="field"><span>상태 메모</span><input name="statusReason" value="${escapeHtml(item.status_reason ?? "")}" placeholder="현재 상태의 근거"></label>`;
  const scope = editor.kind === "promise" && editor.mode === "create" ? '<label class="field"><span>반복 여부</span><select name="scope"><option value="future">한 번의 약속</option><option value="recurring">반복 약속</option></select></label>' : "";
  const availableSources = sourceMessageOptions(data);
  const source = editor.mode === "create" && availableSources ? `<details class="world-disclosure"><summary>원문 근거 연결</summary><div><label class="field"><span>최근 활성 원문</span><select name="sourceMessageId"><option value="">연결하지 않음</option>${availableSources}</select></label></div></details>` : "";
  return `<form id="world-state-form" class="world-editor" data-kind="${editor.kind}" data-id="${escapeHtml(editor.id ?? "")}" data-mode="${editor.mode}"><header><button class="world-back" type="button" data-action="cancel-world-edit" aria-label="수정 닫기">‹</button><div><span>${escapeHtml(label)}</span><h2>${editor.mode === "create" ? "새 기록" : "수정"}</h2></div><div class="world-reader__actions"><button class="btn btn--icon" type="button" data-action="cancel-world-edit" aria-label="닫기" title="닫기">${icon("close")}</button><button class="btn btn--icon btn--primary" type="button" data-action="submit-form" aria-label="저장" title="저장">${icon("save")}</button></div></header><div class="world-editor__body">${fields}${scope}${source}</div></form>`;
}

export function world(data: DashboardData, kind: WorldKind, view: WorldViewState, translations: TranslationView, display: RuntimeState["settings"]["translationDisplay"], editor?: WorldEditor): string {
  const meta = kind === "beliefs"
    ? { title: "인물의 인식", description: "인물별 관점을 확인합니다.", search: "인물 또는 인식 검색", itemKind: "belief" as const }
    : kind === "promises"
      ? { title: "약속", description: "이어지는 약속을 확인합니다.", search: "인물 또는 약속 검색", itemKind: "promise" as const }
      : { title: "세계 상태", description: "현재 사실을 확인합니다.", search: "대상 또는 내용 검색", itemKind: "assertion" as const };
  const current = kind === "beliefs" ? data.beliefs : kind === "promises" ? data.promises : data.assertions;
  const history = kind === "beliefs" ? [...data.endedBeliefs, ...data.userDeletedBeliefs.map((item: any) => ({ ...item, status: "deleted" }))] : kind === "promises" ? data.promiseHistory : data.endedAssertions;
  const holders = [...new Set([...data.beliefs, ...data.endedBeliefs].map((item: any) => String(item.holder ?? "")).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  const filterItems = kind === "promises"
    ? current.filter((item: any) => view.filter === "all" || (view.filter === "open" ? item.status === "open" : item.status !== "open"))
    : view.filter === "history" ? history : view.filter === "all" ? [...current, ...history] : current;
  const holderItems = kind === "beliefs" && view.holder ? filterItems.filter((item: any) => item.holder === view.holder) : filterItems;
  const query = view.query.trim().toLocaleLowerCase();
  const visible = holderItems.filter((item: any) => !query || [item.subject, item.predicate, item.value, item.holder, item.promisor, item.promisee, item.content, item.status]
    .some((value) => String(value ?? "").toLocaleLowerCase().includes(query)));
  const currentSet = new Set(current);
  const recordKey = (item: any, index: number) => currentSet.has(item) ? worldCurrentKey(item) : worldHistoryKey(item, index);
  const translationKeyFor = (item: any, isCurrent: boolean, index: number) => isCurrent
    ? `${meta.itemKind}:${item.id ?? item.promise_key ?? index}`
    : `history:${kind}:${item.id ?? index}`;
  const entries = visible.map((item: any) => {
    const isCurrent = currentSet.has(item);
    const index = Math.max(0, isCurrent ? current.indexOf(item) : history.indexOf(item));
    return { item, key: recordKey(item, index), translationKey: translationKeyFor(item, isCurrent, index), current: isCurrent };
  });
  const grouped = new Map<string, Array<{ item: any; key: string; translationKey: string; current: boolean }>>();
  entries.forEach((entry) => {
    const { item } = entry;
    const label = kind === "beliefs" ? String(item.holder || "관점 미상") : (worldPromiseStatusLabels[item.status] ?? String(item.status || "상태 미상"));
    const group = grouped.get(label) ?? [];
    group.push(entry);
    grouped.set(label, group);
  });
  const row = ({ item, key, translationKey, current: isCurrent }: { item: any; key: string; translationKey: string; current: boolean }) => {
    const selected = key === view.selectedId;
    const canonical = String(kind === "promises" ? item.content ?? "내용 없음" : item.value ?? "내용 없음");
    const listCopy = display === "en" ? canonical : translations.get(translationKey) ?? canonical;
    if (kind === "beliefs") return `<button class="world-row ${selected ? "is-selected" : ""}" type="button" data-action="select-world" data-id="${escapeHtml(key)}" data-world-row><span class="world-row__mark">${escapeHtml(String(item.holder || "?").slice(0, 1))}</span><span class="world-row__copy"><span><strong>${escapeHtml(item.subject || "대상 미상")}</strong><em>${escapeHtml(worldPolarityLabels[item.polarity] ?? item.polarity ?? "인식")}</em></span><p>${escapeHtml(listCopy)}</p><small>${escapeHtml(worldBeliefStatusLabels[item.status] ?? (isCurrent ? "현재" : "이전 인식"))}</small></span><span aria-hidden="true">›</span></button>`;
    if (kind === "promises") return `<button class="world-row ${selected ? "is-selected" : ""}" type="button" data-action="select-world" data-id="${escapeHtml(key)}" data-world-row><span class="world-row__mark is-promise">${icon("clock")}</span><span class="world-row__copy"><span><strong>${escapeHtml(item.promisor || "미상")} → ${escapeHtml(item.promisee || "미상")}</strong><em>${escapeHtml(worldPromiseStatusLabels[item.status] ?? item.status ?? "상태 미상")}</em></span><p>${escapeHtml(listCopy)}</p><small>${escapeHtml(item.scheduled_for || "시점 미정")}</small></span><span aria-hidden="true">›</span></button>`;
    return `<button class="world-row ${selected ? "is-selected" : ""}" type="button" data-action="select-world" data-id="${escapeHtml(key)}" data-world-row><span class="world-row__mark">${icon("world")}</span><span class="world-row__copy"><span><strong>${escapeHtml(item.subject || "대상 미상")}</strong><em>${escapeHtml(worldPredicateLabel(item.predicate))}</em>${!isCurrent ? "<em>이전</em>" : ""}</span><p>${escapeHtml(listCopy)}</p><small>${item.valid_from_ordinal == null ? `revision ${Number(item.valid_from_revision ?? 0)}` : `#${Number(item.valid_from_ordinal)}부터${isCurrent ? " 현재" : ` #${Number(item.valid_to_ordinal ?? 0)}까지`}`}</small></span><span aria-hidden="true">›</span></button>`;
  };
  const list = kind === "assertions"
    ? entries.length ? `<div class="world-flat-list" data-world-group>${entries.map(row).join("")}</div>` : ""
    : [...grouped.entries()].map(([label, items]) => `<section class="world-group" data-world-group><header><strong>${escapeHtml(label)}</strong><span>${items.length}</span></header>${items.map(row).join("")}</section>`).join("");
  const filters = kind === "promises" ? [["open", "이행 전"], ["completed", "완료·종료"], ["all", "전체"]] : [["current", "현재"], ["history", "이전 기록"], ["all", "전체"]];
  const toolbar = `<div class="world-toolbar"><div class="world-search-line"><label class="world-search">${icon("search")}<input type="search" data-action="world-search" value="${escapeHtml(view.query)}" placeholder="${meta.search}" aria-label="${meta.title} 검색"></label>${kind === "beliefs" ? `<select class="world-holder" data-action="world-holder" aria-label="관점 인물"><option value="">모든 관점 인물</option>${holders.map((holder) => `<option value="${escapeHtml(holder)}" ${holder === view.holder ? "selected" : ""}>${escapeHtml(holder)}</option>`).join("")}</select>` : ""}</div><span class="world-toolbar__count" data-world-count>${visible.length}개</span><div class="world-filters" role="group" aria-label="${meta.title} 필터">${filters.map(([value, label]) => `<button type="button" data-action="world-filter" data-value="${value}" aria-pressed="${view.filter === value}">${label}</button>`).join("")}</div></div>`;
  const selectedEntry = entries.find((entry) => entry.key === view.selectedId);
  const selected = selectedEntry?.item;
  let detail = "";
  if (editor) detail = worldEditorPanel(data, editor);
  else if (selected) {
    const isCurrent = Boolean(selectedEntry?.current);
    const title = kind === "beliefs" ? `${selected.holder || "관점 미상"} → ${selected.subject || "대상 미상"}` : kind === "promises" ? `${selected.promisor || "미상"} → ${selected.promisee || "미상"}` : String(selected.subject || "대상 미상");
    const content = kind === "promises" ? selected.content : selected.value;
    const translationKey = selectedEntry.translationKey;
    const matchingHistory = kind === "beliefs" ? data.endedBeliefs.filter((item: any) => item.holder === selected.holder && item.subject === selected.subject && item.predicate === selected.predicate)
      : kind === "promises" ? data.promiseHistory.filter((item: any) => (selected.promise_key && item.promise_key === selected.promise_key) || item.id === selected.id)
        : data.endedAssertions.filter((item: any) => item.subject === selected.subject && item.predicate === selected.predicate);
    const matchingFact = kind === "beliefs" ? data.assertions.find((item: any) => item.subject === selected.subject && item.predicate === selected.predicate) : undefined;
    const metaGrid = kind === "beliefs"
      ? [["인식", worldPolarityLabels[selected.polarity] ?? selected.polarity ?? "—"], ["상태", worldBeliefStatusLabels[selected.status] ?? (isCurrent ? "현재" : "이전 인식")], ["확신도", worldConfidence(selected.confidence)]]
      : kind === "promises"
        ? [["상태", worldPromiseStatusLabels[selected.status] ?? selected.status ?? "—"], ["예정", selected.scheduled_for || "시점 미정"], ["기록 버전", `revision ${Number(selected.updated_revision ?? 0)}`]]
        : [["상태", isCurrent ? "현재" : "이전 기록"], ["확신도", worldConfidence(selected.confidence)], ["기록 시점", selected.valid_from_ordinal == null ? `revision ${Number(selected.valid_from_revision ?? 0)}` : `#${Number(selected.valid_from_ordinal)}`]];
    const canMutate = isCurrent && Boolean(selected.id);
    const actions = canMutate ? `<div class="world-reader__actions"><button class="btn btn--icon" type="button" data-action="edit-world" data-kind="${meta.itemKind}" data-id="${escapeHtml(selected.id)}" aria-label="수정" title="수정">${icon("edit")}</button><button class="btn btn--icon btn--danger" type="button" data-action="delete-world" data-kind="${meta.itemKind}" data-id="${escapeHtml(selected.id)}" aria-label="삭제" title="삭제">${icon("delete")}</button></div>` : "";
    const historyRows = matchingHistory.map((item: any, index: number) => `<div class="world-history-row"><small>${item.valid_from_ordinal == null ? `revision ${Number(item.created_revision ?? item.updated_revision ?? 0)}` : `#${Number(item.valid_from_ordinal)}`}</small><strong>${escapeHtml(kind === "promises" ? worldPromiseStatusLabels[item.status] ?? item.status : worldPredicateLabel(item.predicate))}</strong><p>${escapeHtml(kind === "promises" ? item.content : item.value)}</p></div>`).join("");
    const disclosures = historyRows ? `<div class="world-disclosures"><details class="world-disclosure"><summary>이전 기록 ${matchingHistory.length}개</summary><div>${historyRows}</div></details></div>` : "";
    detail = `<article class="world-reader"><header><button class="world-back" type="button" data-action="world-back" aria-label="목록으로">‹</button><div><span class="world-reader__kicker">${meta.title}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(kind === "promises" ? selected.scheduled_for || "시점 미정" : worldPredicateLabel(selected.predicate))}</p></div>${actions}</header><section class="world-copy">${bilingualCopy(content, translations.get(translationKey) ?? content, display)}${kind === "promises" && selected.status_reason ? `<small>${escapeHtml(selected.status_reason)}</small>` : ""}</section><dl class="world-meta">${metaGrid.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>${matchingFact ? `<section class="world-related"><span>현재 세계 상태</span><strong>${escapeHtml(matchingFact.value)}</strong></section>` : ""}${disclosures}</article>`;
  }
  const hasDetail = Boolean(detail);
  const tabs = `<div class="world-tabs" role="tablist" aria-label="세계 정보"><button role="tab" data-action="set-world-kind" data-kind="assertions" aria-selected="${kind === "assertions"}">세계 상태</button><button role="tab" data-action="set-world-kind" data-kind="beliefs" aria-selected="${kind === "beliefs"}">인물의 인식</button><button role="tab" data-action="set-world-kind" data-kind="promises" aria-selected="${kind === "promises"}">약속</button></div>`;
  const headerActions = `<button class="btn btn--icon" type="button" data-action="new-world" data-kind="${meta.itemKind}" aria-label="${meta.title} 추가" title="추가">${icon("add")}</button>`;
  return `<div class="world-page ${view.mobileDetail && hasDetail ? "is-mobile-detail" : ""}">${tabs}${pageHeader(meta.title, meta.description, headerActions)}<section class="world-workspace ${hasDetail ? "has-detail" : ""} ${view.mobileDetail && hasDetail ? "show-detail" : ""}"><div class="world-list">${toolbar}<div class="world-list__scroll" data-preserve-scroll="world-list">${list || '<div class="world-empty">표시할 기록이 없습니다.</div>'}<div class="world-empty" data-world-search-empty hidden>검색 결과가 없습니다.</div></div></div>${hasDetail ? `<div class="world-detail">${detail}</div>` : ""}</section></div>`;
}

interface ConflictPresentation {
  title: string;
  explanation: string;
  changes: string[];
  allowKeepExisting: boolean;
}

export function conflictCategory(kind: unknown): string {
  switch (kind) {
    case "assertion": return "세계 사실";
    case "unattributed_claim": return "인물 주장";
    case "belief_action_target":
    case "belief_user_override": return "인물 인식";
    case "temporal_boundary_review": return "약속";
    case "source_revision": return "원문 근거";
    case "static_projection_changed": return "캐릭터 설정";
    default: return "기타 충돌";
  }
}

const objectValue = (value: unknown): Record<string, any> => {
  const parsed = parseJson<Record<string, any> | null>(value, null);
  return parsed && typeof parsed === "object" ? parsed : {};
};

export function describeConflict(item: any): ConflictPresentation {
  const existing = objectValue(item.existing_json);
  const incoming = objectValue(item.incoming_json);
  if (item.kind === "static_projection_changed") {
    const structured = existing.schema === "static_projection_summary.v1" && incoming.schema === "static_projection_summary.v1";
    if (!structured) return {
      title: "캐릭터 카드·로어북 구성이 변경됨",
      explanation: "변경 기록의 구조를 읽을 수 없습니다. 현재 설정을 다시 동기화한 뒤 확인하세요.",
      changes: [],
      allowKeepExisting: false,
    };
    const changes: string[] = [];
    if (existing.characterName !== incoming.characterName) changes.push(`캐릭터명: ${existing.characterName || "없음"} → ${incoming.characterName || "없음"}`);
    if (existing.description?.hash !== incoming.description?.hash) {
      changes.push(`캐릭터 설명 변경: ${Number(existing.description?.characters ?? 0).toLocaleString()}자 → ${Number(incoming.description?.characters ?? 0).toLocaleString()}자`);
    }
    const oldLore = new Map<string, { hash?: string }>((existing.lore?.entries ?? []).map((entry: any) => [String(entry.title), entry]));
    const newLore = new Map<string, { hash?: string }>((incoming.lore?.entries ?? []).map((entry: any) => [String(entry.title), entry]));
    const added = [...newLore.keys()].filter((title) => !oldLore.has(title));
    const removed = [...oldLore.keys()].filter((title) => !newLore.has(title));
    const changed = [...newLore.keys()].filter((title) => oldLore.has(title) && oldLore.get(title)?.hash !== newLore.get(title)?.hash);
    if (added.length) changes.push(`로어북 추가 ${added.length}개: ${added.slice(0, 5).join(", ")}${added.length > 5 ? " 외" : ""}`);
    if (removed.length) changes.push(`로어북 제거 ${removed.length}개: ${removed.slice(0, 5).join(", ")}${removed.length > 5 ? " 외" : ""}`);
    if (changed.length) changes.push(`로어북 내용 변경 ${changed.length}개: ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? " 외" : ""}`);
    return {
      title: "캐릭터 카드·로어북 구성이 변경됨",
      explanation: "이미 생성된 기억의 해석 기준이 달라질 수 있어 자동으로 덮어쓰지 않고 검토 대상으로 남겼습니다. Risu 원문은 변경하지 않습니다.",
      changes: changes.length ? changes : ["구성 식별값이 변경됐지만 요약 가능한 항목 차이는 없습니다."],
      allowKeepExisting: false,
    };
  }
  if (item.kind === "assertion" || item.kind === "unattributed_claim") {
    return {
      title: item.kind === "assertion" ? "세계 상태 후보가 기존 사실과 충돌함" : "정본으로 확정되지 않은 새 주장이 들어옴",
      explanation: item.kind === "unattributed_claim"
        ? "보조 모델이 이를 등장인물의 주장으로 분류해 사실로 자동 확정하지 않았습니다. 근거를 확인한 뒤 채택하거나 폐기하세요."
        : "새 후보는 아직 세계 상태 장부에 저장되지 않았습니다. 근거를 확인한 뒤 채택하거나 폐기하세요.",
      changes: [
        `기존 값: ${existing.value ?? "기록 없음"}`,
        `새 후보: ${incoming.subject && incoming.predicate ? `${incoming.subject}.${incoming.predicate} = ` : ""}${incoming.value ?? "알 수 없음"}`,
      ],
      allowKeepExisting: true,
    };
  }
  if (item.kind === "belief_action_target") return {
    title: "인물 인식의 변경 대상을 찾지 못함",
    explanation: "새 인식이 어떤 기존 인식 기록을 강화하거나 대체해야 하는지 확정할 수 없어 자동 반영하지 않았습니다.",
    changes: [
      `관점 인물: ${incoming.holder ?? "알 수 없음"}`,
      `대상: ${incoming.subject ?? "알 수 없음"}`,
      `새 후보: ${incoming.value ?? "알 수 없음"}`,
    ],
    allowKeepExisting: true,
  };
  if (item.kind === "belief_user_override") return {
    title: "사용자가 수정한 인물 인식과 새 후보가 충돌함",
    explanation: "사용자가 직접 고친 인식을 보조 모델의 새 후보로 덮어쓰지 않고 확인 대상으로 남겼습니다.",
    changes: [
      `현재 인식: ${existing.value ?? "기록 없음"}`,
      `새 후보: ${incoming.value ?? "알 수 없음"}`,
    ],
    allowKeepExisting: true,
  };
  if (item.kind === "temporal_boundary_review") return {
    title: "분기 시점의 약속 상태를 확인해야 함",
    explanation: "채팅 분기 시점에 이 약속이 이미 만들어졌는지 확정할 근거가 부족해 자동으로 상속하지 않았습니다.",
    changes: [
      `약속: ${incoming.promisor ?? "미상"} → ${incoming.promisee ?? "미상"}`,
      `내용: ${incoming.content ?? "알 수 없음"}`,
      `기존 상태: ${incoming.status ?? "알 수 없음"}`,
    ],
    allowKeepExisting: false,
  };
  if (item.kind === "source_revision") return {
    title: "근거 원문이 수정되거나 삭제됨",
    explanation: "같은 메시지 ID에서 RCM이 읽은 본문이 달라져, 이전 본문을 근거로 만든 기억을 비활성화했습니다. 직접 편집뿐 아니라 번역 플러그인이 화면 본문과 모델용 본문을 교체할 때도 발생할 수 있습니다.",
    changes: [`영향받은 기억 ${Array.isArray(existing.memoryIds) ? existing.memoryIds.length : 0}개`, `처리 이유: ${incoming.reason ?? "원문 변경"}`],
    allowKeepExisting: false,
  };
  return {
    title: "분류되지 않은 기록 충돌",
    explanation: "기존 데이터와 새 후보가 일치하지 않아 자동 반영하지 않았습니다.",
    changes: [],
    allowKeepExisting: true,
  };
}

function conflicts(data: DashboardData): string {
  const rows = data.conflicts.map((item) => {
    const view = describeConflict(item);
    const category = conflictCategory(item.kind);
    const technical = `<details class="technical"><summary>기술 세부정보</summary><pre class="packet">existing: ${escapeHtml(item.existing_json)}\nincoming: ${escapeHtml(item.incoming_json)}</pre></details>`;
    const assertionConflict = item.kind === "assertion" || item.kind === "unattributed_claim";
    const resolutionLabel = item.resolution === "accept_incoming" || (assertionConflict && item.resolution === "acknowledged")
      ? "새 사실로 채택됨"
      : item.resolution === "keep_existing" ? "후보 폐기됨" : "확인됨";
    const actions = item.status === "pending"
      ? assertionConflict
        ? `<span class="actions"><button class="btn" data-action="resolve-conflict" data-id="${escapeHtml(item.id)}" data-resolution="keep_existing">후보 폐기</button><button class="btn btn--primary" data-action="resolve-conflict" data-id="${escapeHtml(item.id)}" data-resolution="accept_incoming">새 사실로 채택</button></span>`
        : `<span class="actions">${view.allowKeepExisting ? `<button class="btn" data-action="resolve-conflict" data-id="${escapeHtml(item.id)}" data-resolution="keep_existing">기존 값 유지</button>` : ""}<button class="btn btn--primary" data-action="resolve-conflict" data-id="${escapeHtml(item.id)}" data-resolution="acknowledged">${item.kind === "static_projection_changed" ? "변경 확인" : "확인 완료"}</button></span>`
      : `<span class="actions"><button class="btn btn--danger" data-action="delete-conflict" data-id="${escapeHtml(item.id)}">삭제</button></span>`;
    return `<article class="row"><span class="row__top"><strong>${escapeHtml(view.title)}</strong>${status(item.status === "pending" ? "warn" : "ok", item.status === "pending" ? "검토 필요" : resolutionLabel)}</span><span class="row__meta"><span class="attention-type">${escapeHtml(category)}</span><span>revision ${item.created_revision}</span><span>${formatTime(item.created_at)}</span></span><span class="row__body">${escapeHtml(view.explanation)}</span>${view.changes.length ? `<ul class="change-list">${view.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>` : ""}${technical}${actions}</article>`;
  }).join("");
  return `${pageHeader("Conflicts", "원인 없는 덮어쓰기를 막고 사용자 검토 결과를 기록합니다.")}<section class="panel"><div class="rows">${rows || '<div class="empty">검토할 충돌이 없습니다.</div>'}</div></section>`;
}

type AttentionItem = { id: string; type: Exclude<AttentionFilter, "all">; title: string; summary: string; time: unknown; value: any; category?: string };

export function attentionPage(data: DashboardData, translations: TranslationView, display: RuntimeState["settings"]["translationDisplay"], view: AttentionViewState): string {
  const audits: AttentionItem[] = data.extractionAudits
    .filter((item) => item.status === "pending_review" || item.status === "failed")
    .map((item) => ({
      id: `audit:${item.id}`, type: "audit", title: item.evidenceReview?.blocking === false ? "일부 발췌 보류 · 기억 처리 계속" : "상태 확인 필요 · 후속 기억 처리 보류",
      summary: `저장된 기억 ${Number(item.evidenceReview?.appliedMemories ?? 0)}개 · 확인할 근거 ${item.evidenceReview?.issues?.length ?? 0}개`,
      time: item.updatedAt, value: item,
    }));
  const duplicates: AttentionItem[] = data.reconciliationReviews.filter((item) => item.status === "pending").map((item) => ({
    id: `duplicate:${item.id}`, type: "duplicate", title: String(item.incoming?.content ?? item.incoming?.value ?? item.itemRef ?? "상태 후보"),
    summary: String(item.decision?.reason || item.error || "사용자가 관리한 기존 상태와 새 관측을 함께 확인해야 합니다."), time: item.createdAt, value: item,
    category: item.itemKind === "world_fact" ? "세계 사실" : item.itemKind === "character_belief" ? "인물의 인식" : item.itemKind === "promise_event" ? "약속" : "상태",
  }));
  const conflictsPending: AttentionItem[] = data.conflicts.filter((item) => item.status === "pending").map((item) => {
    const presentation = describeConflict(item);
    return { id: `conflict:${item.id}`, type: "conflict", title: presentation.title, summary: presentation.explanation, time: item.created_at, value: item, category: conflictCategory(item.kind) };
  });
  const all = [...audits, ...duplicates, ...conflictsPending].sort((left, right) => Number(right.time ?? 0) - Number(left.time ?? 0));
  const visible = view.filter === "all" ? all : all.filter((item) => item.type === view.filter);
  const selected = visible.find((item) => item.id === view.selectedId) ?? visible[0];
  const labels: Record<AttentionItem["type"], string> = { audit: "재검수", duplicate: "상태 확인", conflict: "충돌" };
  const marks: Record<AttentionItem["type"], string> = { audit: "refresh", duplicate: "reviews", conflict: "conflicts" };
  const count = (type: AttentionFilter) => type === "all" ? all.length : all.filter((item) => item.type === type).length;
  const filters: Array<[AttentionFilter, string]> = [["all", "전체"], ["duplicate", "상태 확인"], ["conflict", "충돌"], ["audit", "재검수"]];
  const rows = visible.map((item) => `<button class="attention-row ${item.id === selected?.id ? "is-selected" : ""}" type="button" data-action="select-attention" data-id="${escapeHtml(item.id)}" data-attention-row><span class="attention-mark">${icon(marks[item.type])}</span><span class="attention-row-copy"><span><em class="attention-type">${escapeHtml(item.category ?? labels[item.type])}</em><time>${formatRelativeTime(item.time)}</time></span><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.summary)}</p></span><span aria-hidden="true">›</span></button>`).join("");
  let detail = '<div class="empty">확인이 필요한 항목이 없습니다.</div>';
  if (selected?.type === "audit") {
    const item = selected.value, draft = item.draft ?? {};
    const counts = `기억 ${(draft.memories ?? []).length}개 · 상태 후보 ${(draft.stateObservations ?? []).length}개`;
    const ordinals = (item.evidenceReview?.sourceMessages ?? []).map((source: any) => Number(source.ordinal) + 1);
    const sourceRange = ordinals.length ? `${Math.min(...ordinals)}–${Math.max(...ordinals)}번째 메시지` : `${(item.sourceMessageIds ?? []).length}개 메시지`;
    detail = `<article class="attention-detail"><header class="attention-detail-head"><button class="attention-back" type="button" data-action="attention-back" aria-label="목록으로">‹</button><div><span class="attention-type">재검수</span><h2>${escapeHtml(selected.title)}</h2><p>${item.evidenceReview?.blocking === false ? "확인되지 않은 발췌만 제외했어요. 기억과 후속 처리는 계속 사용할 수 있어요." : "미해결 후보는 보존되어 있어요. 마지막 확정 기억으로 대화를 계속할 수 있어요."}</p></div></header><div class="attention-detail-body">${!item.evidenceReview?.issues?.length && item.error ? `<section class="attention-error" role="alert">${icon("error")}<div><strong>재검수 요청 실패</strong><p>${escapeHtml(item.error)}</p></div></section>` : ""}<dl class="attention-facts"><div><dt>원문 범위</dt><dd>${escapeHtml(sourceRange)}</dd></div><div><dt>적용된 기억</dt><dd>${Number(item.evidenceReview?.appliedMemories ?? 0)}개</dd></div><div><dt>보존된 초안</dt><dd>${escapeHtml(counts)}</dd></div><div><dt>시도</dt><dd>${Number(item.attempts ?? 1)}회</dd></div></dl>${renderEvidenceIssues(item)}<details class="technical"><summary>기술 세부정보</summary><pre class="packet">${escapeHtml(JSON.stringify(draft, null, 2))}</pre></details></div><footer class="attention-decision"><button class="btn btn--primary" data-action="retry-extraction-audit" data-id="${escapeHtml(item.id)}">${icon("refresh")} 다시 확인 · 보조 모델 호출</button></footer></article>`;
  } else if (selected?.type === "duplicate") {
    const item = selected.value, incoming = item.incoming ?? {};
    const stateKind = item.itemKind === "world_fact" ? "세계 사실" : item.itemKind === "character_belief" ? "인물의 인식" : item.itemKind === "promise_event" ? "약속" : "상태";
    const target = item.candidates.find((candidate: any) => candidate.id === item.decision?.targetId) ?? item.candidates[0];
    const canonical = incoming.content ?? incoming.value ?? incoming.title ?? JSON.stringify(incoming);
    const candidateCopy = target?.value?.content ?? target?.value?.value ?? target?.value?.title ?? "비교할 기존 항목이 없습니다.";
    const incomingTranslation = translations.get(`reconciliation:${item.id}:incoming`), candidateTranslation = translations.get(`reconciliation:${item.id}:candidate`);
    const reference = (id: string, value?: string) => display === "en" ? "" : `<small class="reference-translation" data-translation-id="${escapeHtml(id)}">한국어 참고 · ${escapeHtml(value ?? "번역 준비 중")}</small>`;
    const editFields = item.itemKind === "memory"
      ? `<label class="field"><span>제목</span><input name="canonicalTitle" value="${escapeHtml(incoming.title ?? "")}"></label><label class="field"><span>내용</span><textarea name="canonicalContent">${escapeHtml(incoming.content ?? "")}</textarea></label>`
      : `<label class="field"><span>내용</span><textarea name="canonicalValue">${escapeHtml(incoming.value ?? incoming.content ?? "")}</textarea></label>`;
    const mergeLabel = item.itemKind === "promise_event" ? "기존 약속에 반영" : "기존 상태에 근거 추가";
    const distinctLabel = item.itemKind === "promise_event" ? "별도 약속으로 보존" : "별도 상태로 보존";
    detail = `<article class="attention-detail"><header class="attention-detail-head"><button class="attention-back" type="button" data-action="attention-back" aria-label="목록으로">‹</button><div><span class="attention-type">${stateKind}</span><h2>${escapeHtml(selected.title)}</h2><p>${escapeHtml(selected.summary)}</p></div></header><div class="attention-detail-body"><div class="attention-compare"><section><h3>새 관측</h3><p>${escapeHtml(canonical)}</p>${reference(`reconciliation:${item.id}:incoming`, incomingTranslation)}</section><section><h3>기존 상태</h3><p>${escapeHtml(candidateCopy)}</p>${reference(`reconciliation:${item.id}:candidate`, candidateTranslation)}</section></div><details class="attention-editor"><summary><span>새 상태 내용 편집</span><span aria-hidden="true">›</span></summary><form class="reconciliation-edit" data-review-id="${escapeHtml(item.id)}">${editFields}<p class="attention-editor__hint">편집한 내용은 선택한 상태 처리에만 적용됩니다.</p></form></details></div><footer class="attention-decision"><button class="btn btn--primary" data-action="resolve-reconciliation" data-resolution="merge" data-id="${escapeHtml(item.id)}" data-target-id="${escapeHtml(target?.id ?? "")}" ${target ? "" : "disabled"}>${mergeLabel}</button><button class="btn" data-action="resolve-reconciliation" data-resolution="distinct" data-id="${escapeHtml(item.id)}">${distinctLabel}</button><button class="btn" data-action="resolve-reconciliation" data-resolution="update" data-id="${escapeHtml(item.id)}" data-target-id="${escapeHtml(target?.id ?? "")}" ${target ? "" : "disabled"}>새 상태로 갱신</button><button class="btn btn--danger" data-action="resolve-reconciliation" data-resolution="discard" data-id="${escapeHtml(item.id)}">후보 폐기</button></footer></article>`;
  } else if (selected?.type === "conflict") {
    const item = selected.value, presentation = describeConflict(item);
    const assertionConflict = item.kind === "assertion" || item.kind === "unattributed_claim";
    const actions = assertionConflict
      ? `<button class="btn btn--primary" data-action="resolve-conflict" data-id="${escapeHtml(item.id)}" data-resolution="accept_incoming">새 사실로 채택</button><button class="btn btn--danger" data-action="resolve-conflict" data-id="${escapeHtml(item.id)}" data-resolution="keep_existing">후보 폐기</button>`
      : `${presentation.allowKeepExisting ? `<button class="btn" data-action="resolve-conflict" data-id="${escapeHtml(item.id)}" data-resolution="keep_existing">기존 값 유지</button>` : ""}<button class="btn btn--primary" data-action="resolve-conflict" data-id="${escapeHtml(item.id)}" data-resolution="acknowledged">${item.kind === "static_projection_changed" ? "변경 확인" : "확인 완료"}</button>`;
    detail = `<article class="attention-detail"><header class="attention-detail-head"><button class="attention-back" type="button" data-action="attention-back" aria-label="목록으로">‹</button><div><span class="attention-type">${escapeHtml(conflictCategory(item.kind))}</span><h2>${escapeHtml(presentation.title)}</h2><p>${escapeHtml(presentation.explanation)}</p></div></header><div class="attention-detail-body">${presentation.changes.length ? `<section><h3>달라진 내용</h3><ul class="change-list">${presentation.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul></section>` : ""}<details class="technical"><summary>기술 세부정보</summary><pre class="packet">existing: ${escapeHtml(item.existing_json)}\nincoming: ${escapeHtml(item.incoming_json)}</pre></details></div><footer class="attention-decision">${actions}</footer></article>`;
  }
  return `<section class="management-page attention-page ${view.mobileDetail && selected ? "is-mobile-detail" : ""}">${pageHeader("상태 확인", "RCM이 자동으로 바꾸지 않은 상태와 충돌만 모았습니다.")}<div class="attention-workspace"><div class="attention-list-pane"><div class="attention-toolbar"><label class="attention-search">${icon("search")}<input type="search" data-action="attention-search" value="${escapeHtml(view.query)}" placeholder="제목과 내용 검색"></label><span class="attention-toolbar__count">${visible.length}개</span><div class="attention-filters" role="group" aria-label="확인 항목 필터">${filters.map(([key, label]) => `<button type="button" data-action="attention-filter" data-filter="${key}" aria-pressed="${view.filter === key}">${label} · ${count(key)}</button>`).join("")}</div></div><div class="attention-list" data-preserve-scroll="attention-list">${rows || '<div class="empty">이 필터에는 확인할 항목이 없습니다.</div>'}<div class="empty" data-attention-search-empty hidden>검색 결과가 없습니다.</div></div></div>${detail}</div></section>`;
}

export function operations(state: RuntimeState, data: DashboardData): string {
  const serverMode = state.settings.extractionEngine === "server";
  const chatEnabled = state.current ? isChatMemoryEnabled(state.settings, state.current.chatId) : false;
  const serverWorker = data.health?.serverWorker ?? state.serverWorker;
  const failedCount = data.jobs.filter((job) => job.status === "failed").length;
  const removableCount = data.jobs.filter((job) => ["queued", "failed"].includes(job.status) || (job.status === "leased" && Number(job.leased_until) < Date.now())).length;
  const jobTypeLabels: Record<string, string> = {
    extract: "대화 기억 정리", extract_episode: "대화 기억 정리", episode: "대화 기억 정리",
    project_relationship: "관계 상태 갱신", relationship_projection: "관계 상태 갱신",
    story_consolidation: "줄거리 갱신", initial_calibration: "초기 인물 설정",
    embed: "검색 색인 갱신", social_knowledge: "지인 관계 정리", social_backfill: "지인 관계 다시 찾기",
    audit_retry: "추출 재검수",
    ledger_consistency: "최종 장부 대조",
  };
  const jobStatusLabels: Record<string, string> = { queued: "대기 중", leased: "처리 중", failed: "실패", completed: "완료", done: "완료", cancelled: "취소됨", superseded: "교체됨" };
  const stageLabels: Record<string, string> = { queued: "대기", retrying: "자동 재시도", initial_calibration: "초기 인물 설정", first_extraction: "1차 기억 추출", post_extraction_audit: "추출 재검수", state_reconciliation: "세계·인식·약속 대조", ledger_consistency: "최종 장부 대조", relationship_projection: "관계 상태 투영", story_consolidation: "줄거리 갱신", storing: "기억 반영", complete: "전체 단계 완료", failed: "단계 실패" };
  const jobRow = (job: any) => {
    const payload = parseJson<Record<string, unknown>>(job.payload_json, {});
    const sourceRecovery = payload.sourceRecovery === true;
    const stage = String(payload.pipelineStage ?? (job.status === "queued" ? "queued" : ""));
    const stageLabel = sourceRecovery && stage === "post_extraction_audit" ? "원문 발췌 보완" : stageLabels[stage];
    const stageCopy = stageLabel ? ` · ${stageLabel}` : "";
    const callStats = payload.llmCallStats as { total?: number; repairs?: number } | undefined;
    const repairCount = Number(callStats?.repairs ?? payload.pipelineRepairCount ?? 0);
    const repairCopy = repairCount > 0 ? ` (보완 ${repairCount}회 포함)` : "";
    const callCopy = Number(callStats?.total ?? 0) > 0 ? ` · 보조 모델 호출 총 ${Number(callStats!.total)}회${repairCopy}` : "";
    const estimatedInput = Number(payload.estimatedInputTokens ?? 0);
    const plannedParts = Number(payload.plannedParts ?? 0);
    const inputBudget = (payload.auxiliaryBudget as { maxInputTokens?: number } | undefined)?.maxInputTokens;
    const sourceMessages = Array.isArray(payload.sourceMessageIds) ? payload.sourceMessageIds.length : 0;
    const planCopy = [sourceMessages ? `원문 ${sourceMessages}개` : "", plannedParts ? `계획 ${plannedParts}단계` : "",
      estimatedInput ? `예상 입력 ${estimatedInput.toLocaleString()}${inputBudget ? ` / ${inputBudget.toLocaleString()}` : ""}토큰` : ""].filter(Boolean).join(" · ");
    const usage = payload.llmUsage as { inputTokens?: number; outputTokens?: number; callsWithUsage?: number } | undefined;
    const usageCopy = Number(usage?.callsWithUsage ?? 0) > 0
      ? ` · 실제 입력 ${Number(usage!.inputTokens ?? 0).toLocaleString()} / 출력 ${Number(usage!.outputTokens ?? 0).toLocaleString()}토큰 (${usage!.callsWithUsage}회 보고)`
      : Number(callStats?.total ?? 0) > 0 ? " · 실제 토큰 사용량 미제공" : "";
    const retryCopy = stage === "retrying" ? ` · 재시도 ${Number(payload.pipelineRetryAttempt ?? job.attempts + 1)}/${Number(payload.pipelineMaxAttempts ?? 3)}` : "";
    const ordinal = Number(payload.operationStageOrdinal ?? 0), total = Number(payload.operationStageTotal ?? 0);
    const title = `${sourceRecovery ? "원문 발췌 보완" : jobTypeLabels[job.type] ?? String(job.type).replaceAll("_", " ")}${ordinal > 0 && total > 0 ? ` ${ordinal}/${total}` : ""}`;
    return `<article class="operation-row"><span class="operation-label is-${escapeHtml(stage === "retrying" ? "retrying" : job.status)}">${escapeHtml(stage === "retrying" ? "재시도" : jobStatusLabels[job.status] ?? job.status)}</span><div><strong>${escapeHtml(title)}</strong><p>${job.attempts ? `${job.attempts}회 시도` : "아직 시도하지 않음"}${escapeHtml(stageCopy)}${escapeHtml(retryCopy)}${escapeHtml(callCopy)}${escapeHtml(usageCopy)}${planCopy ? ` · ${escapeHtml(planCopy)}` : ""}${job.last_error ? ` · ${escapeHtml(job.last_error)}` : ""}</p></div><time>${formatRelativeTime(job.updated_at)}</time><span></span></article>`;
  };
  const currentRunId = data.coldStartProgress?.acknowledged ? undefined : data.coldStartProgress?.backfillRunId;
  const currentJobs = currentRunId ? data.jobs.filter((job) => parseJson<Record<string, unknown>>(job.payload_json, {}).backfillRunId === currentRunId) : [];
  const stageOrder: Record<string, number> = { initial_calibration: 0, extraction: 1, ledger_consistency: 2, relationship_projection: 3, story_consolidation: 4 };
  currentJobs.sort((left, right) => {
    const leftPayload = parseJson<Record<string, unknown>>(left.payload_json, {}), rightPayload = parseJson<Record<string, unknown>>(right.payload_json, {});
    return (stageOrder[String(leftPayload.operationStage ?? "")] ?? 9) - (stageOrder[String(rightPayload.operationStage ?? "")] ?? 9)
      || Number(leftPayload.operationStageOrdinal ?? 0) - Number(rightPayload.operationStageOrdinal ?? 0)
      || Number(left.created_at) - Number(right.created_at);
  });
  const historyJobs = data.jobs.filter((job) => !currentJobs.includes(job)).sort((left, right) => Number(right.updated_at) - Number(left.updated_at));
  const unresolvedJobs = historyJobs.filter((job) => ["queued", "leased", "failed"].includes(job.status));
  const completedJobs = historyJobs.filter((job) => !unresolvedJobs.includes(job));
  const visibleCurrent = [...currentJobs, ...unresolvedJobs, ...(!currentJobs.length && !unresolvedJobs.length ? completedJobs.slice(0, 10) : [])].map(jobRow).join("");
  const archivedCompleted = !currentJobs.length && !unresolvedJobs.length ? completedJobs.slice(10) : completedJobs;
  const older = archivedCompleted.map(jobRow).join("");
  const jobs = `${visibleCurrent}${older ? `<details class="operation-history" data-preserve-open="operation-history"><summary>완료된 작업 ${archivedCompleted.length}개</summary><div>${older}</div></details>` : ""}`;
  const logs = state.logs.map((log) => `<div class="log"><span>${formatTime(log.at)}</span><span class="log__level log__level--${log.level}">${log.level}</span><span>${escapeHtml(log.message)}</span></div>`).join("");
  const workerAction = state.settings.workerPaused
    ? '<button class="btn btn--primary" data-action="resume-worker">처리 재개</button>'
    : `<button class="btn" data-action="pause-worker">${serverMode ? "즉시 일시정지" : "현재 호출 후 일시정지"}</button>`;
  const drainAction = !serverMode && !state.settings.workerPaused && !state.workerBusy && data.jobs.some((job) => job.status === "queued")
    ? '<button class="btn btn--primary" data-action="drain-worker">지금 처리</button>'
    : "";
  const workerState = serverMode
    ? serverWorker?.state === "running"
      ? `서버 처리 중 · 활성 호출 ${serverWorker.activeCalls}개${serverWorker.controlLeaseUntil ? ` · 제어권 ${formatTime(serverWorker.controlLeaseUntil)}까지` : ""}`
      : serverWorker?.state === "faulted" ? `서버 오류로 중단 · ${serverWorker.lastError ?? "원인 미상"}`
        : state.settings.workerPaused ? "서버 일시정지됨 — 진행 중 HTTP 요청을 취소하고 새 호출을 시작하지 않습니다."
          : "서버 대기 중 · Risu 제어권이 유지되는 동안만 대기열을 처리합니다."
    : state.currentJob
    ? `진행 중 · 시도 ${state.currentJob.attempt}/3 · ${state.currentJob.sourceMessageCount}개 메시지 · ${formatTime(state.currentJob.startedAt)}`
    : state.settings.workerPaused ? "일시정지됨 — 명시적으로 재개할 때까지 LLM 작업을 lease하지 않습니다." : state.workerBusy ? "다음 작업을 확인하는 중" : "대기 중";
  const retryAction = failedCount ? `<button class="btn" data-action="retry-failed" ${chatEnabled ? "" : "disabled"}>실패 ${failedCount}건 재시도 준비</button>` : "";
  const deleteAction = removableCount ? `<button class="btn btn--danger" data-action="delete-queue">대기열 ${removableCount}건 삭제</button>` : "";
  const completedCount = data.jobs.filter((job) => ["done", "completed", "cancelled", "superseded"].includes(job.status)).length;
  const activeJobCount = data.jobs.filter((job) => ["queued", "leased", "failed"].includes(job.status)).length;
  const clearCompletedAction = completedCount ? `<button class="btn" data-action="clear-completed-jobs">완료 기록 ${completedCount}건 정리</button>` : "";
  const restoreAction = data.cancelledMessages ? `<button class="btn" data-action="restore-cancelled" ${chatEnabled ? "" : "disabled"}>취소 원문 ${data.cancelledMessages}건 복구</button>` : "";
  const serverUnavailable = !data.health?.ok;
  const workerFaulted = serverMode && serverWorker?.state === "faulted";
  const operationTone = state.settings.workerPaused ? "is-paused" : serverUnavailable || workerFaulted ? "is-error" : (serverMode ? serverWorker?.state === "running" : state.workerBusy) ? "is-running" : "is-idle";
  const operationTitle = state.settings.workerPaused ? "일시정지됨" : serverUnavailable ? "서버 연결 확인 필요" : workerFaulted ? "처리 오류" : (serverMode ? serverWorker?.state === "running" : state.workerBusy) ? "기억 처리 중" : "정상 작동";
  const operationCopy = serverUnavailable ? (data.error || "RCM 서버 상태를 확인할 수 없습니다.") : workerState;
  const progress = data.coldStartProgress;
  const operationActions = `${workerAction}${drainAction}${retryAction}${deleteAction}${clearCompletedAction}${restoreAction}`;
  const pageActions = `<div class="operations-actions-desktop">${operationActions}</div><details class="record-menu record-menu--icon operations-actions-mobile"><summary class="btn btn--icon" aria-label="처리 작업" title="처리 작업">${icon("more")}</summary><div class="record-menu__items">${operationActions}</div></details>`;
  // Acknowledgement is the durable dismissal boundary for one finished backfill run.
  // Completed jobs may later be archived from the operation ledger; that must not
  // resurrect an already dismissed card if an older server reports partial counts.
  const progressActive = Boolean(progress?.backfillRunId && (!progress.acknowledged || !progress.runComplete));
  const phaseStatus = (label: string, stateLabel: string, tone: "wait" | "run" | "done" | "warn") => `<span class="operation-phase is-${tone}"><small>${label}</small><strong>${stateLabel}</strong></span>`;
  const extractionState = progress && progress.failedGroups > 0 ? ["일부 실패", "warn"] as const : progress && progress.processedGroups >= progress.totalGroups ? ["완료", "done"] as const : ["진행", "run"] as const;
  const ledgerState = (progress?.ledgerFailed ?? 0) > 0 && !progress?.downstreamWaiting ? ["일부 실패", "warn"] as const : progress?.downstreamWaiting
    ? ((progress.ledgerTotal ?? 0) > 0 ? [`${progress.ledgerProcessed ?? 0}/${progress.ledgerTotal}`, "run"] as const : ["대기", "wait"] as const)
    : (progress?.ledgerTotal ?? 0) > 0 ? [(progress!.ledgerProcessed ?? 0) >= progress!.ledgerTotal! ? "완료" : `${progress!.ledgerProcessed ?? 0}/${progress!.ledgerTotal}`, (progress!.ledgerProcessed ?? 0) >= progress!.ledgerTotal! ? "done" : "run"] as const : ["대기", "wait"] as const;
  const relationshipState = progress?.downstreamWaiting ? ["대기", "wait"] as const : (progress?.relationshipFailed ?? 0) > 0 ? [`${progress?.relationshipProcessed ?? 0}/${progress?.relationshipTotal ?? 0} · 일부 실패`, "warn"] as const : progress && progress.pendingRelationshipPairs + progress.pendingRelationshipProjectionJobs > 0 ? [`${progress.relationshipProcessed ?? 0}/${progress.relationshipTotal ?? 0} · 진행`, "run"] as const : ["완료", "done"] as const;
  const storyState = progress?.downstreamWaiting ? ["대기", "wait"] as const : (progress?.storyFailed ?? 0) > 0 ? [`${progress?.storyProcessed ?? 0}/${progress?.storyTotal ?? 0} · 일부 실패`, "warn"] as const : (progress?.storyPending ?? 0) > 0 ? [`${progress?.storyProcessed ?? 0}/${progress?.storyTotal ?? 0} · 진행`, "run"] as const : ["완료", "done"] as const;
  const retryStatus = progress?.retryAttempt ? ` · 재시도 ${progress.retryAttempt}/${progress.retryMax ?? 3}` : "";
  const advisoryCount = (progress?.ledgerFailed ?? 0) + (progress?.relationshipFailed ?? 0) + (progress?.storyFailed ?? 0);
  const terminal = Boolean(progress?.runComplete);
  const panelTone = terminal ? advisoryCount > 0 || (progress?.failedGroups ?? 0) > 0 ? "warn" : "done" : "run";
  const callSummary = `보조 모델 호출 총 ${progress?.llmCalls ?? 0}회${(progress?.repairCalls ?? 0) > 0 ? ` (보완 ${progress!.repairCalls}회 포함)` : ""}`;
  const progressPanel = progressActive ? `<section class="operation-progress is-${panelTone}"><header><span class="operation-dot is-${panelTone === "run" ? "running" : panelTone === "warn" ? "paused" : "idle"}"></span><div><strong>${terminal ? `과거 대화 기억 생성 완료${advisoryCount > 0 || progress!.failedGroups > 0 ? " · 일부 정리 필요" : ""}` : "과거 대화 기억 생성"}</strong><p>대화 기억 정리 ${progress!.processedGroups}/${progress!.totalGroups}${progress!.activeStage && stageLabels[progress!.activeStage] ? ` · 현재: ${escapeHtml(stageLabels[progress!.activeStage]!)}` : ""}${escapeHtml(retryStatus)} · ${callSummary}</p></div><b>${progress!.processedGroups}/${progress!.totalGroups}</b></header><div>${phaseStatus("대화 기억 정리", `${progress!.processedGroups}/${progress!.totalGroups} · ${extractionState[0]}`, extractionState[1])}${phaseStatus("마지막 장부 대조", ledgerState[0], ledgerState[1])}${phaseStatus("관계 상태", relationshipState[0], relationshipState[1])}${phaseStatus("줄거리", storyState[0], storyState[1])}<span><small>기억 / 세부</small><strong>${progress!.memories} / ${progress!.details}</strong></span><span><small>최종 실패</small><strong>${progress!.failedGroups + advisoryCount}</strong></span></div>${terminal && !progress!.acknowledged ? `<footer>${advisoryCount > 0 || progress!.failedGroups > 0 ? `<button class="btn" data-action="retry-failed">실패 작업 다시 시도</button>` : ""}<button class="btn btn--primary" data-action="acknowledge-backfill" data-run-id="${escapeHtml(progress!.backfillRunId!)}">확인</button></footer>` : ""}</section>` : "";
  return `<section class="management-page operations-page" data-preserve-scroll="operations-page">${pageHeader("처리 상태", "기억 처리와 실패한 작업을 확인합니다.", pageActions)}
    ${state.episodeActivity?.status === 'holding' ? `<section class="panel"><h3>이전 수동 보류가 남아 있어</h3><p>기억 정리에서 보류를 해제할 수 있어. 이미 처리된 기억은 그대로 유지돼.</p><button class="btn" data-action="organization-open">기억 정리 열기</button></section>` : ''}
    ${workerAttentionNotice(state)}
    ${progressPanel}
    <div class="operation-state"><span class="operation-dot ${operationTone}"></span><div><strong>${operationTitle}</strong><p>${escapeHtml(operationCopy)}</p></div><span>${activeJobCount ? `진행 ${activeJobCount}개` : completedCount ? `완료 기록 ${completedCount}개` : "대기열 비어 있음"}</span></div>
    <section class="operation-section"><header><h2>작업 내역</h2><span>${data.jobsError ? "확인 불가" : `${data.jobs.length}건`}</span></header><div class="operation-ledger">${jobs || `<div class="empty">${data.jobsError ? "서버 연결 실패로 작업 목록을 확인할 수 없습니다." : "처리할 작업이 없습니다."}</div>`}</div></section>
    ${typeof __RCM_DISTRIBUTION__ === "undefined" || !__RCM_DISTRIBUTION__ ? `<details class="diagnostic-section"><summary>${icon("settings")}<strong>고급 진단</strong><small>작업 내역과 이 기기의 플러그인 기록</small><span aria-hidden="true">›</span></summary><div><h3>플러그인 기록</h3>${logs || '<div class="empty">런타임 로그가 없습니다.</div>'}</div></details>` : ""}</section>`;
}

export function acknowledgeBackfillLocally(data: DashboardData, runId: string): boolean {
  if (!data.coldStartProgress || data.coldStartProgress.backfillRunId !== runId) return false;
  data.coldStartProgress.acknowledged = true;
  return true;
}

const normalizeBotName = (value: unknown): string => String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();

export async function readHostChatInventory(): Promise<HostChatInventoryItem[]> {
  const database = await risuai.getDatabase(["characters"]);
  if (!database || !("characters" in database)) throw new Error("Risu 채팅 목록 권한을 사용할 수 없습니다");
  const raw = database?.characters;
  const characters = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  const items: HostChatInventoryItem[] = [];
  for (const [index, character] of characters.entries()) {
    if (!character || typeof character !== "object") continue;
    const characterId = String((character as any).chaId ?? (character as any).id ?? index);
    const characterName = String((character as any).name ?? characterId).trim() || characterId;
    const chats = Array.isArray((character as any).chats) ? (character as any).chats : [];
    for (const [chatIndex, chat] of chats.entries()) {
      if (!chat || typeof chat !== "object") continue;
      const chatId = String(chat.id ?? `${characterId}:${chatIndex}`);
      let messageCount = Array.isArray((chat as any).message) ? (chat as any).message.length : 0;
      if (!messageCount) {
        try {
          const full = await risuai.getChatFromIndex(index, chatIndex);
          messageCount = Array.isArray(full?.message) ? full.message.length : 0;
        } catch { /* explicit inventory remains useful even when one chat body is unavailable */ }
      }
      items.push({ characterId, characterName, chatId, chatTitle: String(chat.name ?? chat.title ?? "").trim() || `채팅 ${chatIndex + 1}`, messageCount });
    }
  }
  return items;
}

export function rankInheritanceCandidates(chats: any[], targetChatId: string, targetCharacterName: string, query = ""): any[] {
  const normalizedTarget = normalizeBotName(targetCharacterName);
  const needle = query.trim().toLocaleLowerCase();
  return chats.filter((chat) => chat.id !== targetChatId)
    .filter((chat) => !needle || `${chat.characterName} ${chat.chatTitle} ${chat.id}`.toLocaleLowerCase().includes(needle))
    .sort((left, right) => Number(normalizeBotName(right.characterName) === normalizedTarget) - Number(normalizeBotName(left.characterName) === normalizedTarget)
      || Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));
}

function confirmationPanel(chat: any, confirmation?: DataConfirmation): string {
  if (!confirmation || confirmation.chatId !== chat.id) return "";
  const action = confirmation.action;
  const title = action === "rebuild" ? "원문 장부에서 다시 만들까요?" : "RCM 기록을 완전히 삭제할까요?";
  const detail = action === "rebuild"
      ? `파생 데이터를 비운 뒤 서버에 보존된 /del 이전 원문 ${Number(chat.clientPrunedMessages ?? 0).toLocaleString()}개를 포함해 다시 만듭니다.${chat.pendingMemoryLanguage ? ` 기억 정본 언어도 ${String(chat.pendingMemoryLanguage).toUpperCase()}로 적용됩니다.` : ""}`
      : `원문 ${Number(chat.messages ?? 0).toLocaleString()}개, 기억 ${Number(chat.memories ?? 0).toLocaleString()}개와 계보 대응표를 제거합니다. RCM ZIP 백업 외에는 복구할 수 없습니다.`;
  return `<div class="inline-confirm" role="alert"><strong>${title}</strong><p>${escapeHtml(detail)}</p>${action === "delete" ? `<label class="confirm-check"><input type="checkbox" data-action="ack-delete" data-chat-id="${escapeHtml(chat.id)}" ${confirmation.acknowledged ? "checked" : ""}> RCM 원문 장부도 삭제됨을 이해했습니다</label>` : ""}<div class="actions">${action === "delete" ? `<button class="btn" data-action="export-chat-backup" data-chat-id="${escapeHtml(chat.id)}">먼저 ZIP 백업</button>` : ""}<button class="btn ${action === "delete" ? "btn--danger" : "btn--primary"}" data-action="confirm-data-operation" data-operation="${action}" data-chat-id="${escapeHtml(chat.id)}" ${action === "delete" && !confirmation.acknowledged ? "disabled" : ""}>${action === "rebuild" ? "다시 만들기 시작" : "RCM 기록 완전 삭제"}</button><button class="btn" data-action="cancel-data-operation">취소</button></div></div>`;
}

function sourceLedgerTable(inspector: ServerInspector): string {
  const ledger = inspector.ledger;
  if (!ledger) return '<div class="empty">원문 장부 요약을 불러오는 중입니다.</div>';
  const rows = ledger.items.map((item) => `<tr><td>${Number(item.ordinal)}</td><td>${escapeHtml(item.role)}</td><td>${escapeHtml(item.lifecycle)}</td><td>${escapeHtml(item.host_visibility)}</td><td>${escapeHtml(item.extraction_state)}</td><td>${formatTime(item.event_time)}</td><td>${Number(item.content_bytes ?? 0).toLocaleString()}</td>${ledger.includesContent ? `<td class="ledger-content">${escapeHtml(item.content ?? "(본문 정리됨)")}</td>` : ""}</tr>`).join("");
  const previous = Math.max(0, ledger.offset - ledger.limit);
  const next = ledger.offset + ledger.limit;
  return `<div class="ledger-toolbar"><span>${ledger.offset + 1}–${Math.min(ledger.total, next)} / ${ledger.total}</span><div class="actions"><button class="btn" data-action="ledger-page" data-offset="${previous}" ${ledger.offset === 0 ? "disabled" : ""}>이전</button><button class="btn" data-action="ledger-page" data-offset="${next}" ${next >= ledger.total ? "disabled" : ""}>다음</button></div></div><div class="tablewrap"><table class="table"><thead><tr><th>#</th><th>Role</th><th>Lifecycle</th><th>Visibility</th><th>Extraction</th><th>Time</th><th>Chars</th>${ledger.includesContent ? "<th>원문</th>" : ""}</tr></thead><tbody>${rows}</tbody></table></div>${ledger.includesContent ? '<div class="notice" role="note">원문은 이 화면에만 표시됩니다. 공유 화면이나 캡처에 포함되지 않도록 주의하세요.</div>' : '<div class="ledger-reveal"><p>기본 보기에는 원문 본문을 전송하지 않습니다. 개인정보가 포함될 수 있습니다.</p><button class="btn" data-action="reveal-ledger-content">원문 내용 표시</button></div>'}`;
}

function serverInspectorView(data: DashboardData, inspector: ServerInspector | undefined, translations: TranslationView, display: RuntimeState["settings"]["translationDisplay"]): string {
  if (!inspector) return "";
  const chat = data.adminChats.find((item) => item.id === inspector.chatId);
  if (inspector.loading) return '<section class="panel server-inspector"><div class="skeleton"><span></span><span></span><span></span></div></section>';
  if (inspector.error) return `<section class="panel server-inspector"><div class="notice" role="alert">${icon("error")}<div>${escapeHtml(inspector.error)}</div></div></section>`;
  const memoryRows = inspector.memories.map((item) => {
    const title = display === "en" ? item.title : translations.get(`${item.id}:title`) ?? item.title;
    const content = display === "en" ? item.content : translations.get(`${item.id}:content`) ?? item.content;
    return `<details><summary>${escapeHtml(title)}</summary><p>${escapeHtml(content)}</p>${display === "bilingual" ? `<p class="muted">${escapeHtml(item.content)}</p>` : ""}</details>`;
  }).join("") || '<div class="empty">기억이 없습니다.</div>';
  const relationshipRows = inspector.relationships.map((item) => `<tr><td>${escapeHtml(relationshipFrom(item))} → ${escapeHtml(relationshipTo(item))}</td><td>${["affection","trust","intimacy","fear","jealousy","hostility"].map((axis) => `${axis} ${relationshipAxisText(item, axis)}`).join(" · ")}</td></tr>`).join("");
  const worldRows = [
    ...inspector.assertions.map((item) => ["Fact", `${item.subject}.${item.predicate} = ${item.value}`]),
    ...inspector.beliefs.map((item) => ["Belief", `${item.holder}: ${item.subject}.${item.predicate} = ${item.value}`]),
    ...inspector.promises.map((item) => ["Promise", `${item.promisor} → ${item.promisee}: ${item.content} (${item.status})`]),
  ].map(([kind, value]) => `<tr><td>${kind}</td><td>${escapeHtml(value)}</td></tr>`).join("");
  const ledger = data.health?.capabilities?.sourceLedgerInspection ? sourceLedgerTable(inspector) : '<div class="empty">원문 장부 열람은 API 12 서버 업데이트가 필요합니다.</div>';
  return `<section class="panel server-inspector"><div class="panel__head"><h2>기록 보기</h2><span>${escapeHtml(chat?.chatTitle || inspector.chatId)} · 읽기 전용</span><button class="btn" data-action="close-server-inspector">닫기</button></div><div class="inspector-section"><h3>Memories</h3>${memoryRows}</div><div class="inspector-section"><h3>Relationships</h3><div class="tablewrap"><table class="table"><tbody>${relationshipRows || '<tr><td class="muted">관계가 없습니다.</td></tr>'}</tbody></table></div></div><div class="inspector-section"><h3>World facts · beliefs · promises</h3><div class="tablewrap"><table class="table"><tbody>${worldRows || '<tr><td class="muted">구조화 상태가 없습니다.</td></tr>'}</tbody></table></div></div><div class="inspector-section"><h3>Review · Conflicts</h3><p>${inspector.reconciliationReviews.length} review · ${inspector.conflicts.length} conflict</p></div><div class="inspector-section"><h3>Source ledger</h3>${ledger}</div></section>`;
}

function inheritancePanel(state: RuntimeState, data: DashboardData, view: DataViewState): string {
  if (!view.inheritanceOpen || !state.current) return "";
  if (Number(data.health?.apiRevision ?? 0) !== RCM_API_REVISION || !data.health?.capabilities?.manualLineageTransfer) return '<section class="panel"><div class="empty">현재 RCM 서버 계약이 필요합니다.</div></section>';
  const candidates = rankInheritanceCandidates(data.adminChats, state.current.chatId, state.current.characterName, view.inheritanceQuery);
  const options = candidates.map((chat) => `<option value="${escapeHtml(chat.id)}" ${view.inheritanceSourceId === chat.id ? "selected" : ""}>${escapeHtml(chat.characterName)} · ${escapeHtml(chat.chatTitle || chat.id)}${normalizeBotName(chat.characterName) === normalizeBotName(state.current!.characterName) ? " · 같은 봇 이름" : ""}</option>`).join("");
  const preview = view.inheritancePreview;
  const replacing = preview?.requiresReplacement === true;
  const previewHtml = preview ? `<div class="transfer-preview"><h3>이식할 내용 확인</h3><dl><div><dt>원본</dt><dd>${escapeHtml(preview.parent.characterName)} · ${escapeHtml(preview.parent.chatTitle || preview.parent.chatId)}</dd></div><div><dt>대상</dt><dd>${escapeHtml(preview.target.characterName)} · ${escapeHtml(preview.target.chatTitle || preview.target.chatId)}</dd></div><div><dt>방식</dt><dd>원본 기억 전체를 독립 기록으로 복사</dd></div><div><dt>원본 범위</dt><dd>${preview.forkOrdinal >= 0 ? `원문 #0~${preview.forkOrdinal}` : "저장된 원문 없음"}</dd></div><div><dt>기억 이식</dt><dd>기억 ${preview.inheritedCounts.memories ?? 0} · 관계 ${preview.inheritedCounts.relationships ?? 0} · 세계 상태 ${(preview.inheritedCounts.assertions ?? 0) + (preview.inheritedCounts.beliefs ?? 0)} · 약속 ${preview.inheritedCounts.promises ?? 0}</dd></div>${replacing ? `<div><dt>교체 대상</dt><dd>기억 ${preview.targetDerivedCounts.memories ?? 0} · 관계 ${preview.targetDerivedCounts.relationships ?? 0} · 세계 상태 ${(preview.targetDerivedCounts.assertions ?? 0) + (preview.targetDerivedCounts.beliefs ?? 0)} · 약속 ${preview.targetDerivedCounts.promises ?? 0}</dd></div>` : ""}</dl>${replacing ? `<label class="confirm-check"><input type="checkbox" data-action="ack-lineage-replacement" ${view.inheritanceReplacementAcknowledged ? "checked" : ""}> 현재 채팅의 파생 정본이 교체됨을 이해했습니다</label>` : ""}<div class="actions"><button class="btn btn--primary" data-action="apply-lineage-transfer" ${replacing && !view.inheritanceReplacementAcknowledged ? "disabled" : ""}>${replacing ? "교체 후 기억 이식" : "기억 이식"}</button><button class="btn" data-action="cancel-lineage-preview">원본 다시 선택</button></div></div>` : "";
  return `<section class="panel transfer-panel"><div class="panel__head"><h2>현재 채팅에 기억 이식</h2><span>서버에 있는 채팅에서 가져오기</span></div><div class="panel__body"><p>확인된 원문 범위와 기억 장부를 현재 채팅의 독립 기록으로 옮깁니다.</p><div class="formgrid"><label class="field"><span>원본 검색</span><input data-action="inheritance-search" value="${escapeHtml(view.inheritanceQuery)}" placeholder="봇 이름, 채팅 제목, ID"></label><label class="field"><span>원본 채팅</span><select data-action="select-inheritance-source"><option value="">원본을 선택하세요</option>${options}</select></label></div>${view.inheritanceError ? `<div class="notice" role="alert">${icon("error")}<div>${escapeHtml(view.inheritanceError)}</div></div>` : ""}${previewHtml || `<div class="actions"><button class="btn btn--primary" data-action="preview-lineage-transfer" ${view.inheritanceSourceId ? "" : "disabled"}>이식 범위 확인</button><button class="btn" data-action="close-lineage-transfer">닫기</button></div>`}</div></section>`;
}

export function dataManagement(state: RuntimeState, data: DashboardData, view: DataViewState, translations: TranslationView): string {
  const localByChat = new Map(view.inventory.map((item) => [item.chatId, item]));
  const currentCharacterId = state.current?.characterId;
  const serverHasCurrent = Boolean(state.current && data.adminChats.some((chat) => chat.id === state.current!.chatId));
  const visibleChats = serverHasCurrent || !state.current ? data.adminChats : [...data.adminChats, {
    id: state.current.chatId,
    characterId: state.current.characterId,
    characterName: state.current.characterName,
    chatTitle: state.current.chatTitle,
    updatedAt: 0,
    messages: 0,
    memories: 0,
    relationships: 0,
    assertions: 0,
    beliefs: 0,
    promises: 0,
    pendingReviews: 0,
    pendingConflicts: 0,
    approximateBytes: 0,
    serverRegistered: false,
  }];
  const classify = (chat: any): "current" | "other" => chat.characterId === currentCharacterId ? "current" : "other";
  const query = view.query.trim().toLocaleLowerCase();
  const filtered = visibleChats.filter((chat) => (view.filter === "all" || classify(chat) === view.filter)
    && (!query || `${chat.characterName} ${chat.chatTitle} ${chat.id}`.toLocaleLowerCase().includes(query)))
    .sort((left, right) => Number(right.characterId === currentCharacterId) - Number(left.characterId === currentCharacterId)
      || normalizeBotName(left.characterName).localeCompare(normalizeBotName(right.characterName), ["ko", "en"], { numeric: true })
      || Number(right.id === state.current?.chatId) - Number(left.id === state.current?.chatId)
      || String(left.chatTitle ?? "").localeCompare(String(right.chatTitle ?? ""), ["ko", "en"], { numeric: true })
      || Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));
  const rows = filtered.map((chat) => {
    const registered = chat.serverRegistered !== false;
    const local = localByChat.get(chat.id);
    const titleText = local?.chatTitle || state.current?.chatTitles?.[chat.id] || (state.current?.chatId === chat.id ? state.current?.chatTitle : "") || chat.chatTitle || "제목 없음";
    const botName = local?.characterName || chat.characterName || chat.characterId || "봇 이름 없음";
    const sourceCount = local?.messageCount ?? (state.current?.chatId === chat.id ? state.current?.sourceMessageCount : undefined);
    const inherited = chat.lineage?.status === "inherited" ? `<small>${escapeHtml(chat.lineage.parentTitle ?? chat.lineage.parentChatId ?? "원본")}에서 이어받음</small>` : "";
    const diagnosticsAction = (typeof __RCM_DISTRIBUTION__ === "undefined" || !__RCM_DISTRIBUTION__) && data.health?.capabilities?.retrievalDiagnostics === true
      ? `<button class="btn" data-action="toggle-retrieval-diagnostics" data-chat-id="${escapeHtml(chat.id)}" data-enabled="${chat.retrievalDiagnosticsEnabled === true}">${chat.retrievalDiagnosticsEnabled === true ? "진단 기록 끄기" : "진단 기록 켜기"}</button>`
      : "";
    const more = registered ? `<details class="record-menu record-menu--icon"><summary class="btn btn--icon" aria-label="더보기" title="더보기">${icon("more")}</summary><div class="record-menu__items"><button class="btn" data-action="view-server-data" data-chat-id="${escapeHtml(chat.id)}">기록 보기</button><button class="btn" data-action="export-chat-backup" data-chat-id="${escapeHtml(chat.id)}" ${view.backupExportPhase?"disabled":""}>이 채팅 백업</button>${diagnosticsAction}${state.current && chat.id !== state.current.chatId ? `<button class="btn" data-action="inherit-from-chat" data-chat-id="${escapeHtml(chat.id)}">현재 채팅에 기억 이식</button>` : ""}<button class="btn" data-action="open-data-operation" data-operation="rebuild" data-chat-id="${escapeHtml(chat.id)}">다시 만들기</button></div></details>` : "";
    const actions = registered
      ? `<div class="data-actions"><button class="btn btn--icon btn--danger" data-action="open-data-operation" data-operation="delete" data-chat-id="${escapeHtml(chat.id)}" aria-label="삭제" title="삭제">${icon("delete")}</button>${more}</div>`
      : '<span class="data-unregistered">RCM 서버 미등록</span>';
    return `<div class="data-entry" data-data-row><article class="data-row"><div class="data-chat"><strong>${escapeHtml(botName)} · ${escapeHtml(titleText)}</strong>${inherited}<small>${escapeHtml(chat.id)}</small></div><span data-label="최근 갱신">${registered ? formatRelativeTime(chat.updatedAt) : "—"}</span><span data-label="원문">동기화 ${Number(chat.messages ?? 0).toLocaleString()} · 원문 ${sourceCount === undefined ? "—" : Number(sourceCount).toLocaleString()}</span><span data-label="파생 기록"><strong>${Number(chat.memories ?? 0).toLocaleString()} 기억</strong><small>관계 ${Number(chat.relationships ?? 0)} · 세계 ${(Number(chat.assertions ?? 0) + Number(chat.beliefs ?? 0) + Number(chat.promises ?? 0))}</small></span><span data-label="검토">${Number(chat.pendingReviews ?? 0)} / ${Number(chat.pendingConflicts ?? 0)}</span><span data-label="용량">${Math.max(0, Number(chat.approximateBytes) / 1024).toFixed(1)} KiB</span><div class="data-action-cell">${actions}</div></article>${confirmationPanel(chat, view.confirmation)}</div>`;
  }).join("");
  const totalMessages = data.adminChats.reduce((sum, chat) => sum + Number(chat.messages ?? 0), 0);
  const totalMemories = data.adminChats.reduce((sum, chat) => sum + Number(chat.memories ?? 0), 0);
  const totalBytes = data.adminChats.reduce((sum, chat) => sum + Number(chat.approximateBytes ?? 0), 0);
  const botCount = new Set(visibleChats.map((chat) => chat.characterId)).size;
  const inventoryLabel = view.inventoryStatus === "loading" ? "확인 중…" : view.inventoryStatus === "ready" ? "원문 수 다시 확인" : "원문 수 확인";
  const controls = `<div class="data-toolbar"><label class="data-search">${icon("search")}<input data-action="data-search" value="${escapeHtml(view.query)}" placeholder="봇 이름, 채팅 제목, ID 검색"></label><select data-action="data-filter" aria-label="봇 필터"><option value="all" ${view.filter === "all" ? "selected" : ""}>전체 봇</option><option value="current" ${view.filter === "current" ? "selected" : ""}>현재 봇</option><option value="other" ${view.filter === "other" ? "selected" : ""}>다른 봇</option></select><button class="btn data-inventory" data-action="load-data-inventory" ${view.inventoryStatus === "loading" ? "disabled" : ""}>${inventoryLabel}</button></div>`;
  const backupBusy = Boolean(view.backupExportPhase);
  const importAction = `<button class="btn" data-action="export-chat-backup" ${backupBusy||!state.current?"disabled":""}>현재 채팅 백업</button><button class="btn" data-action="export-complete-backup" ${backupBusy ? "disabled" : ""}>전체 백업</button><label class="btn data-import" for="backup-file" title="백업 불러오기">백업 불러오기</label><input class="sr-only" id="backup-file" type="file" accept=".zip,application/zip" ${backupBusy?"disabled":""}>`;
  const backupProgress = backupBusy ? `<div class="notice" role="status"><div><strong>${view.backupExportPhase === "creating" ? "백업 생성" : "다운로드"}</strong><p>${view.backupExportChatId?"선택한 채팅의 RCM 데이터와 채팅별 설정":"모든 RCM 데이터·설정·키"}을 저장하고 있습니다.</p></div></div>` : "";
  const backupError = view.backupExportError ? `<div class="notice" role="alert">${icon("error")}<div><strong>백업을 만들지 못했습니다.</strong><p>${escapeHtml(view.backupExportError)}</p></div></div>` : "";
  return `<section class="management-page data-management-page">${pageHeader("데이터", "채팅별 RCM 기록을 확인하고 백업하거나 삭제합니다.", importAction)}
    ${lineagePanel(data)}
    ${lineagePath(data)}
    ${lineageProbeNotice(state)}
    <div class="data-metrics"><span>봇 <strong>${botCount}</strong></span><span>채팅 <strong>${visibleChats.length}</strong></span><span>동기화 원문 <strong>${totalMessages.toLocaleString()}</strong></span><span>기억 <strong>${totalMemories.toLocaleString()}</strong></span><span>텍스트 <strong>${(totalBytes / 1024).toFixed(1)} KiB</strong></span></div>
    ${backupProgress}${backupError}${controls}${inheritancePanel(state, data, view)}${serverInspectorView(data, view.inspector, translations, state.settings.translationDisplay)}
    <section class="data-ledger" aria-label="채팅별 RCM 데이터"><div class="data-columns"><span>채팅</span><span>최근 갱신</span><span>원문</span><span>파생 기록</span><span>검토</span><span>용량</span><span>작업</span></div>${rows || '<div class="empty">조건에 맞는 RCM 데이터가 없습니다.</div>'}</section>
    <p class="data-footnote">채팅 백업: RCM에 마지막으로 동기화된 원문·기억·임베딩·채팅별 설정. 전체 백업: 모든 RCM 데이터·설정·서버 토큰·API 키. 전체 백업은 키가 포함된 개인 파일입니다.</p></section>`;
}

export async function setRetrievalDiagnostics(client: Pick<ServerClient, "request">, data: Pick<DashboardData, "adminChats" | "error">, chatId: string, enabled: boolean): Promise<boolean> {
  if (typeof __RCM_DISTRIBUTION__ !== "undefined" && __RCM_DISTRIBUTION__) return false;
  try {
    const result = await client.request<{ enabled: boolean }>(`/v1/admin/chats/${encodeURIComponent(chatId)}/retrieval-diagnostics`, {
      method: "PUT", body: JSON.stringify({ enabled }),
    });
    const chat = data.adminChats.find((item) => item.id === chatId);
    if (chat) chat.retrievalDiagnosticsEnabled = result.enabled;
    data.error = undefined;
    return result.enabled;
  } catch (error) {
    data.error = String(error);
    throw error;
  }
}

function settings(
  state: RuntimeState,
  data: DashboardData,
  saveState?: ActionState,
  voyageState?: ActionState,
  voyageBusy = false,
  cacheStats: TranslationCacheStats = { items: 0, bytes: 0, maxItems: 50_000, maxBytes: 128 * 1024 * 1024 },
): string {
  const settings = state.settings;
  const hasCurrentChat = Boolean(state.current);
  const currentChatEnabled = state.current ? isChatMemoryEnabled(settings, state.current.chatId) : settings.defaultChatEnabled;
  const includeUserMessages = state.current ? (settings.includeUserMessages[state.current.chatId] ?? true) : true;
  const extractionGroupTurns = state.current ? (settings.extractionGroupTurns[state.current.chatId] ?? 6) : 6;
  const desiredMemoryLanguage = state.current ? (settings.memoryLanguages[state.current.chatId] ?? "en") : "en";
  const currentMemoryBudget = state.current ? settings.memoryBudgets[state.current.chatId] : undefined;
  const currentProfile = state.current?.profile ?? "companion";
  const currentServerChat = state.current ? data.adminChats.find((chat) => chat.id === state.current!.chatId) : undefined;
  const activeMemoryLanguage = state.lastPrepare?.memoryLanguage ?? currentServerChat?.memoryLanguage ?? desiredMemoryLanguage;
  const pendingMemoryLanguage = state.lastPrepare?.pendingMemoryLanguage ?? currentServerChat?.pendingMemoryLanguage;
  const perspectives = state.current ? (settings.perspectives[state.current.chatId] ?? []).join(", ") : "";
  const perspectiveScope = state.current && data.health?.instanceId ? `${data.health.instanceId}:${state.current.chatId}` : "";
  const detectedPerspectives = perspectiveScope ? settings.detectedPerspectives[perspectiveScope] ?? state.lastPrepare?.perspectiveResolution?.perspectives ?? [] : [];
  const embedding = data.health?.embedding;
  const embeddingState = !data.health
    ? "Server status unavailable"
    : embedding?.ready
    ? `${embedding.model} · ${embedding.dimension}d · ready`
    : embedding?.configured
      ? `${embedding.model} · unavailable, using FTS fallback`
      : "VOYAGE_API_KEY not configured · using FTS fallback";
  const serverState = data.health?.ok ? status("ok", `Server ${data.health.version}`) : status("error", "Server unavailable");
  const voyageStatus = !data.health
    ? status("warn", "Key status unknown")
    : embedding?.ready
      ? status("ok", "Configured on server · ready")
      : embedding?.configured
        ? status("warn", "Configured on server · unavailable")
        : status("warn", "Not configured on server");
  const serverLlm = data.health?.serverLlm ?? { maxInputTokens: 80000, maxOutputTokens: 24000, embeddingTimeoutMs: 15000, rerankTimeoutMs: 45000, llmTimeoutMs: 300000,
    engine: settings.extractionEngine,
    provider: "llm_gateway",
    endpoint: "https://api.llmgateway.io/v1/chat/completions",
    model: "auto",
    temperature: 0.2,
    thinking: "off",
    keyConfigured: false,
    configuredProviders: [],
  };
  const configuredProviders = new Set(serverLlm.configuredProviders ?? []);
  const serverLlmStatus = serverLlm.keyConfigured ? "인증정보 저장됨" : "인증정보 없음";
  return `${pageHeader("설정", "현재 채팅의 기억 방식과 개인 서버·보조 모델을 관리합니다.")}
    <div class="statusbar">${serverState}${voyageStatus}</div>
    <section class="panel"><div class="panel__head"><h2>Memory injection position</h2><span>주요 설정</span></div><div class="panel__body"><p>RCM을 켠 채팅은 최종 프롬프트에 기억을 넣을 위치를 명시해야 합니다.</p><p class="muted">프리셋·캐릭터 설명·로어북의 원하는 곳에 <code>[[RCM]]</code>을 한 번 넣으세요. 해당 위치에서 기억 블록으로 치환됩니다. Risu는 알 수 없는 <code>{{RCM}}</code> 형태를 요청 훅 전에 제거하므로 대괄호 표식을 사용합니다. 표식이 여러 개면 첫 번째만 사용하고 나머지는 지웁니다.</p></div></section>
    <section class="panel"><div class="panel__head"><h2>RCM settings</h2><span>변경한 값은 이 기기에 기억됩니다.</span></div><div class="panel__body"><form id="settings-form">
      <div class="settings-section"><h3>현재 채팅</h3><div class="formgrid">
        <label class="field field--check"><span><input name="chatEnabled" type="checkbox" ${currentChatEnabled ? "checked" : ""} ${hasCurrentChat ? "" : "disabled"}> 이 채팅에서 RCM 사용</span><small class="muted">켜져 있으면 전송 직전 최종 프롬프트에 <code>[[RCM]]</code> 또는 기존 RCM 패킷이 반드시 있어야 합니다. 끄면 새 동기화·추출·기억 도구 호출을 만들지 않습니다.</small></label>
        ${dashboardChatProfileControl(currentProfile, !hasCurrentChat)}
        <label class="field"><span>자동 감지된 관점</span><input value="${escapeHtml(detectedPerspectives.length ? detectedPerspectives.join(" · ") : "아직 감지 전")}" disabled><small class="muted">PocketRisu 페르소나와 장부의 실제 인물명을 사용합니다.</small></label>
        <label class="field"><span>수동 관점 지정 · 선택 사항</span><input name="perspectives" value="${escapeHtml(perspectives)}" ${hasCurrentChat ? "" : "disabled"} placeholder="비워두면 자동 감지"><small class="muted">자동 감지를 덮어쓸 때만 입력하세요. 여러 인물은 쉼표로 구분합니다.</small></label>
        <label class="field field--check"><span><input name="includeUserMessages" type="checkbox" ${includeUserMessages ? "checked" : ""} ${hasCurrentChat ? "" : "disabled"}> 유저 메시지를 기억 추출에 포함</span></label>
        <label class="field"><span>한 번에 정리할 턴</span><input name="extractionGroupTurns" type="number" min="1" max="50" step="1" value="${extractionGroupTurns}" ${hasCurrentChat ? "" : "disabled"}><small class="muted">완료된 RP 턴을 몇 개 모아 한 번에 정리할지 정합니다. 입력 한도를 넘는 구간은 원문을 보존하며 나누어 처리합니다.${hasCurrentChat ? ` 현재 ${data.bufferedTurns}/${data.extractionGroupTurns}턴 · 약 ${data.bufferedSourceTokens.toLocaleString()}토큰 대기 중입니다.` : ""}</small></label>
        <label class="field"><span>기억 정본 언어</span><select name="memoryLanguage" ${hasCurrentChat ? "" : "disabled"}><option value="en" ${desiredMemoryLanguage === "en" ? "selected" : ""}>English · 기본</option><option value="ko" ${desiredMemoryLanguage === "ko" ? "selected" : ""}>한국어</option><option value="ja" ${desiredMemoryLanguage === "ja" ? "selected" : ""}>日本語</option><option value="zh" ${desiredMemoryLanguage === "zh" ? "selected" : ""}>中文</option></select><small class="muted">현재 정본: ${escapeHtml(activeMemoryLanguage)}${pendingMemoryLanguage ? ` · 변경 예정: ${escapeHtml(pendingMemoryLanguage)}. Data & privacy의 전체 기억 다시 만들기 때 적용됩니다.` : ""}</small></label>
        <label class="field"><span>이 채팅의 기억 주입량</span><select name="chatMemoryBudget" ${hasCurrentChat ? "" : "disabled"}><option value="inherit" ${currentMemoryBudget === undefined ? "selected" : ""}>공통값 사용 · ${settings.defaultMemoryBudget.toLocaleString()}</option>${[4_000, 6_000, 8_000, 12_000].map((value) => `<option value="${value}" ${currentMemoryBudget === value ? "selected" : ""}>${value.toLocaleString()} tokens</option>`).join("")}</select><small class="muted">전체 자동 주입의 목표 예산입니다. 직접 맞은 기억과 연속성을 완결할 때만 최대 15% 여유를 사용합니다.</small></label>
      </div></div>
      <div class="settings-section"><h3>Memory behavior</h3><div class="formgrid">
        <label class="field"><span>공통 기억 주입량</span><select name="defaultMemoryBudget">${[4_000, 6_000, 8_000, 12_000].map((value) => `<option value="${value}" ${settings.defaultMemoryBudget === value ? "selected" : ""}>${value.toLocaleString()} tokens</option>`).join("")}</select><small class="muted">채팅별 선택이 없을 때 사용하는 목표 예산입니다. 실제 context가 작으면 안전하게 줄고, 직접 근거 완결에만 최대 15% 여유를 사용합니다.</small></label>
        <label class="field"><span>MCP 호출당 최대 결과 토큰</span><input name="mcpCap" type="number" min="1500" max="4000" step="100" value="${settings.mcpCap}"><small class="muted">한 번의 기억 도구 호출이 반환할 수 있는 최대 분량입니다. 호출 횟수는 사용 중인 도구 제공자가 관리합니다.</small></label>
        <label class="field field--check"><span><input name="memoryToolsEnabled" type="checkbox" ${settings.memoryToolsEnabled ? "checked" : ""}> 메인 모델에 RCM 기억 도구 제공</span><small class="muted">필요한 과거 기록을 모델이 직접 더 찾아볼 수 있게 합니다.</small></label>
        <label class="field field--check"><span><input name="postExtractionReview" type="checkbox" ${settings.postExtractionReview ? "checked" : ""}> 추출 결과를 보조 모델로 한 번 더 재검수</span><small class="muted">새 기억 그룹의 인물별 지식과 믿음 변화 등을 2차 검토합니다. 보조 모델 호출이 늘어납니다. 전체 다시 만들기·백필은 시작할 때 별도로 묻습니다.</small></label>
      </div></div>
      <div class="settings-section"><h3>화면 표시와 번역</h3><div class="formgrid">
        <label class="field field--check"><span><input name="showKoreanTranslation" type="checkbox" ${settings.autoTranslate && settings.translationDisplay !== "en" ? "checked" : ""} ${activeMemoryLanguage === "ko" ? "disabled" : ""}> 한국어 번역 같이 보기</span><small class="muted">${activeMemoryLanguage === "ko" ? "현재 정본이 한국어라 번역이 필요하지 않습니다. 다른 언어 채팅의 선호는 유지됩니다." : "켜면 읽기 화면은 한국어를 먼저 보여주고 정본 보기·비교를 함께 제공합니다. 번역문은 서버 장부나 백업에 저장되지 않습니다."}</small></label>
        <label class="field"><span>번역 서비스</span><select name="translationProvider"><option value="google" ${settings.translationProvider === "google" ? "selected" : ""}>Google Translate · 기본</option><option value="risu" ${settings.translationProvider === "risu" ? "selected" : ""}>Yumi / Risu translator</option></select><small class="muted">Google 선택 시 화면에 보이는 기억 내용이 공개 Google 번역 서비스로 전송됩니다.</small></label>
        <div class="field"><span>번역 캐시</span><div class="actions"><span class="muted">${cacheStats.items.toLocaleString()}개 · ${(cacheStats.bytes / 1024 / 1024).toFixed(1)} MiB</span><button class="btn" type="button" data-action="clear-translation-cache">번역 캐시 비우기</button></div></div>
      </div></div>
      <div class="settings-section"><h3>Server & models</h3><div class="formgrid">
        <label class="field"><span>Server URL</span><input name="serverUrl" value="${escapeHtml(settings.serverUrl)}"></label>
        <label class="field"><span>Server token</span><input name="serverToken" type="password" value="${escapeHtml(settings.serverToken)}" autocomplete="off"></label>
        <label class="field"><span>Extraction processing</span><select name="extractionEngine"><option value="risu" ${settings.extractionEngine === "risu" ? "selected" : ""}>Risu auxiliary model</option><option value="server" ${settings.extractionEngine === "server" ? "selected" : ""}>RCM server</option></select></label>
        <label class="field" data-engine-fields="risu" ${settings.extractionEngine === "risu" ? "" : "hidden"}><span>Risu auxiliary model slot</span><select name="auxiliaryMode">${[["main", "Main"], ["memory", "Memory"], ["otherAx", "Other AX"], ["static", "Static model ID"]].map(([value, label]) => `<option value="${value}" ${settings.auxiliaryMode === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        <label class="field" data-engine-fields="risu" data-static-model ${settings.extractionEngine === "risu" && settings.auxiliaryMode === "static" ? "" : "hidden"}><span>Static model ID</span><input name="staticModel" value="${escapeHtml(settings.staticModel)}"></label>
        <label class="field"><span>Embedding</span><input value="${escapeHtml(embeddingState)}" disabled></label>
      </div><div data-engine-fields="server" ${settings.extractionEngine === "server" ? "" : "hidden"}><p class="settings-subhead">Server extraction model <span class="muted" data-provider-key-status>${serverLlmStatus}</span></p><div class="formgrid">
        <label class="field"><span>Provider</span><select name="serverLlmProvider" data-configured-providers="${escapeHtml([...configuredProviders].join(","))}"><option value="vertex" ${serverLlm.provider === "vertex" ? "selected" : ""}>Vertex AI · service-account JSON</option><option value="gemini_api" ${serverLlm.provider === "gemini_api" ? "selected" : ""}>Google Gemini API · API key</option><option value="llm_gateway" ${serverLlm.provider === "llm_gateway" ? "selected" : ""}>LLM Gateway / OpenAI-compatible</option><option value="ollama_cloud" ${serverLlm.provider === "ollama_cloud" ? "selected" : ""}>Ollama Cloud</option></select></label>
        <label class="field"><span>Endpoint</span><input name="serverLlmEndpoint" value="${escapeHtml(serverLlm.endpoint)}" placeholder="HTTPS endpoint"></label>
        <label class="field"><span>API key / service-account JSON</span><input name="serverLlmApiKey" type="password" value="" autocomplete="off" placeholder="${serverLlm.keyConfigured ? "저장된 인증정보 유지 (변경할 때만 입력)" : "서버에 저장할 인증정보"}"></label>
        <label class="field"><span>Model ID</span><input name="serverLlmModel" value="${escapeHtml(serverLlm.model)}"></label>
        <label class="field"><span>Temperature</span><input name="serverLlmTemperature" type="number" min="0" max="2" step="0.05" value="${serverLlm.temperature}"></label>
        <label class="field"><span>Thinking</span><select name="serverLlmThinking">${[["default", "Provider default"], ["off", "Off / none"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]].map(([value, label]) => `<option value="${value}" ${serverLlm.thinking === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      </div><p class="muted">빈 입력은 선택한 프로바이더의 저장된 인증정보를 유지합니다.</p>${configuredProviders.size ? `<button class="btn btn--danger" type="button" data-action="remove-server-llm-key" ${serverLlm.keyConfigured ? "" : "hidden"}>현재 프로바이더 인증정보 제거</button>` : ""}</div></div>
      <div class="actions"><button class="btn btn--primary" type="button" data-action="save-settings">설정 저장</button></div>${saveState ? `<div class="notice" role="${saveState.kind === "success" ? "status" : "alert"}">${icon(saveState.kind === "success" ? "check" : "error")}<div><strong>${saveState.kind === "success" ? "저장됨" : "설정 저장 실패"}</strong><div class="muted">${escapeHtml(saveState.message)}</div></div></div>` : ""}
    </form>
    <div class="settings-section"><h3>Embedding · Voyage</h3><div class="statusbar">${voyageStatus}</div><form id="voyage-form"><label class="field"><span>새 Voyage API key</span><input name="voyageApiKey" type="password" value="" autocomplete="off" placeholder="입력 후 서버에서 검증하고 저장" ${voyageBusy ? "disabled" : ""}></label><div class="actions"><button class="btn btn--primary" type="button" data-action="save-voyage-key" ${voyageBusy ? "disabled" : ""}>${voyageBusy ? "키 검증 중…" : "키 검증 및 서버 저장"}</button>${embedding?.configured ? '<button class="btn btn--danger" type="button" data-action="remove-voyage-key">저장된 키 제거</button>' : ""}</div>${voyageState ? `<div class="notice" role="${voyageState.kind === "success" ? "status" : "alert"}">${icon(voyageState.kind === "success" ? "check" : "error")}<div><strong>${voyageState.kind === "success" ? "Voyage 키 저장 완료" : "Voyage 키 저장 실패"}</strong><div class="muted">${escapeHtml(voyageState.message)}</div></div></div>` : ""}<p class="muted">키 원문은 Risu 저장소에 남지 않습니다. 빈 입력은 저장된 키가 없다는 뜻이 아닙니다.</p></form></div>
    </div></section>
    `;
}

type SettingsSection = "chat" | "memory" | "server";

type ComparableServerLlmConfig = Pick<ServerLlmPublicConfig, "engine" | "provider" | "endpoint" | "model" | "temperature" | "thinking" | "serviceTier"> & Partial<Pick<ServerLlmPublicConfig, "maxInputTokens" | "maxOutputTokens" | "embeddingTimeoutMs" | "rerankTimeoutMs" | "llmTimeoutMs">>;

export function serverLlmUpdateRequired(
  current: ServerLlmPublicConfig | undefined,
  next: ComparableServerLlmConfig,
  apiKey = "",
): boolean {
  if (apiKey.trim()) return true;
  if (!current) return false;
  const endpoint = (value: string) => value.trim().replace(/\/+$/, "");
  return current.engine !== next.engine
    || current.provider !== next.provider
    || endpoint(current.endpoint) !== endpoint(next.endpoint)
    || current.model.trim() !== next.model.trim()
    || Number(current.temperature) !== Number(next.temperature)
    || current.thinking !== next.thinking
    || (current.serviceTier ?? "standard") !== next.serviceTier
    || ["maxInputTokens", "maxOutputTokens", "embeddingTimeoutMs", "rerankTimeoutMs", "llmTimeoutMs"].some(key => {
      const field = key as "maxInputTokens" | "maxOutputTokens" | "embeddingTimeoutMs" | "rerankTimeoutMs" | "llmTimeoutMs";
      return next[field] !== undefined && current[field] !== next[field];
    });
}

export function serverLlmUpdateRequiredForSettingsSave(
  bootstrappingServerConnection: boolean,
  current: ServerLlmPublicConfig | undefined,
  next: ComparableServerLlmConfig,
  apiKey = "",
): boolean {
  if (bootstrappingServerConnection) return Boolean(apiKey.trim());
  return serverLlmUpdateRequired(current, next, apiKey);
}

export function settingsConnectionNeedsHealthProbe(
  current: Pick<PluginSettings, "serverUrl" | "serverToken">,
  next: Pick<PluginSettings, "serverUrl" | "serverToken">,
  health?: { ok?: boolean },
): boolean {
  return isServerConfigured(next) && (
    !health?.ok
    || current.serverUrl.replace(/\/+$/, "") !== next.serverUrl.replace(/\/+$/, "")
    || current.serverToken !== next.serverToken
  );
}

export function settingsSaveFailureMessage(
  error: unknown,
  attempted: Pick<PluginSettings, "serverUrl" | "serverToken">,
): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, "");
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden/i.test(message)) {
    return describeServerConnectionIssue(attempted, error)?.detail ?? "서버 토큰을 확인해 주세요.";
  }
  if (/failed to fetch|network|timed out|econn|enotfound|certificate|load failed/i.test(message)) {
    return describeServerConnectionIssue(attempted, error)?.detail ?? "서버 주소와 실행 상태를 확인해 주세요.";
  }
  return message || "설정을 저장하지 못했습니다.";
}

function regexRuleEditor(rule: CanonicalRemovalRule): string {
  return `<article class="settings-regex-rule" data-regex-rule><label class="settings-regex-enabled" title="규칙 사용"><input name="customRuleEnabled" type="checkbox" aria-label="규칙 사용" ${rule.enabled ? "checked" : ""}><span>규칙 사용</span></label><label class="field settings-regex-name"><span>규칙 이름</span><input name="customRuleName" value="${escapeHtml(rule.name)}" placeholder="예: 상태 패널"></label><label class="field settings-regex-flags"><span>Flags</span><input name="customRuleFlags" value="${escapeHtml(rule.flags || "gis")}" aria-describedby="regex-flags-help"></label><label class="field settings-regex-pattern"><span>정규식 패턴</span><input name="customRulePattern" value="${escapeHtml(rule.pattern)}" placeholder="제거할 문자열 패턴"></label><button class="btn btn--icon settings-regex-remove" type="button" data-action="remove-regex-rule" aria-label="규칙 삭제" title="규칙 삭제">${icon("delete")}</button></article>`;
}

function settingsV2(
  state: RuntimeState,
  data: DashboardData,
  section: SettingsSection,
  voyageState?: ActionState,
  voyageBusy = false,
  cacheStats: TranslationCacheStats = { items: 0, bytes: 0, maxItems: 50_000, maxBytes: 128 * 1024 * 1024 },
): string {
  const settings = state.settings;
  const hasCurrentChat = Boolean(state.current);
  const currentChatEnabled = state.current ? isChatMemoryEnabled(settings, state.current.chatId) : settings.defaultChatEnabled;
  const includeUserMessages = state.current ? (settings.includeUserMessages[state.current.chatId] ?? true) : true;
  const extractionGroupTurns = state.current ? (settings.extractionGroupTurns[state.current.chatId] ?? 6) : 6;
  const desiredMemoryLanguage = state.current ? (settings.memoryLanguages[state.current.chatId] ?? "en") : "en";
  const currentMemoryBudget = state.current ? settings.memoryBudgets[state.current.chatId] : undefined;
  const currentProfile = state.current?.profile ?? "companion";
  const currentServerChat = state.current ? data.adminChats.find((chat) => chat.id === state.current!.chatId) : undefined;
  const activeMemoryLanguage = state.lastPrepare?.memoryLanguage ?? currentServerChat?.memoryLanguage ?? desiredMemoryLanguage;
  const pendingMemoryLanguage = state.lastPrepare?.pendingMemoryLanguage ?? currentServerChat?.pendingMemoryLanguage;
  const perspectives = state.current ? (settings.perspectives[state.current.chatId] ?? []).join(", ") : "";
  const perspectiveScope = state.current && data.health?.instanceId ? `${data.health.instanceId}:${state.current.chatId}` : "";
  const detectedPerspectives = perspectiveScope ? settings.detectedPerspectives[perspectiveScope] ?? state.lastPrepare?.perspectiveResolution?.perspectives ?? [] : [];
  const embedding = data.health?.embedding;
  const embeddingState = !data.health ? "서버 상태를 확인할 수 없음" : embedding?.ready ? `${embedding.model} · ${embedding.dimension}d · 사용 가능` : embedding?.configured ? `${embedding.model} · FTS로 대체 중` : "Voyage 키 없음 · FTS 사용 중";
  const connectionKind = data.health?.ok ? "is-ok" : data.connectionIssue?.kind === "unconfigured" ? "is-pending" : "is-error";
  const connectionTitle = data.health?.ok ? "RCM 서버 연결됨" : data.connectionIssue?.title ?? "RCM 서버 연결 안 됨";
  const voyageLabel = !data.health ? data.connectionIssue?.detail ?? "Voyage 상태 확인 불가" : embedding?.ready ? "Voyage 사용 가능" : embedding?.configured ? "Voyage 연결 확인 필요" : "Voyage 키 없음, FTS 사용 중";
  const serverLlm = data.health?.serverLlm ?? { maxInputTokens: 80000, maxOutputTokens: 24000, embeddingTimeoutMs: 15000, rerankTimeoutMs: 45000, llmTimeoutMs: 300000, engine: settings.extractionEngine, provider: "llm_gateway", endpoint: "https://api.llmgateway.io/v1/chat/completions", model: "auto", temperature: 0.2, thinking: "off", serviceTier: "standard", keyConfigured: false, configuredProviders: [] };
  const serverConnectionReady = data.health?.ok === true;
  const configuredProviders = new Set(serverLlm.configuredProviders ?? []);
  const serverLlmStatus = serverLlm.keyConfigured ? "인증정보 저장됨" : "인증정보 없음";
  const pluginUpdateAvailable = pluginUpdateNeeded(state.updateStatus);
  const nav: Array<[SettingsSection, string, string]> = [["chat", "현재 채팅", "이 대화에만 적용"], ["memory", "기억과 번역", "공통 동작과 화면"], ["server", "서버와 모델", "연결과 보조 모델"]];
  const pane = (key: SettingsSection, title: string, description: string, content: string) => `<section data-settings-pane="${key}" ${section === key ? "" : "hidden"}><div class="setting-section-copy"><h2>${title}</h2><p>${description}</p></div>${content}</section>`;
  const currentChat = pane("chat", "현재 채팅", "이 대화의 기억 처리 방식을 정합니다.", `
    <div class="setting-group"><h3>기억 사용</h3><div class="formgrid">
      <label class="field field--check"><span><input name="chatEnabled" type="checkbox" ${currentChatEnabled ? "checked" : ""} ${hasCurrentChat ? "" : "disabled"}> 이 채팅에서 RCM 사용</span><small class="muted">끄면 새 동기화와 기억 도구 호출을 만들지 않습니다.</small></label>
      ${dashboardChatProfileControl(currentProfile, !hasCurrentChat)}
      <label class="field field--check"><span><input name="includeUserMessages" type="checkbox" ${includeUserMessages ? "checked" : ""} ${hasCurrentChat ? "" : "disabled"}> 유저 메시지도 기억에 포함</span><small class="muted">유저가 서술한 행동과 대사도 기억 근거로 사용합니다.</small></label>
    </div></div>
    <div class="setting-group"><h3>관점과 정리</h3><div class="formgrid">
      <label class="field"><span>자동 감지된 관점</span><input value="${escapeHtml(detectedPerspectives.length ? detectedPerspectives.join(" · ") : "아직 감지 전")}" disabled><small class="muted">최근 요청에서 확인된 인물을 표시합니다.</small></label>
      <label class="field"><span>관점 직접 지정</span><input name="perspectives" value="${escapeHtml(perspectives)}" ${hasCurrentChat ? "" : "disabled"} placeholder="비워두면 자동 감지"><small class="muted">여러 인물은 쉼표로 구분합니다.</small></label>
      <label class="field"><span>기억 정본 언어</span><select name="memoryLanguage" ${hasCurrentChat ? "" : "disabled"}><option value="en" ${desiredMemoryLanguage === "en" ? "selected" : ""}>English</option><option value="ko" ${desiredMemoryLanguage === "ko" ? "selected" : ""}>한국어</option><option value="ja" ${desiredMemoryLanguage === "ja" ? "selected" : ""}>日本語</option><option value="zh" ${desiredMemoryLanguage === "zh" ? "selected" : ""}>中文</option></select><small class="muted">현재 ${escapeHtml(activeMemoryLanguage.toUpperCase())}${pendingMemoryLanguage ? ` · 다음 재생성부터 ${escapeHtml(pendingMemoryLanguage.toUpperCase())}` : ""}</small></label>
      <label class="field"><span>이 채팅의 기억 주입량</span><select name="chatMemoryBudget" ${hasCurrentChat ? "" : "disabled"}><option value="inherit" ${currentMemoryBudget === undefined ? "selected" : ""}>공통값 · ${settings.defaultMemoryBudget.toLocaleString()}</option>${[4_000, 6_000, 8_000, 12_000].map((value) => `<option value="${value}" ${currentMemoryBudget === value ? "selected" : ""}>${value.toLocaleString()} tokens</option>`).join("")}</select><small class="muted">공통값을 쓰거나 이 채팅만 다르게 설정합니다.</small></label>
    </div></div>
    <div class="setting-group"><h3>프롬프트 위치</h3><div class="settings-injection"><p><code>[[RCM]]</code>을 프리셋·캐릭터 설명·로어북 중 기억을 넣을 위치에 한 번 배치하세요.</p><p class="muted">여러 개가 있으면 첫 번째 위치만 사용합니다.</p></div></div>`);
  const memory = pane("memory", "기억과 번역", "채팅별 설정이 없을 때 사용할 공통 동작과 화면을 정합니다.", `
    <div class="setting-group"><h3>최근 대화 처리</h3><div class="formgrid settings-recent-grid">
      <label class="field"><span>원문 보호</span><input name="sourceProtectionTurns" type="number" min="1" max="20" step="1" value="${settings.sourceProtectionTurns}"><small class="muted">요청에 남은 최근 N턴과 겹치는 일반 기억을 줄입니다. 관계·약속 같은 현재 상태는 유지합니다. 실제로 보낼 원문 범위는 포켓리스가 정합니다.</small></label>
      <label class="field"><span>수정 보호</span><input name="editProtectionTurns" type="number" min="1" max="5" step="1" value="${settings.editProtectionTurns}"><small class="muted">최근 N턴은 수정이 끝날 때까지 기억 생성을 기다립니다.</small></label>
      <label class="field"><span>한 번에 정리할 턴</span><input name="extractionGroupTurns" type="number" min="1" max="50" step="1" value="${extractionGroupTurns}" ${hasCurrentChat ? "" : "disabled"}><small class="muted">보호가 끝난 턴을 몇 개씩 모아 기억을 만들지 정합니다. 입력 예산을 넘으면 원문을 보존하며 나누어 처리합니다.</small></label>
    </div></div>
    <div class="setting-group"><h3>원문 정규화</h3><div class="formgrid">
      <label class="field field--check"><span><input name="useLightboard" type="checkbox" ${settings.canonicalizationPolicy.useLightboard ? "checked" : ""}> Lightboard 데이터 제외</span><small class="muted">완전한 LBDATA와 lb-lazy 기술 태그만 보조 모델·검색 입력에서 제외합니다.</small></label>
    </div><div class="settings-regex-toolbar"><div><strong>추가 제외 규칙</strong><span>일치한 부분만 제거하며 위에서 아래 순서로 적용합니다.</span></div><button class="btn" type="button" data-action="add-regex-rule">+ 규칙 추가</button></div><details class="settings-regex-disclosure" data-regex-disclosure><summary><span class="settings-regex-summary"><strong><span data-regex-count>${settings.canonicalizationPolicy.customRules.length}</span>개 규칙</strong><small><span data-regex-active-count>${settings.canonicalizationPolicy.customRules.filter((rule) => rule.enabled).length}</span>개 사용 중</small></span></summary><div class="settings-regex-body"><div class="settings-regex-list" data-regex-rules>${settings.canonicalizationPolicy.customRules.map(regexRuleEditor).join("")}<div class="settings-regex-empty" data-regex-empty ${settings.canonicalizationPolicy.customRules.length ? "hidden" : ""}>추가한 제외 규칙이 없습니다.</div></div><p class="settings-regex-note" id="regex-flags-help">Flags 기본값은 <code>gis</code>입니다. 과거 기록에는 ‘원문 장부에서 다시 만들기’를 실행할 때 새 규칙이 적용됩니다.</p></div></details></div>
    <div class="setting-group"><h3>기억 사용</h3><div class="formgrid">
      <label class="field"><span>공통 기억 주입량</span><select name="defaultMemoryBudget">${[4_000, 6_000, 8_000, 12_000].map((value) => `<option value="${value}" ${settings.defaultMemoryBudget === value ? "selected" : ""}>${value.toLocaleString()} tokens</option>`).join("")}</select></label>
      <label class="field"><span>도구 호출당 최대 반환량</span><input name="mcpCap" type="number" min="1500" max="4000" step="100" value="${settings.mcpCap}"></label>
      <label class="field field--check"><span><input name="memoryToolsEnabled" type="checkbox" ${settings.memoryToolsEnabled ? "checked" : ""}> 메인 모델에 기억 도구 제공</span><small class="muted">끄면 자동 기억 주입만 사용합니다.</small></label>
      <label class="field field--check"><span><input name="postExtractionReview" type="checkbox" ${settings.postExtractionReview ? "checked" : ""}> 보조 모델로 한 번 더 재검수</span><small class="muted">정확도를 높이는 대신 호출량이 늘어납니다.</small></label>
    </div></div>
    <div class="setting-group"><h3>화면 표시</h3><div class="formgrid">
      <label class="field"><span>화면 테마</span><select name="dashboardTheme"><option value="dark" ${settings.dashboardTheme === "dark" ? "selected" : ""}>다크 모드</option><option value="light" ${settings.dashboardTheme === "light" ? "selected" : ""}>라이트 모드</option></select><small class="muted">이 기기의 플러그인 저장소에 저장됩니다.</small></label>
      <label class="field field--check"><span><input name="showKoreanTranslation" type="checkbox" ${settings.autoTranslate && settings.translationDisplay !== "en" ? "checked" : ""} ${activeMemoryLanguage === "ko" ? "disabled" : ""}> 한국어 번역 같이 보기</span><small class="muted">정본이 한국어이면 자동으로 생략합니다.</small></label>
      <label class="field"><span>번역 서비스</span><select name="translationProvider"><option value="google" ${settings.translationProvider === "google" ? "selected" : ""}>Google Translate</option><option value="risu" ${settings.translationProvider === "risu" ? "selected" : ""}>Yumi / Risu translator</option></select><small class="muted">기억 화면의 참고 번역에 사용합니다.</small></label>
      <div class="field"><span>번역 캐시</span><div class="settings-cache-row"><span class="muted">${cacheStats.items.toLocaleString()} / ${cacheStats.maxItems.toLocaleString()}개 · ${(cacheStats.bytes / 1024 / 1024).toFixed(1)} / ${(cacheStats.maxBytes / 1024 / 1024).toFixed(0)} MiB</span><button class="btn btn--icon settings-cache-clear" type="button" data-action="clear-translation-cache" aria-label="번역 캐시 비우기" title="번역 캐시 비우기">${icon("delete")}</button></div><small class="muted">서버에 저장되어 다른 기기에서도 재사용됩니다.</small></div>
    </div></div>`);
  const server = pane("server", "서버와 모델", "서버 연결과 기억 추출 모델을 관리합니다.", `
    <div class="settings-connection ${connectionKind}" role="status"><span class="settings-connection__mark">${icon(data.health?.ok ? "check" : data.connectionIssue?.kind === "unconfigured" ? "clock" : "error")}</span><div><strong>${connectionTitle}</strong><small>${data.health?.version ? `버전 ${escapeHtml(data.health.version)} · ` : ""}${voyageLabel}</small></div></div>
    <div class="setting-group"><h3>기본 연결</h3><div class="formgrid">
      <label class="field"><span>서버 주소</span><input name="serverUrl" value="${escapeHtml(settings.serverUrl)}"></label>
      <label class="field"><span>서버 토큰</span><input name="serverToken" type="password" value="${escapeHtml(settings.serverToken)}" autocomplete="new-password"></label>
      <label class="field"><span>추출 처리</span><select name="extractionEngine"><option value="risu" ${settings.extractionEngine === "risu" ? "selected" : ""}>Risu 보조 모델</option><option value="server" ${settings.extractionEngine === "server" ? "selected" : ""}>RCM 서버</option></select></label>
      <label class="field" data-engine-fields="risu" ${settings.extractionEngine === "risu" ? "" : "hidden"}><span>Risu 모델 슬롯</span><select name="auxiliaryMode">${[["main", "Main"], ["memory", "Memory"], ["otherAx", "Other AX"], ["static", "고정 모델 ID"]].map(([value, label]) => `<option value="${value}" ${settings.auxiliaryMode === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label class="field" data-engine-fields="risu" data-static-model ${settings.extractionEngine === "risu" && settings.auxiliaryMode === "static" ? "" : "hidden"}><span>고정 모델 ID</span><input name="staticModel" value="${escapeHtml(settings.staticModel)}"></label>
      <label class="field"><span>임베딩</span><input value="${escapeHtml(embeddingState)}" disabled></label>
    </div></div>
    <div class="setting-group"><h3>업데이트</h3>${state.updateStatus?.configured
      ? `<div class="settings-connection ${state.updateStatus.error ? "is-error" : state.updateStatus.available || state.updateStatus.restartRequired || pluginUpdateAvailable ? "is-pending" : "is-ok"}" role="status"><span class="settings-connection__mark">${icon(state.updateStatus.error ? "error" : state.updateStatus.available || state.updateStatus.restartRequired || pluginUpdateAvailable ? "clock" : "check")}</span><div><strong>${state.updateStatus.restartRequired ? state.updateStatus.canApplyAutomatically ? "서버 업데이트 설치 가능" : "서버 재시작 필요" : state.updateStatus.available ? `${escapeHtml(state.updateStatus.latestVersion ?? "새 버전")} 설치 가능` : pluginUpdateAvailable ? "플러그인 업데이트 필요" : "최신 버전 사용 중"}</strong><small>현재 서버 ${escapeHtml(state.updateStatus.currentServerVersion)} · 정식 채널${pluginUpdateAvailable ? ` · 플러그인 ${escapeHtml(state.updateStatus.latestPluginVersion ?? "새 버전")}` : ""}</small></div></div><div class="actions">${state.updateStatus.restartRequired && state.updateStatus.canApplyAutomatically || state.updateStatus.available && state.updateStatus.canStageServer ? `<button class="btn btn--primary" type="button" data-action="stage-server-update">${state.updateStatus.canApplyAutomatically ? "서버 업데이트 설치" : "서버 업데이트 준비"}</button>` : ""}<button class="btn" type="button" data-action="check-update">업데이트 다시 확인</button></div><p class="muted">${pluginUpdateAvailable ? `Risu 플러그인 메뉴의 + 버튼으로 RCM ${escapeHtml(state.updateStatus.latestPluginVersion ?? "새 버전")}을 설치해 주세요. ` : ""}서버 파일은 체크섬을 확인한 뒤 적용합니다. 자동 적용을 지원하는 설치에서는 재시작과 완료 확인까지 진행하며, 설정·토큰·기억 DB는 유지됩니다.</p>`
      : '<p class="muted">이 빌드에는 업데이트 채널이 연결되어 있지 않습니다. 릴리스 검사 빌드에서는 정상입니다.</p>'}</div>
    <div class="setting-group"><h3>보조 모델 처리량</h3><div class="formgrid">
      <label class="field"><span>호출당 최대 입력 토큰</span><input name="maxInputTokens" type="number" min="1024" step="1" value="${serverLlm.maxInputTokens ?? 80000}"><small class="muted">지시문과 원문, 이전 응답을 합친 한도입니다. 긴 입력은 원문을 보존하며 나누어 처리합니다.</small></label>
      <label class="field" data-engine-fields="server" ${settings.extractionEngine === "server" ? "" : "hidden"}><span>호출당 최대 출력 토큰</span><input name="maxOutputTokens" type="number" min="256" step="1" value="${serverLlm.maxOutputTokens ?? 24000}"><small class="muted">서버 모델에 전달할 출력 상한입니다.</small></label>
      <div class="field" data-engine-fields="risu" ${settings.extractionEngine === "risu" ? "" : "hidden"}><span>최대 출력 토큰</span><p class="muted">선택한 Risu 보조 모델의 출력 설정을 사용합니다.</p><small class="muted">Risu 호출의 취소와 대기 시간은 호스트가 제어합니다. RCM의 서버 대기 시간은 Risu 호출에 적용되지 않습니다.</small></div>
    </div><details class="settings-advanced"><summary>고급 서버 시간 설정</summary><div class="formgrid">
      <label class="field"><span>임베딩 대기 시간 · 초</span><input name="embeddingTimeoutSeconds" type="number" min="0.25" max="60" step="0.25" value="${(serverLlm.embeddingTimeoutMs ?? 15000) / 1000}"></label>
      <label class="field"><span>재정렬 대기 시간 · 초</span><input name="rerankTimeoutSeconds" type="number" min="1" max="90" step="1" value="${(serverLlm.rerankTimeoutMs ?? 45000) / 1000}"></label>
      <label class="field"><span>서버 보조 모델 대기 시간 · 초</span><input name="llmTimeoutSeconds" type="number" min="30" max="900" step="1" value="${(serverLlm.llmTimeoutMs ?? 300000) / 1000}"></label>
    </div></details></div>
    <div class="setting-group settings-provider" data-engine-fields="server" ${settings.extractionEngine === "server" ? "" : "hidden"}><h3>고급 연결 설정 <span class="muted" data-provider-key-status>· ${serverLlmStatus}</span></h3><div class="formgrid">
      <label class="field"><span>프로바이더</span><select name="serverLlmProvider" data-configured-providers="${escapeHtml([...configuredProviders].join(","))}"><option value="vertex" ${serverLlm.provider === "vertex" ? "selected" : ""}>Vertex AI</option><option value="gemini_api" ${serverLlm.provider === "gemini_api" ? "selected" : ""}>Google Gemini API</option><option value="llm_gateway" ${serverLlm.provider === "llm_gateway" ? "selected" : ""}>LLM Gateway / OpenAI 호환</option><option value="ollama_cloud" ${serverLlm.provider === "ollama_cloud" ? "selected" : ""}>Ollama Cloud</option></select></label>
      <label class="field"><span>엔드포인트</span><input name="serverLlmEndpoint" value="${escapeHtml(serverLlm.endpoint)}"></label>
      <label class="field"><span>API 키 / 서비스 계정 JSON</span><input name="serverLlmApiKey" type="password" autocomplete="new-password" placeholder="${serverLlm.keyConfigured ? "저장된 인증정보 유지 (변경할 때만 입력)" : "인증정보 입력"}"></label>
      <label class="field"><span>모델 ID</span><input name="serverLlmModel" value="${escapeHtml(serverLlm.model)}"></label>
      <label class="field"><span>Temperature</span><input name="serverLlmTemperature" type="number" min="0" max="2" step="0.05" value="${serverLlm.temperature}"></label>
      <label class="field"><span>Thinking</span><select name="serverLlmThinking">${[["default", "Provider default"], ["off", "Off"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]].map(([value, label]) => `<option value="${value}" ${serverLlm.thinking === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label class="field"><span>처리 등급</span><select name="serverLlmServiceTier" ${serverLlm.provider === "gemini_api" || serverLlm.provider === "ollama_cloud" ? "disabled" : ""}><option value="standard" ${serverLlm.serviceTier === "standard" ? "selected" : ""}>Standard</option><option value="flex" ${serverLlm.serviceTier === "flex" ? "selected" : ""}>Flex · 저렴하지만 느림</option><option value="priority" ${serverLlm.serviceTier === "priority" ? "selected" : ""}>Priority · 더 비싸지만 우선 처리</option></select><small class="muted">서버 연결을 먼저 확인한 뒤 모델과 인증정보를 함께 저장합니다. Gemini API direct와 Ollama Cloud는 Standard만 지원합니다.</small></label>
    </div>${serverConnectionReady && configuredProviders.size ? `<button class="btn btn--danger" type="button" data-action="remove-server-llm-key" ${serverLlm.keyConfigured ? "" : "hidden"}>현재 인증정보 제거</button>` : ""}</div>`);
  const voyage = `<div class="setting-group" data-settings-voyage ${section === "server" ? "" : "hidden"}><h3>Voyage 임베딩</h3><form id="voyage-form"><label class="field"><span>새 Voyage API 키</span><input name="voyageApiKey" type="password" autocomplete="new-password" placeholder="저장된 인증정보 유지 (변경할 때만 입력)" ${voyageBusy ? "disabled" : ""}><small class="muted">새 키를 입력하면 상단 저장 시 검증 후 서버에 저장합니다.</small></label>${embedding?.configured ? '<div class="actions"><button class="btn btn--danger" type="button" data-action="remove-voyage-key">저장된 키 제거</button></div>' : ""}${voyageState ? `<div class="notice" role="${voyageState.kind === "success" ? "status" : "alert"}">${icon(voyageState.kind === "success" ? "check" : "error")}<div>${escapeHtml(voyageState.message)}</div></div>` : ""}</form></div>`;
  const saveAction = `<button class="btn btn--primary settings-save-action" type="button" data-action="save-settings" aria-label="설정 저장" title="설정 저장" ${voyageBusy ? "disabled" : ""}><span class="settings-save-action__icon">${icon("save")}</span><span class="settings-save-action__label">${voyageBusy ? "저장 중…" : "저장"}</span></button>`;
  return `<section class="management-page settings-page">${pageHeader("설정", "현재 채팅과 기억 처리 방식을 관리합니다.", saveAction)}<div class="settings-layout"><nav class="settings-nav" aria-label="설정 구간">${nav.map(([key, title, note]) => `<button type="button" data-action="settings-section" data-section="${key}" aria-current="${section === key ? "page" : "false"}"><span><strong>${title}</strong><small>${note}</small></span>${icon("arrow-right")}</button>`).join("")}</nav><main class="settings-panel"><div class="settings-scroll"><form id="settings-form">${currentChat}${memory}${server}</form>${voyage}</div></main></div></section>`;
}

export async function loadDashboardData(
  state: RuntimeState,
  client: ServerClient,
  options: { tab?: Tab; previous?: DashboardData } = {},
): Promise<DashboardData> {
  const contextPromise = readOptionalCurrentContext(state);
  if (!isServerConfigured(state.settings)) {
    const contextCall = await Promise.resolve(contextPromise).then(
      (value) => ({ status: "fulfilled", value }) as PromiseFulfilledResult<any>,
      (reason) => ({ status: "rejected", reason }) as PromiseRejectedResult,
    );
    return {
      ...emptyData(),
      contextError: contextCall.status === "rejected" ? String(contextCall.reason) : contextCall.value.error,
      connectionIssue: describeServerConnectionIssue(state.settings),
    };
  }
  const [healthCall, contextCall] = await Promise.allSettled([
    client.request<any>("/v1/health", {}, SERVER_STATUS_TIMEOUT_MS),
    contextPromise,
  ]);
  const optionalContext = contextCall.status === "fulfilled" ? contextCall.value : { error: String(contextCall.reason) };
  const context = optionalContext.context;
  let previous = options.previous && options.previous.chatId === context?.chatId ? options.previous : emptyData();
  if (healthCall.status === "fulfilled" && Number(healthCall.value?.apiRevision) !== RCM_API_REVISION) {
    throw new Error(`RCM API revision mismatch: expected ${RCM_API_REVISION}, received ${String(healthCall.value?.apiRevision ?? "unknown")}`);
  }
  const adminCall = healthCall.status === "fulfilled"
    ? await Promise.resolve(client.request<any>("/v1/admin/chats")).then(
      (value) => ({ status: "fulfilled", value }) as PromiseFulfilledResult<any>,
      (reason) => ({ status: "rejected", reason }) as PromiseRejectedResult,
    )
    : { status: "rejected", reason: healthCall.reason } as PromiseRejectedResult;
  const adminChats = adminCall.status === "fulfilled" ? adminCall.value.items ?? [] : previous.adminChats;
  const serverHasCurrent = Boolean(context && adminChats.some((chat: any) => chat.id === context.chatId));
  // A successful inventory confirms deletion. Only an unavailable inventory
  // may keep cached chat data while the connection recovers.
  if (context && adminCall.status === "fulfilled" && !serverHasCurrent) previous = emptyData();
  const requested = new Set(options.tab ? dashboardDatasetsForTab(options.tab) : ALL_DASHBOARD_DATASETS);
  const endpoint = (dataset: DashboardChatDataset): string => {
    const chat = encodeURIComponent(context!.chatId);
    const paths: Record<DashboardChatDataset, string> = {
      memories: "memories", messages: "messages", relationships: "relationships", world: "world-state?includeHistory=true",
      conflicts: "conflicts", jobs: "jobs", recallLogs: "recall-logs", entities: "entities", reviews: "reconciliation-reviews",
      lineage: "lineage", socialKnowledge: "social-knowledge", physicalIntimacy: "physical-intimacy", status: "status",
      audits: "extraction-audits", initialCalibration: "initial-calibration", storySpine: "story-spine",
    };
    return `/v1/chats/${chat}/${paths[dataset]}`;
  };
  const chatCalls = new Map<DashboardChatDataset, PromiseSettledResult<any>>();
  if (context && serverHasCurrent && healthCall.status === "fulfilled" && adminCall.status === "fulfilled") {
    await Promise.all([...requested].map(async (dataset) => {
      const result = await Promise.resolve(client.request<any>(endpoint(dataset))).then(
        (value) => ({ status: "fulfilled", value }) as PromiseFulfilledResult<any>,
        (reason) => ({ status: "rejected", reason }) as PromiseRejectedResult,
      );
      chatCalls.set(dataset, result);
    }));
  }
  const value = (dataset: DashboardChatDataset, fallback: any) => chatCalls.get(dataset)?.status === "fulfilled"
    ? (chatCalls.get(dataset) as PromiseFulfilledResult<any>).value
    : fallback;
  const worldState = value("world", {
    assertions: previous.assertions, beliefs: previous.beliefs, promises: previous.promises,
    endedAssertions: previous.endedAssertions, endedBeliefs: previous.endedBeliefs,
    userDeletedBeliefs: previous.userDeletedBeliefs, promiseHistory: previous.promiseHistory,
  });
  const relationshipState = value("relationships", { items: previous.relationships, events: previous.relationshipEvents });
  const jobsState = value("jobs", {
    items: previous.jobs, cancelledMessages: previous.cancelledMessages, waitingForAssistant: previous.waitingForAssistant,
    bufferedMessages: previous.bufferedMessages, bufferedTurns: previous.bufferedTurns, bufferedSourceTokens: previous.bufferedSourceTokens,
    extractionGroupTurns: previous.extractionGroupTurns, recoverableMessages: previous.recoverableMessages,
    historicalBackfillMessages: previous.historicalBackfillMessages, ingestionState: previous.ingestionState,
  });
  const lineage = value("lineage", previous.lineage ?? { status: "none" }) as ChatLineageStatus;
  const currentAdmin = context ? adminChats.find((chat: any) => chat.id === context.chatId) : undefined;
  const currentHasDerived = currentAdmin && ["memories", "relationships", "assertions", "beliefs", "promises"].some((key) => Number(currentAdmin[key] ?? 0) > 0);
  if (requested.has("lineage") && context && healthCall.status === "fulfilled" && healthCall.value?.capabilities?.readOnlyLineageProbe && lineage.status === "none" && !currentHasDerived) {
    await probeDashboardLineage(state, client, context);
  } else if (requested.has("lineage") && (!context || lineage.status !== "none" || currentHasDerived)) {
    state.lineageProbe = undefined;
  }
  return {
    chatId: context?.chatId,
    health: healthCall.status === "fulfilled" ? healthCall.value : previous.health,
    memories: value("memories", { items: previous.memories }).items,
    storySpine: value("storySpine", previous.storySpine),
    messages: value("messages", { items: previous.messages }).items,
    relationships: relationshipState.items,
    relationshipEvents: relationshipState.events ?? [],
    coldStartProgress: value("status", { progress: previous.coldStartProgress }).progress,
    physicalIntimacy: value("physicalIntimacy", { items: previous.physicalIntimacy }).items,
    entities: value("entities", { items: previous.entities }).items,
    socialKnowledge: value("socialKnowledge", { items: previous.socialKnowledge }).items,
    socialKnowledgeJobs: value("socialKnowledge", { jobs: previous.socialKnowledgeJobs }).jobs ?? {},
    assertions: worldState.assertions ?? [],
    beliefs: worldState.beliefs ?? [],
    promises: worldState.promises ?? [],
    endedAssertions: worldState.endedAssertions ?? [],
    endedBeliefs: worldState.endedBeliefs ?? [],
    userDeletedBeliefs: worldState.userDeletedBeliefs ?? [],
    promiseHistory: worldState.promiseHistory ?? [],
    conflicts: value("conflicts", { items: previous.conflicts }).items,
    reconciliationReviews: value("reviews", { items: previous.reconciliationReviews }).items,
    extractionAudits: value("audits", { items: previous.extractionAudits }).items,
    initialCalibration: value("initialCalibration", previous.initialCalibration),
    jobs: jobsState.items,
    cancelledMessages: Number(jobsState.cancelledMessages ?? 0),
    waitingForAssistant: Number(jobsState.waitingForAssistant ?? 0),
    bufferedMessages: Number(jobsState.bufferedMessages ?? 0),
    bufferedTurns: Number(jobsState.bufferedTurns ?? 0),
    bufferedSourceTokens: Number(jobsState.bufferedSourceTokens ?? 0),
    extractionGroupTurns: Number(jobsState.extractionGroupTurns ?? 6),
    recoverableMessages: Number(jobsState.recoverableMessages ?? 0),
    historicalBackfillMessages: Number(jobsState.historicalBackfillMessages ?? 0),
    ingestionState: jobsState.ingestionState,
    recallLogs: value("recallLogs", { items: previous.recallLogs }).items,
    adminChats,
    lineage,
    jobsError: requested.has("jobs")
      ? chatCalls.get("jobs")?.status === "rejected" ? String((chatCalls.get("jobs") as PromiseRejectedResult).reason) : undefined
      : previous.jobsError,
    adminError: adminCall.status === "rejected" ? String(adminCall.reason) : undefined,
    contextError: optionalContext.error,
    error: healthCall.status === "rejected" ? String(healthCall.reason) : undefined,
    connectionIssue: healthCall.status === "rejected" ? describeServerConnectionIssue(state.settings, healthCall.reason) : undefined,
  };
}

async function applyHostTheme(preferredTheme?: RuntimeState["settings"]["dashboardTheme"]): Promise<void> {
  try {
    const style = await (await risuai.getRootDocument()).getStyleAttribute();
    for (const name of ["bgcolor", "darkbg", "selected", "darkborderc", "borderc", "textcolor", "textcolor2", "draculared"]) {
      const match = style.match(new RegExp(`--risu-theme-${name}\\s*:\\s*([^;]+)`));
      if (match?.[1]) document.documentElement.style.setProperty(`--risu-theme-${name}`, match[1].trim());
    }
  } catch { /* documented fallbacks remain active */ }
  const hostBackground = getComputedStyle(document.documentElement).getPropertyValue("--risu-theme-bgcolor");
  document.documentElement.dataset.rcmTheme = preferredTheme
    ?? dashboardThemeFromColor(hostBackground, window.matchMedia("(prefers-color-scheme: dark)").matches);
}

export async function openDashboard(state: RuntimeState, client: ServerClient): Promise<void> {
  document.documentElement.lang = "ko";
  document.documentElement.dataset.rcmTheme = state.settings.dashboardTheme;
  document.title = "Risu Cognitive Memory";
  document.head.innerHTML = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${styles}${dashboardStyles}${interactionStyles}${storyStyles}${managementStyles}</style>`;
  document.body.innerHTML = '<div id="app" class="app" aria-busy="true"></div>';
  const root = document.getElementById("app")!;
  let activeTab: Tab = "overview";
  let worldKind: WorldKind = "assertions";
  const worldView: WorldViewState = { selectedId: "", query: "", filter: "current", holder: "", mobileDetail: false };
  let worldEditor: WorldEditor | undefined;
  let selectedMemory = "";
  const organizationView = createOrganizationView();
  let organizationChatId = state.current?.chatId;
  const timelineView: TimelineViewState = { query: "", landmarkOnly: false, pinnedOnly: false, includeInactive: false, detailMode: "translation", editing: false, creating: false, mobileDetail: false };
  const storyView: StoryViewState = { selectedGroupId: "", query: "", indexOpen: false, detailMode: "translation", expandedMemoryId: "", editingOverview: false };
  const peopleView: PeopleViewState = { selectedId: "", query: "", prominence: "all", editing: false, mobileDetail: false, management: "" };
  let selectedRelationship = "";
  let relationshipSection = "state";
  let relationshipEditing = false;
  let relationshipStateView = "list";
  let relationshipPerson = "";
  let relationshipMobileDetail = false;
  let relationshipQuery = "";
  let relationshipIntimacyOnly = false;
  let intimacyEditor: IntimacyEditor | undefined;
  let socialEditor: SocialEditor | undefined;
  let entityMergePreview: any | undefined;
  let voyageSaveState: ActionState | undefined;
  let actionSaveState: ActionState | undefined;
  let actionSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let settingsSaving = false;
  let voyageSaveBusy = false;
  const attentionView: AttentionViewState = { selectedId: "", query: "", filter: "all", mobileDetail: false };
  let settingsSection: SettingsSection = "chat";
  let data = emptyData();
  let dashboardOpen = true;
  let refreshGeneration = 0;
  let refreshing = true;
  let activityWasBusy = false;
  let lastServerActivitySignature = "";
  let lastLiveDataSignature = "";
  let activityRefreshPending = false;
  let formDirty = false;
  let newDataAvailable = false;
  let pendingData: DashboardData | undefined;
  let renderedPageTab: Tab | undefined;
  let renderedPageContent = "";
  let deferredPageRender = false;
  const dataView: DataViewState = { inventoryStatus: "idle", inventory: [], query: "", filter: "all", inheritanceOpen: false, inheritanceQuery: "" };
  let cacheStats: TranslationCacheStats = { items: 0, bytes: 0, maxItems: 50_000, maxBytes: 128 * 1024 * 1024 };
  const translations: TranslationView = new Map();
  const translationRequested = new Set<string>();
  const pendingTranslationPatches = new Set<string>();
  let translationObserver: IntersectionObserver | undefined;
  let unsubscribeActivity: (() => void) | undefined;
  const activeCanonicalLanguage = (chatId = state.current?.chatId): MemoryLanguage => {
    if (!chatId) return "en";
    if (state.current?.chatId === chatId && state.lastPrepare?.memoryLanguage) return state.lastPrepare.memoryLanguage;
    return (data.adminChats.find((chat) => chat.id === chatId)?.memoryLanguage as MemoryLanguage | undefined)
      ?? state.settings.memoryLanguages[chatId]
      ?? "en";
  };

  const applyTimelineSearch = () => {
    const query = timelineView.query.trim().toLocaleLowerCase();
    let visible = 0;
    root.querySelectorAll<HTMLElement>("#memory-rows > .row").forEach((row) => {
      const match = !query || Boolean(row.textContent?.toLocaleLowerCase().includes(query));
      row.hidden = !match;
      if (match) visible += 1;
    });
    let visibleChildren = 0;
    root.querySelectorAll<HTMLDetailsElement>("#memory-rows > .capsule-children").forEach((group) => {
      let childVisible = 0;
      group.querySelectorAll<HTMLElement>(".row").forEach((row) => {
        const match = !query || Boolean(row.textContent?.toLocaleLowerCase().includes(query));
        row.hidden = !match;
        if (match) childVisible += 1;
      });
      group.hidden = childVisible === 0;
      visibleChildren += childVisible;
    });
    const count = root.querySelector<HTMLElement>("[data-timeline-count]");
    if (count) count.textContent = `기억 ${visible}개`;
    const empty = root.querySelector<HTMLElement>("[data-timeline-search-empty]");
    if (empty) empty.hidden = !query || visible + visibleChildren > 0;
  };

  const applyPeopleSearch = () => {
    const query = peopleView.query.trim().toLocaleLowerCase();
    let visible = 0;
    root.querySelectorAll<HTMLElement>("[data-people-group]").forEach((group) => {
      let groupVisible = 0;
      group.querySelectorAll<HTMLElement>("[data-person-row]").forEach((row) => {
        const match = !query || Boolean(row.textContent?.toLocaleLowerCase().includes(query));
        row.hidden = !match;
        if (match) groupVisible += 1;
      });
      group.hidden = groupVisible === 0;
      if (query && groupVisible) (group as HTMLDetailsElement).open = true;
      visible += groupVisible;
    });
    const count = root.querySelector<HTMLElement>("[data-people-count]");
    if (count) count.textContent = `${visible}명`;
    const empty = root.querySelector<HTMLElement>("[data-people-search-empty]");
    if (empty) empty.hidden = visible > 0;
  };

  const applyWorldSearch = () => {
    const query = worldView.query.trim().toLocaleLowerCase();
    let visible = 0;
    root.querySelectorAll<HTMLElement>("[data-world-group]").forEach((group) => {
      let groupVisible = 0;
      group.querySelectorAll<HTMLElement>("[data-world-row]").forEach((row) => {
        const match = !query || Boolean(row.textContent?.toLocaleLowerCase().includes(query));
        row.hidden = !match;
        if (match) groupVisible += 1;
      });
      group.hidden = groupVisible === 0;
      visible += groupVisible;
    });
    const count = root.querySelector<HTMLElement>("[data-world-count]");
    if (count) count.textContent = `${visible}개`;
    const empty = root.querySelector<HTMLElement>("[data-world-search-empty]");
    if (empty) empty.hidden = !query || visible > 0;
  };

  const applyStorySearch = () => {
    const query = storyView.query.trim().toLocaleLowerCase();
    let visible = 0;
    root.querySelectorAll<HTMLElement>("[data-story-row]").forEach((row) => {
      const match = !query || Boolean(row.textContent?.toLocaleLowerCase().includes(query));
      row.hidden = !match;
      if (match) visible += 1;
    });
    const empty = root.querySelector<HTMLElement>("[data-story-search-empty]");
    if (empty) empty.hidden = !query || visible > 0;
  };

  const applyRelationshipSearch = () => {
    const query = relationshipQuery.trim().toLocaleLowerCase();
    let visible = 0;
    root.querySelectorAll<HTMLElement>("[data-relationship-group]").forEach((group) => {
      let groupVisible = 0;
      group.querySelectorAll<HTMLElement>("[data-relationship-row]").forEach((row) => {
        const match = !query || Boolean(row.textContent?.toLocaleLowerCase().includes(query));
        row.hidden = !match;
        if (match) groupVisible += 1;
      });
      group.hidden = groupVisible === 0;
      if (query && groupVisible) (group as HTMLDetailsElement).open = true;
      visible += groupVisible;
    });
    const count = root.querySelector<HTMLElement>("[data-relationship-count]");
    if (count) count.textContent = `${visible}개`;
    const empty = root.querySelector<HTMLElement>("[data-relationship-search-empty]");
    if (empty) empty.hidden = visible > 0;
  };

  const applyAttentionSearch = () => {
    const query = attentionView.query.trim().toLocaleLowerCase();
    let visible = 0;
    root.querySelectorAll<HTMLElement>("[data-attention-row]").forEach((row) => {
      const match = !query || Boolean(row.textContent?.toLocaleLowerCase().includes(query));
      row.hidden = !match;
      if (match) visible += 1;
    });
    const empty = root.querySelector<HTMLElement>("[data-attention-search-empty]");
    if (empty) empty.hidden = !query || visible > 0;
  };

  const hasActiveSelection = (): boolean => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    const node = selection.getRangeAt(0).commonAncestorContainer;
    return root.contains(node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement);
  };

  const editorSignature = (form: HTMLFormElement): string => JSON.stringify(Array.from(form.elements).flatMap((element) => {
    const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (!control.name) return [];
    return [[control.name, control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked : control.value]];
  }));

  const setEditorBaselines = (scope: ParentNode = root) => {
    scope.querySelectorAll<HTMLFormElement>("#memory-form, #manual-memory-form, #story-overview-form, #intimacy-form, #social-form, #world-state-form, #relationship-form, .person-editor, .initial-relationship-editor").forEach((form) => {
      form.dataset.initialSignature = editorSignature(form);
    });
    scope.querySelectorAll<HTMLElement>("[data-dirty-only]").forEach((control) => { control.hidden = true; });
  };

  const editorHasChanges = (): boolean => {
    return Array.from(root.querySelectorAll<HTMLFormElement>("#memory-form, #manual-memory-form, #story-overview-form, #intimacy-form, #social-form, #world-state-form, #relationship-form, .person-editor, .initial-relationship-editor"))
      .some((form) => form.dataset.initialSignature !== undefined && editorSignature(form) !== form.dataset.initialSignature);
  };

  const syncEditorDirtyState = () => {
    formDirty = editorHasChanges();
    root.querySelectorAll<HTMLElement>("[data-dirty-only]").forEach((control) => { control.hidden = !formDirty; });
  };

  const persistSettingsForm = async (form: HTMLFormElement) => {
    const formData = new FormData(form);
    const values = Object.fromEntries(formData);
    const includeUserMessages = formData.has("includeUserMessages");
    const chatEnabled = formData.has("chatEnabled");
    const chatEnabledById = { ...state.settings.chatEnabled };
    const catchUpPending = { ...state.settings.chatCatchUpPending };
    const chatWasEnabled = state.current ? isChatMemoryEnabled(state.settings, state.current.chatId) : false;
    if (state.current) {
      chatEnabledById[state.current.chatId] = chatEnabled;
      if (!chatWasEnabled && chatEnabled) catchUpPending[state.current.chatId] = true;
      if (!chatEnabled) delete catchUpPending[state.current.chatId];
    }
    const perChat = { ...state.settings.includeUserMessages };
    if (state.current) perChat[state.current.chatId] = includeUserMessages;
    const extractionGroupTurns = Math.min(50, Math.max(1, Math.round(Number(values.extractionGroupTurns ?? 6))));
    const sourceProtectionTurns = Math.min(20, Math.max(1, Math.round(Number(values.sourceProtectionTurns ?? 10))));
    const editProtectionTurns = Math.min(5, Math.max(1, Math.round(Number(values.editProtectionTurns ?? 2))));
    const customRules: CanonicalRemovalRule[] = Array.from(form.querySelectorAll<HTMLElement>("[data-regex-rule]")).map((row) => ({
      name: row.querySelector<HTMLInputElement>('input[name="customRuleName"]')?.value.trim() ?? "",
      enabled: row.querySelector<HTMLInputElement>('input[name="customRuleEnabled"]')?.checked === true,
      pattern: row.querySelector<HTMLInputElement>('input[name="customRulePattern"]')?.value ?? "",
      flags: row.querySelector<HTMLInputElement>('input[name="customRuleFlags"]')?.value.trim() || "gis",
    }));
    for (const [index, rule] of customRules.entries()) {
      if (!rule.name) throw new Error(`추가 제외 규칙 ${index + 1}의 이름을 입력하세요.`);
      const error = validateCanonicalRemovalRule(rule);
      if (error) throw new Error(`추가 제외 규칙 ${index + 1}: ${error}`);
    }
    const perChatGroupTurns = { ...state.settings.extractionGroupTurns };
    if (state.current) perChatGroupTurns[state.current.chatId] = extractionGroupTurns;
    const memoryLanguage = ["en", "ko", "ja", "zh"].includes(String(values.memoryLanguage)) ? String(values.memoryLanguage) as "en" | "ko" | "ja" | "zh" : "en";
    const memoryLanguages = { ...state.settings.memoryLanguages };
    if (state.current) memoryLanguages[state.current.chatId] = memoryLanguage;
    const allowedMemoryBudgets = new Set([4_000, 6_000, 8_000, 12_000]);
    const defaultMemoryBudget = allowedMemoryBudgets.has(Number(values.defaultMemoryBudget))
      ? Number(values.defaultMemoryBudget) as 4000 | 6000 | 8000 | 12000
      : 6000;
    const memoryBudgets = { ...state.settings.memoryBudgets };
    if (state.current) {
      if (values.chatMemoryBudget === "inherit") delete memoryBudgets[state.current.chatId];
      else if (allowedMemoryBudgets.has(Number(values.chatMemoryBudget))) memoryBudgets[state.current.chatId] = Number(values.chatMemoryBudget) as 4000 | 6000 | 8000 | 12000;
    }
    const nextServerConnection = {
      serverUrl: String(values.serverUrl).trim().replace(/\/$/, ""),
      serverToken: String(values.serverToken).trim(),
    };
    let verifiedHealth = data.health;
    const bootstrappingServerConnection = settingsConnectionNeedsHealthProbe(state.settings, nextServerConnection, verifiedHealth);
    if (bootstrappingServerConnection) {
      const previousSettings = state.settings;
      state.settings = { ...state.settings, ...nextServerConnection };
      try {
        verifiedHealth = await client.request<any>("/v1/health");
      } finally {
        state.settings = previousSettings;
      }
    }
    if (verifiedHealth?.ok && Number(verifiedHealth.apiRevision ?? 0) !== RCM_API_REVISION) {
      throw new Error(`RCM API revision mismatch: expected ${RCM_API_REVISION}, received ${String(verifiedHealth.apiRevision ?? "unknown")}`);
    }
    if (state.current && memoryLanguage !== (state.settings.memoryLanguages[state.current.chatId] ?? "en")
      && (Number(verifiedHealth?.apiRevision ?? 0) !== RCM_API_REVISION || !verifiedHealth?.capabilities?.multilingualCanonicalMemory)) {
      throw new Error("현재 RCM 서버 계약에서만 기억 정본 언어를 변경할 수 있습니다.");
    }
    const perspectives = { ...state.settings.perspectives };
    const perspectiveNames = String(values.perspectives ?? "").split(/[,\n]/).map((name) => name.trim()).filter(Boolean);
    if (state.current) perspectives[state.current.chatId] = [...new Set(perspectiveNames)].slice(0, 4);
    const extractionEngine: ServerLlmPublicConfig["engine"] = values.extractionEngine === "server" ? "server" : "risu";
    if (extractionEngine === "server" && (Number(verifiedHealth?.apiRevision ?? 0) !== RCM_API_REVISION || !verifiedHealth?.serverLlm || !verifiedHealth?.capabilities?.serverServiceTier)) {
      throw new Error("RCM 서버 계약이 맞지 않습니다. 현재 빌드로 업데이트하고 재시작한 뒤 다시 저장하세요.");
    }
    if (state.settings.extractionEngine === "risu" && extractionEngine === "server" && state.workerBusy) {
      throw new Error("현재 Risu 보조모델 호출이 끝난 뒤 처리 방식을 변경하세요. 실행 중인 Risu 호출은 API로 취소할 수 없습니다.");
    }
    const memoryToolsWereEnabled = state.settings.memoryToolsEnabled;
    const priorTranslationPreference = state.settings.autoTranslate && state.settings.translationDisplay !== "en";
    const showKoreanTranslation = resolveTranslationPreference(activeCanonicalLanguage(), priorTranslationPreference, formData.has("showKoreanTranslation"));
    state.settings = { ...state.settings, ...nextServerConnection, extractionEngine, postExtractionReview: formData.has("postExtractionReview"), auxiliaryMode: String(values.auxiliaryMode) as any, staticModel: String(values.staticModel), translationProvider: values.translationProvider === "risu" ? "risu" : "google", translationDisplay: showKoreanTranslation ? "bilingual" : "en", autoTranslate: showKoreanTranslation, dashboardTheme: values.dashboardTheme === "light" ? "light" : "dark", defaultMemoryBudget, memoryBudgets, mcpCap: Number(values.mcpCap), memoryToolsEnabled: formData.has("memoryToolsEnabled"), chatEnabled: chatEnabledById, chatCatchUpPending: catchUpPending, includeUserMessages: perChat, sourceProtectionTurns, editProtectionTurns, canonicalizationPolicy: { useLightboard: formData.has("useLightboard"), useGigaTrans: true, customRules }, extractionGroupTurns: perChatGroupTurns, memoryLanguages, perspectives };
    if (state.current) {
      state.current.includeUserMessages = includeUserMessages;
      state.current.sourceProtectionTurns = sourceProtectionTurns;
      state.current.editProtectionTurns = editProtectionTurns;
      state.current.canonicalizationPolicy = state.settings.canonicalizationPolicy;
      state.current.extractionGroupTurns = extractionGroupTurns;
      state.current.memoryLanguage = memoryLanguage;
      state.lastPromptValidation = chatEnabled ? undefined : { chatId: state.current.chatId, status: "disabled", at: Date.now() };
      if (!chatEnabled) {
        state.automaticTurnPacket = undefined;
        state.activeModelRequest = undefined;
      }
    }
    await saveSettings(state.settings);
    if (verifiedHealth?.ok) data.health = verifiedHealth;
    const serverConfigured = isServerConfigured(state.settings);
    state.serverConnectionIssue = serverConfigured ? undefined : describeServerConnectionIssue(state.settings);
    state.activityStatusError = undefined;
    state.activityReady = !serverConfigured;
    state.publishActivity?.();
    if (memoryToolsWereEnabled !== state.settings.memoryToolsEnabled) {
      const registration = state.settings.memoryToolsEnabled
        ? state.restoreMemoryToolDiscoveryRegistration?.()
        : state.syncMemoryToolRegistration?.(false);
      await registration?.catch((error) => addLog(state.logs, "warn", `Memory tool registration update failed: ${String(error)}`));
      state.automaticTurnPacket = undefined;
      if (!state.settings.memoryToolsEnabled) showActionSaveState({ kind: "success", message: "기억 도구를 중지했습니다. 수동 설치한 외부 도구는 Provider 설정에서도 꺼주세요." });
    }
    if (state.current) state.current = await readCurrentContext(state);
    const apiKey = String(values.serverLlmApiKey ?? "").trim();
    const nextServerLlm = {
      engine: extractionEngine,
      maxInputTokens: Number(values.maxInputTokens ?? verifiedHealth?.serverLlm?.maxInputTokens ?? 80000),
      maxOutputTokens: Number(values.maxOutputTokens ?? verifiedHealth?.serverLlm?.maxOutputTokens ?? 24000),
      embeddingTimeoutMs: Number(values.embeddingTimeoutSeconds ?? (verifiedHealth?.serverLlm?.embeddingTimeoutMs ?? 15000) / 1000) * 1000,
      rerankTimeoutMs: Number(values.rerankTimeoutSeconds ?? (verifiedHealth?.serverLlm?.rerankTimeoutMs ?? 45000) / 1000) * 1000,
      llmTimeoutMs: Number(values.llmTimeoutSeconds ?? (verifiedHealth?.serverLlm?.llmTimeoutMs ?? 300000) / 1000) * 1000,
      provider: String(values.serverLlmProvider) as ServerLlmPublicConfig["provider"],
      endpoint: String(values.serverLlmEndpoint).trim(),
      model: String(values.serverLlmModel).trim(),
      temperature: Number(values.serverLlmTemperature),
      thinking: String(values.serverLlmThinking) as ServerLlmPublicConfig["thinking"],
      serviceTier: (values.serverLlmProvider === "gemini_api" || values.serverLlmProvider === "ollama_cloud" ? "standard" : String(values.serverLlmServiceTier ?? "standard")) as ServerLlmPublicConfig["serviceTier"],
    };
    if (serverConfigured && serverLlmUpdateRequiredForSettingsSave(bootstrappingServerConnection, verifiedHealth?.serverLlm, nextServerLlm, apiKey)) {
      const result = await client.request<{ worker: ServerWorkerStatus }>("/v1/admin/server-llm", {
        method: "PUT",
        body: JSON.stringify({ ...nextServerLlm, ...(apiKey ? { apiKey } : {}) }),
      });
      state.serverWorker = result.worker;
    }
    if (serverConfigured && state.current && chatWasEnabled && isChatMemoryEnabled(state.settings, state.current.chatId)) {
      state.lastPrepare = await client.prepare(makePrepareRequest(state.current, 0, { deferExtraction: false }), 5_000);
    }
    if (serverConfigured && !state.settings.workerPaused) void drainWorker(state, client);
  };

  const loadDataInventory = async () => {
    if (dataView.inventoryStatus !== "idle") return;
    dataView.inventoryStatus = "loading";
    render();
    try {
      dataView.inventory = await readHostChatInventory();
      dataView.inventoryStatus = "ready";
    } catch (error) {
      dataView.inventory = [];
      dataView.inventoryStatus = "unavailable";
      addLog(state.logs, "warn", `Risu chat inventory unavailable: ${String(error)}`);
    }
    if (activeTab === "data") render();
  };

  const loadServerInspector = async (chatId: string, offset = 0, includeContent = false) => {
    dataView.inspector = { chatId, loading: true, memories: [], storySpine: [], relationships: [], assertions: [], beliefs: [], promises: [], endedAssertions: [], endedBeliefs: [], userDeletedBeliefs: [], promiseHistory: [], reconciliationReviews: [], conflicts: [] };
    render();
    try {
      const encoded = encodeURIComponent(chatId);
      const ledgerRequest = data.health?.capabilities?.sourceLedgerInspection
        ? client.request<any>(`/v1/admin/chats/${encoded}/source-ledger?offset=${Math.max(0, offset)}&limit=50&includeContent=${includeContent}`)
        : Promise.resolve(undefined);
      const [memories, storySpineState, relationshipsState, worldState, reconciliationState, conflictState, ledger] = await Promise.all([
        client.request<any>(`/v1/chats/${encoded}/memories`),
        client.request<any>(`/v1/chats/${encoded}/story-spine`),
        client.request<any>(`/v1/chats/${encoded}/relationships`),
        client.request<any>(`/v1/chats/${encoded}/world-state?includeHistory=true`),
        client.request<any>(`/v1/chats/${encoded}/reconciliation-reviews`),
        client.request<any>(`/v1/chats/${encoded}/conflicts`),
        ledgerRequest,
      ]);
      dataView.inspector = {
        chatId,
        memories: memories.items ?? [], storySpine: storySpineState, relationships: relationshipsState.items ?? [],
        assertions: worldState.assertions ?? [], beliefs: worldState.beliefs ?? [], promises: worldState.promises ?? [],
        endedAssertions: worldState.endedAssertions ?? [], endedBeliefs: worldState.endedBeliefs ?? [],
        userDeletedBeliefs: worldState.userDeletedBeliefs ?? [], promiseHistory: worldState.promiseHistory ?? [],
        reconciliationReviews: reconciliationState.items ?? [], conflicts: conflictState.items ?? [], ledger,
      };
      const sourceLanguage = activeCanonicalLanguage(chatId);
      if (data.health?.instanceId && state.settings.translationDisplay !== "en" && sourceLanguage !== "ko") {
        const cached = await readCachedTranslations(state, (memories.items ?? []).flatMap((memory: any) => [
          { serverInstanceId: data.health!.instanceId, chatId, sourceLanguage, kind: "memory-title", itemId: `${memory.id}:title`, text: String(memory.title ?? "") },
          { serverInstanceId: data.health!.instanceId, chatId, sourceLanguage, kind: "memory-content", itemId: `${memory.id}:content`, text: String(memory.content ?? "") },
        ]), state.settings.translationProvider);
        cached.forEach((item) => translations.set(item.itemId, item.translated));
      }
    } catch (error) {
      dataView.inspector = { chatId, error: String(error), memories: [], storySpine: [], relationships: [], assertions: [], beliefs: [], promises: [], endedAssertions: [], endedBeliefs: [], userDeletedBeliefs: [], promiseHistory: [], reconciliationReviews: [], conflicts: [] };
    }
    if (activeTab === "data") render();
  };

  const exportCompleteBackup = async (chatId?:string) => {
    if (dataView.backupExportPhase) return;
    try {
      dataView.backupExportError = undefined;
      dataView.backupExportChatId=chatId;
      dataView.backupExportPhase = "creating"; render();
      const response = await client.raw("/v1/export", { method: "POST", body: JSON.stringify({
        ...(chatId?{chatId,chatSettings:exportChatSettings(state.settings,chatId)}:{pluginSettings:state.settings,serverUrl:state.settings.serverUrl}),
      }) }, 120_000);
      const blob = await response.blob();
      dataView.backupExportPhase = "downloading"; render();
      triggerBackupDownload(blob, `rcm-${chatId?`chat-${chatId.replace(/[^a-zA-Z0-9_-]/g,"_")}`:"complete"}-backup-${new Date().toISOString().slice(0, 10)}.zip`);
    } finally {
      dataView.backupExportPhase = undefined;
      dataView.backupExportChatId = undefined;
      render();
    }
  };

  const restoreChatBackup = async (bytes: ArrayBuffer) => {
    const response=await client.raw("/v1/import/chat",{method:"POST",headers:{"Content-Type":"application/zip"},body:backupRequestBody(bytes)},180_000);
    const restored=await response.json() as any;
    invalidateRestoredChatState(state,restored.chatId);
    state.settings.serverInstances[state.settings.serverUrl.replace(/\/$/,"")]=restored.serverInstanceId;
    restoreChatSettings(state.settings,restored.chatId,restored.chatSettings);
    await saveStoredJson(CACHE_KEY,state.cache);
    await saveSettings(state.settings);
    await alertDashboard("채팅의 RCM 기록과 설정을 복원했습니다.");
    await refresh();
  };

  const restoreCompleteBackup = async (bytes: ArrayBuffer) => {
    const response = await client.raw("/v1/import/restore", { method: "POST", headers: { "Content-Type": "application/zip" }, body: backupRequestBody(bytes) }, 180_000);
    const restored = await response.json() as any;
    for(const chatId of new Set([...Object.keys(state.cache),...(state.current?[state.current.chatId]:[])]))invalidateRestoredChatState(state,chatId);
    await saveStoredJson(CACHE_KEY,state.cache);
    if (restored.pluginSettings?.settingsRevision === 20) {
      state.settings = mergeCompleteBackupSettings(state.settings, restored.pluginSettings);
      await saveSettings(state.settings);
    }
    addLog(state.logs, "info", `Complete memory backup restored (${Number(restored.vectorsRestored ?? 0)} vectors)`);
    await alertDashboard("기억 복원이 완료되었습니다. 현재 서버 주소와 토큰은 유지되었습니다. 복원된 임베딩·보조 모델 키와 서버 설정을 적용하려면 RCM 서버를 재시작해 주세요.");
    await refresh();
  };

  const transplantChatBackup = async (bytes: ArrayBuffer, sourceChatId: string) => {
    if (!state.current) throw new Error("현재 채팅을 찾지 못했습니다.");
    const targetChatId = state.current.chatId;
    if (!data.adminChats.some((chat) => chat.id === targetChatId)) await syncCompleteSourceLedger(client, state.current);
    const path = `/v1/import/transplant?sourceChatId=${encodeURIComponent(sourceChatId)}&targetChatId=${encodeURIComponent(targetChatId)}`;
    const response = await client.raw(path, { method: "POST", headers: { "Content-Type": "application/zip" }, body: backupRequestBody(bytes) }, 180_000);
    const result = await response.json() as any;
    invalidateRestoredChatState(state,targetChatId);
    await saveStoredJson(CACHE_KEY,state.cache);
    addLog(state.logs, "info", `Memory transplanted without re-extraction (${Number(result.memories ?? 0)} memories)`);
    await refresh();
  };

  const activeContent = () => !state.current && !["data", "settings"].includes(activeTab) ? noActiveChat(data, activeTab)
    : activeTab === "overview" ? overview(state, data, translations)
    : activeTab === "initial" ? initialCalibrationPage(data, peopleView, translations, state.settings.translationDisplay, entityMergePreview)
    : activeTab === "story" ? storySpinePage(data, translations, storyView, koreanTranslationEnabled(state.settings.autoTranslate, state.settings.translationDisplay, activeCanonicalLanguage()), activeCanonicalLanguage(), state.current ? state.settings.storyOverviewBackups[state.current.chatId] : undefined)
    : activeTab === "timeline" ? organizationView.open ? memoryOrganization(organizationView, data.memories, translations, state.settings.translationDisplay) : timeline(data, selectedMemory, translations, timelineView, koreanTranslationEnabled(state.settings.autoTranslate, state.settings.translationDisplay, activeCanonicalLanguage()), activeCanonicalLanguage(), state.translationActivity?.error)
      : activeTab === "relationships" ? relationshipsV2(state, data, selectedRelationship, translations, state.settings.translationDisplay, entityMergePreview, intimacyEditor, relationshipSection, relationshipEditing, relationshipStateView, relationshipPerson, relationshipMobileDetail, relationshipQuery, relationshipIntimacyOnly, socialEditor)
        : activeTab === "world" ? world(data, worldKind, worldView, translations, state.settings.translationDisplay, worldEditor)
          : activeTab === "reviews" ? attentionPage(data, translations, state.settings.translationDisplay, attentionView)
            : activeTab === "conflicts" ? conflicts(data)
              : activeTab === "operations" ? operations(state, data)
                : activeTab === "data" ? dataManagement(state, data, dataView, translations)
                  : settingsV2(state, data, settingsSection, voyageSaveState, voyageSaveBusy, cacheStats);

  const patchTranslatedMemory = (memory: any) => {
    if (!dashboardOpen || activeTab !== "timeline" || formDirty) return;
    if (hasActiveSelection()) { pendingTranslationPatches.add(memory.id); return; }
    render();
  };

  const queueMemoryTranslation = async (memory: any, force = false) => {
    const sourceLanguage = activeCanonicalLanguage();
    if (!state.settings.autoTranslate || state.settings.translationDisplay === "en" || sourceLanguage === "ko" || !state.current || !data.health?.instanceId) return;
    const requestKey = `${memory.id}:${state.settings.translationProvider}:${memory.updated_at}`;
    if (!force && translationRequested.has(requestKey)) return;
    translationRequested.add(requestKey);
    const evidence = parseJson<Array<{ messageId?: string; quote?: string }>>(memory.evidence_json, []);
    const messages = new Map(data.messages.map((message) => [message.message_id, message]));
    const relationshipEvents = data.relationshipEvents.filter((item) => item.sourceMemoryId === memory.id);
    const intimacyMilestones = data.physicalIntimacy.filter((item) => item.sourceMemoryId === memory.id);
    const records = [
      { kind: "memory-title", itemId: `${memory.id}:title`, text: String(memory.title) },
      { kind: "memory-content", itemId: `${memory.id}:content`, text: String(memory.content) },
      ...(memory.details ?? []).map((item: any) => ({ kind: "memory-detail", itemId: `${memory.id}:detail:${item.id}`, text: String(item.text ?? "") })),
      ...relationshipEvents.map((item: any) => ({ kind: "relationship-event", itemId: `relationship-event:${item.id}:reason`, text: String(item.reason ?? "") })),
      ...intimacyMilestones.map((item: any) => ({ kind: "physical-intimacy", itemId: `intimacy:${item.id}:circumstance`, text: String(item.circumstance ?? "") })),
      ...(memory.keyDialogues ?? []).map((item: any, index: number) => ({ kind: "dialogue", itemId: `${memory.id}:dialogue:${index}`, text: String(item.text) })),
      ...evidence.map((item, index) => ({ kind: "evidence", itemId: `${memory.id}:evidence:${index}`, text: String(item.quote ?? messages.get(item.messageId ?? "")?.content ?? "") })).filter((item) => item.text),
    ].map((record) => ({ ...record, serverInstanceId: data.health!.instanceId, chatId: state.current!.chatId, sourceLanguage }));
    const results = await translateRecords(state, records);
    for (const result of results) {
      if (!result.error) translations.set(result.itemId, result.translated);
    }
    if (isServerConfigured(state.settings)) cacheStats = await translationCacheStats(state).catch(() => cacheStats);
    patchTranslatedMemory(memory);
  };

  const hydrateCachedMemoryTranslations = async (next: DashboardData) => {
    const sourceLanguage = activeCanonicalLanguage();
    if (!state.current || !next.health?.instanceId || state.settings.translationDisplay === "en" || sourceLanguage === "ko") return;
    const records = [...next.memories.flatMap((memory) => [
      { serverInstanceId: next.health!.instanceId, chatId: state.current!.chatId, sourceLanguage, kind: "memory-title", itemId: `${memory.id}:title`, text: String(memory.title ?? "") },
      { serverInstanceId: next.health!.instanceId, chatId: state.current!.chatId, sourceLanguage, kind: "memory-content", itemId: `${memory.id}:content`, text: String(memory.content ?? "") },
    ]), ...storyTranslationRecords(next.storySpine).map((record) => ({ ...record, serverInstanceId: next.health!.instanceId, chatId: state.current!.chatId, sourceLanguage })), ...next.reconciliationReviews.filter((item) => item.status === "pending").flatMap((item) => {
      const candidate = item.candidates.find((value: any) => value.id === item.decision?.targetId) ?? item.candidates[0];
      return [
        { serverInstanceId: next.health!.instanceId, chatId: state.current!.chatId, sourceLanguage, kind: "reconciliation", itemId: `reconciliation:${item.id}:incoming`, text: String(item.incoming?.content ?? item.incoming?.value ?? item.incoming?.title ?? "") },
        { serverInstanceId: next.health!.instanceId, chatId: state.current!.chatId, sourceLanguage, kind: "reconciliation", itemId: `reconciliation:${item.id}:candidate`, text: String(candidate?.value?.content ?? candidate?.value?.value ?? candidate?.value?.title ?? "") },
      ];
    })].filter((item) => item.text);
    const cached = await readCachedTranslations(state, records, state.settings.translationProvider);
    for (const item of cached) translations.set(item.itemId, item.translated);
  };

  const observeVisibleMemories = () => {
    translationObserver?.disconnect();
    if (!state.settings.autoTranslate || state.settings.translationDisplay === "en" || activeCanonicalLanguage() === "ko" || activeTab !== "timeline") return;
    translationObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) {
        const id = (entry.target as HTMLElement).dataset.translateMemory;
        const memory = data.memories.find((item) => item.id === id);
        if (memory) void queueMemoryTranslation(memory);
      }
    }, { root: root.querySelector("#memory-rows"), threshold: 0.05 });
    root.querySelectorAll<HTMLElement>("[data-translate-memory]").forEach((element) => translationObserver?.observe(element));
    const selected = data.memories.find((item) => item.id === selectedMemory);
    if (selected) void queueMemoryTranslation(selected);
  };

  const queueStructuredTranslations = async () => {
    const sourceLanguage = activeCanonicalLanguage();
    if (!state.settings.autoTranslate || state.settings.translationDisplay === "en" || sourceLanguage === "ko" || !["story", "world", "initial", "relationships", "reviews"].includes(activeTab) || !state.current || !data.health?.instanceId) return;
    const source = activeTab === "story"
      ? (() => {
        const all = storyTranslationRecords(data.storySpine);
        const overviewKey = storyGroupKey(data.storySpine?.overview, "overview");
        const prefixes = [`story:${storyView.selectedGroupId}:`, `story:${overviewKey}:`];
        const selectedGroup = storyGroups(data.storySpine).find((item) => item.key === storyView.selectedGroupId)?.group;
        const linkedMemories = (selectedGroup?.linkedMemoryIds ?? []).map((id: string) => data.memories.find((memory) => memory.id === id)).filter(Boolean).flatMap((memory: any) => [
          { kind: "memory-title", itemId: `${memory.id}:title`, text: String(memory.title ?? "") },
          { kind: "memory-content", itemId: `${memory.id}:content`, text: String(memory.content ?? "") },
        ]);
        return [...all.filter((item) => prefixes.some((prefix) => item.itemId.startsWith(prefix))), ...linkedMemories, ...all.filter((item) => !prefixes.some((prefix) => item.itemId.startsWith(prefix)))];
      })()
      : ["initial", "relationships"].includes(activeTab)
      ? [
        ...data.relationships.flatMap((item) => [
          { kind: "relationship", itemId: `relationship:${relationshipFrom(item)}|${relationshipTo(item)}:summary`, text: String(item.summary ?? "") },
          ...(item.activeTensions ?? []).map((text: string, index: number) => ({ kind: "relationship-tension", itemId: `relationship:${relationshipFrom(item)}|${relationshipTo(item)}:tension:${index}`, text })),
        ]),
        ...data.relationshipEvents.map((item) => ({ kind: "relationship-event", itemId: `relationship-event:${item.id}:reason`, text: String(item.reason ?? "") })),
        ...data.physicalIntimacy.map((item) => ({ kind: "physical-intimacy", itemId: `intimacy:${item.id}:circumstance`, text: String(item.circumstance ?? "") })),
        ...(data.initialCalibration?.relationships ?? []).map((item: any) => ({
          kind: "initial-relationship",
          itemId: `initial-relationship:${item.id ?? `${item.from}|${item.to}`}:summary`,
          text: String(item.summary ?? ""),
        })),
      ]
      : activeTab === "reviews"
        ? data.reconciliationReviews.filter((item) => item.status === "pending").flatMap((item) => {
          const incoming = item.incoming ?? {};
          const candidate = item.candidates.find((value: any) => value.id === item.decision?.targetId) ?? item.candidates[0];
          return [
            { kind: "reconciliation", itemId: `reconciliation:${item.id}:incoming`, text: String(incoming.content ?? incoming.value ?? incoming.title ?? "") },
            { kind: "reconciliation", itemId: `reconciliation:${item.id}:candidate`, text: String(candidate?.value?.content ?? candidate?.value?.value ?? candidate?.value?.title ?? "") },
          ];
        })
      : worldKind === "beliefs"
        ? [...data.beliefs.map((item, index) => ({ kind: "belief", itemId: `belief:${item.id ?? index}`, text: String(item.value) })), ...data.endedBeliefs.map((item, index) => ({ kind: "belief-history", itemId: `history:beliefs:${item.id ?? index}`, text: String(item.value) }))]
        : worldKind === "promises"
          ? [...data.promises.map((item, index) => ({ kind: "promise", itemId: `promise:${item.id ?? item.promise_key ?? index}`, text: String(item.content) })), ...data.promiseHistory.map((item, index) => ({ kind: "promise-history", itemId: `history:promises:${item.id ?? index}`, text: String(item.content) }))]
          : [...data.assertions.map((item, index) => ({ kind: "assertion", itemId: `assertion:${item.id ?? index}`, text: String(item.value) })), ...data.endedAssertions.map((item, index) => ({ kind: "assertion-history", itemId: `history:assertions:${item.id ?? index}`, text: String(item.value) }))];
    const records = source.filter((item) => item.text && !translationRequested.has(`${item.itemId}:${state.settings.translationProvider}`)).slice(0, 32);
    if (!records.length) return;
    records.forEach((item) => translationRequested.add(`${item.itemId}:${state.settings.translationProvider}`));
    const results = await translateRecords(state, records.map((record) => ({ ...record, serverInstanceId: data.health!.instanceId, chatId: state.current!.chatId, sourceLanguage })));
    results.forEach((result) => { if (!result.error) translations.set(result.itemId, result.translated); });
    if (dashboardOpen && ["story", "world", "relationships", "reviews"].includes(activeTab) && !hasActiveSelection()) {
      if (activeTab === "reviews") {
        for (const result of results) {
          const element = root.querySelector<HTMLElement>(`[data-translation-id="${CSS.escape(result.itemId)}"]`);
          if (element && !result.error) element.textContent = `참고 번역, 저장되지 않음 · ${result.translated}`;
        }
      } else render();
    }
  };

  const renderedHtml = new WeakMap<HTMLElement, string>();
  const setHtmlIfChanged = (element: HTMLElement, next: string) => {
    if (renderedHtml.get(element) === next) return;
    element.innerHTML = next;
    renderedHtml.set(element, next);
  };

  const updateTopbar = () => {
    const topbar = root.querySelector<HTMLElement>(".topbar");
    if (!topbar) return;
    const summary = state.statusSummary;
    const sourceRecovery = state.currentJob?.sourceRecovery === true || state.serverWorker?.activeJob?.sourceRecovery === true;
    const auditing = state.currentJob?.phase === "post_extraction_audit" || state.serverWorker?.phase === "post_extraction_audit";
    const reconciling = state.currentJob?.phase === "state_reconciliation" || state.serverWorker?.phase === "state_reconciliation";
    const activity = refreshing ? "정보 갱신 중" : state.episodeActivity?.status === "holding" ? `에피소드 보류 중 · ${state.episodeActivity.turnCount}턴` : ["queued", "processing"].includes(state.episodeActivity?.status ?? "") ? "에피소드 정리 중" : sourceRecovery ? "원문 발췌 보완 중" : auditing ? "추출 재검수 중" : reconciling ? "상태 장부 대조 중" : state.currentJob || (state.serverWorker?.activeCalls ?? 0) > 0 ? "기억 추출 중" : (summary?.pendingEmbeddings ?? 0) > 0 ? "검색 인덱싱 중" : (state.translationActivity?.pending ?? 0) > 0 ? "번역 중" : "";
    const workState = dashboardTopbarWorkState(activity, state.serverConnectionIssue ?? data.connectionIssue);
    const currentStatus = settingsSaving
      ? status("warn", "저장 중…")
      : actionSaveState
      ? status(actionSaveState.kind === "success" ? "ok" : "error", actionSaveState.message)
      : workState ? status(workState.kind, workState.text)
      : state.activityStatusError === SERVER_RESPONSE_DELAYED ? status("warn", "서버 응답 지연")
      : data.error ? status("error", "서버 확인 필요") : data.contextError ? status("warn", "채팅 확인 필요") : !state.current ? status("warn", "활성 채팅 없음") : status("ok", "동기화됨");
    const context = dashboardChatContext(state.current);
    setHtmlIfChanged(topbar, `<div class="chat-context"><strong>${escapeHtml(context.character)}</strong>${context.chat ? `<span aria-hidden="true">·</span><span class="chat-context__title">${escapeHtml(context.chat)}</span>` : ""}</div><div class="topbar__spacer"></div><span class="topbar__state" role="status" aria-live="polite" aria-atomic="true">${currentStatus}</span><button class="btn btn--icon" data-action="refresh" aria-label="새로고침" ${refreshing ? "disabled" : ""}>${icon("refresh")}</button><button class="btn btn--icon" data-action="close" aria-label="닫기">${icon("close")}</button>`);
  };

  const showActionSaveState = (next: ActionState) => {
    actionSaveState = next;
    if (actionSaveTimer) clearTimeout(actionSaveTimer);
    updateTopbar();
    actionSaveTimer = setTimeout(() => {
      actionSaveState = undefined;
      actionSaveTimer = undefined;
      if (dashboardOpen) updateTopbar();
    }, 2_400);
  };

  const updateRegexRuleSummary = () => {
    const rules = Array.from(root.querySelectorAll<HTMLElement>("[data-regex-rule]"));
    const count = root.querySelector<HTMLElement>("[data-regex-count]");
    const activeCount = root.querySelector<HTMLElement>("[data-regex-active-count]");
    if (count) count.textContent = String(rules.length);
    if (activeCount) activeCount.textContent = String(rules.filter((rule) => rule.querySelector<HTMLInputElement>('input[name="customRuleEnabled"]')?.checked).length);
  };

  const updateNavBadges = () => {
    const pending = reviewBadgeVisible(state);
    const label = root.querySelector<HTMLElement>('[data-action="tab"][data-tab="reviews"] span');
    if (label) label.textContent = `관리${pending ? " · !" : ""}`;
  };

  const serverActivitySignature = () => JSON.stringify({
    summary: state.statusSummary,
    worker: state.serverWorker,
    currentJob: state.currentJob?.id,
    workerBusy: state.workerBusy,
  });

  const render = (preserveMainScroll = true) => {
    const previousSidebar = root.querySelector<HTMLElement>(".sidebar");
    const previousMain = root.querySelector<HTMLElement>(".main");
    const previousRows = root.querySelector<HTMLElement>("#memory-rows");
    const timelineAnchor = (() => {
      if (!previousRows) return undefined;
      const rows = Array.from(previousRows.querySelectorAll<HTMLElement>(":scope > .row[data-id]"));
      const anchor = rows.findLast((row) => row.offsetTop <= previousRows.scrollTop) ?? rows[0];
      return anchor?.dataset.id ? { id: anchor.dataset.id, offset: previousRows.scrollTop - anchor.offsetTop } : undefined;
    })();
    const preservedScroll = new Map(Array.from(root.querySelectorAll<HTMLElement>("[data-preserve-scroll]"))
      .map((element) => [element.dataset.preserveScroll!, { left: element.scrollLeft, top: element.scrollTop }] as const));
    const preservedOpen = new Map(Array.from(root.querySelectorAll<HTMLDetailsElement>("[data-preserve-open]"))
      .map((element) => [element.dataset.preserveOpen!, element.open] as const));
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusAction = previousFocus?.closest<HTMLElement>("[data-action]");
    const focusIdentity = focusAction ? { action: focusAction.dataset.action, id: focusAction.dataset.id } : undefined;
    const focusDisclosure = previousFocus?.closest<HTMLDetailsElement>("[data-preserve-open]");
    const focusDisclosureKey = focusDisclosure?.dataset.preserveOpen;
    const sidebarScroll = { left: previousSidebar?.scrollLeft ?? 0, top: previousSidebar?.scrollTop ?? 0 };
    const mainScroll = { left: previousMain?.scrollLeft ?? 0, top: previousMain?.scrollTop ?? 0 };
    const rowsScroll = previousRows?.scrollTop ?? 0;
    const content = activeContent();
    if (!root.querySelector(".topbar")) root.innerHTML = '<header class="topbar"></header><div class="shell"><aside class="sidebar"><a class="product" data-action="tab" data-tab="overview" aria-label="기억 홈으로 이동"><span class="product__mark">' + MEMORY_ICON + '</span><span><strong>RCM</strong><small>기억 대시보드</small></span></a><nav class="nav" aria-label="주요 메뉴"></nav><div class="sidebar__chat"></div></aside><main class="main" id="main-content"><nav class="secondary-nav" aria-label="세부 메뉴"></nav><div class="page"></div></main></div>';
    const nav = root.querySelector<HTMLElement>(".nav")!;
    const secondaryNav = root.querySelector<HTMLElement>(".secondary-nav")!;
    const sidebarChat = root.querySelector<HTMLElement>(".sidebar__chat")!;
    const page = root.querySelector<HTMLElement>(".page")!;
    updateTopbar();
    const groups = dashboardNavigation(reviewBadgeVisible(state));
    const activeGroupId = dashboardNavGroup(activeTab);
    const activeGroup = groups.find((group) => group.id === activeGroupId) ?? groups[0]!;
    setHtmlIfChanged(nav, groups.map((group) => `<button data-action="tab" data-tab="${group.defaultTab}" aria-label="${escapeHtml(group.label)}" aria-current="${activeGroupId === group.id ? "page" : "false"}">${icon(group.icon)}<span>${group.label}</span></button>`).join(""));
    setHtmlIfChanged(secondaryNav, dashboardSecondaryNavigation(activeGroup, activeTab));
    secondaryNav.hidden = activeGroup.items.length === 0;
    const chatContext = dashboardChatContext(state.current);
    setHtmlIfChanged(sidebarChat, `<span>현재 채팅</span><strong>${escapeHtml(chatContext.character)}</strong>${chatContext.chat ? `<small>${escapeHtml(chatContext.chat)}</small>` : ""}`);
    const activeElement = document.activeElement as HTMLElement | null;
    const protectFocusedControl = !organizationView.open && page.dataset.tab === activeTab && Boolean(activeElement && page.contains(activeElement) && activeElement.matches("input, select, textarea"));
    const protectDirtyForm = formDirty && ["initial", "story", "timeline", "relationships", "world"].includes(activeTab) && page.dataset.tab === activeTab;
    const pageContent = content;
    const pageUnchanged = page.dataset.tab === activeTab && renderedPageTab === activeTab && renderedPageContent === pageContent;
    let replacedPage = false;
    if (!pageUnchanged && !protectDirtyForm && !protectFocusedControl) {
      page.dataset.tab = activeTab;
      page.innerHTML = pageContent;
      renderedPageTab = activeTab;
      renderedPageContent = pageContent;
      deferredPageRender = false;
      replacedPage = true;
    } else if (!pageUnchanged) {
      deferredPageRender = true;
    }
    if ((protectDirtyForm || protectFocusedControl) && newDataAvailable && !page.querySelector(".new-data")) {
      page.insertAdjacentHTML("afterbegin", `<div class="notice new-data" role="status">${icon("clock")}<div><strong>새 데이터 있음</strong><div class="muted">편집 내용을 보호하고 있습니다. 저장하거나 취소하면 최신 서버 데이터를 반영합니다.</div></div></div>`);
    }
    if (!newDataAvailable) page.querySelector(".new-data")?.remove();
    const nextSidebar = root.querySelector<HTMLElement>(".sidebar");
    const nextMain = root.querySelector<HTMLElement>(".main");
    const nextRows = root.querySelector<HTMLElement>("#memory-rows");
    root.querySelectorAll<HTMLDetailsElement>("[data-preserve-open]").forEach((element) => {
      if (preservedOpen.get(element.dataset.preserveOpen!)) element.open = true;
    });
    nextSidebar?.scrollTo(sidebarScroll);
    if (preserveMainScroll) nextMain?.scrollTo(mainScroll);
    root.querySelectorAll<HTMLElement>("[data-preserve-scroll]").forEach((element) => {
      const position = preservedScroll.get(element.dataset.preserveScroll!);
      if (position) element.scrollTo(position);
    });
    if (nextRows) {
      const anchor = timelineAnchor && Array.from(nextRows.querySelectorAll<HTMLElement>(":scope > .row[data-id]"))
        .find((row) => row.dataset.id === timelineAnchor.id);
      nextRows.scrollTop = anchor ? anchor.offsetTop + timelineAnchor.offset : rowsScroll;
    }
    if (focusIdentity?.action) {
      Array.from(root.querySelectorAll<HTMLElement>("[data-action]")).find((element) => element.dataset.action === focusIdentity.action && element.dataset.id === focusIdentity.id)?.focus({ preventScroll: true });
    } else if (focusDisclosureKey) {
      root.querySelector<HTMLDetailsElement>(`[data-preserve-open="${focusDisclosureKey}"]`)?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    }
    if (activeTab === "timeline") applyTimelineSearch();
    if (activeTab === "story") applyStorySearch();
    if (activeTab === "initial") applyPeopleSearch();
    if (activeTab === "relationships" && relationshipSection !== "acquaintances") applyRelationshipSearch();
    if (activeTab === "reviews") applyAttentionSearch();
    if (replacedPage) setEditorBaselines(page);
    root.setAttribute("aria-busy", "false");
    observeVisibleMemories();
    void queueStructuredTranslations();
  };

  const refresh = async (options: { forceApply?: boolean } = {}) => {
    const generation = ++refreshGeneration;
    refreshing = true;
    updateTopbar();
    try {
      const refreshed = await loadDashboardData(state, client, { tab: activeTab, previous: data });
      if (organizationChatId !== state.current?.chatId) {
        Object.assign(organizationView, createOrganizationView());
        organizationChatId = state.current?.chatId;
      }
      if (organizationView.open && state.current) {
        organizationView.data = await client.request<OrganizationData>(`/v1/chats/${encodeURIComponent(state.current.chatId)}/memory-organization`);
      }
      const previousIssue = state.serverConnectionIssue;
      if (refreshed.connectionIssue) {
        const confirmed = noteServerConnectionFailure(state, state.settings, new Error(refreshed.error ?? refreshed.connectionIssue.technical ?? refreshed.connectionIssue.detail));
        refreshed.connectionIssue = confirmed;
        if (!confirmed) {
          state.activityReady = true;
          if (previousIssue || state.activityStatusError === SERVER_RESPONSE_DELAYED) state.publishActivity?.();
          refreshing = false;
          updateTopbar();
          return;
        }
      } else noteServerConnectionSuccess(state);
      const connectionChanged = previousIssue?.kind !== state.serverConnectionIssue?.kind
        || previousIssue?.detail !== state.serverConnectionIssue?.detail
        || state.activityReady !== true;
      state.activityReady = true;
      if (connectionChanged) state.publishActivity?.();
      const recovered = await reconcileAutomaticServerPause(state, client, {
        failedJobs: refreshed.jobs.filter((job) => job.status === "failed").length,
        worker: refreshed.health?.serverWorker ?? state.serverWorker,
        available: !refreshed.jobsError && !refreshed.error && Boolean(refreshed.health?.serverWorker ?? state.serverWorker),
      });
      if (recovered && refreshed.health && state.serverWorker) refreshed.health.serverWorker = state.serverWorker;
      if (generation !== refreshGeneration || !dashboardOpen) return;
      if (activeTab === "reviews") syncReviewActivity(state, refreshed);
      await hydrateCachedMemoryTranslations(refreshed);
      if (shouldDeferDashboardRefresh(options.forceApply === true, formDirty, activeTab, hasActiveSelection())) {
        pendingData = refreshed;
        newDataAvailable = true;
      } else {
        data = refreshed;
        pendingData = undefined;
        newDataAvailable = false;
      }
      if (refreshed.health?.instanceId) {
        const serverUrl = state.settings.serverUrl.replace(/\/$/, "");
        if (state.settings.serverInstances[serverUrl] !== refreshed.health.instanceId) {
          state.settings.serverInstances[serverUrl] = refreshed.health.instanceId;
          await saveSettings(state.settings);
          if (state.current) state.current = await readCurrentContext(state);
        }
      }
      if (refreshed.initialCalibration?.status === "awaiting_confirmation"
        && ["overview", "data", "operations"].includes(activeTab)) activeTab = "initial";
      selectedMemory ||= data.memories[0]?.id ?? "";
      const availableStoryGroups = storyGroups(data.storySpine);
      if (!availableStoryGroups.some((item) => item.key === storyView.selectedGroupId)) {
        const selectedStory = availableStoryGroups.at(-1);
        storyView.selectedGroupId = selectedStory?.key ?? "";
        storyView.expandedMemoryId = "";
      }
    } catch (error) {
      console.error("[RCM dashboard] initial data load failed", error);
      const confirmed = noteServerConnectionFailure(state, state.settings, error);
      if (confirmed) data = { ...data, error: String(error), connectionIssue: confirmed };
    }
    refreshing = false;
    if (!pendingData) render(); else { updateTopbar(); updateNavBadges(); }
  };

  const saveVoyageKey = async (form: HTMLFormElement): Promise<boolean> => {
    if (voyageSaveBusy) return false;
    const apiKey = String(new FormData(form).get("voyageApiKey") ?? "").trim();
    if (!apiKey) {
      voyageSaveState = { kind: "error", message: "Voyage API key를 입력하세요." };
      render();
      return false;
    }
    voyageSaveBusy = true;
    voyageSaveState = undefined;
    render();
    try {
      await client.request("/v1/admin/voyage-key", { method: "PUT", body: JSON.stringify({ apiKey }) }, 15_000);
      voyageSaveState = { kind: "success", message: "서버 검증을 통과해 저장했습니다. Vector 검색을 사용할 수 있습니다." };
      addLog(state.logs, "info", "Voyage API key validated and saved on the server");
      await refresh();
      return true;
    } catch (error) {
      voyageSaveState = { kind: "error", message: String(error) };
      addLog(state.logs, "error", `Voyage API key save failed: ${String(error)}`);
      return false;
    } finally {
      voyageSaveBusy = false;
      render();
    }
  };

  const changeChatProfile = async (profile: RpProfile): Promise<boolean> => {
    if (!state.current || !["companion", "simulation"].includes(profile)) return false;
    if (profile === state.current.profile) { data.error = undefined; return false; }
    const transitioningToSimulation = state.current.profile === "companion" && profile === "simulation";
    const backfill = transitioningToSimulation
      ? await chooseSimulationBackfill(state.current.estimatedSourceTokens)
      : false;
    if (backfill === undefined) return false;
    const serverHasChat = data.adminChats.some((item) => item.id === state.current?.chatId);
    if (!data.adminError && data.health?.ok && !serverHasChat) {
      if (backfill) {
        await alertDashboard("과거 기록을 다시 추출하려면 먼저 이 채팅의 RCM 서버 연결을 완료해 주세요.");
        return false;
      }
      state.settings.profiles[state.current.chatId] = profile;
      state.current.profile = profile;
      clearDeletedChatState(state, state.current.chatId, false);
      await saveSettings(state.settings);
      addLog(state.logs, "info", "Chat mode saved locally; full backfill is required before server state can be updated");
      render();
      return true;
    }
    let extractionReviewOverride: boolean | undefined;
    if (backfill) {
      requireChatMemoryEnabled(state, state.current.chatId);
      const tokens = state.current.estimatedSourceTokens;
      extractionReviewOverride = await chooseExtractionReviewOverride(
        "World Simulation 백필을 재검수할까요?",
        `World Simulation에 필요한 과거 원문 약 ${tokens.toLocaleString()} 입력 토큰을 처리합니다. 2차 재검수는 정확도를 높일 수 있지만 호출량과 비용이 늘어납니다.`,
        state.settings.postExtractionReview,
      );
      if (extractionReviewOverride === undefined) return false;
    }
    const chatId = state.current.chatId;
    const scope = backfill ? serverScopeKey(state.settings, chatId) : undefined;
    const profileRequest = backfill ? withExtractionReviewOverride({ profile, backfill }, extractionReviewOverride as boolean) : { profile, backfill: false };
    await client.request(`/v1/chats/${encodeURIComponent(chatId)}`, { method: "PATCH", body: JSON.stringify(profileRequest) });
    state.settings.profiles[chatId] = profile;
    state.current.profile = profile;
    if (scope) state.settings.backfillApproved[scope] = true;
    await saveSettings(state.settings);
    await refresh({ forceApply: true });
    return true;
  };

  let dragScroll: { element: HTMLElement; pointerId: number; startX: number; scrollLeft: number; moved: boolean } | undefined;
  let suppressDragClickUntil = 0;
  const placeStoryMemoryPreview = (id: string) => {
    if (!id || !window.matchMedia("(max-width: 760px)").matches) return;
    const item = root.querySelector<HTMLElement>(`[data-story-memory-item="${CSS.escape(id)}"]`);
    const preview = root.querySelector<HTMLElement>(`[data-story-memory-preview="${CSS.escape(id)}"]`);
    if (item && preview) item.after(preview);
  };
  root.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch" || event.button !== 0) return;
    const element = (event.target as HTMLElement).closest<HTMLElement>("[data-drag-scroll]");
    if (!element || element.scrollWidth <= element.clientWidth) return;
    dragScroll = { element, pointerId: event.pointerId, startX: event.clientX, scrollLeft: element.scrollLeft, moved: false };
  });
  root.addEventListener("pointermove", (event) => {
    if (!dragScroll || dragScroll.pointerId !== event.pointerId) return;
    const delta = event.clientX - dragScroll.startX;
    if (!dragScroll.moved && Math.abs(delta) < 5) return;
    if (!dragScroll.moved) {
      dragScroll.moved = true;
      // Capturing on pointer-down retargets a normal click to the overflowing
      // rail, so linked-memory buttons stop receiving clicks when the rail is
      // actually scrollable. Capture only after a deliberate drag begins.
      dragScroll.element.setPointerCapture(event.pointerId);
    }
    dragScroll.element.classList.add("is-dragging");
    dragScroll.element.scrollLeft = dragScroll.scrollLeft - delta;
    event.preventDefault();
  });
  const finishDragScroll = (event: PointerEvent) => {
    if (!dragScroll || dragScroll.pointerId !== event.pointerId) return;
    if (dragScroll.moved) suppressDragClickUntil = Date.now() + 250;
    dragScroll.element.classList.remove("is-dragging");
    if (dragScroll.element.hasPointerCapture(event.pointerId)) dragScroll.element.releasePointerCapture(event.pointerId);
    dragScroll = undefined;
  };
  root.addEventListener("pointerup", finishDragScroll);
  root.addEventListener("pointercancel", finishDragScroll);
  root.addEventListener("click", (event) => {
    if (Date.now() < suppressDragClickUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  const discardReadyOrganizationCandidate = async (): Promise<boolean> => {
    const candidateId = organizationView.candidateId;
    const item = candidateId.startsWith("group:")
      ? organizationView.data.groups.find((group) => `group:${group.id}` === candidateId)
      : organizationView.data.regenerations.find((run) => `regeneration:${run.id}` === candidateId);
    if (!candidateId || item?.status !== "ready" || !state.current) return true;
    const confirmed = await confirmDashboard(
      "적용하지 않은 후보를 버릴까요? 이 후보는 다시 열 수 없습니다.",
      false,
      { title: "후보 버리기", confirm: "후보 버리기", cancel: "계속 확인" },
    );
    if (!confirmed) return false;
    try {
      const chat = encodeURIComponent(state.current.chatId);
      if (candidateId.startsWith("group:")) await client.request(`/v1/chats/${chat}/memory-groups/${encodeURIComponent(item.id)}/discard`, { method: "POST" });
      else await client.request(`/v1/chats/${chat}/regenerations/${encodeURIComponent(item.id)}`, { method: "DELETE" }, 120_000);
      organizationView.candidateId = "";
      organizationView.selection = [];
      organizationView.mobileDetail = Boolean(organizationView.focusedId);
      await refresh({ forceApply: true });
      return true;
    } catch (error) {
      organizationView.error = error instanceof Error ? error.message : String(error);
      render();
      return false;
    }
  };

  root.addEventListener("click", async (event) => {
    const clickedElement = event.target as HTMLElement;
    const clickedMenu = clickedElement.closest<HTMLDetailsElement>(".memory-actions-menu, .record-menu");
    root.querySelectorAll<HTMLDetailsElement>(".memory-actions-menu[open], .record-menu[open]").forEach((menu) => {
      if (menu !== clickedMenu) menu.open = false;
    });
    const target = clickedElement.closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (["data-search", "data-filter", "inheritance-search", "select-inheritance-source", "select-probe-source", "ack-delete", "ack-lineage-replacement"].includes(action ?? "")) return;
    if (action === "close") {
      if (organizationView.open && !await discardReadyOrganizationCandidate()) return;
      unsubscribeActivity?.();
      translationObserver?.disconnect();
      if (actionSaveTimer) clearTimeout(actionSaveTimer);
      await closeDashboardContainer(state);
      dashboardOpen = false;
      return;
    }
    if (action === "tab") {
      const nextTab = target.dataset.tab as Tab;
      if (organizationView.open && nextTab !== activeTab && !await discardReadyOrganizationCandidate()) return;
      if (nextTab === "settings" && ["chat", "memory", "server"].includes(target.dataset.settingsSection ?? "")) {
        settingsSection = target.dataset.settingsSection as SettingsSection;
      }
      const requestedAttentionFilter = target.dataset.attentionFilter as AttentionFilter | undefined;
      if (nextTab === "reviews" && requestedAttentionFilter && ["all", "duplicate", "conflict", "audit"].includes(requestedAttentionFilter)) {
        attentionView.filter = requestedAttentionFilter;
        attentionView.selectedId = "";
        attentionView.query = "";
        attentionView.mobileDetail = false;
      }
      if (nextTab === "timeline" && activeTab !== "timeline") timelineView.mobileDetail = false;
      if (nextTab === "initial" && activeTab !== "initial") {
        peopleView.selectedId = "";
        peopleView.editing = false;
        peopleView.mobileDetail = false;
        peopleView.management = "";
      }
      if (nextTab === "relationships" && activeTab !== "relationships") {
        selectedRelationship = "";
        relationshipEditing = false;
        relationshipMobileDetail = false;
        intimacyEditor = undefined;
        socialEditor = undefined;
      }
      timelineView.editing = false;
      storyView.editingOverview = false;
      storyView.overviewDraft = undefined;
      activeTab = nextTab;
      formDirty = false;
      if (pendingData) { data = pendingData; pendingData = undefined; newDataAvailable = false; }
      render(false);
      void refresh({ forceApply: true });
      return;
    }
    if (action === "open-initial-calibration") {
      activeTab = "initial";
      peopleView.selectedId = "";
      peopleView.editing = false;
      peopleView.mobileDetail = false;
      peopleView.management = "";
      formDirty = false;
      render(false);
      void refresh({ forceApply: true });
      return;
    }
    if (action === "add-regex-rule") {
      const list = root.querySelector<HTMLElement>("[data-regex-rules]");
      if (!list) return;
      const disclosure = root.querySelector<HTMLDetailsElement>("[data-regex-disclosure]");
      if (disclosure) disclosure.open = true;
      const shell = document.createElement("div");
      shell.innerHTML = regexRuleEditor({ name: "", enabled: true, pattern: "", flags: "gis" });
      const row = shell.firstElementChild as HTMLElement | null;
      if (!row) return;
      list.append(row);
      const empty = list.querySelector<HTMLElement>("[data-regex-empty]");
      if (empty) empty.hidden = true;
      updateRegexRuleSummary();
      row.querySelector<HTMLInputElement>('input[name="customRuleName"]')?.focus();
      formDirty = true;
      return;
    }
    if (action === "remove-regex-rule") {
      const list = target.closest("[data-regex-rules]");
      target.closest("[data-regex-rule]")?.remove();
      const empty = list?.querySelector<HTMLElement>("[data-regex-empty]");
      if (empty) empty.hidden = Boolean(list?.querySelector("[data-regex-rule]"));
      updateRegexRuleSummary();
      formDirty = true;
      return;
    }
    if (action === "settings-section") {
      const next = target.dataset.section as SettingsSection;
      if (!["chat", "memory", "server"].includes(next)) return;
      settingsSection = next;
      root.querySelectorAll<HTMLElement>("[data-settings-pane]").forEach((pane) => { pane.hidden = pane.dataset.settingsPane !== next; });
      root.querySelectorAll<HTMLElement>(".settings-nav [data-section]").forEach((button) => button.setAttribute("aria-current", button.dataset.section === next ? "page" : "false"));
      const voyage = root.querySelector<HTMLElement>("[data-settings-voyage]");
      if (voyage) voyage.hidden = next !== "server";
      root.querySelector<HTMLElement>(".settings-panel")?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (action === "attention-filter") {
      const next = target.dataset.filter as AttentionFilter;
      if (!["all", "duplicate", "conflict", "audit"].includes(next)) return;
      attentionView.filter = next;
      attentionView.selectedId = "";
      attentionView.mobileDetail = false;
      render(false);
      return;
    }
    if (action === "select-attention") {
      attentionView.selectedId = target.dataset.id ?? "";
      attentionView.mobileDetail = Boolean(attentionView.selectedId);
      render(false);
      return;
    }
    if (action === "attention-back") {
      attentionView.mobileDetail = false;
      render(false);
      return;
    }
    if (action === "load-data-inventory") {
      dataView.inventoryStatus = "idle";
      void loadDataInventory();
      return;
    }
    if (action === "apply-probed-lineage" && state.current && state.lineageProbe?.result?.fingerprint) {
      const parentChatId = target.dataset.parentId || state.lineageProbe.selectedParentId;
      if (!parentChatId) return;
      try {
        await client.request(`/v1/chats/${encodeURIComponent(state.current.chatId)}/lineage/apply`, { method: "POST", body: JSON.stringify({ ...lineageProbePayload(state.current), parentChatId, fingerprint: state.lineageProbe.result.fingerprint }) }, 60_000);
        await inheritLineageSettings(state, state.current, parentChatId);
        state.lineageProbe = undefined;
        addLog(state.logs, "info", "Read-only lineage match applied without provider calls");
        await refresh({ forceApply: true });
      } catch (error) {
        const failedProbe = state.lineageProbe;
        if (failedProbe) state.lineageProbe = { key: failedProbe.key, status: "failed", result: failedProbe.result, selectedParentId: parentChatId, error: String(error) };
        data.error = String(error);
        render();
      }
      return;
    }
    if (action === "refresh") { await refresh(); return; }
    if (action === "check-update") {
      try {
        await refreshUpdateStatus(state, client, { remote: true, force: true });
      } catch (error) { data.error = error instanceof Error ? error.message : String(error); }
      render();
      await showCompletedProductReleaseNotice(state);
      return;
    }
    if (action === "stage-server-update") {
      target.setAttribute("disabled", "true");
      try {
        const result = await installServerUpdate(state, client);
        if (result.status === "completed") {
          showActionSaveState({ kind: "success", message: `RCM ${result.targetVersion ?? "새 버전"} 서버 업데이트를 완료했습니다.` });
          await showCompletedProductReleaseNotice(state);
        }
        else if (result.status === "failed") data.error = result.message ?? "서버 업데이트를 완료하지 못했습니다.";
      } catch (error) { data.error = error instanceof Error ? error.message : String(error); }
      render();
      return;
    }
    if (action === "story-mode") {
      const mode = target.dataset.mode as TimelineDetailMode;
      if (["translation", "canonical", "compare"].includes(mode)) storyView.detailMode = mode;
      render(false);
      return;
    }
    if (action === "edit-story-overview") {
      const overview = data.storySpine?.overview;
      if (!overview) return;
      storyView.editingOverview = true;
      storyView.overviewDraft = String(overview.summary ?? "");
      formDirty = false;
      render(false);
      window.requestAnimationFrame(() => root.querySelector<HTMLTextAreaElement>('#story-overview-form textarea[name="summary"]')?.focus());
      return;
    }
    if (action === "load-story-overview-backup" && state.current) {
      const backup = state.settings.storyOverviewBackups[state.current.chatId];
      if (!backup) return;
      storyView.editingOverview = true;
      storyView.overviewDraft = backup.summary;
      formDirty = false;
      render(false);
      window.requestAnimationFrame(() => root.querySelector<HTMLTextAreaElement>('#story-overview-form textarea[name="summary"]')?.focus());
      return;
    }
    if (action === "cancel-story-overview") {
      formDirty = editorHasChanges();
      if (formDirty && !await confirmDashboard("저장하지 않은 줄거리 수정을 버릴까요?")) return;
      storyView.editingOverview = false;
      storyView.overviewDraft = undefined;
      formDirty = false;
      if (pendingData) { data = pendingData; pendingData = undefined; newDataAvailable = false; }
      render(false);
      return;
    }
    if (action === "toggle-story-index") {
      storyView.indexOpen = !storyView.indexOpen;
      render(false);
      return;
    }
    if (action === "select-story-group") {
      storyView.selectedGroupId = target.dataset.groupId ?? "";
      storyView.indexOpen = false;
      storyView.expandedMemoryId = "";
      render(false);
      return;
    }
    if (action === "toggle-story-memory") {
      const id = target.dataset.memoryId ?? "";
      const nextId = storyView.expandedMemoryId === id ? "" : id;
      const previousStoryScroll = root.querySelector<HTMLElement>(".story-reader__scroll");
      const previousMain = root.querySelector<HTMLElement>(".main");
      const storyPosition = { left: previousStoryScroll?.scrollLeft ?? 0, top: previousStoryScroll?.scrollTop ?? 0 };
      const mainPosition = { left: previousMain?.scrollLeft ?? 0, top: previousMain?.scrollTop ?? 0 };
      target.blur();
      storyView.expandedMemoryId = nextId;
      render();
      placeStoryMemoryPreview(nextId);
      const restorePosition = () => {
        root.querySelector<HTMLElement>(".story-reader__scroll")?.scrollTo(storyPosition);
        root.querySelector<HTMLElement>(".main")?.scrollTo(mainPosition);
      };
      restorePosition();
      window.requestAnimationFrame(() => {
        restorePosition();
        window.requestAnimationFrame(restorePosition);
      });
      return;
    }
    if ((action === "toggle-story-pin" || action === "toggle-story-hidden" || action === "rebuild-story-spine") && state.current) {
      const chat = encodeURIComponent(state.current.chatId);
      if (action === "rebuild-story-spine") {
        if (!await confirmDashboard("현재 파생 스토리 지도만 다시 만들까요? 정본 기억과 원문은 변경되지 않습니다.")) return;
        await client.request(`/v1/chats/${chat}/story-spine/rebuild`, { method: "POST" });
        void drainWorker(state, client);
      } else {
        await client.request(`/v1/chats/${chat}/story-spine/${encodeURIComponent(target.dataset.groupId ?? "")}`, {
          method: "PATCH",
          body: JSON.stringify(action === "toggle-story-pin" ? { pinned: target.dataset.value === "true" } : { hidden: target.dataset.value === "true" }),
        });
      }
      await refresh({ forceApply: true });
      return;
    }
    if (action === "open-timeline-memory") {
      selectedMemory = target.dataset.memoryId ?? "";
      activeTab = "timeline";
      timelineView.editing = false;
      timelineView.mobileDetail = true;
      render(false);
      return;
    }
    if (action === "submit-form") {
      const form = target.closest<HTMLFormElement>("form");
      if (!form) return;
      if (!form.reportValidity()) return;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return;
    }
    if (action === "open-lineage-transfer") {
      dataView.inheritanceOpen = true;
      dataView.inheritancePreview = undefined;
      dataView.inheritanceError = undefined;
      render(); return;
    }
    if (action === "inherit-from-chat") {
      dataView.inheritanceOpen = true;
      dataView.inheritanceSourceId = target.dataset.chatId;
      dataView.inheritancePreview = undefined;
      dataView.inheritanceReplacementAcknowledged = false;
      dataView.inheritanceError = undefined;
      render(); return;
    }
    if (action === "close-lineage-transfer") { dataView.inheritanceOpen = false; dataView.inheritancePreview = undefined; dataView.inheritanceError = undefined; render(); return; }
    if (action === "cancel-lineage-preview") { dataView.inheritancePreview = undefined; dataView.inheritanceError = undefined; render(); return; }
    if (action === "preview-lineage-transfer" && state.current && dataView.inheritanceSourceId) {
      try {
        dataView.inheritanceError = undefined;
        if (!data.adminChats.some((chat) => chat.id === state.current!.chatId)) await syncCompleteSourceLedger(client, state.current);
        dataView.inheritancePreview = await client.request<ManualLineagePreview>(`/v1/chats/${encodeURIComponent(state.current.chatId)}/memory-transplant/preview`, { method: "POST", body: JSON.stringify({ sourceChatId: dataView.inheritanceSourceId }) }, 30_000);
      } catch (error) {
        dataView.inheritanceError = String(error);
      }
      render(); return;
    }
    if (action === "apply-lineage-transfer" && state.current && dataView.inheritanceSourceId && dataView.inheritancePreview) {
      try {
        if (dataView.inheritancePreview.requiresReplacement && !dataView.inheritanceReplacementAcknowledged) return;
        await client.request(`/v1/chats/${encodeURIComponent(state.current.chatId)}/memory-transplant`, { method: "POST", body: JSON.stringify({ sourceChatId: dataView.inheritanceSourceId, fingerprint: dataView.inheritancePreview.fingerprint, replaceDerived: dataView.inheritancePreview.requiresReplacement === true }) }, 120_000);
        dataView.inheritanceOpen = false;
        dataView.inheritancePreview = undefined;
        dataView.inheritanceReplacementAcknowledged = false;
        addLog(state.logs, "info", "Cross-bot memory snapshot inherited without provider calls");
        await refresh();
      } catch (error) { dataView.inheritanceError = String(error); render(); }
      return;
    }
    if (action === "view-server-data") { await loadServerInspector(target.dataset.chatId ?? ""); return; }
    if ((typeof __RCM_DISTRIBUTION__ === "undefined" || !__RCM_DISTRIBUTION__) && action === "toggle-retrieval-diagnostics") {
      const chatId = target.dataset.chatId ?? "";
      try {
        const enabled = await setRetrievalDiagnostics(client, data, chatId, target.dataset.enabled !== "true");
        addLog(state.logs, "info", `Retrieval diagnostics ${enabled ? "enabled" : "disabled"} for chat ${chatId}`);
        render();
      } catch (error) { data.error = String(error); render(); }
      return;
    }
    if (action === "close-server-inspector") { dataView.inspector = undefined; render(); return; }
    if (action === "reveal-ledger-content" && dataView.inspector) { await loadServerInspector(dataView.inspector.chatId, dataView.inspector.ledger?.offset ?? 0, true); return; }
    if (action === "ledger-page" && dataView.inspector) { await loadServerInspector(dataView.inspector.chatId, Number(target.dataset.offset ?? 0), dataView.inspector.ledger?.includesContent === true); return; }
    if (action === "export-complete-backup" || action === "export-chat-backup") { try { const chatId=action==="export-chat-backup"?(target.dataset.chatId||state.current?.chatId):undefined;if(action==="export-chat-backup"&&!chatId)throw new Error("백업할 채팅을 선택해주세요.");await exportCompleteBackup(chatId); } catch (error) { dataView.backupExportError = error instanceof Error ? error.message : String(error); render(); } return; }
    if (action === "open-data-operation") {
      dataView.confirmation = { action: target.dataset.operation as DataConfirmation["action"], chatId: target.dataset.chatId ?? "" };
      render(); return;
    }
    if (action === "cancel-data-operation") { dataView.confirmation = undefined; render(); return; }
    if (action === "confirm-data-operation" && dataView.confirmation) {
      const { action: operation, chatId } = dataView.confirmation;
      try {
        if (operation === "rebuild") requireChatMemoryEnabled(state, chatId);
        const extractionReviewOverride = operation === "rebuild"
          ? await chooseExtractionReviewOverride(
            "전체 기억을 재검수할까요?",
            "전체 원문을 다시 추출한 뒤 보조 모델이 각 그룹의 결과를 한 번 더 검토할 수 있습니다. 정확도는 높아질 수 있지만 호출량과 비용이 늘어납니다.",
            state.settings.postExtractionReview,
          )
          : undefined;
        if (operation === "rebuild" && extractionReviewOverride === undefined) return;
        const path = operation === "rebuild" ? `/v1/chats/${encodeURIComponent(chatId)}/reprocess`
          : `/v1/chats/${encodeURIComponent(chatId)}`;
        let rebuildContext: Awaited<ReturnType<typeof readCurrentContext>> | undefined;
        let expectedSourceMessages: number | undefined;
        if (operation === "rebuild" && state.current?.chatId === chatId) {
          rebuildContext = await readCurrentContext(state, { snapshotMode: "full" });
          const synced = await syncCompleteSourceLedger(client, rebuildContext);
          expectedSourceMessages = synced.expectedSourceMessages;
          const serverUrl = state.settings.serverUrl.replace(/\/$/, "");
          state.settings.serverInstances[serverUrl] = synced.serverInstanceId;
          await saveSettings(state.settings);
        }
        const resolvedSetup = operation === "rebuild" && state.lastResolvedSetup?.chatId === chatId
          ? state.lastResolvedSetup.projection
          : undefined;
        const result = await client.request<any>(path, {
          method: operation === "rebuild" ? "POST" : "DELETE",
          ...(operation === "rebuild" ? {
            body: JSON.stringify(withExtractionReviewOverride({
              activatePendingMemoryLanguage: true,
              resolvedSetup,
              identityHints: rebuildContext?.identityHints,
              expectedSourceMessages,
            }, extractionReviewOverride as boolean)),
          } : {}),
        }, operation === "rebuild" ? 120_000 : 30_000);
        if (operation === "rebuild" && state.current?.chatId === chatId && !state.settings.workerPaused) void drainWorker(state, client);
        if (operation === "delete") {
          clearDeletedChatState(state, chatId);
          if (data.chatId === chatId) {
            ++refreshGeneration; // Ignore reads started before the deletion.
            data = { ...emptyData(), chatId, health: data.health, adminChats: data.adminChats.filter(item => item.id !== chatId) };
            pendingData = undefined;
            newDataAvailable = false;
            Object.assign(organizationView, createOrganizationView());
            render();
          }
          await invalidateTranslationCache(state, { chatId });
          await saveSettings(state.settings);
        }
        addLog(state.logs, "info", operation === "rebuild"
          ? result.awaitingCalibration
            ? "Initial setup analysis queued; confirm the setup ledger before transcript extraction starts"
            : `Ledger rebuild queued: ${Number(result.queuedJobs ?? 0)} job(s)`
          : `Data operation completed: ${operation}`);
        if (operation === "rebuild" && result.awaitingCalibration) activeTab = "initial";
        dataView.confirmation = undefined;
        if (dataView.inspector?.chatId === chatId) dataView.inspector = undefined;
        await refresh({ forceApply: operation === "delete" });
      } catch (error) {
        const message = String(error);
        data.error = message.includes("(INITIAL_SETUP_REQUIRED)")
          ? "초기 장부를 만들려면 이 채팅의 최종 설정문을 먼저 불러와야 합니다. 새 플러그인을 설치한 뒤 모델 요청을 한 번 실행하고, 페이지를 새로고침하지 않은 상태에서 다시 시도하세요. 응답 생성을 시작한 뒤 취소해도 됩니다. 기존 기억은 삭제되지 않았습니다."
          : message;
        render();
      }
      return;
    }
    if (action === "select-lineage" && state.current) {
      const selectedChatId = data.chatId ?? state.current.chatId;
      const current = await readCurrentContext(state);
      if (current.chatId !== selectedChatId) {
        await refresh();
        await alertDashboard('채팅이 변경되었습니다. 현재 채팅에서 다시 선택해 주세요.');
        return;
      }
      try {
        await client.request(`/v1/chats/${encodeURIComponent(current.chatId)}/lineage/select`, { method: "POST", body: JSON.stringify({ ...lineageProbePayload(current), parentChatId: target.dataset.parentId,
          fingerprint: data.lineage?.ambiguousCandidates?.find(item => item.chatId === target.dataset.parentId)?.fingerprint }) }, 30_000);
      } catch (error) {
        if (!String(error).includes('LINEAGE_PROBE_STALE')) throw error;
        await refresh();
        await alertDashboard('원문이나 원본 기억이 변경되어 상속을 적용하지 않았습니다. 목록을 확인하고 다시 선택해 주세요.');
        return;
      }
      await refresh(); return;
    }
    if (action === "decline-lineage" && state.current) {
      await client.request(`/v1/chats/${encodeURIComponent(state.current.chatId)}/lineage/decline`, { method: "POST", body: JSON.stringify({ fingerprint: target.dataset.fingerprint }) }, 15_000);
      await refresh(); return;
    }
    if (action === "acknowledge-lineage" && state.current) {
      await client.request(`/v1/chats/${encodeURIComponent(state.current.chatId)}/lineage/acknowledge`, { method: "POST" }, 30_000);
      await refresh(); return;
    }
    if (action === "revert-lineage" && state.current) {
      if (!await confirmDashboard("상속된 기억과 파생 상태를 비우고, 현재 Risu 원문만으로 다시 시작할까요? Risu 원문은 변경되지 않습니다.")) return;
      await client.request(`/v1/chats/${encodeURIComponent(state.current.chatId)}/lineage/revert`, { method: "POST" }, 30_000);
      await refresh(); return;
    }
    if (action === "select-memory") {
      formDirty = editorHasChanges();
      if (formDirty && !await confirmDashboard("저장하지 않은 정본 변경을 버리고 다른 기억을 열까요?")) return;
      formDirty = false;
      selectedMemory = target.dataset.id ?? "";
      const memory = data.memories.find((item) => item.id === selectedMemory);
      timelineView.editing = false;
      timelineView.creating = false;
      timelineView.mobileDetail = true;
      render(false);
      if (memory) void queueMemoryTranslation(memory);
      return;
    }
    if (action === "new-manual-memory") {
      formDirty = false;
      timelineView.editing = false;
      timelineView.creating = true;
      timelineView.mobileDetail = true;
      render(false);
      return;
    }
    if (action === "cancel-manual-memory") {
      formDirty = editorHasChanges();
      if (formDirty && !await confirmDashboard("저장하지 않은 기억을 버리고 목록으로 돌아갈까요?")) return;
      formDirty = false;
      timelineView.creating = false;
      timelineView.mobileDetail = false;
      render(false);
      return;
    }
    if (action === "timeline-filter") {
      timelineView.creating = false;
      const filter = target.dataset.filter;
      if (filter === "landmark") timelineView.landmarkOnly = !timelineView.landmarkOnly;
      if (filter === "pinned") timelineView.pinnedOnly = !timelineView.pinnedOnly;
      if (filter === "inactive") timelineView.includeInactive = !timelineView.includeInactive;
      const visible = filterTimelineMemories(data.memories, timelineView);
      if (!visible.some((memory) => memory.id === selectedMemory)) selectedMemory = visible.find((memory) => !memory.capsule_parent_id)?.id ?? visible[0]?.id ?? "";
      timelineView.editing = false;
      render(false);
      return;
    }
    if (action === "timeline-order") {
      timelineView.sortOrder = timelineView.sortOrder === "descending" ? "ascending" : "descending";
      render(false);
      return;
    }
    if (action === "timeline-mode") {
      const mode = target.dataset.mode as TimelineDetailMode;
      if (["translation", "canonical", "compare"].includes(mode)) timelineView.detailMode = mode;
      timelineView.editing = false;
      render(false);
      return;
    }
    if (action === "edit-memory") {
      timelineView.editing = true;
      render(false);
      return;
    }
    if (action === "timeline-back") {
      formDirty = editorHasChanges();
      if (formDirty && !await confirmDashboard("저장하지 않은 정본 변경을 버리고 목록으로 돌아갈까요?")) return;
      formDirty = false;
      timelineView.editing = false;
      timelineView.creating = false;
      timelineView.mobileDetail = false;
      render(false);
      return;
    }
    if (action === "timeline-adjacent" && target.dataset.id) {
      formDirty = editorHasChanges();
      if (formDirty && !await confirmDashboard("저장하지 않은 정본 변경을 버리고 다른 기억을 열까요?")) return;
      formDirty = false;
      selectedMemory = target.dataset.id;
      timelineView.editing = false;
      timelineView.mobileDetail = true;
      render(false);
      const memory = data.memories.find((item) => item.id === selectedMemory);
      if (memory) void queueMemoryTranslation(memory);
      return;
    }
    if (action === "cancel-memory-edit") {
      formDirty = editorHasChanges();
      if (formDirty && !await confirmDashboard("저장하지 않은 정본 변경을 버리고 수정 화면을 닫을까요?")) return;
      formDirty = false;
      timelineView.editing = false;
      if (pendingData) { data = pendingData; pendingData = undefined; newDataAvailable = false; }
      render();
      return;
    }
    if (action === "retry-translation") {
      const memory = data.memories.find((item) => item.id === target.dataset.id);
      if (memory) void queueMemoryTranslation(memory, true);
      return;
    }
    if (action === "clear-translation-cache") {
      await clearTranslationCache(state);
      translations.clear();
      translationRequested.clear();
      cacheStats = { ...cacheStats, items: 0, bytes: 0 };
      render();
      return;
    }
    if (action === "select-person") {
      const id = target.dataset.id ?? "";
      peopleView.selectedId = peopleView.selectedId === id ? "" : id;
      peopleView.editing = false;
      peopleView.mobileDetail = Boolean(peopleView.selectedId);
      peopleView.management = "";
      formDirty = false;
      render(false);
      return;
    }
    if (action === "people-filter") {
      const value = target.dataset.value as PeopleViewState["prominence"];
      if (["all", "primary", "supporting", "reference"].includes(value)) peopleView.prominence = value;
      peopleView.selectedId = "";
      peopleView.editing = false;
      peopleView.mobileDetail = false;
      peopleView.management = "";
      render(false);
      return;
    }
    if (action === "new-person") {
      peopleView.selectedId = "__new__";
      peopleView.editing = true;
      peopleView.mobileDetail = true;
      peopleView.management = "";
      formDirty = false;
      render(false);
      return;
    }
    if (action === "edit-person") {
      peopleView.editing = true;
      peopleView.management = "";
      formDirty = false;
      render(false);
      return;
    }
    if (action === "close-people-management") {
      peopleView.management = "";
      peopleView.mobileDetail = false;
      entityMergePreview = undefined;
      render(false);
      return;
    }
    if (action === "close-person" || action === "close-person-editor") {
      formDirty = editorHasChanges();
      if (formDirty && !await confirmDashboard("저장하지 않은 인물 변경을 버릴까요?")) return;
      const adding = peopleView.selectedId === "__new__";
      formDirty = false;
      peopleView.editing = false;
      if (action === "close-person" || adding) {
        peopleView.selectedId = "";
        peopleView.mobileDetail = false;
      }
      render(false);
      return;
    }
    if (action === "open-person-relations") {
      activeTab = "relationships";
      relationshipSection = "state";
      relationshipPerson = target.dataset.name ?? "";
      selectedRelationship = "";
      relationshipEditing = false;
      relationshipMobileDetail = false;
      render(false);
      return;
    }
    if (action === "open-relationship-person") {
      const name = String(target.dataset.personName ?? "").normalize("NFKC").trim().toLocaleLowerCase();
      // The people reader merges live entities with initial-calibration records and
      // keeps the calibration id when the names match. Prefer that same record here
      // so a relationship participant link opens the reader instead of only the list.
      const candidates = [...(data.initialCalibration?.entities ?? []), ...data.entities];
      const person = candidates.find((item: any) => [item.name, item.displayName, item.internalName, ...(item.aliases ?? [])]
        .some((value) => String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase() === name));
      activeTab = "initial";
      peopleView.selectedId = person ? String(person.id) : "";
      peopleView.query = person ? "" : target.dataset.personName ?? "";
      peopleView.editing = false;
      peopleView.mobileDetail = Boolean(person);
      peopleView.management = "";
      render(false);
      return;
    }
    if (action === "open-relationship") {
      selectedRelationship = target.dataset.key ?? "";
      relationshipPerson = selectedRelationship.split("|")[0] ?? "";
      relationshipSection = "state";
      activeTab = "relationships";
      relationshipEditing = false;
      relationshipMobileDetail = true;
      render(false);
      return;
    }
    if (action === "select-relationship") {
      const key = target.dataset.key ?? "";
      selectedRelationship = selectedRelationship === key ? "" : key;
      relationshipStateView = "list";
      relationshipEditing = false;
      relationshipMobileDetail = Boolean(selectedRelationship);
      render();
      return;
    }
    if (action === "relationship-section") { relationshipSection = target.dataset.section === "acquaintances" ? "acquaintances" : "state"; selectedRelationship = ""; relationshipEditing = false; relationshipMobileDetail = false; intimacyEditor = undefined; socialEditor = undefined; render(); return; }
    if (action === "relationship-state-view") {
      relationshipStateView = target.dataset.view === "network" ? "network" : "list";
      relationshipEditing = false;
      relationshipMobileDetail = false;
      render();
      return;
    }
    if (action === "back-relationship-list") { selectedRelationship = ""; relationshipEditing = false; relationshipMobileDetail = false; intimacyEditor = undefined; render(); return; }
    if (action === "edit-relationship") { relationshipEditing = true; render(); return; }
    if (action === "close-relationship-editor") {
      formDirty = editorHasChanges();
      if (formDirty && !await confirmDashboard("저장하지 않은 관계 변경을 버릴까요?")) return;
      relationshipEditing = false; intimacyEditor = undefined; formDirty = false; render(); return;
    }
    if (action === "reset-relationship-auto") {
      const [from, to] = (target.dataset.key ?? "").split("|");
      if (!from || !to || !state.current) return;
      if (!await confirmDashboard("수동으로 고정한 관계 요약과 값을 해제하고, 저장된 초기 상태와 관계 변화를 기준으로 다시 계산할까요?\n\n완료 전까지 현재 값이 표시될 수 있습니다.")) return;
      const chat = encodeURIComponent(state.current.chatId);
      const result = await client.request<{ ok: boolean }>(`/v1/chats/${chat}/relationships`, { method: "PATCH", body: JSON.stringify({ from, to, clear: true }) });
      if (!result.ok) throw new Error("자동 계산으로 되돌리지 못했습니다.");
      relationshipEditing = false;
      formDirty = false;
      await refresh({ forceApply: true });
      showActionSaveState({ kind: "success", message: "수동 수정을 해제하고 관계를 다시 계산하고 있습니다." });
      return;
    }
    if (action === "set-world-kind") {
      const next = target.dataset.kind as WorldKind;
      if (!["assertions", "beliefs", "promises"].includes(next)) return;
      worldKind = next;
      worldView.selectedId = "";
      worldView.query = "";
      worldView.filter = next === "promises" ? "open" : "current";
      worldView.mobileDetail = false;
      worldEditor = undefined;
      render(); return;
    }
    if (action === "world-filter") {
      const next = target.dataset.value as WorldViewState["filter"];
      if (!["current", "history", "all", "open", "completed"].includes(next)) return;
      worldView.filter = next;
      worldView.selectedId = "";
      worldView.mobileDetail = false;
      worldEditor = undefined;
      render(); return;
    }
    if (action === "select-world") {
      worldView.selectedId = target.dataset.id ?? "";
      worldView.mobileDetail = Boolean(worldView.selectedId);
      worldEditor = undefined;
      render(); return;
    }
    if (action === "world-back") {
      worldView.mobileDetail = false;
      worldEditor = undefined;
      render(); return;
    }
    if (action === "new-world") {
      const kind = target.dataset.kind as WorldEditor["kind"];
      if (!["assertion", "belief", "promise"].includes(kind)) return;
      worldEditor = { kind, mode: "create" };
      worldView.mobileDetail = true;
      formDirty = false;
      render();
      root.querySelector<HTMLElement>(".world-editor")?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (action === "edit-world" || action === "delete-world") {
      const kind = target.dataset.kind as WorldEditor["kind"];
      if (!["assertion", "belief", "promise"].includes(kind) || !target.dataset.id) return;
      worldEditor = { kind, id: target.dataset.id, mode: action === "edit-world" ? "edit" : "delete" };
      worldView.mobileDetail = true;
      formDirty = false;
      render();
      root.querySelector<HTMLElement>(".world-editor")?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (action === "cancel-world-edit") {
      formDirty = false;
      worldEditor = undefined;
      worldView.mobileDetail = false;
      if (pendingData) { data = pendingData; pendingData = undefined; newDataAvailable = false; }
      render();
      return;
    }
    if (action === "relationship-filter") { relationshipIntimacyOnly = !relationshipIntimacyOnly; selectedRelationship = ""; relationshipMobileDetail = false; render(); return; }
    if (action === "new-intimacy") { formDirty = false; relationshipEditing = true; intimacyEditor = { participantA: target.dataset.a, participantB: target.dataset.b }; render(); return; }
    if (action === "edit-intimacy") { formDirty = false; relationshipEditing = true; intimacyEditor = { id: target.dataset.id }; render(); return; }
    if (action === "cancel-intimacy") {
      formDirty = false;
      intimacyEditor = undefined;
      if (pendingData) { data = pendingData; pendingData = undefined; newDataAvailable = false; }
      render();
      return;
    }
    if (action === "save-settings") {
      const form = root.querySelector<HTMLFormElement>("#settings-form");
      if (!form) return;
      settingsSaving = true;
      target.setAttribute("disabled", "");
      updateTopbar();
      try {
        await persistSettingsForm(form);
        const voyageForm = root.querySelector<HTMLFormElement>("#voyage-form");
        const voyageKey = voyageForm ? String(new FormData(voyageForm).get("voyageApiKey") ?? "").trim() : "";
        const voyageSaved = voyageKey ? await saveVoyageKey(voyageForm!) : true;
        if (!voyageSaved) throw new Error("일반 설정은 저장했지만 Voyage 키 검증에 실패했습니다.");
        addLog(state.logs, "info", "Settings persistence verified");
        if (!voyageKey) await refresh();
        settingsSaving = false;
        showActionSaveState({ kind: "success", message: "저장됨" });
      } catch (error) {
        settingsSaving = false;
        addLog(state.logs, "error", `Settings save failed: ${String(error)}`);
        const attempted = new FormData(form);
        showActionSaveState({ kind: "error", message: settingsSaveFailureMessage(error, {
          serverUrl: String(attempted.get("serverUrl") ?? state.settings.serverUrl).trim(),
          serverToken: String(attempted.get("serverToken") ?? state.settings.serverToken).trim(),
        }) });
      } finally {
        settingsSaving = false;
        target.removeAttribute("disabled");
        updateTopbar();
      }
      return;
    }
    if (action === "save-voyage-key") {
      const form = root.querySelector<HTMLFormElement>("#voyage-form");
      if (form) await saveVoyageKey(form);
      return;
    }
    if (action === "remove-voyage-key") {
      if (!await confirmDashboard("현재 RCM 서버에 저장된 Voyage API key를 제거할까요? 검색은 FTS로 계속됩니다.")) return;
      try {
        await client.request("/v1/admin/voyage-key", { method: "DELETE" });
        addLog(state.logs, "info", "Voyage API key removed from the server");
        await refresh();
      } catch (error) { data.error = String(error); render(); }
      return;
    }
    if (action === "remove-server-llm-key") {
      if (!await confirmDashboard("현재 선택한 프로바이더의 인증정보를 제거할까요? 서버 처리는 즉시 일시정지됩니다.")) return;
      try {
        const result = await client.request<{ worker: ServerWorkerStatus }>("/v1/admin/server-llm-key", { method: "DELETE" });
        state.serverWorker = result.worker;
        state.settings.workerPaused = true;
        await saveSettings(state.settings);
        addLog(state.logs, "info", "Server LLM API key removed; worker paused");
        await refresh();
      } catch (error) { data.error = String(error); render(); }
      return;
    }
    if (!state.current) return;
    const chat = encodeURIComponent(state.current.chatId);
    try {
      if (action?.startsWith('organization-') || action === 'related-source') {
        organizationView.error = undefined;
        try {
          const id = target.dataset.id ?? '';
          const leavesCandidate = ['organization-close', 'organization-list', 'organization-back-detail', 'organization-detail', 'organization-select', 'organization-candidate'].includes(action ?? '');
          if (leavesCandidate && !await discardReadyOrganizationCandidate()) return;
          if (action === 'organization-close') organizationView.open = false;
          else if (action === 'organization-list') { organizationView.mobileDetail = false; organizationView.candidateId = ''; }
          else if (action === 'organization-back-detail') { organizationView.candidateId = ''; organizationView.mobileDetail = Boolean(organizationView.focusedId); }
          else if (action === 'organization-open' || action === 'related-source') {
            organizationView.open = true; activeTab = 'timeline';
            organizationView.data = await client.request<OrganizationData>(`/v1/chats/${chat}/memory-organization`);
            if (action === 'related-source') {
              organizationView.highlightedIds = organizationView.data.ranges.filter((row) => row.memoryIds.includes(id)).map((row) => row.id);
              organizationView.focusedId = organizationView.highlightedIds[0] ?? '';
              organizationView.candidateId = '';
              if (organizationView.focusedId) {
                organizationView.detail = await client.request(`/v1/chats/${chat}/source-ranges/${encodeURIComponent(organizationView.focusedId)}`);
                organizationView.mobileDetail = true;
              } else organizationView.error = '이 기억에 연결된 처리 원문 묶음이 없어.';
            }
          } else if (action === 'organization-select') {
            organizationView.selection = toggleOrganizationRange(organizationView.data.ranges, organizationView.selection, id);
          } else if (action === 'organization-detail') {
            organizationView.focusedId = id; organizationView.candidateId = ''; organizationView.mobileDetail = true;
            organizationView.detail = await client.request(`/v1/chats/${chat}/source-ranges/${encodeURIComponent(id)}`);
          } else if (action === 'organization-candidate') { organizationView.candidateId = id; organizationView.mobileDetail = true; }
          else if (action === 'organization-create-group') {
            requireChatMemoryEnabled(state, state.current.chatId);
            const estimate = await client.request<any>(`/v1/chats/${chat}/memory-groups/preview`, { method: 'POST', body: JSON.stringify({ batchIds: organizationView.selection, postExtractionReview: state.settings.postExtractionReview }) });
            const review = await chooseExtractionReviewOverride('선택한 원문 구간을 묶을까요?',
              `원문 묶음 ${estimate.sourceBatchIds.length}개 · 메시지 ${estimate.messageCount}개\n원문 약 ${estimate.rawTokens.toLocaleString()}토큰 · 전체 예상 입력 약 ${estimate.estimatedInputTokens.toLocaleString()}토큰\n처음 ${estimate.initialCalls}회${estimate.mergeRequired ? ' + 단계별 통합' : ''}로 처리합니다. 재검수를 사용하면 검수 단계가 추가됩니다. 이 수치는 실제 청구량이 아닙니다.\n기존 세부·대사·상태는 보존되며, 결과를 확인한 뒤 적용할 수 있습니다.${estimate.partialIds.length ? ` 범위 밖 근거도 가진 기억 ${estimate.partialIds.length}개는 원래 위치에 남습니다.` : ''}`,
              state.settings.postExtractionReview);
            if (review === undefined) return;
            const created = await client.request<{ runId: string }>(`/v1/chats/${chat}/memory-groups/create`, { method: 'POST', body: JSON.stringify({ batchIds: organizationView.selection, postExtractionReview: review }) });
            organizationView.candidateId = `group:${created.runId}`; organizationView.mobileDetail = true;
            void drainWorker(state, client);
            await refresh({ forceApply: true }); return;
          } else if (action === 'organization-release-hold') {
            const result = await client.request<any>(`/v1/chats/${chat}/episodes/${encodeURIComponent(id)}/release`, { method: 'POST' });
            state.episodeActivity = result.active ?? null;
            await refresh({ forceApply: true }); return;
          } else if (action === 'organization-discard-group' || action === 'organization-discard-regeneration') {
            await discardReadyOrganizationCandidate();
            return;
          } else if (action === 'organization-ungroup' || action.endsWith('-group')) {
            const operation = action === 'organization-ungroup' ? 'ungroup' : action.includes('-apply-') ? 'apply' : action.includes('-discard-') ? 'discard' : 'retry';
            await client.request(`/v1/chats/${chat}/memory-groups/${encodeURIComponent(id)}/${operation}`, { method: 'POST' });
            if (operation !== 'retry') { organizationView.candidateId = ''; organizationView.selection = []; organizationView.mobileDetail = false; }
            else void drainWorker(state, client);
            await refresh({ forceApply: true }); return;
          } else if (action === 'organization-apply-regeneration') {
            await client.request(`/v1/chats/${chat}/regenerations/${encodeURIComponent(id)}/apply`, { method: 'POST' }, 120_000);
            organizationView.candidateId = ''; organizationView.selection = []; organizationView.mobileDetail = false;
            await refresh({ forceApply: true }); return;
          }
        } catch (error) { organizationView.error = error instanceof Error ? error.message : String(error); }
        render();
        if (action === 'organization-select') {
          const control = [...root.querySelectorAll<HTMLInputElement>('[data-action="organization-select"]')].find((input) => input.dataset.id === target.dataset.id);
          control?.focus({ preventScroll: true });
        } else if (action === 'organization-candidate' || action === 'organization-detail') {
          const heading = root.querySelector<HTMLElement>('.organization-reader h2');
          if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
        }
        return;
      }
      if (action === "initial-confirm" || action === "initial-skip" || action === "initial-retry") {
        if (action === "initial-skip" && !await confirmDashboard(data.initialCalibration?.status === "failed"
          ? "초기 분석 없이 원문 기억 생성을 계속할까요? 이름과 별칭은 나중에 인물 설정에서 직접 추가할 수 있습니다."
          : "분석된 초기 이름·관계축을 사용하지 않고 원문 기억 생성을 시작할까요?")) return;
        if (action === "initial-retry" && data.initialCalibration?.status === "awaiting_confirmation"
          && !await confirmDashboard("현재 미확정 이름·초기 관계 장부를 버리고 같은 렌더링 설정으로 다시 분석할까요? 직접 수정한 값도 교체됩니다.")) return;
        if (action === "initial-retry" && ["ready", "inherited", "skipped"].includes(data.initialCalibration?.status ?? "")
          && !await confirmDashboard("현재 인물 설정을 다시 읽을까요? 직접 수정한 초기 이름과 관계값이 새 분석 결과로 바뀔 수 있습니다.")) return;
        const freshSetup = action === "initial-retry" && state.lastResolvedSetup?.chatId === state.current.chatId
          ? state.lastResolvedSetup.projection
          : undefined;
        const result = await client.request<{ calibration: InitialCalibrationActivity }>(`/v1/chats/${chat}/initial-calibration/${action === "initial-confirm" ? "confirm" : action === "initial-skip" ? "skip" : "retry"}`, {
          method: "POST",
          ...(freshSetup ? { body: JSON.stringify({ resolvedSetup: freshSetup, identityHints: state.current.identityHints }) } : {}),
        }, 120_000);
        state.statusSummary = {
          ...(state.statusSummary ?? { queuedJobs: 0, failedJobs: 0, pendingReviews: 0, pendingEmbeddings: 0, failedEmbeddings: 0 }),
          initialCalibration: result.calibration,
        };
        state.publishStatusSummary?.();
        void drainWorker(state, client);
        await refresh({ forceApply: true });
      } else if (action === "save-initial-entity" || action === "add-initial-entity") {
        const form = target.closest<HTMLFormElement>("form");
        if (!form?.reportValidity()) return;
        const values = new FormData(form);
        const payload = { displayName: String(values.get("displayName") ?? "").trim(), aliases: String(values.get("aliases") ?? "").split(",").map((item) => item.trim()).filter(Boolean), prominence: String(values.get("prominence") ?? "supporting") };
        const id = action === "save-initial-entity" ? encodeURIComponent(target.dataset.id ?? "") : "";
        await client.request(`/v1/chats/${chat}/initial-calibration/entities${id ? `/${id}` : ""}`, { method: id ? "PATCH" : "POST", body: JSON.stringify(payload) });
        formDirty = false;
        peopleView.editing = false;
        if (!id) { peopleView.selectedId = ""; peopleView.mobileDetail = false; }
        await refresh({ forceApply: true });
      } else if (action === "delete-initial-entity") {
        const name = target.dataset.name ?? "이 인물";
        if (!await confirmDashboard(`${name}을(를) 초기 이름 장부에서 삭제할까요? 연결된 초기 관계축도 함께 제거됩니다.`)) return;
        await client.request(`/v1/chats/${chat}/initial-calibration/entities/${encodeURIComponent(target.dataset.id ?? "")}`, { method: "DELETE" });
        formDirty = false;
        peopleView.selectedId = "";
        peopleView.editing = false;
        peopleView.mobileDetail = false;
        await refresh({ forceApply: true });
      } else if (action === "save-initial-relationship") {
        const form = target.closest<HTMLFormElement>("form");
        if (!form) return;
        const values = new FormData(form);
        const axes = Object.fromEntries(["affection", "trust", "intimacy", "fear", "jealousy", "hostility"].map((axis) => [axis, String(values.get(axis) ?? "unknown")]));
        await client.request(`/v1/chats/${chat}/initial-calibration/relationships/${encodeURIComponent(target.dataset.id ?? "")}`, { method: "PATCH", body: JSON.stringify({ axes, summary: String(values.get("summary") ?? "") }) });
        formDirty = false;
        await refresh({ forceApply: true });
      } else if (action === "go-entity-merge") {
        activeTab = "initial";
        peopleView.selectedId = "";
        peopleView.editing = false;
        peopleView.mobileDetail = true;
        peopleView.management = "merge";
        render(false);
      } else if (action === "delete-intimacy") {
        await client.request(`/v1/chats/${chat}/physical-intimacy/${encodeURIComponent(target.dataset.id ?? "")}`, { method: "DELETE" });
        intimacyEditor = undefined;
        await refresh({ forceApply: true });
        showActionSaveState({ kind: "success", message: "스킨십 기록 삭제됨" });
      } else if (action === "confirm-delete-world") {
        const kind = target.dataset.kind as WorldEditor["kind"];
        const itemId = target.dataset.id ?? "";
        await client.request(`/v1/chats/${chat}/world-state/${encodeURIComponent(kind)}/${encodeURIComponent(itemId)}`, { method: "DELETE" });
        await invalidateTranslationCache(state, { serverInstanceId: data.health?.instanceId, chatId: state.current.chatId, itemIdPrefix: `${kind}:${itemId}` });
        translations.delete(`${kind}:${itemId}`);
        formDirty = false;
        worldEditor = undefined;
        worldView.selectedId = "";
        worldView.mobileDetail = false;
        if (pendingData) { data = pendingData; pendingData = undefined; newDataAvailable = false; }
        addLog(state.logs, "info", `${kind} removed from derived world state`);
      } else if (action === "resolve-reconciliation") {
        const reviewId = target.dataset.id ?? "";
        const resolution = target.dataset.resolution as "merge" | "distinct" | "update" | "discard";
        const review = data.reconciliationReviews.find((item) => item.id === reviewId);
        if (!review) return;
        const form = root.querySelector<HTMLFormElement>(`.reconciliation-edit[data-review-id="${CSS.escape(reviewId)}"]`);
        const values = form ? new FormData(form) : undefined;
        const editedItem = { ...review.incoming };
        if (values) {
          if (review.itemKind === "memory") { editedItem.title = String(values.get("canonicalTitle") ?? editedItem.title); editedItem.content = String(values.get("canonicalContent") ?? editedItem.content); }
          else if ("value" in editedItem) editedItem.value = String(values.get("canonicalValue") ?? editedItem.value);
          else editedItem.content = String(values.get("canonicalValue") ?? editedItem.content);
        }
        await client.request(`/v1/chats/${chat}/reconciliation-reviews/${encodeURIComponent(reviewId)}`, { method: "PATCH", body: JSON.stringify({ action: resolution, targetId: target.dataset.targetId || undefined, editedItem }) });
        await invalidateTranslationCache(state, { chatId: state.current.chatId, itemIdPrefix: `reconciliation:${reviewId}:` });
        addLog(state.logs, "info", `Duplicate review resolved: ${resolution}`);
      } else if (action === "retry-extraction-audit") {
        const auditId = target.dataset.id ?? "";
        await client.request(`/v1/chats/${chat}/extraction-audits/${encodeURIComponent(auditId)}/retry`, { method: "POST" });
        addLog(state.logs, "info", "Extraction audit queued again with its preserved source and first draft");
      } else if (action === "approve-backfill") {
        requireChatMemoryEnabled(state, state.current.chatId);
        const resolvedSetup = capturedSetupForBackfill(state, state.current.chatId);
        if (!resolvedSetup) {
          await alertDashboard(BACKFILL_SETUP_CAPTURE_MESSAGE);
          addLog(state.logs, "info", "과거 대화로 기억 생성을 시작하지 않음: 초기 설정 캡처가 필요합니다.");
          return;
        }
        const extractionReviewOverride = await chooseExtractionReviewOverride(
          "과거 대화 백필을 재검수할까요?",
          `현재 채팅의 과거 원문 약 ${state.current.estimatedSourceTokens.toLocaleString()} 입력 토큰을 처음부터 처리합니다. 2차 재검수는 정확도를 높일 수 있지만 호출량과 비용이 늘어납니다.`,
          state.settings.postExtractionReview,
        );
        if (extractionReviewOverride === undefined) return;
        const fullContext = await readCurrentContext(state, { snapshotMode: "full" });
        const prepared = await client.prepare(withExtractionReviewOverride(
          makePrepareRequest(fullContext, 0, { forceBackfill: true, deferExtraction: false, resolvedSetup }),
          extractionReviewOverride,
        ), 120_000);
        state.statusSummary = {
          ...(state.statusSummary ?? { queuedJobs: 0, failedJobs: 0, pendingReviews: 0, pendingEmbeddings: 0, failedEmbeddings: 0 }),
          initialCalibration: prepared.initialCalibration,
        };
        state.publishStatusSummary?.();
        const serverUrl = state.settings.serverUrl.replace(/\/$/, "");
        state.settings.serverInstances[serverUrl] = prepared.serverInstanceId;
        state.settings.backfillApproved[`${prepared.serverInstanceId}:${fullContext.chatId}`] = true;
        await saveSettings(state.settings);
        void drainWorker(state, client);
      } else if (action === "set-profile") {
        await changeChatProfile(target.dataset.profile as RpProfile);
      } else if (action === "regenerate-episode" || action === "regenerate-canonical") {
        if (organizationView.busy) return;
        requireChatMemoryEnabled(state, state.current.chatId);
        const batchId = target.dataset.id ?? "";
        const range = organizationView.data.ranges.find((row) => row.id === batchId);
        if (!range?.eligible) throw new Error(range?.reason ?? "원문 구간을 다시 선택해 주세요.");
        const canonical = action === "regenerate-canonical";
        organizationView.busy = true;
        organizationView.error = undefined;
        render();
        try {
          const estimate = await client.request<any>(`/v1/chats/${chat}/extraction-batches/${encodeURIComponent(batchId)}/preview-regeneration`, { method: 'POST', body: JSON.stringify({ canonical }) });
          // A read may finish after the user has left this chat or screen.
          if (!organizationView.open || encodeURIComponent(state.current?.chatId ?? '') !== chat
            || organizationView.selection.length !== 1 || organizationView.selection[0] !== batchId) return;
          organizationView.busy = false;
          render();
          const review = await chooseExtractionReviewOverride(
            canonical ? "여기부터 기억 후보를 다시 만들까요?" : "이 구간의 기억 후보를 다시 만들까요?",
            `${canonical ? "선택 지점부터 최신 적격 원문까지 기억과 상태를 다시 계산합니다." : "선택한 원문 묶음의 기억·세부·대사만 다시 만들고 상태 장부는 유지합니다."} 결과는 자동으로 적용되지 않습니다.\n묶음 ${estimate.batchCount}개 · 메시지 ${estimate.messageCount}개 · 원문 약 ${estimate.rawTokens.toLocaleString()}토큰\n전체 예상 입력 약 ${estimate.estimatedInputTokens.toLocaleString()}토큰, 기본 추출 약 ${estimate.estimatedExtractionCalls}회입니다. 재검수·상태 대조·긴 입력 분할에 따라 호출이 추가될 수 있으며 실제 청구량과 다릅니다.`,
            state.settings.postExtractionReview,
          );
          if (review === undefined) return;
          const started = await client.request<{ runId: string }>(`/v1/chats/${chat}/extraction-batches/${encodeURIComponent(batchId)}/${action}`, { method: "POST", body: JSON.stringify({ postExtractionReview: review }) }, 120_000);
          organizationView.candidateId = `regeneration:${started.runId}`;
          organizationView.mobileDetail = true;
          void drainWorker(state, client);
          await refresh({ forceApply: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          organizationView.error = `기억 후보 생성을 준비하지 못했습니다. ${message}`;
          addLog(state.logs, "error", `Regeneration preparation failed: ${message}`);
        } finally {
          organizationView.busy = false;
          if (dashboardOpen) render();
        }
        return;
      } else if (action === "toggle-pin" || action === "toggle-memory") {
        const memory = data.memories.find((item) => item.id === target.dataset.id);
        if (!memory) return;
        const body = action === "toggle-pin" ? { pinned: !memory.pinned } : { active: !memory.active };
        await client.request(`/v1/chats/${chat}/memories/${encodeURIComponent(memory.id)}`, { method: "PATCH", body: JSON.stringify(body) });
      } else if (action === "delete-memory") {
        const id = target.dataset.id ?? "";
        if (!await confirmDashboard("이 파생 기억과 연결된 trace/edge를 영구 삭제할까요? Risu 원문은 삭제되지 않습니다.")) return;
        await client.request(`/v1/chats/${chat}/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
        await invalidateTranslationCache(state, { chatId: state.current.chatId, itemIdPrefix: `${id}:` });
        selectedMemory = "";
      } else if (action === "resolve-conflict") {
        await client.request(`/v1/chats/${chat}/conflicts/${encodeURIComponent(target.dataset.id ?? "")}`, { method: "PATCH", body: JSON.stringify({ resolution: target.dataset.resolution }) });
      } else if (action === "delete-conflict") {
        if (!await confirmDashboard("확인 완료한 충돌 기록을 삭제할까요?")) return;
        await client.request(`/v1/chats/${chat}/conflicts/${encodeURIComponent(target.dataset.id ?? "")}`, { method: "DELETE" });
      } else if (action === "preview-entity-merge") {
        const form = root.querySelector<HTMLFormElement>("#entity-merge-form");
        if (!form) return;
        const values = new FormData(form);
        const sourceId = String(values.get("sourceId") ?? "");
        const targetId = String(values.get("targetId") ?? "");
        if (!sourceId || !targetId || sourceId === targetId) throw new Error("서로 다른 두 인물을 선택하세요.");
        entityMergePreview = await client.request(`/v1/chats/${chat}/entities/merge-preview`, { method: "POST", body: JSON.stringify({ sourceId, targetId }) });
        render();
        return;
      } else if (action === "cancel-entity-merge") {
        entityMergePreview = undefined;
        render();
        return;
      } else if (action === "merge-entities-final") {
        await client.request(`/v1/chats/${chat}/entities/merge`, { method: "POST", body: JSON.stringify({ sourceId: target.dataset.sourceId, targetId: target.dataset.targetId, revision: Number(target.dataset.revision) }) });
        entityMergePreview = undefined;
        peopleView.management = "";
        peopleView.mobileDetail = false;
        selectedRelationship = "";
        relationshipPerson = "";
        relationshipMobileDetail = false;
      } else if (action === "new-social" || action === "edit-social") {
        socialEditor = {
          holder: action === "edit-social" ? target.dataset.holder ?? "" : "",
          subject: action === "edit-social" ? target.dataset.subject ?? "" : "",
          level: action === "edit-social" ? target.dataset.level ?? "aware_of" : "aware_of",
          knownAs: action === "edit-social" ? target.dataset.knownAs ?? "" : "",
          editing: action === "edit-social",
        };
        render();
        root.querySelector<HTMLInputElement>('#social-form input[name="holder"]')?.focus();
        return;
      } else if (action === "cancel-social") {
        socialEditor = undefined;
        formDirty = false;
        render();
        return;
      } else if (action === "delete-social") {
        await client.request(`/v1/chats/${chat}/social-knowledge`, { method: "DELETE", body: JSON.stringify({ holder: target.dataset.holder, subject: target.dataset.subject }) });
      } else if (action === "backfill-social") {
        requireChatMemoryEnabled(state, state.current.chatId);
        const result = await client.request<{ queuedJobs: number }>(`/v1/chats/${chat}/social-knowledge/backfill`, { method: "POST" });
        addLog(state.logs, "info", result.queuedJobs ? `지인 관계 백필 ${result.queuedJobs}개 묶음을 대기열에 추가했습니다.` : "이미 지인 관계 백필이 진행 중이거나 처리할 원문이 없습니다.");
      } else if (action === "drain-worker") {
        await drainWorker(state, client);
      } else if (action === "pause-worker") {
        state.settings.workerPaused = true;
        if (state.settings.extractionEngine === "server") state.serverWorker = await client.pauseServerWorker();
        await saveSettings(state.settings);
        addLog(state.logs, "info", state.settings.extractionEngine === "server"
          ? "Server queue paused; active HTTP requests were aborted"
          : state.workerBusy ? "Queue pause requested; the current model call may finish" : "Queue paused");
      } else if (action === "resume-worker") {
        state.settings.workerPaused = false;
        delete state.settings.workerAttention;
        await saveSettings(state.settings);
        await updateWorkerMenuButton(state);
        if (state.settings.extractionEngine === "server") state.serverWorker = await client.resumeServerWorker(state.workerId);
        addLog(state.logs, "info", "Queue resumed by user");
        void drainWorker(state, client);
      } else if (action === "retry-failed") {
        requireChatMemoryEnabled(state, state.current.chatId);
        if (!await confirmDashboard("실패한 기억 처리 작업의 시도 횟수를 초기화해 다시 대기 상태로 둘까요? 서버 worker가 실행 중이면 곧바로 다시 처리합니다.")) return;
        const result = await client.request<{ retried: number }>(`/v1/chats/${chat}/jobs/retry-failed`, { method: "POST" });
        addLog(state.logs, "info", `${result.retried} failed extraction job(s) returned to queued state`);
      } else if (action === "acknowledge-backfill") {
        const runId = target.dataset.runId ?? "";
        if (!runId) return;
        const previousAcknowledged = data.coldStartProgress?.acknowledged;
        const closedLocally = acknowledgeBackfillLocally(data, runId);
        if (closedLocally) render();
        try {
          await client.request(`/v1/chats/${chat}/backfill-runs/${encodeURIComponent(runId)}/acknowledge`, { method: "POST" });
        } catch (error) {
          if (closedLocally && data.coldStartProgress?.backfillRunId === runId) {
            data.coldStartProgress.acknowledged = previousAcknowledged;
            render();
          }
          throw error;
        }
        addLog(state.logs, "info", "Backfill result acknowledged");
      } else if (action === "delete-queue") {
        if (!await confirmDashboard(`${state.settings.workerPaused ? "" : "안전한 삭제를 위해 worker를 먼저 일시정지합니다.\n\n"}현재 채팅의 queued/failed/만료된 작업을 삭제할까요? 원문은 보존되며 자동 재생성을 막기 위해 취소 상태로 표시됩니다.`)) return;
        await pauseWorkerForQueueMutation(state, client);
        const result = await client.request<{ deletedJobs: number; cancelledMessages: number }>(`/v1/chats/${chat}/jobs`, { method: "DELETE" });
        addLog(state.logs, "info", `${result.deletedJobs} extraction job(s) deleted; ${result.cancelledMessages} source message(s) cancelled`);
        showActionSaveState({ kind: "success", message: `대기열 ${result.deletedJobs}건 삭제됨 · worker 일시정지` });
      } else if (action === "clear-completed-jobs") {
        if (!await confirmDashboard("완료·취소·교체된 작업 기록을 대기열 목록에서 정리할까요? 기억과 검토 기록은 그대로 보존됩니다.")) return;
        const result = await client.request<{ archivedJobs: number }>(`/v1/chats/${chat}/jobs/completed`, { method: "DELETE" });
        addLog(state.logs, "info", `${result.archivedJobs} completed job record(s) archived`);
        showActionSaveState({ kind: "success", message: `완료 기록 ${result.archivedJobs}건 정리됨` });
      } else if (action === "restore-cancelled") {
        requireChatMemoryEnabled(state, state.current.chatId);
        if (!await confirmDashboard(`${state.settings.workerPaused ? "" : "안전한 복구를 위해 worker를 먼저 일시정지합니다.\n\n"}취소된 원문을 pending 상태로 되돌릴까요? 다음 동기화에서 작업이 다시 생성될 수 있지만, worker는 일시정지를 유지합니다.`)) return;
        await pauseWorkerForQueueMutation(state, client);
        const result = await client.request<{ restoredMessages: number }>(`/v1/chats/${chat}/jobs/requeue-cancelled`, { method: "POST" });
        addLog(state.logs, "info", `${result.restoredMessages} cancelled source message(s) restored to pending`);
        showActionSaveState({ kind: "success", message: `취소 원문 ${result.restoredMessages}개 복구됨 · worker 일시정지` });
      }
      await refresh({ forceApply: true });
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, "");
      addLog(state.logs, "error", `Dashboard action failed: ${message}`);
      showActionSaveState({ kind: "error", message: "작업 실패 · 관리 → 처리 상태에서 확인" });
    }
  });

  root.addEventListener("keydown", async (event) => {
    if (event.key !== "Escape") return;
    if (organizationView.open && organizationView.candidateId) {
      event.preventDefault();
      if (await discardReadyOrganizationCandidate()) {
        organizationView.candidateId = "";
        organizationView.mobileDetail = Boolean(organizationView.focusedId);
        render(false);
      }
      return;
    }
    let closed = false;
    root.querySelectorAll<HTMLDetailsElement>(".memory-actions-menu[open], .record-menu[open]").forEach((menu) => {
      menu.open = false;
      closed = true;
    });
    if (closed) event.preventDefault();
  });

  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const values = Object.fromEntries(new FormData(form));
    const mutationForm = ["memory-form", "manual-memory-form", "story-overview-form", "relationship-form", "social-form", "world-state-form", "intimacy-form"].includes(form.id);
    const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"], button[data-action="submit-form"]');
    if (mutationForm) { form.setAttribute("aria-busy", "true"); if (submitButton) submitButton.disabled = true; }
    let successMessage = "";
    try {
      if (form.id === "settings-form") {
        settingsSaving = true;
        updateTopbar();
        await persistSettingsForm(form);
        addLog(state.logs, "info", "Settings persistence verified");
        await refresh();
        settingsSaving = false;
        showActionSaveState({ kind: "success", message: "저장됨" });
        return;
      } else if (form.id === "voyage-form") {
        await saveVoyageKey(form);
        return;
      } else if (!state.current) {
        throw new Error("현재 채팅 정보를 아직 불러오는 중입니다.");
      } else if (form.id === "story-overview-form") {
        const overview = data.storySpine?.overview;
        const groupId = form.dataset.groupId ?? overview?.groupId ?? "";
        const summary = String(values.summary ?? "").trim();
        if (!groupId || !overview) throw new Error("수정할 전체 요약을 찾지 못했습니다.");
        if (!summary) throw new Error("지금까지의 이야기를 입력해 주세요.");
        const chatId = state.current.chatId;
        const chat = encodeURIComponent(chatId);
        const result = await client.request<{ ok: boolean }>(`/v1/chats/${chat}/story-spine/${encodeURIComponent(groupId)}`, { method: "PATCH", body: JSON.stringify({ summary }) });
        if (!result.ok) throw new Error("줄거리 요약을 저장하지 못했습니다.");
        state.settings.storyOverviewBackups = { ...state.settings.storyOverviewBackups, [chatId]: {
          summary, groupId, startOrdinal: Number(overview.startOrdinal ?? 0), endOrdinal: Number(overview.endOrdinal ?? 0), savedAt: Date.now(),
        } };
        try { await saveSettings(state.settings); }
        catch (error) { addLog(state.logs, "warn", `Story overview saved, but its rebuild draft backup failed: ${String(error)}`); }
        await invalidateTranslationCache(state, { serverInstanceId: data.health?.instanceId, chatId, itemId: storyTranslationKey(storyGroupKey(overview, "overview"), "summary") });
        translations.delete(storyTranslationKey(storyGroupKey(overview, "overview"), "summary"));
        storyView.editingOverview = false;
        storyView.overviewDraft = undefined;
        formDirty = false;
        successMessage = "지금까지의 이야기 저장됨";
      } else if (form.id === "manual-memory-form") {
        const chat = encodeURIComponent(state.current.chatId);
        const participants = String(values.participants ?? "").split(",").map((value) => value.trim()).filter(Boolean);
        const landmarkKind = String(values.landmarkKind ?? "");
        if (landmarkKind && participants.length !== 2) throw new Error("관계 이정표에는 관련 인물 두 명을 입력해 주세요.");
        const storyTime = String(values.storyTime ?? "").trim();
        const landmarkKinds = landmarkKind ? [{ kind: landmarkKind, pair: [participants[0], participants[1]], ...(storyTime ? { storyTime } : {}) }] : [];
        const result = await client.request<{ ok: boolean; id: string }>(`/v1/chats/${chat}/memories`, { method: "POST", body: JSON.stringify({
          title: String(values.title ?? "").trim(), content: String(values.content ?? "").trim(), storyTime, participants, landmarkKinds,
        }) });
        if (!result.ok || !result.id) throw new Error("수동 기억을 저장하지 못했습니다.");
        selectedMemory = result.id;
        timelineView.creating = false;
        timelineView.mobileDetail = true;
        formDirty = false;
        successMessage = "타임라인 기억 추가됨";
      } else if (form.id === "memory-form") {
        const chat = encodeURIComponent(state.current.chatId);
        const memoryId = form.dataset.memoryId ?? "";
        const locations = String(values.locations ?? "").split(",").map((value) => value.trim()).filter(Boolean);
        const memory = data.memories.find((item) => item.id === memoryId);
        const existingLandmarks = Array.isArray(memory?.landmarkKinds) ? memory.landmarkKinds : [];
        const landmarkKinds = String(values.landmarkKinds ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => value.startsWith("other:")
          ? { kind: "other", label: value.slice(6).trim() }
          : existingLandmarks.find((item: any) => item.kind === value) ?? { kind: value });
        const initial = new Map<string, unknown>(JSON.parse(form.dataset.initialSignature ?? "[]") as Array<[string, unknown]>);
        const changed = (name: string, value: unknown): boolean => !initial.has(name) || initial.get(name) !== value;
        const landmark = (form.elements.namedItem("landmark") as HTMLInputElement | null)?.checked === true;
        const patch: Record<string, unknown> = {};
        if (changed("title", String(values.title ?? ""))) patch.title = values.title;
        if (changed("content", String(values.content ?? ""))) patch.content = values.content;
        if (changed("storyTime", String(values.storyTime ?? ""))) patch.storyTime = String(values.storyTime ?? "").trim() || null;
        if (changed("locations", String(values.locations ?? ""))) patch.locations = locations;
        if (changed("landmarkKinds", String(values.landmarkKinds ?? ""))) patch.landmarkKinds = landmarkKinds;
        if (changed("landmark", landmark)) patch.landmark = landmark;
        if (changed("salience", String(values.salience ?? ""))) patch.salience = Number(values.salience);
        if (changed("strength", String(values.strength ?? ""))) patch.strength = Number(values.strength);
        if (Object.keys(patch).length === 0) {
          formDirty = false;
          successMessage = "변경 사항 없음";
        } else {
          const result = await client.request<{ ok: boolean }>(`/v1/chats/${chat}/memories/${encodeURIComponent(memoryId)}`, { method: "PATCH", body: JSON.stringify(patch) });
          if (!result.ok) throw new Error("기억을 찾지 못해 저장하지 못했습니다. 새로고침 후 다시 시도하세요.");
        }
        if ("title" in patch) {
          await invalidateTranslationCache(state, { serverInstanceId: data.health?.instanceId, chatId: state.current.chatId, itemId: `${memoryId}:title` });
          translations.delete(`${memoryId}:title`);
        }
        if ("content" in patch) {
          await invalidateTranslationCache(state, { serverInstanceId: data.health?.instanceId, chatId: state.current.chatId, itemId: `${memoryId}:content` });
          translations.delete(`${memoryId}:content`);
        }
        formDirty = false;
        timelineView.editing = false;
        pendingData = undefined; newDataAvailable = false;
        successMessage = "기억 저장됨";
      } else if (form.id === "relationship-form") {
        const chat = encodeURIComponent(state.current.chatId);
        const from = String(values.from ?? ""), to = String(values.to ?? "");
        const current = data.relationships.find((item) => relationshipFrom(item) === from && relationshipTo(item) === to);
        let changes = 0;
        const nextSummary = String(values.summary ?? "").trim();
        const initialBaselineId = form.dataset.initialBaselineId;
        if (initialBaselineId && data.initialCalibration?.status === "awaiting_confirmation") {
          const axes = Object.fromEntries(Object.keys(relationshipLevels).map((axis) => [axis, String(values[`${axis}Level`] ?? "unknown")]));
          const result = await client.request<{ ok: boolean }>(`/v1/chats/${chat}/initial-calibration/relationships/${encodeURIComponent(initialBaselineId)}`, {
            method: "PATCH", body: JSON.stringify({ axes, summary: nextSummary }),
          });
          if (!result.ok) throw new Error("초기 관계를 저장하지 못했습니다.");
          changes = 1;
        } else {
          const endpoint = `/v1/chats/${chat}/relationships`;
          const nextTensions = String(values.activeTensions ?? "").split(",").map((value) => value.trim()).filter(Boolean);
          if (nextSummary !== String(current?.summary ?? "") || JSON.stringify(nextTensions) !== JSON.stringify(current?.activeTensions ?? [])) {
            const result = await client.request<{ ok: boolean }>(endpoint, { method: "PATCH", body: JSON.stringify({ from, to, summary: nextSummary || null, activeTensions: nextTensions }) });
            if (!result.ok) throw new Error("관계 요약을 저장하지 못했습니다.");
            changes += 1;
          }
          for (const axis of Object.keys(relationshipLevels)) {
            const level = String(values[`${axis}Level`] ?? "unknown");
            const trend = String(values[`${axis}Trend`] ?? "unclear");
            const prior = relationshipAxis(current, axis);
            if (level === prior.level && trend === prior.trend) continue;
            const result = await client.request<{ ok: boolean }>(endpoint, { method: "PATCH", body: JSON.stringify({ from, to, axis, level, trend }) });
            if (!result.ok) throw new Error(`${relationshipAxisLabels[axis as keyof typeof relationshipAxisLabels] ?? axis} 상태를 저장하지 못했습니다.`);
            changes += 1;
          }
        }
        formDirty = false;
        successMessage = changes ? (initialBaselineId ? "초기 관계 저장됨" : "관계 상태 저장됨") : "변경 사항 없음";
        relationshipEditing = false;
        intimacyEditor = undefined;
      } else if (form.id === "social-form") {
        const chat = encodeURIComponent(state.current.chatId);
        const result = await client.request<{ items: any[] }>(`/v1/chats/${chat}/social-knowledge`, { method: "PUT", body: JSON.stringify({
          holder: String(values.holder ?? "").trim(), subject: String(values.subject ?? "").trim(), level: values.level,
          knownAs: String(values.knownAs ?? "").split(",").map((value) => value.trim()).filter(Boolean),
          previousHolder: form.dataset.originalHolder || undefined,
          previousSubject: form.dataset.originalSubject || undefined,
        }) });
        if (!Array.isArray(result.items)) throw new Error("지인 관계 저장 결과를 확인하지 못했습니다.");
        data.socialKnowledge = result.items;
        socialEditor = undefined;
        successMessage = "지인 관계 저장됨";
      } else if (form.id === "intimacy-form") {
        const chat = encodeURIComponent(state.current.chatId);
        const itemId = form.dataset.id ?? "";
        const body = {
          participantA: String(values.participantA ?? "").trim(), participantB: String(values.participantB ?? "").trim(),
          act: String(values.act ?? ""), customLabel: String(values.customLabel ?? "").trim() || undefined,
          initiator: String(values.initiator ?? "").trim() || undefined,
          interactionContext: String(values.interactionContext ?? "ambiguous"),
          circumstance: String(values.circumstance ?? "").trim() || undefined,
          sourceMessageId: String(values.sourceMessageId ?? "").trim() || undefined,
          autoInject: (form.elements.namedItem("autoInject") as HTMLInputElement | null)?.checked !== false,
        };
        await client.request(`/v1/chats/${chat}/physical-intimacy${itemId ? `/${encodeURIComponent(itemId)}` : ""}`, { method: itemId ? "PATCH" : "POST", body: JSON.stringify(body) });
        formDirty = false;
        intimacyEditor = undefined;
        pendingData = undefined; newDataAvailable = false;
        successMessage = itemId ? "스킨십 기록 수정됨" : "스킨십 기록 추가됨";
      } else if (form.id === "world-state-form") {
        const chat = encodeURIComponent(state.current.chatId);
        const kind = form.dataset.kind as WorldEditor["kind"];
        const itemId = form.dataset.id ?? "";
        const creating = form.dataset.mode === "create";
        const body: Record<string, unknown> = { kind, ...(creating ? {} : { id: itemId }) };
        for (const key of ["subject", "predicate", "holder", "promisor", "promisee", "value", "content", "polarity", "status", "scope", "scheduledFor", "statusReason", "sourceMessageId"]) {
          if (values[key] !== undefined) body[key] = String(values[key]).trim();
        }
        if (values.confidence !== undefined) body.confidence = Number(values.confidence);
        const result = await client.request<{ ok: boolean; item?: any }>(`/v1/chats/${chat}/world-state`, { method: creating ? "POST" : "PATCH", body: JSON.stringify(body) });
        if (!result.ok) throw new Error("세계·관점 정보를 저장하지 못했습니다.");
        if (!creating && !result.item) throw new Error("저장 후 서버 값을 다시 확인하지 못했습니다.");
        if (!creating && kind === "assertion") data.assertions = data.assertions.map((item) => item.id === itemId ? result.item : item);
        if (!creating && kind === "belief") data.beliefs = data.beliefs.map((item) => item.id === itemId ? result.item : item);
        if (!creating && kind === "promise") data.promises = data.promises.map((item) => item.id === itemId ? result.item : item);
        const savedId = String(result.item?.id ?? itemId ?? "");
        if (savedId) worldView.selectedId = `current:${savedId}`;
        await invalidateTranslationCache(state, { serverInstanceId: data.health?.instanceId, chatId: state.current.chatId, itemIdPrefix: `${kind}:${itemId}` });
        translations.delete(`${kind}:${itemId}`);
        formDirty = false;
        worldEditor = undefined;
        worldView.mobileDetail = Boolean(worldView.selectedId);
        pendingData = undefined; newDataAvailable = false;
        successMessage = creating ? "세계·관점 정보 추가됨" : "세계·관점 정보 저장됨";
      }
      await refresh({ forceApply: mutationForm });
      if (successMessage) showActionSaveState({ kind: "success", message: successMessage });
    } catch (error) {
      const duplicateId = String(error).match(/existingId=([^\s]+)/)?.[1];
      if (duplicateId && form.id === "intimacy-form") {
        intimacyEditor = { id: duplicateId };
        showActionSaveState({ kind: "error", message: "같은 기록이 있어 기존 항목 수정 화면을 열었습니다." });
        render();
        return;
      }
      if (duplicateId && form.id === "world-state-form") {
        worldEditor = { kind: form.dataset.kind as WorldEditor["kind"], id: duplicateId, mode: "edit" };
        showActionSaveState({ kind: "error", message: "같은 활성 항목이 있어 기존 항목 수정 화면을 열었습니다." });
        render();
        return;
      }
      if (form.id === "settings-form") {
        settingsSaving = false;
        addLog(state.logs, "error", `Settings save failed: ${String(error)}`);
        const attempted = new FormData(form);
        showActionSaveState({ kind: "error", message: settingsSaveFailureMessage(error, {
          serverUrl: String(attempted.get("serverUrl") ?? state.settings.serverUrl).trim(),
          serverToken: String(attempted.get("serverToken") ?? state.settings.serverToken).trim(),
        }) });
      } else {
        data.error = String(error);
        if (mutationForm) showActionSaveState({ kind: "error", message: `저장 실패 · ${String(error)}` });
      }
      if (form.id !== "settings-form") render();
    } finally {
      if (form.id === "settings-form") {
        settingsSaving = false;
        updateTopbar();
      }
      if (mutationForm && form.isConnected) {
        form.removeAttribute("aria-busy");
        if (submitButton) submitButton.disabled = false;
      }
    }
  });

  root.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.closest("#memory-form") || input.closest("#manual-memory-form") || input.closest("#story-overview-form") || input.closest("#intimacy-form") || input.closest("#social-form") || input.closest("#world-state-form") || input.closest("#relationship-form") || input.closest(".person-editor") || input.closest(".initial-relationship-editor")) syncEditorDirtyState();
    if (input.dataset.action === "people-search") {
      peopleView.query = input.value;
      applyPeopleSearch();
      return;
    }
    if (input.dataset.action === "relationship-search") {
      relationshipQuery = input.value;
      applyRelationshipSearch();
      return;
    }
    if (input.dataset.action === "data-search") {
      dataView.query = input.value;
      const query = input.value.trim().toLocaleLowerCase();
      root.querySelectorAll<HTMLElement>("[data-data-row]").forEach((row) => { row.hidden = Boolean(query) && !row.textContent?.toLocaleLowerCase().includes(query); });
      return;
    }
    if (input.dataset.action === "attention-search") {
      attentionView.query = input.value;
      applyAttentionSearch();
      return;
    }
    if (input.dataset.action === "inheritance-search") {
      dataView.inheritanceQuery = input.value;
      render();
      root.querySelector<HTMLInputElement>('[data-action="inheritance-search"]')?.focus();
      return;
    }
    if (input.dataset.action === "social-search") {
      const query = input.value.trim().toLocaleLowerCase();
      let visible = 0;
      root.querySelectorAll<HTMLElement>("[data-social-group]").forEach((group) => {
        let groupVisible = 0;
        group.querySelectorAll<HTMLElement>("[data-social-row]").forEach((row) => {
          const match = !query || Boolean(row.textContent?.toLocaleLowerCase().includes(query));
          row.hidden = !match;
          if (match) groupVisible += 1;
        });
        group.hidden = groupVisible === 0;
        if (query && groupVisible) (group as HTMLDetailsElement).open = true;
        visible += groupVisible;
      });
      const count = root.querySelector<HTMLElement>("[data-social-count]");
      if (count) count.textContent = `${visible}개`;
      const empty = root.querySelector<HTMLElement>("[data-social-search-empty]");
      if (empty) empty.hidden = visible > 0;
      return;
    }
    if (input.dataset.action === "world-search") {
      worldView.query = input.value;
      applyWorldSearch();
      return;
    }
    if (input.dataset.action === "story-search") {
      storyView.query = input.value;
      applyStorySearch();
      return;
    }
    if (input.id !== "memory-search") return;
    timelineView.query = input.value;
    applyTimelineSearch();
  });

  root.addEventListener("change", async (event) => {
    const input = event.target as HTMLInputElement;
    if (input.closest("#memory-form") || input.closest("#manual-memory-form") || input.closest("#story-overview-form") || input.closest("#intimacy-form") || input.closest("#social-form") || input.closest("#world-state-form") || input.closest("#relationship-form") || input.closest(".person-editor") || input.closest(".initial-relationship-editor")) syncEditorDirtyState();
    if (input.name === "customRuleEnabled") updateRegexRuleSummary();
    if (input.dataset.action === "select-relationship-person") {
      relationshipPerson = input.value;
      selectedRelationship = "";
      relationshipEditing = false;
      relationshipMobileDetail = false;
      input.blur();
      render();
      return;
    }
    if (input.dataset.action === "set-profile-select") {
      try {
        const changed = await changeChatProfile(input.value as RpProfile);
        if (!changed) input.value = state.current?.profile ?? state.settings.defaultProfile;
      } catch (error) {
        data.error = String(error);
        input.value = state.current?.profile ?? state.settings.defaultProfile;
      }
      render(false);
      return;
    }
    if (input.name === "dashboardTheme") {
      document.documentElement.dataset.rcmTheme = input.value === "light" ? "light" : "dark";
      return;
    }
    if (input.dataset.action === "world-holder") {
      worldView.holder = input.value;
      worldView.selectedId = "";
      worldView.mobileDetail = false;
      render();
      return;
    }
    if (input.dataset.action === "data-filter") { dataView.filter = input.value as DataViewState["filter"]; render(); return; }
    if (input.dataset.action === "select-inheritance-source") {
      dataView.inheritanceSourceId = input.value || undefined;
      dataView.inheritancePreview = undefined;
      dataView.inheritanceReplacementAcknowledged = false;
      dataView.inheritanceError = undefined;
      render(); return;
    }
    if (input.dataset.action === "select-probe-source" && state.lineageProbe) {
      state.lineageProbe.selectedParentId = input.value || undefined;
      render(); return;
    }
    if (input.dataset.action === "ack-lineage-replacement") {
      dataView.inheritanceReplacementAcknowledged = input.checked;
      const apply = root.querySelector<HTMLButtonElement>('[data-action="apply-lineage-transfer"]');
      if (apply) apply.disabled = !input.checked;
      return;
    }
    const confirmation = dataView.confirmation;
    if (input.dataset.action === "ack-delete" && confirmation && confirmation.chatId === input.dataset.chatId) {
      confirmation.acknowledged = input.checked;
      const confirm = root.querySelector<HTMLButtonElement>('[data-action="confirm-data-operation"][data-operation="delete"]');
      if (confirm) confirm.disabled = !input.checked;
      return;
    }
    if (input.name === "extractionEngine") {
      root.querySelectorAll<HTMLElement>("[data-engine-fields]").forEach((element) => { element.hidden = element.dataset.engineFields !== input.value; });
      const auxiliary = root.querySelector<HTMLSelectElement>('select[name="auxiliaryMode"]');
      const staticModel = root.querySelector<HTMLElement>("[data-static-model]");
      if (staticModel) staticModel.hidden = input.value !== "risu" || auxiliary?.value !== "static";
      return;
    }
    if (input.name === "auxiliaryMode") {
      const staticModel = root.querySelector<HTMLElement>("[data-static-model]");
      const engine = root.querySelector<HTMLSelectElement>('select[name="extractionEngine"]')?.value;
      if (staticModel) staticModel.hidden = engine !== "risu" || input.value !== "static";
      return;
    }
    if (input.name === "serverLlmProvider") {
      const configured = new Set((input.dataset.configuredProviders ?? "").split(",").filter(Boolean));
      const configuredHere = configured.has(input.value);
      const keyStatus = root.querySelector<HTMLElement>("[data-provider-key-status]");
      const keyInput = root.querySelector<HTMLInputElement>('input[name="serverLlmApiKey"]');
      const remove = root.querySelector<HTMLElement>('[data-action="remove-server-llm-key"]');
      if (keyStatus) keyStatus.textContent = configuredHere ? "인증정보 저장됨" : "인증정보 없음";
      if (keyInput) keyInput.placeholder = configuredHere ? "저장된 인증정보 유지 (변경할 때만 입력)" : "서버에 저장할 인증정보";
      if (remove) remove.hidden = !configuredHere;
      const endpoint = root.querySelector<HTMLInputElement>('input[name="serverLlmEndpoint"]');
      const model = root.querySelector<HTMLInputElement>('input[name="serverLlmModel"]');
      const serviceTier = root.querySelector<HTMLSelectElement>('select[name="serverLlmServiceTier"]');
      if (serviceTier) {
        serviceTier.disabled = input.value === "gemini_api" || input.value === "ollama_cloud";
        if (serviceTier.disabled) serviceTier.value = "standard";
      }
      if (input.value === "vertex") {
        if (endpoint) endpoint.value = "https://aiplatform.googleapis.com/v1";
        if (model && (!model.value || model.value === "auto")) model.value = "gemini-2.5-flash";
      } else if (input.value === "gemini_api") {
        if (endpoint) endpoint.value = "https://generativelanguage.googleapis.com/v1beta";
        if (model && (!model.value || model.value === "auto")) model.value = "gemini-2.5-flash";
      } else if (input.value === "ollama_cloud") {
        if (endpoint) endpoint.value = "https://ollama.com/api/chat";
        if (model && (!model.value || model.value === "auto")) model.value = "gpt-oss:120b";
      } else {
        if (endpoint) endpoint.value = "https://api.llmgateway.io/v1/chat/completions";
        if (model && !model.value) model.value = "auto";
      }
      return;
    }
    if (input.id !== "backup-file" || !input.files?.[0]) return;
    try {
      const bytes = await input.files[0].arrayBuffer();
      input.value = "";
      const response = await client.raw("/v1/import/inspect", { method: "POST", headers: { "Content-Type": "application/zip" }, body: backupRequestBody(bytes) }, 60_000);
      const inspection = await response.json() as any;
      const scope = inspection?.manifest?.scope;
      if (scope === "complete") {
        if (await confirmDashboard("현재 RCM 서버의 모든 기억과 설정을 이 백업으로 교체할까요? 현재 설치의 서버 주소와 토큰은 유지됩니다.")) await restoreCompleteBackup(bytes);
        return;
      }
      if (scope !== "chat") throw new Error("지원하지 않는 백업 종류입니다.");
      const sourceChatId = inspection?.manifest?.chats?.[0]?.id;
      if (!sourceChatId) throw new Error("백업에서 원래 채팅 ID를 찾지 못했습니다.");
      const canTransplant = Boolean(state.current?.chatId && state.current.chatId !== sourceChatId);
      const choice = await chooseChatBackupImport(canTransplant);
      if (choice === "original") await restoreChatBackup(bytes);
      else if (choice === "current") await transplantChatBackup(bytes, sourceChatId);
    } catch (error) { data.error = String(error); render(); }
  });

  root.addEventListener("focusout", () => {
    queueMicrotask(() => {
      if (!deferredPageRender || formDirty || hasActiveSelection()) return;
      const page = root.querySelector<HTMLElement>(".page");
      const active = document.activeElement as HTMLElement | null;
      if (page && active && page.contains(active) && active.matches("input, select, textarea")) return;
      render();
    });
  });

  document.addEventListener("selectionchange", () => {
    if (hasActiveSelection() || formDirty) return;
    if (pendingData) {
      data = pendingData;
      pendingData = undefined;
      newDataAvailable = false;
      render();
      return;
    }
    if (pendingTranslationPatches.size) {
      const ids = [...pendingTranslationPatches];
      pendingTranslationPatches.clear();
      for (const id of ids) {
        const memory = data.memories.find((item) => item.id === id);
        if (memory) patchTranslatedMemory(memory);
      }
    }
  });

  render();
  await state.setStatusWidgetHidden?.(true);
  try { await risuai.showContainer("fullscreen"); }
  catch (error) {
    await state.setStatusWidgetHidden?.(false);
    throw error;
  }
  // PocketRisu reparents a previously display:none sandbox iframe when showing
  // it. Let Chromium schedule a visible frame before replacing the shell with
  // network-backed content, otherwise the completed render can remain visually
  // stale until the next pointer event even though the DOM is already current.
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  const themeReady = applyHostTheme(state.settings.dashboardTheme);
  if (isServerConfigured(state.settings)) cacheStats = await translationCacheStats(state).catch(() => cacheStats);
  await refresh();
  if (isServerConfigured(state.settings) && !state.updateDashboardChecked) {
    state.updateDashboardChecked = true;
    await refreshUpdateStatus(state, client, { remote: true, force: true });
    render();
  }
  await themeReady;
  await showCompletedProductReleaseNotice(state);
  lastServerActivitySignature = serverActivitySignature();
  lastLiveDataSignature = dashboardLiveDataSignature(state.statusSummary);
  const refreshFromActivity = async () => {
    if (refreshing) { activityRefreshPending = true; return; }
    do {
      activityRefreshPending = false;
      await refresh();
    } while (dashboardOpen && activityRefreshPending);
  };
  unsubscribeActivity = subscribeActivity(state, () => {
    if (!dashboardOpen) return;
    const summary = state.statusSummary;
    const busy = !!state.currentJob || (state.serverWorker?.activeCalls ?? 0) > 0 || (summary?.queuedJobs ?? 0) > 0 || (summary?.pendingEmbeddings ?? 0) > 0 || ["queued", "processing"].includes(state.episodeActivity?.status ?? "");
    const nextServerSignature = serverActivitySignature();
    const serverActivityChanged = nextServerSignature !== lastServerActivitySignature;
    const nextLiveDataSignature = dashboardLiveDataSignature(summary);
    const liveDataChanged = nextLiveDataSignature !== lastLiveDataSignature;
    lastServerActivitySignature = nextServerSignature;
    lastLiveDataSignature = nextLiveDataSignature;
    updateTopbar();
    updateNavBadges();
    if (!serverActivityChanged && !liveDataChanged) return;
    if (liveDataChanged || (activityWasBusy && !busy)) void refreshFromActivity();
    activityWasBusy = busy;
  });
}
