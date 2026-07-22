/**
 * Backend-independent inference abstraction.
 *
 * These types are domain-owned: no OpenRouter SDK or OpenAI SDK types are
 * exposed here. Backend adapters translate to and from their vendor SDKs
 * internally and only ever return these domain types.
 */
import { BackendProvenance } from "./provenance.js";

/**
 * A single chat message in an inference request.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Sampling parameters shared across backends.
 *
 * `extraParams` carries backend-specific request fields (e.g. vLLM extensions)
 * without leaking vendor types into the domain model. It is passed through to
 * OpenAI-compatible backends verbatim.
 */
export interface SamplingConfig {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** Optional deterministic seed. Supported by OpenAI-compatible backends. */
  seed?: number;
  /** Optional additional request parameters merged into the request body. */
  extraParams?: Record<string, unknown>;
}

/**
 * A backend-independent inference request.
 */
export interface InferenceRequest {
  /** The concrete model name the backend should serve (served model name). */
  model: string;
  messages: ChatMessage[];
  sampling: SamplingConfig;
  timeoutMs?: number;
}

/**
 * Normalized token usage metadata.
 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * A backend-independent inference response.
 */
export interface InferenceResponse {
  text: string;
  finishReason?: string;
  usage?: TokenUsage;
  latencyMs: number;
  providerRequestId?: string;
  rawMetadata?: Record<string, unknown>;
}

/**
 * An inference backend adapter. Each concrete deployment (OpenRouter, a vLLM
 * server, Ollama, ...) is represented by an implementation of this interface.
 */
export interface InferenceBackend {
  /** Stable backend identity (matches the backend key in configuration). */
  readonly id: string;

  /** Backend type discriminator, e.g. "openrouter" | "openai-compatible". */
  readonly type: string;

  complete(request: InferenceRequest): Promise<InferenceResponse>;

  /**
   * Optionally report runtime provenance for the deployment. Implementations
   * must never include credentials. May return partial provenance with missing
   * fields marked rather than throwing.
   */
  inspect?(): Promise<BackendProvenance>;
}

/**
 * Classification of normalized inference errors.
 */
export type InferenceErrorKind =
  | "timeout"
  | "http"
  | "network"
  | "invalid_response"
  | "unknown";

/**
 * Normalized error raised by every backend adapter, so callers never have to
 * reason about vendor-specific error shapes.
 */
export class InferenceError extends Error {
  readonly kind: InferenceErrorKind;
  /** HTTP status code when the failure is an HTTP error. */
  readonly status?: number;
  /** Backend id that produced the error, when known. */
  readonly backendId?: string;
  readonly cause?: unknown;

  constructor(
    kind: InferenceErrorKind,
    message: string,
    options: { status?: number; backendId?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "InferenceError";
    this.kind = kind;
    this.status = options.status;
    this.backendId = options.backendId;
    this.cause = options.cause;
  }
}
