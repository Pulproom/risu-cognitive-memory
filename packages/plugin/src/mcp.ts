declare const __RCM_DISTRIBUTION__: boolean;
import { RCM_PLUGIN_VERSION, renderMcpAnswer, type McpQuestionAnswer, type McpSourceRange, estimateTokens, memoryGuidanceBlock, RecallIntentSchema, type RecallIntent } from "@rcm/shared";
import type { ServerClient } from "./api-client.js";
import { readCurrentChatId, readCurrentContext } from "./context.js";
import { isChatMemoryEnabled } from "./settings.js";
import mcpContract from "./mcp-contract.json" with { type: "json" };
import type { RuntimeState } from "./types.js";
import { finishTiming, startTiming } from "./timing.js";

export const memoryToolFunctions = mcpContract.tools;
export const MCP_REQUEST_TIMEOUT_MS = 90_000;

export type MemoryToolName = "recall_rp_memory" | "follow_rp_memory";

export function currentTurnMemoryToolNames(state: RuntimeState, chatId?: string): MemoryToolName[] {
  const opportunity = state.memoryToolOpportunity;
  const currentChatId = chatId ?? state.current?.chatId;
  if (!state.settings.memoryToolsEnabled || !opportunity || opportunity.chatId !== currentChatId) return [];
  const names: MemoryToolName[] = [];
  if (opportunity.value.archiveSearchAvailable || opportunity.value.recallCandidateMemoryIds.length > 0) names.push("recall_rp_memory");
  const referenced = new Set(Object.values(state.memoryRefs ?? {}));
  if (opportunity.value.followCandidates.some((candidate) => referenced.has(candidate.memoryId)) || (state.mcpReturnedMemoryIds ?? []).some((id) => referenced.has(id))) names.push("follow_rp_memory");
  return names;
}

function toolDefinitions(_state: RuntimeState, _chatId: string, names: MemoryToolName[]) {
  return memoryToolFunctions.filter((tool) => names.includes(tool.name as MemoryToolName)).map(({ id: _id, ...tool }) => tool);
}

export function traceMemoryToolExposure(
  state: RuntimeState,
  client: ServerClient,
  transport: "native" | "yumi",
  plannedTools: MemoryToolName[],
  offeredTools: MemoryToolName[],
  outcome: "offered" | "empty" | "not_connected" | "timeout" | "error" | "stale_turn",
  elapsedMs?: number,
  previousCleared?: boolean,
  registration?: Record<string, unknown>,
): void {
  if (typeof __RCM_DISTRIBUTION__ !== "undefined" && __RCM_DISTRIBUTION__) return;
  if (!state.retrievalTraceEnabled) return;
  const turnKey = state.memoryToolOpportunity?.turnKey ?? state.mcpTurnKey;
  const key = `${turnKey}:${transport}:${outcome}:${offeredTools.join(",")}:${registration?.requestId ?? ""}`;
  state.memoryToolExposureKeys ??= {};
  if (state.memoryToolExposureKeys[key]) return;
  state.memoryToolExposureKeys[key] = true;
  const opportunity = state.memoryToolOpportunity?.value;
  void client.traceRetrieval({
    id: crypto.randomUUID(), kind: "tool_exposure", chatId: state.memoryToolOpportunity?.chatId ?? state.current?.chatId ?? "unknown",
    traceContext: { requestId: turnKey, turnKey, latestMessageId: state.current?.snapshot?.at(-1)?.id },
    transport, plannedTools, offeredTools, outcome, elapsedMs, previousCleared,
    registration,
    opportunity: opportunity ? {
      recallMemoryCount: opportunity.recallCandidateMemoryIds.length,
      recallAtomCount: opportunity.recallCandidateAtomKeys.length,
      followRefCount: opportunity.followCandidates.length,
      excluded: opportunity.excluded,
    } : undefined,
  }).catch(() => undefined);
}

const normalizeIntent = (value: unknown): RecallIntent => {
  const parsed = RecallIntentSchema.safeParse(value ?? "recall");
  return parsed.success ? parsed.data : "recall";
};

