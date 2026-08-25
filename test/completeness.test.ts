/**
 * Response completeness regression tests.
 *
 * These cover the defect found in the old Phase G evidence: a run that came back
 * over the wire was counted as a success even when it carried no final answer,
 * reasoning was inlined into the answer field, the rubric was hashed but never
 * captured, and the raw provider payload was discarded.
 *
 * The five mandated response shapes are exercised end to end through the
 * campaign runner, plus the rubric/reference/legacy-hash invariants.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { loadAllBenchmarks, loadBenchmarkById } from "../src/framework/loader.js";
import { parseCampaignSpec, CampaignSpec } from "../src/framework/campaign.js";
import { runCampaign, FrameworkRunRecord } from "../src/framework/runner.js";
import { buildCampaignReport } from "../src/framework/report.js";
import { mapFinishReason, finishReasonTable, CANONICAL_STOP } from "../src/completeness/finish-reason.js";
import { normalizeCompletion } from "../src/completeness/normalize.js";
import { classifyRun } from "../src/completeness/status.js";
import { captureRubric, captureReferenceAsset } from "../src/completeness/assets.js";
import { canonicalize } from "../src/suite/hash.js";
import { createHash } from "crypto";

import { ExecutionBackend } from "../src/backend/interface.js";
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

const NOW = () => "2026-08-22T00:00:00.000Z";

let root: string;
let outDir: string;

const SYSTEM = "Be terse.";
const USER = "Say hello.";
const RUBRIC = `Correctness:
  weight: 60
Clarity:
  weight: 40
`;

function metadataYaml(id: string, category: string): string {
  return `id: ${id}
title: Test ${id}
version: 1.0.0
category: ${category}
difficulty: hard
estimated_tokens: 256
tags: [t1]
author: tester
license: CC-BY-4.0
golden: false
`;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "plinius-completeness-"));
  outDir = await mkdtemp(join(tmpdir(), "plinius-completeness-out-"));
  // One benchmark WITH references.md, one WITHOUT — exercises both branches.
  const withRef = join(root, "software-engineering", "se-with-ref");
  await mkdir(withRef, { recursive: true });
  await writeFile(join(withRef, "metadata.yaml"), metadataYaml("se-with-ref", "software-engineering"));
  await writeFile(join(withRef, "system.md"), SYSTEM);
  await writeFile(join(withRef, "user.md"), USER);
  await writeFile(join(withRef, "rubric.yaml"), RUBRIC);
  await writeFile(join(withRef, "references.md"), "## Intent\n\nReviewer notes.\n");

  const noRef = join(root, "security", "sec-no-ref");
  await mkdir(noRef, { recursive: true });
  await writeFile(join(noRef, "metadata.yaml"), metadataYaml("sec-no-ref", "security"));
  await writeFile(join(noRef, "system.md"), SYSTEM);
  await writeFile(join(noRef, "user.md"), USER);
  await writeFile(join(noRef, "rubric.yaml"), RUBRIC);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
});

function spec(models: string[]): CampaignSpec {
  return parseCampaignSpec({
    schema_version: 1,
    id: "completeness-fixture",
    title: "completeness fixture",
    description: "response completeness regression fixture",
    benchmarks: "all",
    backends: ["stub"],
    models,
    sampling: { temperature: 0, seed: 1, seed_strategy: "fixed" },
    repetitions: 1,
    exclude_from_rankings: true,
  });
}

/** A backend whose response shape is chosen by the model name. */
class ShapedBackend implements ExecutionBackend {
  name() {
    return "stub";
  }
  version() {
    return "1.0.0";
  }
  metadata(): BackendMetadata {
    return { backendName: "stub", backendVersion: "1.0.0", vendor: "test", apiVersion: null };
  }
  async capabilities(): Promise<BackendCapabilities> {
    return { capabilities: unknownCapabilities(), maxContextLength: null, maxOutputLength: null };
  }
  async discoverModels(): Promise<ModelDescriptor[]> {
    return [{ id: "m", canonicalSlug: "m", ownedBy: "stub", contextLength: 4096, backendMetadata: null }];
  }
  async resolveModel(requestedModel: string): Promise<ResolveResult> {
    return { requestedModel, resolvedModel: requestedModel, found: true, isAlias: false, warnings: [] };
  }
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const shapes: Record<string, { content: string | null; reasoning?: string; finish: string }> = {
      "empty-response": { content: "", finish: "stop" },
      "reasoning-only": { content: null, reasoning: "I considered the options.", finish: "stop" },
      "length-truncated": { content: "A partial but non-empty answer that was cut", finish: "length" },
      "content-filtered": { content: "", finish: "content_filter" },
      "good-stop": { content: "A complete, non-empty final answer.", finish: "stop" },
      "think-inline": {
        content: "<think>step one, step two</think>\n\nThe final answer.",
        finish: "stop",
      },
    };
    const shape = shapes[request.model] ?? shapes["good-stop"];
    const raw = {
      id: "gen-test-1",
      model: request.model,
      choices: [
        {
          finish_reason: shape.finish,
          message: {
            role: "assistant",
            content: shape.content,
            ...(shape.reasoning ? { reasoning: shape.reasoning } : {}),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };
    const provenance: ExecutionProvenance = {
      backend: "stub",
      endpoint: "http://stub/v1",
      model: request.model,
      created: null,
      requestId: "gen-test-1",
      seed: request.sampling?.seed ?? null,
      sampling: null,
      finishReason: shape.finish,
      usage: null,
      backendMetadata: null,
    };
    return {
      text: shape.content ?? "",
      finishReason: shape.finish,
      metrics: {
        latencyMs: 10,
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        promptTps: null,
        generationTps: null,
        queueTimeMs: null,
      },
      provenance,
      cost: { costModel: "METERED", estimatedUsd: 0.001 } as CostEstimate,
      raw,
    };
  }
  async *stream(): AsyncIterable<StreamChunk> {
    yield { delta: "", done: true };
  }
  async estimateCost(): Promise<CostEstimate> {
    return { costModel: "METERED", estimatedUsd: 0.001 };
  }
  async provenance(): Promise<ExecutionProvenance | null> {
    return null;
  }
  async health(): Promise<HealthResult> {
    return { backend: "stub", healthy: true, checks: [], checkedAt: NOW() };
  }
}

async function runWith(models: string[], dir: string): Promise<FrameworkRunRecord[]> {
  const benchmarks = await loadAllBenchmarks(root);
  const { records } = await runCampaign({
    spec: spec(models),
    benchmarks,
    resolveBackend: () => new ShapedBackend(),
    outputDir: join(outDir, dir),
    now: NOW,
  });
  return records;
}

// --- finish reason mapping ---------------------------------------------------

describe("finish reason mapping", () => {
  it("maps only normal termination onto the canonical stop", () => {
    for (const raw of ["stop", "STOP", " end_turn ", "eos", "completed"]) {
      const m = mapFinishReason(raw);
      expect(m.canonical).toBe(CANONICAL_STOP);
      expect(m.accepted).toBe(true);
    }
  });

  it("never accepts truncation, filtering, timeout, cancellation or provider error", () => {
    const cases: Array<[string, string]> = [
      ["length", "length"],
      ["max_tokens", "length"],
      ["content_filter", "content_filter"],
      ["safety", "content_filter"],
      ["timeout", "timeout"],
      ["cancelled", "cancelled"],
      ["error", "provider_error"],
    ];
    for (const [raw, canonical] of cases) {
      const m = mapFinishReason(raw);
      expect(m.canonical).toBe(canonical);
      expect(m.accepted).toBe(false);
    }
  });

  it("treats an absent or unrecognised reason as unknown and not accepted", () => {
    for (const raw of [null, undefined, "", "something_new"]) {
      const m = mapFinishReason(raw);
      expect(m.canonical).toBe("unknown");
      expect(m.accepted).toBe(false);
    }
  });

  it("preserves the raw reason verbatim alongside the mapping table", () => {
    expect(mapFinishReason("MAX_TOKENS").raw).toBe("MAX_TOKENS");
    expect(finishReasonTable()["content_filter"]).toBe("content_filter");
    expect(finishReasonTable()["stop"]).toBe("stop");
  });
});

// --- reasoning / final separation -------------------------------------------

describe("reasoning and final answer separation", () => {
  it("lifts a dedicated reasoning field out of the answer", () => {
    const n = normalizeCompletion({
      rawResponse: { choices: [{ message: { content: "The answer.", reasoning: "my thoughts" } }] },
      text: "The answer.",
    });
    expect(n.reasoningText).toBe("my thoughts");
    expect(n.reasoningSource).toBe("reasoning_field");
    expect(n.finalAnswer).toBe("The answer.");
    expect(n.finalAnswerIsEmpty).toBe(false);
    expect(n.reasoningOnly).toBe(false);
  });

  it("strips inline <think> markup into reasoning", () => {
    const n = normalizeCompletion({
      rawResponse: { choices: [{ message: { content: "<think>a</think>B" } }] },
      text: "<think>a</think>B",
    });
    expect(n.reasoningText).toBe("a");
    expect(n.reasoningSource).toBe("think_tags");
    expect(n.finalAnswer.trim()).toBe("B");
  });

  it("splits on a closing </think> that has no opener (template-prefilled)", () => {
    // Qwen3-family chat templates put the opening <think> in the prompt, so the
    // model emits only the closer. Everything before it is reasoning.
    const content = 'We need to respond to user. Need final exactly "hello world". No extra.\n</think>\n\nhello world';
    const n = normalizeCompletion({
      rawResponse: { choices: [{ message: { content } }] },
      text: content,
    });
    expect(n.reasoningSource).toBe("think_tags");
    expect(n.reasoningText).toContain("We need to respond");
    expect(n.finalAnswer.trim()).toBe("hello world");
    expect(n.finalAnswerIsEmpty).toBe(false);
    expect(n.reasoningOnly).toBe(false);
    // the reasoning must not have leaked into the answer
    expect(n.finalAnswer).not.toContain("We need to respond");
  });

  it("reports reasoning-only when a template-prefilled closer leaves nothing after it", () => {
    const content = "thinking with no answer after the closer\n</think>\n   ";
    const n = normalizeCompletion({
      rawResponse: { choices: [{ message: { content } }] },
      text: content,
    });
    expect(n.reasoningOnly).toBe(true);
    expect(n.finalAnswerIsEmpty).toBe(true);
  });

  it("treats an unterminated <think> as reasoning with no final answer", () => {
    const n = normalizeCompletion({
      rawResponse: { choices: [{ message: { content: "<think>cut off mid thought" } }] },
      text: "<think>cut off mid thought",
    });
    expect(n.reasoningOnly).toBe(true);
    expect(n.finalAnswerIsEmpty).toBe(true);
  });

  it("never substitutes reasoning for a missing final answer", () => {
    const n = normalizeCompletion({
      rawResponse: { choices: [{ message: { content: null, reasoning: "lots of thinking" } }] },
      text: null,
    });
    expect(n.reasoningText).toBe("lots of thinking");
    expect(n.finalAnswer).toBe("");
    expect(n.finalAnswerIsEmpty).toBe(true);
    expect(n.reasoningOnly).toBe(true);
  });

  it("treats whitespace as an empty final answer", () => {
    const n = normalizeCompletion({
      rawResponse: { choices: [{ message: { content: "   \n\t  " } }] },
      text: "   \n\t  ",
    });
    expect(n.finalAnswerIsEmpty).toBe(true);
  });

  it("reports a normalizer error instead of throwing on an unreadable payload", () => {
    const n = normalizeCompletion({ rawResponse: { nonsense: true }, text: null });
    expect(n.normalizerError).not.toBeNull();
    expect(n.finalAnswerIsEmpty).toBe(true);
  });
});

// --- status separation -------------------------------------------------------

describe("status separation", () => {
  it("keeps transport success distinct from a complete answer", () => {
    const s = classifyRun({
      transportError: null,
      normalized: normalizeCompletion({
        rawResponse: { choices: [{ message: { content: "" } }] },
        text: "",
      }),
      finishReason: mapFinishReason("stop"),
    });
    expect(s.transport).toBe("ok");
    expect(s.response).toBe("received");
    expect(s.finalCompleteness).toBe("empty_final");
    expect(s.qualification).toBe("fail");
  });

  it("fails a transport error at every level", () => {
    const s = classifyRun({
      transportError: { kind: "timeout", message: "took too long" },
      normalized: null,
      finishReason: mapFinishReason(null),
    });
    expect(s.transport).toBe("failed");
    expect(s.qualification).toBe("fail");
  });
});

// --- the five mandated response shapes, end to end ---------------------------

describe("mandated regression scenarios", () => {
  it("1. an empty response is a failure, not a success", async () => {
    const records = await runWith(["empty-response"], "empty");
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.output.finalAnswerIsEmpty).toBe(true);
      expect(r.status.finalCompleteness).toBe("empty_final");
      expect(r.status.qualification).toBe("fail");
      // transport still succeeded — the two must not be conflated
      expect(r.status.transport).toBe("ok");
    }
  });

  it("2. a reasoning-only response is a failure and keeps reasoning separate", async () => {
    const records = await runWith(["reasoning-only"], "reasoning");
    for (const r of records) {
      expect(r.output.reasoningText).toBe("I considered the options.");
      expect(r.output.finalAnswer).toBe("");
      expect(r.output.reasoningOnly).toBe(true);
      expect(r.status.finalCompleteness).toBe("reasoning_only");
      expect(r.status.qualification).toBe("fail");
    }
  });

  it("3. a length-truncated non-empty response is not a success", async () => {
    const records = await runWith(["length-truncated"], "length");
    for (const r of records) {
      expect(r.output.finalAnswerIsEmpty).toBe(false);
      expect(r.finishReasonMapping.raw).toBe("length");
      expect(r.finishReasonMapping.canonical).toBe("length");
      expect(r.finishReasonMapping.accepted).toBe(false);
      expect(r.status.finalCompleteness).toBe("truncated");
      expect(r.status.qualification).toBe("fail");
    }
  });

  it("4. a content_filter response is not a success", async () => {
    const records = await runWith(["content-filtered"], "filtered");
    for (const r of records) {
      expect(r.finishReasonMapping.canonical).toBe("content_filter");
      expect(r.status.finalCompleteness).toBe("filtered");
      expect(r.status.qualification).toBe("fail");
    }
  });

  it("5. a normal non-empty stop response qualifies", async () => {
    const records = await runWith(["good-stop"], "good");
    for (const r of records) {
      expect(r.output.finalAnswer).toBe("A complete, non-empty final answer.");
      expect(r.output.finalAnswerIsEmpty).toBe(false);
      expect(r.finishReasonMapping.canonical).toBe("stop");
      expect(r.finishReasonMapping.accepted).toBe(true);
      expect(r.status.finalCompleteness).toBe("complete");
      expect(r.status.qualification).toBe("pass");
    }
  });
});

