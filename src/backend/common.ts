/**
 * Shared helpers for adapters built on the existing {@link InferenceBackend}
 * (OpenRouter SDK and OpenAI-compatible HTTP). Keeps request/response mapping in
 * one place so vendor details never leak into the Execution Backend contract.
 */
import { InferenceRequest, InferenceResponse, SamplingConfig } from "../types/inference.js";
import {
  ExecutionProvenance,
  ExecutionRequest,
  ExecutionResult,
  RuntimeMetrics,
  CostEstimate,
  emptyRuntimeMetrics,
} from "./types.js";

/** Map a common ExecutionRequest to the legacy InferenceRequest. */
export function toInferenceRequest(request: ExecutionRequest): InferenceRequest {
  const s = request.sampling ?? {};
  const extraParams: Record<string, unknown> = {};
  if (s.topK !== undefined) extraParams.top_k = s.topK;
  if (s.minP !== undefined) extraParams.min_p = s.minP;
  if (request.reasoning?.enabled) {
    const reasoning: Record<string, unknown> = {};
    if (request.reasoning.effort) reasoning.effort = request.reasoning.effort;
    if (request.reasoning.maxTokens !== undefined) reasoning.max_tokens = request.reasoning.maxTokens;
    if (request.reasoning.exclude !== undefined) reasoning.exclude = request.reasoning.exclude;
    extraParams.reasoning = reasoning;
  }
  const sampling: SamplingConfig = {
    maxTokens: s.maxTokens ?? 1024,
    temperature: s.temperature ?? 0,
    topP: s.topP ?? 1,
    seed: s.seed,
    extraParams: Object.keys(extraParams).length > 0 ? extraParams : undefined,
  };
  return { model: request.model, messages: request.messages, sampling, timeoutMs: request.timeoutMs };
}

/** Extract runtime metrics from an InferenceResponse. */
export function metricsFromResponse(response: InferenceResponse): RuntimeMetrics {
  const metrics = emptyRuntimeMetrics();
  metrics.latencyMs = response.latencyMs ?? null;
  const usage = response.usage;
  if (usage) {
    metrics.promptTokens = usage.promptTokens ?? null;
    metrics.completionTokens = usage.completionTokens ?? null;
    metrics.totalTokens = usage.totalTokens ?? null;
    if (typeof usage.completionTokens === "number" && response.latencyMs && response.latencyMs > 0) {
      metrics.generationTps = usage.completionTokens / (response.latencyMs / 1000);
    }
  }
  return metrics;
}

export interface BuildResultOptions {
  backendName: string;
  endpoint: string | null;
  request: ExecutionRequest;
  response: InferenceResponse;
  cost: CostEstimate;
  /** Backend-specific provenance (e.g. vLLM hardware). Null when unavailable. */
  backendMetadata?: Record<string, unknown> | null;
}

export function buildExecutionResult(options: BuildResultOptions): ExecutionResult {
  const { response, request } = options;
  const provenance: ExecutionProvenance = {
    backend: options.backendName,
    endpoint: options.endpoint,
    model: request.model,
    created: null,
    requestId: response.providerRequestId ?? null,
    seed: request.sampling?.seed ?? null,
    sampling: request.sampling ? { ...request.sampling } : null,
    finishReason: response.finishReason ?? null,
    usage: response.usage ? { ...response.usage } : null,
    backendMetadata: options.backendMetadata ?? null,
  };
  return {
    text: response.text,
    finishReason: response.finishReason ?? null,
    metrics: metricsFromResponse(response),
    provenance,
    cost: options.cost,
    raw: response.rawMetadata ?? null,
  };
}
