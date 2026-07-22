/**
 * `plinius experiment` — run a versioned experiment (repeated runs of suite
 * benchmarks against configured targets), persisting each repetition
 * independently. Phase 1 runs sequentially.
 */
import { mkdir } from "fs/promises";
import { join } from "path";
import { resolveEnv, validateEnv } from "../env.js";
import { defaultBenchmarkConfig } from "../config.js";
import {
  ExperimentConfig,
  defaultExperimentConfig,
  getTarget,
  resolvedServedModelName,
} from "../experiment/config.js";
import { buildBackendForTarget } from "../backends/factory.js";
import { BackendProvenance } from "../types/provenance.js";
import { loadAllBenchmarks } from "../suite/loader.js";
import { loadExperimentSpec } from "../experiment/spec.js";
import {
  ExperimentTargetContext,
  runExperiment,
} from "../experiment/runner.js";
import { LocalProcessSandbox } from "../evaluators/sandbox.js";
import { getPliniusCommit } from "../utils/git.js";

export interface ExperimentOptions {
  /** Experiment id (resolves benchmark/experiments/<id>.yaml) or a file path. */
  experiment: string;
  config?: ExperimentConfig;
}

function resolveExperimentPath(idOrPath: string): string {
  if (idOrPath.endsWith(".yaml") || idOrPath.endsWith(".yml") || idOrPath.includes("/")) {
    return idOrPath;
  }
  return join(process.cwd(), "benchmark", "experiments", `${idOrPath}.yaml`);
}

export async function runExperimentCommand(options: ExperimentOptions): Promise<void> {
  const config = options.config ?? defaultExperimentConfig;
  const spec = await loadExperimentSpec(resolveExperimentPath(options.experiment));

  console.log(`\n=== Plinius Experiment: ${spec.id} ===`);
  console.log(`Purpose: ${spec.purpose}`);
  if (spec.excludeFromRankings || spec.purpose === "infrastructure-validation") {
    console.log(`⚠ Excluded from rankings (${spec.purpose}).`);
  }

  // Resolve targets and validate any required credentials.
  const targetConfigs = spec.targets.map((id) => getTarget(config, id));
  const requiredEnv = new Set<string>();
  for (const target of targetConfigs) {
    const def = config.backends[target.backend];
    if (!def) throw new Error(`Target "${target.id}" references unknown backend "${target.backend}"`);
    if (def.type === "openrouter") requiredEnv.add(def.apiKeyEnv ?? "OPENROUTER_API_KEY");
  }
  if (requiredEnv.size > 0) validateEnv([...requiredEnv]);

  // Load benchmarks and filter to the experiment's selection.
  let benchmarks = await loadAllBenchmarks();
  if (spec.benchmarks !== "all") {
    const wanted = new Set(spec.benchmarks);
    benchmarks = benchmarks.filter((b) => wanted.has(b.definition.id));
  }
  if (benchmarks.length === 0) {
    console.log("No matching benchmarks found under benchmark/suites/.");
    return;
  }

  const pliniusCommit = await getPliniusCommit();

  // Build backends and capture provenance once per target.
  const targets: ExperimentTargetContext[] = [];
  for (const target of targetConfigs) {
    const backend = buildBackendForTarget(config, target.backend, { env: resolveEnv });
    let provenance: BackendProvenance | undefined;
    if (backend.inspect) {
      try {
        provenance = await backend.inspect();
        if (provenance.missingFields.length > 0) {
          console.log(
            `⚠ Provenance for ${target.id}: missing ${provenance.missingFields.length} field(s).`,
          );
        }
      } catch (error) {
        console.log(
          `⚠ Could not capture provenance for ${target.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    targets.push({
      targetId: target.id,
      model: target.model,
      servedModelName: resolvedServedModelName(target),
      backend,
      seed: target.seed,
      provenance,
    });
  }

  const outputDir = join(
    process.cwd(),
    "benchmark",
    "artifacts",
    "experiments",
    spec.id,
  );
  await mkdir(outputDir, { recursive: true });

  console.log(`Targets: ${targets.map((t) => t.targetId).join(", ")}`);
  console.log(`Benchmarks: ${benchmarks.length}`);
  console.log(`Repetitions: ${spec.repetitions} (seed strategy: ${spec.seedStrategy})`);
  console.log(`Output: ${outputDir}`);
  console.log(`\n=== Running (sequential) ===\n`);

  const records = await runExperiment({
    spec,
    benchmarks,
    targets,
    sandbox: new LocalProcessSandbox(),
    outputDir,
    defaultSampling: defaultBenchmarkConfig,
    pliniusCommit,
    onRecord: (record, file) => {
      const status = record.error
        ? `✗ [${record.error.kind}] ${record.error.message}`
        : `✓ ${record.response?.latencyMs}ms`;
      const det = record.deterministicEvaluations
        ? ` det:${record.deterministicEvaluations.filter((e) => e.status === "pass").length}/${record.deterministicEvaluations.length}`
        : "";
      console.log(
        `${record.benchmark.id} → ${record.targetId} rep${record.repetitionIndex} ${status}${det} → ${file.split("/").pop()}`,
      );
    },
  });

  console.log(`\n=== Complete ===`);
  console.log(`Records written: ${records.length}`);
  console.log(`\nBuild a capability matrix with: plinius matrix --experiment ${spec.id}`);
}
