/**
 * `plinius human-review` — import, report, and (explicitly) unblind human
 * reviews. `report` stays blind unless `--unblind` is passed; `unblind` is a
 * dedicated explicit operation that joins reviews to model identities.
 */
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { BenchmarkRunRecord } from "../types/benchmark.js";
import { loadExperimentRecords } from "../experiment/records.js";
import { importHumanReviews, unblindReviews } from "../blind/import.js";
import { analyze } from "../blind/analysis.js";
import { renderAnalysisReportJa } from "../blind/report.js";
import {
  loadMapping,
  loadPairwiseReviews,
  loadReviewSet,
  loadReviews,
  saveReviews,
  setDir,
} from "../blind/store.js";

export interface ImportOptions {
  reviewSet: string;
  input: string;
  update?: boolean;
}

export async function runHumanReviewImport(options: ImportOptions): Promise<void> {
  const set = await loadReviewSet(options.reviewSet);
  const existing = await loadReviews(options.reviewSet);
  const raw = JSON.parse(await readFile(options.input, "utf-8"));
  const result = importHumanReviews(raw, set, existing, options.update ?? false);

  console.log(`\n=== Import into ${set.reviewSetId} ===`);
  console.log(`Accepted: ${result.accepted.length}`);
  console.log(`Rejected: ${result.rejected.length}`);
  for (const r of result.rejected.slice(0, 50)) {
    console.log(`  ✗ [${r.blindId ?? `#${r.index}`}] ${r.errors.join("; ")}`);
  }

  if (result.accepted.length > 0) {
    const merged = options.update
      ? mergeReviews(existing, result.accepted)
      : [...existing, ...result.accepted];
    const path = await saveReviews(options.reviewSet, merged);
    console.log(`Saved ${merged.length} review(s) → ${path}`);
  }
}

function mergeReviews<T extends { reviewerId: string; blindId: string }>(
  existing: T[],
  incoming: T[],
): T[] {
  const byKey = new Map(existing.map((r) => [`${r.reviewerId}::${r.blindId}`, r]));
  for (const r of incoming) byKey.set(`${r.reviewerId}::${r.blindId}`, r);
  return [...byKey.values()];
}

export interface ReportOptions {
  reviewSet: string;
  unblind?: boolean;
}

async function runRecordsMap(experimentId: string): Promise<Map<string, BenchmarkRunRecord>> {
  const records = await loadExperimentRecords(experimentId);
  return new Map(records.map((r) => [r.runRecordId, r.record]));
}

export async function runHumanReviewReport(options: ReportOptions): Promise<void> {
  const set = await loadReviewSet(options.reviewSet);
  const reviews = await loadReviews(options.reviewSet);

  let mapping;
  let runRecordsById;
  let pairwiseReviews;
  if (options.unblind) {
    mapping = await loadMapping(options.reviewSet);
    const experimentId = mapping.mapping[0]?.experimentId;
    if (experimentId) runRecordsById = await runRecordsMap(experimentId);
    pairwiseReviews = await loadPairwiseReviews(options.reviewSet);
  }

  const result = analyze({ set, reviews, mapping, runRecordsById, pairwiseReviews });
  const md = renderAnalysisReportJa(result);

  const reportsDir = join(setDir(options.reviewSet), "reports");
  await mkdir(reportsDir, { recursive: true });
  const name = options.unblind ? "analysis.unblinded.ja.md" : "analysis.blind.ja.md";
  const path = join(reportsDir, name);
  await writeFile(path, md, "utf-8");

  console.log(`\n=== Report ${set.reviewSetId} (${options.unblind ? "UNBLINDED" : "blind"}) ===`);
  console.log(`Reviews: ${result.counts.reviews}, reviewers: ${result.counts.reviewers}, missing items: ${result.counts.missingItems}`);
  if (!options.unblind) console.log("(model identities hidden — pass --unblind to join identities)");
  console.log(`Saved report → ${path}`);
}

export async function runHumanReviewUnblind(reviewSetId: string): Promise<void> {
  const mapping = await loadMapping(reviewSetId);
  const reviews = await loadReviews(reviewSetId);
  const { unblinded, unmatched } = unblindReviews(reviews, mapping);

  const outDir = join(setDir(reviewSetId), "private");
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, "unblinded-reviews.json");
  await writeFile(path, JSON.stringify(unblinded, null, 2), "utf-8");

  console.log(`\n=== Unblind ${reviewSetId} ===`);
  console.log(`⚠ This joins reviews to model identities. Output is PRIVATE.`);
  console.log(`Joined: ${unblinded.length}, unmatched: ${unmatched}`);
  const byTarget = new Map<string, number>();
  for (const r of unblinded) byTarget.set(r.targetId, (byTarget.get(r.targetId) ?? 0) + 1);
  for (const [target, count] of [...byTarget].sort()) console.log(`  ${target}: ${count} review(s)`);
  console.log(`Saved → ${path}`);
}
