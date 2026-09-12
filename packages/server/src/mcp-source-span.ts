import { createHash } from "node:crypto";
import type { McpEvidence, McpQuestionAnswer, McpSourceRange } from "@rcm/shared";
import type { EvidenceReranker } from "./reranker.js";
import { presentationOnlySourcePassage } from "./source-evidence.js";

const MAX_SPAN_CHARACTERS = 720;
const MAX_SOURCE_SPANS_PER_QUESTION = 2;
const SECOND_SPAN_MAX_GAP = .16;
// This is a direct-evidence gate, not a relative-ranking cutoff. A source
// passage that merely comes first among weak neighbours must be omitted.
const SOURCE_SPAN_ACCEPTANCE = .55;

export interface McpSourceSpanDiagnostic {
  elapsedMs: number;
  calls: number;
  questions: Array<{ question: string; candidates: number; selected: number; scores: number[] }>;
}

type SourceSpan = { evidence: McpEvidence; sourceText: string; start: number; end: number };

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

function overlaps(left: McpSourceRange | undefined, right: McpSourceRange): boolean {
  if (!left || left.messageId !== right.messageId) return false;
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function preciseRange(evidence: McpEvidence, start: number, end: number): McpSourceRange | undefined {
  return evidence.sourceRange ? {
    messageId: evidence.sourceRange.messageId,
    start: evidence.sourceRange.start + start,
    end: evidence.sourceRange.start + end,
  } : undefined;
}

/** Parent-memory labels can span several locations or times. A child excerpt
 * only inherits metadata explicitly anchored to its own source coordinates. */
function metadataForSpan(evidence: McpEvidence, sourceRange: McpSourceRange | undefined): Pick<McpEvidence, "location"> {
  if (!sourceRange || !evidence.sourceMetadata?.length) return {};
  const overlapping = evidence.sourceMetadata.filter(metadata => overlaps(metadata.sourceRange, sourceRange));
  if (!overlapping.length || overlapping.some(metadata => metadata.sourceRange.messageId !== sourceRange.messageId
    || metadata.sourceRange.start > sourceRange.start || metadata.sourceRange.end < sourceRange.end)) return {};
  const values = overlapping.map(metadata => metadata.location);
  return { location: values.length && values.every(value => typeof value === "string" && value === values[0]) ? values[0] : undefined };
}

function sentenceRanges(text: string): Array<{ start: number; end: number }> {
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
    return [...segmenter.segment(text)].flatMap(segment => {
      const leading = segment.segment.search(/\S/u);
      if (leading < 0) return [];
      const value = segment.segment.trimEnd();
      return [{ start: segment.index + leading, end: segment.index + value.length }];
    });
  } catch {
    return [...text.matchAll(/\S[\s\S]*?(?:[.!?。！？]+(?=\s|$)|$)/gu)].map(match => ({
      start: match.index!, end: match.index! + match[0].length,
    }));
  }
}

function sourceSpans(evidence: McpEvidence, excluded: McpSourceRange[]): SourceSpan[] {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const paragraph of evidence.text.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/gu)) {
    const paragraphStart = paragraph.index!;
    const paragraphEnd = paragraphStart + paragraph[0].length;
    if (paragraph[0].length <= MAX_SPAN_CHARACTERS) ranges.push({ start: paragraphStart, end: paragraphEnd });
  }
  // Dialogue turns are sometimes separated by paragraph breaks. Keep the
  // sentence windows continuous across those breaks so a question and its
  // answer compete as one short, readable passage.
  const sentences = sentenceRanges(evidence.text);
  for (let index = 0; index < sentences.length; index++) {
    for (let count = 1; count <= 3 && index + count <= sentences.length; count++) {
      const start = sentences[index]!.start;
      const end = sentences[index + count - 1]!.end;
      if (end - start <= MAX_SPAN_CHARACTERS) ranges.push({ start, end });
    }
  }
  const unique = new Map<string, SourceSpan>();
  for (const range of ranges) {
    const text = evidence.text.slice(range.start, range.end).trim();
    if (text.length < 18 || presentationOnlySourcePassage(text)) continue;
    const sourceRange = preciseRange(evidence, range.start, range.end);
    if (sourceRange && excluded.some(item => overlaps(sourceRange, item))) continue;
    const identity = `${sourceRange?.messageId ?? "source"}:${sourceRange?.start ?? range.start}:${sourceRange?.end ?? range.end}:${text}`;
    const metadata = metadataForSpan(evidence, sourceRange);
    unique.set(identity, { sourceText: evidence.text, start: range.start, end: range.end, evidence: {
      ...evidence, atomKey: `atom:v1:${hash(identity).slice(0, 32)}`,
      bundleKey: `source-span:${hash(identity).slice(0, 24)}`, text, sourceRange,
      // Do not inherit message- or memory-level metadata without a matching
      // source anchor. It would label a correct excerpt with a later scene.
      time: undefined, location: metadata.location,
      sourceMetadata: undefined,
    }});
  }
  return [...unique.values()];
}

