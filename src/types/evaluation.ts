import { BenchmarkId } from "./benchmark.js";
import { OpenRouterModel } from "./openrouter.js";

/**
 * Evaluation criteria based on the rubric
 */
export interface EvaluationScores {
  structure: number; // 0-5: Organization and logical flow
  depth: number; // 0-5: Depth of reasoning and insights
  consistency: number; // 0-5: Internal consistency and coherence
  creativity: number; // 0-5: Creativity and concreteness
  domainCorrectness: number; // 0-5: Domain-specific correctness
}

/**
 * Detailed evaluation result
 */
export interface EvaluationResult {
  benchmarkId: BenchmarkId;
  model: OpenRouterModel;
  evaluatedBy: OpenRouterModel; // The model that performed evaluation (e.g., GPT-5.1)
  timestamp: Date;
  scores: EvaluationScores;
  totalScore: number; // Sum of all scores (max 25)
  commentary: string; // Detailed evaluation commentary
  metadata: {
    evaluationLatencyMs?: number;
    evaluationTokens?: number;
  };
}

/**
 * Progress tracking for evaluation
 */
export interface EvaluationProgress {
  completed: Array<{
    benchmarkId: BenchmarkId;
    model: string;
    evaluatedBy?: string; // Added for multi-evaluator support
    evaluationFile: string;
  }>;
  failed: Array<{
    benchmarkId: BenchmarkId;
    model: string;
    evaluatedBy?: string; // Added for multi-evaluator support
    error: string;
  }>;
  lastUpdate: string;
}

/**
 * Task to be evaluated
 */
export interface EvaluationTask {
  benchmarkId: BenchmarkId;
  model: OpenRouterModel;
  resultFilePath: string;
}

/**
 * Parsed benchmark result from markdown file
 */
export interface ParsedBenchmarkResult {
  benchmarkId: BenchmarkId;
  model: OpenRouterModel;
  prompt: string;
  response: string;
  metadata: {
    timestamp: string;
    latency: string;
    tokens: string;
  };
}
