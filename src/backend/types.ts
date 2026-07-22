/**
 * Shared Execution Backend types.
 *
 * These types express only concepts common to ALL backends. Backend-specific
 * data (e.g. vLLM GPU / tensor-parallel / KV-cache details) is never a
 * first-class field here — it lives inside the opaque `backendMetadata`
 * extension field, so new backends can be added without changing this contract.
 */
import { ChatMessage } from "../types/inference.js";
import { BackendCapabilities } from "./capabilities.js";

export const EXECUTION_BACKEND_SCHEMA_VERSION = 1;

export interface BackendMetadata {
  backendName: string;
  backendVersion: string;
  vendor: string;
  apiVersion: string | null;
}

/** A model as discovered from a backend. */
export interface ModelDescriptor {
  id: string;
  canonicalSlug: string;
  ownedBy: string | null;
  contextLength: number | null;
  /** Backend-specific fields (permissions, quantization, ...). Opaque. */
  backendMetadata: Record<string, unknown> | null;
}

export interface ResolveResult {
  requestedModel: string;
  resolvedModel: string | null;
  found: boolean;
  isAlias: boolean;
  warnings: string[];
}

export interface BackendSampling {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  seed?: number;
  maxTokens?: number;
}

export interface BackendReasoning {
  enabled?: boolean;
  effort?: string;
  maxTokens?: number;
  exclude?: boolean;
}

export interface ExecutionRequest {
  model: string;
  messages: ChatMessage[];
  sampling?: BackendSampling;
  reasoning?: BackendReasoning;
  stream?: boolean;
  timeoutMs?: number;
}

export interface RuntimeMetrics {
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Prompt tokens processed per second. */
  promptTps: number | null;
  /** Generated tokens per second. */
  generationTps: number | null;
  queueTimeMs: number | null;
}

export function emptyRuntimeMetrics(): RuntimeMetrics {
  return {
    latencyMs: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    promptTps: null,
    generationTps: null,
    queueTimeMs: null,
  };
}

export interface ExecutionProvenance {
  backend: string;
  endpoint: string | null;
  model: string | null;
  created: string | null;
  requestId: string | null;
  seed: number | null;
  sampling: Record<string, unknown> | null;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
  /**
   * Backend-specific provenance (e.g. vLLM hardware: CUDA/driver/GPU/TP/PP/
   * quantization/KV-cache/FlashAttention). Null when unavailable — never guessed.
   */
  backendMetadata: Record<string, unknown> | null;
}

export type CostModel = "FREE" | "FIXED" | "METERED" | "UNKNOWN";

export interface CostEstimate {
  costModel: CostModel;
  estimatedUsd: number | null;
}

export interface ExecutionResult {
  text: string;
  finishReason: string | null;
  metrics: RuntimeMetrics;
  provenance: ExecutionProvenance;
  cost: CostEstimate;
  /** Raw backend response, for debugging/audit. */
  raw: unknown;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
}

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthResult {
  backend: string;
  healthy: boolean;
  checks: HealthCheck[];
  checkedAt: string;
}

/** Compact backend descriptor for manifests. */
export interface BackendManifestInfo {
  backend: string;
  backendVersion: string;
  vendor: string;
  apiVersion: string | null;
  capabilities: BackendCapabilities | null;
  health: { healthy: boolean; checkedAt: string } | null;
  costModel: CostModel;
}
