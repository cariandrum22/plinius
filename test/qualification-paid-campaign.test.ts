/**
 * Partitioned hosted paid passes — production-path tests (Paid Pass r2).
 *
 * Every scenario drives the real production code (the pure paid-campaign module,
 * the driver's dispatch adapter, the credential-ordering bootstrap with its
 * required gates, and the paid orchestrator with hardened-journal persistence and
 * full request/response re-derivation). No network, no credential, no generation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
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
  estimateCellCeilingUsd,
  checkBudgetBeforeDispatch,
  OIDC_BENCHMARK_ID,
} from "../src/qualification/paid-campaign.js";
import type { CatalogModelInfo, PaidTarget, ProviderRouting, ObservedDispatch, ExpectedDispatch } from "../src/qualification/paid-campaign.js";

import { dispatchViaBackend, preparePaidBootstrap, runPaidPass, paidPlanCell, verifyPaidCatalog, resolveDriverMode } from "../qualification-driver.mjs";
import type { PaidCellPlan } from "../qualification-driver.mjs";
import type { FetchFn } from "../src/backends/openai-compatible.js";

const OR_BASE = "https://openrouter.ai/api/v1";
const CHAT_URL = `${OR_BASE}/chat/completions`;

// --- helpers -----------------------------------------------------------------

function goodModel(target: PaidTarget): CatalogModelInfo {
  return {
    id: target.slug,
    endpoints: [
      {
        tag: target.providerRoute,
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

function goodCatalog(targets: PaidTarget[]): Map<string, CatalogModelInfo> {
  return new Map(targets.map((t) => [t.slug, goodModel(t)]));
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
    const payload = {
      id: "gen-mock-1",
      model,
      provider: "MockProvider",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "FINAL ANSWER" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

function wirePreimage(obj: unknown) {
  const bytes = Buffer.from(JSON.stringify(obj), "utf-8");
  return { encoding: "base64" as const, base64: bytes.toString("base64"), sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

/** GenerateFacts for a planned cell — a passing/failing hosted response with full wire. */
function factsFor(
  plan: PaidCellPlan,
  opts: { ok?: boolean; costUsd?: number | null; routing?: ProviderRouting | null; model?: string; url?: string } = {},
): any {
  const ok = opts.ok ?? true;
  const routing = opts.routing === undefined ? buildProviderRouting(plan.target) : opts.routing;
  const model = opts.model ?? plan.target.slug;
  const content = ok ? "FINAL ANSWER" : "";
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
  const preimage = wirePreimage(sentBody);
  const url = opts.url ?? CHAT_URL;
  return {
    raw: { id: "gen-x", model, provider: plan.target.providerRoute, choices: [{ finish_reason: ok ? "stop" : "content_filter", message: { role: "assistant", content } }], usage: {} },
    text: ok ? content : "",
    rawFinish: ok ? "stop" : "content_filter",
    transportError: null,
    usage: {},
    latencyMs: 5,
    cost: { costModel: "METERED", actualCostUsd: opts.costUsd === undefined ? 0.01 : opts.costUsd, lookup: {} },
    routing: { provider: plan.target.providerRoute },
    requestSent: { model, maxTokens: plan.maxTokens, temperature: s.temperature, topP: s.topP, seed: s.seed, providerRouting: routing ?? undefined },
    requestWireSha256: preimage.sha256,
    responseWireSha256: "sha256:bb",
    costLookupWireSha256: "sha256:cc",
    requestUrl: url,
    requestMethod: "POST",
    responseModelId: model,
    responseGenerationId: "gen-x",
    responseProvider: plan.target.providerRoute,
    generationLookupModelId: model,
    generationLookupGenerationId: "gen-x",
    generationLookupProvider: plan.target.providerRoute,
    wire: { request: { url, method: "POST", body: preimage }, response: { httpStatus: 200, receivedAtUtc: "t", headers: {}, body: null }, costLookup: null },
  };
}

/** A fully-wired credential-ordering bootstrap with fs-free stubs and an env spy. */
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
    fetchCatalogAndVerify: async () => ({ ok: true, reasons: [], catalogArtifactBody: "{}", perTarget: [] }),
    assertOutputRootEmpty: () => {},
    acquireLock: () => null,
    finalizeCatalogArtifact: () => {},
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

