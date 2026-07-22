import { describe, it, expect } from "vitest";
import {
  RepetitionSignal,
  aggregate,
  deriveRepetitionSignal,
} from "../src/experiment/verdict.js";
import { numberStats, disagreementRate } from "../src/experiment/stats.js";
import { Qualification } from "../src/suite/schema.js";
import { BenchmarkRunRecord } from "../src/types/benchmark.js";

function signal(overrides: Partial<RepetitionSignal> = {}): RepetitionSignal {
  return {
    backendError: false,
    emptyOutput: false,
    blockingFail: false,
    blockingNotAvailable: false,
    deterministicError: false,
    refusal: false,
    formatValid: true,
    judgeOverallScores: [],
    judgeNormalizedScores: [],
    latencyMs: 100,
    ...overrides,
  };
}

const Q: Qualification = {
  deterministicPassRate: 1,
  minimumDomainScore: 0,
  maximumCatastrophicFailureRate: 0,
  maximumEvaluatorDisagreement: 0.25,
};

describe("numberStats", () => {
  it("computes mean/median/stddev/min/max", () => {
    const s = numberStats([1, 2, 3, 4]);
    expect(s.mean).toBe(2.5);
    expect(s.median).toBe(2.5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(4);
    expect(s.stddev).toBeCloseTo(1.1180, 3);
  });
  it("handles empty input", () => {
    expect(numberStats([]).mean).toBeNull();
  });
});

describe("disagreementRate", () => {
  it("flags runs whose judges spread beyond threshold", () => {
    expect(disagreementRate([[0.1, 0.9], [0.5, 0.55]], 0.2)).toBe(0.5);
  });
  it("is 0 without at least two judges", () => {
    expect(disagreementRate([[0.5]], 0.2)).toBe(0);
  });
});

describe("aggregate", () => {
  it("qualifies when all thresholds pass", () => {
    const signals = [
      signal({ judgeOverallScores: [4.5], judgeNormalizedScores: [0.9] }),
      signal({ judgeOverallScores: [4.2], judgeNormalizedScores: [0.84] }),
    ];
    const result = aggregate(signals, { ...Q, minimumDomainScore: 4 });
    expect(result.status).toBe("qualified");
    expect(result.deterministicPassRate).toBe(1);
    expect(result.catastrophicFailureRate).toBe(0);
  });

  it("disqualifies on a blocking failure", () => {
    const result = aggregate([signal({ blockingFail: true })], Q);
    expect(result.status).toBe("disqualified");
    expect(result.catastrophicFailureRate).toBe(1);
  });

  it("is inconclusive when a required verifier is not_available", () => {
    const result = aggregate([signal({ blockingNotAvailable: true })], Q);
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toMatch(/not_available/);
  });

  it("is infrastructure_error when every repetition fails on infrastructure", () => {
    const result = aggregate(
      [signal({ backendError: true }), signal({ backendError: true })],
      Q,
    );
    expect(result.status).toBe("infrastructure_error");
    expect(result.infrastructureFailureRate).toBe(1);
  });

  it("separates catastrophic from infrastructure failures", () => {
    // one infra rep + one catastrophic rep: infra excluded from catastrophic rate
    const result = aggregate(
      [signal({ backendError: true }), signal({ blockingFail: true })],
      Q,
    );
    expect(result.infrastructureFailureRate).toBe(0.5);
    // decidable = 1 (the blockingFail rep) → catastrophic rate over decidable = 1
    expect(result.catastrophicFailureRate).toBe(1);
    expect(result.status).toBe("disqualified");
  });

  it("is inconclusive when a minimum domain score is required but no judges ran", () => {
    const result = aggregate([signal()], { ...Q, minimumDomainScore: 4 });
    expect(result.status).toBe("inconclusive");
  });
});

describe("deriveRepetitionSignal", () => {
  it("marks a backend error as infrastructure", () => {
    const record = {
      schemaVersion: 2,
      benchmark: { id: "x", contentHash: "sha256:0" },
      targetId: "t",
      backendId: "b",
      backendType: "openai-compatible",
      model: "m",
      servedModelName: "m",
      promptProfile: "none",
      messages: [],
      sampling: { maxTokens: 10, temperature: 0, topP: 1 },
      timestamp: "2026-01-01T00:00:00Z",
      error: { kind: "timeout", message: "timed out" },
    } as BenchmarkRunRecord;
    const s = deriveRepetitionSignal(record);
    expect(s.backendError).toBe(true);
  });

  it("derives blocking failure from deterministic evaluations", () => {
    const record = {
      schemaVersion: 2,
      benchmark: { id: "x", contentHash: "sha256:0" },
      targetId: "t",
      backendId: "b",
      backendType: "openai-compatible",
      model: "m",
      servedModelName: "m",
      promptProfile: "none",
      messages: [],
      sampling: { maxTokens: 10, temperature: 0, topP: 1 },
      timestamp: "2026-01-01T00:00:00Z",
      response: { text: "some sufficiently long answer here", latencyMs: 50 },
      deterministicEvaluations: [
        {
          checkId: "c",
          evaluatorId: "command:c",
          version: "1.0.0",
          authority: "executable",
          blocking: true,
          status: "fail",
          message: "exit 1",
          evidence: {},
        },
      ],
    } as BenchmarkRunRecord;
    const s = deriveRepetitionSignal(record);
    expect(s.blockingFail).toBe(true);
    expect(s.backendError).toBe(false);
  });
});
