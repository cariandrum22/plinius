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