// --- 1. fixed definitions ----------------------------------------------------

describe("paid pass fixed definitions", () => {
  it("Hosted Pass A: campaign/stage/budget/targets/routes/ceilings/15 cells", () => {
    expect(HOSTED_PAID_PASS.stageId).toBe("plinius-qualification-2026-08-22-diagnostic-hosted-paid-r1");
    expect(HOSTED_PAID_PASS.budget).toEqual({ totalCapUsd: 5.0, perRunCapUsd: 1.0 });
    expect(HOSTED_PAID_TARGETS.map((t) => [t.slug, t.providerRoute, t.priceCeiling.inputPerMTokens, t.priceCeiling.outputPerMTokens])).toEqual([
      ["openai/gpt-5.6-sol-pro", "openai", 2.0, 10.0],
      ["anthropic/claude-opus-5", "claude-on-aws", 5.0, 25.0],
      ["google/gemini-3.7-flash", "google-vertex/global", 0.375, 1.875],
      ["deepseek/deepseek-v4-flash-0731", "deepinfra/fp8", 0.08, 0.18],
    ]);
    const cells = buildHostedPaidCells();
    expect(cells.length).toBe(15);
    expect(cells[0]).toEqual({ target: "openai/gpt-5.6-sol-pro", benchmark: OIDC_BENCHMARK_ID, sentinel: true, group: "hosted-global" });
    expect(cells.filter((c) => c.sentinel).length).toBe(1);
    expect(cells.some((c) => c.target === "anthropic/claude-opus-5" && c.benchmark === OIDC_BENCHMARK_ID)).toBe(false);
    expect(cells.filter((c) => c.target === "anthropic/claude-opus-5").length).toBe(3);
  });

  it("Candidate Pass: new campaign, provider SLUG routes, ceilings, 16 cells, per-model sentinels", () => {
    expect(CANDIDATE_PAID_PASS.campaignId).toBe("plinius-qualification-2026-08-26-candidate-r1");
    expect(CANDIDATE_PAID_PASS.budget).toEqual({ totalCapUsd: 6.0, perRunCapUsd: 0.75 });
    expect(CANDIDATE_PAID_PASS.sentinelScope).toBe("per-model");
    expect(CANDIDATE_PAID_TARGETS.map((t) => [t.slug, t.providerRoute, t.priceCeiling.inputPerMTokens, t.priceCeiling.outputPerMTokens])).toEqual([
      ["z-ai/glm-5.3", "z-ai/fp8", 1.4, 4.4],
      ["moonshotai/kimi-k3", "moonshotai/mxfp4", 3.0, 15.0],
      ["qwen/qwen3.8-max", "alibaba", 2.0, 6.0],
      ["anthropic/claude-sonnet-5", "anthropic", 2.0, 10.0],
    ]);
    const cells = buildCandidatePaidCells();
    expect(cells.length).toBe(16);
    for (const t of CANDIDATE_PAID_TARGETS) {
      const group = cells.filter((c) => c.group === t.slug);
      expect(group.length).toBe(4);
      expect(group[0]).toEqual({ target: t.slug, benchmark: OIDC_BENCHMARK_ID, sentinel: true, group: t.slug });
    }
  });

  it("resolveDriverMode accepts both paid modes and rejects unknown", () => {
    expect(resolveDriverMode("diagnostic-hosted-paid-r1")).toBe("diagnostic-hosted-paid-r1");
    expect(resolveDriverMode("diagnostic-candidate-paid-r1")).toBe("diagnostic-candidate-paid-r1");
    expect(() => resolveDriverMode(undefined)).toThrow();
  });
});

// --- 2. routing validation ---------------------------------------------------

