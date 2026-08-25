/**
 * Diagnostic-continuation driver — offline tests (Stage C1 r3).
 *
 * Exercise EXTERNAL behavior with a mock catalog preflight AND the REAL production
 * preflight / dispatch adapter driven through an injectable fetch, plus real
 * temp-directory journal/record/summary/manifest fixtures. No network, no
 * credentials, no live clock. These pin down: catalog raw-body preservation +
 * re-derived digest + freshness (F01/C1-R2-F01); the local vLLM binding gate
 * (C1-R2-F02); wire-request capture + response/routing drift, and HTTP-error /
 * invalid-body / no-choice as RECEIVED (not transport) outcomes (C1-R2-F03);
 * strict resume completeness — attempt-digest / cost / provenance / headline
 * forgery, sticky continuation-validation failures, and a runs-directory allowlist
 * with no stray entries (C1-R2-F04); and durable, fail-closed finalize with an
 * immutable per-invocation runtime manifest chain (C1-R2-F05). The four Authority
 * adversarial cases (wrong-model accept, tampered-attempt resume, unauthorized run
 * entry, durability-failure concealment) are reproduced as negative fixtures.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, chmodSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";

import {
  runContinuation,
  buildFrozenOrder,
  resolveDriverMode,
  verifyHistoricalDigestsFromFiles,
  defaultBuildRequest,
  buildQualificationAttempt,
  buildQualificationRunRecord,
  resolveLocalTarget,
  livePreflight,
  dispatchViaBackend,
  loadExpectedLocalBindingsFromParent,
  makeLocalBindingProbe,
  PARENT_LOCAL_ARTIFACT_DIGESTS,
  CONTINUATION_RUN_SCHEMA_VERSION,
  CONTINUATION_STAGE_ID,
  CATALOG_FRESHNESS_SECONDS,
  generationCost,
  loadExpectedLocalRuntimesFromParent,
  type LocalPreflightResult,
  type CellPlan,
  type GenerateFacts,
  type RequestBody,
  type TargetResolution,
  type PreflightResult,
  type ExpectedLocalBinding,
  type LocalTargetBinding,
} from "../qualification-driver.mjs";
import {
  deriveContinuationPlan,
  classifyResume,
  isRecordComplete,
  validateRecordComplete,
  recordTerminalBlocker,
  resumeWireConsistency,
  resumeReDerive,
  deriveResponseOutcome,
  CONTINUATION_EXTENSION_SCHEMA_VERSION,
  sentinelAccepted,
  planConsistency,
  computeContinuationValidation,
  DIAGNOSTIC_COMPLETE_WITH_PROVIDER_POLICY_FAILURE,
  type Cell,
  type PersistedRecordShape,
} from "../src/continuation/plan.js";
import {
  finalizeArtifact,
  verifyReferencedArtifact,
  verifyRuntimeManifestChain,
  computePlanDigest,
  RUNTIME_MANIFEST_SCHEMA_VERSION,
  acquireInvocationLock,
  releaseInvocationLock,
} from "../src/continuation/journal.js";
import {
  deriveExpectedLocalBindings,
  buildObservedBinding,
  weightManifestDigest,
  servingConfigDigest,
  canonicalJson,
  weightFileCollatorReport,
  LOCAL_BINDING_FRESHNESS_SECONDS,
  type RuntimeObservation,
  type WeightFileEntry,
} from "../src/continuation/local-runtime.js";
import {
  observeLocalRuntime,
  makeProductionObserver,
  deriveExpectedLocalRuntimes,
  type ExpectedLocalRuntime,
  type ObserverFs,
  type ObserverDeps,
  type CommandResult,
  type CommandRunner,
} from "../src/continuation/runtime-observer.js";
import { hashRawResponse } from "../src/completeness/assets.js";
import { encodeWireBody, verifyWireBody, reDeriveResponseIdentity, reDeriveCost, reDeriveRequestIdentity, verifyCostLookupChain, sanitizeHeaders } from "../src/continuation/wire.js";
import type { AttemptWireEvidence, WireBodyPreimage, CostLookupWireEvidence, CostLookupPollEvidence } from "../src/continuation/wire.js";
import { parseEngineArgs, decodeHfSnapshot, normalizeWeightRel } from "../src/continuation/runtime-observer.js";
import { CONTENT_ADDRESSED_KINDS } from "../src/continuation/journal.js";

const TS = "2026-08-22T00:00:00.000Z";
const CAMPAIGN_ID = "plinius-qualification-2026-08-22-v1";
const OPENAI_SENTINEL: Cell = { target: "openai/gpt-5.6-sol-pro", benchmark: "sec-oidc-id-token-validation-001", sentinel: true };
const HISTORICAL: Cell = { target: "anthropic/claude-opus-5", benchmark: "sec-oidc-id-token-validation-001", sentinel: true };

function sha256(body: string): string {
  return "sha256:" + createHash("sha256").update(Buffer.from(body, "utf-8")).digest("hex");
}
function bareSha(body: string): string {
  return createHash("sha256").update(Buffer.from(body, "utf-8")).digest("hex");
}
/** Acquire an invocation lock on `r`, run `fn`, always release (F05 required-lock API). */
function withLock<T>(r: string, fn: (l: ReturnType<typeof acquireInvocationLock>) => T): T {
  const l = acquireInvocationLock(r, { stageId: "test", invocationId: "test#0", startedAt: TS });
  try {
    return fn(l);
  } finally {
    releaseInvocationLock(l);
  }
}

const OK_DIGESTS = () => ({
  ok: true,
  details: [{ name: "historicalRun", path: "h", expected: "z", actual: "z", match: true }],
});

function runIdFor(orderIndex: number, cell: Cell): string {
  return `run-${String(orderIndex).padStart(2, "0")}-${cell.target.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;
}

function planCellSync(cell: Cell, orderIndex: number): CellPlan {
  const runId = runIdFor(orderIndex, cell);
  const maxTokens = 8192;
  const sampling = { maxTokens, temperature: 0, topP: 1, seed: 1, temperatureSent: true, topPSent: true, seedSent: true };
  return {
    runId,
    orderIndex,
    requestedSlug: cell.target,
    backend: "openrouter",
    benchmarkId: cell.benchmark,
    endpoint: "https://openrouter.ai/api/v1",
    maxTokens,
    sampling,
    header: {
      runId,
      sentinel: cell.sentinel,
      orderIndex,
      benchmarkId: cell.benchmark,
      benchmarkVersion: "1.0.0",
      benchmarkContentHash: "sha256:aaaa",
      rubricHash: "sha256:bbbb",
      referenceAsset: { referenceAssetStatus: "present", referenceAssetHash: "sha256:cccc" },
      category: "security",
      golden: true,
      backend: "openrouter",
      requestedSlug: cell.target,
      resolvedSlug: cell.target,
      substitutionUsed: false,
      fallbackUsed: false,
      endpoint: "https://openrouter.ai/api/v1",
      promptSnapshot: { promptId: `prompt-${orderIndex}` },
      sampling,
    },
  };
}
const mockPlanCell = (cell: Cell, orderIndex: number): Promise<CellPlan> => Promise.resolve(planCellSync(cell, orderIndex));

function continuationTargets(): string[] {
  return [...new Set(deriveContinuationPlan(buildFrozenOrder()).continuation.map((c) => c.target))];
}
function exactResolution(slug: string): TargetResolution {
  return { requestedSlug: slug, backend: "openrouter", resolvedSlug: slug, resolvedExactly: true, substitutionUsed: false, fallbackUsed: false };
}
function mockPreflight(opts?: {
  resolution?: TargetResolution[];
  ok?: boolean;
  freshnessOk?: boolean;
  reasons?: string[];
  rawBody?: string;
  rawBodySha256?: string;
  byteLength?: number;
}): () => Promise<PreflightResult> {
  const rawBody = opts?.rawBody ?? '{"data":[]}';
  return () =>
    Promise.resolve({
      ok: opts?.ok ?? true,
      reasons: opts?.reasons ?? [],
      catalog: {
        fetchedAtUtc: TS,
        endpoint: "https://openrouter.ai/api/v1/models",
        httpStatus: 200,
        rawBodySha256: opts?.rawBodySha256 ?? sha256(rawBody),
        byteLength: opts?.byteLength ?? Buffer.byteLength(rawBody, "utf-8"),
        requestStartedUtc: TS,
        responseReceivedUtc: TS,
        evaluatedAtUtc: TS,
        httpHeaders: {},
        ageSeconds: 0,
        freshnessThresholdSeconds: 1800,
        freshnessOk: opts?.freshnessOk ?? true,
      },
      rawBody,
      resolution: opts?.resolution ?? continuationTargets().map(exactResolution),
      localBindings: [],
    });
}

/** Build the byte-preserving wire evidence a hosted attempt records (F02). */
/** The frozen benchmark messages the mock request wire carries (shared with resume plans). */
const WIRE_MESSAGES = [
  { role: "system", content: "SYS" },
  { role: "user", content: "USER" },
];
/** The exact OpenAI-format request body the real backend transmits (max_tokens / top_p / messages). */
function toWireReq(req: RequestBody): Record<string, unknown> {
  return { model: req.model, messages: WIRE_MESSAGES, max_tokens: req.maxTokens, temperature: req.temperature, top_p: req.topP, seed: req.seed };
}
function wireFor(
  req: RequestBody,
  rawObj: unknown,
  ids: { genId: string; model: string; provider: string; cost: number },
): AttemptWireEvidence {
  return {
    request: { url: "https://openrouter.ai/api/v1/chat/completions", method: "POST", body: encodeWireBody(JSON.stringify(toWireReq(req))) },
    response: { httpStatus: 200, receivedAtUtc: TS, headers: { "content-type": "application/json" }, body: encodeWireBody(JSON.stringify(rawObj)) },
    costLookup: {
      polls: [
        {
          pollIndex: 0,
          kind: "http_response",
          url: `https://openrouter.ai/api/v1/generation?id=${ids.genId}`,
          method: "GET",
          receivedAtUtc: TS,
          httpStatus: 200,
          headers: { "content-type": "application/json" },
          body: encodeWireBody(JSON.stringify({ data: { id: ids.genId, model: ids.model, provider_name: ids.provider, total_cost: ids.cost } })),
          jsonParsed: true,
          jsonError: null,
          dataPresent: true,
        },
      ],
      finalOk: true,
    },
  };
}
function qualifyingFacts(cell: Cell, plan: CellPlan, req: RequestBody): GenerateFacts {
  const genId = `gen-${plan.runId}`;
  const raw = {
    id: genId,
    model: cell.target,
    created: 1_700_000_000,
    provider: "VendorCloud",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "The final answer." } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  const respPre = encodeWireBody(JSON.stringify(raw));
  return {
    raw,
    text: "The final answer.",
    rawFinish: "stop",
    transportError: null,
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    latencyMs: 100,
    cost: { costModel: "METERED", actualCostUsd: 0.001, lookup: { lookupOk: true, generationId: genId } },
    routing: { provider: "VendorCloud", responseModelId: cell.target, generationId: genId },
    requestSent: req,
    requestWireSha256: encodeWireBody(JSON.stringify(req)).sha256,
    requestWireBytes: encodeWireBody(JSON.stringify(req)).bytes,
    responseWireSha256: respPre.sha256,
    responseWireBytes: respPre.bytes,
    responseModelId: cell.target,
    responseGenerationId: genId,
    responseProvider: "VendorCloud",
    generationLookupModelId: cell.target,
    generationLookupGenerationId: genId,
    generationLookupProvider: "VendorCloud",
    wire: wireFor(req, raw, { genId, model: cell.target, provider: "VendorCloud", cost: 0.001 }),
  };
}
function filteredFacts(cell: Cell, plan: CellPlan, req: RequestBody): GenerateFacts {
  const genId = `gen-${plan.runId}`;
  const raw = {
    id: genId,
    model: cell.target,
    created: 1_700_000_000,
    provider: "VendorCloud",
    choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: "" } }],
    usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
  };
  const respPre = encodeWireBody(JSON.stringify(raw));
  return {
    ...qualifyingFacts(cell, plan, req),
    raw,
    text: "",
    rawFinish: "content_filter",
    // The headline usage must equal the wire raw usage (the resume re-derivation
    // deep-equals them) — a content-filter response has 0 completion tokens.
    usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    responseWireSha256: respPre.sha256,
    responseWireBytes: respPre.bytes,
    wire: wireFor(req, raw, { genId, model: cell.target, provider: "VendorCloud", cost: 0.001 }),
  };
}

function recordingGenerate(fn: (cell: Cell, plan: CellPlan, req: RequestBody, i: number) => GenerateFacts) {
  const history: Cell[] = [];
  const gen = (cell: Cell, plan: CellPlan, req: RequestBody): Promise<GenerateFacts> => {
    const i = history.length;
    history.push(cell);
    return Promise.resolve(fn(cell, plan, req, i));
  };
  return { gen, history };
}

/** A fully-formed schema-v2 record built by the real builders (passes strict validation). */
function makeCompleteRecord(cell: Cell, orderIndex: number, qualification: "pass" | "fail"): Record<string, unknown> {
  const plan = planCellSync(cell, orderIndex);
  const req = defaultBuildRequest(cell, plan, exactResolution(cell.target));
  const facts = qualification === "pass" ? qualifyingFacts(cell, plan, req) : filteredFacts(cell, plan, req);
  const attempt = buildQualificationAttempt({
    attemptIndex: 0,
    timestamp: TS,
    backend: plan.backend,
    requestedSlug: plan.requestedSlug,
    endpoint: plan.endpoint,
    raw: facts.raw,
    text: facts.text,
    rawFinish: facts.rawFinish,
    transportError: facts.transportError,
    usage: facts.usage,
    latencyMs: facts.latencyMs,
    cost: facts.cost,
    routing: facts.routing,
    wire: facts.wire,
  });
  const rec = buildQualificationRunRecord(
    { ...plan.header, timestamp: TS, resolvedSlug: cell.target, substitutionUsed: false, fallbackUsed: false },
    [attempt],
  );
  return {
    ...rec,
    continuationExtensionSchemaVersion: CONTINUATION_EXTENSION_SCHEMA_VERSION,
    continuationValidation: { ok: true, reasons: [] },
    responseModelId: facts.responseModelId,
    responseGenerationId: facts.responseGenerationId,
    responseProvider: facts.responseProvider,
    responseWireSha256: facts.responseWireSha256,
    responseWireBytes: facts.responseWireBytes,
    wire: facts.wire,
    catalogArtifactRef: { file: `catalog-preflight-${"0".repeat(64)}.json`, sha256: `sha256:${"0".repeat(64)}` },
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plinius-cont-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const base = (over: Partial<Parameters<typeof runContinuation>[0]>) => ({
  outputRoot: root,
  verifyHistoricalDigests: OK_DIGESTS,
  preflight: mockPreflight(),
  planCell: mockPlanCell,
  now: () => TS,
  ...over,
});

async function freshAll(fn: (cell: Cell, plan: CellPlan, req: RequestBody, i: number) => GenerateFacts = qualifyingFacts) {
  const { gen, history } = recordingGenerate(fn);
  const res = await runContinuation(base({ generate: gen }));
  return { res, history };
}
/**
 * Simulate a resume from an invocation that CRASHED before its finalize step: keep
 * only the named records/intents, and remove the summary + runtime manifest (both
 * written last). A partially-completed prior invocation therefore has no manifest,
 * so the surviving records are validated per-record on resume (not chain-bound).
 */
function keepOnly(root: string, keepRunIds: string[]): void {
  const runsDir = join(root, "runs");
  const keep = new Set<string>();
  for (const id of keepRunIds) {
    keep.add(`${id}.json`);
    keep.add(`${id}.intent.json`);
  }
  for (const f of readdirSync(runsDir)) if (!keep.has(f)) rmSync(join(runsDir, f));
  dropManifests(root);
}
/** Remove the summary + runtime manifest (written last) — simulate a pre-finalize crash. */
function dropManifests(root: string): void {
  for (const f of readdirSync(root)) {
    if (/^continuation-(summary|runtime-manifest)-[0-9a-f]{64}\.json$/.test(f)) rmSync(join(root, f));
  }
}

// --- mock fetch (real Response objects; global Response in node 22) ------------
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("frozen order, plan and mode gate", () => {
  it("frozen order is 24 with two sentinels first; continuation is 23", () => {
    const order = buildFrozenOrder();
    expect(order).toHaveLength(24);
    expect(order[0]).toMatchObject({ target: HISTORICAL.target, sentinel: true });
    const { historicalFixed, continuation } = deriveContinuationPlan(order);
    expect(historicalFixed.target).toBe(HISTORICAL.target);
    expect(continuation).toHaveLength(23);
    expect(continuation[0]).toMatchObject({ target: OPENAI_SENTINEL.target, benchmark: OPENAI_SENTINEL.benchmark });
  });
  it("mode gate fails closed on absent/unknown", () => {
    expect(() => resolveDriverMode(undefined)).toThrow(/unknown or absent/);
    expect(() => resolveDriverMode("bogus")).toThrow();
    expect(resolveDriverMode("default")).toBe("default");
    expect(() => resolveDriverMode("diagnostic-continuation-r1")).toThrow(/retired/);
    expect(resolveDriverMode("diagnostic-one-shot-r1")).toBe("diagnostic-one-shot-r1");
  });
});

describe("F01 catalog resolution (driver)", () => {
  it("verifies raw sha-256 from actual files", () => {
    const f = join(root, "s.json");
    writeFileSync(f, "hello");
    const sha = createHash("sha256").update(readFileSync(f)).digest("hex");
    expect(verifyHistoricalDigestsFromFiles({ parentBundlePath: f, parentBundleSha256: sha, frozenDefinitionPath: f, frozenDefinitionSha256: sha, historicalRunPath: f, historicalRunSha256: sha }).ok).toBe(true);
    expect(verifyHistoricalDigestsFromFiles({ parentBundlePath: f, parentBundleSha256: "bad", frozenDefinitionPath: f, frozenDefinitionSha256: sha, historicalRunPath: f, historicalRunSha256: sha }).ok).toBe(false);
  });
  it("dispatches 4/4 exact-resolution happy path (23 cells) and persists a re-derivable catalog artifact", async () => {
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen }));
    const expected = deriveContinuationPlan(buildFrozenOrder()).continuation;
    expect(history.map((c) => `${c.target}|${c.benchmark}`)).toEqual(expected.map((c) => `${c.target}|${c.benchmark}`));
    expect(res.summary.executedThisInvocation).toBe(23);
    expect(res.summary.overallStatus).toBe(DIAGNOSTIC_COMPLETE_WITH_PROVIDER_POLICY_FAILURE);
    const catalogFile = readdirSync(root).find((f) => /^catalog-preflight-[0-9a-f]{64}\.json$/.test(f));
    expect(catalogFile).toBeDefined();
    const art = JSON.parse(readFileSync(join(root, catalogFile as string), "utf-8"));
    // the raw body is stored and its digest re-derives to the recorded value
    expect(sha256(art.rawBody)).toBe(art.catalog.rawBodySha256);
  });
  it("stops at dispatch 0 when a hosted target is missing/aliased (no dispatch)", async () => {
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const bad = continuationTargets().map((s, i) => (i === 0 ? { ...exactResolution(s), resolvedSlug: null, resolvedExactly: false } : exactResolution(s)));
    const res = await runContinuation(base({ generate: gen, preflight: mockPreflight({ resolution: bad, ok: false, reasons: ["unresolved hosted"] }) }));
    expect(history).toHaveLength(0);
    expect(res.stopped).toMatch(/^catalog_preflight_failed/);
  });
  it("stops at dispatch 0 when the catalog is stale (no dispatch)", async () => {
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, preflight: mockPreflight({ freshnessOk: false }) }));
    expect(history).toHaveLength(0);
    expect(res.stopped).toBe("catalog_stale");
  });
  it("stops at dispatch 0 when the stored raw body does not re-derive the recorded digest", async () => {
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, preflight: mockPreflight({ rawBodySha256: `sha256:${"e".repeat(64)}` }) }));
    expect(history).toHaveLength(0);
    expect(res.stopped).toBe("catalog_raw_digest_mismatch");
    // the catalog artifact was still persisted before the stop
    expect(readdirSync(root).some((f) => /^catalog-preflight-[0-9a-f]{64}\.json$/.test(f))).toBe(true);
  });
  it("stops BEFORE dispatch when the built request payload differs from the plan", async () => {
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const badBuild = (cell: Cell, plan: CellPlan): RequestBody => ({ model: "evil/substitute", maxTokens: plan.maxTokens, temperature: 0, topP: 1, seed: 1 });
    const res = await runContinuation(base({ generate: gen, buildRequest: badBuild }));
    expect(history).toHaveLength(0);
    expect(res.stopped).toMatch(/^request_payload_drift/);
    expect(existsSync(join(root, "runs", runIdFor(1, OPENAI_SENTINEL) + ".intent.json"))).toBe(false);
  });
});

