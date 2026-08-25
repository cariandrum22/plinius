import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { parseBenchmarkAsset, parseRubric } from "../src/framework/benchmark.js";
import { loadAllBenchmarks, loadBenchmarkById, LoadedFrameworkBenchmark } from "../src/framework/loader.js";
import { parseCampaignSpec, campaignBenchmarkRefs, CampaignSpec } from "../src/framework/campaign.js";
import { runCampaign, computeRunId, FRAMEWORK_RUN_SCHEMA_VERSION } from "../src/framework/runner.js";
import {
  createReviewSet,
  advanceTask,
  submitReview,
  canTransition,
  reviewStateCounts,
  ReviewableRun,
} from "../src/framework/review.js";
import { aggregateResults } from "../src/framework/aggregate.js";
import { buildCampaignReport, renderReportMarkdown, REPORT_SCHEMA_VERSION } from "../src/framework/report.js";
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
    // `succeeded` used to mean "the call came back", which is how 120 truncated
    // and empty runs were once reported as successes. Transport and
    // qualification are now counted separately: the stub returns a non-empty
    // answer on a normal stop, so all four qualify on their own merits.
    expect(report.runtime.transportOk).toBe(4);
    expect(report.runtime.qualified).toBe(4);
    expect(report.runtime.notQualified).toBe(0);
    expect(report.backends[0].backend).toBe("stub");
    expect(report.benchmarks.length).toBe(2);
    expect(report.knownLimitations.some((l) => /No LLM judge/.test(l))).toBe(true);
    const md = renderReportMarkdown(report);
    for (const section of ["Campaign Summary", "Models", "Backend", "Benchmarks", "Review Summary", "Cost", "Runtime", "Known Limitations"]) {
      expect(md).toContain(`## ${section}`);
    }
  });
});

// --- authority findings A-05 (retry accounting + provenance) and A-07 (schema) --

/** Transport-ok but non-qualifying (empty final) response at a fixed cost/attempt. */
class CostBackend implements ExecutionBackend {
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
    const provenance: ExecutionProvenance = {
      backend: "stub", endpoint: "http://stub/v1", model: request.model, created: null,
      requestId: "req-cost", seed: null, sampling: null, finishReason: "stop", usage: null, backendMetadata: null,
    };
    return {
      text: "", // empty final → never qualifies → runner retries to the cap
      finishReason: "stop",
      metrics: { latencyMs: 5, promptTokens: 1, completionTokens: 0, totalTokens: 1, promptTps: null, generationTps: null, queueTimeMs: null },
      provenance,
      cost: { costModel: "METERED", estimatedUsd: 0.001 } as CostEstimate,
      raw: { id: "req-cost", model: request.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] },
    };
  }
  async *stream(): AsyncIterable<StreamChunk> { yield { delta: "", done: true }; }
  async estimateCost(): Promise<CostEstimate> { return { costModel: "METERED", estimatedUsd: 0.001 }; }
  async provenance(): Promise<ExecutionProvenance | null> { return null; }
  async health(): Promise<HealthResult> { return { backend: "stub", healthy: true, checks: [], checkedAt: NOW() }; }
}

/** Attempt 0 returns a non-qualifying response with provenance; later attempts throw. */
class FlakyProvenanceBackend implements ExecutionBackend {
  private calls = 0;
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
    this.calls += 1;
    if (this.calls === 1) {
      const provenance: ExecutionProvenance = {
        backend: "stub", endpoint: "http://early/v1", model: "m/early", created: "2026-01-01T00:00:00Z",
        requestId: "req-early", seed: null, sampling: null, finishReason: "stop", usage: null,
        backendMetadata: { tier: "gold" },
      };
      return {
        text: "", // non-qualifying, so the runner keeps retrying
        finishReason: "stop",
        metrics: { latencyMs: 7, promptTokens: 1, completionTokens: 0, totalTokens: 1, promptTps: null, generationTps: null, queueTimeMs: null },
        provenance,
        cost: { costModel: "METERED", estimatedUsd: 0.001 } as CostEstimate,
        raw: { id: "req-early", model: "m/early", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] },
      };
    }
    throw new BackendError("timeout", "later attempt failed", { backend: "stub" });
  }
  async *stream(): AsyncIterable<StreamChunk> { yield { delta: "", done: true }; }
  async estimateCost(): Promise<CostEstimate> { return { costModel: "METERED", estimatedUsd: 0.001 }; }
  async provenance(): Promise<ExecutionProvenance | null> { return null; }
  async health(): Promise<HealthResult> { return { backend: "stub", healthy: true, checks: [], checkedAt: NOW() }; }
}

