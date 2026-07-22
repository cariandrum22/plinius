/**
 * Blind-review set generator.
 *
 * Builds the reviewer-visible packet and the private mapping manifest from
 * selected run records. Canonical run records are never mutated; every
 * reviewer-facing item is constructed field-by-field so no model/runtime
 * identity can leak in. Ordering is randomized with a seeded PRNG so the same
 * (records, config, seed) reproduces the same packet.
 */
import { LoadedRunRecord } from "../experiment/records.js";
import { LoadedBenchmark } from "../suite/loader.js";
import { extractFiles } from "../coding/extract.js";
import {
  BlindReviewConfig,
  BlindReviewItem,
  BlindReviewMapping,
  BlindReviewMappingEntry,
  BlindReviewSet,
  GENERATION_MANIFEST_SCHEMA_VERSION,
  GenerationManifest,
  BLIND_REVIEW_SCHEMA_VERSION,
  MAPPING_SCHEMA_VERSION,
  PairwiseItem,
  PairwiseMappingEntry,
  PairwiseReviewSet,
  RandomizationMetadata,
  RedactionRecord,
  ReviewerArtifact,
  STANDARD_HUMAN_RUBRIC,
} from "./schema.js";
import { assignBlindIds, pairwiseBlindId } from "./blind-id.js";
import { makeRng, sha256Hex, shuffle } from "./rng.js";
import { Denylist, applyRedaction } from "./redact.js";

const ALGORITHM = "plinius-blind-shuffle";
const ALGORITHM_VERSION = "1.0.0";

export interface GenerateInput {
  experimentId: string;
  config: BlindReviewConfig;
  /** Already filtered + selected records. */
  records: LoadedRunRecord[];
  benchmarksById: Map<string, LoadedBenchmark>;
  denylist: Denylist;
  /** Injected timestamp (ISO) for deterministic call sites/tests. */
  createdAt: string;
}

export interface GenerateOutput {
  set: BlindReviewSet;
  mapping: BlindReviewMapping;
  manifest: GenerationManifest;
  pairwiseSet?: PairwiseReviewSet;
}

function detectLanguage(text: string): string {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "und-cjk";
  if (/[A-Za-z]/.test(text)) return "en";
  return "und";
}

function reviewSetId(config: BlindReviewConfig, experimentId: string, seedHash: string): string {
  return config.reviewSetId ?? `${experimentId}-blind-${seedHash.slice(0, 8)}`;
}

function buildArtifacts(record: LoadedRunRecord, domain: string): ReviewerArtifact[] | undefined {
  if (domain !== "coding") return undefined;
  const text = record.record.response?.text ?? "";
  const extracted = extractFiles(text);
  if (extracted.files.length === 0) return undefined;
  return extracted.files.map((f) => ({ path: f.path, content: f.content }));
}

function sourceHash(records: LoadedRunRecord[]): string {
  const canonical = records
    .map((r) => ({
      runRecordId: r.runRecordId,
      contentHash: r.record.benchmark.contentHash,
      responseHash: sha256Hex(r.record.response?.text ?? ""),
    }))
    .sort((a, b) => a.runRecordId.localeCompare(b.runRecordId));
  return sha256Hex(JSON.stringify(canonical));
}

/** Hash the public set with its generatedSetHash field blanked. */
function computeSetHash(set: BlindReviewSet): string {
  const clone = {
    ...set,
    randomization: { ...set.randomization, generatedSetHash: "" },
  };
  return sha256Hex(JSON.stringify(clone));
}

