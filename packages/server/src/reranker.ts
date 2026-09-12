export interface RerankDocument {
  id: string;
  text: string;
}

export interface RerankScore {
  id: string;
  score: number;
}

export interface RerankResult {
  model: string;
  scores: RerankScore[];
  elapsedMs: number;
}

export interface EvidenceReranker {
  readonly ready: boolean;
  readonly status: { configured: boolean; ready: boolean; model: string; timeoutMs: number };
  rerank(query: string, documents: RerankDocument[]): Promise<RerankResult>;
}

export class RerankerUnavailableError extends Error {
  constructor(message: string, readonly kind: "not_configured" | "timeout" | "provider_error" | "invalid_response") {
    super(message);
    this.name = "RerankerUnavailableError";
  }
}

export interface VoyageRerankerOptions {
  apiKey: () => string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** A discriminative evidence gate for MCP. It is deliberately independent of
 * the contextual embedding service used by automatic injection. */
export class VoyageReranker implements EvidenceReranker {
  readonly #apiKey: () => string;
  readonly #endpoint: string;
  readonly #model: string;
  #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: VoyageRerankerOptions) {
    this.#apiKey = options.apiKey;
    this.#endpoint = options.endpoint ?? "https://api.voyageai.com/v1/rerank";
    this.#model = options.model ?? "rerank-3";
    this.#timeoutMs = options.timeoutMs ?? 45_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  setTimeoutMs(value: number): void {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid reranker timeout");
    this.#timeoutMs = value;
  }

  get ready(): boolean { return Boolean(this.#apiKey()); }

  get status() {
    return { configured: Boolean(this.#apiKey()), ready: this.ready, model: this.#model, timeoutMs: this.#timeoutMs };
  }

  async rerank(query: string, documents: RerankDocument[]): Promise<RerankResult> {
    if (!documents.length) return { model: this.#model, scores: [], elapsedMs: 0 };
    const apiKey = this.#apiKey();
    if (!apiKey) throw new RerankerUnavailableError("Voyage reranker key is not configured", "not_configured");
    const started = performance.now();
    const controller = new AbortController();
    const timeoutMs = this.#timeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.#model, query, documents: documents.map(document => document.text), top_k: documents.length, truncation: true }),
        signal: controller.signal,
      });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 240);
      throw new RerankerUnavailableError(`Voyage reranker returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`, "provider_error");
    }
    const body = await response.json().catch(() => undefined) as { data?: Array<{ index?: unknown; relevance_score?: unknown }> } | undefined;
    if (controller.signal.aborted) throw new Error("Reranker response deadline exceeded");
    if (!Array.isArray(body?.data)) throw new RerankerUnavailableError("Voyage reranker returned an invalid response", "invalid_response");
    const scores = body.data.flatMap(row => {
      const index = Number(row.index);
      const score = Number(row.relevance_score);
      return Number.isInteger(index) && index >= 0 && index < documents.length && Number.isFinite(score)
        ? [{ id: documents[index]!.id, score }] : [];
    });
    if (!scores.length) throw new RerankerUnavailableError("Voyage reranker returned no document scores", "invalid_response");
    return { model: this.#model, scores, elapsedMs: performance.now() - started };
    } catch (error) {
      if (controller.signal.aborted) throw new RerankerUnavailableError(`Voyage reranker timed out after ${timeoutMs}ms`, "timeout");
      if (error instanceof RerankerUnavailableError) throw error;
      throw new RerankerUnavailableError(`Voyage reranker request failed: ${error instanceof Error ? error.message : String(error)}`, "provider_error");
    } finally {
      clearTimeout(timeout);
    }
  }
}
