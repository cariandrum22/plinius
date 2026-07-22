import { describe, it, expect } from "vitest";
import {
  EXPERIMENT_SCHEMA_VERSION,
  isExcludedFromRankings,
  parseExperimentSpec,
  seedForRepetition,
} from "../src/experiment/spec.js";

function base(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    id: "baseline-smoke",
    targets: ["qwen-smoke-vllm"],
    ...overrides,
  };
}

describe("experiment spec", () => {
  it("applies defaults", () => {
    const spec = parseExperimentSpec(base());
    expect(spec.repetitions).toBe(1);
    expect(spec.seedStrategy).toBe("fixed");
    expect(spec.concurrency).toBe(1);
    expect(spec.benchmarks).toBe("all");
    expect(spec.purpose).toBe("ranking");
  });

  it("requires at least one target", () => {
    expect(() => parseExperimentSpec(base({ targets: [] }))).toThrow();
  });

  it("computes seeds by strategy", () => {
    const fixed = parseExperimentSpec(base({ seedStrategy: "fixed", baseSeed: 7 }));
    expect(seedForRepetition(fixed, 0)).toBe(7);
    expect(seedForRepetition(fixed, 3)).toBe(7);

    const varying = parseExperimentSpec(base({ seedStrategy: "varying", baseSeed: 100 }));
    expect(seedForRepetition(varying, 0)).toBe(100);
    expect(seedForRepetition(varying, 2)).toBe(102);
  });

  it("treats infrastructure-validation as excluded from rankings", () => {
    const spec = parseExperimentSpec(base({ purpose: "infrastructure-validation" }));
    expect(isExcludedFromRankings(spec)).toBe(true);
  });

  it("honors an explicit excludeFromRankings flag", () => {
    const spec = parseExperimentSpec(base({ excludeFromRankings: true }));
    expect(isExcludedFromRankings(spec)).toBe(true);
  });
});