describe("C1-R2-F01 production livePreflight (mock fetch)", () => {
  const catalogBody = () =>
    JSON.stringify({
      data: [
        { id: "openai/gpt-5.6-sol-pro" },
        { id: "anthropic/claude-opus-5" },
        { id: "google/gemini-3.7-flash" },
        { id: "deepseek/deepseek-v4-flash-0731" },
      ],
    });
  const fullLocal: ExpectedLocalBinding[] = [
    { requestedSlug: "Qwen/Qwen3.8-27B", endpoint: "http://localhost:8001/v1", servedModelId: "Qwen/Qwen3.8-27B", checkpointRevision: "sha256:c1", weightManifestDigest: "sha256:w1", servingConfigDigest: "sha256:s1", tensorParallelism: 2, precision: "bf16" },
    { requestedSlug: "openai/gpt-oss-20b", endpoint: "http://localhost:8002/v1", servedModelId: "openai/gpt-oss-20b", checkpointRevision: "sha256:c2", weightManifestDigest: "sha256:w2", servingConfigDigest: "sha256:s2", tensorParallelism: 1, precision: "bf16" },
  ];
  const observedFull = (): LocalTargetBinding[] =>
    fullLocal.map((e) => ({ ...e, healthy: true, capturedAtUtc: TS }));

  it("re-derives raw body digest/bytes from the captured body and resolves 4/4 hosted", async () => {
    const body = catalogBody();
    const pf = await livePreflight({
      orKey: "unused",
      now: () => TS,
      fetchFn: async () => jsonResponse(body),
      expectedLocalBindings: fullLocal,
      localBindingProbe: async () => observedFull(),
    });
    expect(pf.rawBody).toBe(body);
    expect(pf.catalog.rawBodySha256).toBe(sha256(body));
    expect(pf.catalog.byteLength).toBe(Buffer.byteLength(body, "utf-8"));
    expect(pf.ok).toBe(true);
    const hosted = pf.resolution.filter((r) => r.backend === "openrouter");
    expect(hosted.every((r) => r.resolvedExactly)).toBe(true);
  });
  it("non-200 preserves the raw body and fails closed (no throw)", async () => {
    const body = '{"error":"unauthorized"}';
    const pf = await livePreflight({ orKey: "x", now: () => TS, fetchFn: async () => jsonResponse(body, 401), expectedLocalBindings: fullLocal, localBindingProbe: async () => observedFull() });
    expect(pf.ok).toBe(false);
    expect(pf.rawBody).toBe(body);
    expect(pf.catalog.rawBodySha256).toBe(sha256(body));
    expect(pf.reasons.join(";")).toMatch(/catalog http 401/);
  });
  it("malformed JSON preserves the raw body and fails closed (no throw)", async () => {
    const body = "not-json<garbage>";
    const pf = await livePreflight({ orKey: "x", now: () => TS, fetchFn: async () => jsonResponse(body, 200), expectedLocalBindings: fullLocal, localBindingProbe: async () => observedFull() });
    expect(pf.ok).toBe(false);
    expect(pf.rawBody).toBe(body);
    expect(pf.reasons.join(";")).toMatch(/malformed json/);
  });
  it("computes freshness from receipt vs evaluation time (stale => freshnessOk false)", async () => {
    let n = 0;
    const times = [TS, TS, "2026-08-22T02:00:00.000Z"]; // eval is 2h after receipt
    const pf = await livePreflight({
      orKey: "x",
      now: () => times[Math.min(n++, times.length - 1)],
      fetchFn: async () => jsonResponse(catalogBody()),
      expectedLocalBindings: fullLocal,
      localBindingProbe: async () => observedFull(),
    });
    expect(pf.catalog.ageSeconds).toBeGreaterThan(CATALOG_FRESHNESS_SECONDS);
    expect(pf.catalog.freshnessOk).toBe(false);
  });
});

describe("C1-R2-F02 local vLLM binding gate", () => {
  const expected: ExpectedLocalBinding = {
    requestedSlug: "Qwen/Qwen3.8-27B",
    endpoint: "http://localhost:8001/v1",
    servedModelId: "Qwen/Qwen3.8-27B",
    checkpointRevision: "sha256:ck",
    weightManifestDigest: "sha256:wm",
    servingConfigDigest: "sha256:sc",
    tensorParallelism: 2,
    precision: "bf16",
  };
  const observed = (over?: Partial<LocalTargetBinding>): LocalTargetBinding => ({
    requestedSlug: "Qwen/Qwen3.8-27B",
    endpoint: "http://localhost:8001/v1",
    healthy: true,
    servedModelId: "Qwen/Qwen3.8-27B",
    checkpointRevision: "sha256:ck",
    weightManifestDigest: "sha256:wm",
    servingConfigDigest: "sha256:sc",
    tensorParallelism: 2,
    precision: "bf16",
    capturedAtUtc: TS,
    ...over,
  });
  it("resolves exactly when every field matches an accepted binding", () => {
    const r = resolveLocalTarget(expected, observed(), TS);
    expect(r.resolution.resolvedExactly).toBe(true);
    expect(r.resolution.resolvedSlug).toBe("Qwen/Qwen3.8-27B");
    expect(r.reasons).toHaveLength(0);
  });
  it("fails closed when unhealthy", () => {
    expect(resolveLocalTarget(expected, observed({ healthy: false }), TS).resolution.resolvedExactly).toBe(false);
  });
  it("fails closed on a missing field (checkpoint absent)", () => {
    const r = resolveLocalTarget(expected, observed({ checkpointRevision: null }), TS);
    expect(r.resolution.resolvedExactly).toBe(false);
    expect(r.reasons.join(";")).toMatch(/missing checkpointRevision/);
  });
  it("fails closed on a served-model mismatch", () => {
    const r = resolveLocalTarget(expected, observed({ servedModelId: "other/model" }), TS);
    expect(r.resolution.resolvedExactly).toBe(false);
    expect(r.reasons.join(";")).toMatch(/servedModelId mismatch/);
  });
  it("fails closed on a serving divergence (tensor parallelism mismatch)", () => {
    // The descriptor-based servingConfigDigest is no longer a resolveLocalTarget gate
    // (expected uses a100 descriptors, observed uses the live argv — incomparable;
    // serving correctness is verified structurally by the live observer, C1-R6-F01).
    // tensorParallelism stays an explicit like-for-like machine gate.
    expect(resolveLocalTarget(expected, observed({ tensorParallelism: 99 }), TS).resolution.resolvedExactly).toBe(false);
  });
  it("fails closed when there is no observation at all", () => {
    const r = resolveLocalTarget(expected, undefined, TS);
    expect(r.resolution.resolvedExactly).toBe(false);
    expect(r.reasons.join(";")).toMatch(/no observed local binding/);
  });
  it("livePreflight leaves local unresolved (ok=false) when the probe is absent", async () => {
    const pf = await livePreflight({
      orKey: "x",
      now: () => TS,
      fetchFn: async () =>
        jsonResponse({ data: [{ id: "openai/gpt-5.6-sol-pro" }, { id: "anthropic/claude-opus-5" }, { id: "google/gemini-3.7-flash" }, { id: "deepseek/deepseek-v4-flash-0731" }] }),
      // no expectedLocalBindings, no probe -> local targets fail closed
    });
    expect(pf.ok).toBe(false);
    const local = pf.resolution.filter((r) => r.backend === "vllm");
    expect(local).toHaveLength(2);
    expect(local.every((r) => !r.resolvedExactly)).toBe(true);
  });
});

describe("C1-R2-F03 wire capture and response/routing drift (dispatchViaBackend)", () => {
  const req: RequestBody = { model: "openai/gpt-5.6-sol-pro", maxTokens: 8192, temperature: 0, topP: 1, seed: 1 };
  const messages = [{ role: "user" as const, content: "hi" }];
  const completion = { id: "gen-1", model: "openai/gpt-5.6-sol-pro", provider: "VendorCloud", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: {} };

  it("derives requestSent from the captured wire body (not the plan) and cross-checks the lookup", async () => {
    const facts = await dispatchViaBackend({
      backendId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      timeoutMs: 1000,
      isHosted: true,
      req,
      messages,
      fetchFn: async () => jsonResponse(completion),
      costLookup: async (id) => ({ lookupOk: true, generationId: id, actualCostUsd: 0.002, provider: "VendorCloud", responseModelId: "openai/gpt-5.6-sol-pro" }),
    });
    expect(facts.requestSent.model).toBe("openai/gpt-5.6-sol-pro");
    expect(facts.requestSent.maxTokens).toBe(8192);
    expect(facts.requestWireSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(facts.responseModelId).toBe("openai/gpt-5.6-sol-pro");
    expect(facts.transportError).toBeNull();
    expect(facts.generationLookupModelId).toBe("openai/gpt-5.6-sol-pro");
  });
  it("an HTTP error is a RECEIVED response (raw evidence kept), not a transport failure", async () => {
    const facts = await dispatchViaBackend({
      backendId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      timeoutMs: 1000,
      isHosted: true,
      req,
      messages,
      fetchFn: async () => jsonResponse({ error: { message: "server exploded" } }, 500),
    });
    expect(facts.transportError).toBeNull();
    expect((facts.raw as { __httpStatus?: number }).__httpStatus).toBe(500);
  });
  it("an invalid (non-JSON) body is a RECEIVED response, not a transport failure", async () => {
    const facts = await dispatchViaBackend({
      backendId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      timeoutMs: 1000,
      isHosted: true,
      req,
      messages,
      fetchFn: async () => jsonResponse("<<not json>>", 200),
    });
    expect(facts.transportError).toBeNull();
    expect((facts.raw as { __nonJson?: boolean }).__nonJson).toBe(true);
  });
  it("a no-choice payload is a RECEIVED response, not a transport failure", async () => {
    const facts = await dispatchViaBackend({
      backendId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      timeoutMs: 1000,
      isHosted: true,
      req,
      messages,
      fetchFn: async () => jsonResponse({ id: "g", model: "m", choices: [] }, 200),
    });
    expect(facts.transportError).toBeNull();
    expect((facts.raw as { choices?: unknown[] }).choices).toEqual([]);
  });
  it("a fetch that never completes IS a transport failure", async () => {
    const facts = await dispatchViaBackend({
      backendId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      timeoutMs: 1000,
      isHosted: true,
      req,
      messages,
      fetchFn: async () => {
        throw new Error("connection refused");
      },
    });
    expect(facts.transportError).not.toBeNull();
    expect(facts.transportError?.kind).toBe("network");
    expect(facts.raw).toBeNull();
  });
  it("computeContinuationValidation flags a wrong non-null response model (Authority wrong-model case)", () => {
    const cv = computeContinuationValidation({
      expected: { requestedSlug: "openai/gpt-5.6-sol-pro", resolvedSlug: "openai/gpt-5.6-sol-pro", maxTokens: 8192, sampling: { maxTokens: 8192, temperature: 0, topP: 1, seed: 1 } },
      observed: {
        requestModel: "openai/gpt-5.6-sol-pro",
        requestMaxTokens: 8192,
        requestSampling: { maxTokens: 8192, temperature: 0, topP: 1, seed: 1 },
        responseModelId: "other/substituted-model",
        responseReceived: true,
        resolvedSlug: "openai/gpt-5.6-sol-pro",
        resolvedExactly: true,
        substitutionUsed: false,
        fallbackUsed: false,
      },
    });
    expect(cv.ok).toBe(false);
    expect(cv.reasons.join(";")).toMatch(/response model other\/substituted-model != expected/);
  });
  it("computeContinuationValidation flags a generation-lookup / response mismatch", () => {
    const cv = computeContinuationValidation({
      expected: { requestedSlug: "m", resolvedSlug: "m", maxTokens: 10, sampling: { a: 1 } },
      observed: {
        requestModel: "m",
        requestMaxTokens: 10,
        requestSampling: { a: 1 },
        responseModelId: "m",
        responseReceived: true,
        resolvedSlug: "m",
        resolvedExactly: true,
        substitutionUsed: false,
        fallbackUsed: false,
        responseGenerationId: "gen-1",
        lookupGenerationId: "gen-2",
      },
    });
    expect(cv.ok).toBe(false);
    expect(cv.reasons.join(";")).toMatch(/generation-lookup id gen-2 != response generation id gen-1/);
  });
});

describe("historical gate and sentinel", () => {
  it("stops at dispatch 0 on historical digest mismatch", async () => {
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, verifyHistoricalDigests: () => ({ ok: false, details: [] }) }));
    expect(history).toHaveLength(0);
    expect(res.stopped).toBe("historical_digest_mismatch");
  });
  it("never dispatches the historical cell; OpenAI sentinel is first", async () => {
    const { gen, history } = recordingGenerate(qualifyingFacts);
    await runContinuation(base({ generate: gen }));
    expect(history[0]).toMatchObject({ target: OPENAI_SENTINEL.target, benchmark: OPENAI_SENTINEL.benchmark });
    expect(history.some((c) => c.target === HISTORICAL.target && c.benchmark === HISTORICAL.benchmark)).toBe(false);
  });
  it("stops after a failing sentinel: 1 dispatched, 22 not attempted", async () => {
    const { gen, history } = recordingGenerate((c, p, r, i) => (i === 0 ? filteredFacts(c, p, r) : qualifyingFacts(c, p, r)));
    const res = await runContinuation(base({ generate: gen }));
    expect(history).toHaveLength(1);
    expect(res.stopped).toMatch(/^openai_sentinel_not_accepted/);
    expect(res.summary.notAttemptedContinuation).toBe(22);
  });
});

describe("F02 persistence before stop", () => {
  it("finalizes the outcome record on response-model/routing drift, THEN stops (Authority wrong-model at dispatch)", async () => {
    const { gen, history } = recordingGenerate((c, p, r) => ({ ...qualifyingFacts(c, p, r), responseModelId: "other/substituted-model", generationLookupModelId: "other/substituted-model" }));
    const res = await runContinuation(base({ generate: gen }));
    expect(history).toHaveLength(1);
    expect(res.stopped).toMatch(/^continuation_validation_failed/);
    const rec = JSON.parse(readFileSync(join(root, "runs", runIdFor(1, OPENAI_SENTINEL) + ".json"), "utf-8"));
    expect(rec.continuationValidation.ok).toBe(false);
    expect(rec.status.qualification).not.toBe("pass_promoted");
  });
  it("finalizes a null-response-model drift record then stops", async () => {
    const { gen } = recordingGenerate((c, p, r) => ({ ...qualifyingFacts(c, p, r), responseModelId: null }));
    const res = await runContinuation(base({ generate: gen }));
    expect(res.stopped).toMatch(/^continuation_validation_failed/);
    const rec = JSON.parse(readFileSync(join(root, "runs", runIdFor(1, OPENAI_SENTINEL) + ".json"), "utf-8"));
    expect(rec.continuationValidation.ok).toBe(false);
  });
  it("finalizes a transport-failure record when the provider throws, then continues (non-sentinel)", async () => {
    const { gen, history } = recordingGenerate((c, p, r, i) => {
      if (i === 1) throw new Error("boom-network");
      return qualifyingFacts(c, p, r);
    });
    await runContinuation(base({ generate: gen }));
    const order = deriveContinuationPlan(buildFrozenOrder()).continuation;
    const rec = JSON.parse(readFileSync(join(root, "runs", runIdFor(2, order[1]) + ".json"), "utf-8"));
    expect(rec.status.transport).toBe("failed");
    expect(rec.attempts).toHaveLength(1);
    expect(rec.error).not.toBeNull();
    expect(history.length).toBeGreaterThan(2);
  });
  it("stops (after finalizing) when a non-sentinel response is missing cost", async () => {
    const { gen, history } = recordingGenerate((c, p, r, i) =>
      i === 1 ? { ...qualifyingFacts(c, p, r), cost: { costModel: "METERED", actualCostUsd: null } } : qualifyingFacts(c, p, r),
    );
    const res = await runContinuation(base({ generate: gen }));
    expect(res.stopped).toBe("incomplete_billing_or_provenance");
    const order = deriveContinuationPlan(buildFrozenOrder()).continuation;
    expect(existsSync(join(root, "runs", runIdFor(2, order[1]) + ".json"))).toBe(true);
    expect(history).toHaveLength(2);
  });
});

