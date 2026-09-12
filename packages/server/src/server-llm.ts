import { prepareAuxiliaryText, resolveModelSourceReferences, inspectSourceReferences, sourceRepairMessages, applySourceRepairs } from "@rcm/shared";
import { validateGroupingResult, validateSourceRecoveryPatch, type MemoryGroupingResult } from "@rcm/shared";
import { randomUUID, sign } from "node:crypto";
import { planExtractionFieldRepair, applyExtractionFieldRepair } from "@rcm/shared";
import { applySourceAccessRepair, type SourceAccessRepairPlan } from "@rcm/shared";
import {
  EpisodeCapsuleResultSchema,
  EpisodeDraftResultSchema,
  estimateTokens,
  groupEpisodeDrafts,
  normalizeEpisodeCapsuleInput,
  normalizeEpisodeDraftInput,
  normalizeStructuredModelOptionals,
  parseStructuredModelJson,
  Api38ExtractionDraftResultSchema,
  INTENSITY_RELATIONSHIP_BASELINE_VALUES,
  ITEM_ACCESS_BASIS_VALUES,
  KEY_DIALOGUE_KIND_VALUES,
  MEMORY_DETAIL_KIND_VALUES,
  PHYSICAL_INTIMACY_ACT_VALUES,
  SIGNED_RELATIONSHIP_BASELINE_VALUES,
  assertChangedStructuredRepair,
  structuredValidationDiagnostic,
  buildExtractionAuditMessages,
  extractionAuditDraftForJob,
  ExtractionAuditPatchSchema,
  normalizeExtractionDraftInput,
  InitialCalibrationResultSchema,
  mergeInitialCalibrationResults,
  LedgerConsistencyResultSchema,
  ReconciliationResultSchema,
  RelationshipProjectionResultSchema,
  StorySpineConsolidationResultSchema,
  measureAuxiliaryPrompt,
  storySpineRepairInstruction,
  validateStorySpineConsolidation,
  ServerLlmConfigSchema,
  type EpisodeCapsuleResult,
  type EpisodeDraftResult,
  type ExtractionDraftResult,
  type ExtractionAuditSubmission,
  type InitialCalibrationResult,
  type LeasedJob,
  type LedgerConsistencyResult,
  type ReconciliationResult,
  type RelationshipProjectionResult,
  type ServerLlmConfigInput,
  type ServerLlmProvider,
  type ServerLlmPublicConfig,
  type StorySpineConsolidationResult,
  type ThinkingLevel,
} from "@rcm/shared";
import type { RcmDatabase } from "./db.js";
import { saveSecret } from "./admin.js";
import { normalizeAndValidateSetupEvidence } from "./initial-calibration.js";
import { recordJobLlmCall, settleJobLlmCall, stageJobModelOutput } from "./jobs.js";
import { cachedAuxiliaryPage, storeValidatedAuxiliaryPage, type CachedAuxiliaryPurpose } from "./auxiliary-page-cache.js";

const CONFIG_KEY = "server_llm_config";
const providers: ServerLlmProvider[] = ["gemini_api", "vertex", "llm_gateway", "ollama_cloud"];
const secretName = (provider: ServerLlmProvider) => `RCM_LLM_API_KEY_${provider.toUpperCase()}` as const;
type StoredServerLlmConfig = Omit<ServerLlmPublicConfig, "keyConfigured" | "configuredProviders">;

const defaults: StoredServerLlmConfig = {
  engine: "risu",
  provider: "llm_gateway",
  endpoint: "https://api.llmgateway.io/v1/chat/completions",
  model: "auto",
  temperature: 0.2,
  thinking: "off",
  serviceTier: "standard",
  maxInputTokens: 80_000,
  maxOutputTokens: 24_000,
  embeddingTimeoutMs: 15_000,
  rerankTimeoutMs: 45_000,
  llmTimeoutMs: 300_000,
};

/** Gemini 3.7+ Flash replaced token budgets with LOW/MEDIUM/HIGH thinking
 * levels and rejects an explicit disabled/minimal level. Keep this narrow to
 * the documented Flash line instead of guessing capabilities for every model. */
function usesGeminiFlashThinkingLevel(model: string): boolean {
  const match = /^gemini-3\.(\d+)-flash(?:$|[-@])/i.exec(model.trim());
  return Boolean(match && Number(match[1]) >= 7);
}

function normalizeDirectGeminiThinking(provider: ServerLlmProvider, model: string, thinking: ThinkingLevel): ThinkingLevel {
  return (provider === "vertex" || provider === "gemini_api") && usesGeminiFlashThinkingLevel(model) && thinking === "off"
    ? "low"
    : thinking;
}

function validateEndpoint(provider: ServerLlmConfigInput["provider"], endpoint: string): string {
  const url = new URL(endpoint.trim());
  if (url.protocol !== "https:") throw new Error("Server LLM endpoint must use HTTPS");
  if (url.username || url.password) throw new Error("Credentials must not be embedded in the endpoint URL");
  if (provider === "gemini_api" && url.hostname !== "generativelanguage.googleapis.com") {
    throw new Error("Gemini API endpoint must use generativelanguage.googleapis.com");
  }
  if (provider === "vertex" && url.hostname !== "aiplatform.googleapis.com" && !url.hostname.endsWith("-aiplatform.googleapis.com")) {
    throw new Error("Vertex endpoint must use an aiplatform.googleapis.com host");
  }
  if (provider === "ollama_cloud" && (url.hostname !== "ollama.com" || url.pathname !== "/api/chat")) {
    throw new Error("Ollama Cloud endpoint must be https://ollama.com/api/chat");
  }
  return url.toString().replace(/\/$/, "");
}

function parseStoredConfig(db: RcmDatabase): StoredServerLlmConfig {
  const row = db.prepare("SELECT value FROM server_meta WHERE key=?").get(CONFIG_KEY) as { value: string } | undefined;
  if (!row) return { ...defaults };
  try {
    const parsed = ServerLlmConfigSchema.omit({ apiKey: true }).safeParse(JSON.parse(row.value));
    return parsed.success
      ? { ...parsed.data, thinking: normalizeDirectGeminiThinking(parsed.data.provider, parsed.data.model, parsed.data.thinking) }
      : { ...defaults };
  } catch {
    return { ...defaults };
  }
}

