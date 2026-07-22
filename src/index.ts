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

// --- Blind human-review system ---
export * from "./blind/schema.js";
export { makeRng, shuffle, sha256Hex } from "./blind/rng.js";
export { assignBlindIds, pairwiseBlindId } from "./blind/blind-id.js";
export * from "./blind/redact.js";
export { filterRecords, selectRecords } from "./blind/select.js";
export type { FilterConfig } from "./blind/select.js";
export * from "./blind/generator.js";
export * from "./blind/render.js";
export { writeBlindReviewSet, reviewSetDir } from "./blind/writer.js";
export { buildPublicArchive, listPublicArchiveFiles } from "./blind/archive.js";
export * from "./blind/import.js";
export * from "./blind/analysis.js";
export { renderAnalysisReportJa } from "./blind/report.js";
export { loadExperimentRecords, experimentRecordsDir } from "./experiment/records.js";
export type { LoadedRunRecord } from "./experiment/records.js";

// --- OpenRouter catalog + online campaign ---
export * from "./catalog/schema.js";
export { OpenRouterCatalogClient } from "./catalog/client.js";
export * from "./catalog/snapshot.js";
export * from "./catalog/filter.js";
export * from "./catalog/diff.js";
export * from "./catalog/resolve.js";
export * from "./campaign/profiles.js";
export * from "./campaign/cohort.js";
export * from "./campaign/param-validation.js";
export * from "./campaign/reasoning.js";
export * from "./campaign/routing.js";
export * from "./campaign/cost.js";
export * from "./campaign/budget.js";
export * from "./campaign/discovery.js";
export * from "./campaign/plan.js";
export * from "./campaign/data-retention.js";
export * from "./campaign/lifecycle.js";

// --- Reproducibility & provenance hardening ---
export * from "./version.js";
export * from "./provenance/schema.js";
export * from "./provenance/generation.js";
export * from "./prompt/fingerprint.js";
export * from "./prompt/snapshot.js";
export * from "./environment/environment.js";
export * from "./manifest/manifest.js";
export * from "./manifest/reproduce.js";
export * from "./manifest/audit.js";

// --- Execution Backend abstraction ---
export * from "./backend/capabilities.js";
export * from "./backend/errors.js";
export * from "./backend/types.js";
export type { ExecutionBackend } from "./backend/interface.js";
export * from "./backend/registry.js";
export { createDefaultRegistry } from "./backend/default-registry.js";
export { OpenRouterExecutionBackend } from "./backend/openrouter/index.js";
export { VllmExecutionBackend } from "./backend/vllm/index.js";