describe("C1-R2-F04 strict resume completeness and cumulative accounting", () => {
  it("does not treat a malformed transport-failure record (attempts:[{}]) as complete", () => {
    const malformed: PersistedRecordShape = {
      schemaVersion: 2,
      error: { kind: "timeout", message: "x" },
      status: { transport: "failed", response: "not_received", finalCompleteness: "not_received", qualification: "fail", failureReasons: [] },
      attempts: [{}],
    };
    expect(isRecordComplete(malformed)).toBe(false);
    expect(validateRecordComplete(malformed).reasons.join(";")).toMatch(/attempt 0 missing/);
  });
  it("rejects a tampered ATTEMPT raw digest (Authority attempt-forgery case)", () => {
    const rec = makeCompleteRecord(OPENAI_SENTINEL, 1, "pass") as Record<string, unknown>;
    (rec.attempts as Array<Record<string, unknown>>)[0].rawResponseSha256 = `sha256:${"f".repeat(64)}`;
    expect(validateRecordComplete(rec as PersistedRecordShape).reasons.join(";")).toMatch(/attempt 0 rawResponseSha256 does not match/);
  });
  it("rejects an attempt missing cost / provenance", () => {
    const rec = makeCompleteRecord(OPENAI_SENTINEL, 1, "pass") as Record<string, unknown>;
    (rec.attempts as Array<Record<string, unknown>>)[0].cost = { costModel: "METERED", actualCostUsd: null };
    expect(validateRecordComplete(rec as PersistedRecordShape).reasons.join(";")).toMatch(/attempt 0 cost missing/);
  });
  it("rejects a headline that disagrees with the final attempt (Authority headline-forgery case)", () => {
    const rec = makeCompleteRecord(OPENAI_SENTINEL, 1, "pass") as Record<string, unknown>;
    rec.cost = { costModel: "METERED", actualCostUsd: 999.0 }; // headline cost != attempt cost
    expect(validateRecordComplete(rec as PersistedRecordShape).reasons.join(";")).toMatch(/headline cost != final attempt/);
  });
  it("requires continuationValidation / responseModelId / catalogArtifactRef", () => {
    const rec = makeCompleteRecord(OPENAI_SENTINEL, 1, "pass") as Record<string, unknown>;
    delete rec.catalogArtifactRef;
    expect(validateRecordComplete(rec as PersistedRecordShape).reasons.join(";")).toMatch(/catalogArtifactRef missing/);
  });
  it("does not resume-skip a record with drifted sampling", async () => {
    await freshAll();
    const order = deriveContinuationPlan(buildFrozenOrder()).continuation;
    const path = join(root, "runs", `${runIdFor(1, order[0])}.json`);
    const rec = JSON.parse(readFileSync(path, "utf-8"));
    rec.sampling.maxTokens = 999;
    writeFileSync(path, JSON.stringify(rec), { mode: 0o600 });
    dropManifests(root); // un-manifested record — the record-level gate must catch the drift
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, isResume: true }));
    expect(res.stopped).toBe("record_inconsistent_with_plan");
    expect(history).toHaveLength(0);
  });
  it("rejects a stored top-level raw digest mismatch", async () => {
    await freshAll();
    const order = deriveContinuationPlan(buildFrozenOrder()).continuation;
    const path = join(root, "runs", `${runIdFor(1, order[0])}.json`);
    const rec = JSON.parse(readFileSync(path, "utf-8"));
    rec.rawResponseSha256 = `sha256:${"f".repeat(64)}`;
    writeFileSync(path, JSON.stringify(rec), { mode: 0o600 });
    dropManifests(root); // un-manifested record — the record-level digest gate must catch it
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, isResume: true }));
    expect(res.stopped).toBe("record_inconsistent_with_plan");
    expect(history).toHaveLength(0);
  });
  it("resumes 2 complete records + 21 fresh dispatches → cumulative 23", async () => {
    await freshAll();
    const order = deriveContinuationPlan(buildFrozenOrder()).continuation;
    keepOnly(root, [runIdFor(1, order[0]), runIdFor(2, order[1])]);
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, isResume: true }));
    expect(history).toHaveLength(21);
    const s = res.summary;
    expect(s.executedThisInvocation).toBe(21);
    expect(s.resumeSkippedThisInvocation).toBe(2);
    expect(s.cumulativeTerminalContinuation).toBe(23);
    expect(s.cumulativePassedContinuation + s.cumulativeFailedContinuation).toBe(23);
    expect(s.cumulativeAttemptsContinuation).toBe(23);
    expect(s.overallStatus).toBe(DIAGNOSTIC_COMPLETE_WITH_PROVIDER_POLICY_FAILURE);
  });
  it("does not clear the sentinel gate on a resumed FAILING sentinel", async () => {
    await freshAll((c, p, r, i) => (i === 0 ? filteredFacts(c, p, r) : qualifyingFacts(c, p, r)));
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, isResume: true }));
    expect(res.stopped).toMatch(/^openai_sentinel_not_accepted/);
    expect(history).toHaveLength(0);
  });
  it("treats a recorded continuationValidation.ok=false as a STICKY blocker on resume (sentinel)", async () => {
    await freshAll((c, p, r, i) => (i === 0 ? { ...qualifyingFacts(c, p, r), responseModelId: null } : qualifyingFacts(c, p, r)));
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, isResume: true }));
    expect(res.stopped).toBe("sticky_continuation_validation_failed");
    expect(history).toHaveLength(0);
  });
  it("treats a recorded continuationValidation.ok=false as a STICKY blocker on resume (non-sentinel)", async () => {
    await freshAll((c, p, r, i) => (i === 1 ? { ...qualifyingFacts(c, p, r), responseModelId: null } : qualifyingFacts(c, p, r)));
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, isResume: true }));
    expect(res.stopped).toBe("sticky_continuation_validation_failed");
    expect(history).toHaveLength(0);
  });
  it("stops the resume when a record's catalog-artifact reference is absent", async () => {
    await freshAll();
    const order = deriveContinuationPlan(buildFrozenOrder()).continuation;
    keepOnly(root, [runIdFor(1, order[0])]);
    const path = join(root, "runs", `${runIdFor(1, order[0])}.json`);
    const rec = JSON.parse(readFileSync(path, "utf-8"));
    rec.catalogArtifactRef = { file: `catalog-preflight-${"9".repeat(16)}.json`, sha256: `sha256:${"9".repeat(64)}` };
    writeFileSync(path, JSON.stringify(rec), { mode: 0o600 });
    const { gen } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, isResume: true }));
    expect(res.stopped).toMatch(/^catalog_ref_invalid/);
  });
});

describe("C1-R2-F04 append-only output, allowlist and durable manifests", () => {
  it("rejects a fresh run when a stray file sits directly in the output root", async () => {
    writeFileSync(join(root, "stray.txt"), "x");
    const { gen } = recordingGenerate(qualifyingFacts);
    await expect(runContinuation(base({ generate: gen }))).rejects.toThrow(/not empty/);
  });
  it("rejects an unauthorized runs/unauthorized.json on resume (Authority unauthorized-entry case)", async () => {
    mkdirSync(join(root, "runs"), { recursive: true });
    writeFileSync(join(root, "runs", "unauthorized.json"), "{}", { mode: 0o600 });
    const { gen } = recordingGenerate(qualifyingFacts);
    await expect(runContinuation(base({ generate: gen, isResume: true }))).rejects.toThrow(/unauthorized/);
  });
  it("rejects a symlink in the output root on resume", async () => {
    symlinkSync("/etc/hostname", join(root, `continuation-summary-${"a".repeat(16)}.json`));
    const { gen } = recordingGenerate(qualifyingFacts);
    await expect(runContinuation(base({ generate: gen, isResume: true }))).rejects.toThrow(/symlink/);
  });
  it("rejects a directory where a file artifact is expected on resume", async () => {
    mkdirSync(join(root, `catalog-preflight-${"b".repeat(16)}.json`));
    const { gen } = recordingGenerate(qualifyingFacts);
    await expect(runContinuation(base({ generate: gen, isResume: true }))).rejects.toThrow(/non-regular/);
  });
  it("rejects a group/other-permissive mode on resume", async () => {
    writeFileSync(join(root, `continuation-summary-${"c".repeat(16)}.json`), "{}", { mode: 0o666 });
    const { gen } = recordingGenerate(qualifyingFacts);
    await expect(runContinuation(base({ generate: gen, isResume: true }))).rejects.toThrow(/unexpected mode/);
  });
  it("leaves zero fsync-probe residue in the runs directory", async () => {
    await freshAll();
    expect(readdirSync(join(root, "runs")).filter((f) => f.startsWith(".fsync-probe"))).toHaveLength(0);
  });
  it("writes immutable, content-addressed summaries + runtime manifests across invocations", async () => {
    const r1 = await freshAll();
    const g2 = recordingGenerate(qualifyingFacts);
    const r2 = await runContinuation(base({ generate: g2.gen, isResume: true }));
    expect(g2.history).toHaveLength(0);
    const summaries = readdirSync(root).filter((f) => /^continuation-summary-[0-9a-f]{64}\.json$/.test(f));
    const manifests = readdirSync(root).filter((f) => /^continuation-runtime-manifest-[0-9a-f]{64}\.json$/.test(f));
    expect(summaries.length).toBe(2);
    expect(manifests.length).toBe(2);
    expect(r1.res.summaryFile).not.toBe(r2.summaryFile);
    expect(r1.res.runtimeManifestFile).not.toBe(r2.runtimeManifestFile);
  });
  it("the runtime manifest binds catalog/records/summary and chains to prior manifests", async () => {
    const r1 = await freshAll();
    const first = JSON.parse(readFileSync(join(root, r1.res.runtimeManifestFile), "utf-8"));
    expect(first.records).toHaveLength(23);
    expect(first.catalogArtifact).not.toBeNull();
    expect(first.summary.file).toBe(r1.res.summaryFile);
    const g2 = recordingGenerate(qualifyingFacts);
    const r2 = await runContinuation(base({ generate: g2.gen, isResume: true }));
    const second = JSON.parse(readFileSync(join(root, r2.runtimeManifestFile), "utf-8"));
    expect(second.priorRuntimeManifests.length).toBeGreaterThanOrEqual(1);
    for (const p of second.priorRuntimeManifests) {
      const actual = "sha256:" + createHash("sha256").update(readFileSync(join(root, p.file))).digest("hex");
      expect(actual).toBe(p.sha256);
    }
  });
});

describe("C1-R2-F05 durable, fail-closed finalize", () => {
  it("does NOT swallow a durability failure (regular-file output root fails closed)", async () => {
    const fileRoot = join(root, "as-a-file");
    writeFileSync(fileRoot, "x");
    const { gen } = recordingGenerate(qualifyingFacts);
    await expect(runContinuation(base({ generate: gen, outputRoot: fileRoot }))).rejects.toThrow();
  });
  it("refuses to overwrite a pre-existing artifact with different content", () => {
    writeFileSync(join(root, "m.json"), "AAA", { mode: 0o600 });
    withLock(root, (l) => expect(() => finalizeArtifact(root, "m.json", "BBB", l)).toThrow(/different content/));
  });
  it("is idempotent for byte-identical content (reused=true), never a silent overwrite", () => {
    withLock(root, (l) => {
      const a = finalizeArtifact(root, "i.json", "SAME", l);
      const b = finalizeArtifact(root, "i.json", "SAME", l);
      expect(a.reused).toBe(false);
      expect(b.reused).toBe(true);
      expect(a.sha256).toBe(b.sha256);
    });
  });
  it("propagates a permission fault instead of reporting success", () => {
    // Under F05 finalize is confined to the lock's own runs/ subdir; a read-only
    // runs/ still surfaces the write fault rather than reporting success.
    const runsDir = join(root, "runs");
    mkdirSync(runsDir, { mode: 0o500 });
    try {
      withLock(root, (l) => expect(() => finalizeArtifact(runsDir, "x.json", "{}", l)).toThrow());
    } finally {
      chmodSync(runsDir, 0o700);
    }
  });
  it("verifyReferencedArtifact confirms an on-disk artifact by digest AND filename content address", () => {
    const body = '{"catalog":true}';
    withLock(root, (l) => {
      const r = finalizeArtifact(root, `catalog-preflight-${bareSha(body)}.json`, body, l);
      expect(verifyReferencedArtifact(root, { file: r.file, sha256: r.sha256 }, "catalog").ok).toBe(true);
      expect(verifyReferencedArtifact(root, { file: r.file, sha256: `sha256:${"0".repeat(64)}` }, "catalog").ok).toBe(false);
      expect(verifyReferencedArtifact(root, { file: `catalog-preflight-${"a".repeat(64)}.json`, sha256: r.sha256 }, "catalog").reason).toBe("catalog_ref_absent");
      // a 16-hex (short) content address does not match the kind's 64-hex name (F04)
      const short = finalizeArtifact(root, `catalog-preflight-${"1".repeat(16)}.json`, body, l);
      expect(verifyReferencedArtifact(root, { file: short.file, sha256: short.sha256 }, "catalog").reason).toMatch(/ref_kind_mismatch:expected_catalog/);
    });
  });
});

describe("interruption safety, schema and secrecy", () => {
  it("stops as attempt_outcome_uncertain on a dispatch_started intent with no record", async () => {
    const runsDir = join(root, "runs");
    mkdirSync(runsDir, { recursive: true });
    const rid = runIdFor(1, OPENAI_SENTINEL);
    writeFileSync(
      join(runsDir, `${rid}.intent.json`),
      JSON.stringify({ campaignId: "c", orderIndex: 1, runId: rid, target: OPENAI_SENTINEL.target, benchmark: OPENAI_SENTINEL.benchmark, attemptIndex: 0, createdAt: TS, state: "dispatch_started" }),
      { mode: 0o600 },
    );
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, isResume: true }));
    expect(res.stopped).toBe("attempt_outcome_uncertain");
    expect(history).toHaveLength(0);
  });
  it("stops on a duplicate run id", async () => {
    const { gen } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, planCell: (c: Cell) => mockPlanCell(c, 1) }));
    expect(res.stopped).toBe("duplicate_run_id");
  });
  it("writes schema-v2 records with headline == final attempt and no secret material", async () => {
    await freshAll();
    const rid = runIdFor(1, OPENAI_SENTINEL);
    const rec = JSON.parse(readFileSync(join(root, "runs", `${rid}.json`), "utf-8"));
    expect(rec.schemaVersion).toBe(2);
    expect(CONTINUATION_RUN_SCHEMA_VERSION).toBe(2);
    expect(rec.output).toEqual(rec.attempts[0].output);
    expect(rec.rawResponseSha256).toBe(rec.attempts[0].rawResponseSha256);
    expect(rec).not.toHaveProperty("succeeded");
    for (const f of readdirSync(join(root, "runs"))) {
      const body = readFileSync(join(root, "runs", f), "utf-8");
      expect(body).not.toMatch(/sk-[A-Za-z0-9]/);
      expect(body.toLowerCase()).not.toContain("authorization");
      expect(body).not.toMatch(/api[_-]?key/i);
    }
  });
});

describe("pure classifiers", () => {
  it("validateRecordComplete accepts a well-formed record and rejects missing provenance", () => {
    const complete = makeCompleteRecord(OPENAI_SENTINEL, 1, "pass") as PersistedRecordShape;
    expect(validateRecordComplete(complete).complete).toBe(true);
    expect(sentinelAccepted(complete).accepted).toBe(true);
    const noProv = { ...complete, generationProvenance: { generationId: null } } as PersistedRecordShape;
    expect(validateRecordComplete(noProv).complete).toBe(false);
  });
  it("recordTerminalBlocker flags a recorded cv failure and missing billing", () => {
    const complete = makeCompleteRecord(OPENAI_SENTINEL, 1, "pass") as Record<string, unknown>;
    expect(recordTerminalBlocker(complete as PersistedRecordShape)).toBeNull();
    const cvFail = { ...complete, continuationValidation: { ok: false, reasons: ["x"] } } as PersistedRecordShape;
    expect(recordTerminalBlocker(cvFail)).toBe("sticky_continuation_validation_failed");
  });
  it("sentinelAccepted rejects a sentinel whose continuationValidation failed", () => {
    const rec = makeCompleteRecord(OPENAI_SENTINEL, 1, "pass") as Record<string, unknown>;
    rec.continuationValidation = { ok: false, reasons: ["drift"] };
    expect(sentinelAccepted(rec as PersistedRecordShape).accepted).toBe(false);
    expect(sentinelAccepted(rec as PersistedRecordShape).reasons.join(";")).toMatch(/continuation_validation_failed/);
  });
  it("planConsistency flags a benchmark-hash difference", () => {
    const rec = makeCompleteRecord(OPENAI_SENTINEL, 1, "pass") as PersistedRecordShape;
    const plan = planCellSync(OPENAI_SENTINEL, 1);
    const good = planConsistency(rec, {
      campaignId: "plinius-qualification-2026-08-22-v1", runId: plan.runId, orderIndex: 1,
      benchmarkId: OPENAI_SENTINEL.benchmark, benchmarkVersion: "1.0.0", benchmarkContentHash: "sha256:aaaa",
      requestedSlug: OPENAI_SENTINEL.target, resolvedSlug: OPENAI_SENTINEL.target, backend: "openrouter",
      endpoint: "https://openrouter.ai/api/v1", promptId: "prompt-1", sampling: plan.sampling, maxTokens: 8192,
      substitutionUsed: false, fallbackUsed: false,
    });
    expect(good.consistent).toBe(true);
    const bad = planConsistency(rec, {
      campaignId: "plinius-qualification-2026-08-22-v1", runId: plan.runId, orderIndex: 1,
      benchmarkId: OPENAI_SENTINEL.benchmark, benchmarkVersion: "1.0.0", benchmarkContentHash: "sha256:DIFFERENT",
      requestedSlug: OPENAI_SENTINEL.target, resolvedSlug: OPENAI_SENTINEL.target, backend: "openrouter",
      endpoint: "https://openrouter.ai/api/v1", promptId: "prompt-1", sampling: plan.sampling, maxTokens: 8192,
      substitutionUsed: false, fallbackUsed: false,
    });
    expect(bad.consistent).toBe(false);
    expect(bad.reasons.join(";")).toMatch(/benchmarkContentHash/);
  });
  it("classifyResume is fail-closed and honors a terminal blocker", () => {
    expect(classifyResume({ record: null, recordConsistent: true, intentState: "dispatch_started" }).reason).toBe("attempt_outcome_uncertain");
    const complete = makeCompleteRecord(OPENAI_SENTINEL, 1, "pass") as PersistedRecordShape;
    expect(classifyResume({ record: complete, recordConsistent: true, intentState: null }).decision).toBe("skip");
    expect(classifyResume({ record: complete, recordConsistent: false, intentState: null }).decision).toBe("stop");
    expect(classifyResume({ record: complete, recordConsistent: true, terminalBlocker: "sticky_continuation_validation_failed", intentState: null }).reason).toBe("sticky_continuation_validation_failed");
  });
});

