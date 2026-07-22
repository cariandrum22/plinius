/**
 * vLLM Execution Backend (OpenAI-compatible API).
 *
 * Targets only the OpenAI-compatible surface: `GET /v1/models`,
 * `POST /v1/chat/completions`, `POST /v1/completions`. vLLM-specific concepts
 * (GPU, tensor/pipeline parallel, KV cache, FlashAttention, quantization) are
 * NEVER first-class fields — they belong in `backendMetadata`, and are `null`
 * whenever they cannot actually be observed. Nothing is guessed.
 */
import { InferenceBackend, InferenceError } from "../../types/inference.js";
import { OpenAICompatibleBackend } from "../../backends/openai-compatible.js";
import { FetchFn } from "../../catalog/client.js";
import { ExecutionBackend } from "../interface.js";
import { BackendCapabilities, buildCapabilities } from "../capabilities.js";
import { BackendError, kindFromStatus } from "../errors.js";
import {
  BackendMetadata,
  CostEstimate,
  ExecutionProvenance,
  ExecutionRequest,
  ExecutionResult,
  HealthResult,
  ModelDescriptor,
  ResolveResult,
  StreamChunk,
} from "../types.js";
import { buildExecutionResult, toInferenceRequest } from "../common.js";

export interface VllmBackendOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: FetchFn;
  inferenceBackend?: InferenceBackend;
  now?: () => string;
}

const BACKEND_NAME = "vllm";
const BACKEND_VERSION = "1.0.0";

interface RawVllmModel {
  id: string;
  owned_by?: string;
  permission?: unknown[];
  max_model_len?: number;
}

export class VllmExecutionBackend implements ExecutionBackend {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: FetchFn;
  private readonly inference: InferenceBackend;
  private readonly now: () => string;

  constructor(options: VllmBackendOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:8000/v1").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.inference =
      options.inferenceBackend ??
      new OpenAICompatibleBackend({ id: BACKEND_NAME, baseUrl: this.baseUrl, apiKey: options.apiKey, fetchFn: options.fetchFn });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  name(): string {
    return BACKEND_NAME;
  }
  version(): string {
    return BACKEND_VERSION;
  }
  metadata(): BackendMetadata {
    return { backendName: BACKEND_NAME, backendVersion: BACKEND_VERSION, vendor: "vLLM", apiVersion: "v1" };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async listRawModels(): Promise<RawVllmModel[]> {
    const res = await this.fetchFn(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) {
      throw new BackendError(kindFromStatus(res.status), `vLLM /models failed: ${res.status}`, { backend: BACKEND_NAME, status: res.status });
    }
    const json = (await res.json()) as { data?: RawVllmModel[] };
    return json.data ?? [];
  }

  async discoverModels(): Promise<ModelDescriptor[]> {
    const models = await this.listRawModels();
    return models.map((m) => ({
      id: m.id,
      canonicalSlug: m.id, // vLLM serves canonical ids only; no aliases
      ownedBy: m.owned_by ?? null,
      contextLength: typeof m.max_model_len === "number" ? m.max_model_len : null,
      backendMetadata: { owned_by: m.owned_by ?? null, permission: m.permission ?? null },
    }));
  }

  /** vLLM has no aliases — a model resolves to itself if it is served. */
  async resolveModel(requestedModel: string): Promise<ResolveResult> {
    const models = await this.listRawModels();
    const found = models.some((m) => m.id === requestedModel);
    return {
      requestedModel,
      resolvedModel: found ? requestedModel : null,
      found,
      isAlias: false,
      warnings: found ? [] : [`model "${requestedModel}" is not served by this vLLM instance`],
    };
  }

  async capabilities(model?: string): Promise<BackendCapabilities> {
    // Only facts the OpenAI-compatible contract guarantees are marked supported.
    // Everything else is unknown (never guessed).
    let maxContextLength: number | null = null;
    if (model) {
      const models = await this.listRawModels();
      const m = models.find((x) => x.id === model);
      maxContextLength = typeof m?.max_model_len === "number" ? m.max_model_len : null;
    }
    return buildCapabilities(
      { chat: "supported", completion: "supported", streaming: "supported" },
      { maxContextLength, maxOutputLength: null },
    );
  }

  async estimateCost(): Promise<CostEstimate> {
    // Local execution: no monetary cost by default.
    return { costModel: "FREE", estimatedUsd: 0 };
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    let response;
    try {
      response = await this.inference.complete(toInferenceRequest(request));
    } catch (error) {
      throw toBackendError(error);
    }
    const cost = await this.estimateCost();
    // Hardware provenance is not exposed by the OpenAI-compatible API → null.
    return buildExecutionResult({
      backendName: BACKEND_NAME,
      endpoint: this.baseUrl,
      request,
      response,
      cost,
      backendMetadata: null,
    });
  }

  async *stream(request: ExecutionRequest): AsyncIterable<StreamChunk> {
    const result = await this.execute(request);
    yield { delta: result.text, done: true };
  }

  /** No generation-lookup endpoint in the OpenAI-compatible API. */
  async provenance(): Promise<ExecutionProvenance | null> {
    return null;
  }

  async health(): Promise<HealthResult> {
    const checks = [];
    let ok = false;
    try {
      const models = await this.listRawModels();
      ok = true;
      checks.push({ name: "api-connection", ok: true, detail: `${this.baseUrl} reachable` });
      checks.push({ name: "models-endpoint", ok: models.length > 0, detail: `${models.length} model(s) served` });
    } catch (error) {
      checks.push({ name: "api-connection", ok: false, detail: error instanceof Error ? error.message : String(error) });
      checks.push({ name: "models-endpoint", ok: false, detail: "unreachable" });
    }
    return { backend: BACKEND_NAME, healthy: ok && checks.every((c) => c.ok), checks, checkedAt: this.now() };
  }
}

function toBackendError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof InferenceError) {
    const kind = error.kind === "http" && error.status ? kindFromStatus(error.status) : error.kind === "timeout" ? "timeout" : error.kind === "network" ? "network" : "unknown";
    return new BackendError(kind, error.message, { backend: BACKEND_NAME, status: error.status, cause: error });
  }
  return new BackendError("unknown", error instanceof Error ? error.message : String(error), { backend: BACKEND_NAME, cause: error });
}
