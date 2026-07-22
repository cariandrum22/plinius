import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  BENCHMARK_SCHEMA_VERSION,
  parseBenchmarkDefinition,
} from "../src/suite/schema.js";
import { LoadedBenchmark } from "../src/suite/loader.js";
import { LoadedRunRecord } from "../src/experiment/records.js";
import { BenchmarkRunRecord } from "../src/types/benchmark.js";
import { defaultExperimentConfig } from "../src/experiment/config.js";
import {
  parseBlindReviewConfig,
  BlindReviewItem,
  STANDARD_HUMAN_RUBRIC,
  HumanReviewRecord,
} from "../src/blind/schema.js";
import { assignBlindIds } from "../src/blind/blind-id.js";
import { buildDenylist, scanText } from "../src/blind/redact.js";
import { filterRecords, selectRecords } from "../src/blind/select.js";
import { makeRng } from "../src/blind/rng.js";
import { generateBlindReviewSet } from "../src/blind/generator.js";
import { writeBlindReviewSet } from "../src/blind/writer.js";
import { buildPublicArchive } from "../src/blind/archive.js";
import { renderItemMarkdownJa } from "../src/blind/render.js";
import { importHumanReviews, unblindReviews, validateHumanReviewRecord } from "../src/blind/import.js";
import { analyze } from "../src/blind/analysis.js";

// --- helpers -----------------------------------------------------------------

function bench(id: string, domain = "writing", prototype = true): LoadedBenchmark {
  const def = parseBenchmarkDefinition({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    id,
    version: "1.0.0",
    domain,
    difficulty: "advanced",
    title: id,
    prototype,
  });
  return { definition: def, dir: "", taskText: `Task for ${id}`, fixtures: [], references: [], contentHash: `sha256:${id}` };
}

function rec(
  runRecordId: string,
  opts: {
    benchmarkId: string;
    targetId: string;
    rep: number;
    text: string;
    prototype?: boolean;
    det?: "pass" | "fail";
    judgeNorm?: number;
  },
): LoadedRunRecord {
  const record: BenchmarkRunRecord = {
    schemaVersion: 2,
    benchmark: { id: opts.benchmarkId, contentHash: "sha256:0", prototype: opts.prototype ?? true, domain: "writing" },
    experimentId: "exp-1",
    repetitionIndex: opts.rep,
    targetId: opts.targetId,
    backendId: "local-vllm",
    backendType: "openai-compatible",
    model: "Qwen/Qwen2.5-0.5B-Instruct",
    servedModelName: "Qwen/Qwen2.5-0.5B-Instruct",
    promptProfile: "neutral",
    messages: [],
    sampling: { maxTokens: 100, temperature: 0, topP: 1 },
    seed: 0,
    timestamp: "2026-01-01T00:00:00Z",
    response: { text: opts.text, latencyMs: 120, usage: { completionTokens: 50 } },
  };
  if (opts.det) {
    record.deterministicEvaluations = [
      { checkId: "c", evaluatorId: "e", version: "1.0.0", authority: "structural", blocking: true, status: opts.det, message: "", evidence: {} },
    ];
  }
  if (opts.judgeNorm !== undefined) {
    record.judgeEvaluations = [
      { judgeId: "j", judgeType: "scalar", authority: "scalar_judge", version: "1.0.0", rubricScaleMin: 0, rubricScaleMax: 5, dimensions: [], overall: opts.judgeNorm * 5, normalizedScore: opts.judgeNorm, refusal: false, formatValid: true, commentary: "", timestamp: "2026-01-01T00:00:00Z" },
    ];
  }
  return { runRecordId, record };
}

const CONFIG = parseBlindReviewConfig({ schemaVersion: 1, seed: "seed-A" });
const DENYLIST = buildDenylist(defaultExperimentConfig);
const CREATED = "2026-07-19T00:00:00.000Z";

function makeRecords(): LoadedRunRecord[] {
  return [
    rec("bw_t1_rep0", { benchmarkId: "writing-001", targetId: "target-alpha", rep: 0, text: "回答アルファ ワン" }),
    rec("bw_t1_rep1", { benchmarkId: "writing-001", targetId: "target-alpha", rep: 1, text: "回答アルファ ツー" }),
    rec("bw_t2_rep0", { benchmarkId: "writing-001", targetId: "target-beta", rep: 0, text: "回答ベータ ワン" }),
    rec("ba_t1_rep0", { benchmarkId: "arch-001", targetId: "target-alpha", rep: 0, text: "回答アーキ" }),
  ];
}
const BENCHES = new Map<string, LoadedBenchmark>([
  ["writing-001", bench("writing-001")],
  ["arch-001", bench("arch-001", "architecture")],
]);

