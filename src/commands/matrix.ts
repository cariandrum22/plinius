/**
 * `plinius matrix` — build a capability matrix (machine-readable JSON + derived
 * Markdown) from persisted experiment run records.
 */
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";
import { BenchmarkRunRecord } from "../types/benchmark.js";
import { LoadedBenchmark, loadAllBenchmarks } from "../suite/loader.js";
import { buildCapabilityMatrix } from "../matrix/capability.js";
import { renderMatrixMarkdown } from "../matrix/render.js";
import { loadExperimentSpec, isExcludedFromRankings } from "../experiment/spec.js";

export interface MatrixOptions {
  /** Experiment id whose records to aggregate. */
  experiment: string;
}

function recordsDir(experimentId: string): string {
  return join(process.cwd(), "benchmark", "artifacts", "experiments", experimentId);
}

async function loadRecords(dir: string): Promise<BenchmarkRunRecord[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    throw new Error(`No experiment records found at ${dir}. Run the experiment first.`);
  }
  const records: BenchmarkRunRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const raw = await readFile(join(dir, file), "utf-8");
    records.push(JSON.parse(raw) as BenchmarkRunRecord);
  }
  return records;
}

export async function runMatrixCommand(options: MatrixOptions): Promise<void> {
  const dir = recordsDir(options.experiment);
  const records = await loadRecords(dir);
  if (records.length === 0) {
    console.log(`No records to aggregate for experiment "${options.experiment}".`);
    return;
  }

  // Try to honor the experiment's ranking-exclusion flag.
  let excludeFromRankings = false;
  try {
    const spec = await loadExperimentSpec(
      join(process.cwd(), "benchmark", "experiments", `${options.experiment}.yaml`),
    );
    excludeFromRankings = isExcludedFromRankings(spec);
  } catch {
    // Fall back to per-benchmark prototype flags embedded in the records.
  }

  const benchmarks = await loadAllBenchmarks();
  const benchmarksById = new Map<string, LoadedBenchmark>(
    benchmarks.map((b) => [b.definition.id, b]),
  );

  const matrix = buildCapabilityMatrix(records, benchmarksById, {
    experimentId: options.experiment,
    excludeFromRankings,
  });

  const reportsDir = join(process.cwd(), "benchmark", "artifacts", "reports");
  await mkdir(reportsDir, { recursive: true });
  const stamp = matrix.generatedAt.replace(/[:.]/g, "-");
  const base = `matrix_${options.experiment}_${stamp}`;
  await writeFile(join(reportsDir, `${base}.json`), JSON.stringify(matrix, null, 2), "utf-8");
  await writeFile(join(reportsDir, `${base}.md`), renderMatrixMarkdown(matrix), "utf-8");

  console.log(`\n=== Capability Matrix: ${options.experiment} ===`);
  console.log(`Entries: ${matrix.entries.length}`);
  for (const entry of matrix.entries) {
    const domains = entry.qualifiedDomains.length ? entry.qualifiedDomains.join(", ") : "(none)";
    console.log(
      `- ${entry.targetId}${entry.excludedFromRankings ? " [excluded]" : ""}: qualified domains → ${domains}`,
    );
  }
  console.log(`\nSaved: benchmark/artifacts/reports/${base}.json (+ .md)`);
}
