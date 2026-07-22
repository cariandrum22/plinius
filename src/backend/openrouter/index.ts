/**
 * OpenRouter Execution Backend.
 *
 * Wraps the existing OpenRouter pieces (catalog client, inference SDK adapter,
 * generation provenance, pricing) behind the common Execution Backend contract.
 * The public CLI behavior is unchanged; only the internal wiring moves here.
 */
import { InferenceBackend, InferenceError } from "../../types/inference.js";
import { OpenRouterBackend as OpenRouterInference } from "../../backends/openrouter.js";
import { OpenRouterCatalogClient, FetchFn } from "../../catalog/client.js";
import { CatalogSnapshot, NormalizedModel } from "../../catalog/schema.js";
import { buildSnapshot, findModel } from "../../catalog/snapshot.js";
import { resolveModel as catalogResolve } from "../../catalog/resolve.js";
import { estimateListCost } from "../../campaign/cost.js";
import { GenerationClient } from "../../provenance/generation.js";
import { ExecutionBackend } from "../interface.js";
import { BackendCapabilities, buildCapabilities, capabilitiesFromSupportedParameters } from "../capabilities.js";
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

export interface OpenRouterBackendOptions {
  apiKey?: string;
  catalogClient?: OpenRouterCatalogClient;
  inferenceBackend?: InferenceBackend;
  generationClient?: GenerationClient;
  fetchFn?: FetchFn;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

const BACKEND_NAME = "openrouter";
const BACKEND_VERSION = "1.0.0";
const ENDPOINT = "https://openrouter.ai/api/v1";

export class OpenRouterExecutionBackend implements ExecutionBackend {
  private readonly apiKey?: string;
  private readonly catalog: OpenRouterCatalogClient;
  private readonly inference: InferenceBackend;
  private readonly generation: GenerationClient;
  private readonly now: () => string;
  private snapshotCache?: Promise<CatalogSnapshot>;

  constructor(options: OpenRouterBackendOptions = {}) {
    this.apiKey = options.apiKey;
    this.catalog = options.catalogClient ?? new OpenRouterCatalogClient({ apiKey: options.apiKey, fetchFn: options.fetchFn });
    this.inference = options.inferenceBackend ?? new OpenRouterInference({ id: BACKEND_NAME, apiKey: options.apiKey });
    this.generation = options.generationClient ?? new GenerationClient({ apiKey: options.apiKey, fetchFn: options.fetchFn });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  name(): string {
    return BACKEND_NAME;
  }
  version(): string {
    return BACKEND_VERSION;
  }
  metadata(): BackendMetadata {
    return { backendName: BACKEND_NAME, backendVersion: BACKEND_VERSION, vendor: "OpenRouter", apiVersion: "v1" };
  }

  private async snapshot(): Promise<CatalogSnapshot> {
    if (!this.snapshotCache) {
      this.snapshotCache = (async () => {
        const models = await this.catalog.getModels();
        return buildSnapshot({ rawModels: models, fetchedAt: this.now(), source: "live" });
      })();
    }
    return this.snapshotCache;
  }

  async discoverModels(): Promise<ModelDescriptor[]> {
    const snapshot = await this.snapshot();
    return snapshot.models.map((m) => ({
      id: m.id,
      canonicalSlug: m.canonicalSlug,
      ownedBy: m.author || null,
      contextLength: m.contextLength,
      backendMetadata: { supportedParameters: m.supportedParameters, pricing: m.pricing, moderated: m.moderated },
    }));
  }

  async resolveModel(requestedModel: string): Promise<ResolveResult> {
    const snapshot = await this.snapshot();
    const r = catalogResolve(requestedModel, snapshot, this.now());
    return {
      requestedModel,
      resolvedModel: r.resolvedSlug,
      found: r.found,
      isAlias: r.isAlias,
      warnings: r.warnings,
    };
  }

  async capabilities(model?: string): Promise<BackendCapabilities> {
    let normalized: NormalizedModel | undefined;
    if (model) {
      const snapshot = await this.snapshot();
      normalized = findModel(snapshot, model);
    }
    const overrides = normalized
      ? capabilitiesFromSupportedParameters(normalized.supportedParameters)
      : {};
    return buildCapabilities(
      { chat: "supported", completion: "supported", streaming: "supported", ...overrides },
      { maxContextLength: normalized?.contextLength ?? null, maxOutputLength: normalized?.pricing.maxCompletionTokens ?? null },
    );
  }

  async estimateCost(
    request: ExecutionRequest,
    usage?: { promptTokens: number; completionTokens: number },
  ): Promise<CostEstimate> {
    const snapshot = await this.snapshot();
    const model = findModel(snapshot, request.model);
    if (!model || !usage) return { costModel: "METERED", estimatedUsd: null };
    const estimatedUsd = estimateListCost(
      { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, reasoningTokens: 0, cachedTokens: 0, nativeTokens: usage.promptTokens + usage.completionTokens },
      model.pricing,
    );
    return { costModel: "METERED", estimatedUsd };
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    let response;
    try {
      response = await this.inference.complete(toInferenceRequest(request));
    } catch (error) {
      throw toBackendError(error);
    }
    const usage = response.usage
      ? { promptTokens: response.usage.promptTokens ?? 0, completionTokens: response.usage.completionTokens ?? 0 }
      : undefined;
    const cost = await this.estimateCost(request, usage);
    return buildExecutionResult({ backendName: BACKEND_NAME, endpoint: ENDPOINT, request, response, cost });
  }

  async *stream(request: ExecutionRequest): AsyncIterable<StreamChunk> {
    // Minimal streaming: execute then emit as a single final chunk.
    const result = await this.execute(request);
    yield { delta: result.text, done: true };
  }

  async provenance(generationId?: string): Promise<ExecutionProvenance | null> {
    if (!generationId) return null;
    const p = await this.generation.getProvenance(generationId);
    return {
      backend: BACKEND_NAME,
      endpoint: ENDPOINT,
      model: p.model,
      created: p.createdAt,
      requestId: p.generationId,
      seed: null,
      sampling: null,
      finishReason: null,
      usage: p.pricing ? { totalCostUsd: p.pricing.totalCostUsd } : null,
      backendMetadata: p.providerMetadata,
    };
  }

  async health(): Promise<HealthResult> {
    const checks = [];
    let apiOk = false;
    try {
      await this.catalog.getModels();
      apiOk = true;
      checks.push({ name: "api-connection", ok: true, detail: `${ENDPOINT} reachable` });
    } catch (error) {
      checks.push({ name: "api-connection", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    const authOk = !!this.apiKey;
    checks.push({ name: "auth", ok: authOk, detail: authOk ? "API key present" : "no API key (generation will fail)" });
    return { backend: BACKEND_NAME, healthy: apiOk && authOk, checks, checkedAt: this.now() };
  }
}

function toBackendError(error: unknown): BackendError {
  if (error instanceof InferenceError) {
    let kind: import("../errors.js").BackendErrorKind;
    switch (error.kind) {
      case "http":
        kind = error.status ? kindFromStatus(error.status) : "unavailable";
        break;
      case "timeout":
        kind = "timeout";
        break;
      case "network":
        kind = "network";
        break;
      case "invalid_response":
        kind = "invalid_response";
        break;
      default:
        kind = "unknown";
    }
    return new BackendError(kind, error.message, { backend: BACKEND_NAME, status: error.status, cause: error });
  }
  return new BackendError("unknown", error instanceof Error ? error.message : String(error), { backend: BACKEND_NAME, cause: error });
}