function gen(seed = "seed-A", records = makeRecords()) {
  return generateBlindReviewSet({
    experimentId: "exp-1",
    config: parseBlindReviewConfig({ schemaVersion: 1, seed }),
    records,
    benchmarksById: BENCHES,
    denylist: DENYLIST,
    createdAt: CREATED,
  });
}

// --- 1, 15: deterministic + reproducible ------------------------------------

describe("blind ids & reproducibility", () => {
  it("(1) deterministic blind IDs with a fixed seed", () => {
    const ids1 = assignBlindIds(["a", "b", "c"], "seed-A");
    const ids2 = assignBlindIds(["c", "b", "a"], "seed-A");
    expect([...ids1.entries()].sort()).toEqual([...ids2.entries()].sort());
    for (const id of ids1.values()) expect(id).toMatch(/^R-[0-9A-HJKMNP-TV-Z]{7}$/);
  });

  it("(2) different seed → different IDs and order", () => {
    const a = gen("seed-A");
    const b = gen("seed-B");
    expect(a.set.items.map((i) => i.blindId)).not.toEqual(b.set.items.map((i) => i.blindId));
    expect(a.set.randomization.generatedSetHash).not.toBe(b.set.randomization.generatedSetHash);
  });

  it("(15) same input + seed → identical packet", () => {
    const a = gen();
    const b = gen();
    expect(a.set).toEqual(b.set);
    expect(a.set.randomization.generatedSetHash).toBe(b.set.randomization.generatedSetHash);
  });
});

// --- 3, 13: metadata removal & original preservation ------------------------

describe("identity removal & original preservation", () => {
  const FORBIDDEN = ["targetId", "model", "backendId", "seed", "latency", "latencyMs", "usage", "cost", "provenance", "timestamp", "quantization", "gpu"];

  it("(3) reviewer items contain no model/runtime metadata", () => {
    const { set } = gen();
    for (const item of set.items) {
      const keys = Object.keys(item);
      for (const forbidden of FORBIDDEN) expect(keys).not.toContain(forbidden);
    }
    // Whole public set serialized also must not mention target ids.
    const json = JSON.stringify(set);
    expect(json).not.toContain("target-alpha");
    expect(json).not.toContain("target-beta");
  });

  it("(13) original answer is preserved as-is, not translated", () => {
    const english = "This is the ORIGINAL answer, kept verbatim.";
    const records = [rec("r1", { benchmarkId: "writing-001", targetId: "target-alpha", rep: 0, text: english })];
    const { set } = gen("seed-A", records);
    expect(set.items[0].responseText).toBe(english);
    expect(set.items[0].responseLanguage).toBe("en");
    expect(set.items[0].referenceTranslation).toBeUndefined();
  });
});

// --- 4: leakage detection ----------------------------------------------------

describe("(4) leakage detection", () => {
  it("detects a known target id / model name in text", () => {
    const hits = scanText("これは target-alpha が Qwen として書いた回答です。", buildDenylist(defaultExperimentConfig, ["target-alpha"]));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => /self-identification|denylisted/.test(h.reason))).toBe(true);
  });
  it("flags explicit self-identification phrases", () => {
    const hits = scanText("As Qwen, I will answer.", DENYLIST);
    expect(hits.some((h) => h.reason === "explicit self-identification")).toBe(true);
  });
});

// --- 5, 6: public/private separation & archive ------------------------------