// ============================================================================
// Stage C1 r4 — findings C1-R3-F01..F05 and the 5 Authority adversarial cases:
// local-binding freshness, artifact path traversal, forged resume record,
// wire-body absence, hosted-provider absence.
// ============================================================================

// F08: the real-parent test root is a TEST PARAMETER (PLINIUS_R5_PARENT_ROOT env
// override), never a production trust source or a baked-in execution-host path.
// Absent the expanded parent Evidence the real-parent test skips with a recorded
// reason rather than depending on a hard-coded host path.
const R5_PARENT_ROOT =
  process.env.PLINIUS_R7_PARENT_ROOT ??
  process.env.PLINIUS_R6_PARENT_ROOT ??
  process.env.PLINIUS_R5_PARENT_ROOT ??
  "/home/ubuntu/plinius-evidence/plinius-qualification-2026-08-22-exec";
const R5_PARENT_AVAILABLE = existsSync(R5_PARENT_ROOT);

function writeContentAddressed(
  dir: string,
  prefix: "continuation-summary" | "catalog-preflight" | "continuation-runtime-manifest" | "local-runtime-preflight",
  bodyObj: unknown,
): string {
  // A summary body must carry the campaign / stage identity so the r6 manifest
  // verifier's referenced-body binding (C1-R5-F03) accepts it; tests pass a small
  // discriminator object and this fills in the binding fields when absent.
  let obj = bodyObj;
  if (prefix === "continuation-summary" && obj != null && typeof obj === "object" && typeof obj !== "string") {
    obj = { campaignId: CAMPAIGN_ID, stageId: CONTINUATION_STAGE_ID, ...(obj as Record<string, unknown>) };
  }
  const body = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  const name = `${prefix}-${bareSha(body)}.json`;
  writeFileSync(join(dir, name), body, { mode: 0o600 });
  return name;
}
const diskSha = (dir: string, f: string): string => sha256(readFileSync(join(dir, f), "utf-8"));
const diskBytes = (dir: string, f: string): number => Buffer.byteLength(readFileSync(join(dir, f), "utf-8"), "utf-8");
/** A manifest reference (file + digest + byte length) the r6 verifier recomputes (F03). */
function mref(dir: string, file: string): { file: string; sha256: string; bytes: number } {
  return { file, sha256: diskSha(dir, file), bytes: diskBytes(dir, file) };
}

/** Chain-verify options matching a REAL run over the mock plan (F04). */
function realChainOpts(over?: Partial<Parameters<typeof verifyRuntimeManifestChain>[1]>) {
  const cont = deriveContinuationPlan(buildFrozenOrder()).continuation;
  const validRunIds = cont.map((c, i) => runIdFor(i + 1, c));
  const planDigest = computePlanDigest(CAMPAIGN_ID, CONTINUATION_STAGE_ID, validRunIds);
  return { validRunIds, campaignId: CAMPAIGN_ID, stageId: CONTINUATION_STAGE_ID, planDigest, allowCrashFrontier: true, ...over };
}
/** Options for a SYNTHETIC (empty-plan) manifest chain built directly in a test. */
function synthChainOpts(over?: Partial<Parameters<typeof verifyRuntimeManifestChain>[1]>) {
  const planDigest = computePlanDigest(CAMPAIGN_ID, CONTINUATION_STAGE_ID, []);
  return { validRunIds: [], campaignId: CAMPAIGN_ID, stageId: CONTINUATION_STAGE_ID, planDigest, allowCrashFrontier: true, ...over };
}
/** A synthetic runtime-manifest body carrying the strict required fields (F04). */
function synthManifest(extra: Record<string, unknown>, invocationSuffix = 0): Record<string, unknown> {
  return {
    manifestSchemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
    campaignId: CAMPAIGN_ID,
    stageId: CONTINUATION_STAGE_ID,
    invocationId: `${CONTINUATION_STAGE_ID}#${invocationSuffix}`,
    planDigest: computePlanDigest(CAMPAIGN_ID, CONTINUATION_STAGE_ID, []),
    records: [],
    intents: [],
    catalogArtifact: null,
    localRuntimeArtifact: null,
    priorRuntimeManifests: [],
    requiredRefs: [],
    ...extra,
  };
}

describe("C1-R3-F01 parent-derived expected local bindings", () => {
  it("weightManifestDigest orders files with localeCompare (not ASCII byte order)", () => {
    const files: WeightFileEntry[] = [
      { file: "a.bin", sizeBytes: 2, sha256: "bb" },
      { file: "LICENSE", sizeBytes: 1, sha256: "aa" },
    ];
    const localeOrder = files
      .slice()
      .sort((x, y) => x.file.localeCompare(y.file))
      .map((w) => ({ file: w.file, sizeBytes: w.sizeBytes, sha256: w.sha256 }));
    expect(weightManifestDigest(files, bareSha).digest).toBe(bareSha(canonicalJson(localeOrder)));
    // localeCompare puts 'a.bin' before 'LICENSE'; ASCII would put 'LICENSE' first.
    expect(files.slice().sort((x, y) => x.file.localeCompare(y.file))[0].file).toBe("a.bin");
  });
  it("canonicalJson sorts object keys lexicographically with no whitespace", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("deriveExpectedLocalBindings re-derives checkpoint revision + digests from parsed artifacts", () => {
    const a100 = {
      servers: [
        {
          target: "T", endpoint: "http://localhost:8001/v1", load: { servedModelId: "T" },
          serving: { tensorParallelSize: 2, dtype: "bfloat16", quantization: "none", vllmImage: "img", vllmVersion: "0.27.1", engineArgs: "serve" },
        },
      ],
    };
    const ckpt = { target: "T", expectedOfficialCheckpointSha: "a".repeat(40), weightFiles: [{ file: "m.safetensors", sizeBytes: 3, sha256: "z" }], weightFileCount: 1, totalBytes: 3, quantization: "none" };
    const [b] = deriveExpectedLocalBindings({ a100Preflight: a100 as any, checkpoints: [ckpt as any], hasher: bareSha });
    expect(b.checkpointRevision).toBe("a".repeat(40));
    expect(b.weightManifestDigest).toBe(weightManifestDigest(ckpt.weightFiles as any, bareSha).digest);
    expect(b.servingConfigDigest).toBe(servingConfigDigest({ target: "T", endpoint: "http://localhost:8001/v1", servedModelId: "T", tensorParallelSize: 2, dtype: "bfloat16", quantization: "none", vllmImage: "img", vllmVersion: "0.27.1", engineArgs: "serve" }, bareSha).digest);
    // precision is the argv --dtype flag; the synthetic engineArgs "serve" has none → null (C1-R6-F01).
    expect(b.precision).toBeNull();
  });
  it("rejects a parent artifact whose fixed digest does not match", () => {
    const p = mkdtempSync(join(tmpdir(), "plinius-parent-"));
    try {
      mkdirSync(join(p, "artifacts"), { recursive: true });
      for (const f of ["06-a100-preflight.json", "06-local-checkpoint-qwen3.8-27b.json", "06-local-checkpoint-gpt-oss-20b.json", "05-openrouter-catalog-and-resolution.json"]) writeFileSync(join(p, "artifacts", f), "{}");
      expect(() => loadExpectedLocalBindingsFromParent(p)).toThrow(/digest mismatch/);
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  });
  it("rejects a symlinked parent artifact (not a regular file)", () => {
    const p = mkdtempSync(join(tmpdir(), "plinius-parent-"));
    try {
      mkdirSync(join(p, "artifacts"), { recursive: true });
      symlinkSync("/etc/hostname", join(p, "artifacts", "06-a100-preflight.json"));
      expect(() => loadExpectedLocalBindingsFromParent(p)).toThrow(/not a regular file/);
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  });
  it("PARENT_LOCAL_ARTIFACT_DIGESTS pins four 64-hex parent artifact digests", () => {
    expect(Object.keys(PARENT_LOCAL_ARTIFACT_DIGESTS)).toHaveLength(4);
    for (const d of Object.values(PARENT_LOCAL_ARTIFACT_DIGESTS)) expect(d).toMatch(/^[0-9a-f]{64}$/);
  });
  (R5_PARENT_AVAILABLE ? it : it.skip)(`re-derives the Authority-accepted values from the real parent Evidence (root=${R5_PARENT_ROOT}, available=${R5_PARENT_AVAILABLE})`, () => {
    const bindings = loadExpectedLocalBindingsFromParent(R5_PARENT_ROOT);
    const qwen = bindings.find((b) => b.requestedSlug === "Qwen/Qwen3.8-27B")!;
    const gptoss = bindings.find((b) => b.requestedSlug === "openai/gpt-oss-20b")!;
    expect(qwen.checkpointRevision).toBe("1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0");
    expect(qwen.weightManifestDigest).toBe("d67d740e1ce3a0eda51cadf908c3d9f42248ccf0648d7c91448b81a00d943eda");
    expect(qwen.servingConfigDigest).toBe("76f881245f804386ef12353dfd611a8c53d94b050ac6a0f475507328441d4db5");
    expect(qwen.tensorParallelism).toBe(2);
    expect(qwen.weightFileCount).toBe(32);
    expect(qwen.totalBytes).toBe(55586114863);
    expect(gptoss.checkpointRevision).toBe("6cee5e81ee83917806bbde320786a8fb61efebee");
    expect(gptoss.weightManifestDigest).toBe("2e68a02214cd6eec14b8135f954e8a8d010d330f32bdbede4fd7b02b241647b9");
    expect(gptoss.servingConfigDigest).toBe("55f1cf727844da343820fdfdf162dbc6db0ff6a975e64c44fc0a31537728145a");
    expect(gptoss.tensorParallelism).toBe(1);
  });
});

describe("C1-R3-F01 runtime observation freshness + fail-closed probe (Authority: freshness欠落)", () => {
  const expected: ExpectedLocalBinding = {
    requestedSlug: "Qwen/Qwen3.8-27B", endpoint: "http://localhost:8001/v1", servedModelId: "Qwen/Qwen3.8-27B",
    checkpointRevision: "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0", weightManifestDigest: "wm", servingConfigDigest: "sc",
    tensorParallelism: 2, precision: "bfloat16", weightFileCount: 32, totalBytes: 1,
  };
  const obs = (over?: Partial<LocalTargetBinding>): LocalTargetBinding => ({
    requestedSlug: "Qwen/Qwen3.8-27B", endpoint: "http://localhost:8001/v1", healthy: true, servedModelId: "Qwen/Qwen3.8-27B",
    checkpointRevision: "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0", weightManifestDigest: "wm", servingConfigDigest: "sc",
    tensorParallelism: 2, precision: "bfloat16", capturedAtUtc: TS, ...over,
  });
  const now2m = "2026-08-22T00:02:00.000Z"; // 120s after TS
  it("resolves when the observation is fresh (within 300s)", () => {
    expect(resolveLocalTarget(expected, obs(), now2m).resolution.resolvedExactly).toBe(true);
    expect(LOCAL_BINDING_FRESHNESS_SECONDS).toBe(300);
  });
  it("fails closed when capturedAtUtc is missing", () => {
    expect(resolveLocalTarget(expected, obs({ capturedAtUtc: null }), now2m).reasons.join(";")).toMatch(/capturedAtUtc missing/);
  });
  it("fails closed when capturedAtUtc is unparseable", () => {
    expect(resolveLocalTarget(expected, obs({ capturedAtUtc: "not-a-date" }), now2m).reasons.join(";")).toMatch(/capturedAtUtc invalid/);
  });
  it("fails closed when capturedAtUtc is in the future", () => {
    expect(resolveLocalTarget(expected, obs({ capturedAtUtc: "2026-08-22T01:00:00.000Z" }), now2m).reasons.join(";")).toMatch(/future/);
  });
  it("fails closed when the observation is stale (>300s)", () => {
    expect(resolveLocalTarget(expected, obs(), "2026-08-22T00:10:00.000Z").reasons.join(";")).toMatch(/stale/);
  });
  it("a probe with no observation emits a null binding that fails closed", async () => {
    const probe = makeLocalBindingProbe({ now: () => TS, observe: async () => null });
    const bindings = await probe([{ slug: "Qwen/Qwen3.8-27B", baseUrl: "http://localhost:8001/v1" } as any], (async () => jsonResponse({})) as any);
    expect(bindings[0].healthy).toBe(false);
    expect(bindings[0].weightManifestDigest).toBeNull();
    expect(resolveLocalTarget(expected, bindings[0], TS).resolution.resolvedExactly).toBe(false);
  });
  it("buildObservedBinding RE-COMPUTES digests from observed files (a weight tamper is caught)", () => {
    const serving = { target: "Qwen/Qwen3.8-27B", endpoint: "http://localhost:8001/v1", servedModelId: "Qwen/Qwen3.8-27B", tensorParallelSize: 2, dtype: "bfloat16", quantization: "none", vllmImage: "img", vllmVersion: "0.27.1", engineArgs: "serve" };
    const goodObs: RuntimeObservation = { requestedSlug: "Qwen/Qwen3.8-27B", endpoint: "http://localhost:8001/v1", healthy: true, servedModelId: "Qwen/Qwen3.8-27B", checkpointRevision: "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0", weightFiles: [{ file: "m.safetensors", sizeBytes: 10, sha256: "abc" }], servingObserved: serving, precision: "bfloat16", capturedAtUtc: TS };
    const bind = buildObservedBinding(goodObs, bareSha);
    const exp2: ExpectedLocalBinding = { ...expected, weightManifestDigest: bind.weightManifestDigest!, servingConfigDigest: bind.servingConfigDigest! };
    expect(resolveLocalTarget(exp2, bind, TS).resolution.resolvedExactly).toBe(true);
    const tampered = buildObservedBinding({ ...goodObs, weightFiles: [{ file: "m.safetensors", sizeBytes: 10, sha256: "DIFFERENT" }] }, bareSha);
    expect(resolveLocalTarget(exp2, tampered, TS).reasons.join(";")).toMatch(/weightManifestDigest mismatch/);
  });
});

describe("C1-R3-F02 artifact reference containment + full content address (Authority: path traversal)", () => {
  it("rejects a parent-directory traversal reference", () => {
    expect(verifyReferencedArtifact(root, { file: "../outside.json", sha256: "sha256:x" }, "catalog").reason).toBe("catalog_ref_path_separator");
  });
  it("rejects an absolute-path reference", () => {
    expect(verifyReferencedArtifact(root, { file: "/etc/hostname", sha256: "sha256:x" }, "catalog").reason).toBe("catalog_ref_path_separator");
  });
  it("rejects a nested-path reference", () => {
    expect(verifyReferencedArtifact(root, { file: "sub/dir.json", sha256: "sha256:x" }, "catalog").reason).toBe("catalog_ref_path_separator");
  });
  it("rejects a '..' component", () => {
    expect(verifyReferencedArtifact(root, { file: "..", sha256: "sha256:x" }, "catalog").reason).toBe("catalog_ref_dot_component");
  });
  it("rejects a symlinked artifact ancestor/file", () => {
    const body = "{}";
    const target = join(root, "real.json");
    writeFileSync(target, body);
    symlinkSync(target, join(root, `catalog-preflight-${bareSha(body)}.json`));
    expect(verifyReferencedArtifact(root, { file: `catalog-preflight-${bareSha(body)}.json`, sha256: sha256(body) }, "catalog").reason).toBe("catalog_ref_not_regular_file");
  });
  it("rejects a 64-hex filename whose suffix != body digest", () => {
    const body = '{"x":1}';
    const wrongName = `catalog-preflight-${"a".repeat(64)}.json`;
    writeFileSync(join(root, wrongName), body, { mode: 0o600 });
    expect(verifyReferencedArtifact(root, { file: wrongName, sha256: sha256(body) }, "catalog").reason).toBe("catalog_ref_filename_digest_mismatch");
  });
  it("resume allowlist rejects a content-addressed artifact whose name/body disagree", async () => {
    await freshAll();
    dropManifests(root);
    writeFileSync(join(root, `continuation-summary-${"a".repeat(64)}.json`), "{}", { mode: 0o600 });
    const { gen } = recordingGenerate(qualifyingFacts);
    await expect(runContinuation(base({ generate: gen, isResume: true }))).rejects.toThrow(/filename\/body digest mismatch/);
  });
});

describe("C1-R3-F03 wire evidence re-derivable + hosted provenance (Authority: wire body欠落 / provider欠落)", () => {
  const req: RequestBody = { model: "openai/gpt-5.6-sol-pro", maxTokens: 8192, temperature: 0, topP: 1, seed: 1 };
  const messages = [{ role: "user" as const, content: "hi" }];
  const completion = { id: "gen-1", model: "openai/gpt-5.6-sol-pro", provider: "VendorCloud", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: {} };
  it("captures request AND response wire digests/bytes/status, re-derivable from stored bytes", async () => {
    const bodyText = JSON.stringify(completion);
    const facts = await dispatchViaBackend({
      backendId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", timeoutMs: 1000, isHosted: true, req, messages, now: () => TS,
      fetchFn: async () => jsonResponse(bodyText),
      costLookup: async (id) => ({ lookupOk: true, generationId: id, actualCostUsd: 0.002, provider: "VendorCloud", responseModelId: "openai/gpt-5.6-sol-pro", rawBodySha256: "sha256:deadbeef", rawBodyBytes: 42, httpStatus: 200 }),
    });
    expect(facts.responseWireSha256).toBe(sha256(bodyText));
    expect(facts.responseWireBytes).toBe(Buffer.byteLength(bodyText, "utf-8"));
    expect(facts.responseHttpStatus).toBe(200);
    expect(facts.responseReceivedUtc).toBe(TS);
    expect(facts.requestWireSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(facts.costLookupWireSha256).toBe("sha256:deadbeef");
    expect(facts.costLookupWireBytes).toBe(42);
    expect(facts.costLookupHttpStatus).toBe(200);
  });
  it("an HTTP-error response still carries response wire digest/status (evidence kept)", async () => {
    const errBody = JSON.stringify({ error: { message: "boom" } });
    const facts = await dispatchViaBackend({ backendId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", timeoutMs: 1000, isHosted: true, req, messages, now: () => TS, fetchFn: async () => jsonResponse(errBody, 500) });
    expect(facts.transportError).toBeNull();
    expect(facts.responseHttpStatus).toBe(500);
    expect(facts.responseWireSha256).toBe(sha256(errBody));
  });
  it("hosted response missing a provider fails continuation validation", () => {
    const cv = computeContinuationValidation({
      expected: { requestedSlug: "m", resolvedSlug: "m", maxTokens: 10, sampling: {} },
      observed: { requestModel: "m", requestMaxTokens: 10, requestSampling: {}, responseModelId: "m", responseReceived: true, resolvedSlug: "m", resolvedExactly: true, substitutionUsed: false, fallbackUsed: false, responseProvider: null, lookupProvider: "VendorCloud", responseGenerationId: "g", lookupGenerationId: "g", lookupModelId: "m", isHosted: true },
    });
    expect(cv.ok).toBe(false);
    expect(cv.reasons.join(";")).toMatch(/hosted response provider missing/);
  });
  it("hosted response missing a generation-lookup id fails validation", () => {
    const cv = computeContinuationValidation({
      expected: { requestedSlug: "m", resolvedSlug: "m", maxTokens: 10, sampling: {} },
      observed: { requestModel: "m", requestMaxTokens: 10, requestSampling: {}, responseModelId: "m", responseReceived: true, resolvedSlug: "m", resolvedExactly: true, substitutionUsed: false, fallbackUsed: false, responseProvider: "VendorCloud", lookupProvider: "VendorCloud", responseGenerationId: "g", lookupGenerationId: null, lookupModelId: "m", isHosted: true },
    });
    expect(cv.reasons.join(";")).toMatch(/hosted generation-lookup id missing/);
  });
  it("a local (vLLM) target is exempt from the hosted lookup requirement", () => {
    const cv = computeContinuationValidation({
      expected: { requestedSlug: "Q", resolvedSlug: "Q", maxTokens: 10, sampling: {} },
      observed: { requestModel: "Q", requestMaxTokens: 10, requestSampling: {}, responseModelId: "Q", responseReceived: true, resolvedSlug: "Q", resolvedExactly: true, substitutionUsed: false, fallbackUsed: false, responseProvider: "local-vllm", isHosted: false },
    });
    expect(cv.ok).toBe(true);
  });
  it("runContinuation stops (after finalize) on a hosted response with no provider", async () => {
    const { gen } = recordingGenerate((c, p, r, i) => (i === 0 ? { ...qualifyingFacts(c, p, r), responseProvider: null } : qualifyingFacts(c, p, r)));
    const res = await runContinuation(base({ generate: gen }));
    expect(res.stopped).toMatch(/^continuation_validation_failed/);
    const rec = JSON.parse(readFileSync(join(root, "runs", runIdFor(1, OPENAI_SENTINEL) + ".json"), "utf-8"));
    expect(rec.continuationValidation.ok).toBe(false);
  });
});

describe("C1-R3-F04 resume re-derives from wire body + manifest chain (Authority: forged resume record)", () => {
  it("resumeWireConsistency rejects a wrong-model wire body even with consistently forged top-level fields", () => {
    const rec = {
      status: { transport: "received", response: "received", finalCompleteness: "complete", qualification: "pass", failureReasons: [] },
      error: null,
      rawResponse: { id: "gen-1", model: "other/wrong-model", provider: "X" },
      responseModelId: "other/wrong-model",
      responseGenerationId: "gen-1",
      responseProvider: "X",
      continuationValidation: { ok: true, reasons: [] },
    } as unknown as PersistedRecordShape;
    const r = resumeWireConsistency(rec, { resolvedSlug: "openai/gpt-5.6-sol-pro" });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(";")).toMatch(/wire response model other\/wrong-model != expected/);
  });
  it("resumeWireConsistency rejects a headline that disagrees with the wire body", () => {
    const rec = {
      status: { transport: "received" }, error: null,
      rawResponse: { id: "gen-1", model: "openai/gpt-5.6-sol-pro" },
      responseModelId: "other/forged",
    } as unknown as PersistedRecordShape;
    expect(resumeWireConsistency(rec, { resolvedSlug: "openai/gpt-5.6-sol-pro" }).reasons.join(";")).toMatch(/stored responseModelId .* != wire model/);
  });
  it("resume stops on a consistently-forged wrong-model record (integration)", async () => {
    await freshAll();
    const order = deriveContinuationPlan(buildFrozenOrder()).continuation;
    const path = join(root, "runs", `${runIdFor(1, order[0])}.json`);
    const rec = JSON.parse(readFileSync(path, "utf-8"));
    rec.rawResponse.model = "other/substituted-model";
    rec.attempts[0].rawResponse.model = "other/substituted-model";
    const hTop = hashRawResponse(rec.rawResponse);
    rec.rawResponseSha256 = hTop.sha256;
    rec.rawResponseBytes = hTop.byteLength;
    const hAt = hashRawResponse(rec.attempts[0].rawResponse);
    rec.attempts[0].rawResponseSha256 = hAt.sha256;
    rec.attempts[0].rawResponseBytes = hAt.byteLength;
    rec.responseModelId = "other/substituted-model";
    rec.continuationValidation = { ok: true, reasons: [] };
    writeFileSync(path, JSON.stringify(rec), { mode: 0o600 });
    dropManifests(root);
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, isResume: true }));
    expect(res.stopped).toBe("record_inconsistent_with_plan");
    expect(history).toHaveLength(0);
  });
  it("verifyRuntimeManifestChain accepts a clean genesis and detects a 1-byte record tamper", async () => {
    await freshAll();
    expect(verifyRuntimeManifestChain(root, realChainOpts()).ok).toBe(true);
    const order = deriveContinuationPlan(buildFrozenOrder()).continuation;
    const p = join(root, "runs", `${runIdFor(1, order[0])}.json`);
    const rec = JSON.parse(readFileSync(p, "utf-8"));
    rec.timestamp = "TAMPERED";
    writeFileSync(p, JSON.stringify(rec), { mode: 0o600 });
    const chain = verifyRuntimeManifestChain(root, realChainOpts());
    expect(chain.ok).toBe(false);
    expect(chain.reason).toMatch(/manifest_ref_digest_mismatch/);
  });
  it("runContinuation resume stops on a tampered manifest-bound record", async () => {
    await freshAll();
    const order = deriveContinuationPlan(buildFrozenOrder()).continuation;
    const p = join(root, "runs", `${runIdFor(1, order[0])}.json`);
    const rec = JSON.parse(readFileSync(p, "utf-8"));
    rec.timestamp = "TAMPERED";
    writeFileSync(p, JSON.stringify(rec), { mode: 0o600 });
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, isResume: true }));
    expect(res.stopped).toMatch(/^manifest_chain_invalid:manifest_ref_digest_mismatch/);
    expect(history).toHaveLength(0);
  });
  it("verifyRuntimeManifestChain rejects a fork (two genesis manifests)", () => {
    const s1 = writeContentAddressed(root, "continuation-summary", { s: 1 });
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: mref(root, s1), requiredRefs: [s1] }, 0));
    const s2 = writeContentAddressed(root, "continuation-summary", { s: 2 });
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: mref(root, s2), requiredRefs: [s2] }, 1));
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/fork_or_gap/);
  });
  it("verifyRuntimeManifestChain rejects an orphan summary not bound to the chain", () => {
    const s1 = writeContentAddressed(root, "continuation-summary", { s: 1 });
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: mref(root, s1), requiredRefs: [s1] }, 0));
    writeContentAddressed(root, "continuation-summary", { orphan: true });
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/orphan_artifact/);
  });
  it("verifyRuntimeManifestChain accepts a valid 2-link chain", () => {
    const s1 = writeContentAddressed(root, "continuation-summary", { s: 1 });
    const m1 = writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: mref(root, s1), requiredRefs: [s1] }, 0));
    const s2 = writeContentAddressed(root, "continuation-summary", { s: 2 });
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: mref(root, s2), priorRuntimeManifests: [mref(root, m1)], requiredRefs: [s2, m1] }, 1));
    const chain = verifyRuntimeManifestChain(root, synthChainOpts());
    expect(chain.ok).toBe(true);
    expect(chain.length).toBe(2);
  });
});

