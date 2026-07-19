/**
 * Benchmark categories
 */
export enum BenchmarkCategory {
  Quantitative = "quantitative",
  FormalVerification = "formal-verification",
  BusinessStrategy = "business-strategy",
}

/**
 * Benchmark identifier
 * Dynamic string type - benchmarks are discovered from prompt directory
 */
export type BenchmarkId = string;

/**
 * Benchmark metadata
 */
export interface BenchmarkMetadata {
  id: BenchmarkId;
  category: BenchmarkCategory;
  title: string;
  description: string;
}

/**
 * Benchmark prompt with content
 */
export interface Benchmark extends BenchmarkMetadata {
  content: string;
}

/**
 * Benchmark result from a model
 */
export interface BenchmarkResult {
  benchmarkId: BenchmarkId;
  model: string;
  timestamp: Date;
  prompt: string;
  response: string;
  metadata: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    latencyMs?: number;
  };
}

/**
 * Canonical, backend-independent benchmark run record.
 *
 * This is the reproducible JSON artifact: it captures the exact messages,
 * sampling parameters, seed, response, usage, runtime provenance, and enough
 * identity fields to reproduce and audit a run. Markdown reports are derived
 * from this record — never the other way around.
 */
export const BENCHMARK_RECORD_SCHEMA_VERSION = 1;

export interface BenchmarkRunRecord {
  schemaVersion: number;

  benchmark: {
    id: BenchmarkId;
    /** Content hash of the exact prompt file used. */
    contentHash: string;
    version?: string;
  };

  /** Benchmark target ID (deployment + logical model binding). */
  targetId: string;
  /** Backend identity. */
  backendId: string;
  /** Backend type discriminator, e.g. "openrouter" | "openai-compatible". */
  backendType: string;
  /** Logical model identity (what is being studied). */
  model: string;
  /** Concrete served model name requested from the backend. */
  servedModelName: string;

  /** Prompt profile id used to render the messages. */
  promptProfile: string;
  /** Exact rendered messages that were sent to the backend. */
  messages: import("./inference.js").ChatMessage[];
  /** Sampling parameters actually used. */
  sampling: import("./inference.js").SamplingConfig;
  /** Deterministic seed, when set. */
  seed?: number;

  timestamp: string;
  /** Plinius commit SHA, when discoverable. */
  pliniusCommit?: string;

  /** Present on success. */
  response?: {
    text: string;
    finishReason?: string;
    usage?: import("./inference.js").TokenUsage;
    latencyMs: number;
    providerRequestId?: string;
    rawMetadata?: Record<string, unknown>;
  };

  /** Runtime provenance for the deployment (credentials excluded). */
  provenance?: import("./provenance.js").BackendProvenance;

  /** Present on failure instead of `response`. */
  error?: {
    kind?: string;
    message: string;
    status?: number;
  };
}

/**
 * Benchmark evaluation scores
 */
export interface BenchmarkScore {
  benchmarkId: BenchmarkId;
  model: string;
  scores: {
    structure: number; // 0-5
    reasoning: number; // 0-5
    consistency: number; // 0-5
    creativity: number; // 0-5
    domainAccuracy: number; // 0-5
  };
  totalScore: number; // 0-25
  notes?: string;
}

/**
 * Infer category from benchmark ID prefix
 * Convention: A=Quantitative, B=FormalVerification, C=BusinessStrategy
 * Can be extended for custom categories
 */
export function inferCategory(benchmarkId: string): BenchmarkCategory {
  const prefix = benchmarkId.charAt(0).toUpperCase();
  switch (prefix) {
    case "A":
      return BenchmarkCategory.Quantitative;
    case "B":
      return BenchmarkCategory.FormalVerification;
    case "C":
      return BenchmarkCategory.BusinessStrategy;
    default:
      // Default to Quantitative for unknown prefixes
      return BenchmarkCategory.Quantitative;
  }
}

/**
 * Create metadata for a discovered benchmark
 */
export function createBenchmarkMetadata(benchmarkId: string): BenchmarkMetadata {
  return {
    id: benchmarkId,
    category: inferCategory(benchmarkId),
    title: benchmarkId, // Can be extracted from prompt file if needed
    description: `Benchmark ${benchmarkId}`,
  };
}
