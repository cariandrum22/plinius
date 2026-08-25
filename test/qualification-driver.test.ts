/**
 * Qualification driver — offline record-assembly tests (authority finding A-04).
 *
 * The driver used to store a thin `attempts[0]` (index, timestamp, status, one
 * digest, latency, error) while building the record's headline independently, so
 * an attempt's own output, raw body, cost, routing and provenance were not
 * recoverable from the attempt itself. These tests exercise the pure builders
 * that now assemble a COMPLETE attempt and derive the headline from the final
 * attempt. They are fully offline: no network, no credentials, no clock.
 *
 * maxAttempts stays 1 for this campaign — there is no retry or continuation
 * mode. The builders still support several attempts, and the headline-derivation
 * contract is what these tests pin down.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "crypto";

import {
  buildQualificationAttempt,
  buildQualificationRunRecord,
  QUALIFICATION_RUN_SCHEMA_VERSION,
  QualificationAttemptFacts,
  QualificationRecordHeader,
} from "../qualification-driver.mjs";
import { canonicalize } from "../src/suite/hash.js";

const TS = "2026-08-22T00:00:00.000Z";

/** An OpenAI-shaped provider payload. */
function rawPayload(
  content: string | null,
  finish: string,
  extraMessage: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "gen-abc123",
    model: "vendor/model-x",
    created: 1_700_000_000,
    provider: "VendorCloud",
    choices: [{ finish_reason: finish, message: { role: "assistant", content, ...extraMessage } }],
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
  };
}

function facts(over: Partial<QualificationAttemptFacts>): QualificationAttemptFacts {
  return {
    attemptIndex: 0,
    timestamp: TS,
    backend: "openrouter",
    requestedSlug: "vendor/model-x",
    endpoint: "https://openrouter.ai/api/v1",
    raw: rawPayload("The final answer.", "stop"),
    text: "The final answer.",
    rawFinish: "stop",
    transportError: null,
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
    latencyMs: 1234,
    cost: { costModel: "METERED", actualCostUsd: 0.0042, lookup: { lookupOk: true, generationId: "gen-abc123" } },
    routing: { provider: "VendorCloud", responseModelId: "vendor/model-x", generationId: "gen-abc123" },
    ...over,
  };
}

function header(over: Partial<QualificationRecordHeader> = {}): QualificationRecordHeader {
  return {
    runId: "run-deadbeefdeadbeef",
    sentinel: false,
    orderIndex: 3,
    benchmarkId: "sec-oidc-id-token-validation-001",
    benchmarkVersion: "1.0.0",
    benchmarkContentHash: "sha256:aaaa",
    rubricHash: "sha256:bbbb",
    referenceAsset: { referenceAssetStatus: "present", referenceAssetHash: "sha256:cccc" },
    category: "security",
    golden: true,
    backend: "openrouter",
    requestedSlug: "vendor/model-x",
    resolvedSlug: "vendor/model-x",
    substitutionUsed: false,
    fallbackUsed: false,
    endpoint: "https://openrouter.ai/api/v1",
    timestamp: TS,
    promptSnapshot: { promptId: "prompt-1" },
    sampling: { maxTokens: 8192, temperature: 0, topP: 1, seed: 1 },
    ...over,
  };
}

/** Every top-level field an attempt must always carry, present (defined). */
function assertAttemptComplete(a: ReturnType<typeof buildQualificationAttempt>): void {
  for (const key of [
    "attemptIndex",
    "timestamp",
    "status",
    "output",
    "rawResponse",
    "rawResponseSha256",
    "rawResponseBytes",
    "finishReasonMapping",
    "finishReasonTable",
    "metrics",
    "cost",
    "routing",
    "generationProvenance",
    "executionProvenance",
    "error",
  ]) {
    expect(a, `attempt is missing "${key}"`).toHaveProperty(key);
    expect((a as Record<string, unknown>)[key], `attempt "${key}" is undefined`).not.toBeUndefined();
  }
  // The four independent statuses are all present.
  for (const s of ["transport", "response", "finalCompleteness", "qualification", "failureReasons"]) {
    expect(a.status).toHaveProperty(s);
  }
  // Every normalized output field is present (may be null, never undefined).
  for (const o of [
    "text",
    "finishReason",
    "reasoningText",
    "reasoningSource",
    "finalAnswer",
    "finalAnswerSource",
    "finalAnswerIsEmpty",
    "reasoningOnly",
    "normalizerError",
  ]) {
    expect(a.output).toHaveProperty(o);
    expect((a.output as Record<string, unknown>)[o]).not.toBeUndefined();
  }
  // Metrics carry both latency and usage.
  expect(a.metrics).toHaveProperty("latencyMs");
  expect(a.metrics).toHaveProperty("usage");
}

