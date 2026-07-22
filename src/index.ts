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

// --- Phase 1 evaluation system ---
export * from "./suite/schema.js";
export { canonicalHash, canonicalize, bytesHash } from "./suite/hash.js";
export {
  loadAllBenchmarks as loadAllSuiteBenchmarks,
  loadBenchmarkById as loadSuiteBenchmarkById,
  loadBenchmarkFromDir,
  getSuitesDir,
  suiteRelativePath,
} from "./suite/loader.js";
export type { LoadedBenchmark, BenchmarkFile } from "./suite/loader.js";

export * from "./evaluators/sandbox.js";
export * from "./evaluators/types.js";
export * from "./evaluators/tools.js";
export { runDeterministicChecks, summarizeDeterministic } from "./evaluators/registry.js";
export type { DeterministicSummary } from "./evaluators/registry.js";

export * from "./coding/extract.js";
export * from "./coding/workspace.js";

export * from "./experiment/spec.js";
export * from "./experiment/stats.js";
export * from "./experiment/verdict.js";
export {
  runExperiment,
  runSingle,
  composeUserPrompt,
} from "./experiment/runner.js";
export type {
  RunSingleParams,
  RunExperimentDeps,
  ExperimentTargetContext,
} from "./experiment/runner.js";

export * from "./evaluation/judge.js";
export * from "./evaluation/judge-apply.js";

export * from "./matrix/cost.js";
export * from "./matrix/capability.js";
export * from "./matrix/render.js";

export * from "./models/registry.js";
