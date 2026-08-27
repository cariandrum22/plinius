/**
 * Partitioned hosted paid passes — production-path tests (Paid Pass r4).
 *
 * Drives the real production code: the pure paid-campaign module (routing, catalog
 * verification incl. provider display, budget, actual-cost, full re-derivation,
 * AUTHENTICATED authority source manifest, preimage integrity, raw-observation
 * re-derivation, and strict binding-manifest verification), the dispatch adapter,
 * the credential-ordering bootstrap with required gates, and the paid orchestrator
 * with hardened-journal persistence, a durable send/receive wire sink, raw
 * observations saved-then-READ-BACK from disk, terminal-exception evidence, and a
 * strict binding manifest verified against disk. No network, no credential.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, readdir, stat } from "fs/promises";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join } from "path";

import {
  HOSTED_PAID_PASS,
  CANDIDATE_PAID_PASS,
  HOSTED_PAID_TARGETS,
  CANDIDATE_PAID_TARGETS,
  buildHostedPaidCells,
  buildCandidatePaidCells,
  buildProviderRouting,
  serializeProviderRouting,
  parseProviderRoutingWire,
  providerRoutingEqual,
  verifyPaidRequestWire,
  verifyPaidTargetAgainstCatalog,
  verifyPaidDispatch,
  validatePaidActualCost,
  verifyAuthoritySourceManifest,
  verifyWirePreimageIntegrity,
  reDerivePaidFromRawObservation,
  verifyPaidManifest,
  tokenUpperBound,
  estimateCellCeilingUsd,
  checkBudgetBeforeDispatch,
  OIDC_BENCHMARK_ID,
} from "../src/qualification/paid-campaign.js";
import type {
  CatalogModelInfo,
  PaidTarget,
  ProviderRouting,
  ObservedDispatch,
  ExpectedDispatch,
  ObservedSource,
  PaidRawObservation,
  PaidBindingManifest,
  PaidManifestRef,
} from "../src/qualification/paid-campaign.js";

import { dispatchViaBackend, preparePaidBootstrap, runPaidPass, paidPlanCell, verifyPaidCatalog, resolveDriverMode } from "../qualification-driver.mjs";
import type { PaidCellPlan } from "../qualification-driver.mjs";
import type { FetchFn } from "../src/backends/openai-compatible.js";

const OR_BASE = "https://openrouter.ai/api/v1";
const CHAT_URL = `${OR_BASE}/chat/completions`;
const DISPLAY = "TestProvider";

// --- helpers -----------------------------------------------------------------

function goodModel(target: PaidTarget): CatalogModelInfo {
  return {
    id: target.slug,
    endpoints: [
      {
        tag: target.providerRoute,
        providerName: DISPLAY,
        pricing: {
          prompt: (target.priceCeiling.inputPerMTokens / 1_000_000).toString(),
          completion: (target.priceCeiling.outputPerMTokens / 1_000_000).toString(),
        },
        contextLength: 200_000,
        maxCompletionTokens: 64_000,
        supportedParameters: ["max_tokens", "temperature", "top_p", "seed"],
      },
    ],
  };
}
const goodCatalog = (targets: PaidTarget[]) => new Map(targets.map((t) => [t.slug, goodModel(t)]));
const displayMap = (targets: PaidTarget[]) => Object.fromEntries(targets.map((t) => [t.slug, DISPLAY]));
const promptMap = (cells: { benchmark: string }[]) => new Map(cells.map((c) => [c.benchmark, 1000]));

function wirePreimage(obj: unknown) {
  const bytes = Buffer.from(JSON.stringify(obj), "utf-8");
  return { encoding: "base64" as const, base64: bytes.toString("base64"), sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

function mockFetch(model: string): { fn: FetchFn; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fn: FetchFn = async (url, init) => {
    let body: unknown = null;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    } catch {
      body = init?.body ?? null;
    }
    calls.push({ url: String(url), body });
    const payload = { id: "gen-mock-1", model, provider: DISPLAY, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "FINAL ANSWER" } }], usage: {} };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

/** GenerateFacts with FULL wire preimages (request/response/cost-lookup), from which
 * the orchestrator re-derives every field. Convenience fields are also set but the
 * validation reads only the wire. */