describe("C1-R3-F05 invocation lock + atomic no-replace (Authority: durability / concurrency)", () => {
  it("acquireInvocationLock is exclusive: a second acquire fails closed", () => {
    const l = acquireInvocationLock(root, { stageId: "s", invocationId: "i1", startedAt: TS });
    try {
      expect(() => acquireInvocationLock(root, { stageId: "s", invocationId: "i2", startedAt: TS })).toThrow(/already held/);
    } finally {
      releaseInvocationLock(l);
    }
  });
  it("a stale lock (crash residue) blocks a fresh run — never auto-deleted", async () => {
    const l = acquireInvocationLock(root, { stageId: "s", invocationId: "i1", startedAt: TS });
    const { gen } = recordingGenerate(qualifyingFacts);
    await expect(runContinuation(base({ generate: gen }))).rejects.toThrow(/already held/);
    releaseInvocationLock(l);
  });
  it("finalizeArtifact with a released lock refuses to finalize", () => {
    const l = acquireInvocationLock(root, { stageId: "s", invocationId: "i1", startedAt: TS });
    releaseInvocationLock(l);
    expect(() => finalizeArtifact(root, `catalog-preflight-${bareSha("{}")}.json`, "{}", l)).toThrow(/released/);
  });
  it("finalizeArtifact is atomic no-replace: a racing file with different content is never overwritten", () => {
    const name = `catalog-preflight-${bareSha("BODY")}.json`;
    writeFileSync(join(root, name), "OTHER", { mode: 0o600 });
    withLock(root, (l) => expect(() => finalizeArtifact(root, name, "BODY", l)).toThrow(/different content/));
    expect(readFileSync(join(root, name), "utf-8")).toBe("OTHER");
  });
  it("a clean run releases the lock (no residue)", async () => {
    await freshAll();
    expect(existsSync(join(root, ".continuation.lock"))).toBe(false);
  });
});

// ============================================================================
// Stage C1 r5 — C1-R4-F01..F08 offline tests
// ============================================================================

