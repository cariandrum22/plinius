import { OpenRouter } from "@openrouter/sdk";
import {
  Benchmark,
  BenchmarkId,
  BenchmarkResult,
} from "../types/benchmark.js";
import { OpenRouterModel } from "../types/openrouter.js";
import { loadBenchmark, loadAllBenchmarks } from "./loader.js";

/**
 * Configuration for benchmark runner
 */
export interface BenchmarkRunnerConfig {
  apiKey: string;
  model: OpenRouterModel;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  useSystemPrompt?: boolean;
}

/**
 * Benchmark runner class
 */
export class BenchmarkRunner {
  private client: OpenRouter;
  private model: OpenRouterModel;
  private maxTokens: number;
  private temperature: number;
  private topP: number;
  private useSystemPrompt: boolean;

  constructor(config: BenchmarkRunnerConfig) {
    this.client = new OpenRouter({
      apiKey: config.apiKey,
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 16000;
    this.temperature = config.temperature ?? 0.1;
    this.topP = config.topP ?? 0.95;
    this.useSystemPrompt = config.useSystemPrompt ?? true;
  }

  /**
   * Run a single benchmark
   */
  async runBenchmark(benchmark: Benchmark): Promise<BenchmarkResult> {
    const startTime = Date.now();

    try {
      const messages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }> = [];

      if (this.useSystemPrompt) {
        messages.push({
          role: "system",
          content:
            "You are an expert reasoning system designed to demonstrate maximum analytical capability. " +
            "Show all intermediate steps, underlying assumptions, and alternative approaches. " +
            "Prioritize thoroughness, correctness, and depth of reasoning over brevity. " +
            "Use structured thinking: break down complex problems, consider edge cases, " +
            "and provide rigorous justification for your conclusions.",
        });
      }

      messages.push({
        role: "user",
        content: benchmark.content,
      });

      const completion = await this.client.chat.send({
        model: this.model,
        messages,
        maxTokens: this.maxTokens,
        temperature: this.temperature,
        topP: this.topP,
      });

      const endTime = Date.now();
      const response =
        typeof completion.choices[0].message.content === "string"
          ? completion.choices[0].message.content
          : "";

      return {
        benchmarkId: benchmark.id,
        model: this.model,
        timestamp: new Date(),
        prompt: benchmark.content,
        response,
        metadata: {
          promptTokens: completion.usage?.promptTokens,
          completionTokens: completion.usage?.completionTokens,
          totalTokens: completion.usage?.totalTokens,
          latencyMs: endTime - startTime,
        },
      };
    } catch (error) {
      throw new Error(
        `Failed to run benchmark ${benchmark.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Run a benchmark by ID
   */
  async runBenchmarkById(id: BenchmarkId): Promise<BenchmarkResult> {
    const benchmark = await loadBenchmark(id);
    return this.runBenchmark(benchmark);
  }

  /**
   * Run all benchmarks
   */
  async runAllBenchmarks(): Promise<BenchmarkResult[]> {
    const benchmarks = await loadAllBenchmarks();
    const results: BenchmarkResult[] = [];

    for (const benchmark of benchmarks) {
      console.log(`Running benchmark ${benchmark.id}: ${benchmark.title}`);
      const result = await this.runBenchmark(benchmark);
      results.push(result);
      console.log(`Completed benchmark ${benchmark.id}`);
    }

    return results;
  }

  /**
   * Run benchmarks in a specific category
   */
  async runBenchmarksByIds(ids: BenchmarkId[]): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = [];

    for (const id of ids) {
      console.log(`Running benchmark ${id}`);
      const result = await this.runBenchmarkById(id);
      results.push(result);
      console.log(`Completed benchmark ${id}`);
    }

    return results;
  }
}

/**
 * Save benchmark results to a file
 */
export async function saveBenchmarkResults(
  results: BenchmarkResult[],
  outputPath: string
): Promise<void> {
  const { writeFile } = await import("fs/promises");
  const content = JSON.stringify(results, null, 2);
  await writeFile(outputPath, content, "utf-8");
}

/**
 * Format benchmark result as markdown
 */
export function formatResultAsMarkdown(result: BenchmarkResult): string {
  return `# Benchmark ${result.benchmarkId}

**Model:** ${result.model}
**Timestamp:** ${result.timestamp.toISOString()}
**Latency:** ${result.metadata.latencyMs}ms
**Tokens:** ${result.metadata.totalTokens} (prompt: ${result.metadata.promptTokens}, completion: ${result.metadata.completionTokens})

## Prompt

\`\`\`
${result.prompt}
\`\`\`

## Response

${result.response}
`;
}