export function generateBlindReviewSet(input: GenerateInput): GenerateOutput {
  const { config, records, benchmarksById, denylist, createdAt } = input;
  const seedHash = sha256Hex(config.seed);
  const setId = reviewSetId(config, input.experimentId, seedHash);

  const blindIds = assignBlindIds(
    records.map((r) => r.runRecordId),
    config.seed,
    "R",
  );

  // Build reviewer items (identity-free) + mapping entries + redactions.
  const rawItems: BlindReviewItem[] = [];
  const mappingEntries: BlindReviewMappingEntry[] = [];
  const redactions: RedactionRecord[] = [];

  for (const r of records) {
    const loaded = benchmarksById.get(r.record.benchmark.id);
    const blindId = blindIds.get(r.runRecordId)!;
    const domain = loaded?.definition.domain ?? r.record.benchmark.domain ?? "unknown";
    const responseText = r.record.response!.text;

    let item: BlindReviewItem = {
      blindId,
      benchmarkId: r.record.benchmark.id,
      benchmarkVersion: loaded?.definition.version ?? r.record.benchmark.version ?? "0.0.0",
      domain,
      difficulty: loaded?.definition.difficulty ?? r.record.benchmark.difficulty ?? "unknown",
      taskText: loaded?.taskText ?? "",
      expectedOutputFormat: loaded?.definition.expectedOutputFormat || undefined,
      requiredConstraints: loaded?.definition.requiredConstraints,
      responseText,
      responseLanguage: detectLanguage(responseText),
      extractedArtifacts: buildArtifacts(r, domain),
      scoringRubric: STANDARD_HUMAN_RUBRIC,
    };

    const redaction = applyRedaction(item, denylist, config.redaction.policy);
    redactions.push(...redaction.redactions);
    if (redaction.excluded || !redaction.item) continue;
    item = redaction.item;

    rawItems.push(item);
    mappingEntries.push({
      blindId,
      runRecordId: r.runRecordId,
      experimentId: r.record.experimentId ?? input.experimentId,
      benchmarkId: r.record.benchmark.id,
      targetId: r.record.targetId,
      repetitionIndex: r.record.repetitionIndex ?? 0,
    });
  }

  // Randomize order: shuffle within each benchmark, optionally benchmark order.
  const items = randomizeItems(
    rawItems,
    config.seed,
    config.randomization.shuffleResponses,
    config.randomization.shuffleBenchmarkOrder,
  );

  const benchmarkIds = [...new Set(items.map((i) => i.benchmarkId))].sort();
  const rubricVersions: Record<string, string> = {};
  for (const id of benchmarkIds) {
    rubricVersions[id] = benchmarksById.get(id)?.definition.version ?? "0.0.0";
  }

  const randomization: RandomizationMetadata = {
    algorithm: ALGORITHM,
    algorithmVersion: ALGORITHM_VERSION,
    seedHash,
    shuffleResponses: config.randomization.shuffleResponses,
    shuffleBenchmarkOrder: config.randomization.shuffleBenchmarkOrder,
    pairwise: config.pairwise.enabled,
    sourceRecordsHash: sourceHash(records),
    generatedSetHash: "",
  };

  const set: BlindReviewSet = {
    schemaVersion: BLIND_REVIEW_SCHEMA_VERSION,
    reviewSetId: setId,
    createdAt,
    locale: config.locale,
    purpose: config.purpose,
    excludeFromModelQualification: config.excludeFromModelQualification,
    benchmarkIds,
    rubricVersions,
    randomization,
    items,
  };
  set.randomization.generatedSetHash = computeSetHash(set);
  const publicSetHash = set.randomization.generatedSetHash;

  // Optional pairwise packet.
  let pairwiseSet: PairwiseReviewSet | undefined;
  let pairwiseMapping: PairwiseMappingEntry[] | undefined;
  if (config.pairwise.enabled) {
    const built = buildPairwise(records, benchmarksById, config, setId, createdAt, randomization);
    pairwiseSet = built.set;
    pairwiseMapping = built.mapping;
  }

  const mapping: BlindReviewMapping = {
    schemaVersion: MAPPING_SCHEMA_VERSION,
    reviewSetId: setId,
    publicSetHash,
    mapping: mappingEntries,
    pairwiseMapping,
    redactions,
  };

  const manifest: GenerationManifest = {
    schemaVersion: GENERATION_MANIFEST_SCHEMA_VERSION,
    reviewSetId: setId,
    createdAt,
    experimentId: input.experimentId,
    algorithm: ALGORITHM,
    algorithmVersion: ALGORITHM_VERSION,
    seed: config.randomization.storeFullSeedInPrivate ? config.seed : undefined,
    seedHash,
    sourceRecordsHash: randomization.sourceRecordsHash,
    publicSetHash,
    selection: config.selection,
    filter: config.filter,
    redactionPolicy: config.redaction.policy,
  };

  return { set, mapping, manifest, pairwiseSet };
}