function memoryToolRequestKey(
  turnKey: string,
  request: { tool: "recall"; query: string; aspects: string[]; intent: RecallIntent; memoryId?: string }
    | { tool: "follow"; memoryId: string; focus: string; intent: RecallIntent },
): string {
  return JSON.stringify([turnKey, request]);
}

const escapeXmlAttribute = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

function resetToolTurnState(state: RuntimeState, chatId: string, lastMessageId: string): void {
  const turnKey = `${chatId}:${lastMessageId}`;
  if (state.mcpTurnKey === turnKey) return;
  state.mcpTurnKey = turnKey;
  state.mcpTraceCalls = 0;
  state.mcpReturnedMemoryIds = [];
  state.mcpReturnedMemorySignatures = [];
  state.mcpReturnedAtomKeys = [];
  state.mcpReturnedSourceRanges = [];
  state.mcpResponseCache = {};
  state.mcpResponseTraceIds = {};
  state.expiredMemoryRefs = Object.keys(state.memoryRefs ?? {}).slice(-128);
  state.memoryRefs = {};
  state.nextMemoryRef = 1;
}

export function beginMemoryReferenceTurn(state: RuntimeState, turnKey: string): void {
  if (state.mcpTurnKey === turnKey) return;
  state.mcpTurnKey = turnKey;
  state.mcpTraceCalls = 0;
  state.mcpReturnedMemoryIds = [];
  state.mcpReturnedMemorySignatures = [];
  state.mcpReturnedAtomKeys = [];
  state.mcpReturnedSourceRanges = [];
  state.mcpResponseCache = {};
  state.mcpResponseTraceIds = {};
  state.expiredMemoryRefs = Object.keys(state.memoryRefs ?? {}).slice(-128);
  state.memoryRefs = {};
  state.nextMemoryRef = 1;
}

function memoryRef(state: RuntimeState, id: string): string {
  state.memoryRefs ??= {};
  const existing = Object.entries(state.memoryRefs).find(([, value]) => value === id)?.[0];
  if (existing) return existing;
  const ref = `m${state.nextMemoryRef ?? 1}`;
  state.nextMemoryRef = (state.nextMemoryRef ?? 1) + 1;
  state.memoryRefs[ref] = id;
  return ref;
}

function memoryRefForId(state: RuntimeState, id: string): string | undefined {
  return Object.entries(state.memoryRefs ?? {}).find(([, value]) => value === id)?.[0];
}

export function renderMemoryReferences(
  state: RuntimeState,
  packet: string,
  selected: Array<{ id: string }> = [],
  enabled = state.settings.memoryToolsEnabled,
  followableIds: ReadonlySet<string> = new Set(),
): string {
  if (!packet) return packet;
  if (!enabled) return packet.replace(/\s+(?:id|ref)="[^"]*"/g, "");
  const renderedIds = [...packet.matchAll(/<memory\b[^>]*\sid="([^"]+)"/g)].map((match) => match[1]!).filter((id) => followableIds.has(id));
  for (const id of renderedIds) memoryRef(state, id);
  for (const item of selected) (item as { id: string; ref?: string }).ref = Object.entries(state.memoryRefs ?? {}).find(([, id]) => id === item.id)?.[0];
  return packet.replace(/<memory\b[^>]*>/g, (tag) => tag.replace(/\sid="([^"]+)"/, (_match, id: string) => followableIds.has(id) ? ` ref="${memoryRef(state, id)}"` : "")).replace(/\sid="[^"]+"/g, "");
}

export async function currentMemoryToolsAvailable(state: RuntimeState, client: ServerClient, chatId?: string, refresh = false): Promise<boolean> {
  if (!state.settings.memoryToolsEnabled) return false;
  const currentChatId = chatId ?? await readCurrentChatId();
  if (!isChatMemoryEnabled(state.settings, currentChatId)) return false;
  const cached = state.memoryToolAvailability?.[currentChatId];
  if (!refresh && typeof cached === "boolean") return cached;
  try {
    const readiness = await client.request<{ available: boolean }>(
      `/v1/chats/${encodeURIComponent(currentChatId)}/memory-tools/readiness`,
      {},
      2_000,
    );
    state.memoryToolAvailability ??= {};
    state.memoryToolAvailability[currentChatId] = readiness.available === true;
    return readiness.available === true;
  } catch {
    return state.memoryToolAvailability?.[currentChatId] === true;
  }
}