export class ServerLlmStore {
  #config: StoredServerLlmConfig;
  #apiKeys: Partial<Record<ServerLlmProvider, string>>;
  #vertexToken: { accessToken: string; expiresAt: number; projectId: string } | undefined;
  #jobConfigs = new Map<string, StoredServerLlmConfig>();
  #jobApiKeys = new Map<string, string>();
  #timingObserver?: (event: { id: string; jobId: string; purpose: ServerLlmPurpose; startedAt: number; elapsedMs?: number; outcome: "running" | "succeeded" | "failed" }) => void;

  constructor(
    private readonly db: RcmDatabase,
    private readonly secretsPath: string,
    apiKeys: Partial<Record<ServerLlmProvider, string>> = {},
    readonly requestTimeoutMs = 300_000,
  ) {
    this.#config = parseStoredConfig(db);
    const storedRow = db.prepare("SELECT value FROM server_meta WHERE key='server_llm_config'").get() as { value: string } | undefined;
    let hasStoredLlmTimeout = false;
    try { hasStoredLlmTimeout = Object.prototype.hasOwnProperty.call(JSON.parse(storedRow?.value ?? "{}"), "llmTimeoutMs"); } catch { /* malformed stored config is replaced by defaults */ }
    if (!hasStoredLlmTimeout && requestTimeoutMs !== 300_000) this.#config.llmTimeoutMs = requestTimeoutMs;
    this.#apiKeys = { ...apiKeys };
  }

