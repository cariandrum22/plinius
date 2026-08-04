import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { parseBenchmarkAsset, parseRubric } from "../src/framework/benchmark.js";
import { loadAllBenchmarks, loadBenchmarkById, LoadedFrameworkBenchmark } from "../src/framework/loader.js";
import { parseCampaignSpec, campaignBenchmarkRefs, CampaignSpec } from "../src/framework/campaign.js";
import { runCampaign, computeRunId } from "../src/framework/runner.js";
import {
  createReviewSet,
  advanceTask,
  submitReview,
  canTransition,
  reviewStateCounts,
  ReviewableRun,
} from "../src/framework/review.js";
import { aggregateResults } from "../src/framework/aggregate.js";
import { buildCampaignReport, renderReportMarkdown } from "../src/framework/report.js";
import { resolveCampaignBenchmarks } from "../src/commands/campaign.js";

import { ExecutionBackend } from "../src/backend/interface.js";
import { BackendError } from "../src/backend/errors.js";
import {
  BackendMetadata,
  CostEstimate,
  ExecutionProvenance,
  ExecutionRequest,
  ExecutionResult,
  HealthResult,
  ModelDescriptor,
  ResolveResult,
  StreamChunk,
} from "../src/backend/types.js";
import { BackendCapabilities, unknownCapabilities } from "../src/backend/capabilities.js";

const NOW = () => "2026-07-23T00:00:00.000Z";

// --- fixture asset tree ------------------------------------------------------

let root: string;
let outDir: string;

function metadataYaml(id: string, category: string, version = "1.0.0"): string {
  return `id: ${id}
title: Test ${id}
version: ${version}
category: ${category}
difficulty: hard
estimated_tokens: 256
tags: [t1, t2]
author: tester
license: CC-BY-4.0
golden: false
`;
}
const SYSTEM = `Be terse.`;
const USER = `Say hello.`;
const RUBRIC = `Correctness:
  weight: 60
Clarity:
  weight: 40
`;
const REFERENCES = `Intent: fixture. Assumptions: none. Reviewer notes: n/a.`;

async function writeBenchmark(category: string, id: string, version?: string): Promise<void> {
  const dir = join(root, category, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "metadata.yaml"), metadataYaml(id, category, version), "utf-8");
  await writeFile(join(dir, "system.md"), SYSTEM, "utf-8");
  await writeFile(join(dir, "user.md"), USER, "utf-8");
  await writeFile(join(dir, "rubric.yaml"), RUBRIC, "utf-8");
  await writeFile(join(dir, "references.md"), REFERENCES, "utf-8");
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "plinius-fw-"));
  outDir = await mkdtemp(join(tmpdir(), "plinius-fw-out-"));
  await writeBenchmark("software-engineering", "se-one");
  await writeBenchmark("security", "sec-two");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
});

// --- schema + prompt + rubric ------------------------------------------------

describe("benchmark schema", () => {
  it("parses a valid asset (snake_case normalized, golden default false)", () => {
    const a = parseBenchmarkAsset({
      id: "x-one",
      title: "X",
      version: "1.2.3",
      category: "architecture",
      difficulty: "expert",
      estimated_tokens: 100,
      author: "a",
      license: "MIT",
    });
    expect(a.estimatedTokens).toBe(100);
    expect(a.golden).toBe(false); // default
    expect(a.schemaVersion).toBe(1); // default
  });
  it("accepts all four difficulty levels", () => {
    for (const difficulty of ["easy", "medium", "hard", "expert"]) {
      expect(
        parseBenchmarkAsset({ id: "x", title: "t", version: "1.0.0", category: "security", difficulty, estimated_tokens: 1, author: "a", license: "MIT" }).difficulty,
      ).toBe(difficulty);
    }
  });
  it("rejects a non-semver version, a non-kebab id, and a missing license", () => {
    expect(() => parseBenchmarkAsset({ id: "X", title: "t", version: "1.0", category: "security", difficulty: "medium", estimated_tokens: 1, author: "a", license: "MIT" })).toThrow();
    expect(() => parseBenchmarkAsset({ id: "x", title: "t", version: "1.0.0", category: "security", difficulty: "medium", estimated_tokens: 1, author: "a" })).toThrow();
  });
  it("rubric holds weights only (map form) and requires ≥1 criterion", () => {
    const r = parseRubric({ Correctness: { weight: 60 }, Clarity: { weight: 40 } });
    expect(r.criteria[0]).toEqual({ name: "Correctness", weight: 60, description: "" });
    expect(r.criteria.map((c) => c.name)).toEqual(["Correctness", "Clarity"]);
    expect(() => parseRubric({})).toThrow();
    expect(() => parseRubric({ Correctness: { weight: 0 } })).toThrow();
    expect(() => parseRubric({ Correctness: {} })).toThrow(); // no weight
  });
});