describe("qualification driver — complete attempt records", () => {
  it("captures a complete attempt for a qualifying stop response", () => {
    const a = buildQualificationAttempt(facts({}));
    assertAttemptComplete(a);
    expect(a.status.qualification).toBe("pass");
    expect(a.output.finalAnswer).toBe("The final answer.");
    expect(a.output.finalAnswerIsEmpty).toBe(false);
    // raw body, digest and byte length are all retained
    expect(a.rawResponse).not.toBeNull();
    expect(a.rawResponseSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(typeof a.rawResponseBytes).toBe("number");
    // cost and its lookup are retained
    expect(a.cost.actualCostUsd).toBe(0.0042);
    expect(a.cost.lookup).toBeTruthy();
    // finish reason mapping (raw + canonical) and the table are retained
    expect(a.finishReasonMapping.raw).toBe("stop");
    expect(a.finishReasonMapping.canonical).toBe("stop");
    expect(a.finishReasonTable.stop).toBe("stop");
    // generation + execution provenance carry the request id and model
    expect(a.generationProvenance.generationId).toBe("gen-abc123");
    expect(a.generationProvenance.responseModelId).toBe("vendor/model-x");
    expect(a.executionProvenance.requestId).toBe("gen-abc123");
    expect(a.executionProvenance.endpoint).toBe("https://openrouter.ai/api/v1");
  });

  it("keeps a full attempt record for empty, reasoning-only and filtered responses", () => {
    const empty = buildQualificationAttempt(facts({ raw: rawPayload("", "stop"), text: "" }));
    assertAttemptComplete(empty);
    expect(empty.status.qualification).toBe("fail");
    expect(empty.status.finalCompleteness).toBe("empty_final");
    expect(empty.output.finalAnswerIsEmpty).toBe(true);
    expect(empty.rawResponseSha256).toMatch(/^sha256:/); // body still captured

    const reasoning = buildQualificationAttempt(
      facts({ raw: rawPayload(null, "stop", { reasoning: "I weighed the options." }), text: null }),
    );
    assertAttemptComplete(reasoning);
    expect(reasoning.status.finalCompleteness).toBe("reasoning_only");
    expect(reasoning.output.reasoningText).toBe("I weighed the options.");
    expect(reasoning.output.reasoningOnly).toBe(true);
    expect(reasoning.status.qualification).toBe("fail");

    const filtered = buildQualificationAttempt(
      facts({ raw: rawPayload("", "content_filter"), text: "", rawFinish: "content_filter" }),
    );
    assertAttemptComplete(filtered);
    expect(filtered.finishReasonMapping.canonical).toBe("content_filter");
    expect(filtered.status.finalCompleteness).toBe("filtered");
    expect(filtered.status.qualification).toBe("fail");
  });

  it("records a transport-failure attempt with no borrowed provenance or body, and does not drop it", () => {
    const a = buildQualificationAttempt(
      facts({
        raw: null,
        text: null,
        rawFinish: null,
        transportError: { kind: "timeout", message: "deadline exceeded" },
        cost: { costModel: "METERED", actualCostUsd: null },
        routing: null,
      }),
    );
    assertAttemptComplete(a); // still a complete record — nothing is missing
    expect(a.error).toEqual({ kind: "timeout", message: "deadline exceeded" });
    expect(a.status.transport).toBe("failed");
    expect(a.rawResponse).toBeNull();
    expect(a.rawResponseSha256).toBeNull();
    expect(a.rawResponseBytes).toBeNull();
    // a failed transport borrows no request id, model id, or provider
    expect(a.generationProvenance.generationId).toBeNull();
    expect(a.generationProvenance.responseModelId).toBeNull();
    expect(a.generationProvenance.provider).toBeNull();
    expect(a.executionProvenance.requestId).toBeNull();
    expect(a.executionProvenance.endpoint).toBeNull();
  });

  it("re-derives the raw response digest from the stored payload", () => {
    const a = buildQualificationAttempt(facts({}));
    const expected =
      "sha256:" + createHash("sha256").update(Buffer.from(canonicalize(a.rawResponse), "utf-8")).digest("hex");
    expect(a.rawResponseSha256).toBe(expected);
  });
});

describe("qualification driver — headline derived from the final attempt", () => {
  it("derives every headline field from attempt 0 (the only attempt)", () => {
    const a = buildQualificationAttempt(facts({}));
    const record = buildQualificationRunRecord(header(), [a]);

    expect(record.schemaVersion).toBe(QUALIFICATION_RUN_SCHEMA_VERSION);
    expect(record.schemaVersion).toBe(2);
    expect(record.attemptCount).toBe(1);
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]).toBe(a);

    // headline equals the final attempt, field by field
    expect(record.output).toBe(a.output);
    expect(record.rawResponse).toBe(a.rawResponse);
    expect(record.rawResponseSha256).toBe(a.rawResponseSha256);
    expect(record.rawResponseBytes).toBe(a.rawResponseBytes);
    expect(record.cost).toBe(a.cost);
    expect(record.routing).toBe(a.routing);
    expect(record.status).toBe(a.status);
    expect(record.finishReasonMapping).toBe(a.finishReasonMapping);
    expect(record.generationProvenance).toBe(a.generationProvenance);
    expect(record.executionProvenance).toBe(a.executionProvenance);
    expect(record.error).toBe(a.error);
  });

  it("carries no collapsed succeeded/failed field and throws on zero attempts", () => {
    const record = buildQualificationRunRecord(header(), [buildQualificationAttempt(facts({}))]);
    expect(record).not.toHaveProperty("succeeded");
    expect(record).not.toHaveProperty("failed");
    expect(() => buildQualificationRunRecord(header(), [])).toThrow(/no attempts/);
  });
});
