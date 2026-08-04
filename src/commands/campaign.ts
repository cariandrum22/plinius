/**
 * `plinius campaign create|run|status|report` — campaign lifecycle commands.
 *
 * `run` executes the campaign against the configured backends/models (reusing
 * the Execution Backend, Prompt Snapshot, Manifest, and Provenance primitives),
 * persists one Execution Artifact per run, and creates a blind review set.
 * `status` and `report` operate on the persisted artifacts.
 */
import { mkdir, writeFile, stat } from "fs/promises";
import { join } from "path";
import { createDefaultRegistry } from "../backend/default-registry.js";
import {
  CampaignSpec,
  campaignBenchmarkRefs,
  getCampaignDir,
  loadCampaignSpec,
} from "../framework/campaign.js";
import { LoadedFrameworkBenchmark, loadAllBenchmarks } from "../framework/loader.js";
import { runCampaign } from "../framework/runner.js";
import { aggregateResults } from "../framework/aggregate.js";
import { buildCampaignReport, renderReportMarkdown } from "../framework/report.js";
import { createReviewSet, reviewStateCounts, ReviewableRun } from "../framework/review.js";
import {
  campaignReviewDir,
  campaignRunsDir,
  loadReviewMapping,
  loadReviewSet,
  loadRunRecords,
  writeReport,
  writeReviewSet,
} from "../framework/store.js";

/** Resolve the benchmarks a campaign will run, validating pinned versions. */
export function resolveCampaignBenchmarks(
  spec: CampaignSpec,
  all: LoadedFrameworkBenchmark[],
): LoadedFrameworkBenchmark[] {
  const refs = campaignBenchmarkRefs(spec);
  if (refs === "all") return [...all].sort((a, b) => a.asset.id.localeCompare(b.asset.id));

  const byId = new Map(all.map((b) => [b.asset.id, b]));
  const resolved: LoadedFrameworkBenchmark[] = [];
  for (const ref of refs) {
    const loaded = byId.get(ref.id);
    if (!loaded) throw new Error(`Campaign ${spec.id} references unknown benchmark "${ref.id}"`);
    if (ref.version && loaded.asset.version !== ref.version) {
      throw new Error(
        `Campaign ${spec.id} pins ${ref.id}@${ref.version} but the asset is v${loaded.asset.version}`,
      );
    }
    resolved.push(loaded);
  }
  return resolved.sort((a, b) => a.asset.id.localeCompare(b.asset.id));
}

const CAMPAIGN_TEMPLATE = (id: string): string => `schema_version: 1
id: ${id}
title: ${id}
description: ""

# Benchmarks to run: "all", or a list of ids / pinned refs.
benchmarks: all

# Backends to execute against (registry names).
backends:
  - vllm

# Models to evaluate (interpreted per backend).
models:
  - Qwen/Qwen2.5-0.5B-Instruct

sampling:
  temperature: 0
  seed: 1
  seed_strategy: fixed

repetitions: 1
exclude_from_rankings: true
`;

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function runCampaignCreate(options: { id: string }): Promise<void> {
  const dir = getCampaignDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${options.id}.yaml`);
  if (await pathExists(path)) {
    console.error(`Campaign already exists: ${path}`);
    process.exit(1);
  }
  await writeFile(path, CAMPAIGN_TEMPLATE(options.id), "utf-8");
  console.log(`Created campaign template: ${path}`);
  console.log(`Edit it, then run: plinius campaign run --campaign ${options.id}`);
}

export async function runCampaignRun(options: { campaign: string; seed?: string }): Promise<void> {
  const spec = await loadCampaignSpec(options.campaign);
  const all = await loadAllBenchmarks();
  const benchmarks = resolveCampaignBenchmarks(spec, all);
  if (benchmarks.length === 0) {
    console.error(`Campaign ${spec.id} resolved zero benchmarks.`);
    process.exit(1);
  }

  const registry = createDefaultRegistry();
  const outputDir = campaignRunsDir(spec.id);

  console.log(`\n=== Running campaign ${spec.id} ===`);
  console.log(`Backends: ${spec.backends.join(", ")}`);
  console.log(`Models:   ${spec.models.join(", ")}`);
  console.log(`Benchmarks: ${benchmarks.map((b) => b.asset.id).join(", ")}`);
  console.log(`Repetitions: ${spec.repetitions}\n`);

  const { records, catalogs } = await runCampaign({
    spec,
    benchmarks,
    resolveBackend: (name) => registry.get(name),
    outputDir,
    now: () => new Date().toISOString(),
    onRecord: (r, file) => {
      const status = r.error ? `✗ ${r.error.kind}` : `✓ ${r.output.finishReason ?? "ok"}`;
      console.log(`  ${status}  ${r.backend}:${r.model}  ${r.benchmarkId}#${r.repetitionIndex}  → ${file}`);
    },
  });

  // Create the blind review set from the produced runs.
  const reviewSeed = options.seed ?? `${spec.id}-review`;
  const reviewables: ReviewableRun[] = records.map((r) => ({
    runId: r.runId,
    backend: r.backend,
    model: r.model,
    benchmarkId: r.benchmarkId,
    category: r.category,
    repetitionIndex: r.repetitionIndex,
  }));
  const { set, mapping } = createReviewSet(reviewables, {
    campaignId: spec.id,
    reviewSetId: `rs-${spec.id}`,
    seed: reviewSeed,
    createdAt: new Date().toISOString(),
  });
  const { setPath, mappingPath } = await writeReviewSet(set, mapping);

  console.log(`\nRuns:           ${records.length}`);
  console.log(`Catalogs:       ${catalogs.length}`);
  console.log(`Review set:     ${setPath} (${set.tasks.length} blind tasks, all CREATED)`);
  console.log(`Private mapping: ${mappingPath}`);
  console.log(`\nNext: collect blind reviews, then: plinius campaign report --campaign ${spec.id}`);
}

export async function runCampaignStatus(options: { campaign: string }): Promise<void> {
  const spec = await loadCampaignSpec(options.campaign);
  const records = await loadRunRecords(spec.id);
  const set = await loadReviewSet(spec.id);

  console.log(`\n=== Campaign ${spec.id} — status ===\n`);
  console.log(`Run records: ${records.length}`);
  const failed = records.filter((r) => r.error !== null).length;
  console.log(`  succeeded: ${records.length - failed} · failed: ${failed}`);

  if (!set) {
    console.log(`Review set:  none (run the campaign first).`);
    return;
  }
  const counts = reviewStateCounts(set);
  console.log(`Review set:  ${set.reviewSetId} (${set.tasks.length} tasks)`);
  for (const [state, n] of Object.entries(counts)) console.log(`  ${state}: ${n}`);
}

export async function runCampaignReport(options: { campaign: string }): Promise<void> {
  const spec = await loadCampaignSpec(options.campaign);
  const records = await loadRunRecords(spec.id);
  if (records.length === 0) {
    console.error(`No run records for campaign ${spec.id}. Run it first.`);
    process.exit(1);
  }
  const set = await loadReviewSet(spec.id);
  const mapping = await loadReviewMapping(spec.id);
  const aggregates = set && mapping ? aggregateResults(set, mapping) : [];

  const report = buildCampaignReport({
    spec,
    records,
    aggregates,
    reviewSet: set,
    generatedAt: new Date().toISOString(),
  });
  const markdown = renderReportMarkdown(report);
  const { jsonPath, mdPath } = await writeReport(spec.id, report, markdown);

  console.log(`\nCampaign report written:`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  MD:   ${mdPath}`);
  console.log(`\nReview dir: ${campaignReviewDir(spec.id)}`);
}