/** A version-1 style record with NO attempts array — exercises the legacy fallback. */
function legacyRecord(estimatedUsd: number | null, id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: `run-legacy-${id}`,
    campaignId: "camp-one",
    benchmarkId: "b-legacy",
    benchmarkVersion: "1.0.0",
    category: "security",
    backend: "legacy",
    backendVersion: "1.0.0",
    model: "m-legacy",
    cost: { costModel: "METERED", estimatedUsd },
    status: { transport: "ok", response: "received", finalCompleteness: "complete", qualification: "pass", failureReasons: [] },
    finishReasonMapping: { raw: "stop", canonical: "stop", accepted: true, matchedTable: "normal_termination" },
    metrics: { latencyMs: 1 },
    error: null,
    // deliberately no `attempts` / `attemptCount`
  };
}

describe("A-05 retry accounting and provenance", () => {
  it("sums cost over every attempt of every logical run, counting runs and attempts separately", async () => {
    const spec = fixtureCampaign({ models: ["m-a"] });
    const benchmarks = await loadAllBenchmarks(root); // se-one + sec-two = 2 logical runs
    const { records } = await runCampaign({
      spec, benchmarks, resolveBackend: () => new CostBackend(),
      outputDir: join(outDir, "a05-cost"), now: NOW, maxAttempts: 3,
    });
    expect(records.length).toBe(2);
    expect(records.every((r) => r.attemptCount === 3)).toBe(true);

    const report = buildCampaignReport({ spec, records, aggregates: [], reviewSet: null, generatedAt: NOW() });
    // 2 logical runs × 3 attempts × $0.001 = $0.006 — headline-only would be $0.002.
    expect(report.cost.logicalRuns).toBe(2);
    expect(report.cost.attempts).toBe(6);
    expect(report.cost.totalEstimatedUsd).toBe(0.006);
    expect(report.cost.attemptsWithKnownCost).toBe(6);
    expect(report.cost.attemptsWithUnknownCost).toBe(0);
    const stub = report.cost.byBackend.find((b) => b.backend === "stub")!;
    expect(stub.estimatedUsd).toBe(0.006);
    expect(stub.attempts).toBe(6);
    expect(stub.attemptsWithKnownCost).toBe(6);
  });

  it("falls back to headline cost for a legacy record and never coerces unknown cost to $0", () => {
    const spec = fixtureCampaign();
    const records = [legacyRecord(0.002, "known"), legacyRecord(null, "unknown")] as unknown as Parameters<typeof buildCampaignReport>[0]["records"];
    const report = buildCampaignReport({ spec, records, aggregates: [], reviewSet: null, generatedAt: NOW() });
    expect(report.cost.logicalRuns).toBe(2);
    expect(report.cost.attempts).toBe(2); // one attempt each, via the fallback
    expect(report.cost.totalEstimatedUsd).toBe(0.002); // unknown is NOT added as 0
    expect(report.cost.attemptsWithKnownCost).toBe(1);
    expect(report.cost.attemptsWithUnknownCost).toBe(1);
  });

  it("reports total cost as null (unknown) when no attempt cost is known", () => {
    const spec = fixtureCampaign();
    const records = [legacyRecord(null, "u1")] as unknown as Parameters<typeof buildCampaignReport>[0]["records"];
    const report = buildCampaignReport({ spec, records, aggregates: [], reviewSet: null, generatedAt: NOW() });
    expect(report.cost.totalEstimatedUsd).toBeNull(); // not 0
    expect(report.cost.attemptsWithUnknownCost).toBe(1);
  });

  it("does not let a final transport failure inherit an earlier attempt's provenance", async () => {
    const spec = fixtureCampaign({ models: ["m-a"] });
    const all = await loadAllBenchmarks(root);
    const benchmarks = all.filter((b) => b.asset.id === "se-one"); // 1 logical run
    const { records } = await runCampaign({
      spec, benchmarks, resolveBackend: () => new FlakyProvenanceBackend(),
      outputDir: join(outDir, "a05-prov"), now: NOW, maxAttempts: 3,
    });
    expect(records.length).toBe(1);
    const r = records[0];
    expect(r.attemptCount).toBe(3); // never qualifies → runs to the cap
    expect(r.attempts[2].error?.kind).toBe("timeout"); // final attempt failed transport

    // Headline provenance is the FINAL (failed) attempt's: it carries no request
    // id, endpoint, provider metadata, created time, or the early response model.
    expect(r.generationProvenance.generationId).toBeNull();
    expect(r.generationProvenance.endpoint).toBeNull();
    expect(r.generationProvenance.providerMetadata).toBeNull();
    expect(r.generationProvenance.createdAt).toBeNull();
    expect(r.generationProvenance.model).not.toBe("m/early");
    expect(r.generationProvenance.canonicalSlug).not.toBe("m/early");

    // The early attempt's provenance is retained on attempt 0 only.
    expect(r.attempts[0].generationProvenance.generationId).toBe("req-early");
    expect(r.attempts[0].generationProvenance.providerMetadata).toEqual({ tier: "gold" });
    expect(r.attempts[2].generationProvenance.generationId).toBeNull();

    // The manifest's headline provenance likewise carries no early request id.
    expect(r.manifest.generationProvenance[0].generationId).toBeNull();
  });
});

