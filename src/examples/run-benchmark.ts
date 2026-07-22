/**
 * Example: run a single benchmark against a configured target.
 *
 * Usage:
 *   pnpm tsx src/examples/run-benchmark.ts qwen-smoke-vllm A1
 */
import { resolveEnv } from "../env.js";
import { loadBenchmark } from "../benchmark/loader.js";
import {
  BenchmarkRunner,
  formatRecordAsMarkdown,
} from "../benchmark/runner.js";
import {
  defaultExperimentConfig,
  getTarget,
} from "../experiment/config.js";
import { buildBackendForTarget } from "../backends/factory.js";
import { defaultBenchmarkConfig } from "../config.js";
import { DEFAULT_PROMPT_PROFILE } from "../prompts/profiles.js";

async function main() {
  const targetId = process.argv[2] ?? "qwen-smoke-vllm";
  const benchmarkId = process.argv[3] ?? "A1";

  const config = defaultExperimentConfig;
  const target = getTarget(config, targetId);
  const backend = buildBackendForTarget(config, target.backend, {
    env: resolveEnv,
  });

  const provenance = backend.inspect ? await backend.inspect() : undefined;

  const runner = new BenchmarkRunner({
    backend,
    target,
    promptProfile: target.promptProfile ?? DEFAULT_PROMPT_PROFILE,
    sampling: {
      maxTokens: defaultBenchmarkConfig.maxTokens,
      temperature: defaultBenchmarkConfig.temperature,
      topP: defaultBenchmarkConfig.topP,
    },
    provenance,
  });

  const benchmark = await loadBenchmark(benchmarkId);
  const record = await runner.runBenchmark(benchmark);

  console.log(formatRecordAsMarkdown(record));
  console.log("\n--- Canonical JSON ---\n");
  console.log(JSON.stringify(record, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { main };