  get config(): Readonly<StoredServerLlmConfig> { return this.#config; }
  snapshotJob(jobId: string): Readonly<StoredServerLlmConfig> {
    let snapshot = this.#jobConfigs.get(jobId);
    if (!snapshot) {
      const row = this.db.prepare("SELECT payload_json FROM jobs WHERE id=?").get(jobId) as { payload_json: string } | undefined;
      const payload = row ? JSON.parse(row.payload_json || "{}") as Record<string, unknown> : {};
      const stored = ServerLlmConfigSchema.omit({ apiKey: true }).safeParse(payload.serverLlmSnapshot);
      snapshot = stored.success ? stored.data : ServerLlmConfigSchema.omit({ apiKey: true }).parse(this.config);
      if (!stored.success && row) {
        payload.serverLlmSnapshot = snapshot;
        this.db.prepare("UPDATE jobs SET payload_json=?,updated_at=? WHERE id=?").run(JSON.stringify(payload), Date.now(), jobId);
      }
      this.#jobConfigs.set(jobId, snapshot);
      this.#jobApiKeys.set(jobId, this.apiKeyFor(snapshot.provider));
    }
    return snapshot;
  }
  get apiKey(): string { return this.#apiKeys[this.#config.provider] ?? ""; }
  apiKeyFor(provider: ServerLlmProvider): string { return provider === this.config.provider ? this.apiKey : this.#apiKeys[provider] ?? ""; }
  apiKeyForJob(jobId: string, provider: ServerLlmProvider): string {
    this.snapshotJob(jobId);
    return this.#jobApiKeys.get(jobId) ?? this.apiKeyFor(provider);
  }
  backupApiKeys(): Partial<Record<ServerLlmProvider,string>> { return {...this.#apiKeys}; }
  recordCall(jobId: string, purpose: ServerLlmPurpose): void { recordJobLlmCall(this.db, jobId, purpose); }
  setTimingObserver(observer: (event: { id: string; jobId: string; purpose: ServerLlmPurpose; startedAt: number; elapsedMs?: number; outcome: "running" | "succeeded" | "failed" }) => void): void { this.#timingObserver = observer; }
  recordTiming(event: { id: string; jobId: string; purpose: ServerLlmPurpose; startedAt: number; elapsedMs?: number; outcome: "running" | "succeeded" | "failed" }): void { this.#timingObserver?.(event); }
  canRepair(jobId: string): boolean {
    const row = this.db.prepare("SELECT payload_json FROM jobs WHERE id=?").get(jobId) as { payload_json: string } | undefined;
    return Number(JSON.parse(row?.payload_json ?? "{}").llmCallStats?.repairs ?? 0) < 1;
  }
  stageOutput(jobId: string, output: string, storyValidationReason?: string): void { stageJobModelOutput(this.db, jobId, output, undefined, storyValidationReason); }
  settleCall(jobId: string, purpose: ServerLlmPurpose, outcome: "succeeded" | "failed", details?: { error?: unknown; usage?: Record<string, unknown> }): void { settleJobLlmCall(this.db, jobId, purpose, outcome, details); }
  cachedPage(jobId: string, purpose: CachedAuxiliaryPurpose, systemPrompt: string, userPrompt: string): unknown | undefined {
    const row = this.db.prepare("SELECT payload_json FROM jobs WHERE id=?").get(jobId) as { payload_json: string } | undefined;
    return cachedAuxiliaryPage(JSON.parse(row?.payload_json ?? "{}"), purpose, systemPrompt, userPrompt);
  }
  cachePage(jobId: string, purpose: CachedAuxiliaryPurpose, systemPrompt: string, userPrompt: string, result: unknown): void {
    const row = this.db.prepare("SELECT 1 FROM jobs WHERE id=? AND status='leased' AND lease_owner IS NOT NULL").get(jobId);
    if (row) storeValidatedAuxiliaryPage(this.db, jobId, undefined, { purpose, systemPrompt, userPrompt, result });
  }
  planPages(jobId: string, purpose: CachedAuxiliaryPurpose, parts: Array<{ systemPrompt: string; userPrompt: string }>): void {
    const row = this.db.prepare("SELECT payload_json FROM jobs WHERE id=? AND status='leased' AND lease_owner IS NOT NULL").get(jobId) as { payload_json: string } | undefined;
    if (!row) throw new Error("Lease not found while planning auxiliary pages");
    const payload = JSON.parse(row.payload_json || "{}");
    payload.auxiliaryPromptParts = parts.map((part) => ({ purpose, ...part }));
    this.db.prepare("UPDATE jobs SET payload_json=?,updated_at=? WHERE id=?").run(JSON.stringify(payload), Date.now(), jobId);
  }
  get publicConfig(): ServerLlmPublicConfig {
    return { ...this.#config, keyConfigured: Boolean(this.apiKey), configuredProviders: providers.filter((provider) => Boolean(this.#apiKeys[provider])) };
  }

  async vertexCredential(signal: AbortSignal, apiKey = this.apiKey, timeoutMs = this.requestTimeoutMs): Promise<{ accessToken: string; projectId: string }> {
    const account = parseVertexServiceAccount(apiKey);
    if (this.#vertexToken && this.#vertexToken.expiresAt > Date.now() + 60_000 && this.#vertexToken.projectId === account.project_id) {
      return this.#vertexToken;
    }
    const issuedAt = Math.floor(Date.now() / 1_000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: account.token_uri,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    })}`;
    const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), account.private_key).toString("base64url")}`;
    const token = await fetchJson(account.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    }, signal, timeoutMs);
    if (typeof token.access_token !== "string" || !token.access_token) throw new Error("Vertex OAuth response did not contain an access token");
    this.#vertexToken = {
      accessToken: token.access_token,
      expiresAt: Date.now() + Math.max(60, Number(token.expires_in) || 3_600) * 1_000,
      projectId: account.project_id,
    };
    return this.#vertexToken;
  }

  update(input: ServerLlmConfigInput): ServerLlmPublicConfig {
    const parsed = ServerLlmConfigSchema.parse({ ...this.#config, ...input });
    const next = {
      ...parsed,
      endpoint: validateEndpoint(parsed.provider, parsed.endpoint),
      thinking: normalizeDirectGeminiThinking(parsed.provider, parsed.model, parsed.thinking),
    };
    if ((next.provider === "gemini_api" || next.provider === "ollama_cloud") && next.serviceTier !== "standard") {
      throw new Error("The selected provider supports only the standard processing tier");
    }
    if (next.provider === "vertex" && next.serviceTier !== "standard" && new URL(next.endpoint).hostname !== "aiplatform.googleapis.com") {
      throw new Error("Vertex Flex and Priority require the global aiplatform.googleapis.com endpoint");
    }
    if (next.engine === "server" && !next.apiKey && !this.#apiKeys[next.provider]) throw new Error("An API key is required for server processing");
    if (next.apiKey && next.provider !== "vertex" && /\r|\n/.test(next.apiKey)) throw new Error("API key contains unsupported line breaks");
    const { apiKey, ...publicConfig } = next;
    if (apiKey) {
      const normalized = next.provider === "vertex" ? JSON.stringify(parseVertexServiceAccount(apiKey)) : apiKey;
      saveSecret(this.secretsPath, secretName(next.provider), normalized);
      this.#apiKeys[next.provider] = normalized;
      this.#vertexToken = undefined;
    }
    this.#config = publicConfig;
    this.db.prepare("INSERT INTO server_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
      CONFIG_KEY,
      JSON.stringify(publicConfig),
    );
    return this.publicConfig;
  }

  clearKey(): void {
    delete this.#apiKeys[this.#config.provider];
    saveSecret(this.secretsPath, secretName(this.#config.provider), null);
    this.#vertexToken = undefined;
  }
}

interface VertexServiceAccount {
  type: "service_account";
  project_id: string;
  private_key: string;
  client_email: string;
  token_uri: "https://oauth2.googleapis.com/token";
}

function parseVertexServiceAccount(value: string): VertexServiceAccount {
  let parsed: any;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Vertex credential must be a service-account JSON object"); }
  if (parsed?.type !== "service_account" || typeof parsed.project_id !== "string" || !parsed.project_id.trim()
    || typeof parsed.client_email !== "string" || !parsed.client_email.endsWith(".gserviceaccount.com")
    || typeof parsed.private_key !== "string" || !parsed.private_key.includes("BEGIN PRIVATE KEY")
    || parsed.token_uri !== "https://oauth2.googleapis.com/token") {
    throw new Error("Vertex service-account JSON is missing a supported project_id, client_email, private_key, or token_uri");
  }
  return {
    type: "service_account",
    project_id: parsed.project_id.trim(),
    client_email: parsed.client_email.trim(),
    private_key: parsed.private_key,
    token_uri: "https://oauth2.googleapis.com/token",
  };
}

function validationSummary(error: unknown): string {
  return structuredValidationDiagnostic(error);
}

function extractionRepairInstruction(error: unknown): string {
  const evidence = `[{"messageId":"one supplied message ID","quote":"optional exact source excerpt"}]`;
  const access = `[{"holder":"character name","basis":"experienced","evidence":${evidence},"confidence":1.0}]`;
  return `Correct only the previous response and return the complete JSON object with no commentary or Markdown.
Keep the same supported facts and supplied evidence IDs. Do not invent replacements for invalid values.
STRUCTURAL CONTRACT:
- Every field named evidence is an array shaped ${evidence}. Never use a string or a single object.
- Every stateObservations[] item must contain a non-empty evidence array in that exact shape. If its source cannot be preserved, remove the entire observation instead of omitting evidence.
- Every stateObservations[] item must contain a non-empty batch-local key. Preserve an existing key or use a simple kind-and-index label; do not use it as a canonical predicate or promise key.
- Every access field is an array shaped ${access}. access[].basis is one of ${ITEM_ACCESS_BASIS_VALUES.join("|")}. Empty access means narrator archive only.
- The first-pass top level is exactly language, entities, memories, stateObservations, relationshipEvents, socialKnowledge, relationshipBaselines, physicalIntimacy, memoryRecallObservations, atomRelations, sourcePassages, unfinishedSource. Never add canonical assertions, beliefs, or promises.
- physicalIntimacy[].act is exactly one of ${PHYSICAL_INTIMACY_ACT_VALUES.join("|")}. Use other with customLabel only when no listed act fits.
- details[].kind is exactly one of ${MEMORY_DETAIL_KIND_VALUES.join("|")}.
- keyDialogues[].kind is exactly one of ${KEY_DIALOGUE_KIND_VALUES.join("|")}.
- relationshipBaselines affection/trust/intimacy use ${SIGNED_RELATIONSHIP_BASELINE_VALUES.join("|")}.
- relationshipBaselines fear/jealousy/hostility use ${INTENSITY_RELATIONSHIP_BASELINE_VALUES.join("|")}.
Validation paths: ${validationSummary(error)}`;
}

function thinkingBudget(level: ThinkingLevel): number | undefined {
  if (level === "default") return undefined;
  return { off: 0, low: 1_024, medium: 4_096, high: 8_192 }[level];
}

function geminiGenerationTuning(model: string, thinking: ThinkingLevel, temperature: number): Record<string, unknown> {
  if (usesGeminiFlashThinkingLevel(model)) {
    const thinkingLevel = thinking === "default" ? undefined : thinking === "high" ? "HIGH" : thinking === "medium" ? "MEDIUM" : "LOW";
    return thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {};
  }
  const budget = thinkingBudget(thinking);
  return {
    temperature,
    ...(budget === undefined ? {} : { thinkingConfig: { thinkingBudget: budget } }),
  };
}

function vertexUrl(endpoint: string, model: string, projectId: string): string {
  if (endpoint.includes("{model}")) return endpoint.replaceAll("{model}", encodeURIComponent(model));
  if (endpoint.endsWith(":generateContent")) return endpoint;
  const base = endpoint.replace(/\/$/, "");
  if (/\/projects\/[^/]+\/locations\/[^/]+$/i.test(base)) {
    return `${base}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
  }
  const hostname = new URL(endpoint).hostname;
  const location = hostname === "aiplatform.googleapis.com" ? "global" : hostname.replace(/-aiplatform\.googleapis\.com$/, "");
  return `${base}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

function geminiApiUrl(endpoint: string, model: string): string {
  if (endpoint.includes("{model}")) return endpoint.replaceAll("{model}", encodeURIComponent(model));
  if (endpoint.endsWith(":generateContent")) return endpoint;
  return `${endpoint.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
}

async function fetchJson(url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(`Server LLM request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`Server LLM returned ${response.status}${body ? ` — ${body.slice(0, 800)}` : ""}`);
    try { return JSON.parse(body); }
    catch { throw new Error(`Server LLM returned invalid JSON transport data: ${body.slice(0, 400)}`); }
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

type ServerLlmPurpose = "memory_group" | "memory_group_repair" | "extraction" | "extraction_repair" | "initial_calibration" | "initial_calibration_repair" | "audit" | "audit_repair" | "reconciliation" | "reconciliation_repair" | "ledger_consistency" | "ledger_consistency_repair" | "relationship_projection" | "relationship_projection_repair" | "story_consolidation" | "story_consolidation_repair" | "episode_draft" | "episode_draft_repair" | "episode_finalize" | "episode_finalize_repair";

export async function groupMemoriesWithServerLlm(store: ServerLlmStore, job: LeasedJob, signal: AbortSignal): Promise<MemoryGroupingResult> {
  const stage = job.memoryGrouping!;
  const messages = [{ role: 'system' as const, content: stage.systemPrompt }, { role: 'user' as const, content: stage.userPrompt }];
  const first = await callProvider(store, job.id, messages, signal, 'memory_group');
  try { return validateGroupingResult(parseServerJson(first, 'memory_group'), stage); }
  catch (error) {
    const repaired = await callProvider(store, job.id, [...messages, { role: 'assistant', content: first },
      { role: 'user', content: `Return corrected grouping JSON only. Use only supplied evidence IDs. ${validationSummary(error)}` }], signal, 'memory_group_repair');
    assertChangedStructuredRepair(first, repaired, 'memory_group');
    return validateGroupingResult(parseServerJson(repaired, 'memory_group_repair'), stage);
  }
}

function parseServerJson(text: string, purpose: ServerLlmPurpose): unknown {
  const parsed = parseStructuredModelJson(text);
  if (parsed.repaired) console.warn(`[RCM] Server LLM local JSON repair purpose=${purpose} repairs=${parsed.repairs.join(",")}`);
  return normalizeStructuredModelOptionals(parsed.value);
}

export class ServerLlmOutputError extends Error {
  readonly retryable = true;
  constructor(readonly reason: "empty_output" | "max_tokens", message: string) {
    super(message);
    this.name = "ServerLlmOutputError";
  }
}

function ensureCompleteOutput(content: string, finishReason: unknown): string {
  const normalized = String(finishReason ?? "").trim().toUpperCase();
  if (!content.trim()) throw new ServerLlmOutputError("empty_output", "Server LLM returned an empty response");
  if (["MAX_TOKENS", "MAX_OUTPUT_TOKENS", "LENGTH"].includes(normalized)) {
    throw new ServerLlmOutputError("max_tokens", `Server LLM output was truncated (${normalized})`);
  }
  return content;
}

function finiteTokenCount(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

async function callProvider(
  store: ServerLlmStore,
  jobId: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  signal: AbortSignal,
  purpose: ServerLlmPurpose,
  requestedOutputBudget?: number,
): Promise<string> {
  messages = messages.map(message => ({ ...message, content: prepareAuxiliaryText(message.content) }));
  const config = store.snapshotJob(jobId);
  const apiKey = store.apiKeyForJob(jobId, config.provider);
  if (!apiKey) throw new Error("Server LLM API key is not configured");
  const measurement = measureAuxiliaryPrompt(messages, estimateTokens, config);
  if (!measurement.fits) throw new Error(`AUXILIARY_INPUT_BUDGET_EXCEEDED: completed input needs about ${measurement.estimatedInputTokens} tokens; limit is ${measurement.maxInputTokens}. Source and intermediate results were preserved for retry.`);
  const startedAt = Date.now();
  const timingId = randomUUID();
  store.recordTiming({ id: timingId, jobId, purpose, startedAt, outcome: "running" });
  const promptChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const jsonBudget = Math.min(config.maxOutputTokens, requestedOutputBudget ?? config.maxOutputTokens);
  const limit = jsonBudget;
  console.log(`[RCM] Server LLM request start provider=${config.provider} model=${config.model} purpose=${purpose} promptChars=${promptChars} jsonBudget=${jsonBudget} maxTokens=${limit}`);
  const finish = (content: string, metadata: { finishReason?: unknown; usage?: any } = {}): string => {
    const promptTokens = finiteTokenCount(metadata.usage?.prompt_tokens ?? metadata.usage?.promptTokenCount);
    const completionTokens = finiteTokenCount(metadata.usage?.completion_tokens ?? metadata.usage?.candidatesTokenCount);
    const reasoningTokens = finiteTokenCount(metadata.usage?.reasoning_tokens ?? metadata.usage?.completion_tokens_details?.reasoning_tokens ?? metadata.usage?.thoughtsTokenCount);
    const cachedInputTokens = finiteTokenCount(metadata.usage?.cachedContentTokenCount ?? metadata.usage?.prompt_tokens_details?.cached_tokens ?? metadata.usage?.cached_tokens);
    console.log([
      `[RCM] Server LLM request complete provider=${config.provider} model=${config.model} purpose=${purpose}`,
      `elapsedMs=${Date.now() - startedAt} contentChars=${content.length}`,
      metadata.finishReason ? `finishReason=${String(metadata.finishReason)}` : "",
      promptTokens === undefined ? "" : `promptTokens=${promptTokens}`,
      completionTokens === undefined ? "" : `completionTokens=${completionTokens}`,
      reasoningTokens === undefined ? "" : `reasoningTokens=${reasoningTokens}`,
      cachedInputTokens === undefined ? "" : `cachedInputTokens=${cachedInputTokens}`,
    ].filter(Boolean).join(" "));
    store.stageOutput(jobId, content);
    let completed: string;
    try { completed = ensureCompleteOutput(content, metadata.finishReason); }
    catch (error) {
      store.settleCall(jobId, purpose, "failed", { error, usage: { promptTokens, completionTokens, reasoningTokens, cachedInputTokens } });
      throw error;
    }
    store.settleCall(jobId, purpose, "succeeded", { usage: { promptTokens, completionTokens, reasoningTokens, cachedInputTokens } });
    store.recordTiming({ id: timingId, jobId, purpose, startedAt, elapsedMs: Date.now() - startedAt, outcome: "succeeded" });
    return completed;
  };
  try {
    const deadline = Date.now() + config.llmTimeoutMs;
    if (config.provider === "gemini_api" || config.provider === "vertex") {
      const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
      const contents = messages.filter((message) => message.role !== "system").map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }));
      const vertex = config.provider === "vertex" ? await store.vertexCredential(signal, apiKey, Math.max(1, deadline - Date.now())) : undefined;
      const timeoutMs = Math.max(1, deadline - Date.now());
      const url = config.provider === "gemini_api" ? geminiApiUrl(config.endpoint, config.model) : vertexUrl(config.endpoint, config.model, vertex!.projectId);
      const headers: Record<string, string> = config.provider === "gemini_api"
        ? { "Content-Type": "application/json", "x-goog-api-key": apiKey }
        : { "Content-Type": "application/json", Authorization: `Bearer ${vertex!.accessToken}` };
      if (config.provider === "vertex" && config.serviceTier !== "standard") {
        headers["X-Vertex-AI-LLM-Request-Type"] = "shared";
        headers["X-Vertex-AI-LLM-Shared-Request-Type"] = config.serviceTier;
        if (config.serviceTier === "flex") headers["X-Server-Timeout"] = "1800";
      }
      const request: RequestInit = {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents,
          generationConfig: {
            maxOutputTokens: limit,
            responseMimeType: "application/json",
            ...geminiGenerationTuning(config.model, config.thinking, config.temperature),
          },
        }),
      };
      store.recordCall(jobId, purpose);
      const result = await fetchJson(url, request, signal, timeoutMs);
      const content = (result.candidates?.[0]?.content?.parts ?? []).map((part: any) => typeof part?.text === "string" ? part.text : "").join("");
      return finish(content, { finishReason: result.candidates?.[0]?.finishReason, usage: result.usageMetadata });
    }

    if (config.provider === "ollama_cloud") {
      const think = config.thinking === "default" ? undefined : config.thinking === "off" ? false : config.thinking;
      store.recordCall(jobId, purpose);
      const result = await fetchJson(config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: config.model, messages, stream: false, format: "json",
          options: { temperature: config.temperature, num_predict: limit },
          ...(think === undefined ? {} : { think }),
        }),
      }, signal, config.llmTimeoutMs);
      return finish(String(result.message?.content ?? ""), { finishReason: result.done_reason });
    }

    const reasoningEffort = config.thinking === "default" ? undefined : config.thinking === "off" ? "none" : config.thinking;
    const request = {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: limit,
        stream: false,
        response_format: { type: "json_object" },
        ...(config.serviceTier === "standard" ? {} : { service_tier: config.serviceTier }),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
    } satisfies RequestInit;
    store.recordCall(jobId, purpose);
    const result = await fetchJson(config.endpoint, request, signal, config.llmTimeoutMs);
    return finish(String(result.choices?.[0]?.message?.content ?? ""), { finishReason: result.choices?.[0]?.finish_reason, usage: result.usage });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
    store.settleCall(jobId, purpose, "failed", { error: message });
    store.recordTiming({ id: timingId, jobId, purpose, startedAt, elapsedMs: Date.now() - startedAt, outcome: "failed" });
    console.warn(`[RCM] Server LLM request failed provider=${config.provider} model=${config.model} purpose=${purpose} elapsedMs=${Date.now() - startedAt} error=${message}`);
    throw error;
  }
}

export async function extractWithServerLlm(store: ServerLlmStore, job: LeasedJob, signal: AbortSignal, onRepair?: () => void): Promise<ExtractionDraftResult> {
  const sourceMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = job.systemPrompt && job.userPrompt
    ? [{ role: "system", content: job.systemPrompt }, { role: "user", content: job.userPrompt }]
    : [{ role: "user", content: job.prompt }];
  const first = await callProvider(store, job.id, sourceMessages, signal, "extraction");
  store.stageOutput(job.id, first);
  let raw: unknown;
  let resolved: unknown;
  try {
    raw = parseServerJson(first, "extraction");
    resolved = normalizeExtractionDraftInput(job.sourceUnits ? resolveModelSourceReferences(raw, job.sourceUnits) : raw);
    const parsed = Api38ExtractionDraftResultSchema.parse(resolved, { reportInput: true });
    if (parsed.language !== job.memoryLanguage) throw new Error(`Expected canonical language ${job.memoryLanguage}, received ${parsed.language}`);
    return parsed;
  } catch (firstError) {
    onRepair?.();
    console.warn(`[RCM] Server LLM validation repair purpose=extraction issue=${validationSummary(firstError)}`);
    const fieldRepair = job.sourceUnits ? planExtractionFieldRepair(raw, resolved, firstError, job.sourceUnits) : undefined;
    if (fieldRepair) {
      const response = await callProvider(store, job.id, fieldRepair.messages, signal, "extraction_repair");
      const corrected = applyExtractionFieldRepair(raw, fieldRepair, parseServerJson(response, "extraction_repair"));
      const repaired = JSON.stringify(corrected);
      store.stageOutput(job.id, repaired);
      assertChangedStructuredRepair(first, repaired, "extraction");
      const parsed = Api38ExtractionDraftResultSchema.parse(normalizeExtractionDraftInput(resolveModelSourceReferences(corrected, job.sourceUnits!)), { reportInput: true });
      if (parsed.language !== job.memoryLanguage) throw new Error(`Canonical language is still ${parsed.language}; expected ${job.memoryLanguage}`);
      return parsed;
    }
    const repaired = await callProvider(store, job.id, [
      ...sourceMessages,
      { role: "assistant", content: first },
      { role: "user", content: job.sourceUnits ? `Correct the previous JSON using the same sourceRef and evidenceSourceRefs contract as the system prompt. Preserve valid items and their keys. Do not replace missing evidence with invented facts. Return the full corrected JSON only. Errors: ${validationSummary(firstError)}` : extractionRepairInstruction(firstError) },
    ], signal, "extraction_repair");
    store.stageOutput(job.id, repaired);
    assertChangedStructuredRepair(first, repaired, "extraction");
    const parsed = Api38ExtractionDraftResultSchema.parse(normalizeExtractionDraftInput(job.sourceUnits ? resolveModelSourceReferences(parseServerJson(repaired, "extraction_repair"), job.sourceUnits) : parseServerJson(repaired, "extraction_repair")), { reportInput: true });
    if (parsed.language !== job.memoryLanguage) throw new Error(`Canonical language is still ${parsed.language}; expected ${job.memoryLanguage}`);
    return parsed;
  }
}

export async function repairSourceEvidenceWithServerLlm(store: ServerLlmStore, job: LeasedJob, draft: ExtractionDraftResult, signal: AbortSignal): Promise<ExtractionDraftResult> {
  const issues = inspectSourceReferences(draft, job.auditSourceMessages ?? []).filter((issue) => issue.reason !== "access_unverified");
  if (!issues.length || !job.sourceUnits) return draft;
  const messages = sourceRepairMessages(draft, issues, job.sourceUnits);
  if (!messages) return draft;
  const raw = await callProvider(store, job.id, messages, signal, "extraction_repair");
  return applySourceRepairs(draft, parseServerJson(raw, "extraction_repair"), issues, job.sourceUnits);
}

export async function repairPassageAccessWithServerLlm(store: ServerLlmStore, job: LeasedJob, draft: ExtractionDraftResult, plan: SourceAccessRepairPlan, signal: AbortSignal): Promise<ExtractionDraftResult> {
  const response = await callProvider(store, job.id, [{ role: "system", content: plan.systemPrompt }, { role: "user", content: plan.userPrompt }], signal, "extraction_repair");
  return applySourceAccessRepair(draft, plan, parseServerJson(response, "extraction_repair"));
}

export async function calibrateInitialSetupWithServerLlm(store: ServerLlmStore, job: LeasedJob, signal: AbortSignal): Promise<InitialCalibrationResult> {
  const validate = (raw: string, label: "initial_calibration" | "initial_calibration_repair"): InitialCalibrationResult => {
    const parsed = InitialCalibrationResultSchema.parse(parseServerJson(raw, label));
    return job.initialCalibration
      ? normalizeAndValidateSetupEvidence(job.initialCalibration.resolvedSetup, parsed, job.initialCalibration.identityHints)
      : parsed;
  };
  const parts = job.initialCalibration?.promptParts?.length ? job.initialCalibration.promptParts
    : [{ systemPrompt: job.systemPrompt ?? "", userPrompt: job.userPrompt ?? job.prompt }];
  const results: InitialCalibrationResult[] = [];
  for (const part of parts) {
    const cached = store.cachedPage(job.id, "initial_calibration", part.systemPrompt, part.userPrompt);
    if (cached !== undefined) { results.push(InitialCalibrationResultSchema.parse(cached)); continue; }
    const messages = part.systemPrompt
      ? [{ role: "system" as const, content: part.systemPrompt }, { role: "user" as const, content: part.userPrompt }]
      : [{ role: "user" as const, content: part.userPrompt }];
    const first = await callProvider(store, job.id, messages, signal, "initial_calibration");
    try { const parsed = validate(first, "initial_calibration"); store.cachePage(job.id, "initial_calibration", part.systemPrompt, part.userPrompt, parsed); results.push(parsed); }
    catch (firstError) {
      const repaired = await callProvider(store, job.id, [
        ...messages,
        { role: "assistant" as const, content: first },
        { role: "user" as const, content: `Repair only the JSON structure and evidence pointers. Return exactly {entities:[...],relationships:[...]}. For each entity quote only its shortest exact displayed name copied verbatim from the cited renderedSetup source. For each relationship copy one short contiguous supporting substring verbatim; do not rewrite punctuation or whitespace. Remove an unsupported relationship instead of inventing evidence. Do not add story facts, beliefs, promises, relationship types, or physical acts. No commentary. ${validationSummary(firstError)}` },
      ], signal, "initial_calibration_repair");
      assertChangedStructuredRepair(first, repaired, "initial_calibration");
      const parsed = validate(repaired, "initial_calibration_repair"); store.cachePage(job.id, "initial_calibration", part.systemPrompt, part.userPrompt, parsed); results.push(parsed);
    }
  }
  return mergeInitialCalibrationResults(results);
}

export async function auditExtractionWithServerLlm(store: ServerLlmStore, job: LeasedJob, result: unknown, signal: AbortSignal, onRepair?: () => void): Promise<ExtractionAuditSubmission> {
  const draft = extractionAuditDraftForJob(job, result);
  const messages = buildExtractionAuditMessages({
    memoryLanguage: job.memoryLanguage,
    sourceMessages: job.auditSourceMessages ?? [],
    draft,
    existingOpenPromises: job.auditExistingOpenPromises,
    recallCandidates: job.recallCandidates,
    sourceRecovery: job.sourceRecovery,
    sourceRecoveryContext: job.sourceRecoveryContext,
  });
  const first = await callProvider(store, job.id, messages, signal, "audit");
  const validatePatch = (value: unknown) => { const patch = ExtractionAuditPatchSchema.parse(value); return job.sourceRecovery ? validateSourceRecoveryPatch(patch) : patch; };
  try { return { patch: validatePatch(parseServerJson(first, "audit")) }; }
  catch (firstError) {
    onRepair?.();
    const repaired = await callProvider(store, job.id, [
      ...messages, { role: "assistant", content: first },
      { role: "user", content: `Correct only the previous response and return the complete JSON object with exactly the requested top-level keys. Use only listed refs and source message IDs. Do not make canonical lifecycle decisions. No explanation or Markdown. Validation error: ${validationSummary(firstError)}` },
    ], signal, "audit_repair");
    assertChangedStructuredRepair(first, repaired, "audit");
    return { patch: validatePatch(parseServerJson(repaired, "audit_repair")) };
  }
}

export async function episodeWithServerLlm(store: ServerLlmStore, job: LeasedJob, signal: AbortSignal): Promise<EpisodeCapsuleResult> {
  if (!job.episode) throw new Error("Episode job is missing its prompt plan");
  let drafts: EpisodeDraftResult[] = [];
  for (const draft of job.episode.drafts) {
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: draft.systemPrompt }, { role: "user", content: draft.userPrompt },
    ];
    const first = await callProvider(store, job.id, messages, signal, "episode_draft");
    try { drafts.push(EpisodeDraftResultSchema.parse(normalizeEpisodeDraftInput(parseServerJson(first, "episode_draft"), draft.sourceMessageIds))); }
    catch (firstError) {
      const repaired = await callProvider(store, job.id, [
        ...messages, { role: "assistant", content: first },
        { role: "user", content: `Repair into strict episode draft JSON with title, summary, participants, storyTime, locations, evidence, keyDialogues. No commentary. ${validationSummary(firstError)}` },
      ], signal, "episode_draft_repair");
      assertChangedStructuredRepair(first, repaired, "episode_draft");
      drafts.push(EpisodeDraftResultSchema.parse(normalizeEpisodeDraftInput(parseServerJson(repaired, "episode_draft_repair"), draft.sourceMessageIds)));
    }
  }
  while (drafts.length > 1 && estimateTokens(JSON.stringify(drafts)) > 45_000) {
    const consolidated: EpisodeDraftResult[] = [];
    for (const group of groupEpisodeDrafts(drafts)) {
      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: job.episode.finalizeSystemPrompt },
        { role: "user", content: `Consolidate these adjacent episode drafts into one strict episode draft JSON. Retain only dialogue that passes KEY DIALOGUE SELECTION; deduplicate routine or synopsis-redundant lines rather than preserving a quota. Preserve source message IDs and each retained dialogue's complete displayed source form, including quotation marks and any immediately following parenthesized counterpart; do not invent evidence.\n${JSON.stringify(group)}` },
      ];
      const first = await callProvider(store, job.id, messages, signal, "episode_draft");
      const sourceIds = [...new Set(group.flatMap((draft) => draft.evidence.map((item) => item.messageId)))];
      try { consolidated.push(EpisodeDraftResultSchema.parse(normalizeEpisodeDraftInput(parseServerJson(first, "episode_draft"), sourceIds))); }
      catch (firstError) {
        const repaired = await callProvider(store, job.id, [...messages, { role: "assistant", content: first }, { role: "user", content: `Repair into strict episode draft JSON without commentary. ${validationSummary(firstError)}` }], signal, "episode_draft_repair");
        assertChangedStructuredRepair(first, repaired, "episode_draft");
        consolidated.push(EpisodeDraftResultSchema.parse(normalizeEpisodeDraftInput(parseServerJson(repaired, "episode_draft_repair"), sourceIds)));
      }
    }
    if (consolidated.length >= drafts.length) break;
    drafts = consolidated;
  }
  const userPrompt = job.episode.finalizeUserPrompt.replace("{{DRAFTS}}", JSON.stringify(drafts));
  job.systemPrompt = job.episode.finalizeSystemPrompt;
  job.userPrompt = userPrompt;
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: job.episode.finalizeSystemPrompt }, { role: "user", content: userPrompt },
  ];
  const first = await callProvider(store, job.id, messages, signal, "episode_finalize");
  try {
    const parsed = EpisodeCapsuleResultSchema.parse(normalizeEpisodeCapsuleInput(parseServerJson(first, "episode_finalize"), job.sourceMessageIds));
    if (parsed.language !== job.memoryLanguage) throw new Error(`Expected canonical language ${job.memoryLanguage}, received ${parsed.language}`);
    return parsed;
  }
  catch (firstError) {
    const repaired = await callProvider(store, job.id, [
      ...messages, { role: "assistant", content: first },
      { role: "user", content: `Repair into one strict episode capsule JSON object matching the requested schema. No commentary. ${validationSummary(firstError)}` },
    ], signal, "episode_finalize_repair");
    assertChangedStructuredRepair(first, repaired, "episode_finalize");
    const parsed = EpisodeCapsuleResultSchema.parse(normalizeEpisodeCapsuleInput(parseServerJson(repaired, "episode_finalize_repair"), job.sourceMessageIds));
    if (parsed.language !== job.memoryLanguage) throw new Error(`Canonical language is still ${parsed.language}; expected ${job.memoryLanguage}`);
    return parsed;
  }
}

