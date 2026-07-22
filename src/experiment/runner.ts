/**
 * Experiment runner.
 *
 * For every (target × benchmark × repetition) it renders the exact messages,
 * calls the backend, optionally materializes generated files into an isolated
 * workspace, runs the deterministic-evaluator layer, and produces a canonical
 * {@link BenchmarkRunRecord}. Each repetition is an independent record.
 *
 * Generation + deterministic evaluation only. LLM judging is decoupled (see
 * evaluation/judge-apply.ts) so it can be applied later to stored records.
 * Phase 1 runs sequentially.
 */
import { writeFile } from "fs/promises";
import { join } from "path";
import {
  BENCHMARK_RECORD_SCHEMA_VERSION,
  BenchmarkRunRecord,
} from "../types/benchmark.js";
import { InferenceBackend, InferenceError, SamplingConfig } from "../types/inference.js";
import { BackendProvenance } from "../types/provenance.js";
import { PromptProfileId, renderMessages } from "../prompts/profiles.js";
import { LoadedBenchmark } from "../suite/loader.js";
import { DeterministicCheck } from "../suite/schema.js";
import { ExecutionSandbox } from "../evaluators/sandbox.js";
import { runDeterministicChecks } from "../evaluators/registry.js";
import { createWorkspace, destroyWorkspace } from "../coding/workspace.js";
import {
  ExperimentSpec,
  isExcludedFromRankings,
  seedForRepetition,
} from "./spec.js";

/** Compose the user prompt from the task, output format, and constraints. */
export function composeUserPrompt(loaded: LoadedBenchmark): string {
  const { definition, taskText } = loaded;
  const parts = [taskText];
  if (definition.expectedOutputFormat) {
    parts.push("", "## Required Output Format", definition.expectedOutputFormat);
  }
  if (definition.requiredConstraints.length > 0) {
    parts.push(
      "",
      "## Constraints",
      ...definition.requiredConstraints.map((c) => `- ${c}`),
    );
  }
  return parts.join("\n");
}

/** A check needs a workspace when it inspects generated files. */
function needsWorkspace(checks: DeterministicCheck[], hasFixtures: boolean): boolean {
  if (hasFixtures) return true;
  return checks.some(
    (c) =>
      c.kind === "command" ||
      c.kind === "file_exists" ||
      (c.kind === "json_schema" && c.source === "file"),
  );
}

export interface RunSingleParams {
  backend: InferenceBackend;
  loaded: LoadedBenchmark;
  targetId: string;
  model: string;
  servedModelName: string;
  promptProfile: PromptProfileId;
  sampling: SamplingConfig;
  timeoutMs: number;
  sandbox: ExecutionSandbox;
  provenance?: BackendProvenance;
  pliniusCommit?: string;
  experimentId?: string;
  repetitionIndex?: number;
}

