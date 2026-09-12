export type StructuredJsonRepair = "bom" | "trailing_comma" | "raw_control_character" | "missing_object_key_quote" | "trailing_confidence_quote";

export interface StructuredJsonParseResult {
  value: unknown;
  repaired: boolean;
  repairs: StructuredJsonRepair[];
}

const OPTIONAL_STRING_FIELDS = new Set([
  "perspective", "storyTime", "customLabel", "initiator", "interactionContext", "circumstance",
  "sourceQuote", "memoryKey", "detailKey", "validFromMemoryKey", "source", "scheduledFor",
  "statusReason", "reason", "holder", "label", "landmark", "targetBeliefId",
]);

const OPTIONAL_ARRAY_FIELDS = new Set([
  "witnesses", "locations", "landmarkKinds", "keyDialogues", "details", "relationshipEvents",
  "socialKnowledge", "relationshipBaselines", "physicalIntimacy", "memoryRecallObservations", "atomRelations",
  "access", "activeTensions", "basisEventIds", "targetAssertionIds", "targetBeliefIds", "targetIds",
]);

/** Normalizes only optional model-output leaves for which null/blank and absence
 * have the same meaning. Required facts, enums, evidence, IDs, and prose are
 * deliberately left untouched so local code cannot manufacture valid output. */
export function normalizeStructuredModelOptionals(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeStructuredModelOptionals);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === "sourcePassages" && Array.isArray(raw)) {
      output[key] = raw.map((passage) => {
        const normalized = normalizeStructuredModelOptionals(passage);
        if (normalized && typeof normalized === "object" && !Array.isArray(normalized)
          && (normalized as Record<string, unknown>).speaker === null) delete (normalized as Record<string, unknown>).speaker;
        return normalized;
      });
      continue;
    }
    if (OPTIONAL_STRING_FIELDS.has(key) && (raw === null || (typeof raw === "string" && raw.trim() === ""))) continue;
    if (OPTIONAL_ARRAY_FIELDS.has(key) && raw === null) {
      output[key] = [];
      continue;
    }
    output[key] = normalizeStructuredModelOptionals(raw);
  }
  return output;
}

function structuredJsonCandidate(text: string): string {
  if (!text.trim()) throw new Error("Structured model returned an empty response.");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced !== undefined) return fenced;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Structured model response did not contain a complete JSON object.");
  const prefix = text.slice(0, start);
  const suffix = text.slice(end + 1);
  if (/^[ \t\r\n\ufeff]*$/.test(prefix) && /^[ \t\r\n]*$/.test(suffix)) return text;
  return text.slice(start, end + 1);
}

function repairStructuredJsonCandidate(candidate: string): { text: string; repairs: StructuredJsonRepair[] } {
  const repairs = new Set<StructuredJsonRepair>();
  let input = candidate;
  let firstContent = 0;
  while (firstContent < input.length && /[ \t\r\n]/.test(input[firstContent] ?? "")) firstContent += 1;
  if (input.charCodeAt(firstContent) === 0xfeff) {
    input = input.slice(0, firstContent) + input.slice(firstContent + 1);
    repairs.add("bom");
  }

  // Some JSON-mode models emit bare keys or keys with only their closing
  // quote (for example: {affection:{...},trust":{...}}). Repair only
  // ASCII schema keys in an object-key position. The container-aware scan is
  // deliberately narrower than a regex so similar prose inside string values
  // is never rewritten.
  {
    let output = "";
    let inString = false;
    let escaped = false;
    const containers: Array<"object" | "array"> = [];
    for (let index = 0; index < input.length; index += 1) {
      const char = input[index] ?? "";
      if (inString) {
        output += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        output += char;
        inString = true;
        continue;
      }
      if (char === "{") containers.push("object");
      else if (char === "[") containers.push("array");
      else if (char === "}" || char === "]") containers.pop();

      output += char;
      const mayStartObjectKey = (char === "{" && containers.at(-1) === "object")
        || (char === "," && containers.at(-1) === "object");
      if (!mayStartObjectKey) continue;

      let keyStart = index + 1;
      while (keyStart < input.length && /[ \t\r\n]/.test(input[keyStart] ?? "")) keyStart += 1;
      if (!/[A-Za-z_]/.test(input[keyStart] ?? "")) continue;
      let keyEnd = keyStart + 1;
      while (keyEnd < input.length && /[A-Za-z0-9_-]/.test(input[keyEnd] ?? "")) keyEnd += 1;
      const hasClosingQuote = input[keyEnd] === '"';
      const boundary = keyEnd + (hasClosingQuote ? 1 : 0);
      let colon = boundary;
      while (colon < input.length && /[ \t\r\n]/.test(input[colon] ?? "")) colon += 1;
      if (input[colon] !== ":") continue;

      output += `${input.slice(index + 1, keyStart)}"${input.slice(keyStart, keyEnd)}"`;
      index = boundary - 1;
      repairs.add("missing_object_key_quote");
    }
    input = output;
  }

  let output = "";
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let lastString = "";
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (inString) {
      if (escaped) {
        output += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        output += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        output += char;
        inString = false;
        lastString = input.slice(stringStart, index + 1);
        continue;
      }
      const code = char.charCodeAt(0);
      if (code < 0x20) {
        output += ({ 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" } as Record<number, string>)[code]
          ?? `\\u${code.toString(16).padStart(4, "0")}`;
        repairs.add("raw_control_character");
        continue;
      }
      output += char;
      continue;
    }
    if (char === '"') {
      output += char;
      inString = true;
      stringStart = index;
      continue;
    }
    // confidence is a numeric field in the model contract. Remove only a
    // dangling quote after a complete numeric literal at that value boundary.
    // Quoted numbers, prose, unknown fields and malformed numbers stay intact;
    // the ordinary schema still checks type and range after syntax recovery.
    if (char === ":" && lastString === '"confidence"') {
      const value = input.slice(index + 1).match(/^(\s*-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)"(?=\s*[,}\]])/);
      if (value) {
        output += `:${value[1]}`;
        index += value[0].length;
        repairs.add("trailing_confidence_quote");
        lastString = "";
        continue;
      }
    }
    if (char === ",") {
      let next = index + 1;
      while (next < input.length && /[ \t\r\n]/.test(input[next] ?? "")) next += 1;
      if (input[next] === "}" || input[next] === "]") {
        repairs.add("trailing_comma");
        continue;
      }
    }
    output += char;
  }
  return { text: output, repairs: [...repairs] };
}

/** Parses one model-produced JSON object and only repairs unambiguous JSON syntax defects. */
export function parseStructuredModelJson(text: string): StructuredJsonParseResult {
  const candidate = structuredJsonCandidate(text);
  try {
    return { value: JSON.parse(candidate), repaired: false, repairs: [] };
  } catch (strictError) {
    const repaired = repairStructuredJsonCandidate(candidate);
    if (repaired.repairs.length === 0) throw strictError;
    return { value: JSON.parse(repaired.text), repaired: true, repairs: repaired.repairs };
  }
}
