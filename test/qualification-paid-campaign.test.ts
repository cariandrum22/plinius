/**
 * Partitioned hosted paid passes — production-path tests (Paid Pass r1).
 *
 * Every scenario drives the real production code (the pure paid-campaign module,
 * the driver's dispatch adapter, the credential-ordering bootstrap, and the paid
 * orchestrator). No network, no credential, no generation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "fs/promises";
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
  estimateCellCeilingUsd,
  checkBudgetBeforeDispatch,
  paidCellMaxTokens,
  OIDC_BENCHMARK_ID,
} from "../src/qualification/paid-campaign.js";
import type { CatalogModelInfo, PaidTarget, ProviderRouting } from "../src/qualification/paid-campaign.js";

import {
  dispatchViaBackend,
  preparePaidBootstrap,
  runPaidPass,
  paidPlanCell,
  verifyPaidCatalog,
  resolveDriverMode,
} from "../qualification-driver.mjs";
import type { PaidCellPlan } from "../qualification-driver.mjs";
import type { FetchFn } from "../src/backends/openai-compatible.js";

// --- helpers -----------------------------------------------------------------

/** A catalog entry that satisfies every check for a given target. */
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

/** A mock OpenRouter fetch returning one valid chat completion. Captures requests. */
function mockFetch(model: string, opts: { content?: string; finish?: string } = {}): { fn: FetchFn; calls: Array<{ url: string; body: unknown }> } {
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
      choices: [{ finish_reason: opts.finish ?? "stop", message: { role: "assistant", content: opts.content ?? "FINAL ANSWER" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

/** Build GenerateFacts for a planned cell — a passing or failing hosted response. */
function factsFor(plan: PaidCellPlan, opts: { ok?: boolean; costUsd?: number | null; routing?: ProviderRouting | null; model?: string } = {}): any {
  const ok = opts.ok ?? true;
  const routing = opts.routing === undefined ? buildProviderRouting(plan.target) : opts.routing;
  const content = ok ? "FINAL ANSWER" : "";
  const model = opts.model ?? plan.target.slug;
  const raw = {
    id: "gen-x",
    model,
    provider: plan.target.providerRoute,
    choices: [{ finish_reason: ok ? "stop" : "content_filter", message: { role: "assistant", content } }],
    usage: {},
  };
  return {
    raw,
    text: ok ? content : "",
    rawFinish: ok ? "stop" : "content_filter",
    transportError: null,
    usage: {},
    latencyMs: 5,
    cost: { costModel: "METERED", actualCostUsd: opts.costUsd === undefined ? 0.01 : opts.costUsd, lookup: {} },
    routing: { provider: plan.target.providerRoute },
    requestSent: {
      model,
      maxTokens: plan.maxTokens,
      temperature: plan.target.sampling.temperature,
      topP: plan.target.sampling.topP,
      seed: plan.target.sampling.seed,
      providerRouting: routing ?? undefined,
    },
    requestWireSha256: "sha256:aa",
    responseWireSha256: "sha256:bb",
    costLookupWireSha256: "sha256:cc",
    responseModelId: model,
    responseGenerationId: "gen-x",
    responseProvider: plan.target.providerRoute,
    wire: { request: { url: null, method: "POST", body: null }, response: { httpStatus: 200, receivedAtUtc: "t", headers: {}, body: null }, costLookup: null },
  };
}

let outRoot: string;
beforeAll(async () => {
  outRoot = await mkdtemp(join(tmpdir(), "plinius-paid-"));
});
afterAll(async () => {
  await rm(outRoot, { recursive: true, force: true });
});

async function freshRoot(name: string): Promise<string> {
  const d = join(outRoot, name);
  return d; // does not exist yet — runPaidPass asserts empty and creates runs/
}

// --- 1. fixed campaign / target / cell definitions ---------------------------

describe("paid pass fixed definitions", () => {
  it("Hosted Pass A: campaign, stage, budget, 4 targets, routes, ceilings, 15 cells", () => {
    expect(HOSTED_PAID_PASS.campaignId).toBe("plinius-qualification-2026-08-22-v1");
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
    // gpt-5.6 OIDC is the single campaign sentinel and runs first
    expect(cells[0]).toEqual({ target: "openai/gpt-5.6-sol-pro", benchmark: OIDC_BENCHMARK_ID, sentinel: true, group: "hosted-global" });
    expect(cells.filter((c) => c.sentinel).length).toBe(1);
    // the historical claude-opus-5 OIDC cell is excluded
    expect(cells.some((c) => c.target === "anthropic/claude-opus-5" && c.benchmark === OIDC_BENCHMARK_ID)).toBe(false);
    const perTarget = (slug: string) => cells.filter((c) => c.target === slug).length;
    expect(perTarget("openai/gpt-5.6-sol-pro")).toBe(4);
    expect(perTarget("anthropic/claude-opus-5")).toBe(3);
    expect(perTarget("google/gemini-3.7-flash")).toBe(4);
    expect(perTarget("deepseek/deepseek-v4-flash-0731")).toBe(4);
  });

  it("Candidate Pass: new campaign, 4 targets, frozen routes/ceilings, 16 cells, per-model sentinels", () => {
    expect(CANDIDATE_PAID_PASS.campaignId).toBe("plinius-qualification-2026-08-26-candidate-r1");
    expect(CANDIDATE_PAID_PASS.budget).toEqual({ totalCapUsd: 6.0, perRunCapUsd: 0.75 });
    expect(CANDIDATE_PAID_PASS.sentinelScope).toBe("per-model");
    expect(CANDIDATE_PAID_TARGETS.map((t) => [t.slug, t.providerRoute, t.priceCeiling.inputPerMTokens, t.priceCeiling.outputPerMTokens])).toEqual([
      ["z-ai/glm-5.3", "Z.AI", 1.4, 4.4],
      ["moonshotai/kimi-k3", "Moonshot AI", 3.0, 15.0],
      ["qwen/qwen3.8-max", "Alibaba", 2.0, 6.0],
      ["anthropic/claude-sonnet-5", "Anthropic", 2.0, 10.0],
    ]);
    const cells = buildCandidatePaidCells();
    expect(cells.length).toBe(16);
    // exactly one sentinel per model, and it is the OIDC cell, first in its group
    for (const t of CANDIDATE_PAID_TARGETS) {
      const group = cells.filter((c) => c.group === t.slug);
      expect(group.length).toBe(4);
      expect(group[0]).toEqual({ target: t.slug, benchmark: OIDC_BENCHMARK_ID, sentinel: true, group: t.slug });
      expect(group.filter((c) => c.sentinel).length).toBe(1);
    }
    // no GLM-5.3/Kimi extras beyond the 4 named candidates
    expect(new Set(cells.map((c) => c.target)).size).toBe(4);
  });

  it("resolveDriverMode accepts both paid modes and still rejects unknown", () => {
    expect(resolveDriverMode("diagnostic-hosted-paid-r1")).toBe("diagnostic-hosted-paid-r1");
    expect(resolveDriverMode("diagnostic-candidate-paid-r1")).toBe("diagnostic-candidate-paid-r1");
    expect(() => resolveDriverMode("diagnostic-continuation-r1")).toThrow();
    expect(() => resolveDriverMode(undefined)).toThrow();
  });
});

// --- 2. routing validation ---------------------------------------------------

describe("provider routing validation", () => {
  const target = HOSTED_PAID_TARGETS[0];
  const good = serializeProviderRouting(buildProviderRouting(target));

  it("blocks a missing provider, multiple routes, fallback enabled, or require_parameters disabled", () => {
    expect(parseProviderRoutingWire(undefined).ok).toBe(false);
    expect(parseProviderRoutingWire({ ...good, order: ["openai", "azure"] }).ok).toBe(false);
    expect(parseProviderRoutingWire({ ...good, order: [] }).ok).toBe(false);
    expect(parseProviderRoutingWire({ ...good, allow_fallbacks: true }).ok).toBe(false);
    expect(parseProviderRoutingWire({ ...good, require_parameters: false }).ok).toBe(false);
  });

  it("blocks unknown routing fields and any generic extra injection", () => {
    const withUnknown = parseProviderRoutingWire({ ...good, transforms: ["x"], sort: "price" });
    expect(withUnknown.ok).toBe(false);
    if (!withUnknown.ok) expect(withUnknown.reasons.some((r) => r.startsWith("provider_unknown_field"))).toBe(true);
    const badMaxPrice = parseProviderRoutingWire({ ...good, max_price: { prompt: 2, completion: 10, image: 1 } });
    expect(badMaxPrice.ok).toBe(false);
  });

  it("accepts the exact canonical routing and round-trips", () => {
    const parsed = parseProviderRoutingWire(good);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(providerRoutingEqual(parsed.routing, buildProviderRouting(target))).toBe(true);
  });
});

// --- 3. wire / resume re-derivation tamper -----------------------------------

describe("request wire and resume re-derivation tamper", () => {
  const target = HOSTED_PAID_TARGETS[0];
  const routing = buildProviderRouting(target);
  const goodWire = { model: target.slug, max_tokens: 1024, provider: serializeProviderRouting(routing) };

  it("passes an untampered wire and blocks model / route / fallback / max_price tampering", () => {
    expect(verifyPaidRequestWire(goodWire, { model: target.slug, routing }).ok).toBe(true);
    // tampered model
    expect(verifyPaidRequestWire({ ...goodWire, model: "openai/other" }, { model: target.slug, routing }).ok).toBe(false);
    // tampered route
    expect(verifyPaidRequestWire({ ...goodWire, provider: { ...goodWire.provider, order: ["azure"] } }, { model: target.slug, routing }).ok).toBe(false);
    // enabled fallback
    expect(verifyPaidRequestWire({ ...goodWire, provider: { ...goodWire.provider, allow_fallbacks: true } }, { model: target.slug, routing }).ok).toBe(false);
    // changed price ceiling
    expect(verifyPaidRequestWire({ ...goodWire, provider: { ...goodWire.provider, max_price: { prompt: 99, completion: 99 } } }, { model: target.slug, routing }).ok).toBe(false);
    // dropped provider entirely
    expect(verifyPaidRequestWire({ model: target.slug, max_tokens: 1024 }, { model: target.slug, routing }).ok).toBe(false);
  });
});

// --- 4. catalog verification -------------------------------------------------

describe("catalog verification", () => {
  const target = HOSTED_PAID_TARGETS[0];
  const need = { maxTokens: 1024, promptTokens: 2048, usedParams: ["max_tokens", "seed"] };

  it("passes a good model and blocks missing model, missing endpoint, ceiling breach, unknown price, unsupported param", () => {
    expect(verifyPaidTargetAgainstCatalog(goodModel(target), target, need).ok).toBe(true);
    // missing model
    expect(verifyPaidTargetAgainstCatalog(undefined, target, need).ok).toBe(false);
    // provider endpoint missing (route not present)
    const noRoute: CatalogModelInfo = { id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], tag: "azure" }] };
    expect(verifyPaidTargetAgainstCatalog(noRoute, target, need).reasons.some((r) => r.startsWith("provider_endpoint_missing"))).toBe(true);
    // price over ceiling
    const pricey: CatalogModelInfo = { id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], pricing: { prompt: "0.001", completion: "0.001" } }] };
    expect(verifyPaidTargetAgainstCatalog(pricey, target, need).reasons).toContain("price_over_input_ceiling");
    // unknown price
    const noPrice: CatalogModelInfo = { id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], pricing: { prompt: null, completion: null } }] };
    expect(verifyPaidTargetAgainstCatalog(noPrice, target, need).reasons).toContain("price_unknown");
    // unsupported parameter
    const noSeed: CatalogModelInfo = { id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], supportedParameters: ["max_tokens"] }] };
    expect(verifyPaidTargetAgainstCatalog(noSeed, target, need).reasons).toContain("parameter_unsupported:seed");
    // alias / free
    const alias: CatalogModelInfo = { ...goodModel(target), isAlias: true };
    expect(verifyPaidTargetAgainstCatalog(alias, target, need).reasons).toContain("model_is_alias");
    const free: CatalogModelInfo = { id: target.slug, endpoints: [{ ...goodModel(target).endpoints[0], isFree: true }] };
    expect(verifyPaidTargetAgainstCatalog(free, target, need).reasons).toContain("provider_endpoint_free");
  });

  it("verifyPaidCatalog blocks the whole pass when any target fails, and finalizes a budget-aware artifact when all pass", () => {
    const cells = buildHostedPaidCells();
    const okCat = goodCatalog(HOSTED_PAID_TARGETS);
    const passOk = verifyPaidCatalog(HOSTED_PAID_PASS, cells, okCat);
    expect(passOk.ok).toBe(true);
    expect(passOk.perTarget.length).toBe(4);
    // drop one target's route -> pass fails, others still reported
    const broken = new Map(okCat);
    broken.set("openai/gpt-5.6-sol-pro", { id: "openai/gpt-5.6-sol-pro", endpoints: [] });
    expect(verifyPaidCatalog(HOSTED_PAID_PASS, cells, broken).ok).toBe(false);
  });
});

