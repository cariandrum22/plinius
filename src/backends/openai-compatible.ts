/**
 * Generic OpenAI-compatible chat completions backend.
 *
 * Works against any service exposing the OpenAI `/chat/completions` contract:
 * vLLM, Ollama, LM Studio, and others. vLLM is represented purely as a
 * configured instance of this class — there is intentionally no vLLM-specific
 * subclass.
 */
import {
  ChatMessage,
  InferenceBackend,
  InferenceError,
  InferenceRequest,
  InferenceResponse,
} from "../types/inference.js";
import {
  BackendProvenance,
  minimalProvenance,
  parseProvenance,
} from "../types/provenance.js";

/** Injectable fetch signature (matches the global `fetch`). */
export type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAICompatibleBackendConfig {
  /** Backend identity, matching its key in the experiment configuration. */
  id: string;
  /** Base URL including the API version segment, e.g. http://vllm:8000/v1. */
  baseUrl: string;
  /** Resolved API key (never persisted). Optional for unauthenticated servers. */
  apiKey?: string;
  /** URL of the machine-readable runtime-provenance JSON, if available. */
  provenanceUrl?: string;
  /** Default request timeout in milliseconds. */
  timeoutMs?: number;
  /** Additional request parameters merged into every request body. */
  extraParams?: Record<string, unknown>;
  /** Injectable fetch, for testing. Defaults to global fetch. */
  fetchFn?: FetchFn;
}

const DEFAULT_TIMEOUT_MS = 120_000;

interface OpenAIChatChoice {
  index?: number;
  finish_reason?: string | null;
  message?: { role?: string; content?: string | null };
}

interface OpenAIChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices?: OpenAIChatChoice[];
  usage?: OpenAIChatUsage;
}

export class OpenAICompatibleBackend implements InferenceBackend {
  readonly id: string;
  readonly type = "openai-compatible";

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly provenanceUrl?: string;
  private readonly timeoutMs: number;
  private readonly extraParams: Record<string, unknown>;
  private readonly fetchFn: FetchFn;

  constructor(config: OpenAICompatibleBackendConfig) {
    this.id = config.id;
    // Normalize so joining with an endpoint path is unambiguous.
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.provenanceUrl = config.provenanceUrl;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraParams = config.extraParams ?? {};
    this.fetchFn = config.fetchFn ?? (globalThis.fetch as FetchFn);

    if (!this.fetchFn) {
      throw new Error(
        "No fetch implementation available; provide fetchFn in OpenAICompatibleBackendConfig",
      );
    }
  }

  /**
   * Serialize an {@link InferenceRequest} into an OpenAI chat completions body.
   * Exposed for testing request serialization.
   */
  buildRequestBody(request: InferenceRequest): Record<string, unknown> {
    const { sampling } = request;
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m: ChatMessage) => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
    };

    if (sampling.maxTokens !== undefined) body.max_tokens = sampling.maxTokens;
    if (sampling.temperature !== undefined)
      body.temperature = sampling.temperature;
    if (sampling.topP !== undefined) body.top_p = sampling.topP;
    if (sampling.seed !== undefined) body.seed = sampling.seed;

    // Backend-level extras first, then per-request extras (request wins).
    return { ...this.extraParams, ...body, ...(sampling.extraParams ?? {}) };
  }

  async complete(request: InferenceRequest): Promise<InferenceResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = this.buildRequestBody(request);
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startTime = Date.now();

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new InferenceError(
          "timeout",
          `Request to ${this.id} timed out after ${timeoutMs}ms`,
          { backendId: this.id, cause: error },
        );
      }
      throw new InferenceError(
        "network",
        `Network error calling ${this.id}: ${errorMessage(error)}`,
        { backendId: this.id, cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await safeReadText(res);
      throw new InferenceError(
        "http",
        `Backend ${this.id} returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
        { backendId: this.id, status: res.status },
      );
    }

    const latencyMs = Date.now() - startTime;

    let payload: OpenAIChatResponse;
    try {
      payload = (await res.json()) as OpenAIChatResponse;
    } catch (error) {
      throw new InferenceError(
        "invalid_response",
        `Backend ${this.id} returned non-JSON response: ${errorMessage(error)}`,
        { backendId: this.id, cause: error },
      );
    }

    return this.parseResponse(payload, latencyMs);
  }

  /**
   * Parse an OpenAI-compatible response payload into a domain response.
   * Exposed for testing response parsing and usage normalization.
   */
  parseResponse(
    payload: OpenAIChatResponse,
    latencyMs: number,
  ): InferenceResponse {
    const choice = payload.choices?.[0];
    if (!choice || typeof choice.message?.content !== "string") {
      throw new InferenceError(
        "invalid_response",
        `Backend ${this.id} returned no valid choice/content`,
        { backendId: this.id },
      );
    }

    const usage = payload.usage
      ? {
          promptTokens: payload.usage.prompt_tokens,
          completionTokens: payload.usage.completion_tokens,
          totalTokens: payload.usage.total_tokens,
        }
      : undefined;

    return {
      text: choice.message.content,
      finishReason: choice.finish_reason ?? undefined,
      usage,
      latencyMs,
      providerRequestId: payload.id,
      rawMetadata: { model: payload.model },
    };
  }

  async inspect(): Promise<BackendProvenance> {
    const capturedAt = new Date().toISOString();
    if (!this.provenanceUrl) {
      return minimalProvenance({
        backendType: this.type,
        backendUrl: this.baseUrl,
        capturedAt,
      });
    }

    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let raw: unknown = {};
    try {
      const res = await this.fetchFn(this.provenanceUrl, { headers });
      if (res.ok) {
        raw = await res.json();
      }
    } catch {
      // Provenance is best-effort: never fail a benchmark because it is
      // unavailable. Fields will simply be marked missing.
      raw = {};
    }

    return parseProvenance(raw, {
      backendType: this.type,
      backendUrl: this.baseUrl,
      capturedAt,
      keepRaw: true,
    });
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return "";
  }
}
