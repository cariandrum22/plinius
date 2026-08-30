/**
 * Partitioned hosted paid passes — production-path tests (Paid Pass v3.3).
 *
 * v3 packages a stable dependency-free launcher, one bundled driver, benchmark assets and
 * an independent Mac verifier under one signed execution manifest. A separately signed,
 * short-lived policy pins the mutable model catalog. Ubuntu never loads the source tree,
 * package manager, tsx or node_modules. Anchor copy remains before the key, while all seal
 * checks precede creation of the final Evidence manifest.
 *
 * Drives the real production code: the pure paid-campaign module (routing, catalog
 * verification, budget, actual-cost, from-bytes re-derivation with the EXACT request
 * key set / stream / HTTP-200 / cost-endpoint binding, authenticated execution manifest,
 * attestation-content + content-addressed-name checks, and a fail-closed portable
 * binding manifest), the dispatch adapter, the credential-ordering bootstrap, and the
 * paid orchestrator: a durable sink that persists request/response AND EACH cost poll
 * at its own boundary (rejecting duplicate stages), raw observations assembled by
 * reading the fragments back, records whose qualification is overwritten on any verdict
 * failure, and a manifest read back from disk, cross-checked against the RECURSIVE disk
 * tree, with the source anchors COPIED IN as portable relative envelopes. No network,
 * no credential.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, readdir, realpath, stat, writeFile, mkdir, chmod, symlink } from "fs/promises";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { basename, join } from "path";

import { acquireInvocationLock, finalizeArtifact } from "../src/continuation/journal.js";
import {
  verifyPaidLaunchGrant,
  PAID_ARTIFACT_PINNED_SIGNER,
  PAID_ARTIFACT_TYPE,
} from "../src/qualification/paid-artifact.js";
import type { PaidExecutionManifest, PaidLaunchGrant, PaidLaunchObservation } from "../src/qualification/paid-artifact.js";
import { createLaunchGrant, loadVerifiedRunner, verifyCampaignPolicy, verifyExecutionPackage } from "../qualification-paid-launch.mjs";
import { parseCampaignPolicy, verifyPaidEvidence } from "../qualification-paid-verify.mjs";

import {
  HOSTED_PAID_PASS,
  CANDIDATE_PAID_PASS,
  HOSTED_PAID_TARGETS,
  CANDIDATE_PAID_TARGETS,
  buildHostedPaidCells,
  buildCandidatePaidCells,
  buildPerModelPaidCells,
  buildProviderRouting,
  serializeProviderRouting,
  parseProviderRoutingWire,
  providerRoutingEqual,
  verifyPaidRequestWire,
  verifyPaidTargetAgainstCatalog,
  verifyPaidDispatch,
  validatePaidActualCost,
  PAID_EXECUTION_MANIFEST_SIGNER,
  reDerivePaidFromRawObservation,
  verifyPaidManifest,
  verifyPaidExecutionAttestation,
  verifyContentAddressedName,
  tokenUpperBound,
  estimateCellCeilingUsd,
  checkBudgetBeforeDispatch,
  OIDC_BENCHMARK_ID,
  parsePaidCampaignPolicy,
  PAID_CAMPAIGN_POLICY_SIGNER,
  BROAD_PAID_MAX_CELLS,
  BROAD_PAID_MAX_TARGETS,
} from "../src/qualification/paid-campaign.js";
import type {
  CatalogModelInfo,
  PaidTarget,
  ProviderRouting,
  ObservedDispatch,
  ExpectedDispatch,
  PaidRawObservation,
  PaidBindingManifest,
  PaidManifestRef,
} from "../src/qualification/paid-campaign.js";

import { dispatchViaBackend, preparePaidBootstrap, runPaidPass, paidPlanCell, verifyPaidCatalog, resolveDriverMode, generationCost, copyPaidAnchorsIntoRoot, validatePaidOpenRouterCredential, PAID_TIMEOUT_MS } from "../qualification-driver.mjs";
import type { PaidCellPlan } from "../qualification-driver.mjs";
import type { FetchFn } from "../src/backends/openai-compatible.js";

const OR_BASE = "https://openrouter.ai/api/v1";
const CHAT_URL = `${OR_BASE}/chat/completions`;
const DISPLAY = "TestProvider";
const ALL_PAID_MODES = ["diagnostic-hosted-paid-r1", "diagnostic-candidate-paid-r1", "diagnostic-broad-paid-r1"] as const;

// --- helpers -----------------------------------------------------------------

function goodModel(target: PaidTarget): CatalogModelInfo {
  return {
    id: target.slug,
    catalogModelId: target.catalogModelId,
    canonicalSlug: target.slug,
    endpoints: [
      {
        tag: target.providerRoute,
        providerName: target.providerDisplay,
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
const displayMap = (targets: PaidTarget[]) => Object.fromEntries(targets.map((t) => [t.slug, t.providerDisplay]));
const promptMap = (cells: { benchmark: string }[]) => new Map(cells.map((c) => [c.benchmark, 1000]));

function wirePreimage(obj: unknown) {
  const bytes = Buffer.from(JSON.stringify(obj), "utf-8");
  return { encoding: "base64" as const, base64: bytes.toString("base64"), sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

function validOpenRouterKey(): string {
  return `sk-or-v1-${"a".repeat(64)}`;
}

function mockFetch(model: string): { fn: FetchFn; calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const fn: FetchFn = async (url, init) => {
    let body: unknown = null;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    } catch {
      body = init?.body ?? null;
    }
    calls.push({ url: String(url), body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
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
  opts: { ok?: boolean; costUsd?: number | null; routing?: ProviderRouting | null; model?: string; responseModel?: string; lookupModel?: string; url?: string; display?: string; genId?: string; costUrl?: string } = {},
): any {
  const ok = opts.ok ?? true;
  const routing = opts.routing === undefined ? buildProviderRouting(plan.target) : opts.routing;
  const model = opts.model ?? plan.target.slug;
  const responseModel = opts.responseModel ?? plan.target.responseModelId;
  const lookupModel = opts.lookupModel ?? plan.target.lookupModelId;
  const display = opts.display ?? plan.target.providerDisplay;
  const cost = opts.costUsd === undefined ? 0.01 : opts.costUsd;
  const s = plan.target.sampling;
  // Mirror the real OpenAI-compatible backend EXACTLY: model / messages / stream:false /
  // max_tokens / provider always, sampling keys only when the plan sends them.
  const sentBody: Record<string, unknown> = {
    model,
    messages: plan.messages,
    stream: false,
    max_tokens: plan.maxTokens,
    ...(s.temperature !== null ? { temperature: s.temperature } : {}),
    ...(s.topP !== null ? { top_p: s.topP } : {}),
    ...(s.seed !== null ? { seed: s.seed } : {}),
    ...(routing ? { provider: serializeProviderRouting(routing) } : {}),
  };
  const genId = opts.genId ?? "gen-x";
  const responseBody = { id: genId, model: responseModel, provider: display, choices: [{ finish_reason: ok ? "stop" : "content_filter", message: { role: "assistant", content: ok ? "FINAL ANSWER" : "" } }], usage: {} };
  const lookupBody = { data: { id: genId, model: lookupModel, provider_name: display, total_cost: cost } };
  const reqPre = wirePreimage(sentBody);
  const resPre = wirePreimage(responseBody);
  const lookupPre = wirePreimage(lookupBody);
  const url = opts.url ?? CHAT_URL;
  const costUrl = opts.costUrl ?? `${OR_BASE}/generation?id=${encodeURIComponent(genId)}`;
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
    responseModelId: responseModel,
    responseGenerationId: "gen-x",
    responseProvider: display,
    generationLookupModelId: lookupModel,
    generationLookupGenerationId: "gen-x",
    generationLookupProvider: display,
    wire: {
      request: { url, method: "POST", body: reqPre },
      response: { httpStatus: 200, receivedAtUtc: "t", headers: {}, body: resPre },
      costLookup: { polls: [{ pollIndex: 0, kind: "http_response", url: costUrl, method: "GET", receivedAtUtc: "t", httpStatus: 200, headers: {}, body: lookupPre, jsonParsed: true, jsonError: null, dataPresent: true }], finalOk: true },
    },
  };
}

type OnWire = (ev: any) => void;

/** Forward the request/response preimages AND the cost-lookup poll chain to the
 * durable sink, exactly as the real adapter does — the raw observation is then
 * assembled from these persisted fragments, never from the returned facts. */
