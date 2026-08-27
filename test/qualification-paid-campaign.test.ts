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
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from "fs/promises";
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
  AUTHORITY_SOURCE_MANIFEST_SIGNER,
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

type OnWire = (ev: any) => void;

/** Forward the request/response preimages AND the cost-lookup poll chain to the
 * durable sink, exactly as the real adapter does — the raw observation is then
 * assembled from these persisted fragments, never from the returned facts. */
function emitWire(facts: any, onWire: OnWire) {
  onWire({ stage: "request", url: facts.wire.request.url, method: "POST", preimage: facts.wire.request.body });
  onWire({ stage: "response", url: facts.wire.request.url, method: "POST", httpStatus: 200, preimage: facts.wire.response.body });
  onWire({ stage: "cost_lookup", costLookup: facts.wire.costLookup });
}

/** Wrap a facts producer into a `generate` that sinks the wire BEFORE returning. */
function withWire(factsFn: (cell: any, plan: any) => any) {
  return async (cell: any, plan: any, _req: any, onWire: OnWire) => {
    const facts = factsFn(cell, plan);
    emitWire(facts, onWire);
    return facts;
  };
}

/**
 * A generate that DIVERGES: it sinks the wire the adversary actually transmitted
 * (`sunk`) but RETURNS a different, benign facts object. The re-derivation must read
 * the SUNK wire from disk, so the benign facts can never launder a bad dispatch.
 */