// --- 5. budget ---------------------------------------------------------------

describe("budget gates", () => {
  it("blocks per-run and total cap breaches independently", () => {
    const budget = { totalCapUsd: 5.0, perRunCapUsd: 1.0 };
    expect(checkBudgetBeforeDispatch(0, 0.5, budget).ok).toBe(true);
    expect(checkBudgetBeforeDispatch(0, 1.5, budget).reasons).toContain("per_run_cap_exceeded");
    expect(checkBudgetBeforeDispatch(4.8, 0.5, budget).reasons).toContain("total_cap_exceeded");
  });

  it("estimateCellCeilingUsd uses the input/output ceilings", () => {
    const t = HOSTED_PAID_TARGETS[0]; // $2/M in, $10/M out
    expect(estimateCellCeilingUsd(t, 1_000_000, 1_000_000)).toBeCloseTo(12.0, 6);
  });
});

// --- 6. dispatch wire: paid carries routing, non-paid unchanged --------------

describe("dispatch adapter provider routing in the wire", () => {
  const target = HOSTED_PAID_TARGETS[0];
  const routing = buildProviderRouting(target);

  it("serializes the exact provider routing into the request wire for a paid hosted request", async () => {
    const { fn, calls } = mockFetch(target.slug);
    const facts = await dispatchViaBackend({
      backendId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      timeoutMs: 5000,
      isHosted: true,
      req: { model: target.slug, maxTokens: 1024, temperature: null, topP: null, seed: 1, providerRouting: routing },
      messages: [{ role: "user", content: "hi" }],
      fetchFn: fn,
    });
    const wireBody = calls[0].body as Record<string, unknown>;
    expect(wireBody.provider).toEqual(serializeProviderRouting(routing));
    // re-derived from the wire, exact match
    expect(facts.requestSent.providerRouting).toBeTruthy();
    expect(providerRoutingEqual(facts.requestSent.providerRouting!, routing)).toBe(true);
    // no credential value or authorization header ever appears in captured wire
    expect(JSON.stringify(facts.wire)).not.toMatch(/sk-or-v1-|"authorization"\s*:/i);
  });

  it("REGRESSION: a non-paid request carries no provider field and no routing", async () => {
    const { fn, calls } = mockFetch(target.slug);
    const facts = await dispatchViaBackend({
      backendId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      timeoutMs: 5000,
      isHosted: true,
      req: { model: target.slug, maxTokens: 1024, temperature: 0, topP: 1, seed: 1 },
      messages: [{ role: "user", content: "hi" }],
      fetchFn: fn,
    });
    const wireBody = calls[0].body as Record<string, unknown>;
    expect(wireBody.provider).toBeUndefined();
    expect(facts.requestSent.providerRouting).toBeUndefined();
  });
});

