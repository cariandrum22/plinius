import { describe, it, expect } from "vitest";
import {
  BENCHMARK_SCHEMA_VERSION,
  parseBenchmarkDefinition,
} from "../src/suite/schema.js";
import { LoadedBenchmark } from "../src/suite/loader.js";
import { buildCapabilityMatrix, MATRIX_SCHEMA_VERSION } from "../src/matrix/capability.js";
import { BenchmarkRunRecord } from "../src/types/benchmark.js";

function loaded(
  id: string,
  domain: string,
  prototype: boolean,
  qualification?: Record<string, unknown>,
): LoadedBenchmark {
  const def = parseBenchmarkDefinition({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    id,
    version: "1.0.0",
    domain,
    difficulty: "medium",
    title: id,
    prototype,
    ...(qualification ? { qualification } : {}),
  });
  return { definition: def, dir: "", taskText: "t", fixtures: [], references: [], contentHash: "sha256:0" };
}

function record(
  id: string,
  domain: string,
  prototype: boolean,
  opts: { detPass?: boolean; judgeOverall?: number } = {},
): BenchmarkRunRecord {
  const rec: BenchmarkRunRecord = {
    schemaVersion: 2,
    benchmark: { id, contentHash: "sha256:0", domain, prototype },
    targetId: "qwen-smoke-vllm",
    backendId: "local-vllm",
    backendType: "openai-compatible",
    model: "Qwen/Qwen2.5-0.5B-Instruct",
    servedModelName: "Qwen/Qwen2.5-0.5B-Instruct",
    promptProfile: "neutral",
    messages: [],
    sampling: { maxTokens: 100, temperature: 0, topP: 1 },
    timestamp: "2026-01-01T00:00:00Z",
    response: { text: "a sufficiently long candidate answer for testing", latencyMs: 200, usage: { completionTokens: 40 } },
  };
  if (opts.detPass !== undefined) {
    rec.deterministicEvaluations = [
      {
        checkId: "s",
        evaluatorId: "required_sections:s",
        version: "1.0.0",
        authority: "structural",
        blocking: true,
        status: opts.detPass ? "pass" : "fail",
        message: "",
        evidence: {},
      },
    ];
  }
  if (opts.judgeOverall !== undefined) {
    rec.judgeEvaluations = [
      {
        judgeId: "scalar_judge:x",
        judgeType: "scalar",
        authority: "scalar_judge",
        version: "1.0.0",
        rubricScaleMin: 0,
        rubricScaleMax: 5,
        dimensions: [],
        overall: opts.judgeOverall,
        normalizedScore: opts.judgeOverall / 5,
        refusal: false,
        formatValid: true,
        commentary: "",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ];
  }
  return rec;
}

describe("buildCapabilityMatrix", () => {
  it("separates raw and derived dimensions and versions the schema", () => {
    const records = [record("code-001", "coding", false, { detPass: true, judgeOverall: 4.5 })];
    const map = new Map([["code-001", loaded("code-001", "coding", false, { minimumDomainScore: 4 })]]);
    const matrix = buildCapabilityMatrix(records, map);

    expect(matrix.schemaVersion).toBe(MATRIX_SCHEMA_VERSION);
    const entry = matrix.entries[0];
    expect(entry.raw.domains.coding).not.toBeNull();
    expect(entry.derived).toHaveProperty("quality");
    expect(entry.derived).toHaveProperty("reliability");
    expect(entry.derived).toHaveProperty("performance");
    expect(entry.derived).toHaveProperty("cost");
    // performance is derived from usage + latency
    expect(entry.derived.performance.tokensPerSecond).toBeGreaterThan(0);
    // qualifies the coding domain
    expect(entry.qualifiedDomains).toContain("coding");
  });

  it("excludes prototype benchmarks from rankings/qualification", () => {
    const records = [record("arch-001", "architecture", true, { detPass: true, judgeOverall: 5 })];
    const map = new Map([["arch-001", loaded("arch-001", "architecture", true, { minimumDomainScore: 4 })]]);
    const matrix = buildCapabilityMatrix(records, map);
    const entry = matrix.entries[0];

    // Prototype → excluded → no qualified domains despite a perfect score.
    expect(entry.excludedFromRankings).toBe(true);
    expect(entry.qualifiedDomains).toHaveLength(0);
    // But the raw cell is still present for visibility.
    expect(entry.raw.domains.architecture?.excludedBenchmarkCount).toBe(1);
  });

  it("honors an experiment-level exclusion flag", () => {
    const records = [record("code-001", "coding", false, { detPass: true, judgeOverall: 5 })];
    const map = new Map([["code-001", loaded("code-001", "coding", false, { minimumDomainScore: 4 })]]);
    const matrix = buildCapabilityMatrix(records, map, { excludeFromRankings: true });
    expect(matrix.entries[0].excludedFromRankings).toBe(true);
    expect(matrix.entries[0].qualifiedDomains).toHaveLength(0);
  });
});