describe("C1-R4-F01 production local runtime observer (mock command / filesystem / fetch)", () => {
  const REV = "a".repeat(40);
  const CACHE = "/cache";
  const REPO = "x/model";
  // HF cache layout: models--x--model decodes to the repo id "x/model" (C1-R5-F01).
  const SNAP = `${CACHE}/hub/models--x--model/snapshots/${REV}`;
  const IMAGE = "vllm/img@sha256:aa";
  const VERSION = "0.9";
  // The engine command carries tensor parallelism + dtype (as the real parent does),
  // so the observer re-derives and gates them from the LIVE argv, never the parent.
  const ENGINE = `serve --model ${REPO} --revision ${REV} --served-model-name ${REPO} --tensor-parallel-size 2 --dtype bfloat16`;
  const BASE_CMD = ENGINE.split(" ");
  const FILES: Record<string, Buffer> = {
    "config.json": Buffer.from('{"k":1}'),
    "model.safetensors": Buffer.from("WEIGHTS-0123456789"),
  };
  const wf: WeightFileEntry[] = Object.entries(FILES).map(([file, buf]) => ({
    file,
    sizeBytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  }));
  const EXPECTED: ExpectedLocalRuntime = {
    requestedSlug: "x/model",
    containerName: "vllm-x",
    endpoint: "http://localhost:8001/v1",
    servedModelId: "x/model",
    vllmImage: IMAGE,
    vllmVersion: VERSION,
    engineArgs: ENGINE,
    dtype: "bfloat16",
    quantization: "none",
    tensorParallelSize: 2,
    checkpointRevision: REV,
    snapshotPath: SNAP,
    weightFiles: wf,
  };
  const MODELS_DIR = `${CACHE}/hub/models--x--model`;
  const DIRS = new Set([CACHE, `${CACHE}/hub`, MODELS_DIR, `${MODELS_DIR}/snapshots`, SNAP]);
  function mockFs(over?: {
    symlinkEscape?: boolean;
    symlinkToDir?: boolean;
    extraFile?: boolean;
    duplicate?: boolean;
    missing?: boolean;
    sizeMismatch?: boolean;
    digestMismatch?: boolean;
  }): ObserverFs {
    const names = Object.keys(FILES).filter((n) => !(over?.missing && n === "config.json"));
    if (over?.extraFile) names.push("EXTRA.bin");
    if (over?.symlinkToDir) names.push("dirlink");
    const symPath = `${SNAP}/model.safetensors`;
    const dirLinkPath = `${SNAP}/dirlink`;
    return {
      realpath: (p) =>
        over?.symlinkEscape && p === symPath
          ? "/outside/evil"
          : over?.symlinkToDir && p === dirLinkPath
            ? `${SNAP}/subdir`
            : p,
      lstat: (p) => {
        const isSym = (!!over?.symlinkEscape && p === symPath) || (!!over?.symlinkToDir && p === dirLinkPath);
        const isDir = DIRS.has(p) || p === `${SNAP}/subdir`;
        return {
          isSymbolicLink: () => isSym,
          isFile: () => !isDir && !isSym,
          isDirectory: () => isDir,
        } as ReturnType<ObserverFs["lstat"]>;
      },
      readdir: (p) => (p === SNAP ? names : []),
      hashFile: async (p) => {
        const name = p.slice(SNAP.length + 1);
        if (name === "EXTRA.bin") return { sizeBytes: 3, sha256: "ff".repeat(32) };
        const buf = FILES[name];
        let sha = createHash("sha256").update(buf).digest("hex");
        let size = buf.length;
        if (over?.sizeMismatch && name === "model.safetensors") size = 999;
        if (over?.digestMismatch && name === "model.safetensors") sha = "00".repeat(32);
        return { sizeBytes: size, sha256: sha };
      },
    };
  }
  const inspectJson = (over?: Record<string, unknown>) =>
    JSON.stringify({
      State: { Running: true },
      // Env carries the HF hub cache so --model (repo id) resolves mechanically to the
      // mount-derived snapshot path (C1-R6-F01): /hf/hub == HF_HUB_CACHE, mount /cache->/hf.
      Config: { Image: IMAGE, Cmd: BASE_CMD, Env: ["HF_HUB_CACHE=/hf/hub"] },
      Mounts: [{ Type: "bind", Source: CACHE, Destination: "/hf" }],
      ...over,
    });
  const imageJson = (over?: Record<string, unknown>) =>
    JSON.stringify({ Id: "sha256:img0", RepoDigests: [IMAGE], Config: { Labels: { "org.opencontainers.image.version": VERSION } }, ...over });
  /** Dispatch the SHELL-FREE argv: `image inspect` vs container `inspect`. */
  function mkRun(container: CommandResult, image?: CommandResult): CommandRunner {
    return (argv) => (argv.includes("image") ? (image ?? { status: 0, stdout: imageJson(), stderr: "", timedOut: false }) : container);
  }
  const containerOk = (over?: Record<string, unknown>): CommandResult => ({ status: 0, stdout: inspectJson(over), stderr: "", timedOut: false });
  const cmdOk = (): CommandRunner => mkRun(containerOk());
  const modelsOk = async () => ({ status: 200, text: async () => JSON.stringify({ data: [{ id: "x/model" }] }) });
  function deps(over?: Partial<ObserverDeps>): ObserverDeps {
    return {
      runCommand: cmdOk(),
      fs: mockFs(),
      fetchModels: modelsOk,
      now: () => TS,
      ...over,
    };
  }
  /** A live container Cmd that replaces the value AFTER `flag` in the base command. */
  const cmdWith = (flag: string, value: string): CommandResult => {
    const c = [...BASE_CMD];
    const i = c.indexOf(flag);
    if (i >= 0) c[i + 1] = value;
    return containerOk({ Config: { Image: IMAGE, Cmd: c } });
  };
  const cmdExtra = (...extra: string[]): CommandResult => containerOk({ Config: { Image: IMAGE, Cmd: [...BASE_CMD, ...extra] } });

  it("returns a fully-measured observation on the happy path (OCI → image → hash → /v1/models)", async () => {
    const { observation, reasons } = await observeLocalRuntime(EXPECTED, deps());
    expect(reasons).toEqual([]);
    expect(observation).not.toBeNull();
    expect(observation!.healthy).toBe(true);
    expect(observation!.checkpointRevision).toBe(REV);
    expect(observation!.weightFiles).toHaveLength(2);
    expect(observation!.capturedAtUtc).toBe(TS);
    // The container-internal checkpoint path is derived from the mount (Source→Dest).
    expect(observation!.observedCheckpointPath).toBe(`/hf/hub/models--x--model/snapshots/${REV}`);
    // The serving config is re-derived from the LIVE argv + image label.
    expect(observation!.servingObserved!.tensorParallelSize).toBe(2);
    expect(observation!.servingObserved!.vllmVersion).toBe(VERSION);
  });
  const failCases: Array<[string, Partial<ObserverDeps>, RegExp]> = [
    ["OCI tool unavailable", { runCommand: mkRun({ status: null, stdout: "", stderr: "", timedOut: false, error: "spawn docker ENOENT" }) }, /oci_tool_unavailable/],
    ["OCI inspect timeout", { runCommand: mkRun({ status: null, stdout: "", stderr: "", timedOut: true }) }, /oci_inspect_timeout/],
    ["container not found (empty)", { runCommand: mkRun({ status: 0, stdout: "", stderr: "", timedOut: false }) }, /oci_container_not_found/],
    ["container not unique (two)", { runCommand: mkRun({ status: 0, stdout: inspectJson() + "\n" + inspectJson(), stderr: "", timedOut: false }) }, /oci_container_not_unique/],
    ["not running", { runCommand: mkRun(containerOk({ State: { Running: false } })) }, /oci_container_not_running/],
    ["image label mismatch", { runCommand: mkRun(containerOk({ Config: { Image: "other", Cmd: BASE_CMD } })) }, /oci_image_mismatch/],
    // C1-R5-F01: each of these is now GATED from the live argv / image (r5 transcribed them).
    ["command revision mismatch", { runCommand: mkRun(cmdWith("--revision", "b".repeat(40))) }, /oci_command_revision_mismatch/],
    ["command served-model mismatch", { runCommand: mkRun(cmdWith("--served-model-name", "other")) }, /oci_command_served_model_mismatch/],
    ["command model (repo) mismatch", { runCommand: mkRun(cmdWith("--model", "y/model")) }, /oci_command_model_path_mismatch/],
    ["WRONG tensor-parallel-size (99 vs 2)", { runCommand: mkRun(cmdWith("--tensor-parallel-size", "99")) }, /oci_command_engine_args_mismatch/],
    ["WRONG dtype (float16 vs bfloat16)", { runCommand: mkRun(cmdWith("--dtype", "float16")) }, /oci_command_engine_args_mismatch/],
    ["EXTRA quantization flag (awq)", { runCommand: mkRun(cmdExtra("--quantization", "awq")) }, /oci_command_engine_args_mismatch/],
    ["duplicate flag in live argv", { runCommand: mkRun(cmdExtra("--dtype", "bfloat16")) }, /oci_command_engine_args_duplicate_flag/],
    ["conflicting alias (-tp vs --tensor-parallel-size)", { runCommand: mkRun(cmdExtra("-tp", "2")) }, /oci_command_engine_args_(duplicate|conflicting)_flag/],
    ["flag missing value", { runCommand: mkRun(containerOk({ Config: { Image: IMAGE, Cmd: ["serve", "--model", REPO, "--revision"] } })) }, /oci_command_engine_args_missing_value/],
    ["image digest not carried", { runCommand: mkRun(containerOk(), { status: 0, stdout: imageJson({ RepoDigests: ["other@sha256:zz"] }), stderr: "", timedOut: false }) }, /oci_image_digest_mismatch/],
    ["image version unobservable (no label)", { runCommand: mkRun(containerOk(), { status: 0, stdout: imageJson({ Config: { Labels: {} } }), stderr: "", timedOut: false }) }, /oci_image_version_unobservable/],
    ["image version mismatch (label 9.9)", { runCommand: mkRun(containerOk(), { status: 0, stdout: imageJson({ Config: { Labels: { "vllm.version": "9.9" } } }), stderr: "", timedOut: false }) }, /oci_image_version_mismatch/],
    ["mount not covering snapshot", { runCommand: mkRun(containerOk({ Mounts: [{ Type: "bind", Source: "/somewhere-else", Destination: "/hf" }] })) }, /oci_mount_not_covering_snapshot/],
    ["mount ambiguous (two covering)", { runCommand: mkRun(containerOk({ Mounts: [{ Source: CACHE, Destination: "/hf" }, { Source: `${CACHE}/hub`, Destination: "/hf2" }] })) }, /oci_mount_ambiguous/],
    ["mount without destination", { runCommand: mkRun(containerOk({ Mounts: [{ Source: CACHE }] })) }, /oci_mount_no_destination/],
    ["extra file in snapshot", { fs: mockFs({ extraFile: true }) }, /snapshot_extra_file/],
    ["missing file in snapshot", { fs: mockFs({ missing: true }) }, /snapshot_missing_file/],
    ["size mismatch", { fs: mockFs({ sizeMismatch: true }) }, /snapshot_size_mismatch/],
    ["digest mismatch", { fs: mockFs({ digestMismatch: true }) }, /snapshot_digest_mismatch/],
    ["symlink escapes cache root", { fs: mockFs({ symlinkEscape: true }) }, /snapshot_symlink_escape/],
    ["symlink to a directory is not a regular file", { fs: mockFs({ symlinkToDir: true }) }, /snapshot_symlink_not_regular_file/],
    ["/v1/models non-200", { fetchModels: async () => ({ status: 503, text: async () => "" }) }, /models_http_503/],
    ["served model absent from /v1/models", { fetchModels: async () => ({ status: 200, text: async () => JSON.stringify({ data: [{ id: "someone-else" }] }) }) }, /models_served_model_absent/],
  ];
  for (const [name, over, re] of failCases) {
    it(`fails closed (no observation) when: ${name}`, async () => {
      const { observation, reasons } = await observeLocalRuntime(EXPECTED, deps(over));
      expect(observation).toBeNull();
      expect(reasons.join(",")).toMatch(re);
    });
  }
  it("rejects a DUPLICATE expected weight-file path before hashing (F05)", async () => {
    const dupExpected = { ...EXPECTED, weightFiles: [...wf, { ...wf[0] }] };
    const { observation, reasons } = await observeLocalRuntime(dupExpected, deps());
    expect(observation).toBeNull();
    expect(reasons.join(",")).toMatch(/expected_duplicate_file/);
  });
  it("rejects an absolute expected weight-file path (F05)", async () => {
    const absExpected = { ...EXPECTED, weightFiles: [{ file: "/etc/passwd", sizeBytes: 1, sha256: "aa" }, ...wf] };
    const { observation, reasons } = await observeLocalRuntime(absExpected, deps());
    expect(observation).toBeNull();
    expect(reasons.join(",")).toMatch(/expected_weight_path_absolute/);
  });
  it("rejects a snapshot whose basename is not the pinned revision", async () => {
    const badSnap = `${MODELS_DIR}/snapshots/not-the-revision`;
    const bad = { ...EXPECTED, snapshotPath: badSnap };
    const badDirs = new Set([CACHE, `${CACHE}/hub`, MODELS_DIR, `${MODELS_DIR}/snapshots`, badSnap]);
    const fs: ObserverFs = {
      ...mockFs(),
      realpath: (p) => p,
      lstat: (p) => ({ isSymbolicLink: () => false, isFile: () => !badDirs.has(p), isDirectory: () => badDirs.has(p) }) as ReturnType<ObserverFs["lstat"]>,
      readdir: (p) => (p === badSnap ? Object.keys(FILES) : []),
    };
    const { observation, reasons } = await observeLocalRuntime(bad, deps({ fs }));
    expect(observation).toBeNull();
    expect(reasons.join(",")).toMatch(/snapshot_basename_revision_mismatch/);
  });
  it("makeProductionObserver drives the REAL observer (non-null on pass) and is fail-closed for an unknown slug", async () => {
    const observe = makeProductionObserver([EXPECTED], deps());
    expect(await observe({ slug: "x/model", baseUrl: EXPECTED.endpoint })).not.toBeNull();
    expect(await observe({ slug: "unknown/target", baseUrl: "http://x" })).toBeNull();
  });
  it("makeProductionObserver returns null (fail-closed) when the OCI tool is unavailable — never a null-observer stand-in", async () => {
    const observe = makeProductionObserver([EXPECTED], deps({ runCommand: () => ({ status: null, stdout: "", stderr: "", timedOut: false, error: "ENOENT" }) }));
    expect(await observe({ slug: "x/model", baseUrl: EXPECTED.endpoint })).toBeNull();
  });
  it("C1-R6-F01: does NOT transcribe a descriptor when --dtype / --quantization are absent from the argv", async () => {
    const noDtypeEngine = `serve --model ${REPO} --revision ${REV} --served-model-name ${REPO} --tensor-parallel-size 2`;
    const exp2: ExpectedLocalRuntime = { ...EXPECTED, engineArgs: noDtypeEngine, dtype: "as-published", quantization: "mxfp4 (published)" };
    const cmd = containerOk({ Config: { Image: IMAGE, Cmd: noDtypeEngine.split(" "), Env: ["HF_HUB_CACHE=/hf/hub"] } });
    const { observation, reasons } = await observeLocalRuntime(exp2, deps({ runCommand: mkRun(cmd) }));
    expect(reasons).toEqual([]);
    expect(observation).not.toBeNull();
    // The absent flags are recorded as null — the expected descriptors are NOT substituted.
    expect(observation!.servingObserved!.dtype).toBeNull();
    expect(observation!.servingObserved!.quantization).toBeNull();
    expect(observation!.precision).toBeNull();
  });
  it("C1-R6-F01: fails closed when the mount destination does not resolve the --model load path", async () => {
    const { observation, reasons } = await observeLocalRuntime(EXPECTED, deps({ runCommand: mkRun(containerOk({ Mounts: [{ Source: CACHE, Destination: "/wrong" }] })) }));
    expect(observation).toBeNull();
    expect(reasons.join(",")).toMatch(/oci_model_path_not_resolved/);
  });
  it("deriveExpectedLocalRuntimes projects container / snapshot / revision / files from the parent shapes", () => {
    const rt = deriveExpectedLocalRuntimes({
      a100Preflight: { servers: [{ target: "x/model", container: "vllm-x", endpoint: EXPECTED.endpoint, load: { servedModelId: "x/model" }, serving: { tensorParallelSize: 2, dtype: "bfloat16", quantization: "none", vllmImage: EXPECTED.vllmImage, vllmVersion: "0.9", engineArgs: EXPECTED.engineArgs } }] },
      checkpoints: [{ target: "x/model", expectedOfficialCheckpointSha: REV, snapshotPath: SNAP, weightFiles: wf, weightFileCount: 2, totalBytes: 25, quantization: "none" }],
    });
    expect(rt[0].containerName).toBe("vllm-x");
    expect(rt[0].snapshotPath).toBe(SNAP);
    expect(rt[0].checkpointRevision).toBe(REV);
    expect(rt[0].weightFiles).toHaveLength(2);
  });
});