describe("provider routing validation", () => {
  const target = HOSTED_PAID_TARGETS[0];
  const good = serializeProviderRouting(buildProviderRouting(target));

  it("blocks missing provider, multiple/empty routes, fallback, param-req, and unknown fields", () => {
    expect(parseProviderRoutingWire(undefined).ok).toBe(false);
    expect(parseProviderRoutingWire({ ...good, order: ["openai", "azure"] }).ok).toBe(false);
    expect(parseProviderRoutingWire({ ...good, order: [] }).ok).toBe(false);
    expect(parseProviderRoutingWire({ ...good, allow_fallbacks: true }).ok).toBe(false);
    expect(parseProviderRoutingWire({ ...good, require_parameters: false }).ok).toBe(false);
    const unk = parseProviderRoutingWire({ ...good, transforms: ["x"], sort: "price" });
    expect(unk.ok).toBe(false);
    if (!unk.ok) expect(unk.reasons.some((r) => r.startsWith("provider_unknown_field"))).toBe(true);
    expect(parseProviderRoutingWire({ ...good, max_price: { prompt: 2, completion: 10, image: 1 } }).ok).toBe(false);
  });

  it("round-trips the exact canonical routing", () => {
    const parsed = parseProviderRoutingWire(good);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(providerRoutingEqual(parsed.routing, buildProviderRouting(target))).toBe(true);
  });

  it("verifyPaidRequestWire blocks model / route / fallback / max_price / dropped-provider tampering", () => {
    const routing = buildProviderRouting(target);
    const w = { model: target.slug, max_tokens: 1024, provider: serializeProviderRouting(routing) };
    expect(verifyPaidRequestWire(w, { model: target.slug, routing }).ok).toBe(true);
    expect(verifyPaidRequestWire({ ...w, model: "x" }, { model: target.slug, routing }).ok).toBe(false);
    expect(verifyPaidRequestWire({ ...w, provider: { ...w.provider, order: ["azure"] } }, { model: target.slug, routing }).ok).toBe(false);
    expect(verifyPaidRequestWire({ ...w, provider: { ...w.provider, allow_fallbacks: true } }, { model: target.slug, routing }).ok).toBe(false);
    expect(verifyPaidRequestWire({ ...w, provider: { ...w.provider, max_price: { prompt: 99, completion: 99 } } }, { model: target.slug, routing }).ok).toBe(false);
    expect(verifyPaidRequestWire({ model: target.slug, max_tokens: 1024 }, { model: target.slug, routing }).ok).toBe(false);
  });
});

// --- 3. full dispatch re-derivation ------------------------------------------

describe("full request/response re-derivation", () => {
  const target = HOSTED_PAID_TARGETS[3]; // deepseek: temperature 0, topP 1, seed 1
  const routing = buildProviderRouting(target);
  const messages = [{ role: "user", content: "hi" }];
  const expected: ExpectedDispatch = { requestUrl: CHAT_URL, model: target.slug, routing, maxTokens: 24576, temperature: 0, topP: 1, seed: 1, messages };
  const base: ObservedDispatch = {
    requestUrl: CHAT_URL, requestMethod: "POST", model: target.slug, routing, maxTokens: 24576, temperature: 0, topP: 1, seed: 1, messages,
    responseModelId: target.slug, responseProvider: "DeepInfra", responseGenerationId: "g1", lookupModelId: target.slug, lookupGenerationId: "g1", lookupProvider: "DeepInfra",
  };

  it("passes a fully-consistent dispatch", () => {
    expect(verifyPaidDispatch(base, expected).ok).toBe(true);
  });
  it("blocks url, method, model, routing, max_tokens, sampling, messages, response model, and lookup identity drift", () => {
    expect(verifyPaidDispatch({ ...base, requestUrl: "https://evil/x" }, expected).reasons.some((r) => r.startsWith("request_url_mismatch"))).toBe(true);
    expect(verifyPaidDispatch({ ...base, requestMethod: "GET" }, expected).reasons.some((r) => r.startsWith("request_method_mismatch"))).toBe(true);
    expect(verifyPaidDispatch({ ...base, model: "x" }, expected).reasons.some((r) => r.startsWith("request_model_mismatch"))).toBe(true);
    expect(verifyPaidDispatch({ ...base, routing: buildProviderRouting(HOSTED_PAID_TARGETS[0]) }, expected).reasons).toContain("request_routing_mismatch");
    expect(verifyPaidDispatch({ ...base, maxTokens: 10 }, expected).reasons.some((r) => r.startsWith("request_max_tokens_mismatch"))).toBe(true);
    expect(verifyPaidDispatch({ ...base, temperature: 1 }, expected).reasons).toContain("request_temperature_mismatch");
    expect(verifyPaidDispatch({ ...base, seed: 9 }, expected).reasons).toContain("request_seed_mismatch");
    expect(verifyPaidDispatch({ ...base, messages: [{ role: "user", content: "changed" }] }, expected).reasons).toContain("request_messages_mismatch");
    expect(verifyPaidDispatch({ ...base, responseModelId: "other" }, expected).reasons.some((r) => r.startsWith("response_model_mismatch"))).toBe(true);
    expect(verifyPaidDispatch({ ...base, responseProvider: null }, expected).reasons).toContain("response_provider_missing");
    expect(verifyPaidDispatch({ ...base, lookupModelId: "other" }, expected).reasons).toContain("lookup_model_mismatch");
    expect(verifyPaidDispatch({ ...base, lookupGenerationId: "g2" }, expected).reasons).toContain("lookup_generation_id_mismatch");
  });
});