function emitWire(facts: any, onWire: OnWire) {
  onWire({ stage: "request", url: facts.wire.request.url, method: "POST", preimage: facts.wire.request.body });
  onWire({ stage: "response", url: facts.wire.request.url, method: "POST", httpStatus: facts.wire.response.httpStatus ?? 200, preimage: facts.wire.response.body, bodyReadError: null });
  for (const poll of facts.wire.costLookup.polls) onWire({ stage: "cost_poll", pollIndex: poll.pollIndex, poll });
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
    onWire({ stage: "response", url: facts.wire.request.url, method: "POST", httpStatus: 200, preimage: facts.wire.response.body, bodyReadError: null });
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
    ...(mode === "diagnostic-hosted-paid-r1"
      ? { pass: HOSTED_PAID_PASS, cells: buildHostedPaidCells(HOSTED_PAID_TARGETS) }
      : { pass: CANDIDATE_PAID_PASS, cells: buildCandidatePaidCells(CANDIDATE_PAID_TARGETS) }),
    readEnv,
    verifyExecution: () => ({ ok: true, reasons: [] }),
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
// The execution manifest, its detached signature, and the THREE parent inputs are external
// files whose CONTENT runPaidPass copies INTO the output root as content-addressed
// envelopes. The catalog + source attestation are finalized in-root by the bootstrap in
// production; each test's setup pre-finalizes them under a held lock, exactly mirroring
// that flow, so runPaidPass exercises the real strict (relative-only, portable) verifier.
let anchorPaths: { executionManifestPath: string; executionSignaturePath: string; parentInputPaths: string[] };
const launcherSha = "sha256:" + "1".repeat(64);
const runnerSha = "sha256:" + "2".repeat(64);
beforeAll(async () => {
  outRoot = await realpath(await mkdtemp(join(tmpdir(), "plinius-paid-")));
  anchorDir = await realpath(await mkdtemp(join(tmpdir(), "plinius-anchors-")));
  const w = async (name: string, body: string) => {
    const p = join(anchorDir, name);
    await writeFile(p, body, { mode: 0o600 });
    return p;
  };
  const executionManifest = {
    schemaVersion: 1,
    artifactType: "plinius-paid-pass-v3",
    createdAtUtc: "2026-08-28T00:00:00Z",
    source: { commit: "a".repeat(40), tree: "b".repeat(40) },
    requiredSignerFingerprint: PAID_ARTIFACT_PINNED_SIGNER,
    allowedModes: [...ALL_PAID_MODES],
    launcher: "qualification-paid-launch.mjs",
    runner: "qualification-driver.mjs",
    verifier: "qualification-paid-verify.mjs",
    files: [
      { path: "qualification-paid-launch.mjs", sha256: launcherSha, bytes: 1, role: "launcher" },
      { path: "qualification-driver.mjs", sha256: runnerSha, bytes: 1, role: "runner" },
      { path: "qualification-paid-verify.mjs", sha256: "sha256:" + "3".repeat(64), bytes: 1, role: "verifier" },
    ],
  };
  anchorPaths = {
    executionManifestPath: await w("qualification-paid-execution-manifest.json", JSON.stringify(executionManifest)),
    executionSignaturePath: await w("qualification-paid-execution-manifest.json.sig", "detached-signature-bytes"),
    parentInputPaths: [await w("parent-bundle.tar", "bundle-bytes"), await w("frozen-definition.json", '{"frozen":true}'), await w("historical-run.json", '{"run":true}')],
  };
});
afterAll(async () => {
  await rm(outRoot, { recursive: true, force: true });
  await rm(anchorDir, { recursive: true, force: true });
});
const freshRoot = (name: string) => join(outRoot, name);
const sha256Hex = (body: string) => createHash("sha256").update(Buffer.from(body, "utf-8")).digest("hex");
const fileSha = async (p: string) => "sha256:" + createHash("sha256").update(await readFile(p)).digest("hex");

function policyBodyFor(pass: any): string {
  const { policyId, ...unsignedPass } = pass;
  return `${JSON.stringify({
    schemaVersion: 2,
    policyType: "plinius-paid-campaign-policy-v2",
    policyId,
    issuedAtUtc: "2026-08-28T00:00:00Z",
    catalogObservedAtUtc: "2026-08-28T00:00:00Z",
    expiresAtUtc: "2026-09-04T00:00:00Z",
    requiredSignerFingerprint: PAID_CAMPAIGN_POLICY_SIGNER,
    pass: unsignedPass,
  }, null, 2)}\n`;
}

function broadTarget(index: number): PaidTarget {
  return {
    slug: `vendor/model-${index}-20260830`,
    catalogModelId: `vendor/model-${index}`,
    responseModelId: `vendor/model-${index}`,
    lookupModelId: `vendor/model-${index}-20260830`,
    providerRoute: `provider-${index}`,
    providerDisplay: `Provider ${index}`,
    priceCeiling: { inputPerMTokens: 0.1, outputPerMTokens: 0.2 },
    sampling: { temperature: null, topP: null, seed: null },
  };
}

function broadPass(targetCount: number): any {
  return {
    mode: "diagnostic-broad-paid-r1",
    campaignId: "plinius-qualification-broad-h1-r1",
    stageId: "plinius-qualification-diagnostic-broad-h1-r1",
    budget: { totalCapUsd: 3, perRunCapUsd: 0.75 },
    targets: Array.from({ length: targetCount }, (_, index) => broadTarget(index + 1)),
    sentinelScope: "per-model",
    policyId: "plinius-broad-paid-h1-r1",
  };
}

// Mirror the production bootstrap: acquire a lock on a fresh root, finalize the catalog +
// the campaign/stage-bound source attestation in-root, and hand runPaidPass the same lock
// plus the external anchor PATHS (which it copies in). The attestation records the ACTUAL
// anchor digests and the parent expected digests are the ACTUAL anchor digests, so the
// copy-vs-verify TOCTOU checks pass on genuine (unmodified) anchors.
async function setupPaidRun(pass: any, cells: any[], root: string, gen: any) {
  await mkdir(root, { recursive: true });
  await chmod(root, 0o700); // the hardened journal requires a 0700 output root
  const lock = acquireInvocationLock(root, { stageId: pass.stageId, invocationId: `${pass.stageId}#test`, startedAt: "2026-08-28T00:00:00Z" });
  const policyPath = join(anchorDir, `${basename(root)}-policy.json`);
  const policySignaturePath = `${policyPath}.sig`;
  await writeFile(policyPath, policyBodyFor(pass), { mode: 0o600 });
  await writeFile(policySignaturePath, "campaign-policy-signature", { mode: 0o600 });
  const catalogEvidence: Array<Record<string, unknown>> = [];
  const addCatalogEvidence = (endpoint: string, value: unknown) => {
    const raw = Buffer.from(JSON.stringify(value), "utf-8");
    catalogEvidence.push({
      endpoint,
      fetchedAtUtc: "2026-08-28T00:00:00Z",
      httpStatus: 200,
      rawBodyBase64: raw.toString("base64"),
      rawBodySha256: "sha256:" + createHash("sha256").update(raw).digest("hex"),
      byteLength: raw.length,
      transportError: null,
    });
  };
  addCatalogEvidence(`${OR_BASE}/models`, { data: pass.targets.map((target: PaidTarget) => ({ id: target.catalogModelId, canonical_slug: target.slug })) });
  for (const target of pass.targets as PaidTarget[]) {
    addCatalogEvidence(`${OR_BASE}/models/${target.slug}/endpoints`, {
      data: {
        endpoints: [{
          tag: target.providerRoute,
          provider_name: target.providerDisplay,
          pricing: {
            prompt: target.priceCeiling.inputPerMTokens / 1_000_000,
            completion: target.priceCeiling.outputPerMTokens / 1_000_000,
          },
          context_length: 200_000,
          max_completion_tokens: 64_000,
          supported_parameters: ["max_tokens", "temperature", "top_p", "seed"],
        }],
      },
    });
  }
  const promptBounds = new Map([
    ["se-concurrency-atomic-stats-012", 6858],
    ["arch-exactly-once-003", 5541],
    ["sec-oidc-id-token-validation-001", 4298],
    ["formal-spec-idempotent-api-003", 4835],
  ]);
  const totalCeilingUsd = cells.reduce((sum, cell) => {
    const target = pass.targets.find((item: PaidTarget) => item.slug === cell.target) as PaidTarget;
    const maxTokens = cell.benchmark === "arch-exactly-once-003" ? 28672 : 24576;
    return sum + ((promptBounds.get(cell.benchmark) ?? Number.POSITIVE_INFINITY) * target.priceCeiling.inputPerMTokens + maxTokens * target.priceCeiling.outputPerMTokens) / 1_000_000;
  }, 0);
  const catalogBody = JSON.stringify({
    ok: true,
    reasons: [],
    campaignId: pass.campaignId,
    stageId: pass.stageId,
    policyId: pass.policyId,
    providerDisplay: displayMap(pass.targets),
    catalogEvidence,
    verification: pass.targets.map((target: PaidTarget) => ({ slug: target.slug, ok: true, reasons: [], providerDisplay: target.providerDisplay })),
    budget: pass.budget,
    totalCeilingUsd,
  });
  const catalog = finalizeArtifact(root, `paid-catalog-preflight-${sha256Hex(catalogBody)}.json`, catalogBody, lock);
  const attBody = JSON.stringify({
    schemaVersion: 1,
    campaignId: pass.campaignId,
    stageId: pass.stageId,
    signatureVerified: true,
    signerFingerprint: PAID_EXECUTION_MANIFEST_SIGNER,
    pinnedSigner: PAID_EXECUTION_MANIFEST_SIGNER,
    manifestSha256: await fileSha(anchorPaths.executionManifestPath),
    signatureSha256: await fileSha(anchorPaths.executionSignaturePath),
    artifactType: "plinius-paid-pass-v3",
    artifactSchemaVersion: 1,
    launcherSha256: launcherSha,
    runnerSha256: runnerSha,
    campaignPolicyId: pass.policyId,
    campaignPolicySha256: await fileSha(policyPath),
    campaignPolicySignatureSha256: await fileSha(policySignaturePath),
    campaignPolicySignerFingerprint: PAID_CAMPAIGN_POLICY_SIGNER,
  });
  const att = finalizeArtifact(root, `paid-execution-attestation-${sha256Hex(attBody)}.json`, attBody, lock);
  const parentInputExpectedSha256 = await Promise.all(anchorPaths.parentInputPaths.map(fileSha));
  // Mirror the bootstrap: COPY + digest-verify the anchors into the root before the run.
  const anchors = copyPaidAnchorsIntoRoot(lock, root, {
    executionManifestPath: anchorPaths.executionManifestPath,
    executionSignaturePath: anchorPaths.executionSignaturePath,
    campaignPolicyPath: policyPath,
    campaignPolicySignaturePath: policySignaturePath,
    parentInputPaths: anchorPaths.parentInputPaths,
    expectedManifestSha256: await fileSha(anchorPaths.executionManifestPath),
    expectedSignatureSha256: await fileSha(anchorPaths.executionSignaturePath),
    expectedCampaignPolicySha256: await fileSha(policyPath),
    expectedCampaignPolicySignatureSha256: await fileSha(policySignaturePath),
    parentExpectedSha256: parentInputExpectedSha256,
  });
  return {
    pass,
    cells,
    outputRoot: root,
    lock,
    providerDisplay: displayMap(pass.targets),
    catalogArtifactRef: { file: catalog.file, sha256: catalog.sha256, bytes: catalog.bytes },
    executionAttestationRef: { file: att.file, sha256: att.sha256, bytes: att.bytes },
    anchors,
    parentInputExpectedSha256,
    planCell: (cell: any, i: number) => paidPlanCell(pass, cell, i),
    generate: gen,
  };
}

// --- 1. fixed definitions ----------------------------------------------------

describe("paid pass fixed definitions", () => {
  it("Hosted Pass A: routes/ceilings/15 cells", () => {
    expect(HOSTED_PAID_PASS.stageId).toBe("plinius-qualification-2026-08-22-diagnostic-hosted-paid-r1");
    expect(HOSTED_PAID_PASS.budget).toEqual({ totalCapUsd: 5.0, perRunCapUsd: 1.0 });
    expect(HOSTED_PAID_TARGETS.map((t) => [t.slug, t.providerRoute])).toEqual([
      ["openai/gpt-5.6-sol-pro-20260709", "openai"],
      ["anthropic/claude-opus-5-20260723", "claude-on-aws"],
      ["google/gemini-3.7-flash-20260813", "google-vertex/global"],
      ["deepseek/deepseek-v4-flash-20260731", "deepinfra/fp8"],
    ]);
    const cells = buildHostedPaidCells(HOSTED_PAID_TARGETS);
    expect(cells.length).toBe(15);
    expect(cells.filter((c) => c.sentinel).length).toBe(1);
    expect(cells.some((c) => c.target === "anthropic/claude-opus-5-20260723" && c.benchmark === OIDC_BENCHMARK_ID)).toBe(false);
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
    const cells = buildCandidatePaidCells(CANDIDATE_PAID_TARGETS);
    expect(cells.length).toBe(16);
    for (const t of CANDIDATE_PAID_TARGETS) expect(cells.filter((c) => c.group === t.slug && c.sentinel).length).toBe(1);
  });

  it("resolveDriverMode accepts all paid modes and rejects unknown", () => {
    expect(resolveDriverMode("diagnostic-hosted-paid-r1")).toBe("diagnostic-hosted-paid-r1");
    expect(resolveDriverMode("diagnostic-candidate-paid-r1")).toBe("diagnostic-candidate-paid-r1");
    expect(resolveDriverMode("diagnostic-broad-paid-r1")).toBe("diagnostic-broad-paid-r1");
    expect(() => resolveDriverMode(undefined)).toThrow();
  });
});

describe("detached-signature campaign policy", () => {
  const bytes = Buffer.from(policyBodyFor(HOSTED_PAID_PASS), "utf-8");
  it("loads canonical versioned targets under the fixed engine budget cap", () => {
    const loaded = parsePaidCampaignPolicy(bytes, "diagnostic-hosted-paid-r1", "2026-08-29T00:00:00Z");
    expect(loaded.pass.policyId).toBe(HOSTED_PAID_PASS.policyId);
    expect(loaded.pass.targets.map((target) => target.slug)).toEqual(HOSTED_PAID_TARGETS.map((target) => target.slug));
    expect(loaded.cells).toHaveLength(15);
    expect(loaded.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("rejects noncanonical bytes, unknown fields, mode drift, expiry and an increased budget", () => {
    expect(() => parsePaidCampaignPolicy(Buffer.concat([bytes, Buffer.from(" ")]), "diagnostic-hosted-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/canonical/);
    const original = JSON.parse(bytes.toString("utf-8"));
    const encoded = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf-8");
    expect(() => parsePaidCampaignPolicy(encoded({ ...original, extra: true }), "diagnostic-hosted-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/field set/);
    expect(() => parsePaidCampaignPolicy(bytes, "diagnostic-candidate-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/mode/);
    expect(() => parsePaidCampaignPolicy(bytes, "diagnostic-hosted-paid-r1", "2026-09-04T00:00:00Z")).toThrow(/expired/);
    expect(() => parsePaidCampaignPolicy(encoded({ ...original, pass: { ...original.pass, budget: { totalCapUsd: 50, perRunCapUsd: 10 } } }), "diagnostic-hosted-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/budget/);
    const unsafeSampling = structuredClone(original);
    unsafeSampling.pass.targets[0].sampling.temperature = 3;
    expect(() => parsePaidCampaignPolicy(encoded(unsafeSampling), "diagnostic-hosted-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/sampling/);
    const duplicateResponse = structuredClone(original);
    duplicateResponse.pass.targets[1].responseModelId = duplicateResponse.pass.targets[0].responseModelId;
    expect(() => parsePaidCampaignPolicy(encoded(duplicateResponse), "diagnostic-hosted-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/duplicate target responseModelId/);
    const missingLookup = structuredClone(original);
    delete missingLookup.pass.targets[0].lookupModelId;
    expect(() => parsePaidCampaignPolicy(encoded(missingLookup), "diagnostic-hosted-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/field set/);
    const duplicateLookup = structuredClone(original);
    duplicateLookup.pass.targets[1].lookupModelId = duplicateLookup.pass.targets[0].lookupModelId;
    expect(() => parsePaidCampaignPolicy(encoded(duplicateLookup), "diagnostic-hosted-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/duplicate target lookupModelId/);
    const sharedProvider = structuredClone(original);
    sharedProvider.pass.targets[1].providerRoute = sharedProvider.pass.targets[0].providerRoute;
    expect(parsePaidCampaignPolicy(encoded(sharedProvider), "diagnostic-hosted-paid-r1", "2026-08-29T00:00:00Z").pass.targets).toHaveLength(4);
    expect(() => parsePaidCampaignPolicy(encoded({ ...original, issuedAtUtc: "2026-02-30T00:00:00Z" }), "diagnostic-hosted-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/timestamp/);
  });

  it("loads the checked-in short-lived Hosted policy as canonical policy bytes", async () => {
    const checkedIn = await readFile(join(process.cwd(), "policy", "qualification-hosted-paid-2026-08-30-r2.json"));
    const loaded = parsePaidCampaignPolicy(checkedIn, "diagnostic-hosted-paid-r1", "2026-08-29T16:00:00Z");
    expect(loaded.pass.stageId).toBe("plinius-qualification-2026-08-30-diagnostic-hosted-paid-r3");
    expect(loaded.pass.targets.map((target) => target.slug)).toEqual(HOSTED_PAID_TARGETS.map((target) => target.slug));
    expect(loaded.pass.targets[0].responseModelId).toBe("openai/gpt-5.6-sol-pro");
    expect(loaded.pass.targets[0].lookupModelId).toBe("openai/gpt-5.6-sol-pro-20260709");

    const legacy = await readFile(join(process.cwd(), "policy", "qualification-hosted-paid-2026-08-29-r1.json"));
    expect(() => parsePaidCampaignPolicy(legacy, "diagnostic-hosted-paid-r1", "2026-08-29T16:00:00Z")).toThrow(/identity mismatch/);
  });

  it("loads the checked-in Candidate policy with four canonical versioned targets", async () => {
    const checkedIn = await readFile(join(process.cwd(), "policy", "qualification-candidate-paid-2026-08-30-r1.json"));
    const loaded = parsePaidCampaignPolicy(checkedIn, "diagnostic-candidate-paid-r1", "2026-08-30T02:00:00Z");
    expect(loaded.pass.policyId).toBe("plinius-candidate-paid-2026-08-30-r1");
    expect(loaded.pass.targets.map((target) => target.slug)).toEqual([
      "z-ai/glm-5.3-20260816",
      "moonshotai/kimi-k3-20260715",
      "qwen/qwen3.8-max-20260803",
      "anthropic/claude-sonnet-5-20260630",
    ]);
    expect(loaded.cells).toHaveLength(16);
    expect(loaded.cells.filter((cell) => cell.sentinel)).toHaveLength(4);
  });

  it("loads Candidate r2 as a fresh full pass with non-colliding campaign identity", async () => {
    const r1 = parsePaidCampaignPolicy(
      await readFile(join(process.cwd(), "policy", "qualification-candidate-paid-2026-08-30-r1.json")),
      "diagnostic-candidate-paid-r1",
      "2026-08-30T06:14:00Z",
    );
    const r2 = parsePaidCampaignPolicy(
      await readFile(join(process.cwd(), "policy", "qualification-candidate-paid-2026-08-30-r2.json")),
      "diagnostic-candidate-paid-r1",
      "2026-08-30T06:14:00Z",
    );
    expect(r2.pass.policyId).toBe("plinius-candidate-paid-2026-08-30-r2");
    expect(r2.pass.campaignId).not.toBe(r1.pass.campaignId);
    expect(r2.pass.stageId).not.toBe(r1.pass.stageId);
    expect(r2.pass.budget).toEqual({ totalCapUsd: 6, perRunCapUsd: 0.75 });
    expect(r2.cells).toHaveLength(16);
    expect(r2.cells.filter((cell) => cell.sentinel)).toHaveLength(4);
  });

  it("loads broad policies from one through 24 targets with per-model sentinels", () => {
    const one = parsePaidCampaignPolicy(Buffer.from(policyBodyFor(broadPass(1))), "diagnostic-broad-paid-r1", "2026-08-29T00:00:00Z");
    expect(one.cells).toHaveLength(4);
    expect(one.cells.filter((cell) => cell.sentinel)).toHaveLength(1);

    const maximum = parsePaidCampaignPolicy(Buffer.from(policyBodyFor(broadPass(BROAD_PAID_MAX_TARGETS))), "diagnostic-broad-paid-r1", "2026-08-29T00:00:00Z");
    expect(maximum.cells).toHaveLength(BROAD_PAID_MAX_CELLS);
    expect(maximum.cells.filter((cell) => cell.sentinel)).toHaveLength(BROAD_PAID_MAX_TARGETS);
    expect(buildPerModelPaidCells(maximum.pass.targets)).toEqual(maximum.cells);
  });

  it("rejects broad target, cell, scope, budget, and field-set drift", () => {
    const encode = (pass: any) => Buffer.from(policyBodyFor(pass));
    expect(() => parsePaidCampaignPolicy(encode(broadPass(0)), "diagnostic-broad-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/target count/);
    expect(() => parsePaidCampaignPolicy(encode(broadPass(BROAD_PAID_MAX_TARGETS + 1)), "diagnostic-broad-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/target count/);
    expect(() => buildPerModelPaidCells(broadPass(BROAD_PAID_MAX_TARGETS + 1).targets)).toThrow(/1-24 targets/);
    expect(() => parsePaidCampaignPolicy(encode({ ...broadPass(1), sentinelScope: "global" }), "diagnostic-broad-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/sentinel scope/);
    expect(() => parsePaidCampaignPolicy(encode({ ...broadPass(1), budget: { totalCapUsd: 12.01, perRunCapUsd: 2 } }), "diagnostic-broad-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/budget/);
    expect(() => parsePaidCampaignPolicy(encode({ ...broadPass(1), targets: [{ ...broadTarget(1), reasoningEffort: "high" }] }), "diagnostic-broad-paid-r1", "2026-08-29T00:00:00Z")).toThrow(/field set/);
  });

  it("the independent verifier applies the same broad bounds without importing the engine", () => {
    expect(parseCampaignPolicy(Buffer.from(policyBodyFor(broadPass(2)))).identity.totalCells).toBe(8);
    expect(() => parseCampaignPolicy(Buffer.from(policyBodyFor({ ...broadPass(1), sentinelScope: "global" })))).toThrow(/policy_mode/);
    expect(() => parseCampaignPolicy(Buffer.from(policyBodyFor({ ...broadPass(1), budget: { totalCapUsd: 12, perRunCapUsd: 2.01 } })))).toThrow(/policy_budget/);
    expect(() => parseCampaignPolicy(Buffer.from(policyBodyFor(broadPass(BROAD_PAID_MAX_TARGETS + 1))))).toThrow(/policy_targets/);
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
  const costUrl = `${OR_BASE}/generation?id=g1`;
  const fullKeys = ["max_tokens", "messages", "model", "provider", "seed", "stream", "temperature", "top_p"].sort();
  const expected: ExpectedDispatch = { requestUrl: CHAT_URL, model: target.slug, responseModelId: target.responseModelId, lookupModelId: target.lookupModelId, routing, maxTokens: 24576, temperature: 0, topP: 1, seed: 1, messages, providerDisplay: "DeepInfra", costLookupBaseUrl: OR_BASE };
  const base: ObservedDispatch = {
    requestUrl: CHAT_URL, requestMethod: "POST", model: target.slug, routing, maxTokens: 24576, temperature: 0, topP: 1, seed: 1, messages,
    requestKeys: fullKeys, stream: false, responseHttpStatus: 200,
    responseModelId: target.responseModelId, responseProvider: "DeepInfra", responseGenerationId: "g1", lookupModelId: target.lookupModelId, lookupGenerationId: "g1", lookupProvider: "DeepInfra",
    costPollUrls: [costUrl],
  };
  it("passes a fully-consistent dispatch", () => {
    expect(verifyPaidDispatch(base, expected).ok).toBe(true);
  });
  it("passes an independently pinned base response and versioned lookup identity", () => {
    expect(target.responseModelId).not.toBe(target.lookupModelId);
    expect(verifyPaidDispatch(base, expected).ok).toBe(true);
  });
  it("rejects swapped or unpinned response and lookup identities", () => {
    const swapped = verifyPaidDispatch({ ...base, responseModelId: target.lookupModelId, lookupModelId: target.responseModelId }, expected);
    expect(swapped.reasons.some((reason) => reason.startsWith("response_model_mismatch"))).toBe(true);
    expect(swapped.reasons.some((reason) => reason.startsWith("lookup_model_mismatch"))).toBe(true);
    expect(verifyPaidDispatch({ ...base, responseModelId: `${target.responseModelId}-alternate` }, expected).ok).toBe(false);
    expect(verifyPaidDispatch({ ...base, lookupModelId: `${target.lookupModelId}-alternate` }, expected).ok).toBe(false);
  });
  it("blocks stream:true, an extra/missing field, a non-200 response, and a wrong cost URL", () => {
    expect(verifyPaidDispatch({ ...base, stream: true }, expected).reasons.some((r) => r.startsWith("request_stream_not_false"))).toBe(true);
    // a smuggled `models` fallback field
    expect(verifyPaidDispatch({ ...base, requestKeys: [...fullKeys, "models"].sort() }, expected).reasons.some((r) => r.startsWith("request_field_set_mismatch"))).toBe(true);
    // a present-but-null sampling field the plan does not send (extra "logprobs")
    expect(verifyPaidDispatch({ ...base, requestKeys: [...fullKeys, "logprobs"].sort() }, expected).reasons.some((r) => r.startsWith("request_field_set_mismatch"))).toBe(true);
    // reasoning profiles are intentionally outside the broad-screening schema
    expect(verifyPaidDispatch({ ...base, requestKeys: [...fullKeys, "reasoning"].sort() }, expected).reasons.some((r) => r.startsWith("request_field_set_mismatch"))).toBe(true);
    // HTTP 500 is never a pass even with a success-shaped body
    expect(verifyPaidDispatch({ ...base, responseHttpStatus: 500 }, expected).reasons.some((r) => r.startsWith("response_http_status"))).toBe(true);
    // an attacker cost-poll URL (different generation id / host)
    expect(verifyPaidDispatch({ ...base, costPollUrls: [`${OR_BASE}/generation?id=EVIL`] }, expected).reasons.some((r) => r.startsWith("cost_poll_url_mismatch"))).toBe(true);
    expect(verifyPaidDispatch({ ...base, costPollUrls: [] }, expected).reasons).toContain("cost_poll_urls_missing");
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

// --- 4. catalog + budget + token bound ---------------------------------------

describe("catalog, budget, token bound", () => {
  const target = HOSTED_PAID_TARGETS[0];
  const need = { maxTokens: 1024, promptTokens: 2048, usedParams: ["max_tokens", "seed"] };
  it("catalog: blocks missing model/endpoint/ceiling/price/param/alias/free and a missing provider display", () => {
    const v = verifyPaidTargetAgainstCatalog(goodModel(target), target, need);
    expect(v.ok).toBe(true);
    expect(v.providerDisplay).toBe(target.providerDisplay);
    expect(verifyPaidTargetAgainstCatalog(undefined, target, need).ok).toBe(false);
    expect(verifyPaidTargetAgainstCatalog({ id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], tag: "azure" }] }, target, need).reasons.some((r) => r.startsWith("provider_endpoint_missing"))).toBe(true);
    expect(verifyPaidTargetAgainstCatalog({ id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], pricing: { prompt: "1", completion: "1" } }] }, target, need).reasons).toContain("price_over_input_ceiling");
    expect(verifyPaidTargetAgainstCatalog({ id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], supportedParameters: ["max_tokens"] }] }, target, need).reasons).toContain("parameter_unsupported:seed");
    expect(verifyPaidTargetAgainstCatalog({ ...goodModel(target), isAlias: true }, target, need).reasons).toContain("model_is_alias");
    expect(verifyPaidTargetAgainstCatalog({ ...goodModel(target), canonicalSlug: "openai/gpt-5.6-sol-pro-OTHER" }, target, need).reasons.some((r) => r.startsWith("canonical_slug_mismatch"))).toBe(true);
    expect(verifyPaidTargetAgainstCatalog({ ...goodModel(target), catalogModelId: "openai/other" }, target, need).reasons.some((r) => r.startsWith("catalog_model_id_mismatch"))).toBe(true);
    expect(verifyPaidTargetAgainstCatalog({ id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], providerName: null }] }, target, need).reasons).toContain("provider_display_name_missing");
  });
  it("verifyPaidCatalog uses per-cell prompt bounds and returns provider displays", () => {
    const cells = buildHostedPaidCells(HOSTED_PAID_TARGETS);
    const out = verifyPaidCatalog(HOSTED_PAID_PASS, cells, goodCatalog(HOSTED_PAID_TARGETS), promptMap(cells));
    expect(out.ok).toBe(true);
    expect(out.providerDisplay[target.slug]).toBe(target.providerDisplay);
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
    const reqBody = { model: target.slug, messages: [{ role: "user", content: "hi" }], stream: false, max_tokens: 1024, temperature: 0, top_p: 1, seed: 1, provider: serializeProviderRouting(routing), ...reqOver };
    const resBody = { id: "g1", model: target.responseModelId, provider: target.providerDisplay, choices: [{ finish_reason: "stop", message: { content: "ok" } }] };
    const lookupBody = { data: { id: "g1", model: target.lookupModelId, provider_name: target.providerDisplay, total_cost: 0.0731 } };
    return {
      runId: "r1",
      requestUrl: CHAT_URL,
      requestMethod: "POST",
      requestBody: goodPre(reqBody),
      responseHttpStatus: 200,
      responseBody: goodPre(resBody),
      responseBodyError: null,
      costLookup: { polls: [httpPoll(0, 200, goodPre(lookupBody))], finalOk: true } as any,
      ...over,
    };
  };
  it("re-derives billed cost + identity + response outcome from the stored bytes", () => {
    const d = reDerivePaidFromRawObservation(rawFor());
    expect(d.ok).toBe(true);
    expect(d.billedCostUsd).toBe(0.0731);
    expect(d.observed.model).toBe(target.slug);
    expect(d.observed.responseProvider).toBe(target.providerDisplay);
    expect(d.observed.lookupProvider).toBe(target.providerDisplay);
    expect(d.responseOutcome?.status.qualification).toBeDefined();
    expect(providerRoutingEqual(d.observed.routing!, routing)).toBe(true);
    // Exposes the exact request key set, stream flag, HTTP status, and cost-poll URLs so
    // verifyPaidDispatch can enforce them against the plan.
    expect(d.observed.requestKeys).toEqual(["max_tokens", "messages", "model", "provider", "seed", "stream", "temperature", "top_p"].sort());
    expect(d.observed.stream).toBe(false);
    expect(d.observed.responseHttpStatus).toBe(200);
    expect(d.observed.costPollUrls).toEqual(["https://openrouter.ai/api/v1/generation?id=g1"]);
  });
  it("re-derives the EXACT observed request keys including a smuggled `models` field", () => {
    // The extra-field REJECTION lives in verifyPaidDispatch (plan-aware); reDerive must
    // faithfully surface the extra key so that check can fire.
    const d = reDerivePaidFromRawObservation(rawFor({}, { models: ["cheaper/model"] }));
    expect(d.observed.requestKeys).toContain("models");
  });
  it("rejects a NON-CANONICAL base64 request body (smuggled bytes)", () => {
    const raw = rawFor();
    // Inject a newline: Node's lenient decoder drops it, but the round-trip differs.
    const nc = { ...raw.requestBody!, base64: raw.requestBody!.base64.slice(0, 8) + "\n" + raw.requestBody!.base64.slice(8) };
    expect(reDerivePaidFromRawObservation({ ...raw, requestBody: nc }).ok).toBe(false);
    expect(reDerivePaidFromRawObservation({ ...raw, requestBody: nc }).reasons.some((r) => r.includes("noncanonical"))).toBe(true);
  });
  it("rejects a forged response digest and yields no cost trust", () => {
    const raw = rawFor();
    const tampered = { ...raw, responseBody: { ...raw.responseBody!, sha256: "sha256:" + "0".repeat(64) } };
    const d = reDerivePaidFromRawObservation(tampered);
    expect(d.ok).toBe(false);
    expect(d.reasons.some((r) => r.startsWith("response_"))).toBe(true);
  });
  it("retains a validated body-read timeout as an explicit failure reason", () => {
    const raw = rawFor({
      responseBody: null,
      responseBodyError: { kind: "timeout", message: "response body read timed out after 1200000ms", timeoutMs: 1_200_000 },
      costLookup: null,
    });
    const d = reDerivePaidFromRawObservation(raw);
    expect(d.ok).toBe(false);
    expect(d.reasons).toContain("response_body_timeout");
    expect(d.reasons).toContain("response_wire_body_missing");
    expect(d.billedCostUsd).toBeNull();
  });
  it("rejects malformed or contradictory body-read error evidence", () => {
    const raw = rawFor({ responseBodyError: { kind: "timeout", message: "timeout", timeoutMs: 1_200_000 } });
    expect(reDerivePaidFromRawObservation(raw).reasons).toContain("response_body_error_with_preimage");
    const malformed = rawFor({ responseBody: null, responseBodyError: { kind: "timeout", message: "bad\nmessage", timeoutMs: 0 } });
    expect(reDerivePaidFromRawObservation(malformed).reasons).toContain("response_body_error_invalid");
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
    // Every ref is RELATIVE (Evidence is a self-contained portable tree); exactly 3
    // parent inputs.
    const manifest: PaidBindingManifest = {
      executionManifest: put(disk, "paid-execution-manifest.json", "{}"),
      executionSignature: put(disk, "paid-execution-signature.json", "sig"),
      executionAttestation: put(disk, "paid-execution-attestation.json", '{"a":1}'),
      campaignPolicy: put(disk, "paid-campaign-policy.json", "{}"),
      campaignPolicySignature: put(disk, "paid-campaign-policy-signature.json", "sig"),
      parentInputs: [put(disk, "p0.json", "[]"), put(disk, "p1.json", "[]"), put(disk, "p2.json", "[]")],
      catalogArtifact: put(disk, "cat.json", '{"c":1}'),
      rawObservations: [put(disk, "runs/raw.json", '{"r":1}')],
      records: [put(disk, "runs/rec.json", '{"x":1}')],
      wires: [put(disk, "runs/w.json", '{"w":1}')],
      intents: [put(disk, "runs/i.intent.json", '{"i":1}')],
      summary: put(disk, "sum.json", '{"s":1}'),
    };
    return { disk, manifest, read: (f: string) => disk.get(f) ?? null };
  };
  const allBound = ["paid-execution-manifest.json", "paid-execution-signature.json", "paid-execution-attestation.json", "paid-campaign-policy.json", "paid-campaign-policy-signature.json", "p0.json", "p1.json", "p2.json", "cat.json", "runs/raw.json", "runs/rec.json", "runs/w.json", "runs/i.intent.json", "sum.json"];
  it("accepts a complete, digest-matching manifest", () => {
    const { manifest, read } = build();
    expect(verifyPaidManifest(manifest, read).ok).toBe(true);
  });
  it("rejects a null execution manifest / signature / attestation / catalog", () => {
    for (const key of ["executionManifest", "executionSignature", "executionAttestation", "catalogArtifact"] as const) {
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
  it("rejects a parent-input count other than exactly three", () => {
    const { manifest, read } = build();
    manifest.parentInputs = manifest.parentInputs.slice(0, 2); // only 2
    expect(verifyPaidManifest(manifest, read).reasons.some((r) => r.startsWith("parent_input_count"))).toBe(true);
  });
  it("rejects a duplicate ref, an ABSOLUTE path, and a traversal path", () => {
    const { manifest, read } = build();
    manifest.records.push(manifest.records[0]); // duplicate file
    expect(verifyPaidManifest(manifest, read).reasons.some((r) => r.startsWith("duplicate_ref"))).toBe(true);
    // an absolute path is no longer a valid bound ref (non-portable Evidence)
    const { manifest: m2, read: r2 } = build();
    m2.wires.push({ file: "/ext/escape.json", sha256: "sha256:" + "0".repeat(64), bytes: 1 });
    expect(verifyPaidManifest(m2, r2).reasons.some((r) => r.startsWith("wire_unsafe_path"))).toBe(true);
    // a traversal path
    const { manifest: m3, read: r3 } = build();
    m3.wires.push({ file: "runs/../escape.json", sha256: "sha256:" + "0".repeat(64), bytes: 1 });
    expect(verifyPaidManifest(m3, r3).reasons.some((r) => r.startsWith("wire_unsafe_path"))).toBe(true);
  });
  it("with diskFiles: rejects a surplus (orphan in ANY subdir) and a shortfall", () => {
    const { manifest, read } = build();
    expect(verifyPaidManifest(manifest, read, { diskFiles: allBound }).ok).toBe(true);
    // surplus: an orphan file in a stray subdirectory the manifest does not bind
    expect(verifyPaidManifest(manifest, read, { diskFiles: [...allBound, "orphan-dir/unbound.json"] }).reasons.some((r) => r.startsWith("unbound_disk_file"))).toBe(true);
    // shortfall: a bound file missing from the disk set
    expect(verifyPaidManifest(manifest, read, { diskFiles: allBound.filter((f) => f !== "sum.json") }).reasons.some((r) => r.startsWith("bound_file_absent_on_disk"))).toBe(true);
  });
});

describe("verifyPaidExecutionAttestation + content-addressed name", () => {
  const good = {
    campaignId: "camp", stageId: "stage", signatureVerified: true,
    signerFingerprint: PAID_EXECUTION_MANIFEST_SIGNER,
    manifestSha256: "sha256:" + "a".repeat(64), signatureSha256: "sha256:" + "b".repeat(64),
    campaignPolicyId: "policy", campaignPolicySha256: "sha256:" + "c".repeat(64),
    campaignPolicySignatureSha256: "sha256:" + "d".repeat(64), campaignPolicySignerFingerprint: PAID_CAMPAIGN_POLICY_SIGNER,
  };
  it("accepts a fully-authenticated attestation for the right campaign/stage", () => {
    expect(verifyPaidExecutionAttestation(good, { campaignId: "camp", stageId: "stage" }).ok).toBe(true);
  });
  it("rejects a wrong campaign/stage, an unverified signature, or an unpinned signer", () => {
    expect(verifyPaidExecutionAttestation(good, { campaignId: "OTHER", stageId: "stage" }).reasons.some((r) => r.startsWith("attestation_campaign_mismatch"))).toBe(true);
    expect(verifyPaidExecutionAttestation({ ...good, signatureVerified: false }, { campaignId: "camp", stageId: "stage" }).reasons).toContain("attestation_signature_not_verified");
    expect(verifyPaidExecutionAttestation({ ...good, signerFingerprint: "7E622B43290C285E" }, { campaignId: "camp", stageId: "stage" }).reasons.some((r) => r.startsWith("attestation_signer_unpinned"))).toBe(true);
    expect(verifyPaidExecutionAttestation(null, { campaignId: "camp", stageId: "stage" }).ok).toBe(false);
  });
  it("verifyContentAddressedName ties a filename to its own bytes", () => {
    const body = Buffer.from("hello", "utf-8");
    const sha = createHash("sha256").update(body).digest("hex");
    expect(verifyContentAddressedName(`paid-pass-manifest-${sha}.json`, body)).toBe(true);
    expect(verifyContentAddressedName(`paid-pass-manifest-${"0".repeat(64)}.json`, body)).toBe(false);
    expect(verifyContentAddressedName("no-digest.json", body)).toBe(false);
  });
});

describe("verifyPaidManifest filesystem-metadata + self-identity checks (F04)", () => {
  const put = (disk: Map<string, Buffer>, file: string, body: string): PaidManifestRef => {
    const buf = Buffer.from(body, "utf-8");
    disk.set(file, buf);
    return { file, sha256: "sha256:" + createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  };
  const build = () => {
    const disk = new Map<string, Buffer>();
    const manifest = {
      manifestSchemaVersion: 6,
      campaignId: "camp",
      stageId: "stage",
      executionManifest: put(disk, "sm.json", "{}"),
      executionSignature: put(disk, "sig.json", "s"),
      executionAttestation: put(disk, "att.json", "{}"),
      campaignPolicy: put(disk, "policy.json", "{}"),
      campaignPolicySignature: put(disk, "policy-sig.json", "s"),
      parentInputs: [put(disk, "p0", "0"), put(disk, "p1", "1"), put(disk, "p2", "2")],
      catalogArtifact: put(disk, "cat.json", "{}"),
      rawObservations: [put(disk, "runs/raw.json", "{}")],
      records: [put(disk, "runs/rec.json", "{}")],
      wires: [put(disk, "runs/w.json", "{}")],
      intents: [put(disk, "runs/i.intent.json", "{}")],
      summary: put(disk, "sum.json", "{}"),
    } as any as PaidBindingManifest;
    return { disk, manifest, read: (f: string) => disk.get(f) ?? null };
  };
  const okStat = { isRegularFile: true, isSymbolicLink: false, ownerUid: 1000, mode: 0o600, nlink: 1 };
  it("accepts regular, single-link, owner-matched, 0600 artifacts with the right schema/campaign/stage", () => {
    const { manifest, read } = build();
    const r = verifyPaidManifest(manifest, read, { statFile: () => ({ ...okStat }), executingUid: 1000, expectedSchemaVersion: 6, expectedCampaignId: "camp", expectedStageId: "stage" });
    expect(r.ok).toBe(true);
  });
  it("rejects a symlink / hardlink / wrong-owner / group-readable artifact", () => {
    const { manifest, read } = build();
    const only = (bad: any, victim: string) => verifyPaidManifest(manifest, read, { statFile: (f) => (f === victim ? bad : { ...okStat }), executingUid: 1000 });
    expect(only({ ...okStat, isSymbolicLink: true }, "runs/rec.json").reasons.some((r) => r.startsWith("record_not_regular_file"))).toBe(true);
    expect(only({ ...okStat, nlink: 2 }, "runs/rec.json").reasons.some((r) => r.startsWith("record_multiple_hardlinks"))).toBe(true);
    expect(only({ ...okStat, ownerUid: 0 }, "runs/rec.json").reasons.some((r) => r.startsWith("record_owner_mismatch"))).toBe(true);
    expect(only({ ...okStat, mode: 0o640 }, "runs/rec.json").reasons.some((r) => r.startsWith("record_mode_insecure"))).toBe(true);
  });
  it("rejects a wrong schema version / campaign / stage", () => {
    const { manifest, read } = build();
    expect(verifyPaidManifest(manifest, read, { expectedSchemaVersion: 999 }).reasons.some((r) => r.startsWith("manifest_schema_version"))).toBe(true);
    expect(verifyPaidManifest(manifest, read, { expectedCampaignId: "OTHER" }).reasons.some((r) => r.startsWith("manifest_campaign"))).toBe(true);
    expect(verifyPaidManifest(manifest, read, { expectedStageId: "OTHER" }).reasons.some((r) => r.startsWith("manifest_stage"))).toBe(true);
  });
});

describe("generationCost persistence failure is not a transport retry (F03)", () => {
  it("a persist (onPoll) failure on a settled 200 poll THROWS and does not re-fetch", async () => {
    let fetchCount = 0;
    const fetchFn: any = async () => {
      fetchCount++;
      return new Response(JSON.stringify({ data: { id: "g1", model: "m", provider_name: "P", total_cost: 0.01 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await expect(
      generationCost("g1", "sk", { fetchFn, sleep: async () => {}, onPoll: () => { throw new Error("disk full"); } }),
    ).rejects.toThrow(/disk full/);
    expect(fetchCount).toBe(1); // the failed persist did NOT trigger a re-fetch of the billed endpoint
  });
  it("a genuine transport error still records a transport-error poll and retries", async () => {
    let fetchCount = 0;
    const polls: any[] = [];
    const fetchFn: any = async () => {
      fetchCount++;
      if (fetchCount === 1) throw new Error("ECONNRESET");
      return new Response(JSON.stringify({ data: { id: "g1", model: "m", provider_name: "P", total_cost: 0.02 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const r = await generationCost("g1", "sk", { fetchFn, sleep: async () => {}, onPoll: (p) => polls.push(p) });
    expect(r.lookupOk).toBe(true);
    expect(fetchCount).toBe(2);
    expect(polls[0].kind).toBe("transport_error");
    expect(polls[1].kind).toBe("http_response");
  });
});

describe("copyPaidAnchorsIntoRoot TOCTOU digest check (F02/F04)", () => {
  it("throws when an anchor's on-disk bytes do not match the pinned expected digest", async () => {
    const root = freshRoot("copy-toctou");
    await mkdir(root, { recursive: true });
    await chmod(root, 0o700);
    const lock = acquireInvocationLock(root, { stageId: "s", invocationId: "s#copytoctou", startedAt: "2026-08-28T00:00:00Z" });
    try {
      expect(() =>
        copyPaidAnchorsIntoRoot(lock, root, {
          executionManifestPath: anchorPaths.executionManifestPath,
          executionSignaturePath: anchorPaths.executionSignaturePath,
          parentInputPaths: anchorPaths.parentInputPaths,
          expectedManifestSha256: "sha256:" + "0".repeat(64), // WRONG
          expectedSignatureSha256: null,
          parentExpectedSha256: [],
        }),
      ).toThrow(/TOCTOU/);
    } finally {
      const { releaseInvocationLock } = await import("../src/continuation/journal.js");
      releaseInvocationLock(lock);
    }
  });
});

describe("Paid Pass v3 artifact boundary", () => {
  const policyBytes = Buffer.from(policyBodyFor(HOSTED_PAID_PASS), "utf-8");
  const policySignatureBytes = Buffer.from("campaign-policy-signature", "utf-8");
  const policySha = "sha256:" + createHash("sha256").update(policyBytes).digest("hex");
  const policySignatureSha = "sha256:" + createHash("sha256").update(policySignatureBytes).digest("hex");
  const manifest: PaidExecutionManifest = {
    schemaVersion: 1,
    artifactType: PAID_ARTIFACT_TYPE,
    createdAtUtc: "2026-08-28T00:00:00Z",
    source: { commit: "a".repeat(40), tree: "b".repeat(40) },
    requiredSignerFingerprint: PAID_ARTIFACT_PINNED_SIGNER,
    allowedModes: [...ALL_PAID_MODES],
    launcher: "qualification-paid-launch.mjs",
    runner: "qualification-driver.mjs",
    verifier: "qualification-paid-verify.mjs",
    files: [
      { path: "qualification-paid-launch.mjs", sha256: launcherSha, bytes: 1, role: "launcher" },
      { path: "qualification-driver.mjs", sha256: runnerSha, bytes: 1, role: "runner" },
      { path: "qualification-paid-verify.mjs", sha256: "sha256:" + "3".repeat(64), bytes: 1, role: "verifier" },
    ],
  };
  const observation: PaidLaunchObservation = {
    artifactRoot: "/artifact",
    executionManifestPath: "/artifact/qualification-paid-execution-manifest.json",
    executionManifestSha256: "sha256:" + "4".repeat(64),
    executionSignaturePath: "/artifact/qualification-paid-execution-manifest.json.sig",
    executionSignatureSha256: "sha256:" + "5".repeat(64),
    launcherPath: "/artifact/qualification-paid-launch.mjs",
    launcherSha256: launcherSha,
    runnerPath: "/artifact/qualification-driver.mjs",
    runnerSha256: runnerSha,
    campaignPolicyPath: "/policy/hosted.json",
    campaignPolicySha256: policySha,
    campaignPolicySignaturePath: "/policy/hosted.json.sig",
    campaignPolicySignatureSha256: policySignatureSha,
    campaignPolicySignerFingerprint: PAID_CAMPAIGN_POLICY_SIGNER,
    processEntryPath: "/artifact/qualification-paid-launch.mjs",
    manifest,
  };
  const grant: PaidLaunchGrant = {
    schemaVersion: 2,
    artifactType: PAID_ARTIFACT_TYPE,
    artifactRoot: observation.artifactRoot,
    executionManifestPath: observation.executionManifestPath,
    executionManifestSha256: observation.executionManifestSha256,
    executionSignaturePath: observation.executionSignaturePath,
    executionSignatureSha256: observation.executionSignatureSha256,
    launcherPath: observation.launcherPath,
    launcherSha256: launcherSha,
    runnerPath: observation.runnerPath,
    runnerSha256: runnerSha,
    signerFingerprint: PAID_ARTIFACT_PINNED_SIGNER,
    campaignPolicyPath: observation.campaignPolicyPath,
    campaignPolicySha256: policySha,
    campaignPolicyBase64: policyBytes.toString("base64"),
    campaignPolicySignaturePath: observation.campaignPolicySignaturePath,
    campaignPolicySignatureSha256: policySignatureSha,
    campaignPolicySignatureBase64: policySignatureBytes.toString("base64"),
    campaignPolicySignerFingerprint: PAID_CAMPAIGN_POLICY_SIGNER,
    mode: "diagnostic-hosted-paid-r1",
    nonce: "6".repeat(64),
    verifiedAtUtc: "2026-08-28T00:00:00Z",
  };

  it("binds the grant to the externally verified launcher, runner and manifest", () => {
    expect(verifyPaidLaunchGrant(grant, observation).ok).toBe(true);
  });

  it("rejects a forged field, direct process entry, signer drift and runner drift", () => {
    expect(verifyPaidLaunchGrant({ ...grant, extra: true } as any, observation).reasons).toContain("launch_grant_shape");
    expect(verifyPaidLaunchGrant(grant, { ...observation, processEntryPath: observation.runnerPath }).reasons).toContain("launch_process_entry_not_launcher");
    expect(verifyPaidLaunchGrant({ ...grant, signerFingerprint: "7E622B43290C285E" }, observation).reasons).toContain("launch_grant_signer");
    expect(verifyPaidLaunchGrant({ ...grant, campaignPolicyBase64: Buffer.from("tampered").toString("base64") }, observation).reasons).toContain("campaign_policy_digest");
    expect(verifyPaidLaunchGrant({ ...grant, campaignPolicySignatureBase64: `${grant.campaignPolicySignatureBase64}==` }, observation).reasons).toContain("campaign_policy_signature_base64");
    expect(verifyPaidLaunchGrant(grant, { ...observation, runnerSha256: "sha256:" + "0".repeat(64) }).ok).toBe(false);
  });

  it("the dependency-free launcher verifies the exact package before importing the bundle", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "plinius-paid-package-")));
    await chmod(root, 0o700);
    try {
      const entries = [
        ["qualification-paid-launch.mjs", "launcher", "launcher-bytes"],
        ["qualification-driver.mjs", "runner", 'export const marker = "verified"; export async function paidArtifactMain() {}'],
        ["qualification-paid-verify.mjs", "verifier", "verifier-bytes"],
      ] as const;
      const files = [];
      for (const [path, role, body] of entries) {
        await writeFile(join(root, path), body, { mode: 0o600 });
        files.push({ path, role, bytes: Buffer.byteLength(body), sha256: "sha256:" + createHash("sha256").update(body).digest("hex") });
      }
      const packageManifest = { ...manifest, files };
      await writeFile(join(root, "qualification-paid-execution-manifest.json"), JSON.stringify(packageManifest), { mode: 0o600 });
      await writeFile(join(root, "qualification-paid-execution-manifest.json.sig"), "signature", { mode: 0o600 });
      const verified = verifyExecutionPackage(root, { verifySignature: () => PAID_ARTIFACT_PINNED_SIGNER });
      expect(verified.manifest.files).toHaveLength(3);
      await writeFile(join(root, "qualification-paid-execution-manifest.json"), JSON.stringify({ ...packageManifest, allowedModes: ALL_PAID_MODES.slice(0, 2) }), { mode: 0o600 });
      expect(() => verifyExecutionPackage(root, { verifySignature: () => PAID_ARTIFACT_PINNED_SIGNER })).toThrow(/modes mismatch/);
      await writeFile(join(root, "qualification-paid-execution-manifest.json"), JSON.stringify(packageManifest), { mode: 0o600 });
      const policyPath = join(anchorDir, "launcher-hosted-policy.json");
      const policySignaturePath = `${policyPath}.sig`;
      await writeFile(policyPath, policyBytes, { mode: 0o600 });
      await writeFile(policySignaturePath, policySignatureBytes, { mode: 0o600 });
      const verifiedPolicy = verifyCampaignPolicy(policyPath, policySignaturePath, "diagnostic-hosted-paid-r1", { verifySignature: () => PAID_CAMPAIGN_POLICY_SIGNER, now: () => new Date("2026-08-29T00:00:00Z") });
      const launchGrant = createLaunchGrant(verified, "diagnostic-hosted-paid-r1", verifiedPolicy);
      await writeFile(join(root, "qualification-driver.mjs"), 'export const marker = "tampered";', { mode: 0o600 });
      const loaded = await loadVerifiedRunner(verified, launchGrant);
      expect(loaded.marker).toBe("verified");
      expect(() => verifyExecutionPackage(root, { verifySignature: () => PAID_ARTIFACT_PINNED_SIGNER })).toThrow(/digest mismatch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a wrong policy signer, an expired policy, and symlinked policy inputs", async () => {
    const policyPath = join(anchorDir, "launcher-policy-adversarial.json");
    const signaturePath = `${policyPath}.sig`;
    await writeFile(policyPath, policyBytes, { mode: 0o600 });
    await writeFile(signaturePath, policySignatureBytes, { mode: 0o600 });
    expect(() => verifyCampaignPolicy(policyPath, signaturePath, "diagnostic-hosted-paid-r1", {
      verifySignature: () => "0".repeat(40),
      now: () => new Date("2026-08-29T00:00:00Z"),
    })).toThrow(/signature signer mismatch/);
    expect(() => verifyCampaignPolicy(policyPath, signaturePath, "diagnostic-hosted-paid-r1", {
      verifySignature: () => PAID_CAMPAIGN_POLICY_SIGNER,
      now: () => new Date("2026-09-04T00:00:00Z"),
    })).toThrow(/time window invalid/);

    const policyLink = join(anchorDir, "launcher-policy-link.json");
    const signatureLink = join(anchorDir, "launcher-policy-link.json.sig");
    await symlink(policyPath, policyLink);
    await symlink(signaturePath, signatureLink);
    expect(() => verifyCampaignPolicy(policyLink, signaturePath, "diagnostic-hosted-paid-r1", {
      verifySignature: () => PAID_CAMPAIGN_POLICY_SIGNER,
      now: () => new Date("2026-08-29T00:00:00Z"),
    })).toThrow(/insecure artifact type|canonical non-symlink/);
    expect(() => verifyCampaignPolicy(policyPath, signatureLink, "diagnostic-hosted-paid-r1", {
      verifySignature: () => PAID_CAMPAIGN_POLICY_SIGNER,
      now: () => new Date("2026-08-29T00:00:00Z"),
    })).toThrow(/insecure artifact type|canonical non-symlink/);
  });
});

// --- 5. dispatch wire: paid carries routing, non-paid unchanged --------------

describe("dispatch adapter provider routing in the wire", () => {
  const target = HOSTED_PAID_TARGETS[0];
  const routing = buildProviderRouting(target);
  it("serializes exact provider routing into the wire for a paid request", async () => {
    const { fn, calls } = mockFetch(target.slug);
    const facts = await dispatchViaBackend({ backendId: "openrouter", baseUrl: OR_BASE, apiKey: validOpenRouterKey(), requirePaidCredential: true, timeoutMs: 5000, isHosted: true, req: { model: target.slug, maxTokens: 1024, temperature: null, topP: null, seed: 1, providerRouting: routing }, messages: [{ role: "user", content: "hi" }], fetchFn: fn });
    expect((calls[0].body as Record<string, unknown>).provider).toEqual(serializeProviderRouting(routing));
    expect(providerRoutingEqual(facts.requestSent.providerRouting!, routing)).toBe(true);
  });
  it("forwards the validated credential as an Authorization bearer header", async () => {
    const key = validOpenRouterKey();
    const { fn, calls } = mockFetch(target.slug);
    await dispatchViaBackend({ backendId: "openrouter", baseUrl: OR_BASE, apiKey: key, requirePaidCredential: true, timeoutMs: 5000, isHosted: true, req: { model: target.slug, maxTokens: 1024, temperature: null, topP: null, seed: 1, providerRouting: routing }, messages: [{ role: "user", content: "hi" }], fetchFn: fn });
    expect(calls[0].headers.authorization).toBe(`Bearer ${key}`);
  });
  it("REGRESSION: a non-paid request carries no provider field", async () => {
    const { fn, calls } = mockFetch(target.slug);
    const facts = await dispatchViaBackend({ backendId: "openrouter", baseUrl: OR_BASE, apiKey: validOpenRouterKey(), timeoutMs: 5000, isHosted: true, req: { model: target.slug, maxTokens: 1024, temperature: 0, topP: 1, seed: 1 }, messages: [{ role: "user", content: "hi" }], fetchFn: fn });
    expect((calls[0].body as Record<string, unknown>).provider).toBeUndefined();
    expect(facts.requestSent.providerRouting).toBeUndefined();
  });
  it("rejects a dotenv assignment at the dispatch boundary without calling fetch", async () => {
    const { fn, calls } = mockFetch(target.slug);
    await expect(dispatchViaBackend({ backendId: "openrouter", baseUrl: OR_BASE, apiKey: `OPENROUTER_API_KEY=${validOpenRouterKey()}`, requirePaidCredential: true, timeoutMs: 5000, isHosted: true, req: { model: target.slug, maxTokens: 1024, temperature: null, topP: null, seed: 1, providerRouting: routing }, messages: [{ role: "user", content: "hi" }], fetchFn: fn })).rejects.toThrow(/one key only/);
    expect(calls).toHaveLength(0);
  });

  it("captures the response stream once without clone/tee", async () => {
    const target = HOSTED_PAID_TARGETS[0];
    const response = new Response(JSON.stringify({
      id: "gen-once",
      model: target.responseModelId,
      provider: target.providerDisplay,
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: {},
    }), { status: 200 });
    Object.defineProperty(response, "clone", { value: () => { throw new Error("clone must not be called"); } });
    let fetches = 0;
    const events: any[] = [];
    const facts = await dispatchViaBackend({
      backendId: "openrouter", baseUrl: OR_BASE, apiKey: validOpenRouterKey(), requirePaidCredential: true,
      timeoutMs: 1000, isHosted: true,
      req: { model: target.slug, maxTokens: 1024, temperature: null, topP: null, seed: 1, providerRouting: buildProviderRouting(target) },
      messages: [{ role: "user", content: "hi" }],
      fetchFn: async () => { fetches++; return response; },
      onWire: (event) => events.push(event),
    });
    expect(fetches).toBe(1);
    expect(facts.transportError).toBeNull();
    expect(events.find((event) => event.stage === "response")).toMatchObject({ httpStatus: 200, bodyReadError: null });
    expect(events.find((event) => event.stage === "response").preimage).not.toBeNull();
  });

  it("persists a body-read timeout reason after HTTP headers arrive", async () => {
    const target = CANDIDATE_PAID_TARGETS[1];
    const events: any[] = [];
    let bodyReads = 0;
    let cloneCalls = 0;
    const fetchFn: FetchFn = async (_url, init) => ({
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      clone: () => { cloneCalls++; throw new Error("clone must not be called"); },
      arrayBuffer: () => {
        bodyReads++;
        return new Promise<ArrayBuffer>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    } as unknown as Response);
    const facts = await dispatchViaBackend({
      backendId: "openrouter", baseUrl: OR_BASE, apiKey: validOpenRouterKey(), requirePaidCredential: true,
      timeoutMs: 10, isHosted: true,
      req: { model: target.slug, maxTokens: 1024, temperature: null, topP: null, seed: null, providerRouting: buildProviderRouting(target) },
      messages: [{ role: "user", content: "hi" }], fetchFn,
      onWire: (event) => events.push(event),
    });
    expect(bodyReads).toBe(1);
    expect(cloneCalls).toBe(0);
    expect(facts.transportError?.kind).toBe("timeout");
    expect(events.find((event) => event.stage === "response")).toEqual({
      stage: "response",
      url: CHAT_URL,
      method: "POST",
      httpStatus: 200,
      preimage: null,
      bodyReadError: { kind: "timeout", message: "response body read timed out after 10ms", timeoutMs: 10 },
    });
  });

  it("uses a bounded twenty-minute timeout for slow paid reasoning", () => {
    expect(PAID_TIMEOUT_MS).toBe(1_200_000);
  });
});

// --- 6. credential ordering --------------------------------------------------

describe("credential ordering — key read last, gates required", () => {
  it("reads the key only after every gate passes", async () => {
    const key = validOpenRouterKey();
    const { deps, reads } = bootDeps("diagnostic-hosted-paid-r1", { CONTINUATION_OUTPUT_ROOT: "/x", OPENROUTER_API_KEY: key });
    const boot = await preparePaidBootstrap(deps as any);
    expect(boot.orKey).toBe(key);
    expect(reads.indexOf("OPENROUTER_API_KEY")).toBeGreaterThan(reads.indexOf("CONTINUATION_OUTPUT_ROOT"));
  });
  it("rejects assignment-file, whitespace, and malformed credentials before dispatch", async () => {
    const key = validOpenRouterKey();
    for (const value of [`OPENROUTER_API_KEY=${key}`, `${key}\n`, ` ${key}`, "sk-or-secret"]) {
      expect(() => validatePaidOpenRouterCredential(value)).toThrow(/one key only/);
      const { deps } = bootDeps("diagnostic-hosted-paid-r1", { CONTINUATION_OUTPUT_ROOT: "/x", OPENROUTER_API_KEY: value });
      await expect(preparePaidBootstrap(deps as any)).rejects.toThrow(/one key only/);
    }
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
      { verifyExecution: () => ({ ok: false, reasons: ["artifact_mismatch"] }) },
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

  it("copies + digest-verifies the anchors BEFORE the credential read — a TOCTOU throws with the key unread (F04)", async () => {
    const root = freshRoot("boot-copy-before-key");
    await mkdir(root, { recursive: true });
    await chmod(root, 0o700);
    const attManifestSha = await fileSha(anchorPaths.executionManifestPath);
    const attSignatureSha = await fileSha(anchorPaths.executionSignaturePath);
    const { deps, reads } = bootDeps("diagnostic-hosted-paid-r1", { CONTINUATION_OUTPUT_ROOT: root, OPENROUTER_API_KEY: "sk-secret" }, {
      // A real lock so the bootstrap actually finalizes + copies into the root.
      acquireLock: () => acquireInvocationLock(root, { stageId: "s", invocationId: "s#bootcopy", startedAt: "2026-08-28T00:00:00Z" }),
      finalizeCatalogArtifact: (l: any, r: string, body: string) => finalizeArtifact(r, `paid-catalog-preflight-${sha256Hex(body)}.json`, body, l),
      verifyExecution: () => ({ ok: true, reasons: [], attestation: { manifestSha256: attManifestSha, signatureSha256: attSignatureSha } }),
      // Anchor inputs + a WRONG pinned parent digest → the copy TOCTOU fires before the key.
      executionManifestPath: anchorPaths.executionManifestPath,
      executionSignaturePath: anchorPaths.executionSignaturePath,
      parentInputPaths: anchorPaths.parentInputPaths,
      parentInputExpectedSha256: ["sha256:" + "0".repeat(64), "sha256:" + "0".repeat(64), "sha256:" + "0".repeat(64)],
    });
    await expect(preparePaidBootstrap(deps as any)).rejects.toThrow(/TOCTOU/);
    expect(reads).not.toContain("OPENROUTER_API_KEY"); // key never read — copy/verify is before it
  });
});

// --- 7. orchestrator ---------------------------------------------------------

describe("runPaidPass orchestration", () => {
  it("accepts policy-pinned base responses with versioned lookup identities end-to-end", async () => {
    const root = freshRoot("hosted-split-provenance");
    const cells = buildHostedPaidCells(HOSTED_PAID_TARGETS);
    const result = await runPaidPass(await setupPaidRun(HOSTED_PAID_PASS, cells, root, withWire((_cell: any, plan: any) => factsFor(plan, { ok: true, costUsd: 0.01 }))));
    expect(result.stopped).toBeNull();
    expect(result.dispatchedRunIds).toHaveLength(15);
    expect(result.passed).toBe(15);
    const independent = verifyPaidEvidence(root, {
      verifySignature: () => PAID_ARTIFACT_PINNED_SIGNER,
      parentDigests: await Promise.all(anchorPaths.parentInputPaths.map(fileSha)),
    });
    expect(independent.ok, independent.reasons.join("\n")).toBe(true);
  }, 20_000);

  it("runs a signed-policy broad layout and passes independent Evidence verification", async () => {
    const pass = broadPass(2);
    const cells = buildPerModelPaidCells(pass.targets);
    const root = freshRoot("broad-happy");
    const result = await runPaidPass(await setupPaidRun(pass, cells, root, withWire((_cell: any, plan: any) => factsFor(plan, { ok: true, costUsd: 0.01 }))));
    expect(result.stopped).toBeNull();
    expect(result.dispatchedRunIds).toHaveLength(8);
    expect(result.passed).toBe(8);
    const independent = verifyPaidEvidence(root, {
      verifySignature: () => PAID_ARTIFACT_PINNED_SIGNER,
      parentDigests: await Promise.all(anchorPaths.parentInputPaths.map(fileSha)),
    });
    expect(independent.ok, independent.reasons.join("\n")).toBe(true);
  }, 20_000);

  it("rejects response/lookup identities swapped on the durable wire", async () => {
    const root = freshRoot("hosted-swapped-provenance");
    const cells = buildHostedPaidCells(HOSTED_PAID_TARGETS);
    const result = await runPaidPass(await setupPaidRun(HOSTED_PAID_PASS, cells, root, withWire((_cell: any, plan: any) => factsFor(plan, {
      ok: true,
      costUsd: 0.01,
      responseModel: plan.target.lookupModelId,
      lookupModel: plan.target.responseModelId,
    }))));
    expect(result.stopped).toMatch(/request_wire_mismatch/);
    expect(result.dispatchedRunIds).toHaveLength(1);
    expect(result.passed).toBe(0);
    const files = await readdir(join(root, "runs"));
    const recordName = files.find((file) => file.endsWith(".json") && !file.startsWith("paid-") && !file.includes("intent"));
    const record = JSON.parse(await readFile(join(root, "runs", recordName!), "utf-8"));
    expect(record.paidVerdict.validationReasons.some((reason: string) => reason.startsWith("response_model_mismatch"))).toBe(true);
    expect(record.paidVerdict.validationReasons.some((reason: string) => reason.startsWith("lookup_model_mismatch"))).toBe(true);
  });

  it("candidate per-model sentinel failure skips only that model's remaining 3 cells", async () => {
    const failModel = "moonshotai/kimi-k3";
    const cells = buildCandidatePaidCells(CANDIDATE_PAID_TARGETS);
    const result = await runPaidPass(await setupPaidRun(CANDIDATE_PAID_PASS, cells, freshRoot("cand-sentinel"), withWire((cell: any, plan: any) => factsFor(plan, { ok: !(cell.target === failModel && cell.sentinel), costUsd: 0.01 }))));
    expect(result.stopped).toBeNull();
    expect(result.dispatchedRunIds.length).toBe(13);
    expect(result.skippedRunIds.length).toBe(3);
    expect(result.skippedGroups).toEqual([failModel]);
    expect(result.manifestFile).toMatch(/paid-pass-manifest-[0-9a-f]{64}\.json$/);
  });

  it("hosted global sentinel failure stops the pass after saving the billed sentinel", async () => {
    const cells = buildHostedPaidCells(HOSTED_PAID_TARGETS);
    const result = await runPaidPass(await setupPaidRun(HOSTED_PAID_PASS, cells, freshRoot("hosted-sentinel"), withWire((cell: any, plan: any) => factsFor(plan, { ok: !cell.sentinel, costUsd: 0.01 }))));
    expect(result.stopped).toMatch(/campaign_sentinel_not_accepted/);
    expect(result.dispatchedRunIds.length).toBe(1);
  });

  it("blocks a WRONG response provider (Azure on a pinned route) after saving the RAW observation", async () => {
    const root = freshRoot("provider-tamper");
    const cells = buildHostedPaidCells(HOSTED_PAID_TARGETS);
    const result = await runPaidPass(await setupPaidRun(HOSTED_PAID_PASS, cells, root, withWire((cell: any, plan: any) => factsFor(plan, { ok: true, costUsd: 0.01, display: "Azure" }))));
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
    const cells = buildHostedPaidCells(HOSTED_PAID_TARGETS);
    // The sink persists a BAD dispatch (wrong provider + content_filter + unknown cost);
    // generate then RETURNS a benign, fully-qualified facts object. The verdict must
    // reflect the SUNK wire read back from disk, never the returned object.
    const result = await runPaidPass(
      await setupPaidRun(
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

  it("ADVERSARIAL: an HTTP 500 response + attacker cost URL sunk to disk still fail (F02/F03)", async () => {
    const root = freshRoot("adv-500-costurl");
    const cells = buildHostedPaidCells(HOSTED_PAID_TARGETS);
    const result = await runPaidPass(
      await setupPaidRun(HOSTED_PAID_PASS, cells, root, withWire((_c: any, plan: any) => {
        // A success-SHAPED body, but the response was HTTP 500 and the cost poll targets
        // an attacker host for the same generation id.
        const f = factsFor(plan, { ok: true, costUsd: 0.01, costUrl: "https://evil.example/generation?id=gen-x" });
        f.wire.response.httpStatus = 500;
        return f;
      })),
    );
    expect(result.stopped).not.toBeNull();
    expect(result.passed).toBe(0);
    const files = await readdir(join(root, "runs"));
    const recName = files.find((f) => f.endsWith(".json") && !f.startsWith("paid-") && !f.includes("intent"));
    const rec = JSON.parse(await readFile(join(root, "runs", recName!), "utf-8"));
    expect(rec.status.qualification).toBe("fail");
    expect(rec.paidVerdict.validationReasons.some((r: string) => r.startsWith("response_http_status"))).toBe(true);
    expect(rec.paidVerdict.validationReasons.some((r: string) => r.startsWith("cost_poll_url_mismatch"))).toBe(true);
  });

  it("rejects a DUPLICATE wire stage event — no silent overwrite (F05)", async () => {
    const root = freshRoot("dup-stage");
    const cells = buildHostedPaidCells(HOSTED_PAID_TARGETS);
    const result = await runPaidPass(
      await setupPaidRun(HOSTED_PAID_PASS, cells, root, async (_c: any, plan: any, _r: any, onWire: any) => {
        const f = factsFor(plan, { ok: true, costUsd: 0.01 });
        onWire({ stage: "request", url: f.wire.request.url, method: "POST", preimage: f.wire.request.body });
        onWire({ stage: "request", url: f.wire.request.url, method: "POST", preimage: f.wire.request.body }); // duplicate — must throw
        return f;
      }),
    );
    expect(result.stopped).toMatch(/dispatch_exception/);
  });

  it("SEAL cross-check: a sealed parent envelope whose inner digest differs from the pinned value is rejected (F03)", async () => {
    const root = freshRoot("toctou-parent");
    const opts = await setupPaidRun(HOSTED_PAID_PASS, buildHostedPaidCells(HOSTED_PAID_TARGETS), root, withWire((_c: any, plan: any) => factsFor(plan, { costUsd: 0.01 })));
    // The anchors were already copied correctly; corrupt the EXPECTED digest so the
    // post-transfer cross-check (step J) no longer matches the sealed envelope.
    opts.parentInputExpectedSha256 = [opts.parentInputExpectedSha256[0], "sha256:" + "f".repeat(64), opts.parentInputExpectedSha256[2]];
    await expect(runPaidPass(opts)).rejects.toThrow(/cross-check failed/);
    expect((await readdir(root)).some((file) => file.startsWith("paid-pass-manifest-"))).toBe(false);
  });

  it("stops (and saves the raw observation) when the actual cost exceeds the per-run cap", async () => {
    const root = freshRoot("cost-overcap");
    const cells = buildHostedPaidCells(HOSTED_PAID_TARGETS);
    const result = await runPaidPass(await setupPaidRun(HOSTED_PAID_PASS, cells, root, withWire((cell: any, plan: any) => factsFor(plan, { ok: true, costUsd: 4.99 }))));
    expect(result.stopped).toMatch(/actual_cost_rejected.*per_run_cap_exceeded_actual/);
    expect(result.dispatchedRunIds.length).toBe(1);
    // the truthful spend records the billed cost even though it tripped the cap
    expect(result.spentUsd).toBeCloseTo(4.99, 6);
    const files = await readdir(join(root, "runs"));
    expect(files.some((f) => f.endsWith(".json") && !f.startsWith("paid-") && !f.includes("intent"))).toBe(true); // final record
    expect(files.some((f) => f.startsWith("paid-rawobs-"))).toBe(true);
  });

  it("stops (and saves the raw observation) when the actual cost is unknown (never 0-fill)", async () => {
    const cells = buildHostedPaidCells(HOSTED_PAID_TARGETS);
    const result = await runPaidPass(await setupPaidRun(HOSTED_PAID_PASS, cells, freshRoot("cost-unknown"), withWire((cell: any, plan: any) => factsFor(plan, { ok: true, costUsd: null }))));
    expect(result.stopped).toMatch(/actual_cost_rejected.*cost_unknown_or_not_finite/);
    expect(result.spentUsd).toBe(0);
    expect(result.costCoverage).toEqual({
      settledRunIds: [],
      unknownCostRunIds: [result.dispatchedRunIds[0]],
      invalidCostRunIds: [],
      settledTotalUsd: 0,
      complete: false,
    });
    expect(result.dispatchedRunIds.length).toBe(1);
  });

  it("binds a response-body timeout into raw Evidence and the failed record", async () => {
    const root = freshRoot("response-body-timeout");
    const cells = buildCandidatePaidCells(CANDIDATE_PAID_TARGETS);
    const result = await runPaidPass(await setupPaidRun(CANDIDATE_PAID_PASS, cells, root, async (_cell: any, plan: any, _req: any, onWire: any) => {
      const facts = factsFor(plan, { ok: true, costUsd: 0.01 });
      onWire({ stage: "request", url: facts.wire.request.url, method: "POST", preimage: facts.wire.request.body });
      onWire({
        stage: "response", url: facts.wire.request.url, method: "POST", httpStatus: 200, preimage: null,
        bodyReadError: { kind: "timeout", message: "response body read timed out after 1200000ms", timeoutMs: 1_200_000 },
      });
      return { ...facts, latencyMs: 1_200_001 };
    }));
    expect(result.stopped).toMatch(/response_body_timeout/);
    expect(result.costCoverage.unknownCostRunIds).toEqual(result.dispatchedRunIds);
    const files = await readdir(join(root, "runs"));
    const rawName = files.find((file) => file.startsWith("paid-rawobs-"));
    const recordName = files.find((file) => file.endsWith(".json") && !file.startsWith("paid-") && !file.includes("intent"));
    const raw = JSON.parse(await readFile(join(root, "runs", rawName!), "utf-8"));
    const record = JSON.parse(await readFile(join(root, "runs", recordName!), "utf-8"));
    expect(raw.responseBody).toBeNull();
    expect(raw.responseBodyError).toEqual({ kind: "timeout", message: "response body read timed out after 1200000ms", timeoutMs: 1_200_000 });
    expect(record.error).toEqual({ kind: "timeout", message: "response body read timed out after 1200000ms" });
    const independent = verifyPaidEvidence(root, {
      verifySignature: () => PAID_ARTIFACT_PINNED_SIGNER,
      parentDigests: await Promise.all(anchorPaths.parentInputPaths.map(fileSha)),
    });
    expect(independent.ok, independent.reasons.join("\n")).toBe(true);
  });

  it("independent verifier rejects malformed response-body error Evidence", async () => {
    const root = freshRoot("response-body-error-malformed");
    const cells = buildCandidatePaidCells(CANDIDATE_PAID_TARGETS);
    await runPaidPass(await setupPaidRun(CANDIDATE_PAID_PASS, cells, root, async (_cell: any, plan: any, _req: any, onWire: any) => {
      const facts = factsFor(plan, { ok: true, costUsd: 0.01 });
      onWire({ stage: "request", url: facts.wire.request.url, method: "POST", preimage: facts.wire.request.body });
      onWire({ stage: "response", url: facts.wire.request.url, method: "POST", httpStatus: 200, preimage: null, bodyReadError: { kind: "timeout", message: "bad\nmessage", timeoutMs: 0 } });
      return facts;
    }));
    const independent = verifyPaidEvidence(root, {
      verifySignature: () => PAID_ARTIFACT_PINNED_SIGNER,
      parentDigests: await Promise.all(anchorPaths.parentInputPaths.map(fileSha)),
    });
    expect(independent.ok).toBe(false);
    expect(independent.reasons.some((reason) => reason.startsWith("response_body_error_shape:"))).toBe(true);
  });

  it("on a generate() throw, saves TERMINAL record + wire fragments and stops (no billed wire lost)", async () => {
    const root = freshRoot("dispatch-throw");
    const cells = buildHostedPaidCells(HOSTED_PAID_TARGETS);
    const result = await runPaidPass(
      await setupPaidRun(HOSTED_PAID_PASS, cells, root, throwAfterWire((_cell: any, plan: any) => factsFor(plan, { ok: true, costUsd: 0.01 }), "boom after provider call")),
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
    const cells = buildCandidatePaidCells(CANDIDATE_PAID_TARGETS);
    const result = await runPaidPass(await setupPaidRun(CANDIDATE_PAID_PASS, cells, root, withWire((cell: any, plan: any) => factsFor(plan, { ok: true, costUsd: 0.02 }))));
    expect(result.stopped).toBeNull();
    expect(result.dispatchedRunIds.length).toBe(16);
    expect(result.costCoverage.complete).toBe(true);
    expect(result.costCoverage.settledRunIds).toEqual(result.dispatchedRunIds);
    expect(result.costCoverage.unknownCostRunIds).toEqual([]);
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
    const originalManifestBody = await readFile(join(root, manifestName!), "utf-8");
    const manifest = JSON.parse(originalManifestBody);
    expect(manifest.manifestSchemaVersion).toBe(7);
    expect(manifest.records.length).toBe(16);
    expect(manifest.rawObservations.length).toBe(16);
    expect(manifest.wires.length).toBe(48);
    expect(manifest.executionManifest).toBeTruthy();
    expect(manifest.executionSignature).toBeTruthy();
    expect(manifest.executionAttestation).toBeTruthy();
    expect(manifest.campaignPolicy).toBeTruthy();
    expect(manifest.campaignPolicySignature).toBeTruthy();
    expect(manifest.catalogArtifact).toBeTruthy();
    expect(manifest.summary.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    const parentDigests = await Promise.all(anchorPaths.parentInputPaths.map(fileSha));
    const independent = verifyPaidEvidence(root, {
      verifySignature: () => PAID_ARTIFACT_PINNED_SIGNER,
      parentDigests,
    });
    expect(independent.ok, independent.reasons.join("\n")).toBe(true);
    const rootLink = freshRoot("cand-happy-link");
    await symlink(root, rootLink, "dir");
    const linkedRoot = verifyPaidEvidence(rootLink, {
      verifySignature: () => PAID_ARTIFACT_PINNED_SIGNER,
      parentDigests,
    });
    expect(linkedRoot.ok).toBe(false);
    expect(linkedRoot.reasons).toContain("root_canonical");
    await rm(rootLink, { force: true });

    // Rebuild the catalog artifact and final manifest with an over-ceiling raw
    // endpoint price. Digest and file-set integrity remain internally consistent;
    // only an independent raw-catalog policy check can reject it.
    const originalCatalogRef = { ...manifest.catalogArtifact };
    const originalCatalogBody = await readFile(join(root, originalCatalogRef.file), "utf-8");
    const hostileCatalog = JSON.parse(originalCatalogBody);
    const catalogVictim = CANDIDATE_PAID_TARGETS[0];
    const endpointEvidence = hostileCatalog.catalogEvidence.find((entry: any) => entry.endpoint === `${OR_BASE}/models/${catalogVictim.slug}/endpoints`);
    const endpointPayload = JSON.parse(Buffer.from(endpointEvidence.rawBodyBase64, "base64").toString("utf-8"));
    endpointPayload.data.endpoints[0].pricing.prompt = 1;
    const hostileEndpointRaw = Buffer.from(JSON.stringify(endpointPayload), "utf-8");
    endpointEvidence.rawBodyBase64 = hostileEndpointRaw.toString("base64");
    endpointEvidence.rawBodySha256 = "sha256:" + createHash("sha256").update(hostileEndpointRaw).digest("hex");
    endpointEvidence.byteLength = hostileEndpointRaw.length;
    const hostileCatalogBody = JSON.stringify(hostileCatalog);
    const hostileCatalogSha = sha256Hex(hostileCatalogBody);
    const hostileCatalogFile = originalCatalogRef.file.replace(/[0-9a-f]{64}\.json$/, `${hostileCatalogSha}.json`);
    await writeFile(join(root, hostileCatalogFile), hostileCatalogBody, { mode: 0o600 });
    await rm(join(root, originalCatalogRef.file));
    manifest.catalogArtifact = { file: hostileCatalogFile, sha256: `sha256:${hostileCatalogSha}`, bytes: Buffer.byteLength(hostileCatalogBody) };
    await rm(join(root, manifestName!));
    const hostileManifestBody = JSON.stringify(manifest, null, 2);
    const hostileManifestFile = `paid-pass-manifest-${sha256Hex(hostileManifestBody)}.json`;
    await writeFile(join(root, hostileManifestFile), hostileManifestBody, { mode: 0o600 });
    const hostileCatalogResult = verifyPaidEvidence(root, {
      manifestFile: hostileManifestFile,
      verifySignature: () => PAID_ARTIFACT_PINNED_SIGNER,
      parentDigests,
    });
    expect(hostileCatalogResult.ok).toBe(false);
    expect(hostileCatalogResult.reasons).toContain(`catalog_price:${catalogVictim.slug}`);

    // Restore the valid catalog/manifest before exercising a different semantic
    // tamper below.
    await rm(join(root, hostileCatalogFile));
    await rm(join(root, hostileManifestFile));
    await writeFile(join(root, originalCatalogRef.file), originalCatalogBody, { mode: 0o600 });
    manifest.catalogArtifact = originalCatalogRef;
    await writeFile(join(root, manifestName!), originalManifestBody, { mode: 0o600 });

    // ADVERSARIAL: rebuild every affected digest and the final manifest after changing
    // one raw observation. Content-address checks all pass, but the independent
    // verifier must still reject the semantic mismatch against the durable request
    // fragment. This proves it does not trust either the driver's verdict or refs.
    const victimRawRef = manifest.rawObservations[0];
    const victimRunId = victimRawRef.runId;
    const victimRaw = JSON.parse(await readFile(join(root, victimRawRef.file), "utf-8"));
    victimRaw.requestUrl = "https://evil.example/chat/completions";
    const rebuiltRawBody = JSON.stringify(victimRaw, null, 2);
    const rebuiltRawSha = sha256Hex(rebuiltRawBody);
    const rebuiltRawFile = victimRawRef.file.replace(/[0-9a-f]{64}\.json$/, `${rebuiltRawSha}.json`);
    await writeFile(join(root, rebuiltRawFile), rebuiltRawBody, { mode: 0o600 });
    await rm(join(root, victimRawRef.file));
    const rebuiltRawRef = { ...victimRawRef, file: rebuiltRawFile, sha256: `sha256:${rebuiltRawSha}`, bytes: Buffer.byteLength(rebuiltRawBody) };
    manifest.rawObservations[0] = rebuiltRawRef;

    const victimRecordRef = manifest.records.find((ref: any) => ref.runId === victimRunId);
    const victimRecord = JSON.parse(await readFile(join(root, victimRecordRef.file), "utf-8"));
    victimRecord.rawObservationRef = { file: rebuiltRawRef.file, sha256: rebuiltRawRef.sha256, bytes: rebuiltRawRef.bytes };
    const rebuiltRecordBody = JSON.stringify(victimRecord, null, 2);
    await writeFile(join(root, victimRecordRef.file), rebuiltRecordBody, { mode: 0o600 });
    victimRecordRef.sha256 = `sha256:${sha256Hex(rebuiltRecordBody)}`;
    victimRecordRef.bytes = Buffer.byteLength(rebuiltRecordBody);

    await rm(join(root, manifestName!));
    const rebuiltManifestBody = JSON.stringify(manifest, null, 2);
    const rebuiltManifestFile = `paid-pass-manifest-${sha256Hex(rebuiltManifestBody)}.json`;
    await writeFile(join(root, rebuiltManifestFile), rebuiltManifestBody, { mode: 0o600 });
    const adversarial = verifyPaidEvidence(root, {
      manifestFile: rebuiltManifestFile,
      verifySignature: () => PAID_ARTIFACT_PINNED_SIGNER,
      parentDigests,
    });
    expect(adversarial.ok).toBe(false);
    expect(adversarial.reasons).toContain(`raw_request_fragment:${victimRunId}`);
  }, 20_000);
});