export async function executeMemoryTool(
  state: RuntimeState,
  client: ServerClient,
  toolName: string,
  args: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const toolStarted = performance.now();
  if (!memoryToolFunctions.some((tool) => tool.name === toolName)) {
    throw new Error(`Unknown memory tool: ${toolName}`);
  }
  if (!state.settings.memoryToolsEnabled) {
    return '<rp_memory_result>RCM memory tools are disabled in the dashboard.</rp_memory_result>';
  }
  const chatId = await readCurrentChatId();
  if (!isChatMemoryEnabled(state.settings, chatId)) {
    return '<rp_memory_result>RCM is disabled for the current chat. Continue without RCM memory tools.</rp_memory_result>';
  }
  if (!await currentMemoryToolsAvailable(state, client, chatId)) {
    return '<rp_memory_result>No processed long-term memory is available for this chat yet. Continue without calling RCM memory tools.</rp_memory_result>';
  }
  const context = await readCurrentContext(state);
  resetToolTurnState(state, context.chatId, context.snapshot.at(-1)?.id ?? "empty");
  // Tool calls search the archive rather than trusting a model-authored name as
  // an authorization boundary. Per-record `known_by` metadata remains in the
  // result so the main model can preserve character knowledge correctly.
  const perspective = "omniscient narrator";
  const intent = normalizeIntent(args?.intent);
  const isRecall = toolName === "recall_rp_memory";
  const query = String(args?.query ?? "").trim();
  const aspects = Array.isArray(args?.aspects) ? args.aspects.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 5) : undefined;

  const requestedMemoryId = String(args?.ref ?? "").trim();
  const focus = String(args?.query ?? "").trim();
  if (requestedMemoryId && state.expiredMemoryRefs?.includes(requestedMemoryId) && !state.memoryRefs?.[requestedMemoryId]) {
    return '<rp_memory_result>This short memory reference expired with the previous RP turn. Run recall_rp_memory again.</rp_memory_result>';
  }
  const memoryId = state.memoryRefs?.[requestedMemoryId];
  if (isRecall && !query) {
    return '<rp_memory_result>Provide a non-empty question with relevant source cues.</rp_memory_result>';
  }
  if (requestedMemoryId && !memoryId) {
    return '<rp_memory_result>Use an exact current-turn memory ref.</rp_memory_result>';
  }
  if (!isRecall && !memoryId) {
    return '<rp_memory_result>Use an exact current-turn memory ref.</rp_memory_result>';
  }
  const requestKey = memoryToolRequestKey(state.mcpTurnKey, isRecall
    ? { tool: "recall", query, aspects: aspects ?? [], intent, ...(memoryId ? { memoryId } : {}) }
    : { tool: "follow", memoryId: memoryId ?? "", focus, intent });
  state.mcpTraceCalls = (state.mcpTraceCalls ?? 0) + 1;
  const traceContext = {
    requestId: crypto.randomUUID(),
    turnKey: state.memoryToolOpportunity?.turnKey ?? state.mcpTurnKey,
    latestMessageId: context.snapshot.at(-1)?.id,
    callIndex: state.mcpTraceCalls,
  };
  let requestMs: number | undefined;
  let serverTimings: Record<string, number> | undefined;
  const traceDelivery = (response: string, cacheHit: boolean, selectedIds: string[] = [], searchRequestId: string | undefined = traceContext.requestId, deliverySource?: string, newAtomCount?: number, opportunityError?: string): void => {
    if (typeof __RCM_DISTRIBUTION__ !== "undefined" && __RCM_DISTRIBUTION__) return;
  if (!state.retrievalTraceEnabled) return;
    void client.traceRetrieval({
      id: crypto.randomUUID(),
      kind: "mcp_delivery",
      chatId: context.chatId,
      traceContext,
      searchRequestId,
      toolName,
      query: isRecall ? query : undefined,
      aspects: isRecall ? aspects : undefined,
      memoryId: isRecall ? undefined : memoryId,
      intent,
      cacheHit,
      deliverySource,
      newAtomCount,
      opportunityError,
      selectedIds,
      response,
      elapsedMs: performance.now() - toolStarted,
      requestMs, serverTimings,
      postDeliveryWait: "not_observed",
      outcome: deliverySource === "transport_error" ? "error" : "delivered",
    }).catch(() => undefined);
  };
  const cached = state.mcpResponseCache?.[requestKey];
  const timing = startTiming(state, {
    chatId: context.chatId,
    kind: "mcp",
    label: toolName === "recall_rp_memory" ? "기억 회상 도구 호출" : "기억 후속 확인 도구 호출",
  });
  let timingOutcome: "succeeded" | "failed" | "reused" = "failed";
  try {
  if (cached) {
    traceDelivery(cached, true, [], state.mcpResponseTraceIds?.[requestKey]);
    timingOutcome = "reused";
    return cached;
  }
  const targetedRecall = isRecall && Boolean(memoryId);
  const desired = targetedRecall || !isRecall ? 3_000 : 1_500 + Math.max(1, aspects?.length ?? 1) * 600;
  const callBudget = Math.min(desired, state.settings.mcpCap);
  const path = isRecall
    ? `/v1/chats/${encodeURIComponent(context.chatId)}/recall`
    : `/v1/chats/${encodeURIComponent(context.chatId)}/follow`;
  // Whole-memory exclusions would hide the remainder after a partial result.
  const delivered = state.lastInjection?.manifest;
  const common = state.lastInjection?.guidanceInjected === true || state.lastInjection?.packet?.includes(memoryGuidanceBlock) ? "" : memoryGuidanceBlock;
  const responseReserve = estimateTokens(common) + 24;
  if (responseReserve >= callBudget) {
    return '<rp_memory_result>Ask a shorter question so the result fits its budget.</rp_memory_result>';
  }
  const shared = { perspective, intent, tokenBudget: callBudget - responseReserve, excludeMemoryIds: [], excludeMemorySignatures: [],
    alreadyPresentMemoryIds: delivered?.memoryIds ?? [],
    alreadyPresentAtomKeys: [...new Set([...(delivered?.atomKeys ?? []), ...(state.mcpReturnedAtomKeys ?? [])])].slice(-512),
    excludeAtomKeys: [...new Set(state.mcpReturnedAtomKeys ?? [])].slice(-512),
    excludeSourceRanges: (state.mcpReturnedSourceRanges ?? []).slice(-256),
    promptSourceMessageIds: state.lastPromptSourceMessageIds ?? [],
    activePerspectives: context.activePerspectives,
    opportunityMemoryIds: state.memoryToolOpportunity?.value.recallCandidateMemoryIds ?? [],
    opportunityAtomKeys: state.memoryToolOpportunity?.value.recallCandidateAtomKeys ?? [],
    traceContext };
  const body = isRecall
    ? { query, ...(memoryId ? { referenceMemoryId: memoryId } : {}), ...(aspects?.length ? { aspects } : {}), ...shared }
    : { memoryId, ...(focus ? { focus } : {}), ...shared };
  const requestStarted = performance.now();
  const result = await client.request<{ answers: McpQuestionAnswer[]; timings?: Record<string, number>; packet?: string; selected?: Array<{ id: string; signature?: string; ref?: string }>; followableMemoryIds?: string[]; coverage?: Array<{ aspect: string; status: string; memoryIds?: string[]; detailIds?: string[]; targetStatus?: string; targetMemoryIds?: string[]; targetDetailIds?: string[] }>; alreadyProvidedIds?: string[]; deliveredAtomKeys?: string[]; deliveredSourceRanges?: McpSourceRange[]; deliverySource?: string; newAtomCount?: number; opportunityError?: string }>(
    path,
    { method: "POST", body: JSON.stringify(body), signal },
    MCP_REQUEST_TIMEOUT_MS,
  ).catch((error) => { if (signal?.aborted) throw error; return null; });
  requestMs = performance.now() - requestStarted;
  serverTimings = result?.timings;
  if (!result) {
    const response = "<rp_memory_result>The search could not complete because the memory or evidence-verification service request failed. This is a communication failure, not a search miss; continue with available context.</rp_memory_result>";
    traceDelivery(response, false, [], traceContext.requestId, "transport_error", 0);
    return response;
  }
  if (result.opportunityError === "stale_turn" && !result.newAtomCount) {
    const response = '<rp_memory_result>The prepared memory opportunity belongs to an earlier RP turn. Continue from the current prompt without retrying this tool.</rp_memory_result>';
    traceDelivery(response, false, [], traceContext.requestId, result.deliverySource, 0, result.opportunityError);
    return response;
  }
  const followable = new Set(result.followableMemoryIds ?? []);
  const response = renderMcpAnswer(result.answers, id => followable.has(id) ? memoryRef(state, id) : undefined)
    .replace("<rp_memory_result>", `<rp_memory_result>${result.answers.some(answer => answer.evidence.length) ? common : ""}`);
  if (estimateTokens(response) > callBudget) {
    return '<rp_memory_result>The result exceeded its delivery budget. Ask a narrower question.</rp_memory_result>';
  }
  state.mcpReturnedMemoryIds = [...new Set([...(state.mcpReturnedMemoryIds ?? []), ...(result.selected ?? []).map((item) => item.id)])].slice(-128);
  state.mcpReturnedMemorySignatures = [...new Set([...(state.mcpReturnedMemorySignatures ?? []), ...(result.selected ?? []).flatMap((item) => item.signature ? [item.signature] : [])])].slice(-128);
  state.mcpReturnedAtomKeys = [...new Set([...(state.mcpReturnedAtomKeys ?? []), ...(result.deliveredAtomKeys ?? [])])].slice(-512);
  const sourceRanges = new Map<string, McpSourceRange>();
  for (const range of [...(state.mcpReturnedSourceRanges ?? []), ...(result.deliveredSourceRanges ?? [])]) {
    sourceRanges.set(`${range.messageId}:${range.start}:${range.end}`, range);
  }
  state.mcpReturnedSourceRanges = [...sourceRanges.values()].slice(-256);
  state.mcpResponseCache ??= {};
  state.mcpResponseTraceIds ??= {};
  if (!result.answers.some(answer => answer.searchUnavailable)) {
    state.mcpResponseCache[requestKey] = response;
    state.mcpResponseTraceIds[requestKey] = traceContext.requestId;
  }
  traceDelivery(response, false, (result.selected ?? []).map((item) => item.id), traceContext.requestId, result.deliverySource, result.newAtomCount, result.opportunityError);
  timingOutcome = "succeeded";
  return response;
  } finally {
    finishTiming(state, timing, timingOutcome);
  }
}

export async function registerMemoryMcp(state: RuntimeState, client: ServerClient): Promise<void> {
  await risuai.registerMCP(
    {
      identifier: "plugin:risu-cognitive-memory",
      name: "Risu Cognitive Memory",
      version: RCM_PLUGIN_VERSION,
      description: "Optional search and expansion of processed RP history. Use supplied evidence first; avoid repeating an unchanged unsuccessful query.",
    },
    async () => {
      if (!state.settings.memoryToolsEnabled) return [];
      try {
        const chatId = await readCurrentChatId();
        if (!isChatMemoryEnabled(state.settings, chatId)) return [];
        const names = currentTurnMemoryToolNames(state, chatId);
        traceMemoryToolExposure(state, client, "native", names, names, names.length ? "offered" : "empty");
        return toolDefinitions(state, chatId, names);
      } catch {
        const planned = currentTurnMemoryToolNames(state);
        traceMemoryToolExposure(state, client, "native", planned, [], "error");
        return [];
      }
    },
    async (toolName, args) => [{ type: "text", text: await executeMemoryTool(state, client, toolName, args) }],
  );
}