describe("public/private separation", () => {
  it("(5,6) writes separate public/private and the public archive omits mapping", async () => {
    const base = await mkdtemp(join(tmpdir(), "plinius-blind-"));
    try {
      const out = gen();
      const { dir } = await writeBlindReviewSet(base, out);
      // mapping.json only under private/
      const mapping = JSON.parse(await readFile(join(dir, "private", "mapping.json"), "utf-8"));
      expect(mapping.mapping[0]).toHaveProperty("targetId");

      const archiveDir = await mkdtemp(join(tmpdir(), "plinius-arch-"));
      const copied = await buildPublicArchive(dir, archiveDir);
      expect(copied.some((f) => f.includes("mapping"))).toBe(false);
      // No copied public file may contain private mapping identifiers.
      for (const rel of copied) {
        const content = await readFile(join(archiveDir, rel), "utf-8");
        expect(content).not.toContain("target-alpha");
        expect(content).not.toContain("runRecordId");
      }
      await rm(archiveDir, { recursive: true, force: true });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// --- 7: pairwise A/B randomization ------------------------------------------

describe("(7) pairwise A/B randomization", () => {
  it("exposes only A/B and stores the mapping privately", () => {
    const out = generateBlindReviewSet({
      experimentId: "exp-1",
      config: parseBlindReviewConfig({ schemaVersion: 1, seed: "pw", pairwise: { enabled: true } }),
      records: makeRecords(),
      benchmarksById: BENCHES,
      denylist: DENYLIST,
      createdAt: CREATED,
    });
    expect(out.pairwiseSet).toBeDefined();
    const item = out.pairwiseSet!.items[0];
    // pairwise item exposes only task + A + B (no target).
    expect(Object.keys(item)).not.toContain("aTargetId");
    expect(JSON.stringify(out.pairwiseSet)).not.toContain("target-alpha");
    // mapping records the concrete A/B targets privately.
    const m = out.mapping.pairwiseMapping!.find((x) => x.blindId === item.blindId)!;
    expect(m.aTargetId).toBeDefined();
    expect(m.bTargetId).toBeDefined();
    expect(m.aTargetId).not.toBe(m.bTargetId); // avoidSameModel default
  });
});

// --- 8, 9, 10: scoring validation, invalid blind id, duplicates -------------

function validReview(blindId: string, reviewerId = "rev1"): HumanReviewRecord {
  return {
    schemaVersion: 1,
    reviewSetId: "rs",
    blindId,
    reviewerId,
    rubricVersion: STANDARD_HUMAN_RUBRIC.version,
    scores: Object.fromEntries(STANDARD_HUMAN_RUBRIC.dimensions.map((d) => [d.id, 4])),
    findings: [],
    overallScore: 4,
    qualificationRecommendation: "qualified",
    confidence: 0.8,
  };
}

describe("human review validation & import", () => {
  const built = (() => {
    const out = gen();
    out.set.reviewSetId = "rs";
    return out.set;
  })();
  const blindId = built.items[0].blindId;

  it("(8) accepts a valid record and rejects out-of-range scores", () => {
    expect(validateHumanReviewRecord(validReview(blindId), built)).toEqual([]);
    const bad = validReview(blindId);
    bad.scores.accuracy = 9;
    expect(validateHumanReviewRecord(bad, built).some((e) => /out of range/.test(e))).toBe(true);
    const badConf = validReview(blindId);
    badConf.confidence = 2;
    expect(validateHumanReviewRecord(badConf, built).some((e) => /confidence/.test(e))).toBe(true);
    const blockingBad = validReview(blindId);
    blockingBad.findings = [{ code: "X", severity: "blocking", category: "correctness" }];
    expect(validateHumanReviewRecord(blockingBad, built).some((e) => /blocking/.test(e))).toBe(true);
  });

  it("(9) rejects an unknown blind ID", () => {
    const res = importHumanReviews([validReview("R-UNKNOWN")], built);
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected[0].errors.some((e) => /does not exist/.test(e))).toBe(true);
  });

  it("(10) rejects duplicate reviewer/blindId unless updating", () => {
    const two = [validReview(blindId), validReview(blindId)];
    const res = importHumanReviews(two, built);
    expect(res.accepted).toHaveLength(1);
    expect(res.rejected[0].errors.some((e) => /duplicate/.test(e))).toBe(true);

    const upd = importHumanReviews([validReview(blindId)], built, [validReview(blindId)], true);
    expect(upd.accepted).toHaveLength(1);
  });
});

// --- 11: explicit unblinding -------------------------------------------------

describe("(11) explicit unblinding", () => {
  it("analysis without mapping stays blind; unblind requires mapping", () => {
    const out = gen();
    out.set.reviewSetId = "rs";
    const reviews = out.set.items.map((i) => validReview(i.blindId));
    const blind = analyze({ set: out.set, reviews });
    expect(blind.unblinded).toBe(false);
    expect(blind.byTarget).toBeUndefined();

    const { unblinded } = unblindReviews(reviews, out.mapping);
    expect(unblinded[0].targetId).toBeDefined();
  });
});

// --- 12, 14: Japanese rendering + reference translation ---------------------

describe("Japanese rendering", () => {
  it("(12) renders Japanese labels", () => {
    const { set } = gen();
    const md = renderItemMarkdownJa(set.items[0]);
    expect(md).toContain("## 課題");
    expect(md).toContain("## モデル回答");
    expect(md).toContain("正確性");
    expect(md).toContain("採用可否");
  });

  it("(14) labels an optional reference translation without replacing the original", () => {
    const { set } = gen("seed-A", [rec("r1", { benchmarkId: "writing-001", targetId: "target-alpha", rep: 0, text: "Original English answer." })]);
    const item: BlindReviewItem = {
      ...set.items[0],
      referenceTranslation: "参考のための日本語訳。",
      translationMetadata: { translatorType: "machine", translatorId: "some-mt", translatedAt: CREATED, sourceHash: "sha256:x" },
    };
    const md = renderItemMarkdownJa(item);
    expect(md).toContain("参考訳（採点対象外）");
    expect(md).toContain("Original English answer."); // original preserved
  });
});

// --- 16: import + join -------------------------------------------------------

describe("(16) review import and mapping join", () => {
  it("joins imported reviews to targets", () => {
    const out = gen();
    out.set.reviewSetId = "rs";
    const raw = out.set.items.map((i) => validReview(i.blindId));
    const imported = importHumanReviews(raw, out.set);
    expect(imported.accepted.length).toBe(out.set.items.length);
    const { unblinded } = unblindReviews(imported.accepted, out.mapping);
    expect(new Set(unblinded.map((u) => u.targetId))).toEqual(new Set(["target-alpha", "target-beta"]));
  });
});

// --- 17: prototype / infra-validation filtering -----------------------------

describe("(17) prototype & infra-validation filtering", () => {
  const records = [
    rec("p1", { benchmarkId: "writing-001", targetId: "t1", rep: 0, text: "x", prototype: true }),
    rec("n1", { benchmarkId: "writing-001", targetId: "t1", rep: 0, text: "y", prototype: false }),
  ];
  it("drops prototypes when includePrototypes is false", () => {
    const out = filterRecords(records, BENCHES, { includePrototypes: false, includeInfraValidation: true }, false);
    expect(out.map((r) => r.runRecordId)).toEqual(["n1"]);
  });
  it("drops everything for an infra-validation experiment when excluded", () => {
    const out = filterRecords(records, BENCHES, { includePrototypes: true, includeInfraValidation: false }, true);
    expect(out).toHaveLength(0);
  });
  it("selection strategies: all vs stratified vs explicit", () => {
    const many = [0, 1, 2, 3].map((i) => rec(`m${i}`, { benchmarkId: "writing-001", targetId: "t1", rep: i, text: `r${i}` }));
    const rng = makeRng("s:select");
    expect(selectRecords(many, parseBlindReviewConfig({ schemaVersion: 1, seed: "s" }).selection, rng)).toHaveLength(4);
    const strat = selectRecords(many, { mode: "stratified", countPerTargetBenchmark: 2, scoreBased: false }, rng);
    expect(strat).toHaveLength(2);
    const explicit = selectRecords(many, { mode: "explicit", runRecordIds: ["m1", "m3"], scoreBased: false }, rng);
    expect(explicit.map((r) => r.runRecordId)).toEqual(["m1", "m3"]);
  });
});

// --- 18: human vs evaluator metrics -----------------------------------------

describe("(18) human vs evaluator comparison", () => {
  it("computes false qualification against deterministic results", () => {
    const records = [
      rec("r1", { benchmarkId: "writing-001", targetId: "target-alpha", rep: 0, text: "回答1", det: "fail", judgeNorm: 0.3 }),
      rec("r2", { benchmarkId: "writing-001", targetId: "target-beta", rep: 0, text: "回答2", det: "pass", judgeNorm: 0.9 }),
    ];
    const out = gen("seed-A", records);
    out.set.reviewSetId = "rs";
    // Human says both qualified (but r1 deterministically fails → false qualification).
    const reviews = out.set.items.map((i) => validReview(i.blindId));
    const runRecordsById = new Map(records.map((r) => [r.runRecordId, r.record]));
    const result = analyze({ set: out.set, reviews, mapping: out.mapping, runRecordsById });

    expect(result.unblinded).toBe(true);
    expect(result.vsDeterministic!.compared).toBe(2);
    expect(result.vsDeterministic!.falseQualificationRate).toBeGreaterThan(0);
    expect(result.vsDeterministic!.catastrophicMissRate).toBeGreaterThan(0);
    expect(result.vsJudge!.compared).toBe(2);
    expect(result.byTarget).toBeDefined();
  });
});
