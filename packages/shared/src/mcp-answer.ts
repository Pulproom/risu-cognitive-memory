/** Internal source coordinates. They support diagnostics and same-turn overlap
 * suppression but are never rendered for the main model. */
export interface McpSourceRange {
  messageId: string;
  start: number;
  end: number;
}

/** Metadata derived from a citation whose exact source range is known. It is
 * kept internal until the final excerpt range has been selected. */
export interface McpSourceMetadata {
  sourceRange: McpSourceRange;
  location?: string;
}

/** Internal evidence contract. IDs and delivery state never appear in model prose. */
export interface McpEvidence {
  atomKey: string;
  bundleKey?: string;
  memoryId?: string;
  kind: "fact" | "quote";
  text: string;
  speaker?: string;
  time?: string;
  location?: string;
  knownBy?: string[];
  basis?: string;
  /** Scene label used only by the evidence verifier. */
  context?: string;
  sourceRange?: McpSourceRange;
  sourceMetadata?: McpSourceMetadata[];
}

export interface McpQuestionAnswer {
  question: string;
  evidence: McpEvidence[];
  alreadyPresent: boolean;
  searchUnavailable?: boolean;
  relatedRecords?: boolean;
}

const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function visibleMetadata(evidence: McpEvidence, reference: (id: string) => string | undefined): string[] {
  return [
    evidence.time && `Time: ${evidence.time}`,
    evidence.location && !/^Source message\s+\d+$/i.test(evidence.location) ? `Place: ${evidence.location}` : undefined,
    evidence.knownBy?.length ? `Known by: ${evidence.knownBy.join(", ")}` : undefined,
    evidence.memoryId && reference(evidence.memoryId) ? `Follow ref: ${reference(evidence.memoryId)}` : undefined,
  ].filter((item): item is string => Boolean(item));
}

function renderEvidence(evidence: McpEvidence, answers: number[], reference: (id: string) => string | undefined): string {
  const label = answers.length ? `Answers ${answers.join(", ")}: ` : "";
  const content = evidence.basis === "archive context"
    ? `“${evidence.text}”`
    : evidence.kind === "quote"
      ? `${evidence.speaker ? `${evidence.speaker}: ` : "Exact quote: "}“${evidence.text}”`
      : evidence.text;
  const metadata = visibleMetadata(evidence, reference);
  return `- ${escape(label + content)}${metadata.length ? `\n  ${escape(metadata.join("; "))}` : ""}`;
}

/** One compact renderer for Native, Yumi and Mask. The sole wrapper marks story data. */
export function renderMcpAnswer(answers: McpQuestionAnswer[], reference: (id: string) => string | undefined = () => undefined): string {
  if (!answers.some(answer => answer.evidence.length)) {
    return answers.some(answer => answer.searchUnavailable)
      ? "<rp_memory_result>Semantic search could not complete. No additional evidence was confirmed by the available search; this is not a conclusive search miss.</rp_memory_result>"
      : answers.some(answer=>answer.alreadyPresent)
        ? "<rp_memory_result>The relevant evidence is already supplied. This search found no additional verified detail.</rp_memory_result>"
      : "<rp_memory_result>This search did not find additional verified evidence for the request.</rp_memory_result>";
  }
  const unique = new Map<string, { evidence: McpEvidence; answers: number[] }>();
  answers.forEach((answer, index) => answer.evidence.forEach(evidence => {
    const current = unique.get(evidence.atomKey);
    if (current) {
      if (!current.answers.includes(index + 1)) current.answers.push(index + 1);
    } else unique.set(evidence.atomKey, { evidence, answers: [index + 1] });
  }));
  const questions = answers.length > 1
    ? `Requested details:\n${answers.map((answer, index) => `${index + 1}. ${escape(answer.question)}`).join("\n")}\n\n`
    : "";
  const evidence = [...unique.values()].map(item => renderEvidence(item.evidence, item.answers, reference)).join("\n");
  const unavailable = answers.flatMap((answer, index) => answer.searchUnavailable && !answer.evidence.length ? [index + 1] : []);
  const unconfirmed = answers.flatMap((answer, index) => !answer.searchUnavailable && !answer.alreadyPresent && !answer.evidence.length ? [index + 1] : []);
  const completion = [
    unavailable.length ? `Search unavailable for requested details: ${unavailable.join(", ")}.` : "",
    unconfirmed.length ? `Unconfirmed in this search: ${unconfirmed.join(", ")}.` : "",
  ].filter(Boolean).join("\n");
  const heading = [...unique.values()].some(item => item.evidence.basis === "archive context")
    ? "Archived evidence (quoted passages are exact excerpts):" : "Archived evidence:";
  return `<rp_memory_result>\n${questions}${heading}\n${evidence}${completion ? `\n\n${completion}` : ""}\n</rp_memory_result>`;
}