export async function reconcileWithServerLlm(
  store: ServerLlmStore,
  jobId: string,
  prompts: { systemPrompt: string; userPrompt: string },
  signal: AbortSignal,
  onRepair?: () => void,
  accessRepair?: { plan: SourceAccessRepairPlan; onResponse: (value: unknown) => void },
): Promise<ReconciliationResult> {
  const sourceMessages = [{ role: "system" as const, content: prompts.systemPrompt + (accessRepair ? `\nAlso complete the independent source-access task. Keep decisions and sourceAccessCorrections as separate fields in the same JSON object.\n${accessRepair.plan.systemPrompt}` : "") },
    { role: "user" as const, content: accessRepair ? JSON.stringify({ ledger: JSON.parse(prompts.userPrompt), sourceAccess: JSON.parse(accessRepair.plan.userPrompt) }) : prompts.userPrompt }];
  const purpose = accessRepair ? "reconciliation_repair" : "reconciliation";
  const first = await callProvider(store, jobId, sourceMessages, signal, purpose);
  try {
    const raw = parseServerJson(first, purpose);
    const result = ReconciliationResultSchema.parse(raw);
    accessRepair?.onResponse(raw);
    return result;
  } catch (firstError) {
    onRepair?.();
    console.warn(`[RCM] Server LLM validation repair purpose=reconciliation issue=${validationSummary(firstError)}`);
    const repaired = await callProvider(store, jobId, [
      ...sourceMessages,
      { role: "assistant", content: first },
      { role: "user", content: `Repair this into one valid JSON object matching the requested reconciliation schema. Keep only allowed itemRef and targetIds values. Return one decision per itemRef. No commentary. Validation error: ${validationSummary(firstError)}` },
    ], signal, "reconciliation_repair");
    assertChangedStructuredRepair(first, repaired, "reconciliation");
    return ReconciliationResultSchema.parse(parseServerJson(repaired, "reconciliation_repair"));
  }
}

