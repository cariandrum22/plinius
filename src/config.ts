/**
 * Plinius Configuration
 *
 * Central configuration for benchmark execution and evaluation.
 * Modify these settings to customize your benchmark runs.
 */
import { readdir } from "fs/promises";
import { join, basename } from "path";
import { OpenRouterModels, OpenRouterModel } from "./types/openrouter.js";

/**
 * Benchmark execution configuration
 */
export interface BenchmarkConfig {
  maxTokens: number;
  temperature: number;
  topP: number;
}

/**
 * Cost estimation configuration
 */
export interface CostConfig {
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  costPerMillionPromptTokens: number;
  costPerMillionCompletionTokens: number;
}

/**
 * Default benchmark execution configuration
 */
export const defaultBenchmarkConfig: BenchmarkConfig = {
  maxTokens: 16000,
  temperature: 0.1,
  topP: 0.95,
};

/**
 * Default cost estimation configuration
 */
export const defaultCostConfig: CostConfig = {
  estimatedPromptTokens: 2000,
  estimatedCompletionTokens: 12000,
  costPerMillionPromptTokens: 2.0,
  costPerMillionCompletionTokens: 6.0,
};

/**
 * Models to benchmark
 * Add or remove models as needed
 */
export const BENCHMARK_MODELS: OpenRouterModel[] = [
  OpenRouterModels.GPT_5_1,
  OpenRouterModels.CLAUDE_4_5_HAIKU,
  OpenRouterModels.GEMINI_2_5_PRO,
  OpenRouterModels.LLAMA_4_MAVERIC,
  OpenRouterModels.MISTRAL_MEDIUM_3_1,
  OpenRouterModels.DEEPSEEK_R1_0528,
  OpenRouterModels.GROK_4,
  OpenRouterModels.KIMI_K2_THINKING,
  OpenRouterModels.QWEN_3_MAX,
  OpenRouterModels.MINIMAX_M2,
  OpenRouterModels.PHI_4_REASONING_PLUS,
  OpenRouterModels.MAI_DS_R1,
];

/**
 * Models to use as evaluators
 * These models will evaluate the benchmark responses
 */
export const EVALUATOR_MODELS: OpenRouterModel[] = [
  OpenRouterModels.GPT_5_1,
  OpenRouterModels.CLAUDE_4_5_SONNET,
  OpenRouterModels.GEMINI_2_5_PRO,
];

/**
 * Get prompt directory path
 */
export function getPromptDir(): string {
  return join(process.cwd(), "benchmark", "prompt");
}

/**
 * Discover available benchmark IDs from prompt directory
 * Scans for .md files and extracts their names as benchmark IDs
 */
export async function discoverBenchmarkIds(): Promise<string[]> {
  const promptDir = getPromptDir();

  try {
    const files = await readdir(promptDir);
    const benchmarkIds = files
      .filter(file => file.endsWith(".md"))
      .map(file => basename(file, ".md"))
      .sort();

    return benchmarkIds;
  } catch (error) {
    console.error(`Error reading prompt directory: ${promptDir}`);
    return [];
  }
}

/**
 * Generate a short display name from a model ID
 * e.g., "openai/gpt-5.1" -> "gpt-5.1"
 * e.g., "anthropic/claude-sonnet-4.5" -> "claude-sonnet-4.5"
 */
export function getShortModelName(modelId: string): string {
  const parts = modelId.split("/");
  return parts.length > 1 ? parts[1] : modelId;
}

/**
 * Generate a display-friendly name from a model ID
 * e.g., "openai/gpt-5.1" -> "GPT-5.1"
 * e.g., "anthropic/claude-sonnet-4.5" -> "Claude-Sonnet-4.5"
 */
export function getDisplayModelName(modelId: string): string {
  const shortName = getShortModelName(modelId);
  return shortName
    .split("-")
    .map(part => {
      // Handle version numbers and special cases
      if (/^\d/.test(part) || part.length <= 2) {
        return part.toUpperCase();
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("-");
}

/**
 * Get company/provider from model ID
 * e.g., "openai/gpt-5.1" -> "openai"
 */
export function getModelProvider(modelId: string): string {
  const parts = modelId.split("/");
  return parts[0] || modelId;
}

/**
 * Sanitize model name for use in filenames
 */
export function sanitizeModelName(model: string): string {
  return model.replace(/\//g, "_").replace(/:/g, "-");
}

/**
 * Estimate cost for a given number of tasks
 */
export function estimateCost(
  totalTasks: number,
  costConfig: CostConfig = defaultCostConfig
) {
  const totalPromptTokens = totalTasks * costConfig.estimatedPromptTokens;
  const totalCompletionTokens = totalTasks * costConfig.estimatedCompletionTokens;
  const promptCost = (totalPromptTokens / 1_000_000) * costConfig.costPerMillionPromptTokens;
  const completionCost = (totalCompletionTokens / 1_000_000) * costConfig.costPerMillionCompletionTokens;
  const totalCost = promptCost + completionCost;

  return {
    totalPromptTokens,
    totalCompletionTokens,
    totalCost,
    costPerTask: totalCost / totalTasks,
  };
}