// --- 4. catalog + budget -----------------------------------------------------

describe("catalog and budget verification", () => {
  const target = HOSTED_PAID_TARGETS[0];
  const need = { maxTokens: 1024, promptTokens: 2048, usedParams: ["max_tokens", "seed"] };

  it("blocks missing model, missing endpoint, ceiling breach, unknown price, unsupported param, alias, free", () => {
    expect(verifyPaidTargetAgainstCatalog(goodModel(target), target, need).ok).toBe(true);
    expect(verifyPaidTargetAgainstCatalog(undefined, target, need).ok).toBe(false);
    expect(verifyPaidTargetAgainstCatalog({ id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], tag: "azure" }] }, target, need).reasons.some((r) => r.startsWith("provider_endpoint_missing"))).toBe(true);
    expect(verifyPaidTargetAgainstCatalog({ id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], pricing: { prompt: "0.001", completion: "0.001" } }] }, target, need).reasons).toContain("price_over_input_ceiling");
    expect(verifyPaidTargetAgainstCatalog({ id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], pricing: { prompt: null, completion: null } }] }, target, need).reasons).toContain("price_unknown");
    expect(verifyPaidTargetAgainstCatalog({ id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], supportedParameters: ["max_tokens"] }] }, target, need).reasons).toContain("parameter_unsupported:seed");
    expect(verifyPaidTargetAgainstCatalog({ ...goodModel(target), isAlias: true }, target, need).reasons).toContain("model_is_alias");
    expect(verifyPaidTargetAgainstCatalog({ id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], isFree: true }] }, target, need).reasons).toContain("provider_endpoint_free");
  });

  it("verifyPaidCatalog passes both real passes and fails when any target is broken", () => {
    expect(verifyPaidCatalog(HOSTED_PAID_PASS, buildHostedPaidCells(), goodCatalog(HOSTED_PAID_TARGETS)).ok).toBe(true);
    expect(verifyPaidCatalog(CANDIDATE_PAID_PASS, buildCandidatePaidCells(), goodCatalog(CANDIDATE_PAID_TARGETS)).ok).toBe(true);
    const broken = goodCatalog(HOSTED_PAID_TARGETS);
    broken.set("openai/gpt-5.6-sol-pro", { id: "openai/gpt-5.6-sol-pro", endpoints: [] });
    expect(verifyPaidCatalog(HOSTED_PAID_PASS, buildHostedPaidCells(), broken).ok).toBe(false);
  });

  it("pre-dispatch budget gate blocks per-run and total breaches", () => {
    const b = { totalCapUsd: 5.0, perRunCapUsd: 1.0 };
    expect(checkBudgetBeforeDispatch(0, 0.5, b).ok).toBe(true);
    expect(checkBudgetBeforeDispatch(0, 1.5, b).reasons).toContain("per_run_cap_exceeded");
    expect(checkBudgetBeforeDispatch(4.8, 0.5, b).reasons).toContain("total_cap_exceeded");
    expect(estimateCellCeilingUsd(HOSTED_PAID_TARGETS[0], 1_000_000, 1_000_000)).toBeCloseTo(12.0, 6);
  });

  it("actual-cost validation rejects null, non-finite, negative, per-run and total breaches (never 0-fill)", () => {
    const b = { totalCapUsd: 5.0, perRunCapUsd: 1.0 };
    expect(validatePaidActualCost(0.5, 0, b).ok).toBe(true);
    expect(validatePaidActualCost(null, 0, b).reasons).toContain("cost_unknown_or_not_finite");
    expect(validatePaidActualCost(Number.POSITIVE_INFINITY, 0, b).reasons).toContain("cost_unknown_or_not_finite");
    expect(validatePaidActualCost(-1, 0, b).reasons).toContain("cost_negative");
    expect(validatePaidActualCost(1.5, 0, b).reasons).toContain("per_run_cap_exceeded_actual");
    expect(validatePaidActualCost(0.5, 4.8, b).reasons).toContain("total_cap_exceeded_actual");
  });
});