export async function checkLedgerConsistencyWithServerLlm(store: ServerLlmStore, job: LeasedJob, signal: AbortSignal, onRepair?: () => void): Promise<LedgerConsistencyResult> {
  const parts = job.ledgerConsistency?.promptParts?.length ? job.ledgerConsistency.promptParts : [{ systemPrompt: job.systemPrompt ?? "", userPrompt: job.userPrompt ?? job.prompt }];
  const merged = new Map<string, LedgerConsistencyResult["groups"][number]>();
  for (const part of parts) {
    const cached = store.cachedPage(job.id, "ledger_consistency", part.systemPrompt, part.userPrompt);
    if (cached !== undefined) {
      for (const group of LedgerConsistencyResultSchema.parse(cached).groups) {
        const prior = merged.get(group.itemRef);
        merged.set(group.itemRef, prior ? { itemRef: group.itemRef, closures: [...prior.closures, ...group.closures] } : group);
      }
      continue;
    }
    const sourceMessages = part.systemPrompt ? [{ role: "system" as const, content: part.systemPrompt }, { role: "user" as const, content: part.userPrompt }] : [{ role: "user" as const, content: part.userPrompt }];
    const first = await callProvider(store, job.id, sourceMessages, signal, "ledger_consistency");
    let parsed: LedgerConsistencyResult;
    try { parsed = LedgerConsistencyResultSchema.parse(parseServerJson(first, "ledger_consistency")); }
    catch (firstError) {
    onRepair?.();
    const repaired = await callProvider(store, job.id, [
      ...sourceMessages,
      { role: "assistant" as const, content: first },
      { role: "user" as const, content: `Repair this into the requested strict final-ledger JSON. Return every supplied itemRef exactly once and use only supplied IDs. No commentary. Validation error: ${validationSummary(firstError)}` },
    ], signal, "ledger_consistency_repair");
    assertChangedStructuredRepair(first, repaired, "ledger_consistency");
      parsed = LedgerConsistencyResultSchema.parse(parseServerJson(repaired, "ledger_consistency_repair"));
    }
    const expected = new Set("itemRefs" in part ? part.itemRefs : job.ledgerConsistency?.groups.map((group) => group.itemRef) ?? []);
    if (parsed.groups.length !== expected.size || new Set(parsed.groups.map((group) => group.itemRef)).size !== expected.size || parsed.groups.some((group) => !expected.has(group.itemRef))) throw new Error("Ledger page did not return every supplied group exactly once");
    store.cachePage(job.id, "ledger_consistency", part.systemPrompt, part.userPrompt, parsed);
    for (const group of parsed.groups) {
      const prior = merged.get(group.itemRef);
      merged.set(group.itemRef, prior ? { itemRef: group.itemRef, closures: [...prior.closures, ...group.closures] } : group);
    }
  }
  return LedgerConsistencyResultSchema.parse({ groups: [...merged.values()] });
}

