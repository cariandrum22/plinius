import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { parseCohort, pendingConfirmationTargets } from "../src/campaign/cohort.js";
import { DEFAULT_PROFILES, parseInferenceProfiles } from "../src/campaign/profiles.js";
import { validateProfileParameters } from "../src/campaign/param-validation.js";
import { buildReasoningRequest, recordReasoning } from "../src/campaign/reasoning.js";
import { buildProviderRequest, recordRouting } from "../src/campaign/routing.js";
import { buildCostRecord, estimateListCost, effectiveCost } from "../src/campaign/cost.js";
import { BudgetTracker, budgetStopIsModelFailure, estimateCampaign, parseBudget, requiresAcknowledgement } from "../src/campaign/budget.js";
import { INITIAL_DISCOVERY_RULES, generateRecommendation, proposeCandidates } from "../src/campaign/discovery.js";
import { enforceZdr } from "../src/campaign/data-retention.js";
import { scanText, buildDenylist } from "../src/blind/redact.js";
import { defaultExperimentConfig } from "../src/experiment/config.js";
import { fixtureSnapshot, NOW_MS } from "./helpers/catalog-fixture.js";

const COHORT_DIR = join(process.cwd(), "benchmark", "campaign", "cohorts");

describe("(5) cohort schema validation", () => {
  it("parses all shipped cohort files", async () => {
    for (const file of [
      "frontier-ceiling-2026-07.yaml",
      "open-weight-cost-frontier-2026-07.yaml",
      "coding-specialists-2026-07.yaml",
      "fiction-specialists-exploratory.yaml",
    ]) {
      const cohort = parseCohort(parseYaml(await readFile(join(COHORT_DIR, file), "utf-8")));
      expect(cohort.targets.length).toBeGreaterThan(0);
    }
  });
  it("rejects a target with two identity kinds", () => {
    expect(() =>
      parseCohort({
        schema_version: 1,
        id: "x",
        version: "1.0.0",
        targets: [{ id: "bad", model: "a/b", requested_model: "~a/b-latest" }],
      }),
    ).toThrow(/exactly one/);
  });
  it("makes Kimi K3 available as an OpenRouter target", async () => {
    const cohort = parseCohort(parseYaml(await readFile(join(COHORT_DIR, "frontier-ceiling-2026-07.yaml"), "utf-8")));
    expect(cohort.targets.find((t) => t.model === "moonshotai/kimi-k3")).toBeDefined();
  });
});

describe("(6) unsupported-parameter handling", () => {
  const supported = ["temperature", "max_tokens"]; // no top_p, no seed
  const profile = DEFAULT_PROFILES["deterministic-where-supported"]; // temperature + seed

  it("reject policy rejects the combination", () => {
    const r = validateProfileParameters(profile, supported, "reject");
    expect(r.rejected).toBe(true);
    expect(r.unsupported).toContain("seed");
  });
  it("omit policy drops unsupported params and records them", () => {
    const r = validateProfileParameters(profile, supported, "omit");
    expect(r.omitted).toContain("seed");
    expect(r.rejected).toBe(false);
  });
  it("mark_not_comparable keeps the run but flags it", () => {
    const r = validateProfileParameters(profile, supported, "mark_not_comparable");
    expect(r.notComparable).toBe(true);
  });
  it("never silently treats unsupported as applied", () => {
    const r = validateProfileParameters(profile, supported, "omit");
    expect(r.applied).not.toContain("seed");
  });
});

describe("(7) reasoning-profile normalization", () => {
  it("builds an exact provider request and records provenance", () => {
    const profiles = parseInferenceProfiles(parseYaml("schema_version: 1\nprofiles:\n  hi:\n    reasoning:\n      enabled: true\n      effort: high"));
    const req = buildReasoningRequest(profiles.hi.reasoning);
    expect((req.exactRequest as { reasoning: { effort: string } }).reasoning.effort).toBe("high");
    expect(req.comparisonClass).toBe("best-supported-quality");

    const prov = recordReasoning(profiles.hi.reasoning, req, { acceptedEffort: "high", reasoningTokens: 512, reasoningText: "..." });
    expect(prov.requestedEffort).toBe("high");
    expect(prov.acceptedEffort).toBe("high");
    expect(prov.reasoningReturned).toBe(true);
  });
  it("a fixed token budget marks fixed-budget comparison", () => {
    const req = buildReasoningRequest({ enabled: true, effort: "high", maxTokens: 1000 });
    expect(req.comparisonClass).toBe("fixed-budget");
  });
});

describe("(8) provider-routing provenance & (9) fallback detection", () => {
  it("pins a provider and rejects fallback in reproducibility mode", () => {
    const req = buildProviderRequest({ mode: "reproducibility", provider: "moonshot", allowFallback: false });
    expect((req.provider as { allow_fallbacks: boolean }).allow_fallbacks).toBe(false);
    const prov = recordRouting({ mode: "reproducibility", provider: "moonshot", allowFallback: false }, { actualProvider: "moonshot" });
    expect(prov.fallbackOccurred).toBe(false);
    expect(prov.provenanceComplete).toBe(true);
  });
  it("detects a fallback and warns under reproducibility", () => {
    const prov = recordRouting({ mode: "reproducibility", provider: "moonshot", allowFallback: false }, { actualProvider: "together" });
    expect(prov.fallbackOccurred).toBe(true);
    expect(prov.warnings.some((w) => /reproducibility violated/.test(w))).toBe(true);
  });
  it("marks provenance incomplete when the provider is unknown", () => {
    const prov = recordRouting({ mode: "availability", allowFallback: true }, {});
    expect(prov.provenanceComplete).toBe(false);
  });
});

