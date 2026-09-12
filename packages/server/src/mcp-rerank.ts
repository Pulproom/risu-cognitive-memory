import { normalizeSearchTokens, type McpEvidence, type McpQuestionAnswer } from "@rcm/shared";
import type { EvidenceReranker } from "./reranker.js";

export const MCP_RERANK_ACCEPTANCE = .55;
export const MCP_RERANK_OVERALL_ACCEPTANCE = .55;
const MAX_ACCEPTED_BUNDLES = 3;
const MAX_SCORE_GAP = .08;
const LONG_REQUEST_TOKENS = 20;
// Long multi-facet requests still need stronger complete-request support than
// short questions. Calibration keeps directly relevant .74-class evidence
// while retaining a wide margin over observed neighboring-scene negatives.
const LONG_REQUEST_OVERALL_ACCEPTANCE = .74;

export interface McpRerankQuestionDiagnostic {
  question: string;
  candidates: number;
  accepted: number;
  scores: Array<{ bundleKey: string; score: number; facetScore: number; overallScore: number }>;
}

export interface McpRerankDiagnostic {
  model?: string;
  elapsedMs: number;
  calls: number;
  acceptance: number;
  overallAcceptance: number;
  questions: McpRerankQuestionDiagnostic[];
}

const bundleKey = (evidence: McpEvidence): string => evidence.bundleKey ?? evidence.atomKey;

function renderCandidate(evidence: McpEvidence[]): string {
  return evidence.map(item => [item.kind === "quote" ? "Quote" : "Fact", item.text,
    item.context && `Scene: ${item.context}`,
    item.time && `Time: ${item.time}`, item.location && `Place: ${item.location}`,
    item.speaker && `Speaker: ${item.speaker}`, item.basis && `Basis: ${item.basis}`].filter(Boolean).join("; ")).join("\n");
}

function facetQuestion(overall: string, question: string): string {
  return [
    "Select archive evidence that directly answers the specific question and belongs to the overall request.",
    "Evidence that only shares a person, place, object, or topic with a different event is not an answer.",
    `Overall request: ${overall}`,
    `Specific question: ${question}`,
  ].join("\n");
}

function overallQuestion(overall: string): string {
  return ["Find archive evidence from the same specific event and circumstances named in the complete request.",
    "The evidence may answer only one requested detail; reject it when it belongs to a different event despite overlapping people, places, or topics.",
    `Complete request: ${overall}`].join("\n");
}

/** Uses a discriminative model only. It may reject every first-stage candidate;
 * absence of an accepted candidate is a grounded non-answer, not proof that an
 * event never occurred. */
export async function rerankMcpAnswers(answers: McpQuestionAnswer[], overallQuery: string, reranker: EvidenceReranker): Promise<McpRerankDiagnostic> {
  const started = performance.now();
  const prepared = answers.map(answer => {
    const groups = new Map<string, McpEvidence[]>();
    for (const evidence of answer.evidence) {
      const key = bundleKey(evidence);
      const group = groups.get(key) ?? [];
      group.push(evidence); groups.set(key, group);
    }
    const documents = [...groups].map(([id, evidence]) => ({ id, text: renderCandidate(evidence) }));
    return {answer,groups,documents};
  });
  const allDocuments=[...new Map(prepared.flatMap(item=>item.documents).map(document=>[document.id,document])).values()];
  const overallPromise=allDocuments.length?reranker.rerank(overallQuestion(overallQuery),allDocuments):undefined;
  const facetPromises=prepared.map(item=>item.documents.length
    ?reranker.rerank(facetQuestion(overallQuery||item.answer.question,item.answer.question),item.documents):undefined);
  const [overall,...facets]=await Promise.all([overallPromise,...facetPromises]);
  const overallScores=new Map(overall?.scores.map(item=>[item.id,item.score])??[]);
  // A long request carries more simultaneous event constraints and is much
  // easier to satisfy accidentally with several neighboring scenes. Its
  // candidate therefore needs stronger support for the complete request.
  const overallAcceptance=normalizeSearchTokens(overallQuery).length>=LONG_REQUEST_TOKENS
    ?LONG_REQUEST_OVERALL_ACCEPTANCE:MCP_RERANK_OVERALL_ACCEPTANCE;
  let model: string | undefined;
  const questions: McpRerankQuestionDiagnostic[] = [];
  for (let index=0;index<prepared.length;index++) {
    const item=prepared[index]!; const facet=facets[index]; model??=facet?.model??overall?.model;
    const facetScores=new Map(facet?.scores.map(score=>[score.id,score.score])??[]);
    const scored=[...item.groups].map(([key,evidence])=>{const facetScore=facetScores.get(key)??-Infinity;
      const overallScore=overallScores.get(key)??-Infinity;return {key,evidence,facetScore,overallScore,score:Math.min(facetScore,overallScore)};});
    const eligible=scored.filter(candidate=>candidate.facetScore>=MCP_RERANK_ACCEPTANCE&&candidate.overallScore>=overallAcceptance)
      .sort((left,right)=>right.score-left.score||right.facetScore-left.facetScore);
    const best=eligible[0]?.score??-Infinity;
    const accepted=eligible.filter(candidate=>candidate.score>=best-MAX_SCORE_GAP).slice(0,MAX_ACCEPTED_BUNDLES);
    item.answer.evidence=accepted.flatMap(candidate=>candidate.evidence);
    questions.push({question:item.answer.question,candidates:item.groups.size,accepted:accepted.length,
      scores:scored.sort((left,right)=>right.score-left.score).slice(0,8).map(({key,score,facetScore,overallScore})=>({bundleKey:key,score,facetScore,overallScore}))});
  }
  return { model, elapsedMs: performance.now() - started, calls: Number(Boolean(overallPromise))+facetPromises.filter(Boolean).length,
    acceptance: MCP_RERANK_ACCEPTANCE, overallAcceptance, questions };
}