// --- loader ------------------------------------------------------------------

describe("benchmark loader", () => {
  it("discovers benchmarks under categories, sorted, with a stable content hash", async () => {
    const all = await loadAllBenchmarks(root);
    expect(all.map((b) => b.asset.id)).toEqual(["se-one", "sec-two"]);
    const again = await loadAllBenchmarks(root);
    expect(again[0].contentHash).toBe(all[0].contentHash);
    expect(all[0].contentHash.startsWith("sha256:")).toBe(true);
  });
  it("loads one by id and rejects unknown ids", async () => {
    const b = await loadBenchmarkById("sec-two", root);
    expect(b.asset.category).toBe("security");
    await expect(loadBenchmarkById("nope", root)).rejects.toThrow(/Unknown benchmark/);
  });
});

// --- campaign ----------------------------------------------------------------

function fixtureCampaign(overrides: Partial<Record<string, unknown>> = {}): CampaignSpec {
  return parseCampaignSpec({
    schema_version: 1,
    id: "camp-one",
    title: "Camp",
    backends: ["stub"],
    models: ["m-b", "m-a"],
    sampling: { temperature: 0, seed: 1 },
    ...overrides,
  });
}

describe("campaign spec", () => {
  it("defaults benchmarks to all and normalizes sampling", () => {
    const spec = fixtureCampaign();
    expect(campaignBenchmarkRefs(spec)).toBe("all");
    expect(spec.sampling.seedStrategy).toBe("fixed");
  });
  it("resolveCampaignBenchmarks honors pinned versions", async () => {
    const all = await loadAllBenchmarks(root);
    const ok = fixtureCampaign({ benchmarks: [{ id: "se-one", version: "1.0.0" }] });
    expect(resolveCampaignBenchmarks(ok, all).map((b) => b.asset.id)).toEqual(["se-one"]);
    const bad = fixtureCampaign({ benchmarks: [{ id: "se-one", version: "9.9.9" }] });
    expect(() => resolveCampaignBenchmarks(bad, all)).toThrow(/pins se-one@9\.9\.9/);
  });
});

// --- stub execution backend --------------------------------------------------

class StubBackend implements ExecutionBackend {
  constructor(private readonly opts: { failModel?: string } = {}) {}
  name() { return "stub"; }
  version() { return "9.9.9"; }
  metadata(): BackendMetadata { return { backendName: "stub", backendVersion: "9.9.9", vendor: "Stub", apiVersion: "v1" }; }
  async capabilities(): Promise<BackendCapabilities> { return { capabilities: unknownCapabilities(), maxContextLength: null, maxOutputLength: null }; }
  async discoverModels(): Promise<ModelDescriptor[]> {
    return [{ id: "m-a", canonicalSlug: "m-a", ownedBy: "stub", contextLength: 4096, backendMetadata: null }];
  }
  async resolveModel(requestedModel: string): Promise<ResolveResult> {
    return { requestedModel, resolvedModel: requestedModel, found: true, isAlias: false, warnings: [] };
  }
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (this.opts.failModel && request.model === this.opts.failModel) {
      throw new BackendError("timeout", "stub timeout", { backend: "stub" });
    }
    const provenance: ExecutionProvenance = {
      backend: "stub", endpoint: "http://stub/v1", model: request.model, created: null,
      requestId: "req-1", seed: request.sampling?.seed ?? null, sampling: null,
      finishReason: "stop", usage: null, backendMetadata: null,
    };
    return {
      text: `answer for ${request.model}`,
      finishReason: "stop",
      metrics: { latencyMs: 42, promptTokens: 5, completionTokens: 7, totalTokens: 12, promptTps: null, generationTps: null, queueTimeMs: null },
      provenance,
      cost: { costModel: "FREE", estimatedUsd: 0 } as CostEstimate,
      raw: {},
    };
  }
  async *stream(): AsyncIterable<StreamChunk> { yield { delta: "", done: true }; }
  async estimateCost(): Promise<CostEstimate> { return { costModel: "FREE", estimatedUsd: 0 }; }
  async provenance(): Promise<ExecutionProvenance | null> { return null; }
  async health(): Promise<HealthResult> { return { backend: "stub", healthy: true, checks: [], checkedAt: NOW() }; }
}

