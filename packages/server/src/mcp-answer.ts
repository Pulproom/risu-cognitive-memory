import { appendMcpSourceContext } from "./mcp-source-context.js";
import { evidenceRanker, rankMcpRecords } from "./mcp-evidence.js";
import { randomUUID } from "node:crypto";
import { estimateTokens, renderMcpAnswer, type McpEvidence, type McpQuestionAnswer, type McpSourceRange } from "@rcm/shared";
import type { RcmDatabase } from "./db.js";
import type { retrieve } from "./retrieval.js";
import type { SemanticSearchResult } from "./embedding.js";
import { emptyPacketManifest } from "./packet-manifest.js";
import { memoryAtomKeys, memoryDetailAtomKey, memoryDialogueAtomKey } from "./memory-atoms.js";
import { retrieveSourceEvidence, sourceEvidenceAtomKey } from "./source-evidence.js";
import { targetDetailSourceEvidence } from "./target-source-evidence.js";
import { rerankMcpAnswers, type McpRerankDiagnostic } from "./mcp-rerank.js";
import type { EvidenceReranker } from "./reranker.js";
import { refineMcpSourceSpans, type McpSourceSpanDiagnostic } from "./mcp-source-span.js";

const MCP_RESPONSE_TARGET_TOKENS = 900;
const MCP_RESPONSE_HARD_TOKENS = 1_100;

function responseTarget(tokenBudget: number, query: string, answerCount: number): number {
  const queryComplexity = Math.min(280, estimateTokens(query) * 10);
  return Math.min(tokenBudget, MCP_RESPONSE_TARGET_TOKENS, 500 + answerCount * 100 + queryComplexity);
}

function evidencePriority(evidence: McpEvidence): number {
  if (evidence.kind === "quote" && evidence.speaker) return 0;
  if (evidence.kind === "fact") return 1;
  return 2;
}