describe("A-07 schema versions", () => {
  it("stamps fresh run records at version 2 with per-attempt generation provenance", async () => {
    const spec = fixtureCampaign({ models: ["m-a"] });
    const benchmarks = await loadAllBenchmarks(root);
    const { records } = await runCampaign({
      spec, benchmarks, resolveBackend: () => new StubBackend(),
      outputDir: join(outDir, "a07-run"), now: NOW,
    });
    expect(FRAMEWORK_RUN_SCHEMA_VERSION).toBe(2);
    for (const r of records) {
      expect(r.schemaVersion).toBe(2);
      // required v2 shape: headline + per-attempt generation provenance
      expect(r.generationProvenance).toBeTruthy();
      expect(r.attempts.every((a) => a.generationProvenance !== undefined)).toBe(true);
    }
  });

  it("does not misidentify a version-1 record as version 2", () => {
    const v1 = legacyRecord(0.001, "v1");
    expect(v1.schemaVersion).toBe(1);
    expect(v1.schemaVersion).not.toBe(FRAMEWORK_RUN_SCHEMA_VERSION);
  });

  it("emits version-2 reports with no collapsed succeeded/failed fields", async () => {
    const spec = fixtureCampaign({ models: ["m-a"] });
    const benchmarks = await loadAllBenchmarks(root);
    const { records } = await runCampaign({
      spec, benchmarks, resolveBackend: () => new StubBackend(),
      outputDir: join(outDir, "a07-report"), now: NOW,
    });
    const report = buildCampaignReport({ spec, records, aggregates: [], reviewSet: null, generatedAt: NOW() });
    expect(REPORT_SCHEMA_VERSION).toBe(2);
    expect(report.schemaVersion).toBe(2);
    // the old collapsed counts are gone at every level
    expect(report).not.toHaveProperty("succeeded");
    expect(report).not.toHaveProperty("failed");
    expect(report.runtime).not.toHaveProperty("succeeded");
    expect(report.runtime).not.toHaveProperty("failed");
    expect(report.cost).not.toHaveProperty("runsWithCost");
    expect(report.cost).not.toHaveProperty("runsWithoutCost");
  });
});