function randomizeItems(
  items: BlindReviewItem[],
  seed: string,
  shuffleResponses: boolean,
  shuffleBenchmarkOrder: boolean,
): BlindReviewItem[] {
  const byBenchmark = new Map<string, BlindReviewItem[]>();
  for (const item of items) {
    const list = byBenchmark.get(item.benchmarkId) ?? [];
    list.push(item);
    byBenchmark.set(item.benchmarkId, list);
  }

  let benchmarkOrder = [...byBenchmark.keys()].sort();
  if (shuffleBenchmarkOrder) {
    benchmarkOrder = shuffle(benchmarkOrder, makeRng(`${seed}:benchmark-order`));
  }

  const out: BlindReviewItem[] = [];
  for (const benchmarkId of benchmarkOrder) {
    let group = byBenchmark.get(benchmarkId)!;
    // Stable base order before shuffling.
    group = group.slice().sort((a, b) => a.blindId.localeCompare(b.blindId));
    if (shuffleResponses) {
      group = shuffle(group, makeRng(`${seed}:responses:${benchmarkId}`));
    }
    out.push(...group);
  }
  return out;
}

function buildPairwise(
  records: LoadedRunRecord[],
  benchmarksById: Map<string, LoadedBenchmark>,
  config: BlindReviewConfig,
  setId: string,
  createdAt: string,
  baseRandomization: RandomizationMetadata,
): { set: PairwiseReviewSet; mapping: PairwiseMappingEntry[] } {
  // One record per (benchmark, target): the earliest repetition.
  const perBenchmarkTarget = new Map<string, LoadedRunRecord>();
  for (const r of records) {
    const key = `${r.record.benchmark.id}::${r.record.targetId}`;
    const existing = perBenchmarkTarget.get(key);
    if (!existing || (r.record.repetitionIndex ?? 0) < (existing.record.repetitionIndex ?? 0)) {
      perBenchmarkTarget.set(key, r);
    }
  }

  const byBenchmark = new Map<string, LoadedRunRecord[]>();
  for (const r of perBenchmarkTarget.values()) {
    const list = byBenchmark.get(r.record.benchmark.id) ?? [];
    list.push(r);
    byBenchmark.set(r.record.benchmark.id, list);
  }

  const items: PairwiseItem[] = [];
  const mapping: PairwiseMappingEntry[] = [];
  const rng = makeRng(`${config.seed}:pairwise`);

  for (const [benchmarkId, list] of [...byBenchmark.entries()].sort()) {
    const sorted = list
      .slice()
      .sort((a, b) => a.record.targetId.localeCompare(b.record.targetId));
    const loaded = benchmarksById.get(benchmarkId);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const x = sorted[i];
        const y = sorted[j];
        if (config.pairwise.avoidSameModel && x.record.targetId === y.record.targetId) continue;
        // Randomize which is A vs B.
        const flip = rng() < 0.5;
        const a = flip ? y : x;
        const b = flip ? x : y;
        const blindId = pairwiseBlindId(config.seed, x.runRecordId, y.runRecordId);
        items.push({
          blindId,
          benchmarkId,
          benchmarkVersion: loaded?.definition.version ?? "0.0.0",
          domain: loaded?.definition.domain ?? "unknown",
          difficulty: loaded?.definition.difficulty ?? "unknown",
          taskText: loaded?.taskText ?? "",
          expectedOutputFormat: loaded?.definition.expectedOutputFormat || undefined,
          requiredConstraints: loaded?.definition.requiredConstraints,
          responseA: a.record.response!.text,
          responseB: b.record.response!.text,
        });
        mapping.push({
          blindId,
          benchmarkId,
          aRunRecordId: a.runRecordId,
          bRunRecordId: b.runRecordId,
          aTargetId: a.record.targetId,
          bTargetId: b.record.targetId,
        });
      }
    }
  }

  const set: PairwiseReviewSet = {
    schemaVersion: BLIND_REVIEW_SCHEMA_VERSION,
    reviewSetId: setId,
    createdAt,
    locale: config.locale,
    purpose: config.purpose,
    excludeFromModelQualification: config.excludeFromModelQualification,
    benchmarkIds: [...byBenchmark.keys()].sort(),
    randomization: { ...baseRandomization, pairwise: true },
    items,
  };
  return { set, mapping };
}
