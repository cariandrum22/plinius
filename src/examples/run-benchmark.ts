/**
 * Example: Run benchmarks with OpenRouter
 *
 * Usage:
 *   pnpm run dev src/examples/run-benchmark.ts
 */

import { env, validateEnv } from "../env.js";
import { OpenRouterModels } from "../types/openrouter.js";
import {
  BenchmarkRunner,
  formatResultAsMarkdown,
  saveBenchmarkResults,
} from "../benchmark/runner.js";

async function main() {
  // Validate environment variables
  validateEnv(["OPENROUTER_API_KEY"]);

  // Create benchmark runner
  const runner = new BenchmarkRunner({
    apiKey: env.OPENROUTER_API_KEY!,
    model: OpenRouterModels.DEEPSEEK_R1, // or any other model
    maxTokens: 4000,
    temperature: 0.7,
  });

  // Example 1: Run a single benchmark
  console.log("=== Running single benchmark ===");
  const singleResult = await runner.runBenchmarkById("A1");
  console.log(formatResultAsMarkdown(singleResult));

  // Example 2: Run all quantitative benchmarks
  console.log("\n=== Running quantitative benchmarks ===");
  const quantResults = await runner.runBenchmarksByIds(["A1", "A2", "A3"]);

  // Save results
  await saveBenchmarkResults(
    quantResults,
    `benchmark-results-${Date.now()}.json`
  );

  console.log("\n=== Summary ===");
  for (const result of quantResults) {
    console.log(`${result.benchmarkId}: ${result.metadata.latencyMs}ms`);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main };