describe("(10) cost estimation & (11) actual-cost reconciliation", () => {
  const pricing = { prompt: 0.000001, completion: 0.000002, request: 0, cacheRead: 0.0000005, maxCompletionTokens: null };
  const usage = { promptTokens: 1000, completionTokens: 500, reasoningTokens: 200, cachedTokens: 200, nativeTokens: 1700 };

  it("estimates list cost with cached + reasoning tokens", () => {
    const cost = estimateListCost(usage, pricing);
    // billedPrompt=800*1e-6 + cached200*5e-7 + (500+200)*2e-6 = 0.0008 + 0.0001 + 0.0014
    expect(cost).toBeCloseTo(0.0023, 6);
  });
  it("reconciles against actual cost", () => {
    const record = buildCostRecord(usage, pricing, { actualCostUsd: 0.0025, requestId: "req_1", generationId: "gen_1" });
    expect(record.reconciled).toBe(true);
    expect(record.reconciliationDeltaUsd).toBeCloseTo(0.0002, 6);
    expect(effectiveCost(record)).toBe(0.0025);
  });
  it("falls back to the estimate when actual is unknown", () => {
    const record = buildCostRecord(usage, pricing);
    expect(record.reconciled).toBe(false);
    expect(effectiveCost(record)).toBeCloseTo(0.0023, 6);
  });
});

describe("(12) budget enforcement & (13) exhaustion classification", () => {
  const budget = parseBudget({ maximum_total_usd: 5, maximum_per_target_usd: 2, maximum_per_run_usd: 1 });

  it("estimates and requires acknowledgement above budget", () => {
    const est = estimateCampaign([0.5, 2], 10);
    expect(est.upperUsd).toBe(20);
    expect(requiresAcknowledgement(est, budget)).toBe(true);
  });
  it("blocks a run exceeding the per-run cap", () => {
    const tracker = new BudgetTracker(budget);
    const d = tracker.canRun("t1", 1.5);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.classification).toBe("per_run_exceeds");
  });
  it("stops on total-budget exhaustion (not a model failure)", () => {
    const tracker = new BudgetTracker(budget);
    tracker.record("t1", 2);
    tracker.record("t2", 2.5);
    const d = tracker.canRun("t3", 1);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.classification).toBe("budget_exhausted");
    expect(budgetStopIsModelFailure()).toBe(false);
  });
  it("enforces the per-target cap", () => {
    const tracker = new BudgetTracker(budget);
    tracker.record("t1", 1.5);
    const d = tracker.canRun("t1", 1);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.classification).toBe("per_target_exhausted");
  });
});

describe("(16) discovery proposal & (17) human-confirmation requirement", () => {
  it("proposes candidates not already pinned", async () => {
    const snapshot = await fixtureSnapshot();
    const cohortModelIds = new Set(["moonshotai/kimi-k3", "openai/gpt-5.6-sol"]);
    const report = generateRecommendation({
      current: snapshot,
      cohortModelIds,
      rules: INITIAL_DISCOVERY_RULES,
      generatedAt: "2026-07-20T00:00:00Z",
      nowMs: NOW_MS,
    });
    expect(report.candidateAdditions.length).toBeGreaterThan(0);
    // pinned models are excluded from additions
    expect(report.candidateAdditions.find((c) => c.id === "moonshotai/kimi-k3")).toBeUndefined();
    // alias drift surfaces the sonnet alias
    expect(report.aliasDrift.some((a) => a.id === "anthropic/claude-sonnet-latest")).toBe(true);
  });
  it("a frontier rule ranks by intelligence within maxRank", async () => {
    const snapshot = await fixtureSnapshot();
    const proposed = proposeCandidates(snapshot, INITIAL_DISCOVERY_RULES.frontier_candidate, NOW_MS);
    expect(proposed[0].id).toBe("anthropic/claude-fable-5");
  });
  it("coding cohort discovery targets require human confirmation", async () => {
    const cohort = parseCohort(parseYaml(await readFile(join(COHORT_DIR, "coding-specialists-2026-07.yaml"), "utf-8")));
    const pending = pendingConfirmationTargets(cohort);
    expect(pending.map((t) => t.id)).toContain("gpt-codex-current");
    expect(pending.every((t) => t.discoveryRule || t.requireHumanConfirmation)).toBe(true);
  });
});

describe("(18/19) blind identity removal & self-id leakage", () => {
  it("denylist detects cohort model self-identification", () => {
    const denylist = buildDenylist(defaultExperimentConfig, ["kimi-k3", "moonshotai/kimi-k3"]);
    expect(scanText("これは kimi-k3 の回答です。", denylist).length).toBeGreaterThan(0);
    expect(scanText("As Claude, I will answer.", denylist).some((h) => h.reason === "explicit self-identification")).toBe(true);
  });
});

describe("ZDR data retention", () => {
  it("rejects non-ZDR when required, allows with override", () => {
    const model = { zdrAvailable: false, providers: [] } as never;
    expect(enforceZdr(model, true).allowed).toBe(false);
    expect(enforceZdr(model, true, true).allowed).toBe(true);
    expect(enforceZdr(model, false).allowed).toBe(true);
  });
});