describe("C1-R4-F07 deterministic ordering (explicit collator, not default locale)", () => {
  it("reports the fixed en-US-u-co-default collator resolved options", () => {
    const o = weightFileCollatorReport();
    expect(o.locale).toBe("en-US");
    expect(o.usage).toBe("sort");
    expect(o.sensitivity).toBe("variant");
    expect(o.numeric).toBe(false);
    expect(o.caseFirst).toBe("false");
    expect(o.ignorePunctuation).toBe(false);
  });
  it("weightManifestDigest is order-independent and stable regardless of input order", () => {
    const files: WeightFileEntry[] = [
      { file: "model-00002-of-00003.safetensors", sizeBytes: 2, sha256: "bb" },
      { file: "model-00001-of-00003.safetensors", sizeBytes: 1, sha256: "aa" },
      { file: ".gitattributes", sizeBytes: 3, sha256: "cc" },
    ];
    const a = weightManifestDigest(files, bareSha).digest;
    const b = weightManifestDigest([...files].reverse(), bareSha).digest;
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("C1-R4-F02 wire preimage (byte-preserving evidence)", () => {
  it("encodeWireBody round-trips exact bytes with a matching sha / length", () => {
    const p = encodeWireBody("héllo {}");
    expect(p.encoding).toBe("base64");
    expect(Buffer.from(p.base64, "base64").toString("utf-8")).toBe("héllo {}");
    expect(p.bytes).toBe(Buffer.byteLength("héllo {}", "utf-8"));
    expect(verifyWireBody(p).ok).toBe(true);
  });
  it("preserves invalid-UTF-8 bytes verbatim (never a .text() re-encode)", () => {
    const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    const p = encodeWireBody(raw);
    expect(Buffer.from(p.base64, "base64")).toEqual(Buffer.from(raw));
    expect(verifyWireBody(p).ok).toBe(true);
  });
  it("verifyWireBody rejects a tampered digest / byte length / encoding", () => {
    const p = encodeWireBody("{}");
    expect(verifyWireBody({ ...p, sha256: `sha256:${"0".repeat(64)}` }).reason).toBe("wire_body_digest_mismatch");
    expect(verifyWireBody({ ...p, bytes: p.bytes + 1 }).reason).toBe("wire_body_bytes_mismatch");
    expect(verifyWireBody({ ...p, encoding: "utf8" as unknown as "base64" }).reason).toBe("wire_body_encoding");
    expect(verifyWireBody(null).reason).toBe("wire_body_missing");
  });
  it("sanitizeHeaders is an allowlist — drops authorization / cookie / set-cookie / api key", () => {
    const h = sanitizeHeaders([
      ["Authorization", "Bearer secret"],
      ["Cookie", "s=1"],
      ["Set-Cookie", "s=1"],
      ["x-api-key", "k"],
      ["Content-Type", "application/json"],
      ["X-Provider-Name", "VendorCloud"],
    ]);
    expect(h).toEqual({ "content-type": "application/json", "x-provider-name": "VendorCloud" });
  });
  it("reDeriveResponseIdentity / reDeriveCost re-derive from the stored bytes", () => {
    const resp = encodeWireBody(JSON.stringify({ id: "g1", model: "m", provider: "P", choices: [{ finish_reason: "stop" }] }));
    const id = reDeriveResponseIdentity(resp);
    expect(id.ok && id.identity.model).toBe("m");
    expect(id.ok && id.identity.provider).toBe("P");
    const cost = encodeWireBody(JSON.stringify({ data: { id: "g1", model: "m", provider_name: "P", total_cost: 0.5 } }));
    const c = reDeriveCost(cost);
    expect(c.ok && c.cost.actualCostUsd).toBe(0.5);
  });

  const req: RequestBody = { model: "openai/gpt-5.6-sol-pro", maxTokens: 8192, temperature: 0, topP: 1, seed: 1 };
  const messages = [{ role: "user" as const, content: "hi" }];
  it("dispatchViaBackend captures the response via a byte-preserving preimage and sanitizes headers", async () => {
    const completion = { id: "gen-1", model: "openai/gpt-5.6-sol-pro", provider: "VendorCloud", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: {} };
    const facts = await dispatchViaBackend({
      backendId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      timeoutMs: 1000,
      isHosted: true,
      req,
      messages,
      now: () => TS,
      fetchFn: async () => new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json", authorization: "Bearer secret", "x-provider-name": "VendorCloud" } }),
      costLookup: async (id) => ({ lookupOk: true, generationId: id, actualCostUsd: 0.002, provider: "VendorCloud", responseModelId: "openai/gpt-5.6-sol-pro" }),
    });
    expect(facts.wire!.response.body).not.toBeNull();
    expect(verifyWireBody(facts.wire!.response.body).ok).toBe(true);
    expect(facts.wire!.response.headers).not.toHaveProperty("authorization");
    expect(facts.wire!.request.body).not.toBeNull();
    expect(verifyWireBody(facts.wire!.request.body).ok).toBe(true);
  });
  it("dispatchViaBackend takes the response provider from a sanitized header when the payload omits it", async () => {
    const completion = { id: "gen-1", model: "openai/gpt-5.6-sol-pro", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: {} };
    const facts = await dispatchViaBackend({
      backendId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", timeoutMs: 1000, isHosted: true, req, messages, now: () => TS,
      fetchFn: async () => new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json", "x-provider-name": "HeaderVendor" } }),
      costLookup: async (id) => ({ lookupOk: true, generationId: id, actualCostUsd: 0.002, provider: "HeaderVendor", responseModelId: "openai/gpt-5.6-sol-pro" }),
    });
    expect(facts.responseProvider).toBe("HeaderVendor");
  });

  const noSleep = () => Promise.resolve();
  const seqFetch = (seq: Response[]): typeof fetch => {
    let i = 0;
    return (async () => seq[Math.min(i++, seq.length - 1)]) as unknown as typeof fetch;
  };
  it("generationCost keeps every poll's whole wire evidence and re-derives from the final poll", async () => {
    const g = await generationCost("id1", "key", {
      now: () => TS,
      sleep: noSleep,
      fetchFn: seqFetch([new Response(JSON.stringify({ data: { id: "id1", model: "m", provider_name: "P", total_cost: 0.7 } }), { status: 200 })]) as never,
    });
    expect(g.lookupOk).toBe(true);
    expect(g.wire!.finalOk).toBe(true);
    expect(g.wire!.polls).toHaveLength(1);
    expect(g.actualCostUsd).toBe(0.7);
    expect(verifyWireBody(g.wire!.polls[0].body).ok).toBe(true);
  });
  it("generationCost keeps a non-200 / invalid-JSON / no-data poll body, then succeeds", async () => {
    const g = await generationCost("id1", "key", {
      now: () => TS,
      sleep: noSleep,
      fetchFn: seqFetch([
        new Response("upstream 500", { status: 500 }),
        new Response("{not json", { status: 200 }),
        new Response(JSON.stringify({}), { status: 200 }),
        new Response(JSON.stringify({ data: { id: "id1", model: "m", provider_name: "P", total_cost: 0.1 } }), { status: 200 }),
      ]) as never,
    });
    expect(g.lookupOk).toBe(true);
    expect(g.wire!.polls.length).toBe(4);
    // Discriminated union (C1-R6-F02): jsonParsed / dataPresent are decomposed from
    // the HTTP status; a non-200 and a 200-no-data are preserved whole, not masked.
    const p0 = g.wire!.polls[0];
    expect(p0.kind).toBe("http_response");
    if (p0.kind === "http_response") {
      expect(p0.httpStatus).toBe(500);
      expect(p0.jsonParsed).toBe(false); // "upstream 500" is not JSON
      expect(p0.dataPresent).toBe(false);
    }
    const p1 = g.wire!.polls[1];
    if (p1.kind === "http_response") expect(p1.jsonParsed).toBe(false); // "{not json"
    const p2 = g.wire!.polls[2];
    if (p2.kind === "http_response") {
      expect(p2.jsonParsed).toBe(true); // "{}" is valid JSON
      expect(p2.dataPresent).toBe(false); // but carries no data
    }
    for (const p of g.wire!.polls) if (p.kind === "http_response") expect(verifyWireBody(p.body).ok).toBe(true);
  });
  it("generationCost preserves an invalid-UTF-8 body and reports the final failure without losing polls", async () => {
    const g = await generationCost("id1", "key", {
      now: () => TS,
      sleep: noSleep,
      fetchFn: seqFetch([new Response(new Uint8Array([0xff, 0xfe, 0x41]), { status: 200 })]) as never,
    });
    expect(g.lookupOk).toBe(false);
    expect(g.wire!.finalOk).toBe(false);
    expect(g.wire!.polls).toHaveLength(6);
    const p0 = g.wire!.polls[0];
    expect(p0.kind).toBe("http_response");
    if (p0.kind === "http_response") {
      expect(verifyWireBody(p0.body).ok).toBe(true); // exact bytes preserved
      expect(p0.jsonParsed).toBe(false); // invalid UTF-8 is not valid JSON
      expect(p0.jsonError).toMatch(/invalid json/);
    }
  });
});

describe("C1-R4-F03 resume re-derives from stored wire bytes", () => {
  it("a record with NO wire evidence is neither complete nor resume-skipped", async () => {
    const rec = makeCompleteRecord(OPENAI_SENTINEL, 1, "pass");
    expect(validateRecordComplete(rec as PersistedRecordShape).complete).toBe(true);
    const stripped = { ...rec };
    delete (stripped as Record<string, unknown>).wire;
    delete (stripped.attempts as Array<Record<string, unknown>>)[0].wire;
    const v = validateRecordComplete(stripped as PersistedRecordShape);
    expect(v.complete).toBe(false);
    expect(v.reasons.join(",")).toMatch(/wire evidence missing/);
  });
  it("runContinuation resume STOPS (never skips) a record whose wire evidence was removed", async () => {
    await freshAll();
    const order = deriveContinuationPlan(buildFrozenOrder()).continuation;
    const p = join(root, "runs", `${runIdFor(2, order[1])}.json`);
    const rec = JSON.parse(readFileSync(p, "utf-8"));
    delete rec.wire;
    delete rec.attempts[0].wire;
    writeFileSync(p, JSON.stringify(rec), { mode: 0o600 });
    dropManifests(root);
    const { gen, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, isResume: true }));
    expect(res.stopped).toMatch(/record_inconsistent_with_plan|incomplete_record_present/);
    expect(history).toHaveLength(0);
  });
  it("resumeReDerive rejects a wrong-model wire body / provider mismatch / unknown cost / tampered preimage", () => {
    const good = makeCompleteRecord(OPENAI_SENTINEL, 1, "pass") as PersistedRecordShape;
    const exp = { resolvedSlug: "openai/gpt-5.6-sol-pro", isHosted: true };
    expect(resumeReDerive(good, exp).ok).toBe(true);

    // wrong model in the response wire body
    const wrongModel = JSON.parse(JSON.stringify(good)) as PersistedRecordShape;
    wrongModel.wire!.response.body = encodeWireBody(JSON.stringify({ id: "g", model: "other/model", provider: "VendorCloud", choices: [{ finish_reason: "stop" }] }));
    expect(resumeReDerive(wrongModel, exp).reasons.join(",")).toMatch(/re-derived response model/);

    // cost-lookup provider disagreeing with the response provider
    const provMismatch = JSON.parse(JSON.stringify(good)) as PersistedRecordShape;
    provMismatch.wire!.costLookup!.polls[0].body = encodeWireBody(JSON.stringify({ data: { id: `gen-${good.runId}`, model: "openai/gpt-5.6-sol-pro", provider_name: "OtherVendor", total_cost: 0.001 } }));
    expect(resumeReDerive(provMismatch, exp).reasons.join(",")).toMatch(/lookup provider/);

    // unknown cost (total_cost null)
    const costUnknown = JSON.parse(JSON.stringify(good)) as PersistedRecordShape;
    costUnknown.wire!.costLookup!.polls[0].body = encodeWireBody(JSON.stringify({ data: { id: `gen-${good.runId}`, model: "openai/gpt-5.6-sol-pro", provider_name: "VendorCloud", total_cost: null } }));
    expect(resumeReDerive(costUnknown, exp).reasons.join(",")).toMatch(/cost unknown|cost !=/);

    // tampered response preimage digest
    const tampered = JSON.parse(JSON.stringify(good)) as PersistedRecordShape;
    tampered.wire!.response.body!.sha256 = `sha256:${"0".repeat(64)}`;
    expect(resumeReDerive(tampered, exp).reasons.join(",")).toMatch(/response wire/);
  });
});

describe("C1-R4-F04 strict runtime-manifest schema / containment / chain", () => {
  const summaryRef = () => {
    const s = writeContentAddressed(root, "continuation-summary", { s: 1 });
    return { s, ref: mref(root, s) };
  };
  it("rejects a manifest missing schema / campaign / stage / required refs", () => {
    const { s, ref } = summaryRef();
    const body = synthManifest({ summary: ref, requiredRefs: [s] });
    delete (body as Record<string, unknown>).manifestSchemaVersion;
    writeContentAddressed(root, "continuation-runtime-manifest", body);
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manifest_schema_version/);
  });
  it("rejects a manifest whose plan digest does not match the fresh plan", () => {
    const { s, ref } = summaryRef();
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: ref, requiredRefs: [s] }));
    const opts = synthChainOpts({ planDigest: `sha256:${"1".repeat(64)}` });
    expect(verifyRuntimeManifestChain(root, opts).reason).toMatch(/manifest_plan_digest_mismatch/);
  });
  it("rejects a manifest ref of ../outside.json (dot-dot) and an absolute path", () => {
    const bad = synthManifest({ summary: { file: "../outside.json", sha256: `sha256:${"0".repeat(64)}` }, requiredRefs: ["../outside.json"] });
    writeContentAddressed(root, "continuation-runtime-manifest", bad);
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manifest_ref_dot_dot/);
    for (const f of readdirSync(root)) if (f.startsWith("continuation-runtime-manifest")) rmSync(join(root, f));
    const abs = synthManifest({ summary: { file: "/etc/passwd", sha256: `sha256:${"0".repeat(64)}` }, requiredRefs: ["/etc/passwd"] });
    writeContentAddressed(root, "continuation-runtime-manifest", abs);
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manifest_ref_absolute/);
  });
  it("rejects a manifest summary ref that is a symlink (symlink ancestor / non-regular)", () => {
    writeFileSync(join(root, "real-summary.json"), "{}", { mode: 0o600 });
    symlinkSync(join(root, "real-summary.json"), join(root, "continuation-summary-" + "a".repeat(64) + ".json"));
    const name = "continuation-summary-" + "a".repeat(64) + ".json";
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: mref(root, name), requiredRefs: [name] }));
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manifest_ref_not_regular_file/);
  });
  it("rejects a duplicate prior in the chain", () => {
    const { s: s1, ref: r1 } = summaryRef();
    const m1 = writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: r1, requiredRefs: [s1] }, 0));
    const s2 = writeContentAddressed(root, "continuation-summary", { s: 2 });
    const dup = synthManifest({ summary: mref(root, s2), priorRuntimeManifests: [mref(root, m1), mref(root, m1)], requiredRefs: [s2, m1] }, 1);
    writeContentAddressed(root, "continuation-runtime-manifest", dup);
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manifest_duplicate_prior|fork_or_gap/);
  });
  it("rejects an orphan catalog artifact not bound to the chain", () => {
    const { s, ref } = summaryRef();
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: ref, requiredRefs: [s] }));
    writeContentAddressed(root, "catalog-preflight", { orphan: true });
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/orphan_artifact/);
  });
  it("rejects an orphan run record when a crash frontier is not permitted", () => {
    const { s, ref } = summaryRef();
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: ref, requiredRefs: [s] }));
    mkdirSync(join(root, "runs"), { recursive: true });
    writeFileSync(join(root, "runs", "run-orphan.json"), "{}", { mode: 0o600 });
    expect(verifyRuntimeManifestChain(root, synthChainOpts({ allowCrashFrontier: false })).reason).toMatch(/orphan_run_artifact/);
  });
  it("reports manual_recovery_required when a summary exists with no manifest", () => {
    writeContentAddressed(root, "continuation-summary", { s: 1 });
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manual_recovery_required/);
  });
});

describe("C1-R4-F05 invocation lock is mandatory and root-confined", () => {
  it("rejects finalizing into a directory that is not the lock's own output root", () => {
    const other = mkdtempSync(join(tmpdir(), "plinius-other-"));
    try {
      withLock(root, (l) => expect(() => finalizeArtifact(other, "x.json", "{}", l)).toThrow(/outside the lock/));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
  it("rejects a filename that traverses (separator / ..)", () => {
    withLock(root, (l) => {
      expect(() => finalizeArtifact(root, "../evil.json", "{}", l)).toThrow(/traversal/);
      expect(() => finalizeArtifact(root, "sub/evil.json", "{}", l)).toThrow(/traversal/);
    });
  });
  it("detects a lock file replaced under the held fd (device/inode change)", () => {
    const l = acquireInvocationLock(root, { stageId: "s", invocationId: "i1", startedAt: TS });
    try {
      unlinkSync(l.path);
      writeFileSync(l.path, JSON.stringify({ invocationId: "i1" }), { mode: 0o600 });
      expect(() => finalizeArtifact(root, `catalog-preflight-${bareSha("{}")}.json`, "{}", l)).toThrow(/replaced|lost/);
    } finally {
      try {
        releaseInvocationLock(l);
      } catch {
        /* lock already gone */
      }
    }
  });
  it("finalizes into the lock's verified runs/ subdir", () => {
    withLock(root, (l) => {
      const r = finalizeArtifact(join(root, "runs"), "run-x.json", "{}", l);
      expect(r.reused).toBe(false);
      expect(existsSync(join(root, "runs", "run-x.json"))).toBe(true);
    });
  });
});

describe("C1-R4-F06 preflight order (local OCI/hash/models → catalog → dispatch)", () => {
  const okLocal = (events: string[]): (() => Promise<LocalPreflightResult>) => async () => {
    events.push("local:oci");
    events.push("local:hash");
    events.push("local:models");
    return { ok: true, reasons: [], observed: [], artifactBody: JSON.stringify({ localRuntimePreflightSchemaVersion: 1, ok: true }) };
  };
  it("runs local → catalog → dispatch in order (mock event trace)", async () => {
    const events: string[] = [];
    const { gen } = recordingGenerate(qualifyingFacts);
    await runContinuation(base({ generate: gen, localPreflight: okLocal(events), onEvent: (e) => events.push(e) }));
    const idx = (s: string) => events.indexOf(s);
    expect(idx("local:oci")).toBeLessThan(idx("local:finalize"));
    expect(idx("local:finalize")).toBeLessThan(idx("catalog:fetch"));
    expect(idx("catalog:fetch")).toBeLessThan(idx("catalog:finalize"));
    expect(idx("catalog:finalize")).toBeLessThan(idx("dispatch:sentinel"));
    expect(existsSync(join(root, "runs"))).toBe(true);
    expect(readdirSync(root).some((f) => /^local-runtime-preflight-[0-9a-f]{64}\.json$/.test(f))).toBe(true);
  });
  it("a local gate failure means zero OpenRouter catalog calls and zero generation", async () => {
    let catalogFetched = false;
    let generated = false;
    const mp = mockPreflight();
    const res = await runContinuation(
      base({
        localPreflight: async () => ({ ok: false, reasons: ["not observable"], observed: [], artifactBody: JSON.stringify({ localRuntimePreflightSchemaVersion: 1, ok: false }) }),
        preflight: () => {
          catalogFetched = true;
          return mp();
        },
        generate: async (c, p, r) => {
          generated = true;
          return qualifyingFacts(c, p, r);
        },
      }),
    );
    expect(res.stopped).toMatch(/^local_preflight_failed/);
    expect(catalogFetched).toBe(false);
    expect(generated).toBe(false);
    expect(readdirSync(root).some((f) => /^catalog-preflight-/.test(f))).toBe(false);
    expect(readdirSync(root).some((f) => /^local-runtime-preflight-[0-9a-f]{64}\.json$/.test(f))).toBe(true);
  });
});

// ===========================================================================
// Stage C1 r6 — Authority adversarial NEGATIVE tests (each attack is BLOCKED).
// Unlike r5 (where an adversarial fixture "passed" because the defect reproduced),
// an r6 case PASSES only when the attack is rejected / fails closed.
// ===========================================================================

describe("C1-R5-F02 wire: request + EVERY cost poll + canonical base64", () => {
  it("verifyWireBody rejects NON-CANONICAL base64 (whitespace / newline / extra padding)", () => {
    const p = encodeWireBody("{}");
    // A newline in the middle decodes leniently but re-encodes differently.
    const withNl: WireBodyPreimage = { ...p, base64: p.base64.slice(0, 2) + "\n" + p.base64.slice(2) };
    expect(verifyWireBody(withNl).reason).toBe("wire_body_base64_noncanonical");
    const padded: WireBodyPreimage = { ...p, base64: p.base64 + "=" };
    expect(verifyWireBody(padded).reason).toBe("wire_body_base64_noncanonical");
  });
  it("reDeriveRequestIdentity re-derives model / max output / sampling from the wire", () => {
    const body = encodeWireBody(JSON.stringify({ model: "M", max_tokens: 123, temperature: 0.7, top_p: 0.9, seed: 5 }));
    const r = reDeriveRequestIdentity(body);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity.model).toBe("M");
      expect(r.identity.maxTokens).toBe(123);
      expect(r.identity.temperature).toBe(0.7);
      expect(r.identity.seedSent).toBe(true);
    }
  });
  const GURL = "https://openrouter.ai/api/v1/generation?id=g1";
  const dataPoll = (i: number): CostLookupPollEvidence => ({
    pollIndex: i, kind: "http_response", url: GURL, method: "GET", receivedAtUtc: TS, httpStatus: 200, headers: {},
    body: encodeWireBody(JSON.stringify({ data: { id: "g1", model: "M", provider_name: "P", total_cost: 0.5 } })),
    jsonParsed: true, jsonError: null, dataPresent: true,
  });
  const transportErrPoll = (i: number): CostLookupPollEvidence => ({ pollIndex: i, kind: "transport_error", url: GURL, method: "GET", receivedAtUtc: TS, error: "fetch error: ECONNRESET" });
  const non200Poll = (i: number): CostLookupPollEvidence => ({
    pollIndex: i, kind: "http_response", url: GURL, method: "GET", receivedAtUtc: TS, httpStatus: 502, headers: {},
    body: encodeWireBody(JSON.stringify({ error: "bad gateway" })), jsonParsed: true, jsonError: null, dataPresent: false,
  });
  it("verifyCostLookupChain accepts a valid single-poll chain", () => {
    const r = verifyCostLookupChain({ polls: [dataPoll(0)], finalOk: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.finalCost?.actualCostUsd).toBe(0.5);
  });
  it("verifyCostLookupChain ACCEPTS a production non-200-JSON → success chain (F02)", () => {
    expect(verifyCostLookupChain({ polls: [non200Poll(0), dataPoll(1)], finalOk: true }).ok).toBe(true);
  });
  it("verifyCostLookupChain ACCEPTS a production fetch-error → success chain (F02)", () => {
    expect(verifyCostLookupChain({ polls: [transportErrPoll(0), dataPoll(1)], finalOk: true }).ok).toBe(true);
  });
  it("verifyCostLookupChain rejects a poll index gap", () => {
    const r = verifyCostLookupChain({ polls: [dataPoll(1)], finalOk: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("cost_poll_0_index");
  });
  it("verifyCostLookupChain rejects a FORGED jsonParsed (body is not JSON)", () => {
    const forged: CostLookupPollEvidence = { pollIndex: 0, kind: "http_response", url: GURL, method: "GET", receivedAtUtc: TS, httpStatus: 500, headers: {}, body: encodeWireBody("not json"), jsonParsed: true, jsonError: null, dataPresent: false };
    const r = verifyCostLookupChain({ polls: [forged, dataPoll(1)], finalOk: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("cost_poll_0_jsonParsed_inconsistent");
  });
  it("verifyCostLookupChain rejects a FORGED dataPresent (no data object)", () => {
    const forged: CostLookupPollEvidence = { pollIndex: 0, kind: "http_response", url: GURL, method: "GET", receivedAtUtc: TS, httpStatus: 200, headers: {}, body: encodeWireBody(JSON.stringify({ nope: 1 })), jsonParsed: true, jsonError: null, dataPresent: true };
    const r = verifyCostLookupChain({ polls: [forged], finalOk: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("cost_poll_0_dataPresent_inconsistent");
  });
  it("verifyCostLookupChain rejects a data-bearing poll BEFORE the final one", () => {
    const r = verifyCostLookupChain({ polls: [dataPoll(0), dataPoll(1)], finalOk: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("cost_poll_0_data_before_final");
  });
  it("verifyCostLookupChain rejects finalOk inconsistent with the final poll", () => {
    const r = verifyCostLookupChain({ polls: [dataPoll(0)], finalOk: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("cost_lookup_finalOk_inconsistent");
  });

  // A wire-consistent hosted record: output / status / finishReasonMapping are the
  // SHARED derivation of its own response wire, so a genuine record passes and any
  // single-field forgery is caught (C1-R6-F02).
  const RAW = { id: "g1", model: "M", provider: "P", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "The final answer." } }], usage: { total_tokens: 30 } };
  const oc = deriveResponseOutcome(RAW);
  const hostedRec = (over: Record<string, unknown> = {}): PersistedRecordShape => ({
    status: oc.status,
    error: null,
    backend: "openrouter",
    responseModelId: "M",
    responseGenerationId: "g1",
    responseProvider: "P",
    cost: { costModel: "METERED", actualCostUsd: 0.5 },
    metrics: { usage: { total_tokens: 30 } },
    output: oc.output,
    finishReasonMapping: oc.finishReasonMapping,
    wire: {
      request: { url: "https://openrouter.ai/api/v1/chat/completions", method: "POST", body: encodeWireBody(JSON.stringify({ model: "M", messages: WIRE_MESSAGES, max_tokens: 100, temperature: null, top_p: null, seed: null })) },
      response: { httpStatus: 200, receivedAtUtc: TS, headers: {}, body: encodeWireBody(JSON.stringify(RAW)) },
      costLookup: { polls: [dataPoll(0)], finalOk: true },
    },
    ...over,
  });
  const exp = { resolvedSlug: "M", isHosted: true, maxTokens: 100, sampling: {}, request: { url: "https://openrouter.ai/api/v1/chat/completions", messages: WIRE_MESSAGES } };
  it("resumeReDerive ACCEPTS a fully-consistent hosted record (round-trip)", () => {
    const r = resumeReDerive(hostedRec(), exp);
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it("resumeReDerive BLOCKS a record with a NULL request body", () => {
    const w = hostedRec().wire!;
    const rec = hostedRec({ wire: { ...w, request: { url: w.request.url, method: "POST", body: null } } });
    expect(resumeReDerive(rec, exp).reasons.join(",")).toMatch(/request wire wire_body_missing/);
  });
  it("resumeReDerive BLOCKS a wrong request URL (!= plan endpoint)", () => {
    const w = hostedRec().wire!;
    const rec = hostedRec({ wire: { ...w, request: { url: "https://evil.example/v1/chat/completions", method: "POST", body: w.request.body } } });
    expect(resumeReDerive(rec, exp).reasons.join(",")).toMatch(/request URL .* != plan endpoint/);
  });
  it("resumeReDerive BLOCKS a non-POST request method", () => {
    const w = hostedRec().wire!;
    const rec = hostedRec({ wire: { ...w, request: { url: w.request.url, method: "GET", body: w.request.body } } });
    expect(resumeReDerive(rec, exp).reasons.join(",")).toMatch(/request method GET != POST/);
  });
  it("resumeReDerive BLOCKS request MESSAGES drift", () => {
    const w = hostedRec().wire!;
    const rec = hostedRec({ wire: { ...w, request: { url: w.request.url, method: "POST", body: encodeWireBody(JSON.stringify({ model: "M", messages: [{ role: "user", content: "DIFFERENT" }], max_tokens: 100 })) } } });
    expect(resumeReDerive(rec, exp).reasons.join(",")).toMatch(/request messages != plan messages/);
  });
  it("resumeReDerive BLOCKS an UNEXPECTED request field (allowed-field-set)", () => {
    const w = hostedRec().wire!;
    const rec = hostedRec({ wire: { ...w, request: { url: w.request.url, method: "POST", body: encodeWireBody(JSON.stringify({ model: "M", messages: WIRE_MESSAGES, max_tokens: 100, tools: [] })) } } });
    expect(resumeReDerive(rec, exp).reasons.join(",")).toMatch(/unexpected field tools/);
  });
  it("resumeReDerive BLOCKS request drift (wire max_tokens != plan)", () => {
    const w = hostedRec().wire!;
    const rec = hostedRec({ wire: { ...w, request: { url: w.request.url, method: "POST", body: encodeWireBody(JSON.stringify({ model: "M", messages: WIRE_MESSAGES, max_tokens: 999 })) } } });
    expect(resumeReDerive(rec, exp).reasons.join(",")).toMatch(/re-derived request maxTokens 999 != 100/);
  });
  it("resumeReDerive BLOCKS a forged headline whose WIRE model is wrong", () => {
    const wrongBody = encodeWireBody(JSON.stringify({ ...RAW, model: "WRONG" }));
    const w = hostedRec().wire!;
    const rec = hostedRec({ wire: { ...w, response: { ...w.response, body: wrongBody } } });
    expect(resumeReDerive(rec, exp).reasons.join(",")).toMatch(/re-derived response model WRONG != expected M/);
  });
  it("resumeReDerive BLOCKS a persisted status that CONTRADICTS the wire (content_filter vs pass)", () => {
    // Wire says content_filter; the persisted status/output/finishReasonMapping claim a
    // clean stop — the shared re-derivation catches the contradiction (C1-R6-F02).
    const cfRaw = { ...RAW, choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: "" } }] };
    const w = hostedRec().wire!;
    const rec = hostedRec({ wire: { ...w, response: { ...w.response, body: encodeWireBody(JSON.stringify(cfRaw)) } } });
    const reasons = resumeReDerive(rec, exp).reasons.join(",");
    expect(reasons).toMatch(/persisted (status|output|finishReasonMapping) != re-derived from wire/);
  });
  it("resumeReDerive BLOCKS a preceding cost poll with a FORGED jsonParsed", () => {
    const forged: CostLookupPollEvidence = { pollIndex: 0, kind: "http_response", url: GURL, method: "GET", receivedAtUtc: TS, httpStatus: 500, headers: {}, body: encodeWireBody("not json"), jsonParsed: true, jsonError: null, dataPresent: false };
    const w = hostedRec().wire!;
    const rec = hostedRec({ wire: { ...w, costLookup: { polls: [forged, dataPoll(1)], finalOk: true } } });
    expect(resumeReDerive(rec, exp).reasons.join(",")).toMatch(/cost_poll_0_jsonParsed_inconsistent/);
  });
});

describe("C1-R5-F03 manifest: requiredRefs exact-set + bytes + binding", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "r6-f03-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("BLOCKS an EMPTY requiredRefs (r5 accepted requiredRefs: [])", () => {
    const s = writeContentAddressed(root, "continuation-summary", { s: 1 });
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: mref(root, s), requiredRefs: [] }));
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manifest_requiredRefs_mismatch/);
  });
  it("BLOCKS an EXTRA requiredRefs entry not bound in the manifest", () => {
    const s = writeContentAddressed(root, "continuation-summary", { s: 1 });
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: mref(root, s), requiredRefs: [s, "phantom.json"] }));
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manifest_requiredRefs_mismatch/);
  });
  it("BLOCKS a FALSE bytes on a manifest ref (r5 accepted bytes: 999999)", () => {
    const s = writeContentAddressed(root, "continuation-summary", { s: 1 });
    const ref = { file: s, sha256: diskSha(root, s), bytes: 999999 };
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: ref, requiredRefs: [s] }));
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manifest_ref_bytes_mismatch/);
  });
  it("BLOCKS a manifest with NO summary (a clean flow always writes one)", () => {
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ requiredRefs: [] }));
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manifest_missing_summary/);
  });
  it("BLOCKS a referenced summary body bound to the WRONG campaign", () => {
    const s = writeContentAddressed(root, "continuation-summary", { campaignId: "WRONG-CAMPAIGN", stageId: CONTINUATION_STAGE_ID });
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: mref(root, s), requiredRefs: [s] }));
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manifest_summary_campaign/);
  });
});