// --- 5. dispatch wire: paid carries routing, non-paid unchanged --------------

describe("dispatch adapter provider routing in the wire", () => {
  const target = HOSTED_PAID_TARGETS[0];
  const routing = buildProviderRouting(target);

  it("serializes exact provider routing into the request wire for a paid hosted request", async () => {
    const { fn, calls } = mockFetch(target.slug);
    const facts = await dispatchViaBackend({
      backendId: "openrouter",
      baseUrl: OR_BASE,
      timeoutMs: 5000,
      isHosted: true,
      req: { model: target.slug, maxTokens: 1024, temperature: null, topP: null, seed: 1, providerRouting: routing },
      messages: [{ role: "user", content: "hi" }],
      fetchFn: fn,
    });
    expect((calls[0].body as Record<string, unknown>).provider).toEqual(serializeProviderRouting(routing));
    expect(facts.requestSent.providerRouting).toBeTruthy();
    expect(providerRoutingEqual(facts.requestSent.providerRouting!, routing)).toBe(true);
    expect(JSON.stringify(facts.wire)).not.toMatch(/sk-or-v1-|"authorization"\s*:/i);
  });

  it("REGRESSION: a non-paid request carries no provider field and no routing", async () => {
    const { fn, calls } = mockFetch(target.slug);
    const facts = await dispatchViaBackend({
      backendId: "openrouter",
      baseUrl: OR_BASE,
      timeoutMs: 5000,
      isHosted: true,
      req: { model: target.slug, maxTokens: 1024, temperature: 0, topP: 1, seed: 1 },
      messages: [{ role: "user", content: "hi" }],
      fetchFn: fn,
    });
    expect((calls[0].body as Record<string, unknown>).provider).toBeUndefined();
    expect(facts.requestSent.providerRouting).toBeUndefined();
  });
});

// --- 6. credential ordering (required gates) ---------------------------------

describe("credential ordering — key read last, gates required", () => {
  it("reads the key only after every gate passes", async () => {
    const { deps, reads } = bootDeps("diagnostic-hosted-paid-r1", { CONTINUATION_OUTPUT_ROOT: "/x", OPENROUTER_API_KEY: "sk-or-secret" });
    const boot = await preparePaidBootstrap(deps as any);
    expect(boot.orKey).toBe("sk-or-secret");
    expect(reads.indexOf("OPENROUTER_API_KEY")).toBeGreaterThan(reads.indexOf("CONTINUATION_OUTPUT_ROOT"));
  });

  it("does NOT read the key when the catalog preflight fails", async () => {
    const { deps, reads } = bootDeps("diagnostic-hosted-paid-r1", { CONTINUATION_OUTPUT_ROOT: "/x", OPENROUTER_API_KEY: "sk" }, {
      fetchCatalogAndVerify: async () => ({ ok: false, reasons: ["price_over_input_ceiling"], catalogArtifactBody: "{}", perTarget: [] }),
    });
    await expect(preparePaidBootstrap(deps as any)).rejects.toThrow(/catalog preflight failed/);
    expect(reads).not.toContain("OPENROUTER_API_KEY");
  });

  it("does NOT read the key when source, parent Evidence, or campaign benchmarks fail", async () => {
    for (const over of [
      { verifySource: () => ({ ok: false, reasons: ["parent_bundle_digest_mismatch"] }) },
      { verifyParentEvidence: () => ({ ok: false, details: [] }) },
      { verifyCampaignBenchmarks: async () => ({ ok: false, reasons: ["benchmark_hash_mismatch"] }) },
    ]) {
      const { deps, reads } = bootDeps("diagnostic-candidate-paid-r1", { CONTINUATION_OUTPUT_ROOT: "/x", OPENROUTER_API_KEY: "sk" }, over);
      await expect(preparePaidBootstrap(deps as any)).rejects.toThrow();
      expect(reads).not.toContain("OPENROUTER_API_KEY");
    }
  });
});