function factsFor(
  plan: PaidCellPlan,
  opts: { ok?: boolean; costUsd?: number | null; routing?: ProviderRouting | null; model?: string; url?: string; display?: string } = {},
): any {
  const ok = opts.ok ?? true;
  const routing = opts.routing === undefined ? buildProviderRouting(plan.target) : opts.routing;
  const model = opts.model ?? plan.target.slug;
  const display = opts.display ?? DISPLAY;
  const cost = opts.costUsd === undefined ? 0.01 : opts.costUsd;
  const s = plan.target.sampling;
  const sentBody: Record<string, unknown> = {
    model,
    messages: plan.messages,
    max_tokens: plan.maxTokens,
    ...(s.temperature !== null ? { temperature: s.temperature } : {}),
    ...(s.topP !== null ? { top_p: s.topP } : {}),
    ...(s.seed !== null ? { seed: s.seed } : {}),
    ...(routing ? { provider: serializeProviderRouting(routing) } : {}),
  };
  const responseBody = { id: "gen-x", model, provider: display, choices: [{ finish_reason: ok ? "stop" : "content_filter", message: { role: "assistant", content: ok ? "FINAL ANSWER" : "" } }], usage: {} };
  const lookupBody = { data: { id: "gen-x", model, provider_name: display, total_cost: cost } };
  const reqPre = wirePreimage(sentBody);
  const resPre = wirePreimage(responseBody);
  const lookupPre = wirePreimage(lookupBody);
  const url = opts.url ?? CHAT_URL;
  return {
    raw: responseBody,
    text: ok ? "FINAL ANSWER" : "",
    rawFinish: ok ? "stop" : "content_filter",
    transportError: null,
    usage: {},
    latencyMs: 5,
    cost: { costModel: "METERED", actualCostUsd: cost, lookup: {} },
    routing: { provider: display },
    requestSent: { model, maxTokens: plan.maxTokens, temperature: s.temperature, topP: s.topP, seed: s.seed, providerRouting: routing ?? undefined },
    requestWireSha256: reqPre.sha256,
    responseWireSha256: resPre.sha256,
    costLookupWireSha256: lookupPre.sha256,
    requestUrl: url,
    requestMethod: "POST",
    responseModelId: model,
    responseGenerationId: "gen-x",
    responseProvider: display,
    generationLookupModelId: model,
    generationLookupGenerationId: "gen-x",
    generationLookupProvider: display,
    wire: {
      request: { url, method: "POST", body: reqPre },
      response: { httpStatus: 200, receivedAtUtc: "t", headers: {}, body: resPre },
      costLookup: { polls: [{ pollIndex: 0, kind: "http_response", url: "u", method: "GET", receivedAtUtc: "t", httpStatus: 200, headers: {}, body: lookupPre, jsonParsed: true, jsonError: null, dataPresent: true }], finalOk: true },
    },
  };
}

type OnWire = (ev: { stage: "request" | "response"; url: string | null; method: string | null; httpStatus?: number | null; preimage: any }) => void;

/** Wrap a facts producer into a `generate` that forwards the request/response wire
 * preimages to the durable sink BEFORE returning — exactly as the real dispatch does. */
function withWire(factsFn: (cell: any, plan: any) => any) {
  return async (cell: any, plan: any, _req: any, onWire: OnWire) => {
    const facts = factsFn(cell, plan);
    onWire({ stage: "request", url: facts.wire.request.url, method: "POST", preimage: facts.wire.request.body });
    onWire({ stage: "response", url: facts.wire.request.url, method: "POST", httpStatus: 200, preimage: facts.wire.response.body });
    return facts;
  };
}

/** A generate that emits both wire fragments and THEN throws — a billed dispatch
 * whose cost lookup dies. The request/response wire must survive the exception. */
function throwAfterWire(factsFn: (cell: any, plan: any) => any, message: string) {
  return async (cell: any, plan: any, _req: any, onWire: OnWire) => {
    const facts = factsFn(cell, plan);
    onWire({ stage: "request", url: facts.wire.request.url, method: "POST", preimage: facts.wire.request.body });
    onWire({ stage: "response", url: facts.wire.request.url, method: "POST", httpStatus: 200, preimage: facts.wire.response.body });
    throw new Error(message);
  };
}

function bootDeps(mode: any, values: Record<string, string | undefined>, over: Record<string, any> = {}) {
  const reads: string[] = [];
  const readEnv = (name: string) => {
    reads.push(name);
    return values[name];
  };
  const deps = {
    mode,
    readEnv,
    verifySource: () => ({ ok: true, reasons: [] }),
    verifyParentEvidence: () => ({ ok: true, details: [] }),
    verifyCampaignBenchmarks: async () => ({ ok: true, reasons: [] }),
    fetchCatalogAndVerify: async () => ({ ok: true, reasons: [], catalogArtifactBody: "{}", perTarget: [], providerDisplay: {} }),
    assertOutputRootEmpty: () => {},
    acquireLock: () => null,
    finalizeCatalogArtifact: () => null,
    ...over,
  };
  return { deps, reads };
}

let outRoot: string;
beforeAll(async () => {
  outRoot = await mkdtemp(join(tmpdir(), "plinius-paid-"));
});
afterAll(async () => {
  await rm(outRoot, { recursive: true, force: true });
});
const freshRoot = (name: string) => join(outRoot, name);

const runOpts = (pass: any, cells: any[], root: string, gen: any) => ({
  pass,
  cells,
  outputRoot: root,
  providerDisplay: displayMap(pass.targets),
  planCell: (cell: any, i: number) => paidPlanCell(pass, cell, i),
  generate: gen,
});

