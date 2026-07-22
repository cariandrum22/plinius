import { describe, it, expect } from "vitest";
import { ScalarJudge, looksLikeRefusal } from "../src/evaluation/judge.js";
import { applyJudgesToRecord } from "../src/evaluation/judge-apply.js";
import {
  InferenceBackend,
  InferenceRequest,
  InferenceResponse,
} from "../src/types/inference.js";
import { RubricSchema } from "../src/suite/schema.js";
import { BenchmarkRunRecord } from "../src/types/benchmark.js";

class StubJudgeBackend implements InferenceBackend {
  readonly id = "stub-judge";
  readonly type = "openai-compatible";
  constructor(private readonly reply: string) {}
  async complete(_req: InferenceRequest): Promise<InferenceResponse> {
    return { text: this.reply, latencyMs: 5 };
  }
}

const rubric = RubricSchema.parse({
  scaleMin: 0,
  scaleMax: 5,
  dimensions: [
    { id: "precision", weight: 2 },
    { id: "structure", weight: 1 },
  ],
});

describe("looksLikeRefusal", () => {
  it("flags short and refusal-y outputs", () => {
    expect(looksLikeRefusal("no")).toBe(true);
    expect(looksLikeRefusal("I can't help with that request at all.")).toBe(true);
    expect(looksLikeRefusal("Here is a detailed and complete architectural answer.")).toBe(false);
  });
});

describe("ScalarJudge", () => {
  it("parses judge JSON and computes a weighted normalized score", async () => {
    const backend = new StubJudgeBackend(
      '{"dimensions":[{"id":"precision","score":4},{"id":"structure","score":2}],"refusal":false,"commentary":"ok"}',
    );
    const judge = new ScalarJudge(backend);
    const result = await judge.evaluate({
      taskText: "task",
      expectedOutputFormat: "prose",
      candidateOutput: "a thorough and complete answer to the task at hand",
      rubric,
    });
    expect(result.formatValid).toBe(true);
    // weighted: (4*2 + 2*1)/3 = 3.333...
    expect(result.overall).toBeCloseTo(10 / 3, 5);
    expect(result.normalizedScore).toBeCloseTo(10 / 15, 5);
    expect(result.authority).toBe("scalar_judge");
  });

  it("marks invalid judge output as not format-valid", async () => {
    const judge = new ScalarJudge(new StubJudgeBackend("totally not json"));
    const result = await judge.evaluate({
      taskText: "t",
      expectedOutputFormat: "",
      candidateOutput: "a reasonably long candidate answer here",
      rubric,
    });
    expect(result.formatValid).toBe(false);
  });
});

describe("applyJudgesToRecord (decoupled re-application)", () => {
  it("attaches judge evaluations to a stored record", async () => {
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
      response: { text: "a complete and thorough candidate answer", latencyMs: 5 },
    } as BenchmarkRunRecord;

    const backend = new StubJudgeBackend('{"dimensions":[{"id":"precision","score":5}],"refusal":false}');
    const updated = await applyJudgesToRecord(
      record,
      { taskText: "t", expectedOutputFormat: "", rubric },
      [new ScalarJudge(backend)],
    );
    expect(updated.judgeEvaluations).toHaveLength(1);
    expect(updated.judgeEvaluations?.[0].overall).toBe(5);
  });

  it("returns the record unchanged when there is no response", async () => {
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
      error: { message: "boom" },
    } as BenchmarkRunRecord;
    const updated = await applyJudgesToRecord(
      record,
      { taskText: "t", expectedOutputFormat: "", rubric },
      [new ScalarJudge(new StubJudgeBackend("{}"))],
    );
    expect(updated.judgeEvaluations).toBeUndefined();
  });
});