export async function finalizeMcpAnswer(db: RcmDatabase, chatId: string, result: ReturnType<typeof retrieve>, options: {
  archiveView?: boolean; query: string; aspects?: string[]; tokenBudget: number; perspectives: string[]; promptIds?: string[]; excludedAtoms: string[];
  semantic: SemanticSearchResult[]; seedMemoryId?: string; referenceMemoryId?: string; reranker: EvidenceReranker;
  excludedSourceRanges?: McpSourceRange[];
}): Promise<{ answers: McpQuestionAnswer[]; rerank: McpRerankDiagnostic; sourceSpans: McpSourceSpanDiagnostic }> {
  const sourceStarted = performance.now();
  const supplied = new Set(options.excludedAtoms);
  const records = rankMcpRecords(result.eligibleCandidates, options.query, options.aspects ?? [], options.semantic, supplied, options.seedMemoryId, { searchEnvelopes: result.mcpSearchEnvelopes, referenceMemoryId: options.referenceMemoryId });
  const answers: McpQuestionAnswer[] = records.answers;
  const state = (result.answers ?? []).flatMap(answer => answer.evidence).filter(entry => !entry.memoryId);
  const stateRank = evidenceRanker(options.query, state.map(entry => entry.text));
  const stateRecords = [...new Map(state.filter(entry => stateRank(entry.text) >= .12).map(entry => [entry.atomKey, entry])).values()];
  if (stateRecords.length) answers.push({question:"Recorded state",relatedRecords:true,alreadyPresent:false,evidence:stateRecords.slice(0,3)});
  const corpus = result.eligibleCandidates.flatMap(item => [item.title, item.content, ...item.details.map(detail => detail.text), ...item.keyDialogues.map(dialogue => dialogue.text)]);
  const rank = evidenceRanker(options.query, corpus);
  // Source access remains independently checked. Delivery history is not access.
  const detailBundles = new Map(result.eligibleCandidates.flatMap(candidate=>candidate.details.map(detail=>[
    detail.id, answers.flatMap(answer=>answer.evidence).find(entry=>entry.atomKey===memoryDetailAtomKey(detail))?.bundleKey,
  ] as const)));
  const bound = targetDetailSourceEvidence(db, chatId, records.detailIds, options.perspectives, options.tokenBudget,
    options.excludedAtoms, options.promptIds ?? []);
  for (const answer of answers) {
    const id = answer.evidence[0]?.memoryId;
    const evidence = bound.items.filter(item => item.memoryId === id);
    for (const item of evidence) if (!options.archiveView && !answer.evidence.some(entry => entry.text === item.quote)) answer.evidence.push({
      atomKey:sourceEvidenceAtomKey(item), bundleKey:detailBundles.get(item.bundleKey ?? ""), memoryId:item.memoryId, kind:"quote", text:item.quote,
      speaker:item.speaker ?? undefined, knownBy:item.holders, basis:item.epistemic,
    });
  }
  if (!options.archiveView) {
    const sources = retrieveSourceEvidence(db, chatId, options.query, options.perspectives, options.tokenBudget,
      options.promptIds ?? [], options.semantic.flatMap(view => view.sourceHits ?? []), [], bound.atomKeys,
      quote => rank(quote) >= .12, { rank: quote => rank(quote), maxItems:2, budgetRatio:.3 });
    if (sources.items.length) answers[0]?.evidence.push(...sources.items.map(item => ({atomKey:sourceEvidenceAtomKey(item),
      kind:"quote" as const,text:item.quote,speaker:item.speaker ?? undefined,knownBy:item.holders,basis:item.epistemic})));
  }
  const sourceContext = options.archiveView
    ? appendMcpSourceContext(db, chatId, answers, result.eligibleCandidates, options.semantic, options.tokenBudget, options.query, options.promptIds)
    : undefined;
  if (!answers.length) answers.push({question:options.query,evidence:[],alreadyPresent:false,relatedRecords:true,searchUnavailable:options.semantic[0]?.searchUnavailable});
  // Candidate generation is intentionally permissive. Only direct evidence
  // accepted here can affect delivery, suppression, manifests or reinforcement.
  const rerank = await rerankMcpAnswers(answers, options.query, options.reranker);
  const sourceSpans = await refineMcpSourceSpans(answers, options.query, options.reranker, options.excludedSourceRanges);
  for (const answer of answers) {
    const acceptedSupplied=answer.evidence.some(evidence=>supplied.has(evidence.atomKey));
    answer.alreadyPresent=acceptedSupplied;
    answer.evidence=answer.evidence.filter(evidence=>!supplied.has(evidence.atomKey));
  }
  // Give every requested facet one direct unit before spending the remaining
  // compact-response target on supporting quotes or context.
  for (const answer of answers) answer.evidence.sort((left,right)=>evidencePriority(left)-evidencePriority(right));
  const retained = answers.map(answer => ({ ...answer, evidence: [] as typeof answer.evidence }));
  const targetBudget=responseTarget(options.tokenBudget,options.query,answers.length);
  const hardBudget=Math.min(options.tokenBudget,MCP_RESPONSE_HARD_TOKENS);
  const tryAdd=(question:number,evidence:McpEvidence,budget:number)=>{
    retained[question]!.evidence.push(evidence);
    if(estimateTokens(renderMcpAnswer(retained,()=>"m999999"))<=budget)return true;
    retained[question]!.evidence.pop();return false;
  };
  for(let question=0;question<answers.length;question++){
    const primary=answers[question]!.evidence[0];if(primary)tryAdd(question,primary,hardBudget);
  }
  const max=Math.max(0,...answers.map(answer=>answer.evidence.length));
  for(let index=1;index<max;index++)for(let question=0;question<answers.length;question++){
    const evidence=answers[question]!.evidence[index];if(evidence)tryAdd(question,evidence,targetBudget);
  }
  for (let index=0;index<retained.length;index++) retained[index]!.alreadyPresent=answers[index]!.alreadyPresent;
  const keys = new Set(retained.flatMap(answer => answer.evidence.map(evidence => evidence.atomKey)));
  result.mcpFollowableMemoryIds = [...records.eligibleAtomKeysByMemory].flatMap(([memoryId, atomKeys]) =>
    answers.some((answer, index) => retained[index]?.evidence.length === 0 && answer.evidence.some(evidence =>
      evidence.memoryId === memoryId && atomKeys.has(evidence.atomKey) && !keys.has(evidence.atomKey) && !supplied.has(evidence.atomKey)))
      ? [memoryId] : []);
  result.selected = result.eligibleCandidates.flatMap(item => {
    const filtered = { ...item, title: "", content: "", atomAccessVersion: 1,
      details: item.details.filter(detail => keys.has(memoryDetailAtomKey(detail))),
      keyDialogues: item.keyDialogues.filter(dialogue => keys.has(memoryDialogueAtomKey(item.id, dialogue))) };
    return memoryAtomKeys(filtered).length ? [filtered] : [];
  });
  result.deliveredAtomKeys = [...keys];
  result.deliveredSourceRanges = [...new Map(retained.flatMap(answer=>answer.evidence.flatMap(evidence=>evidence.sourceRange?[evidence.sourceRange]:[]))
    .map(range=>[`${range.messageId}:${range.start}:${range.end}`,range])).values()];
  result.structuredManifest = { ...emptyPacketManifest(), atomKeys: [...keys],
    memoryIds: [...new Set(retained.flatMap(answer => answer.evidence.flatMap(evidence => evidence.memoryId ? [evidence.memoryId] : [])))],
    detailIds: result.selected.flatMap(item => item.details.map(detail => detail.id)),
  };
  result.coverage = retained.map(answer => ({ aspect: answer.question,
    status: answer.evidence.length ? "related" : answer.alreadyPresent ? "already_present" : "no_grounded_hit",
    memoryIds: [...new Set(answer.evidence.flatMap(evidence => evidence.memoryId ? [evidence.memoryId] : []))],
  }));
  result.answers = retained;
  result.packet = renderMcpAnswer(retained);
  result.estimatedTokens = estimateTokens(result.packet);
  const ids = new Set(retained.flatMap(answer => answer.evidence.flatMap(evidence => evidence.memoryId ? [evidence.memoryId] : [])));
  const reinforce = db.prepare(`UPDATE memories SET recall_count=recall_count+1,last_recalled_revision=(SELECT revision FROM chats WHERE id=?),
    strength=ROUND(MIN(1.0,strength+0.025),3),updated_at=? WHERE chat_id=? AND id=? AND active=1`);
  const newIds = new Set(retained.flatMap(answer => answer.evidence.filter(entry => !supplied.has(entry.atomKey)).flatMap(entry => entry.memoryId ? [entry.memoryId] : [])));
  db.transaction(() => { for (const id of newIds) reinforce.run(chatId, Date.now(), chatId, id); })();
  if (ids.size) db.prepare("INSERT INTO recall_logs(id,chat_id,query,perspective,selected_json,elapsed_ms,created_at) VALUES(?,?,?,?,?,?,?)").run(
    randomUUID(), chatId, retained.map(answer => answer.question).join("; "), options.perspectives[0] ?? "",
    JSON.stringify([...ids]), Math.round(performance.now() - sourceStarted), Date.now(),
  );
  if (result.diagnostics) {
    const keptIds = new Set(result.selected.map(item => item.id));
    Object.assign(result.diagnostics, { mcpSourceContext: sourceContext, mcpRerank: rerank, mcpSourceSpans: sourceSpans,
      mcpResponseBudget:{target:targetBudget,hard:hardBudget,used:result.estimatedTokens}, referenceMemoryId: options.referenceMemoryId,
      refConflict: Boolean(options.referenceMemoryId && !records.memoryIds.includes(options.referenceMemoryId)), mcpRecordSelection: retained.map(answer => ({question:answer.question, atomKeys:answer.evidence.map(entry=>entry.atomKey), includesSupplied:answer.alreadyPresent})) });
    result.diagnostics.selectedIds = [...keptIds];
    result.diagnostics.usedTokens = result.estimatedTokens;
    for (const candidate of result.diagnostics.candidates) candidate.outcome = keptIds.has(candidate.id) ? "selected" : records.memoryIds.includes(candidate.id) ? "final_packet_trim" : "not_reserved";
    Object.assign(result.diagnostics, { mcpFinalizationMs: performance.now() - sourceStarted });
  }
  return { answers: retained, rerank, sourceSpans };
}