function rangesOverlap(left: McpSourceRange | undefined, right: McpSourceRange | undefined): boolean {
  return Boolean(left && right && overlaps(left, right));
}

function surroundingSentences(span: SourceSpan): { before?: string; after?: string } {
  const sentences = sentenceRanges(span.sourceText);
  const first = sentences.findIndex(sentence => sentence.end > span.start);
  let last = -1;
  for (let index = sentences.length - 1; index >= 0; index--) {
    if (sentences[index]!.start < span.end) { last = index; break; }
  }
  return {
    before: first > 0 ? span.sourceText.slice(sentences[first - 1]!.start, sentences[first - 1]!.end).trim() : undefined,
    after: last >= 0 && last + 1 < sentences.length
      ? span.sourceText.slice(sentences[last + 1]!.start, sentences[last + 1]!.end).trim() : undefined,
  };
}

function candidateForJudging(span: SourceSpan): string {
  const context = surroundingSentences(span);
  return [
    "Candidate passage:", span.evidence.text,
    context.before && `Nearby preceding context (for reference only): ${context.before}`,
    context.after && `Nearby following context (for reference only): ${context.after}`,
  ].filter(Boolean).join("\n");
}

/** Narrows accepted source passages to excerpts that independently answer the
 * facet. Scene relevance supplies candidates; it does not establish that a
 * particular sentence answers the question. */
export async function refineMcpSourceSpans(
  answers: McpQuestionAnswer[],
  overallQuery: string,
  reranker: EvidenceReranker,
  excluded: McpSourceRange[] = [],
): Promise<McpSourceSpanDiagnostic> {
  const started = performance.now();
  const prepared = answers.map(answer => {
    const structured = answer.evidence.filter(evidence => evidence.basis !== "archive context");
    const spans = answer.evidence.filter(evidence => evidence.basis === "archive context").flatMap(evidence => sourceSpans(evidence, excluded));
    return { answer, structured, spans };
  });
  const calls = prepared.map(item => item.spans.length
    ? reranker.rerank([
      "Decide whether the candidate passage itself directly supports the requested detail in the same event as the overall request.",
      "Nearby context only identifies references or speakers. Do not treat it as an answer unless the candidate passage itself supplies the fact, action, dialogue, date, name, or outcome.",
      "Reject atmosphere, a nearby reaction, or a reply to an unrelated exchange.",
      `Overall request: ${overallQuery || item.answer.question}`,
      `Requested detail: ${item.answer.question}`,
    ].join("\n"), item.spans.map(span => ({ id: span.evidence.atomKey, text: candidateForJudging(span) })))
    : undefined);
  const results = await Promise.all(calls);
  const questions: McpSourceSpanDiagnostic["questions"] = [];
  prepared.forEach((item, index) => {
    const scoreMap = new Map(results[index]?.scores.map(score => [score.id, score.score]) ?? []);
    const ranked = item.spans.map(span => ({ evidence: span.evidence, score: scoreMap.get(span.evidence.atomKey) ?? -Infinity }))
      .sort((left, right) => right.score-left.score || left.evidence.text.length-right.evidence.text.length);
    const selected: typeof ranked = [];
    for (const candidate of ranked) {
      if (selected.length >= MAX_SOURCE_SPANS_PER_QUESTION) break;
      if (candidate.score < SOURCE_SPAN_ACCEPTANCE) break;
      if (selected.length && candidate.score < selected[0]!.score - SECOND_SPAN_MAX_GAP) break;
      if (selected.some(current => rangesOverlap(current.evidence.sourceRange, candidate.evidence.sourceRange))) continue;
      selected.push(candidate);
    }
    item.answer.evidence = [...item.structured, ...selected.map(candidate => candidate.evidence)];
    questions.push({ question: item.answer.question, candidates: item.spans.length, selected: selected.length,
      scores: ranked.slice(0, 8).map(candidate => candidate.score) });
  });
  return { elapsedMs: performance.now() - started, calls: calls.filter(Boolean).length, questions };
}
