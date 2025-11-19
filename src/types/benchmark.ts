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
 */
export type BenchmarkId = "A1" | "A2" | "A3" | "B1" | "B2" | "B3" | "C1" | "C2" | "C3";

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
 * All benchmark metadata
 */
export const BENCHMARKS_METADATA: Record<BenchmarkId, BenchmarkMetadata> = {
  A1: {
    id: "A1",
    category: BenchmarkCategory.Quantitative,
    title: "Abstract Market Generation Model Estimation",
    description:
      "Infer stochastic processes from synthetic market data with regime changes",
  },
  A2: {
    id: "A2",
    category: BenchmarkCategory.Quantitative,
    title: "Constrained Alpha Construction",
    description:
      "Design market-neutral alpha signals with turnover and drawdown constraints",
  },
  A3: {
    id: "A3",
    category: BenchmarkCategory.Quantitative,
    title: "Portfolio Risk Decomposition with Dummy Covariance",
    description:
      "Decompose multi-asset portfolio risk into factor and idiosyncratic components",
  },
  B1: {
    id: "B1",
    category: BenchmarkCategory.FormalVerification,
    title: "Monad Laws Proof Structure Design",
    description: "Design Coq typeclass and proof structure for monad laws",
  },
  B2: {
    id: "B2",
    category: BenchmarkCategory.FormalVerification,
    title: "F* Dijkstra Monad for Non-Interference",
    description:
      "Model and prove non-interference property using F* Dijkstra monads",
  },
  B3: {
    id: "B3",
    category: BenchmarkCategory.FormalVerification,
    title: "Type-Level Secret Key Logging Prevention",
    description:
      "Design type system to prevent secret keys from appearing in log messages",
  },
  C1: {
    id: "C1",
    category: BenchmarkCategory.BusinessStrategy,
    title: "Decision Tree Under Uncertainty",
    description:
      "Build decision tree for product launch with market and regulatory uncertainties",
  },
  C2: {
    id: "C2",
    category: BenchmarkCategory.BusinessStrategy,
    title: "Causal Modeling of Business Metrics",
    description: "Model SaaS metrics causally and evaluate strategic levers",
  },
  C3: {
    id: "C3",
    category: BenchmarkCategory.BusinessStrategy,
    title: "Strategic Analysis Through Abstraction and Reduction",
    description:
      'Transform vague complaint "engineering is slow" into structured analysis',
  },
};