// --- 1. fixed definitions ----------------------------------------------------

describe("paid pass fixed definitions", () => {
  it("Hosted Pass A: routes/ceilings/15 cells", () => {
    expect(HOSTED_PAID_PASS.stageId).toBe("plinius-qualification-2026-08-22-diagnostic-hosted-paid-r1");
    expect(HOSTED_PAID_PASS.budget).toEqual({ totalCapUsd: 5.0, perRunCapUsd: 1.0 });
    expect(HOSTED_PAID_TARGETS.map((t) => [t.slug, t.providerRoute])).toEqual([
      ["openai/gpt-5.6-sol-pro", "openai"],
      ["anthropic/claude-opus-5", "claude-on-aws"],
      ["google/gemini-3.7-flash", "google-vertex/global"],
      ["deepseek/deepseek-v4-flash-0731", "deepinfra/fp8"],
    ]);
    const cells = buildHostedPaidCells();
    expect(cells.length).toBe(15);
    expect(cells.filter((c) => c.sentinel).length).toBe(1);
    expect(cells.some((c) => c.target === "anthropic/claude-opus-5" && c.benchmark === OIDC_BENCHMARK_ID)).toBe(false);
  });

  it("Candidate Pass: new campaign, provider SLUG routes, 16 cells, per-model sentinels", () => {
    expect(CANDIDATE_PAID_PASS.campaignId).toBe("plinius-qualification-2026-08-26-candidate-r1");
    expect(CANDIDATE_PAID_PASS.budget).toEqual({ totalCapUsd: 6.0, perRunCapUsd: 0.75 });
    expect(CANDIDATE_PAID_TARGETS.map((t) => [t.slug, t.providerRoute])).toEqual([
      ["z-ai/glm-5.3", "z-ai/fp8"],
      ["moonshotai/kimi-k3", "moonshotai/mxfp4"],
      ["qwen/qwen3.8-max", "alibaba"],
      ["anthropic/claude-sonnet-5", "anthropic"],
    ]);
    const cells = buildCandidatePaidCells();
    expect(cells.length).toBe(16);
    for (const t of CANDIDATE_PAID_TARGETS) expect(cells.filter((c) => c.group === t.slug && c.sentinel).length).toBe(1);
  });

  it("resolveDriverMode accepts both paid modes and rejects unknown", () => {
    expect(resolveDriverMode("diagnostic-hosted-paid-r1")).toBe("diagnostic-hosted-paid-r1");
    expect(resolveDriverMode("diagnostic-candidate-paid-r1")).toBe("diagnostic-candidate-paid-r1");
    expect(() => resolveDriverMode(undefined)).toThrow();
  });
});

// --- 2. routing + wire tamper ------------------------------------------------

describe("provider routing validation and wire tamper", () => {
  const target = HOSTED_PAID_TARGETS[0];
  const good = serializeProviderRouting(buildProviderRouting(target));
  it("blocks missing/multiple/empty routes, fallback, param-req, unknown fields", () => {
    expect(parseProviderRoutingWire(undefined).ok).toBe(false);
    expect(parseProviderRoutingWire({ ...good, order: ["openai", "azure"] }).ok).toBe(false);
    expect(parseProviderRoutingWire({ ...good, allow_fallbacks: true }).ok).toBe(false);
    expect(parseProviderRoutingWire({ ...good, require_parameters: false }).ok).toBe(false);
    expect(parseProviderRoutingWire({ ...good, transforms: ["x"] }).ok).toBe(false);
    expect(parseProviderRoutingWire({ ...good, max_price: { prompt: 2, completion: 10, image: 1 } }).ok).toBe(false);
  });
  it("verifyPaidRequestWire blocks model/route/fallback/max_price/dropped-provider tampering", () => {
    const routing = buildProviderRouting(target);
    const w = { model: target.slug, max_tokens: 1024, provider: good };
    expect(verifyPaidRequestWire(w, { model: target.slug, routing }).ok).toBe(true);
    expect(verifyPaidRequestWire({ ...w, model: "x" }, { model: target.slug, routing }).ok).toBe(false);
    expect(verifyPaidRequestWire({ ...w, provider: { ...good, order: ["azure"] } }, { model: target.slug, routing }).ok).toBe(false);
    expect(verifyPaidRequestWire({ model: target.slug, max_tokens: 1024 }, { model: target.slug, routing }).ok).toBe(false);
  });
});

// --- 3. full dispatch re-derivation w/ provider provenance -------------------