// --- 7. credential ordering --------------------------------------------------

describe("credential ordering (OPENROUTER_API_KEY read last)", () => {
  function envSpy(values: Record<string, string | undefined>) {
    const reads: string[] = [];
    const readEnv = (name: string) => {
      reads.push(name);
      return values[name];
    };
    return { readEnv, reads };
  }

  it("reads the key only after every gate passes", async () => {
    const { readEnv, reads } = envSpy({ CONTINUATION_OUTPUT_ROOT: "/x", OPENROUTER_API_KEY: "sk-or-secret" });
    const boot = await preparePaidBootstrap({
      mode: "diagnostic-hosted-paid-r1",
      readEnv,
      assertOutputRootEmpty: () => {},
      fetchCatalogAndVerify: async () => ({ ok: true, reasons: [], catalogArtifactBody: "{}", perTarget: [] }),
      finalizeCatalogArtifact: () => {},
    });
    expect(boot.orKey).toBe("sk-or-secret");
    expect(reads.indexOf("OPENROUTER_API_KEY")).toBeGreaterThan(reads.indexOf("CONTINUATION_OUTPUT_ROOT"));
  });

  it("does NOT read the key when the catalog preflight fails (generation stays 0)", async () => {
    const { readEnv, reads } = envSpy({ CONTINUATION_OUTPUT_ROOT: "/x", OPENROUTER_API_KEY: "sk-or-secret" });
    let finalizeCalled = false;
    await expect(
      preparePaidBootstrap({
        mode: "diagnostic-hosted-paid-r1",
        readEnv,
        assertOutputRootEmpty: () => {},
        fetchCatalogAndVerify: async () => ({ ok: false, reasons: ["price_over_input_ceiling"], catalogArtifactBody: "{}", perTarget: [] }),
        finalizeCatalogArtifact: () => {
          finalizeCalled = true;
        },
      }),
    ).rejects.toThrow(/catalog preflight failed/);
    expect(reads).not.toContain("OPENROUTER_API_KEY");
    expect(finalizeCalled).toBe(false);
  });

  it("does NOT read the key when parent Evidence or campaign benchmarks fail", async () => {
    const a = envSpy({ CONTINUATION_OUTPUT_ROOT: "/x", OPENROUTER_API_KEY: "sk" });
    await expect(
      preparePaidBootstrap({ mode: "diagnostic-hosted-paid-r1", readEnv: a.readEnv, verifyParentEvidence: () => ({ ok: false, details: [] }) }),
    ).rejects.toThrow(/parent evidence/);
    expect(a.reads).not.toContain("OPENROUTER_API_KEY");

    const b = envSpy({ CONTINUATION_OUTPUT_ROOT: "/x", OPENROUTER_API_KEY: "sk" });
    await expect(
      preparePaidBootstrap({
        mode: "diagnostic-candidate-paid-r1",
        readEnv: b.readEnv,
        assertOutputRootEmpty: () => {},
        verifyCampaignBenchmarks: async () => ({ ok: false, reasons: ["benchmark_hash_mismatch"] }),
      }),
    ).rejects.toThrow(/campaign\/benchmark/);
    expect(b.reads).not.toContain("OPENROUTER_API_KEY");
  });
});