function withDivergentWire(sunkFn: (cell: any, plan: any) => any, returnedFn: (cell: any, plan: any) => any) {
  return async (cell: any, plan: any, _req: any, onWire: OnWire) => {
    emitWire(sunkFn(cell, plan), onWire);
    return returnedFn(cell, plan);
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
let anchorDir: string;
// The strict binding manifest requires a non-null source manifest / signature /
// attestation / catalog + a non-empty parent input, each digest-matched on disk. In
// production these are finalized by the bootstrap; here they are real external files
// (absolute paths, OUTSIDE the output root, so they are excluded from the output-root
// surplus check) so runPaidPass exercises the real strict verifier.
let anchors: {
  sourceManifestRef: PaidManifestRef;
  sourceSignatureRef: PaidManifestRef;
  sourceAttestationRef: PaidManifestRef;
  catalogArtifactRef: PaidManifestRef;
  parentInputRefs: PaidManifestRef[];
};
async function writeAnchor(name: string, body: string): Promise<PaidManifestRef> {
  const file = join(anchorDir, name);
  await writeFile(file, body, { mode: 0o600 });
  return { file, sha256: "sha256:" + createHash("sha256").update(Buffer.from(body, "utf-8")).digest("hex"), bytes: Buffer.byteLength(body, "utf-8") };
}
beforeAll(async () => {
  outRoot = await mkdtemp(join(tmpdir(), "plinius-paid-"));
  anchorDir = await mkdtemp(join(tmpdir(), "plinius-anchors-"));
  anchors = {
    sourceManifestRef: await writeAnchor("source-manifest.json", JSON.stringify({ commit: "c", tree: "t", files: [] })),
    sourceSignatureRef: await writeAnchor("source-manifest.json.sig", "-----BEGIN PGP SIGNATURE-----\nx\n-----END PGP SIGNATURE-----\n"),
    sourceAttestationRef: await writeAnchor("source-attestation.json", JSON.stringify({ schemaVersion: 1, signatureVerified: true })),
    catalogArtifactRef: await writeAnchor("catalog.json", JSON.stringify({ ok: true })),
    parentInputRefs: [await writeAnchor("parent-bundle.tar", "bundle-bytes")],
  };
});
afterAll(async () => {
  await rm(outRoot, { recursive: true, force: true });
  await rm(anchorDir, { recursive: true, force: true });
});
const freshRoot = (name: string) => join(outRoot, name);

const runOpts = (pass: any, cells: any[], root: string, gen: any) => ({
  pass,
  cells,
  outputRoot: root,
  providerDisplay: displayMap(pass.targets),
  ...anchors,
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
  it("AUTHENTICATED source manifest verifies signature file/owner/mode/FULL signer + commit/tree/clean/digests", () => {
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
      signerFingerprint: AUTHORITY_SOURCE_MANIFEST_SIGNER,
      signatureFilePresent: true,
      signatureIsRegularNonSymlink: true,
    };
    expect(verifyAuthoritySourceManifest(manifest, base).ok).toBe(true);
    // git identity + worktree + file digests
    expect(verifyAuthoritySourceManifest(manifest, { ...base, commit: "OTHER" }).reasons.some((r) => r.startsWith("commit_mismatch"))).toBe(true);
    expect(verifyAuthoritySourceManifest(manifest, { ...base, tree: "OTHER" }).reasons.some((r) => r.startsWith("tree_mismatch"))).toBe(true);
    expect(verifyAuthoritySourceManifest(manifest, { ...base, worktreeCleanInclUntracked: false }).reasons).toContain("worktree_dirty_or_untracked");
    expect(verifyAuthoritySourceManifest(manifest, { ...base, fileDigests: { "a.ts": "TAMPERED" } }).reasons.some((r) => r.startsWith("source_file_digest_mismatch"))).toBe(true);
    expect(verifyAuthoritySourceManifest(manifest, { ...base, fileDigests: {} }).reasons.some((r) => r.startsWith("source_file_missing"))).toBe(true);
    // file security posture — manifest AND signature file
    expect(verifyAuthoritySourceManifest(manifest, { ...base, manifestIsRegularNonSymlink: false }).reasons).toContain("manifest_not_regular_file");
    expect(verifyAuthoritySourceManifest(manifest, { ...base, manifestOwnerUid: 0 }).reasons).toContain("manifest_owner_mismatch");
    expect(verifyAuthoritySourceManifest(manifest, { ...base, manifestMode: 0o644 }).reasons).toContain("manifest_mode_insecure");
    expect(verifyAuthoritySourceManifest(manifest, { ...base, signatureFilePresent: false }).reasons).toContain("manifest_signature_file_absent");
    expect(verifyAuthoritySourceManifest(manifest, { ...base, signatureIsRegularNonSymlink: false }).reasons).toContain("manifest_signature_file_absent");
    // signature + EXACT full-fingerprint pin (a 16-hex suffix is NO LONGER accepted)
    expect(verifyAuthoritySourceManifest(manifest, { ...base, signatureVerified: false }).reasons).toContain("manifest_signature_invalid");
    expect(verifyAuthoritySourceManifest(manifest, { ...base, signerFingerprint: "7E622B43290C285E" }).reasons.some((r) => r.startsWith("manifest_signer_unpinned"))).toBe(true);
    expect(verifyAuthoritySourceManifest(manifest, { ...base, signerFingerprint: null }).reasons.some((r) => r.startsWith("manifest_signer_unpinned"))).toBe(true);
  });
});

// --- 4b. raw-observation re-derivation (canonical + full chain) + manifest verify --

const goodPre = (obj: unknown) => {
  const bytes = Buffer.from(JSON.stringify(obj), "utf-8");
  return { encoding: "base64" as const, base64: bytes.toString("base64"), sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
};
const httpPoll = (i: number, status: number, body: any, extra: Record<string, unknown> = {}) => ({
  pollIndex: i,
  kind: "http_response" as const,
  url: "https://openrouter.ai/api/v1/generation?id=g1",
  method: "GET" as const,
  receivedAtUtc: "t",
  httpStatus: status,
  headers: {},
  body,
  jsonParsed: true,
  jsonError: null,
  dataPresent: status === 200,
  ...extra,
});

describe("raw-observation re-derivation from disk bytes (canonical + full chain)", () => {
  const target = HOSTED_PAID_TARGETS[0];
  const routing = buildProviderRouting(target);
  const rawFor = (over: Partial<PaidRawObservation> = {}, reqOver: Record<string, unknown> = {}): PaidRawObservation => {
    const reqBody = { model: target.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 1024, temperature: 0, top_p: 1, seed: 1, provider: serializeProviderRouting(routing), ...reqOver };
    const resBody = { id: "g1", model: target.slug, provider: DISPLAY, choices: [{ finish_reason: "stop", message: { content: "ok" } }] };
    const lookupBody = { data: { id: "g1", model: target.slug, provider_name: DISPLAY, total_cost: 0.0731 } };
    return {
      runId: "r1",
      requestUrl: CHAT_URL,
      requestMethod: "POST",
      requestBody: goodPre(reqBody),
      responseHttpStatus: 200,
      responseBody: goodPre(resBody),
      costLookup: { polls: [httpPoll(0, 200, goodPre(lookupBody))], finalOk: true } as any,
      ...over,
    };
  };
  it("re-derives billed cost + identity + response outcome from the stored bytes", () => {
    const d = reDerivePaidFromRawObservation(rawFor());
    expect(d.ok).toBe(true);
    expect(d.billedCostUsd).toBe(0.0731);
    expect(d.observed.model).toBe(target.slug);
    expect(d.observed.responseProvider).toBe(DISPLAY);
    expect(d.observed.lookupProvider).toBe(DISPLAY);
    expect(d.responseOutcome?.status.qualification).toBeDefined();
    expect(providerRoutingEqual(d.observed.routing!, routing)).toBe(true);
  });
  it("rejects a NON-CANONICAL base64 request body (smuggled bytes)", () => {
    const raw = rawFor();
    // Inject a newline: Node's lenient decoder drops it, but the round-trip differs.
    const nc = { ...raw.requestBody!, base64: raw.requestBody!.base64.slice(0, 8) + "\n" + raw.requestBody!.base64.slice(8) };
    expect(reDerivePaidFromRawObservation({ ...raw, requestBody: nc }).ok).toBe(false);
    expect(reDerivePaidFromRawObservation({ ...raw, requestBody: nc }).reasons.some((r) => r.includes("noncanonical"))).toBe(true);
  });
  it("rejects an EXTRA request field (a `models` fallback list)", () => {
    const d = reDerivePaidFromRawObservation(rawFor({}, { models: ["cheaper/model"] }));
    expect(d.ok).toBe(false);
    expect(d.reasons).toContain("request_unexpected_field:models");
  });
  it("rejects a forged response digest and yields no cost trust", () => {
    const raw = rawFor();
    const tampered = { ...raw, responseBody: { ...raw.responseBody!, sha256: "sha256:" + "0".repeat(64) } };
    const d = reDerivePaidFromRawObservation(tampered);
    expect(d.ok).toBe(false);
    expect(d.reasons.some((r) => r.startsWith("response_"))).toBe(true);
  });
  it("rejects finalOk=false / an unsettled cost lookup, and bills nothing", () => {
    const notSettled = rawFor({ costLookup: { polls: [httpPoll(0, 500, goodPre({ error: "boom" }), { dataPresent: false })], finalOk: false } as any });
    const d = reDerivePaidFromRawObservation(notSettled);
    expect(d.ok).toBe(false);
    expect(d.billedCostUsd).toBeNull();
    expect(d.reasons.some((r) => r.startsWith("cost_"))).toBe(true);
  });
  it("rejects a forged cost poll flag (finalOk true but final poll is HTTP 500)", () => {
    // finalOk claims settled, but the only poll is a non-200 with no data.
    const forged = rawFor({ costLookup: { polls: [httpPoll(0, 500, goodPre({ nope: 1 }), { dataPresent: false })], finalOk: true } as any });
    const d = reDerivePaidFromRawObservation(forged);
    expect(d.ok).toBe(false);
    expect(d.reasons.some((r) => r.startsWith("cost_"))).toBe(true);
  });
});

describe("verifyPaidManifest is fail-closed", () => {
  const put = (disk: Map<string, Buffer>, file: string, body: string): PaidManifestRef => {
    const buf = Buffer.from(body, "utf-8");
    disk.set(file, buf);
    return { file, sha256: "sha256:" + createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  };
  const build = () => {
    const disk = new Map<string, Buffer>();
    const manifest: PaidBindingManifest = {
      sourceManifest: put(disk, "/ext/src.json", "{}"),
      sourceSignature: put(disk, "/ext/src.json.sig", "sig"),
      sourceAttestation: put(disk, "/ext/att.json", '{"a":1}'),
      parentInputs: [put(disk, "/ext/p.json", "[]")],
      catalogArtifact: put(disk, "/ext/cat.json", '{"c":1}'),
      rawObservations: [put(disk, "runs/raw.json", '{"r":1}')],
      records: [put(disk, "runs/rec.json", '{"x":1}')],
      wires: [put(disk, "runs/w.json", '{"w":1}')],
      intents: [put(disk, "runs/i.intent.json", '{"i":1}')],
      summary: put(disk, "sum.json", '{"s":1}'),
    };
    return { disk, manifest, read: (f: string) => disk.get(f) ?? null };
  };
  it("accepts a complete, digest-matching manifest", () => {
    const { manifest, read } = build();
    expect(verifyPaidManifest(manifest, read).ok).toBe(true);
  });
  it("rejects a null source manifest / signature / attestation / catalog", () => {
    for (const key of ["sourceManifest", "sourceSignature", "sourceAttestation", "catalogArtifact"] as const) {
      const { manifest, read } = build();
      (manifest as any)[key] = null;
      expect(verifyPaidManifest(manifest, read).ok).toBe(false);
    }
  });
  it("rejects empty records / wires / raw observations / intents", () => {
    for (const key of ["records", "wires", "rawObservations", "intents"] as const) {
      const { manifest, read } = build();
      (manifest as any)[key] = [];
      const r = verifyPaidManifest(manifest, read);
      expect(r.ok).toBe(false);
      expect(r.reasons.some((x) => x.endsWith("_empty"))).toBe(true);
    }
  });
  it("rejects a duplicate ref and an unsafe (traversal) path", () => {
    const { manifest, read } = build();
    manifest.records.push(manifest.records[0]); // duplicate file
    expect(verifyPaidManifest(manifest, read).reasons.some((r) => r.startsWith("duplicate_ref"))).toBe(true);
    const { manifest: m2, read: r2, disk } = build();
    const buf = Buffer.from("evil", "utf-8");
    disk.set("runs/../escape.json", buf);
    m2.wires.push({ file: "runs/../escape.json", sha256: "sha256:" + createHash("sha256").update(buf).digest("hex"), bytes: buf.length });
    expect(verifyPaidManifest(m2, r2).reasons.some((r) => r.startsWith("wire_unsafe_path"))).toBe(true);
  });
  it("with diskFiles: rejects a surplus (unbound) file and a shortfall (bound-but-absent)", () => {
    const { manifest, read } = build();
    // The bound root-relative set is {runs/raw.json, runs/rec.json, runs/w.json, runs/i.intent.json, sum.json}.
    const bound = ["runs/raw.json", "runs/rec.json", "runs/w.json", "runs/i.intent.json", "sum.json"];
    expect(verifyPaidManifest(manifest, read, { diskFiles: bound }).ok).toBe(true);
    // surplus: an extra file on disk the manifest does not bind
    expect(verifyPaidManifest(manifest, read, { diskFiles: [...bound, "runs/orphan.json"] }).reasons.some((r) => r.startsWith("unbound_disk_file"))).toBe(true);
    // shortfall: a bound file missing from the disk set
    expect(verifyPaidManifest(manifest, read, { diskFiles: bound.filter((f) => f !== "sum.json") }).reasons.some((r) => r.startsWith("bound_file_absent_on_disk"))).toBe(true);
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
    expect(result.passed).toBe(0);
    const files = await readdir(join(root, "runs"));
    expect(files.some((f) => f.startsWith("paid-rawobs-"))).toBe(true);
    expect(files.some((f) => f.startsWith("paid-wirefrag-"))).toBe(true);
    // The record itself is qualification=fail — not just a side-channel verdict (F03).
    const recName = files.find((f) => f.endsWith(".json") && !f.startsWith("paid-") && !f.includes("intent"));
    const rec = JSON.parse(await readFile(join(root, "runs", recName!), "utf-8"));
    expect(rec.status.qualification).toBe("fail");
    expect(rec.paidVerdict.ok).toBe(false);
  });

  it("ADVERSARIAL: a benign RETURNED facts cannot launder a bad SUNK wire (F01)", async () => {
    const root = freshRoot("divergent-wire");
    const cells = buildHostedPaidCells();
    // The sink persists a BAD dispatch (wrong provider + content_filter + unknown cost);
    // generate then RETURNS a benign, fully-qualified facts object. The verdict must
    // reflect the SUNK wire read back from disk, never the returned object.
    const result = await runPaidPass(
      runOpts(
        HOSTED_PAID_PASS,
        cells,
        root,
        withDivergentWire(
          (_c: any, plan: any) => factsFor(plan, { ok: false, costUsd: null, display: "Azure" }),
          (_c: any, plan: any) => factsFor(plan, { ok: true, costUsd: 0.01 }),
        ),
      ),
    );
    expect(result.stopped).not.toBeNull();
    expect(result.passed).toBe(0);
    const files = await readdir(join(root, "runs"));
    const recName = files.find((f) => f.endsWith(".json") && !f.startsWith("paid-") && !f.includes("intent"));
    const rec = JSON.parse(await readFile(join(root, "runs", recName!), "utf-8"));
    expect(rec.status.qualification).toBe("fail");
    expect(rec.paidVerdict.ok).toBe(false);
    // The persisted raw observation carries the SUNK (Azure / content_filter) response.
    const rawName = files.find((f) => f.startsWith("paid-rawobs-"));
    const raw = JSON.parse(await readFile(join(root, "runs", rawName!), "utf-8"));
    const sunkResponse = JSON.parse(Buffer.from(raw.responseBody.base64, "base64").toString("utf-8"));
    expect(sunkResponse.provider).toBe("Azure");
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
    expect(wireFrags.length).toBe(48); // request + response + cost_lookup fragment per cell
    for (const f of records) {
      expect((await stat(join(root, "runs", f))).mode & 0o777).toBe(0o600);
      const body = await readFile(join(root, "runs", f), "utf-8");
      expect(body).not.toMatch(/sk-or-v1-[A-Za-z0-9]/i);
      expect(body).not.toMatch(/"authorization"\s*:/i);
    }
    // the binding manifest content-addresses every record, raw observation, wire, source
    // authentication trail, catalog, and the summary
    const rootFiles = await readdir(root);
    const manifestName = rootFiles.find((f) => /^paid-pass-manifest-[0-9a-f]{64}\.json$/.test(f));
    expect(manifestName).toBeTruthy();
    const manifest = JSON.parse(await readFile(join(root, manifestName!), "utf-8"));
    expect(manifest.records.length).toBe(16);
    expect(manifest.rawObservations.length).toBe(16);
    expect(manifest.wires.length).toBe(48);
    expect(manifest.sourceManifest).toBeTruthy();
    expect(manifest.sourceSignature).toBeTruthy();
    expect(manifest.sourceAttestation).toBeTruthy();
    expect(manifest.catalogArtifact).toBeTruthy();
    expect(manifest.summary.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