describe("full request/response re-derivation and provider provenance", () => {
  const target = HOSTED_PAID_TARGETS[3];
  const routing = buildProviderRouting(target);
  const messages = [{ role: "user", content: "hi" }];
  const expected: ExpectedDispatch = { requestUrl: CHAT_URL, model: target.slug, routing, maxTokens: 24576, temperature: 0, topP: 1, seed: 1, messages, providerDisplay: "DeepInfra" };
  const base: ObservedDispatch = {
    requestUrl: CHAT_URL, requestMethod: "POST", model: target.slug, routing, maxTokens: 24576, temperature: 0, topP: 1, seed: 1, messages,
    responseModelId: target.slug, responseProvider: "DeepInfra", responseGenerationId: "g1", lookupModelId: target.slug, lookupGenerationId: "g1", lookupProvider: "DeepInfra",
  };
  it("passes a fully-consistent dispatch", () => {
    expect(verifyPaidDispatch(base, expected).ok).toBe(true);
  });
  it("blocks a WRONG provider on the response even when non-empty (the r2 defect)", () => {
    expect(verifyPaidDispatch({ ...base, responseProvider: "Azure" }, expected).reasons.some((r) => r.startsWith("response_provider_mismatch"))).toBe(true);
  });
  it("blocks a MISSING lookup provider / model / generation id (never passes on absence)", () => {
    expect(verifyPaidDispatch({ ...base, lookupProvider: null }, expected).reasons).toContain("lookup_provider_missing");
    expect(verifyPaidDispatch({ ...base, lookupModelId: null }, expected).reasons).toContain("lookup_model_missing");
    expect(verifyPaidDispatch({ ...base, lookupGenerationId: null }, expected).reasons).toContain("lookup_generation_id_missing");
  });
  it("blocks a mismatched lookup provider, a missing max_tokens, and url/method/model/messages drift", () => {
    expect(verifyPaidDispatch({ ...base, lookupProvider: "Azure" }, expected).reasons.some((r) => r.startsWith("lookup_provider_mismatch"))).toBe(true);
    expect(verifyPaidDispatch({ ...base, maxTokens: null }, expected).reasons).toContain("request_max_tokens_missing");
    expect(verifyPaidDispatch({ ...base, requestUrl: "https://evil/x" }, expected).reasons.some((r) => r.startsWith("request_url_mismatch"))).toBe(true);
    expect(verifyPaidDispatch({ ...base, requestMethod: "GET" }, expected).reasons.some((r) => r.startsWith("request_method_mismatch"))).toBe(true);
    expect(verifyPaidDispatch({ ...base, messages: [{ role: "user", content: "x" }] }, expected).reasons).toContain("request_messages_mismatch");
  });
});

// --- 4. catalog + budget + source manifest + token bound --------------------