export async function projectRelationshipsWithServerLlm(store: ServerLlmStore, job: LeasedJob, signal: AbortSignal): Promise<RelationshipProjectionResult> {
  const sourceMessages = job.systemPrompt && job.userPrompt
    ? [{ role: "system" as const, content: job.systemPrompt }, { role: "user" as const, content: job.userPrompt }]
    : [{ role: "user" as const, content: job.prompt }];
  const first = await callProvider(store, job.id, sourceMessages, signal, "relationship_projection");
  try { return RelationshipProjectionResultSchema.parse(parseServerJson(first, "relationship_projection"), { reportInput: true }); }
  catch (firstError) {
    const repaired = await callProvider(store, job.id, [
      ...sourceMessages,
      { role: "assistant", content: first },
      { role: "user", content: `Repair into one strict relationship projection JSON object matching the requested schema. Preserve every requested pair exactly once. Each axis is {level,trend}; trend is rising|stable|falling|volatile|unclear. affection levels: unknown|aversion|none|faint|growing|established|strong|deep|conflicted. trust levels: unknown|distrust|none|fragile|developing|established|strong|deep|conflicted. intimacy levels: unknown|avoidant|none|tentative|developing|established|strong|deep|conflicted. fear, jealousy, and hostility levels: unknown|none|low|moderate|high|extreme. No commentary. Validation error: ${validationSummary(firstError)}` },
    ], signal, "relationship_projection_repair");
    assertChangedStructuredRepair(first, repaired, "relationship_projection");
    return RelationshipProjectionResultSchema.parse(parseServerJson(repaired, "relationship_projection_repair"), { reportInput: true });
  }
}

