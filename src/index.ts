/**
 * Plinius public library surface.
 *
 * Exposes the backend-independent inference abstraction, backends, prompt
 * profiles, experiment configuration, and the benchmark runner. The CLI lives
 * in `cli.ts`.
 */
export * from "./types/inference.js";
export * from "./types/provenance.js";
export * from "./types/benchmark.js";

export * from "./backends/openai-compatible.js";
export * from "./backends/openrouter.js";
export * from "./backends/factory.js";

export * from "./prompts/profiles.js";
export * from "./experiment/config.js";

export {
  BenchmarkRunner,
  hashContent,
  saveBenchmarkRecords,
  formatRecordAsMarkdown,
} from "./benchmark/runner.js";
export type { BenchmarkRunnerConfig } from "./benchmark/runner.js";

export { loadBenchmark, loadAllBenchmarks } from "./benchmark/loader.js";