describe("catalog, budget, source manifest, token bound", () => {
  const target = HOSTED_PAID_TARGETS[0];
  const need = { maxTokens: 1024, promptTokens: 2048, usedParams: ["max_tokens", "seed"] };
  it("catalog: blocks missing model/endpoint/ceiling/price/param/alias/free and a missing provider display", () => {
    const v = verifyPaidTargetAgainstCatalog(goodModel(target), target, need);
    expect(v.ok).toBe(true);
    expect(v.providerDisplay).toBe(DISPLAY);
    expect(verifyPaidTargetAgainstCatalog(undefined, target, need).ok).toBe(false);
    expect(verifyPaidTargetAgainstCatalog({ id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], tag: "azure" }] }, target, need).reasons.some((r) => r.startsWith("provider_endpoint_missing"))).toBe(true);
    expect(verifyPaidTargetAgainstCatalog({ id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], pricing: { prompt: "1", completion: "1" } }] }, target, need).reasons).toContain("price_over_input_ceiling");
    expect(verifyPaidTargetAgainstCatalog({ id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], supportedParameters: ["max_tokens"] }] }, target, need).reasons).toContain("parameter_unsupported:seed");
    expect(verifyPaidTargetAgainstCatalog({ ...goodModel(target), isAlias: true }, target, need).reasons).toContain("model_is_alias");
    expect(verifyPaidTargetAgainstCatalog({ id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], providerName: null }] }, target, need).reasons).toContain("provider_display_name_missing");
  });
  it("verifyPaidCatalog uses per-cell prompt bounds and returns provider displays", () => {
    const cells = buildHostedPaidCells();
    const out = verifyPaidCatalog(HOSTED_PAID_PASS, cells, goodCatalog(HOSTED_PAID_TARGETS), promptMap(cells));
    expect(out.ok).toBe(true);
    expect(out.providerDisplay["openai/gpt-5.6-sol-pro"]).toBe(DISPLAY);
    // a per-cell prompt bound that blows the per-run cap is rejected
    const huge = new Map(cells.map((c) => [c.benchmark, 400_000_000]));
    expect(verifyPaidCatalog(HOSTED_PAID_PASS, cells, goodCatalog(HOSTED_PAID_TARGETS), huge).ok).toBe(false);
  });
  it("budget gates and actual-cost validation", () => {
    const b = { totalCapUsd: 5.0, perRunCapUsd: 1.0 };
    expect(checkBudgetBeforeDispatch(0, 1.5, b).reasons).toContain("per_run_cap_exceeded");
    expect(validatePaidActualCost(null, 0, b).reasons).toContain("cost_unknown_or_not_finite");
    expect(validatePaidActualCost(Number.POSITIVE_INFINITY, 0, b).reasons).toContain("cost_unknown_or_not_finite");
    expect(validatePaidActualCost(-1, 0, b).reasons).toContain("cost_negative");
    expect(validatePaidActualCost(1.5, 0, b).reasons).toContain("per_run_cap_exceeded_actual");
    expect(estimateCellCeilingUsd(HOSTED_PAID_TARGETS[0], 1_000_000, 1_000_000)).toBeCloseTo(12.0, 6);
  });
  it("token upper bound never underestimates (bytes >= tokens) and includes a margin", () => {
    expect(tokenUpperBound("abc", 0)).toBe(3);
    expect(tokenUpperBound("héllo", 0)).toBe(Buffer.byteLength("héllo", "utf-8"));
    expect(tokenUpperBound("x", 2048)).toBe(2049);
  });
  it("AUTHENTICATED source manifest verifies signature/owner/mode/signer + commit/tree/clean/digests", () => {
    const manifest = { commit: "c1", tree: "t1", files: [{ path: "a.ts", sha256: "d1" }] };
    const base: ObservedSource = {
      commit: "c1",
      tree: "t1",
      worktreeCleanInclUntracked: true,
      fileDigests: { "a.ts": "d1" },
      manifestIsRegularNonSymlink: true,
      manifestOwnerUid: 1000,
      executingUid: 1000,
      manifestMode: 0o600,
      signatureVerified: true,
      signerFingerprint: "435C9CF0DE7A2C3900FB24357E622B43290C285E",
    };
    expect(verifyAuthoritySourceManifest(manifest, base).ok).toBe(true);
    // git identity + worktree + file digests
    expect(verifyAuthoritySourceManifest(manifest, { ...base, commit: "OTHER" }).reasons.some((r) => r.startsWith("commit_mismatch"))).toBe(true);
    expect(verifyAuthoritySourceManifest(manifest, { ...base, tree: "OTHER" }).reasons.some((r) => r.startsWith("tree_mismatch"))).toBe(true);
    expect(verifyAuthoritySourceManifest(manifest, { ...base, worktreeCleanInclUntracked: false }).reasons).toContain("worktree_dirty_or_untracked");
    expect(verifyAuthoritySourceManifest(manifest, { ...base, fileDigests: { "a.ts": "TAMPERED" } }).reasons.some((r) => r.startsWith("source_file_digest_mismatch"))).toBe(true);
    expect(verifyAuthoritySourceManifest(manifest, { ...base, fileDigests: {} }).reasons.some((r) => r.startsWith("source_file_missing"))).toBe(true);
    // file security posture
    expect(verifyAuthoritySourceManifest(manifest, { ...base, manifestIsRegularNonSymlink: false }).reasons).toContain("manifest_not_regular_file");
    expect(verifyAuthoritySourceManifest(manifest, { ...base, manifestOwnerUid: 0 }).reasons).toContain("manifest_owner_mismatch");
    expect(verifyAuthoritySourceManifest(manifest, { ...base, manifestMode: 0o644 }).reasons).toContain("manifest_mode_insecure");
    // signature + pinned signer
    expect(verifyAuthoritySourceManifest(manifest, { ...base, signatureVerified: false }).reasons).toContain("manifest_signature_invalid");
    expect(verifyAuthoritySourceManifest(manifest, { ...base, signerFingerprint: "DEADBEEF" }).reasons.some((r) => r.startsWith("manifest_signer_unpinned"))).toBe(true);
    expect(verifyAuthoritySourceManifest(manifest, { ...base, signerFingerprint: null }).reasons.some((r) => r.startsWith("manifest_signer_unpinned"))).toBe(true);
  });
});

// --- 4b. preimage integrity + raw-observation re-derivation + manifest verify --