// --- campaign runner ---------------------------------------------------------

describe("campaign runner", () => {
  it("runs backend×model×benchmark deterministically with full artifacts", async () => {
    const spec = fixtureCampaign();
    const benchmarks = await loadAllBenchmarks(root);
    const { records, catalogs } = await runCampaign({
      spec,
      benchmarks,
      resolveBackend: () => new StubBackend(),
      outputDir: join(outDir, "run1"),
      now: NOW,
    });
    // 1 backend × 2 models × 2 benchmarks × 1 rep = 4
    expect(records.length).toBe(4);
    expect(catalogs.length).toBe(1);
    const r = records[0];
    expect(r.promptSnapshot.promptId.startsWith("prompt-")).toBe(true);
    expect(r.catalogSnapshotId.startsWith("catalog-")).toBe(true);
    expect(r.manifest.runId).toBe(r.runId);
    expect(r.manifest.backend).toBe("stub");
    expect(r.output.text).toContain("answer for");
    expect(r.provenanceStatus).toBe("complete");
    expect(r.error).toBeNull();
    // deterministic run id: same inputs → same id
    const id = computeRunId({
      campaignId: spec.id, benchmarkId: r.benchmarkId, benchmarkContentHash: r.benchmarkContentHash,
      backend: r.backend, model: r.model, repetitionIndex: 0, promptId: r.promptSnapshot.promptId,
    });
    expect(id).toBe(r.runId);
  });
  it("re-running writes the same run ids (idempotent)", async () => {
    const spec = fixtureCampaign();
    const benchmarks = await loadAllBenchmarks(root);
    const first = await runCampaign({ spec, benchmarks, resolveBackend: () => new StubBackend(), outputDir: join(outDir, "run2"), now: NOW });
    const second = await runCampaign({ spec, benchmarks, resolveBackend: () => new StubBackend(), outputDir: join(outDir, "run2"), now: NOW });
    expect(first.records.map((r) => r.runId).sort()).toEqual(second.records.map((r) => r.runId).sort());
    const files = (await readdir(join(outDir, "run2"))).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(4); // no duplicates
  });
  it("captures a backend failure on the record without throwing", async () => {
    const spec = fixtureCampaign({ models: ["m-a"] });
    const benchmarks = await loadAllBenchmarks(root);
    const { records } = await runCampaign({ spec, benchmarks, resolveBackend: () => new StubBackend({ failModel: "m-a" }), outputDir: join(outDir, "run3"), now: NOW });
    expect(records.every((r) => r.error?.kind === "timeout")).toBe(true);
    expect(records.every((r) => r.output.text === null)).toBe(true);
  });
});

// --- review workflow ---------------------------------------------------------

const RUNS: ReviewableRun[] = [
  { runId: "run-a", backend: "stub", model: "m-a", benchmarkId: "se-one", category: "software-engineering", repetitionIndex: 0 },
  { runId: "run-b", backend: "stub", model: "m-b", benchmarkId: "se-one", category: "software-engineering", repetitionIndex: 0 },
  { runId: "run-c", backend: "stub", model: "m-a", benchmarkId: "sec-two", category: "security", repetitionIndex: 0 },
];