describe("C1-R5-F04 local-runtime preflight is a first-class content-addressed artifact", () => {
  it("CONTENT_ADDRESSED_KINDS includes local-runtime-preflight (single registry)", () => {
    expect(CONTENT_ADDRESSED_KINDS).toContain("local-runtime-preflight");
  });
  it("a fresh run's local-runtime preflight is ACCEPTED on resume — 0 re-dispatch (r5 tripped the allowlist)", async () => {
    const localBody = JSON.stringify({ localRuntimePreflightSchemaVersion: 1, evaluatedAtUtc: TS, ok: true, observed: [], resolutions: [], reasons: [] });
    const lp = async () => ({ ok: true, reasons: [], observed: [], artifactBody: localBody });
    const { gen: g1 } = recordingGenerate(qualifyingFacts);
    const fresh = await runContinuation(base({ generate: g1, localPreflight: lp }));
    expect(fresh.stopped).toBeNull();
    // The production local-runtime preflight artifact exists at the top level.
    expect(readdirSync(root).some((f) => /^local-runtime-preflight-[0-9a-f]{64}\.json$/.test(f))).toBe(true);
    // Resume: the allowlist + manifest chain ACCEPT the local artifact; nothing re-dispatches.
    const { gen: g2, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: g2, localPreflight: lp, isResume: true }));
    expect(res.stopped).toBeNull();
    expect(history).toHaveLength(0);
    expect(res.summary.resumeSkippedThisInvocation).toBe(23);
  });
});

describe("C1-R5-F01/F05 observer pure helpers (engine argv parse, HF decode, path normalize)", () => {
  it("parseEngineArgs folds aliases and rejects duplicate / conflicting / missing-value / positional", () => {
    const ok = parseEngineArgs(["serve", "--model", "a/b", "-tp", "2"]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.parsed.flags["--tensor-parallel-size"]).toBe("2");
    expect((parseEngineArgs(["serve", "--dtype", "x", "--dtype", "x"]) as { reason: string }).reason).toBe("engine_args_duplicate_flag:--dtype");
    expect((parseEngineArgs(["serve", "--tensor-parallel-size", "2", "-tp", "3"]) as { reason: string }).reason).toBe("engine_args_conflicting_flag:--tensor-parallel-size");
    expect((parseEngineArgs(["serve", "--model"]) as { reason: string }).reason).toBe("engine_args_missing_value:--model");
    expect((parseEngineArgs(["serve", "stray"]) as { reason: string }).reason).toBe("engine_args_unexpected_positional:stray");
    expect((parseEngineArgs(["--model", "x"]) as { reason: string }).reason).toBe("engine_args_no_subcommand");
  });
  it("decodeHfSnapshot decodes org/name + revision from the HF cache layout", () => {
    expect(decodeHfSnapshot("/c/hub/models--Qwen--Qwen3.8-27B/snapshots/" + "a".repeat(40))).toEqual({ repo: "Qwen/Qwen3.8-27B", revision: "a".repeat(40) });
    expect(decodeHfSnapshot("/c/hub/models--openai--gpt-oss-20b/snapshots/abc")).toEqual({ repo: "openai/gpt-oss-20b", revision: "abc" });
    expect(decodeHfSnapshot("/not/hf/layout")).toBeNull();
  });
  it("normalizeWeightRel rejects absolute / dot-dot / backslash / empty-segment paths", () => {
    expect(normalizeWeightRel("model.safetensors").ok).toBe(true);
    expect((normalizeWeightRel("/etc/passwd") as { reason: string }).reason).toBe("weight_path_absolute");
    expect((normalizeWeightRel("../escape") as { reason: string }).reason).toBe("weight_path_dot_segment");
    expect((normalizeWeightRel("a\\b") as { reason: string }).reason).toBe("weight_path_backslash");
    expect((normalizeWeightRel("a//b") as { reason: string }).reason).toBe("weight_path_empty_segment");
  });
});

// ===========================================================================
// Stage C1 r7 — Authority adversarial NEGATIVE tests for C1-R6-F01..F04.
// Each attack PASSES only when it is BLOCKED / fails closed; plus round-trips.
// ===========================================================================

describe("C1-R6-F03 manifest strictness (schema v3, prior bytes, strict crash-frontier)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "r7-f03-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("uses schema version 3", () => {
    expect(RUNTIME_MANIFEST_SCHEMA_VERSION).toBe(3);
  });
  it("BLOCKS a manifest that OMITS its records array", () => {
    const s = writeContentAddressed(root, "continuation-summary", { s: 1 });
    const body = synthManifest({ summary: mref(root, s), requiredRefs: [s] });
    delete (body as Record<string, unknown>).records;
    writeContentAddressed(root, "continuation-runtime-manifest", body);
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manifest_missing_records/);
  });
  it("BLOCKS a manifest that OMITS its intents array", () => {
    const s = writeContentAddressed(root, "continuation-summary", { s: 1 });
    const body = synthManifest({ summary: mref(root, s), requiredRefs: [s] });
    delete (body as Record<string, unknown>).intents;
    writeContentAddressed(root, "continuation-runtime-manifest", body);
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manifest_missing_intents/);
  });
  it("BLOCKS a FALSE prior-manifest bytes value", () => {
    const s1 = writeContentAddressed(root, "continuation-summary", { s: 1 });
    const m1 = writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: mref(root, s1), requiredRefs: [s1] }, 0));
    const s2 = writeContentAddressed(root, "continuation-summary", { s: 2 });
    const falsePrior = { file: m1, sha256: diskSha(root, m1), bytes: 999999 };
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: mref(root, s2), priorRuntimeManifests: [falsePrior], requiredRefs: [s2, m1] }, 1));
    expect(verifyRuntimeManifestChain(root, synthChainOpts()).reason).toMatch(/manifest_prior_bytes_mismatch/);
  });
  it("BLOCKS an UNBOUND arbitrary run body (crash frontier, {} record) → manual_recovery_required", () => {
    const s = writeContentAddressed(root, "continuation-summary", { s: 1 });
    writeContentAddressed(root, "continuation-runtime-manifest", synthManifest({ summary: mref(root, s), requiredRefs: [s] }));
    // A run record for a valid plan id, but an arbitrary {} body no manifest binds.
    const order = deriveContinuationPlan(buildFrozenOrder()).continuation;
    const id = runIdFor(1, order[0]);
    mkdirSync(join(root, "runs"), { recursive: true });
    writeFileSync(join(root, "runs", `${id}.json`), "{}", { mode: 0o600 });
    const opts = realChainOpts({ allowCrashFrontier: true, planDigest: computePlanDigest(CAMPAIGN_ID, CONTINUATION_STAGE_ID, []) });
    // Use synth plan digest so the summary/manifest bind; the frontier record has no summary link.
    const r = verifyRuntimeManifestChain(root, synthChainOpts({ validRunIds: [id], allowCrashFrontier: true }));
    expect(r.reason).toMatch(/manual_recovery_required/);
  });
});

describe("C1-R6-F03 ROUND-TRIP: a production manifest verifies against its own output", () => {
  it("fresh production run → runtime manifest → chain verifier PASSES (uses the module output root)", async () => {
    const localBody = JSON.stringify({ localRuntimePreflightSchemaVersion: 1, evaluatedAtUtc: TS, ok: true, observed: [], resolutions: [], reasons: [] });
    const lp = async () => ({ ok: true, reasons: [], observed: [], artifactBody: localBody });
    const { gen } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: gen, localPreflight: lp }));
    expect(res.stopped).toBeNull();
    // `root` here is the module-level output root base() dispatched into.
    const chain = verifyRuntimeManifestChain(root, realChainOpts());
    expect(chain.ok).toBe(true);
  });
});

describe("C1-R6-F04 typed local artifact binding (kind-checked refs)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "r7-f04-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("BLOCKS a catalog artifact presented as a local-runtime ref (swap attack)", () => {
    withLock(root, (l) => {
      const body = '{"catalog":true}';
      const r = finalizeArtifact(root, `catalog-preflight-${bareSha(body)}.json`, body, l);
      // As a catalog ref it verifies; as a local-runtime ref it is rejected on the kind.
      expect(verifyReferencedArtifact(root, { file: r.file, sha256: r.sha256 }, "catalog").ok).toBe(true);
      expect(verifyReferencedArtifact(root, { file: r.file, sha256: r.sha256 }, "local-runtime").reason).toMatch(/ref_kind_mismatch:expected_local-runtime/);
    });
  });
  it("BLOCKS a local-runtime artifact presented as a catalog ref (reverse swap)", () => {
    withLock(root, (l) => {
      const body = '{"localRuntimePreflightSchemaVersion":1,"ok":true}';
      const r = finalizeArtifact(root, `local-runtime-preflight-${bareSha(body)}.json`, body, l);
      expect(verifyReferencedArtifact(root, { file: r.file, sha256: r.sha256 }, "local-runtime").ok).toBe(true);
      expect(verifyReferencedArtifact(root, { file: r.file, sha256: r.sha256 }, "catalog").reason).toMatch(/ref_kind_mismatch:expected_catalog/);
    });
  });
  it("BLOCKS a FALSE local artifact bytes value", () => {
    withLock(root, (l) => {
      const body = '{"localRuntimePreflightSchemaVersion":1,"ok":true}';
      const r = finalizeArtifact(root, `local-runtime-preflight-${bareSha(body)}.json`, body, l);
      expect(verifyReferencedArtifact(root, { file: r.file, sha256: r.sha256, bytes: 999999 }, "local-runtime").reason).toMatch(/local-runtime_ref_bytes_mismatch/);
    });
  });
});

describe("C1-R6-F04 driver: a changed local runtime fails closed on resume (0 re-dispatch)", () => {
  // A plan that dispatches every cell as a LOCAL (vLLM) target, so its records carry a
  // localRuntimeArtifactRef the resume binding check exercises.
  const vllmPlanCell = async (cell: Cell, oi: number): Promise<CellPlan> => {
    const p = planCellSync(cell, oi);
    return { ...p, backend: "vllm", endpoint: "http://localhost:8001/v1", header: { ...p.header, backend: "vllm" } };
  };
  const lp = (marker: string) => async () => ({ ok: true, reasons: [], observed: [], artifactBody: JSON.stringify({ localRuntimePreflightSchemaVersion: 1, evaluatedAtUtc: TS, ok: true, observed: [], resolutions: [], reasons: [], marker }) });
  it("stops with local_runtime_binding_changed when the fresh local observation differs", async () => {
    const { gen: g1 } = recordingGenerate(qualifyingFacts);
    const fresh = await runContinuation(base({ generate: g1, planCell: vllmPlanCell, localPreflight: lp("A") }));
    expect(fresh.stopped).toBeNull();
    const { gen: g2, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: g2, planCell: vllmPlanCell, localPreflight: lp("B"), isResume: true }));
    expect(res.stopped).toBe("local_runtime_binding_changed");
    expect(history).toHaveLength(0);
  });
  it("an UNCHANGED local runtime resumes cleanly (0 re-dispatch)", async () => {
    const { gen: g1 } = recordingGenerate(qualifyingFacts);
    await runContinuation(base({ generate: g1, planCell: vllmPlanCell, localPreflight: lp("A") }));
    const { gen: g2, history } = recordingGenerate(qualifyingFacts);
    const res = await runContinuation(base({ generate: g2, planCell: vllmPlanCell, localPreflight: lp("A"), isResume: true }));
    expect(res.stopped).toBeNull();
    expect(history).toHaveLength(0);
  });
});