// --- raw response capture ----------------------------------------------------

describe("raw provider response capture", () => {
  it("stores the payload verbatim with a digest of the stored bytes", async () => {
    const records = await runWith(["good-stop"], "raw");
    for (const r of records) {
      expect(r.rawResponse).not.toBeNull();
      const raw = r.rawResponse as Record<string, unknown>;
      expect(raw.id).toBe("gen-test-1");
      expect(Array.isArray(raw.choices)).toBe(true);
      expect(r.rawResponseSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      // the digest must be re-derivable from the stored payload
      const expected =
        "sha256:" +
        createHash("sha256")
          .update(Buffer.from(canonicalize(r.rawResponse), "utf-8"))
          .digest("hex");
      expect(r.rawResponseSha256).toBe(expected);
    }
  });

  it("separates inline reasoning while keeping the original text intact", async () => {
    const records = await runWith(["think-inline"], "think");
    for (const r of records) {
      expect(r.output.text).toContain("<think>");
      expect(r.output.reasoningText).toBe("step one, step two");
      expect(r.output.finalAnswer?.trim()).toBe("The final answer.");
      expect(r.status.qualification).toBe("pass");
    }
  });
});

// --- rubric capture ----------------------------------------------------------

describe("rubric capture", () => {
  it("stores the canonical rubric string and hashes those same bytes", async () => {
    const records = await runWith(["good-stop"], "rubric");
    for (const r of records) {
      expect(r.promptSnapshot.rubric).not.toBeNull();
      const stored = r.promptSnapshot.rubric as string;
      const recomputed = "sha256:" + createHash("sha256").update(Buffer.from(stored, "utf-8")).digest("hex");
      expect(r.rubricHash).toBe(recomputed);
      // and the stored string really is the canonical serialization
      expect(JSON.parse(stored)).toHaveProperty("criteria");
    }
  });

  it("never sends the rubric to the provider", async () => {
    const records = await runWith(["good-stop"], "rubric-leak");
    for (const r of records) {
      expect(r.promptSnapshot.renderedPrompt).not.toContain("criteria");
      expect(r.promptSnapshot.userPrompt).not.toContain("weight");
      expect(r.promptSnapshot.systemPrompt).not.toContain("weight");
    }
  });

  it("captureRubric is stable and matches canonicalize", () => {
    const rubric = {
      criteria: [
        { name: "B", weight: 1, description: "" },
        { name: "A", weight: 2, description: "" },
      ],
    };
    const c = captureRubric(rubric);
    expect(c.canonicalString).toBe(canonicalize(rubric));
    expect(captureRubric(rubric).rubricHash).toBe(c.rubricHash);
  });
});

// --- reference asset ---------------------------------------------------------

describe("reference asset status", () => {
  it("records present with a hash when references.md exists", () => {
    const c = captureReferenceAsset("## Intent\n\nnotes\n");
    expect(c.referenceAssetStatus).toBe("present");
    expect(c.referenceAssetHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(c.referenceAssetSchemaEvidence).toBeNull();
  });

  it("records not_applicable_by_schema with evidence when it does not", () => {
    const c = captureReferenceAsset("");
    expect(c.referenceAssetStatus).toBe("not_applicable_by_schema");
    expect(c.referenceAssetHash).toBeNull();
    expect(c.referenceAssetSchemaEvidence).toContain("benchmark.ts");
  });

  it("takes both branches through the runner", async () => {
    const records = await runWith(["good-stop"], "refs");
    const withRef = records.find((r) => r.benchmarkId === "se-with-ref");
    const noRef = records.find((r) => r.benchmarkId === "sec-no-ref");
    expect(withRef?.referenceAsset.referenceAssetStatus).toBe("present");
    expect(withRef?.referenceAsset.referenceAssetHash).toMatch(/^sha256:/);
    expect(noRef?.referenceAsset.referenceAssetStatus).toBe("not_applicable_by_schema");
    expect(noRef?.referenceAsset.referenceAssetSchemaEvidence).toBeTruthy();
  });
});

// --- legacy content hash stability ------------------------------------------

describe("legacy benchmarkContentHash stability", () => {
  it("does not fold the reference hash into the content-hash preimage", async () => {
    // Real golden assets, with the content hashes recorded in the legacy manifest.
    const known: Record<string, string> = {
      "se-concurrency-atomic-stats-012": "sha256:b2905ae9ed34a4644fb3f92185e55e415167f2b8559cfddbdbb6daecac258c5b",
      "arch-exactly-once-003": "sha256:efecfc2ae16d237e74f275e1d989b3828fbfa246bccc5f8a8da6d0e40960090a",
      "sec-oidc-id-token-validation-001": "sha256:5c0ee69752d1221e27364ddbdee738020c66207415df1f0bc143eb0cff7c9dd9",
      "formal-spec-idempotent-api-003": "sha256:7cdc567c83286aac8d8cdc5a88fe77f2ea238416a5fb727a4e79e29c9eae079b",
    };
    for (const [id, hash] of Object.entries(known)) {
      const loaded = await loadBenchmarkById(id);
      expect(loaded.contentHash).toBe(hash);
      // the reference file is loaded, but must not affect the content hash
      expect(loaded.references.length).toBeGreaterThan(0);
    }
  });

  it("keeps the legacy rubricHash reproducible from the captured rubric", async () => {
    const loaded = await loadBenchmarkById("sec-oidc-id-token-validation-001");
    const c = captureRubric(loaded.rubric);
    expect(c.rubricHash).toBe("sha256:1e23dcefbae43282a9300c6583bbc4406d05657c39bc0db70acf304243d5fe23");
  });
});

// --- report aggregation ------------------------------------------------------

describe("report aggregation", () => {
  it("counts transport success separately from qualification", async () => {
    const records = await runWith(
      ["empty-response", "reasoning-only", "length-truncated", "content-filtered", "good-stop"],
      "report",
    );
    const report = buildCampaignReport({
      spec: spec(["empty-response"]),
      records,
      aggregates: [],
      reviewSet: null,
      generatedAt: NOW(),
    });
    const rt = report.runtime;
    // 5 models × 2 benchmarks = 10 logical runs, all transported fine
    expect(rt.logicalRuns).toBe(10);
    expect(rt.transportOk).toBe(10);
    expect(rt.responseReceived).toBe(10);
    // but only the good-stop model produced a usable answer
    expect(rt.qualified).toBe(2);
    expect(rt.notQualified).toBe(8);
    expect(rt.emptyFinal).toBe(2);
    expect(rt.reasoningOnly).toBe(2);
    expect(rt.truncated).toBe(2);
    expect(rt.filtered).toBe(2);
    expect(rt.finishReasons.stop).toBe(6);
    expect(rt.finishReasons.length).toBe(2);
    expect(rt.finishReasons.content_filter).toBe(2);
  });

  it("counts logical runs and attempts separately", async () => {
    const benchmarks = await loadAllBenchmarks(root);
    const result = await runCampaign({
      spec: spec(["empty-response"]),
      benchmarks,
      resolveBackend: () => new ShapedBackend(),
      outputDir: join(outDir, "attempts"),
      now: NOW,
      maxAttempts: 3,
    });
    // 1 model × 2 benchmarks = 2 logical runs; each retried to the cap
    expect(result.logicalRunCount).toBe(2);
    expect(result.attemptCount).toBe(6);
    for (const r of result.records) {
      expect(r.attemptCount).toBe(3);
      expect(r.attempts.length).toBe(3);
      // every attempt keeps its own cost and failed response
      expect(r.attempts.every((a) => a.cost.estimatedUsd === 0.001)).toBe(true);
      expect(r.attempts.every((a) => a.rawResponse !== null)).toBe(true);
      expect(r.attempts.every((a) => a.status.qualification === "fail")).toBe(true);
    }
  });

  it("stops retrying as soon as an attempt qualifies", async () => {
    const benchmarks = await loadAllBenchmarks(root);
    const result = await runCampaign({
      spec: spec(["good-stop"]),
      benchmarks,
      resolveBackend: () => new ShapedBackend(),
      outputDir: join(outDir, "attempts-ok"),
      now: NOW,
      maxAttempts: 3,
    });
    expect(result.logicalRunCount).toBe(2);
    expect(result.attemptCount).toBe(2);
  });
});