describe("review workflow", () => {
  it("creates blind tasks (no model id) with a separate private mapping", () => {
    const { set, mapping } = createReviewSet(RUNS, { campaignId: "camp-one", reviewSetId: "rs", seed: "s", createdAt: NOW() });
    expect(set.tasks.every((t) => t.state === "CREATED")).toBe(true);
    expect(set.tasks.every((t) => t.blindId.startsWith("R-"))).toBe(true);
    // public task carries no model/backend field
    expect(Object.keys(set.tasks[0])).toEqual(["blindId", "benchmarkId", "category", "state", "comment"]);
    // mapping (private) joins blind id back to the model
    expect(mapping.entries.length).toBe(3);
    expect(mapping.entries.every((e) => e.model && e.runId)).toBe(true);
  });
  it("enforces the state machine CREATED→ASSIGNED→IN_REVIEW→REVIEWED→FINALIZED", () => {
    expect(canTransition("CREATED", "ASSIGNED")).toBe(true);
    expect(canTransition("CREATED", "REVIEWED")).toBe(false);
    const { set } = createReviewSet(RUNS, { campaignId: "c", reviewSetId: "rs", seed: "s", createdAt: NOW() });
    const id = set.tasks[0].blindId;
    advanceTask(set, id, "ASSIGNED");
    advanceTask(set, id, "IN_REVIEW");
    expect(() => advanceTask(set, id, "FINALIZED")).toThrow(/Illegal review transition/);
    submitReview(set, id, { score: 4, comment: "ok", strength: "clear", weakness: "shallow", notes: "", dimensionScores: {} });
    const task = set.tasks.find((t) => t.blindId === id)!;
    expect(task.state).toBe("REVIEWED");
    expect(task.comment?.score).toBe(4);
    advanceTask(set, id, "FINALIZED");
    expect(reviewStateCounts(set).FINALIZED).toBe(1);
  });
  it("rejects submitting a review when not IN_REVIEW", () => {
    const { set } = createReviewSet(RUNS, { campaignId: "c", reviewSetId: "rs", seed: "s", createdAt: NOW() });
    expect(() => submitReview(set, set.tasks[0].blindId, { score: 1, comment: "", strength: "", weakness: "", notes: "", dimensionScores: {} })).toThrow(/must be IN_REVIEW/);
  });
});

// --- aggregation + report ----------------------------------------------------

describe("aggregation and report", () => {
  it("aggregates per model + category from reviewed scores (simple mean)", () => {
    const { set, mapping } = createReviewSet(RUNS, { campaignId: "c", reviewSetId: "rs", seed: "s", createdAt: NOW() });
    for (const task of set.tasks) {
      advanceTask(set, task.blindId, "ASSIGNED");
      advanceTask(set, task.blindId, "IN_REVIEW");
    }
    // Give m-a runs (run-a se, run-c sec) scores; m-b (run-b) one score.
    const byBlind = new Map(mapping.entries.map((e) => [e.runId, e.blindId]));
    submitReview(set, byBlind.get("run-a")!, { score: 4, comment: "", strength: "solid se", weakness: "", notes: "", dimensionScores: {} });
    submitReview(set, byBlind.get("run-c")!, { score: 2, comment: "", strength: "", weakness: "weak sec", notes: "", dimensionScores: {} });
    submitReview(set, byBlind.get("run-b")!, { score: 5, comment: "", strength: "", weakness: "", notes: "", dimensionScores: {} });

    const agg = aggregateResults(set, mapping);
    const mA = agg.find((m) => m.model === "m-a")!;
    expect(mA.averageScore).toBe(3); // (4 + 2) / 2
    expect(mA.reviewedCount).toBe(2);
    expect(mA.categorySummary.map((c) => c.category)).toEqual(["security", "software-engineering"]);
    expect(mA.strengths).toContain("solid se");
    expect(mA.weaknesses).toContain("weak sec");
    const mB = agg.find((m) => m.model === "m-b")!;
    expect(mB.averageScore).toBe(5);
  });

  it("builds a JSON report and renders Markdown with all required sections", async () => {
    const spec = fixtureCampaign();
    const benchmarks = await loadAllBenchmarks(root);
    const { records } = await runCampaign({ spec, benchmarks, resolveBackend: () => new StubBackend(), outputDir: join(outDir, "run4"), now: NOW });
    const { set, mapping } = createReviewSet(
      records.map((r) => ({ runId: r.runId, backend: r.backend, model: r.model, benchmarkId: r.benchmarkId, category: r.category, repetitionIndex: r.repetitionIndex })),
      { campaignId: spec.id, reviewSetId: "rs", seed: "s", createdAt: NOW() },
    );
    const agg = aggregateResults(set, mapping);
    const report = buildCampaignReport({ spec, records, aggregates: agg, reviewSet: set, generatedAt: NOW() });
    expect(report.runtime.totalRuns).toBe(4);
    expect(report.runtime.succeeded).toBe(4);
    expect(report.backends[0].backend).toBe("stub");
    expect(report.benchmarks.length).toBe(2);
    expect(report.knownLimitations.some((l) => /No LLM judge/.test(l))).toBe(true);
    const md = renderReportMarkdown(report);
    for (const section of ["Campaign Summary", "Models", "Backend", "Benchmarks", "Review Summary", "Cost", "Runtime", "Known Limitations"]) {
      expect(md).toContain(`## ${section}`);
    }
  });
});