// --- 7. orchestrator ---------------------------------------------------------

describe("runPaidPass orchestration", () => {
  it("candidate per-model sentinel failure skips only that model's remaining 3 cells", async () => {
    const failModel = "moonshotai/kimi-k3";
    const result = await runPaidPass({
      pass: CANDIDATE_PAID_PASS,
      cells: buildCandidatePaidCells(),
      outputRoot: freshRoot("cand-sentinel"),
      planCell: (cell, i) => paidPlanCell(CANDIDATE_PAID_PASS, cell, i),
      generate: async (cell, plan) => factsFor(plan, { ok: !(cell.target === failModel && cell.sentinel), costUsd: 0.01 }),
    });
    expect(result.stopped).toBeNull();
    expect(result.dispatchedRunIds.length).toBe(13);
    expect(result.skippedRunIds.length).toBe(3);
    expect(result.skippedGroups).toEqual([failModel]);
  });

  it("hosted global sentinel failure stops the pass after saving the billed sentinel", async () => {
    const root = freshRoot("hosted-sentinel");
    const result = await runPaidPass({
      pass: HOSTED_PAID_PASS,
      cells: buildHostedPaidCells(),
      outputRoot: root,
      planCell: (cell, i) => paidPlanCell(HOSTED_PAID_PASS, cell, i),
      generate: async (cell, plan) => factsFor(plan, { ok: !cell.sentinel, costUsd: 0.01 }),
    });
    expect(result.stopped).toMatch(/campaign_sentinel_not_accepted/);
    expect(result.dispatchedRunIds.length).toBe(1);
    expect((await readdir(join(root, "runs"))).filter((f) => f.endsWith(".json") && !f.endsWith(".wire.json") && !f.includes("intent")).length).toBe(1);
  });

  it("a happy hosted pass completes all 15 within budget", async () => {
    const result = await runPaidPass({
      pass: HOSTED_PAID_PASS,
      cells: buildHostedPaidCells(),
      outputRoot: freshRoot("hosted-happy"),
      planCell: (cell, i) => paidPlanCell(HOSTED_PAID_PASS, cell, i),
      generate: async (cell, plan) => factsFor(plan, { ok: true, costUsd: 0.01 }), // 15 * $0.01 = $0.15 < $5
    });
    expect(result.stopped).toBeNull();
    expect(result.dispatchedRunIds.length).toBe(15);
    expect(result.spentUsd).toBeCloseTo(0.15, 6);
  });

  it("stops before completing all cells when cumulative cost would breach the total cap, without overspending", async () => {
    const result = await runPaidPass({
      pass: HOSTED_PAID_PASS,
      cells: buildHostedPaidCells(),
      outputRoot: freshRoot("budget-total"),
      planCell: (cell, i) => paidPlanCell(HOSTED_PAID_PASS, cell, i),
      generate: async (cell, plan) => factsFor(plan, { ok: true, costUsd: 0.9 }), // 0.9 <= per-run 1; cumulates past total $5
    });
    // Either the pre-dispatch estimate gate or the settled actual-cost gate trips —
    // both are total-cap gates — and the accepted spend never exceeds the cap.
    expect(result.stopped).toMatch(/total_cap_exceeded/);
    expect(result.dispatchedRunIds.length).toBeLessThan(15);
    expect(result.spentUsd).toBeLessThanOrEqual(5.0);
  });

  it("PERSISTS the billed response, THEN stops, when the actual cost exceeds the per-run cap", async () => {
    const root = freshRoot("cost-overcap");
    const result = await runPaidPass({
      pass: HOSTED_PAID_PASS,
      cells: buildHostedPaidCells(),
      outputRoot: root,
      planCell: (cell, i) => paidPlanCell(HOSTED_PAID_PASS, cell, i),
      generate: async (cell, plan) => factsFor(plan, { ok: true, costUsd: 4.99 }), // > per-run $1
    });
    expect(result.stopped).toMatch(/actual_cost_rejected.*per_run_cap_exceeded_actual/);
    expect(result.dispatchedRunIds.length).toBe(1);
    // the billed sentinel record + its wire were saved before the stop
    const files = await readdir(join(root, "runs"));
    expect(files.some((f) => f.endsWith(".json") && !f.endsWith(".wire.json") && !f.includes("intent"))).toBe(true);
    expect(files.some((f) => f.endsWith(".wire.json"))).toBe(true);
  });

  it("PERSISTS the billed response, THEN stops, when the actual cost is unknown (never 0-fill)", async () => {
    const root = freshRoot("cost-unknown");
    const result = await runPaidPass({
      pass: HOSTED_PAID_PASS,
      cells: buildHostedPaidCells(),
      outputRoot: root,
      planCell: (cell, i) => paidPlanCell(HOSTED_PAID_PASS, cell, i),
      generate: async (cell, plan) => factsFor(plan, { ok: true, costUsd: null }),
    });
    expect(result.stopped).toMatch(/actual_cost_rejected.*cost_unknown_or_not_finite/);
    expect(result.spentUsd).toBe(0);
    expect(result.dispatchedRunIds.length).toBe(1);
    expect((await readdir(join(root, "runs"))).some((f) => f.endsWith(".json") && !f.includes("intent"))).toBe(true);
  });

  it("PERSISTS the billed response, THEN stops, on a request-wire routing tamper", async () => {
    const root = freshRoot("wire-tamper");
    const wrong = buildProviderRouting(HOSTED_PAID_TARGETS[1]);
    const result = await runPaidPass({
      pass: HOSTED_PAID_PASS,
      cells: buildHostedPaidCells(),
      outputRoot: root,
      planCell: (cell, i) => paidPlanCell(HOSTED_PAID_PASS, cell, i),
      generate: async (cell, plan) => factsFor(plan, { ok: true, costUsd: 0.01, routing: wrong }),
    });
    expect(result.stopped).toMatch(/request_wire_mismatch/);
    expect(result.dispatchedRunIds.length).toBe(1);
    expect((await readdir(join(root, "runs"))).some((f) => f.endsWith(".wire.json"))).toBe(true);
  });

  it("a happy candidate pass dispatches all 16 through the hardened journal with 0600 records and no credential", async () => {
    const root = freshRoot("cand-happy");
    const result = await runPaidPass({
      pass: CANDIDATE_PAID_PASS,
      cells: buildCandidatePaidCells(),
      outputRoot: root,
      planCell: (cell, i) => paidPlanCell(CANDIDATE_PAID_PASS, cell, i),
      generate: async (cell, plan) => factsFor(plan, { ok: true, costUsd: 0.02 }),
    });
    expect(result.stopped).toBeNull();
    expect(result.dispatchedRunIds.length).toBe(16);
    const runFiles = (await readdir(join(root, "runs"))).filter((f) => f.endsWith(".json") && !f.includes("intent"));
    const records = runFiles.filter((f) => !f.endsWith(".wire.json"));
    expect(records.length).toBe(16);
    for (const f of records) {
      // hardened journal writes records mode 0600
      expect((await stat(join(root, "runs", f))).mode & 0o777).toBe(0o600);
      const body = await readFile(join(root, "runs", f), "utf-8");
      expect(body).not.toMatch(/sk-or-v1-[A-Za-z0-9]/i);
      expect(body).not.toMatch(/"authorization"\s*:/i);
    }
    // a content-addressed summary was finalized; the lock was released
    expect((await readdir(root)).some((f) => /^paid-pass-summary-[0-9a-f]{64}\.json$/.test(f))).toBe(true);
    expect(existsSync(join(root, ".invocation.lock")) || existsSync(join(root, "invocation.lock"))).toBe(false);
  });
});