describe("byte-preserving preimage integrity and raw-observation re-derivation", () => {
  const good = (obj: unknown) => {
    const bytes = Buffer.from(JSON.stringify(obj), "utf-8");
    return { encoding: "base64" as const, base64: bytes.toString("base64"), sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
  };
  it("verifyWirePreimageIntegrity catches forged digest, wrong length, bad base64, and missing", () => {
    const p = good({ a: 1 });
    expect(verifyWirePreimageIntegrity(p).ok).toBe(true);
    expect(verifyWirePreimageIntegrity(p).decoded).toEqual({ a: 1 });
    expect(verifyWirePreimageIntegrity({ ...p, sha256: "sha256:" + "0".repeat(64) }).reasons).toContain("preimage_sha_mismatch");
    expect(verifyWirePreimageIntegrity({ ...p, bytes: p.bytes + 1 }).reasons).toContain("preimage_bytes_mismatch");
    expect(verifyWirePreimageIntegrity({ encoding: "utf-8" as any, base64: "x", sha256: "y", bytes: 1 }).reasons).toContain("preimage_encoding");
    expect(verifyWirePreimageIntegrity(null).reasons).toContain("preimage_missing");
  });
  it("reDerivePaidFromRawObservation reads billed cost from the raw lookup and projects identity", () => {
    const target = HOSTED_PAID_TARGETS[0];
    const routing = buildProviderRouting(target);
    const reqBody = { model: target.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 1024, temperature: 0, top_p: 1, seed: 1, provider: serializeProviderRouting(routing) };
    const resBody = { id: "g1", model: target.slug, provider: DISPLAY, choices: [{ finish_reason: "stop", message: { content: "ok" } }] };
    const lookupBody = { data: { id: "g1", model: target.slug, provider_name: DISPLAY, total_cost: 0.0731 } };
    const raw: PaidRawObservation = {
      runId: "r1",
      requestUrl: CHAT_URL,
      requestMethod: "POST",
      requestBody: good(reqBody),
      responseHttpStatus: 200,
      responseBody: good(resBody),
      costLookup: { polls: [{ kind: "http_response", httpStatus: 200, body: good(lookupBody) }], finalOk: true },
    };
    const d = reDerivePaidFromRawObservation(raw);
    expect(d.ok).toBe(true);
    expect(d.billedCostUsd).toBe(0.0731);
    expect(d.observed.model).toBe(target.slug);
    expect(d.observed.responseProvider).toBe(DISPLAY);
    expect(d.observed.lookupProvider).toBe(DISPLAY);
    expect(providerRoutingEqual(d.observed.routing!, routing)).toBe(true);
    // a tampered response digest fails closed and yields no billed cost trust
    const tampered = { ...raw, responseBody: { ...raw.responseBody!, sha256: "sha256:" + "0".repeat(64) } };
    expect(reDerivePaidFromRawObservation(tampered).ok).toBe(false);
    expect(reDerivePaidFromRawObservation(tampered).reasons.some((r) => r.startsWith("response_"))).toBe(true);
    // a missing cost lookup poll → no billed cost
    const noLookup: PaidRawObservation = { ...raw, costLookup: { polls: [], finalOk: false } };
    expect(reDerivePaidFromRawObservation(noLookup).billedCostUsd).toBeNull();
    expect(reDerivePaidFromRawObservation(noLookup).ok).toBe(false);
  });
  it("verifyPaidManifest re-reads every ref and catches a missing or mismatched artifact", () => {
    const disk = new Map<string, Buffer>();
    const put = (file: string, body: string): PaidManifestRef => {
      const buf = Buffer.from(body, "utf-8");
      disk.set(file, buf);
      return { file, sha256: "sha256:" + createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
    };
    const manifest: PaidBindingManifest = {
      sourceManifest: put("src.json", "{}"),
      parentInputs: [put("p.json", "[]")],
      catalogArtifact: put("cat.json", '{"c":1}'),
      rawObservations: [put("runs/raw.json", '{"r":1}')],
      records: [put("runs/rec.json", '{"x":1}')],
      wires: [put("runs/w.json", '{"w":1}')],
      intents: [put("runs/i.intent.json", '{"i":1}')],
      summary: put("sum.json", '{"s":1}'),
    };
    const read = (f: string) => disk.get(f) ?? null;
    expect(verifyPaidManifest(manifest, read).ok).toBe(true);
    // a deleted artifact
    disk.delete("runs/rec.json");
    expect(verifyPaidManifest(manifest, read).reasons.some((r) => r.startsWith("record_missing"))).toBe(true);
    // a mutated artifact (digest drift)
    disk.set("runs/rec.json", Buffer.from('{"x":2}', "utf-8"));
    expect(verifyPaidManifest(manifest, read).reasons.some((r) => r.startsWith("record_sha_mismatch") || r.startsWith("record_bytes_mismatch"))).toBe(true);
  });
});

// --- 5. dispatch wire: paid carries routing, non-paid unchanged --------------

describe("dispatch adapter provider routing in the wire", () => {
  const target = HOSTED_PAID_TARGETS[0];
  const routing = buildProviderRouting(target);
  it("serializes exact provider routing into the wire for a paid request", async () => {
    const { fn, calls } = mockFetch(target.slug);
    const facts = await dispatchViaBackend({ backendId: "openrouter", baseUrl: OR_BASE, timeoutMs: 5000, isHosted: true, req: { model: target.slug, maxTokens: 1024, temperature: null, topP: null, seed: 1, providerRouting: routing }, messages: [{ role: "user", content: "hi" }], fetchFn: fn });
    expect((calls[0].body as Record<string, unknown>).provider).toEqual(serializeProviderRouting(routing));
    expect(providerRoutingEqual(facts.requestSent.providerRouting!, routing)).toBe(true);
  });
  it("REGRESSION: a non-paid request carries no provider field", async () => {
    const { fn, calls } = mockFetch(target.slug);
    const facts = await dispatchViaBackend({ backendId: "openrouter", baseUrl: OR_BASE, timeoutMs: 5000, isHosted: true, req: { model: target.slug, maxTokens: 1024, temperature: 0, topP: 1, seed: 1 }, messages: [{ role: "user", content: "hi" }], fetchFn: fn });
    expect((calls[0].body as Record<string, unknown>).provider).toBeUndefined();
    expect(facts.requestSent.providerRouting).toBeUndefined();
  });
});

// --- 6. credential ordering --------------------------------------------------

describe("credential ordering — key read last, gates required", () => {
  it("reads the key only after every gate passes", async () => {
    const { deps, reads } = bootDeps("diagnostic-hosted-paid-r1", { CONTINUATION_OUTPUT_ROOT: "/x", OPENROUTER_API_KEY: "sk-or-secret" });
    const boot = await preparePaidBootstrap(deps as any);
    expect(boot.orKey).toBe("sk-or-secret");
    expect(reads.indexOf("OPENROUTER_API_KEY")).toBeGreaterThan(reads.indexOf("CONTINUATION_OUTPUT_ROOT"));
  });
  it("does NOT read the key when the catalog preflight fails", async () => {
    const { deps, reads } = bootDeps("diagnostic-hosted-paid-r1", { CONTINUATION_OUTPUT_ROOT: "/x", OPENROUTER_API_KEY: "sk" }, {
      fetchCatalogAndVerify: async () => ({ ok: false, reasons: ["price_over_input_ceiling"], catalogArtifactBody: "{}", perTarget: [], providerDisplay: {} }),
    });
    await expect(preparePaidBootstrap(deps as any)).rejects.toThrow(/catalog preflight failed/);
    expect(reads).not.toContain("OPENROUTER_API_KEY");
  });
  it("does NOT read the key when source / parent Evidence / campaign benchmarks fail", async () => {
    for (const over of [
      { verifySource: () => ({ ok: false, reasons: ["commit_mismatch"] }) },
      { verifyParentEvidence: () => ({ ok: false, details: [] }) },
      { verifyCampaignBenchmarks: async () => ({ ok: false, reasons: ["benchmark_hash_mismatch"] }) },
    ]) {
      const { deps, reads } = bootDeps("diagnostic-candidate-paid-r1", { CONTINUATION_OUTPUT_ROOT: "/x", OPENROUTER_API_KEY: "sk" }, over);
      await expect(preparePaidBootstrap(deps as any)).rejects.toThrow();
      expect(reads).not.toContain("OPENROUTER_API_KEY");
    }
  });
  it("finalizes the catalog artifact even on FAILURE (negative evidence) before throwing", async () => {
    let finalized = false;
    const { deps } = bootDeps("diagnostic-hosted-paid-r1", { CONTINUATION_OUTPUT_ROOT: "/x", OPENROUTER_API_KEY: "sk" }, {
      fetchCatalogAndVerify: async () => ({ ok: false, reasons: ["catalog_http_500"], catalogArtifactBody: '{"ok":false}', perTarget: [], providerDisplay: {} }),
      finalizeCatalogArtifact: () => { finalized = true; return null; },
    });
    await expect(preparePaidBootstrap(deps as any)).rejects.toThrow(/catalog preflight failed/);
    expect(finalized).toBe(true);
  });
});

// --- 7. orchestrator ---------------------------------------------------------

describe("runPaidPass orchestration", () => {
  it("candidate per-model sentinel failure skips only that model's remaining 3 cells", async () => {
    const failModel = "moonshotai/kimi-k3";
    const cells = buildCandidatePaidCells();
    const result = await runPaidPass(runOpts(CANDIDATE_PAID_PASS, cells, freshRoot("cand-sentinel"), withWire((cell: any, plan: any) => factsFor(plan, { ok: !(cell.target === failModel && cell.sentinel), costUsd: 0.01 }))));
    expect(result.stopped).toBeNull();
    expect(result.dispatchedRunIds.length).toBe(13);
    expect(result.skippedRunIds.length).toBe(3);
    expect(result.skippedGroups).toEqual([failModel]);
    expect(result.manifestFile).toMatch(/paid-pass-manifest-[0-9a-f]{64}\.json$/);
  });

  it("hosted global sentinel failure stops the pass after saving the billed sentinel", async () => {
    const cells = buildHostedPaidCells();
    const result = await runPaidPass(runOpts(HOSTED_PAID_PASS, cells, freshRoot("hosted-sentinel"), withWire((cell: any, plan: any) => factsFor(plan, { ok: !cell.sentinel, costUsd: 0.01 }))));
    expect(result.stopped).toMatch(/campaign_sentinel_not_accepted/);
    expect(result.dispatchedRunIds.length).toBe(1);
  });

  it("blocks a WRONG response provider (Azure on a pinned route) after saving the RAW observation", async () => {
    const root = freshRoot("provider-tamper");
    const cells = buildHostedPaidCells();
    const result = await runPaidPass(runOpts(HOSTED_PAID_PASS, cells, root, withWire((cell: any, plan: any) => factsFor(plan, { ok: true, costUsd: 0.01, display: "Azure" }))));
    expect(result.stopped).toMatch(/request_wire_mismatch.*response_provider_mismatch/);
    expect(result.dispatchedRunIds.length).toBe(1);
    const files = await readdir(join(root, "runs"));
    expect(files.some((f) => f.startsWith("paid-rawobs-"))).toBe(true);
    expect(files.some((f) => f.startsWith("paid-wirefrag-"))).toBe(true);
  });

  it("stops (and saves the raw observation) when the actual cost exceeds the per-run cap", async () => {
    const root = freshRoot("cost-overcap");
    const cells = buildHostedPaidCells();
    const result = await runPaidPass(runOpts(HOSTED_PAID_PASS, cells, root, withWire((cell: any, plan: any) => factsFor(plan, { ok: true, costUsd: 4.99 }))));
    expect(result.stopped).toMatch(/actual_cost_rejected.*per_run_cap_exceeded_actual/);
    expect(result.dispatchedRunIds.length).toBe(1);
    // the truthful spend records the billed cost even though it tripped the cap
    expect(result.spentUsd).toBeCloseTo(4.99, 6);
    const files = await readdir(join(root, "runs"));
    expect(files.some((f) => f.endsWith(".json") && !f.startsWith("paid-") && !f.includes("intent"))).toBe(true); // final record
    expect(files.some((f) => f.startsWith("paid-rawobs-"))).toBe(true);
  });

  it("stops (and saves the raw observation) when the actual cost is unknown (never 0-fill)", async () => {
    const cells = buildHostedPaidCells();
    const result = await runPaidPass(runOpts(HOSTED_PAID_PASS, cells, freshRoot("cost-unknown"), withWire((cell: any, plan: any) => factsFor(plan, { ok: true, costUsd: null }))));
    expect(result.stopped).toMatch(/actual_cost_rejected.*cost_unknown_or_not_finite/);
    expect(result.spentUsd).toBe(0);
    expect(result.dispatchedRunIds.length).toBe(1);
  });

  it("on a generate() throw, saves TERMINAL record + wire fragments and stops (no billed wire lost)", async () => {
    const root = freshRoot("dispatch-throw");
    const cells = buildHostedPaidCells();
    const result = await runPaidPass(
      runOpts(HOSTED_PAID_PASS, cells, root, throwAfterWire((_cell: any, plan: any) => factsFor(plan, { ok: true, costUsd: 0.01 }), "boom after provider call")),
    );
    expect(result.stopped).toMatch(/dispatch_exception/);
    expect(result.dispatchedRunIds.length).toBe(1);
    const files = await readdir(join(root, "runs"));
    expect(files.some((f) => f.endsWith(".json") && !f.startsWith("paid-") && !f.includes("intent"))).toBe(true); // terminal record
    expect(files.some((f) => f.startsWith("paid-wirefrag-"))).toBe(true); // request+response survived
    expect(result.manifestFile).toBeTruthy();
  });

  it("a happy candidate pass dispatches all 16 through the hardened journal (0600) with a binding manifest and no credential", async () => {
    const root = freshRoot("cand-happy");
    const cells = buildCandidatePaidCells();
    const result = await runPaidPass(runOpts(CANDIDATE_PAID_PASS, cells, root, withWire((cell: any, plan: any) => factsFor(plan, { ok: true, costUsd: 0.02 }))));
    expect(result.stopped).toBeNull();
    expect(result.dispatchedRunIds.length).toBe(16);
    const runFiles = (await readdir(join(root, "runs"))).filter((f) => f.endsWith(".json") && !f.includes("intent"));
    const records = runFiles.filter((f) => !f.startsWith("paid-"));
    const rawObs = runFiles.filter((f) => f.startsWith("paid-rawobs-"));
    const wireFrags = runFiles.filter((f) => f.startsWith("paid-wirefrag-"));
    expect(records.length).toBe(16);
    expect(rawObs.length).toBe(16);
    expect(wireFrags.length).toBe(32); // one request + one response fragment per cell
    for (const f of records) {
      expect((await stat(join(root, "runs", f))).mode & 0o777).toBe(0o600);
      const body = await readFile(join(root, "runs", f), "utf-8");
      expect(body).not.toMatch(/sk-or-v1-[A-Za-z0-9]/i);
      expect(body).not.toMatch(/"authorization"\s*:/i);
    }
    // the binding manifest content-addresses every record, raw observation, wire, and the summary
    const rootFiles = await readdir(root);
    const manifestName = rootFiles.find((f) => /^paid-pass-manifest-[0-9a-f]{64}\.json$/.test(f));
    expect(manifestName).toBeTruthy();
    const manifest = JSON.parse(await readFile(join(root, manifestName!), "utf-8"));
    expect(manifest.records.length).toBe(16);
    expect(manifest.rawObservations.length).toBe(16);
    expect(manifest.wires.length).toBe(32);
    expect(manifest.summary.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