export async function consolidateStorySpineWithServerLlm(store: ServerLlmStore, job: LeasedJob, signal: AbortSignal): Promise<StorySpineConsolidationResult> {
  const systemPrompt = job.systemPrompt ?? "";
  const userPrompt = job.userPrompt ?? "";
  const validateGenerationShape = (value: unknown): StorySpineConsolidationResult => {
    const parsed = StorySpineConsolidationResultSchema.parse(value);
    if (!job.storyConsolidation) throw new Error("Story consolidation metadata unavailable");
    validateStorySpineConsolidation(parsed, job.storyConsolidation);
    return parsed;
  };
  const first = await callProvider(store, job.id, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], signal, "story_consolidation");
  store.stageOutput(job.id, first);
  try { return validateGenerationShape(parseServerJson(first, "story_consolidation")); }
  catch (error) {
    store.stageOutput(job.id, first, validationSummary(error));
    const repair = storySpineRepairInstruction(job.storyConsolidation?.level ?? "segment", validationSummary(error));
    const second = await callProvider(store, job.id, [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
      { role: "assistant", content: first },
      { role: "user", content: repair },
    ], signal, "story_consolidation_repair");
    store.stageOutput(job.id, second);
    assertChangedStructuredRepair(first, second, "story_consolidation");
    return validateGenerationShape(parseServerJson(second, "story_consolidation_repair"));
  }
}
