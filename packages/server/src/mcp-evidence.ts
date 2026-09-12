import { normalizeSearchTokens, type McpEvidence, type McpQuestionAnswer, type MemoryContextItem } from "@rcm/shared";
import type { SemanticSearchResult } from "./embedding.js";
import { memoryDetailAtomKey, memoryDialogueAtomKey } from "./memory-atoms.js";

/** Retrieval ranking only: term rarity is measured in the accessible corpus.
 * No natural-language label is interpreted as an answer type or truth claim. */
export function evidenceRanker(query: string, corpus: string[]): (text: string) => number {
  const documents = corpus.map(text => new Set(normalizeSearchTokens(text)));
  const weights = new Map([...new Set(normalizeSearchTokens(query))].map(token => {
    const frequency = documents.filter(document => document.has(token)).length;
    return [token, Math.log(1 + documents.length / Math.max(1, frequency))] as const;
  }));
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  return text => {
    const tokens = new Set(normalizeSearchTokens(text));
    return total ? [...weights].reduce((sum, [token, weight]) => sum + (tokens.has(token) ? weight : 0), 0) / total : 0;
  };
}

export interface McpRecordSelection {
  answers: McpQuestionAnswer[];
  detailIds: string[];
  memoryIds: string[];
  /** Query-grounded atoms that remain useful if final budget removes them. */
  eligibleAtomKeysByMemory: Map<string, Set<string>>;
}

type AtomCandidate = { evidence: McpEvidence; memoryId: string; detailId?: string; score: number; supplied: boolean };

/** Selects answer evidence per requested question. Parent summaries may locate a
 * scene but never become answer evidence or make sibling atoms eligible. */
export function rankMcpRecords(items: MemoryContextItem[], query: string, facets: string[], semantic: SemanticSearchResult[],
  supplied: Set<string>, seed?: string, options: { searchEnvelopes?: Map<string,string>; referenceMemoryId?: string } = {}): McpRecordSelection {
  const sceneText = (item: MemoryContextItem) => [options.searchEnvelopes?.get(item.id), item.title, item.content,
    ...item.details.map(detail => detail.text), ...item.keyDialogues.map(dialogue => dialogue.text)].filter(Boolean).join(" ");
  const corpus = items.flatMap(item => [sceneText(item), ...item.details.map(detail => detail.text), ...item.keyDialogues.map(dialogue => dialogue.text)]);
  const questions = facets.length ? facets : [query];
  const eligibleAtomKeysByMemory = new Map<string, Set<string>>();
  const markEligible = (memoryId: string, atomKey: string) => {
    const keys = eligibleAtomKeysByMemory.get(memoryId) ?? new Set<string>();
    keys.add(atomKey); eligibleAtomKeysByMemory.set(memoryId, keys);
  };
  const selectedDetails = new Set<string>();
  const selectedMemories = new Set<string>();
  const fullRank = evidenceRanker(query, corpus);
  const fullView = semantic[0];

  const answers = questions.map((question, questionIndex): McpQuestionAnswer => {
    const focusRank = facets.length ? evidenceRanker(question, corpus) : fullRank;
    const view = facets.length ? semantic[questionIndex + 1] ?? semantic[0] : semantic[0];
    const candidates: AtomCandidate[] = [];
    for (const item of items) {
      const scene = sceneText(item);
      const sceneLexical = focusRank(scene);
      const fullSceneLexical = fullRank(scene);
      const sceneSemantic = view?.hits.get(item.id)?.score ?? 0;
      const fullSceneSemantic = fullView?.hits.get(item.id)?.score ?? 0;
      const target = item.id === seed;
      if (!target && sceneLexical < .14 && fullSceneLexical < .16 && sceneSemantic < .35 && fullSceneSemantic < .35) continue;
      const directDetails = new Map((view?.atomHits?.get(item.id) ?? [])
        .filter(hit => hit.kind === "memory_detail" && hit.score >= .35).map(hit => [hit.sourceId, hit.score]));
      for (const detail of item.details) {
        const atomKey = memoryDetailAtomKey(detail);
        const atomText = `${detail.text} ${detail.participants.join(" ")} ${detail.locations.join(" ")}`;
        const focusLexical = focusRank(atomText);
        const fullLexical = fullRank(atomText);
        const directSemantic = directDetails.get(detail.id) ?? 0;
        if (!(target && !query.trim()) && focusLexical < .12 && fullLexical < .16 && directSemantic < .35) continue;
        candidates.push({ memoryId:item.id, detailId:detail.id, supplied:supplied.has(atomKey),
          score: focusLexical * .72 + fullLexical * .28 + directSemantic * .32
            + Math.max(sceneLexical, sceneSemantic) * .08 + Math.max(fullSceneLexical, fullSceneSemantic) * .03,
          evidence:{atomKey,bundleKey:`anchor:${atomKey}`,memoryId:item.id,kind:"fact",text:detail.text,time:item.storyTime,
            location:detail.locations.join(", "),knownBy:detail.knownBy,basis:detail.epistemic,context:item.title} });
      }
      for (const dialogue of item.keyDialogues) {
        const atomKey = memoryDialogueAtomKey(item.id, dialogue);
        const atomText = `${dialogue.speaker} ${dialogue.text}`;
        const focusLexical = focusRank(atomText);
        const fullLexical = fullRank(atomText);
        if (!(target && !query.trim()) && focusLexical < .12 && fullLexical < .16) continue;
        candidates.push({memoryId:item.id,supplied:supplied.has(atomKey),score:focusLexical*.72+fullLexical*.28
          +Math.max(sceneLexical,sceneSemantic)*.08+Math.max(fullSceneLexical,fullSceneSemantic)*.03,
          evidence:{atomKey,bundleKey:`anchor:${atomKey}`,memoryId:item.id,kind:"quote",text:dialogue.text,speaker:dialogue.speaker,
            time:item.storyTime,knownBy:dialogue.knownBy,context:item.title} });
      }
    }
    // Delivery state must not steer evidence eligibility. A supplied best match
    // remains the best match and cannot be replaced by a different scene.
    candidates.sort((left,right)=>right.score-left.score
      || Number(right.memoryId===options.referenceMemoryId)-Number(left.memoryId===options.referenceMemoryId));
    const chosen: AtomCandidate[]=[];
    for (const candidate of candidates) {
      if (chosen.some(old=>old.evidence.atomKey===candidate.evidence.atomKey)) continue;
      chosen.push(candidate);
      if (chosen.length >= 12) break;
    }
    for (const candidate of chosen) {
      markEligible(candidate.memoryId, candidate.evidence.atomKey);
      selectedMemories.add(candidate.memoryId);
      if(candidate.detailId) selectedDetails.add(candidate.detailId);
    }
    return {question,evidence:chosen.map(candidate=>candidate.evidence),alreadyPresent:chosen.some(candidate=>candidate.supplied),
      relatedRecords:true,searchUnavailable:view?.searchUnavailable};
  });
  return {answers,detailIds:[...selectedDetails],memoryIds:[...selectedMemories],eligibleAtomKeysByMemory};
}
