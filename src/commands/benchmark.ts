/**
 * `plinius benchmark` — run benchmark prompts against configured targets.
 *
 * Targets are backend-independent: an OpenRouter-hosted model and a local
 * vLLM model are selected the same way. The canonical artifact is JSON; a
 * Markdown report is derived from it.
 */
import { mkdir, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { resolveEnv, validateEnv } from "../env.js";
import { BenchmarkId, BenchmarkRunRecord } from "../types/benchmark.js";
import { BackendProvenance } from "../types/provenance.js";
import { SamplingConfig } from "../types/inference.js";
import { loadBenchmark } from "../benchmark/loader.js";
import {
  BenchmarkRunner,
  formatRecordAsMarkdown,
} from "../benchmark/runner.js";
import {
  ExperimentConfig,
  TargetConfig,
  defaultExperimentConfig,
  getTarget,
} from "../experiment/config.js";
import { buildBackendForTarget } from "../backends/factory.js";
import {
  DEFAULT_PROMPT_PROFILE,
  PromptProfileId,
  getPromptProfile,
} from "../prompts/profiles.js";
import { discoverBenchmarkIds, defaultBenchmarkConfig } from "../config.js";
import { executeWithConcurrency } from "../utils/executor.js";
import { getPliniusCommit } from "../utils/git.js";

export interface BenchmarkOptions {
  /** Restrict to a single target id. When omitted, all targets run. */
  targetId?: string;
  /** Override the prompt profile for every target. */
  promptProfile?: PromptProfileId;
  /** Restrict to specific benchmark ids. When omitted, all are discovered. */
  benchmarkIds?: BenchmarkId[];
  /** Experiment configuration (defaults to the built-in config). */
  config?: ExperimentConfig;
}

const CONCURRENT_BENCHMARKS = 5;
const TASK_START_DELAY_MS = 500;
const WORKER_START_DELAY_MS = 1000;

interface BenchmarkTask {
  target: TargetConfig;
  promptId: BenchmarkId;
}

function outputDir(): string {
  return join(process.cwd(), "benchmark", "artifacts", "result");
}

/** A run is complete when its canonical JSON record already exists. */
async function isTaskCompleted(
  target: TargetConfig,
  promptId: BenchmarkId,
): Promise<boolean> {
  try {
    const files = await readdir(outputDir());
    const prefix = `${promptId}_${target.id}_`;
    return files.some(
      (file) => file.startsWith(prefix) && file.endsWith(".json"),
    );
  } catch {
    return false;
  }
}

async function saveRecord(record: BenchmarkRunRecord): Promise<string> {
  const dir = outputDir();
  await mkdir(dir, { recursive: true });

  const timestamp = record.timestamp.replace(/[:.]/g, "-");
  const base = `${record.benchmark.id}_${record.targetId}_${timestamp}`;

  // Canonical JSON artifact.
  await writeFile(
    join(dir, `${base}.json`),
    JSON.stringify(record, null, 2),
    "utf-8",
  );

  // Derived Markdown view.
  await writeFile(join(dir, `${base}.md`), formatRecordAsMarkdown(record), "utf-8");

  return `${base}.json`;
}

/** Resolve the effective sampling config for a target. */
function resolveSampling(target: TargetConfig): SamplingConfig {
  return {
    maxTokens: defaultBenchmarkConfig.maxTokens,
    temperature: defaultBenchmarkConfig.temperature,
    topP: defaultBenchmarkConfig.topP,
    ...target.sampling,
  };
}

/** Validate that credentials required by the selected targets are present. */
function validateBackendCredentials(
  config: ExperimentConfig,
  targets: TargetConfig[],
): void {
  const requiredEnv = new Set<string>();
  for (const target of targets) {
    const def = config.backends[target.backend];
    if (!def) {
      throw new Error(
        `Target "${target.id}" references unknown backend "${target.backend}"`,
      );
    }
    // OpenRouter requires an API key; OpenAI-compatible servers may be open.
    if (def.type === "openrouter") {
      requiredEnv.add(def.apiKeyEnv ?? "OPENROUTER_API_KEY");
    }
  }
  if (requiredEnv.size > 0) {
    validateEnv([...requiredEnv]);
  }
}

export async function runBenchmarks(
  options: BenchmarkOptions = {},
): Promise<void> {
  const config = options.config ?? defaultExperimentConfig;

  console.log(`\n=== Plinius Benchmark Runner ===\n`);

  const targets = options.targetId
    ? [getTarget(config, options.targetId)]
    : config.targets;

  validateBackendCredentials(config, targets);

  const benchmarkIds =
    options.benchmarkIds ?? (await discoverBenchmarkIds());
  if (benchmarkIds.length === 0) {
    console.log("No benchmark prompts found in benchmark/prompt/.");
    return;
  }

  const pliniusCommit = await getPliniusCommit();

  // Build backends and capture provenance once per target.
  const runners = new Map<string, BenchmarkRunner>();
  for (const target of targets) {
    const backend = buildBackendForTarget(config, target.backend, {
      env: resolveEnv,
    });

    let provenance: BackendProvenance | undefined;
    if (backend.inspect) {
      try {
        provenance = await backend.inspect();
        if (provenance.missingFields.length > 0) {
          console.log(
            `⚠ Provenance for ${target.id}: missing ${provenance.missingFields.length} field(s) — ${provenance.missingFields.join(", ")}`,
          );
        }
      } catch (error) {
        console.log(
          `⚠ Could not capture provenance for ${target.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const promptProfile: PromptProfileId =
      options.promptProfile ??
      target.promptProfile ??
      DEFAULT_PROMPT_PROFILE;
    // Fail fast on an unknown profile before running anything.
    getPromptProfile(promptProfile);

    runners.set(
      target.id,
      new BenchmarkRunner({
        backend,
        target,
        promptProfile,
        sampling: resolveSampling(target),
        provenance,
        pliniusCommit,
      }),
    );
  }

  // Build the task matrix and skip already-completed runs (resume).
  const allTasks: BenchmarkTask[] = [];
  for (const target of targets) {
    for (const promptId of benchmarkIds) {
      allTasks.push({ target, promptId });
    }
  }

  const pendingTasks: BenchmarkTask[] = [];
  let skipped = 0;
  for (const task of allTasks) {
    if (await isTaskCompleted(task.target, task.promptId)) {
      skipped++;
    } else {
      pendingTasks.push(task);
    }
  }

  console.log(`=== Execution Plan ===`);
  console.log(`Targets: ${targets.map((t) => t.id).join(", ")}`);
  console.log(`Prompts: ${benchmarkIds.length}`);
  console.log(`Total tasks: ${allTasks.length}`);
  console.log(`Already completed: ${skipped}`);
  console.log(`Pending: ${pendingTasks.length}`);
  if (pliniusCommit) {
    console.log(`Plinius commit: ${pliniusCommit}`);
  }

  if (pendingTasks.length === 0) {
    console.log(`\n✅ All tasks already completed!`);
    return;
  }

  console.log(`\n=== Running ===\n`);

  let completed = 0;
  let failed = 0;

  await executeWithConcurrency(
    pendingTasks,
    CONCURRENT_BENCHMARKS,
    async (task, index) => {
      const runner = runners.get(task.target.id)!;
      console.log(
        `[${index + 1}/${pendingTasks.length}] ${task.promptId} → ${task.target.id}`,
      );

      const benchmark = await loadBenchmark(task.promptId);
      const record = await runner.runBenchmark(benchmark);
      const filename = await saveRecord(record);

      if (record.error) {
        failed++;
        console.log(
          `✗ ${task.promptId} → ${task.target.id}: [${record.error.kind}] ${record.error.message}`,
        );
      } else {
        completed++;
        const tokens = record.response?.usage?.totalTokens ?? "N/A";
        console.log(
          `✓ ${task.promptId} → ${task.target.id} (${record.response?.latencyMs}ms, ${tokens} tokens) → ${filename}`,
        );
      }
    },
    {
      taskStartDelay: TASK_START_DELAY_MS,
      workerStartDelay: WORKER_START_DELAY_MS,
    },
  );

  console.log(`\n=== Complete ===`);
  console.log(`Succeeded this run: ${completed}`);
  console.log(`Failed this run: ${failed}`);
  console.log(`\nResults saved to benchmark/artifacts/result/`);
}