/** Run a single repetition and produce its canonical record. Never throws. */
export async function runSingle(params: RunSingleParams): Promise<BenchmarkRunRecord> {
  const { loaded, backend } = params;
  const { definition } = loaded;
  const messages = renderMessages(params.promptProfile, composeUserPrompt(loaded));

  const record: BenchmarkRunRecord = {
    schemaVersion: BENCHMARK_RECORD_SCHEMA_VERSION,
    benchmark: {
      id: definition.id,
      contentHash: loaded.contentHash,
      version: definition.version,
      domain: definition.domain,
      difficulty: definition.difficulty,
      prototype: definition.prototype,
    },
    experimentId: params.experimentId,
    repetitionIndex: params.repetitionIndex,
    targetId: params.targetId,
    backendId: backend.id,
    backendType: backend.type,
    model: params.model,
    servedModelName: params.servedModelName,
    promptProfile: String(params.promptProfile),
    messages,
    sampling: params.sampling,
    seed: params.sampling.seed,
    timestamp: new Date().toISOString(),
    pliniusCommit: params.pliniusCommit,
    provenance: params.provenance,
  };

  try {
    const response = await backend.complete({
      model: params.servedModelName,
      messages,
      sampling: params.sampling,
      timeoutMs: params.timeoutMs,
    });
    record.response = {
      text: response.text,
      finishReason: response.finishReason,
      usage: response.usage,
      latencyMs: response.latencyMs,
      providerRequestId: response.providerRequestId,
      rawMetadata: response.rawMetadata,
    };
  } catch (error) {
    record.error =
      error instanceof InferenceError
        ? { kind: error.kind, message: error.message, status: error.status }
        : { kind: "unknown", message: error instanceof Error ? error.message : String(error) };
    // No response → no deterministic evaluation is meaningful.
    return record;
  }

  // Deterministic evaluation.
  const checks = definition.deterministicChecks;
  const outputText = record.response.text;
  if (needsWorkspace(checks, loaded.fixtures.length > 0)) {
    const workspace = await createWorkspace(outputText, loaded.fixtures);
    record.codingArtifacts = {
      sandboxId: params.sandbox.id,
      isSecuritySandbox: params.sandbox.isSecuritySandbox,
      ...workspace.extraction,
    };
    try {
      record.deterministicEvaluations = await runDeterministicChecks(checks, {
        outputText,
        workspaceDir: workspace.dir,
        sandbox: params.sandbox,
      });
    } finally {
      await destroyWorkspace(workspace);
    }
  } else if (checks.length > 0) {
    record.deterministicEvaluations = await runDeterministicChecks(checks, {
      outputText,
      sandbox: params.sandbox,
    });
  }

  return record;
}

export interface ExperimentTargetContext {
  targetId: string;
  model: string;
  servedModelName: string;
  backend: InferenceBackend;
  seed?: number;
  provenance?: BackendProvenance;
}

export interface RunExperimentDeps {
  spec: ExperimentSpec;
  benchmarks: LoadedBenchmark[];
  targets: ExperimentTargetContext[];
  sandbox: ExecutionSandbox;
  outputDir: string;
  defaultSampling: { maxTokens: number; temperature: number; topP: number };
  pliniusCommit?: string;
  /** Called after each repetition record is written (progress reporting). */
  onRecord?: (record: BenchmarkRunRecord, file: string) => void;
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

/**
 * Run the full experiment sequentially, persisting each repetition to its own
 * JSON file. Returns every record produced.
 */
export async function runExperiment(
  deps: RunExperimentDeps,
): Promise<BenchmarkRunRecord[]> {
  const { spec } = deps;
  const records: BenchmarkRunRecord[] = [];

  for (const target of deps.targets) {
    for (const loaded of deps.benchmarks) {
      const sampling: SamplingConfig = {
        maxTokens: spec.sampling.maxTokens ?? loaded.definition.maxOutputTokens,
        temperature: spec.sampling.temperature ?? deps.defaultSampling.temperature,
        topP: spec.sampling.topP ?? deps.defaultSampling.topP,
        seed: target.seed,
      };
      const timeoutMs = Math.min(spec.timeoutMs, loaded.definition.timeoutMs);

      for (let rep = 0; rep < spec.repetitions; rep++) {
        const seed = target.seed ?? seedForRepetition(spec, rep);
        const record = await runSingle({
          backend: target.backend,
          loaded,
          targetId: target.targetId,
          model: target.model,
          servedModelName: target.servedModelName,
          promptProfile: spec.promptProfile as PromptProfileId,
          sampling: { ...sampling, seed },
          timeoutMs,
          sandbox: deps.sandbox,
          provenance: target.provenance,
          pliniusCommit: deps.pliniusCommit,
          experimentId: spec.id,
          repetitionIndex: rep,
        });

        const file = join(
          deps.outputDir,
          `${sanitize(loaded.definition.id)}_${sanitize(target.targetId)}_rep${rep}_${Date.now()}.json`,
        );
        await writeFile(file, JSON.stringify(record, null, 2), "utf-8");
        records.push(record);
        deps.onRecord?.(record, file);
      }
    }
  }

  return records;
}

/** Re-export for callers building matrices from an experiment. */
export { isExcludedFromRankings };
