/**
 * `plinius blind` — generate, inspect, and validate blind-review packets.
 * These commands never reveal model identities.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { defaultExperimentConfig } from "../experiment/config.js";
import { loadExperimentRecords } from "../experiment/records.js";
import { loadExperimentSpec, isExcludedFromRankings } from "../experiment/spec.js";
import { LoadedBenchmark, loadAllBenchmarks } from "../suite/loader.js";
import { parseBlindReviewConfig } from "../blind/schema.js";
import { buildDenylist, scanText } from "../blind/redact.js";
import { filterRecords, selectRecords } from "../blind/select.js";
import { generateBlindReviewSet } from "../blind/generator.js";
import { writeBlindReviewSet } from "../blind/writer.js";
import { blindReviewBaseDir, loadReviewSet, setDir } from "../blind/store.js";
import { makeRng } from "../blind/rng.js";
import { listPublicArchiveFiles } from "../blind/archive.js";

export interface BlindCreateOptions {
  experiment: string;
  config: string;
}

async function loadConfigFile(path: string) {
  return parseBlindReviewConfig(parseYaml(await readFile(path, "utf-8")));
}

export async function runBlindCreate(options: BlindCreateOptions): Promise<void> {
  const config = await loadConfigFile(options.config);
  const records = await loadExperimentRecords(options.experiment);
  if (records.length === 0) {
    console.log(`No run records found for experiment "${options.experiment}".`);
    return;
  }

  const benchmarks = await loadAllBenchmarks();
  const benchmarksById = new Map<string, LoadedBenchmark>(
    benchmarks.map((b) => [b.definition.id, b]),
  );

  let infraValidation = false;
  try {
    const spec = await loadExperimentSpec(
      join(process.cwd(), "benchmark", "experiments", `${options.experiment}.yaml`),
    );
    infraValidation = isExcludedFromRankings(spec);
  } catch {
    // no spec on disk; assume not infra-validation
  }

  const filtered = filterRecords(records, benchmarksById, config.filter, infraValidation);
  const selected = selectRecords(filtered, config.selection, makeRng(`${config.seed}:select`));
  if (selected.length === 0) {
    console.log("No records remained after filtering/selection.");
    return;
  }

  const denylist = buildDenylist(defaultExperimentConfig, config.redaction.extraDenylist);
  const output = generateBlindReviewSet({
    experimentId: options.experiment,
    config,
    records: selected,
    benchmarksById,
    denylist,
    createdAt: new Date().toISOString(),
  });

  const { dir } = await writeBlindReviewSet(blindReviewBaseDir(), output);

  console.log(`\n=== Blind Review Set: ${output.set.reviewSetId} ===`);
  console.log(`Purpose: ${output.set.purpose}`);
  if (output.set.excludeFromModelQualification) {
    console.log(`⚠ Excluded from model qualification (calibration set).`);
  }
  console.log(`Items: ${output.set.items.length}`);
  console.log(`Benchmarks: ${output.set.benchmarkIds.join(", ")}`);
  if (output.pairwiseSet) console.log(`Pairwise items: ${output.pairwiseSet.items.length}`);
  console.log(`Redactions recorded: ${output.mapping.redactions.length}`);
  console.log(`Public (share with reviewers): ${dir}/public`);
  console.log(`Private (keep secret):         ${dir}/private`);
  console.log(`\nReproducibility: seedHash=${output.set.randomization.seedHash.slice(0, 12)}… setHash=${output.set.randomization.generatedSetHash.slice(0, 12)}…`);
}

export async function runBlindInspect(reviewSetId: string): Promise<void> {
  const set = await loadReviewSet(reviewSetId);
  console.log(`\n=== ${set.reviewSetId} (blind) ===`);
  console.log(`Created: ${set.createdAt}`);
  console.log(`Locale: ${set.locale} · Purpose: ${set.purpose}`);
  console.log(`Excluded from model qualification: ${set.excludeFromModelQualification}`);
  console.log(`Items: ${set.items.length}`);
  const byDomain = new Map<string, number>();
  for (const item of set.items) byDomain.set(item.domain, (byDomain.get(item.domain) ?? 0) + 1);
  for (const [domain, count] of [...byDomain].sort()) console.log(`  ${domain}: ${count}`);
  console.log(`Benchmarks: ${set.benchmarkIds.join(", ")}`);
  console.log(`(model identities are intentionally hidden)`);
}

export async function runBlindValidate(reviewSetId: string): Promise<void> {
  const set = await loadReviewSet(reviewSetId);
  const denylist = buildDenylist(defaultExperimentConfig);

  // Scan every public artifact for identity leakage.
  const publicFiles = await listPublicArchiveFiles(setDir(reviewSetId));
  const leaks: string[] = [];
  for (const file of publicFiles) {
    const content = await readFile(file, "utf-8");
    for (const hit of scanText(content, denylist)) {
      leaks.push(`${file.split("/").slice(-2).join("/")}: "${hit.matched}" (${hit.reason})`);
    }
  }

  console.log(`\n=== Validate ${set.reviewSetId} ===`);
  console.log(`Public files scanned: ${publicFiles.length}`);
  if (leaks.length === 0) {
    console.log(`✅ No identity leakage detected in public artifacts.`);
  } else {
    console.log(`⚠ Potential leakage (${leaks.length}):`);
    for (const l of leaks.slice(0, 50)) console.log(`  - ${l}`);
  }
  // Confirm the private subtree is not part of the public archive.
  const anyPrivateInPublic = publicFiles.some((f) => f.includes("/private/"));
  console.log(`Private artifacts excluded from public archive: ${anyPrivateInPublic ? "NO ⚠" : "yes"}`);
}