// --- 8. orchestrator: sentinel scope, budget, cost, wire ---------------------

describe("runPaidPass orchestration", () => {
  it("candidate per-model sentinel failure skips only that model's remaining 3 cells", async () => {
    const root = await freshRoot("cand-sentinel");
    const cells = buildCandidatePaidCells();
    const failModel = "moonshotai/kimi-k3";
    const result = await runPaidPass({
      pass: CANDIDATE_PAID_PASS,
      cells,
      outputRoot: root,
      planCell: (cell, i) => paidPlanCell(CANDIDATE_PAID_PASS, cell, i),
      generate: async (cell, plan) =>
        factsFor(plan, { ok: !(cell.target === failModel && cell.sentinel), costUsd: 0.01 }),
    });
    expect(result.stopped).toBeNull();
    // 16 total - 3 skipped (the failed model's non-sentinel cells) = 13 dispatched
    expect(result.dispatchedRunIds.length).toBe(13);
    expect(result.skippedRunIds.length).toBe(3);
    expect(result.skippedGroups).toEqual([failModel]);
  });

  it("hosted global sentinel failure stops the pass before any further dispatch", async () => {
    const root = await freshRoot("hosted-sentinel");
    const cells = buildHostedPaidCells();
    const result = await runPaidPass({
      pass: HOSTED_PAID_PASS,
      cells,
      outputRoot: root,
      planCell: (cell, i) => paidPlanCell(HOSTED_PAID_PASS, cell, i),
      generate: async (cell, plan) => factsFor(plan, { ok: !cell.sentinel, costUsd: 0.01 }),
    });
    expect(result.stopped).toMatch(/campaign_sentinel_not_accepted/);
    expect(result.dispatchedRunIds.length).toBe(1); // only the sentinel ran
  });

  it("stops before dispatch when the budget would be exceeded", async () => {
    const root = await freshRoot("budget");
    const cells = buildHostedPaidCells();
    const result = await runPaidPass({
      pass: HOSTED_PAID_PASS,
      cells,
      outputRoot: root,
      planCell: (cell, i) => paidPlanCell(HOSTED_PAID_PASS, cell, i),
      // sentinel passes but reports an actual cost above the total cap, so the 2nd cell's gate trips
      generate: async (cell, plan) => factsFor(plan, { ok: true, costUsd: 4.99 }),
    });
    expect(result.stopped).toMatch(/budget_exceeded/);
    expect(result.dispatchedRunIds.length).toBe(1);
  });

  it("stops when the billed cost is unknown (never backfilled as 0)", async () => {
    const root = await freshRoot("cost-unknown");
    const cells = buildHostedPaidCells();
    const result = await runPaidPass({
      pass: HOSTED_PAID_PASS,
      cells,
      outputRoot: root,
      planCell: (cell, i) => paidPlanCell(HOSTED_PAID_PASS, cell, i),
      generate: async (cell, plan) => factsFor(plan, { ok: true, costUsd: null }),
    });
    expect(result.stopped).toMatch(/cost_unknown/);
    expect(result.spentUsd).toBe(0);
  });

  it("stops when the request wire routing does not match the plan (tamper)", async () => {
    const root = await freshRoot("wire-tamper");
    const cells = buildHostedPaidCells();
    const wrong = buildProviderRouting(HOSTED_PAID_TARGETS[1]); // wrong route/ceilings
    const result = await runPaidPass({
      pass: HOSTED_PAID_PASS,
      cells,
      outputRoot: root,
      planCell: (cell, i) => paidPlanCell(HOSTED_PAID_PASS, cell, i),
      generate: async (cell, plan) => factsFor(plan, { ok: true, costUsd: 0.01, routing: wrong }),
    });
    expect(result.stopped).toMatch(/request_wire_mismatch/);
  });

  it("a happy candidate pass dispatches all 16, persisting a record + wire evidence per cell with no credential", async () => {
    const root = await freshRoot("cand-happy");
    const cells = buildCandidatePaidCells();
    const result = await runPaidPass({
      pass: CANDIDATE_PAID_PASS,
      cells,
      outputRoot: root,
      planCell: (cell, i) => paidPlanCell(CANDIDATE_PAID_PASS, cell, i),
      generate: async (cell, plan) => factsFor(plan, { ok: true, costUsd: 0.02 }),
    });
    expect(result.stopped).toBeNull();
    expect(result.dispatchedRunIds.length).toBe(16);
    expect(result.passed).toBe(16);
    const runFiles = (await readdir(join(root, "runs"))).filter((f) => f.endsWith(".json") && !f.includes("intent"));
    expect(runFiles.filter((f) => !f.endsWith(".wire.json")).length).toBe(16);
    // No credential VALUE and no captured authorization header in any persisted
    // record / wire artifact. (Security-benchmark prose legitimately discusses
    // "Bearer"/"Authorization"; the leak check is for actual key values and a
    // sanitized-away authorization header field, not those words in content.)
    for (const f of runFiles) {
      const body = await readFile(join(root, "runs", f), "utf-8");
      expect(body).not.toMatch(/sk-or-v1-[A-Za-z0-9]/i);
      expect(body).not.toMatch(/"authorization"\s*:/i);
    }
    const summary = await readFile(join(root, "paid-pass-summary.json"), "utf-8");
    expect(summary).not.toMatch(/sk-or-v1-[A-Za-z0-9]/i);
  });
});
