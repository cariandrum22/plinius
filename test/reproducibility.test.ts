import { describe, it, expect } from "vitest";
import { buildPromptSnapshot, computePromptId } from "../src/prompt/snapshot.js";
import { computeFingerprint, renderTemplate } from "../src/prompt/fingerprint.js";
import { classifyProvenance, emptyGenerationProvenance } from "../src/provenance/schema.js";
import { normalizeGeneration } from "../src/provenance/generation.js";
import { captureEnvironment, diffEnvironment } from "../src/environment/environment.js";
import { classifyLifecycle } from "../src/campaign/lifecycle.js";
import { NormalizedModel } from "../src/catalog/schema.js";
import { buildManifest, validateManifest } from "../src/manifest/manifest.js";
import { compareManifest } from "../src/manifest/reproduce.js";
import { auditManifest } from "../src/manifest/audit.js";

const TS = "2026-07-20T00:00:00.000Z";
const NOW = Date.parse(TS);

// ---------------------------------------------------------------- Prompt

describe("prompt snapshot & fingerprint", () => {
  const base = { systemPrompt: "You are helpful.", userPrompt: "Solve {{task}}.", variables: { task: "A1" } };

  it("generates a snapshot with a rendered prompt and content id", () => {
    const snap = buildPromptSnapshot(base);
    expect(snap.renderedPrompt).toBe("Solve A1.");
    expect(snap.promptId).toMatch(/^prompt-[0-9a-f]{16}$/);
    expect(snap.fingerprint.systemHash).toMatch(/^sha256:/);
  });

  it("hash is stable and time-independent", () => {
    const a = buildPromptSnapshot(base);
    const b = buildPromptSnapshot(base);
    expect(a.promptId).toBe(b.promptId);
    expect(a.fingerprint).toEqual(b.fingerprint);
  });

  it("detects a one-character prompt change", () => {
    const a = buildPromptSnapshot(base);
    const b = buildPromptSnapshot({ ...base, userPrompt: "Solve {{task}}!" });
    expect(a.promptId).not.toBe(b.promptId);
    expect(a.fingerprint.userHash).not.toBe(b.fingerprint.userHash);
    expect(a.fingerprint.systemHash).toBe(b.fingerprint.systemHash); // system unchanged
  });

  it("renderTemplate leaves unknown variables intact", () => {
    expect(renderTemplate("Hi {{name}} {{x}}", { name: "K" })).toBe("Hi K {{x}}");
  });

  it("computeFingerprint is independent per part", () => {
    const fp = computeFingerprint({ systemPrompt: "s", userPrompt: "u", renderedPrompt: "r" });
    expect(new Set([fp.systemHash, fp.userHash, fp.renderedHash]).size).toBe(3);
  });
});

// ---------------------------------------------------------------- Provenance

describe("generation provenance status", () => {
  it("complete when generation id AND provider present", () => {
    const p = normalizeGeneration({ id: "gen_1", provider_name: "moonshot", total_cost: 0.01, latency: 500 }, { requestedSlug: "moonshotai/kimi-k3", canonicalSlug: "moonshotai/kimi-k3" });
    expect(p.generationId).toBe("gen_1");
    expect(p.provider).toBe("moonshot");
    expect(p.pricing.totalCostUsd).toBe(0.01);
    expect(classifyProvenance(p)).toBe("complete");
  });

  it("partial when only provider present", () => {
    const p = normalizeGeneration({ provider_name: "together" });
    expect(classifyProvenance(p)).toBe("partial");
  });

  it("missing when neither present; unknown fields stay null (no guessing)", () => {
    const p = normalizeGeneration({});
    expect(classifyProvenance(p)).toBe("missing");
    expect(p.region).toBeNull();
    expect(p.quantization).toBeNull();
    expect(classifyProvenance(emptyGenerationProvenance())).toBe("missing");
  });
});

// ---------------------------------------------------------------- Lifecycle

describe("model lifecycle", () => {
  const model = (over: Partial<NormalizedModel>): NormalizedModel => ({
    id: "a/b", canonicalSlug: "a/b", author: "a", name: "b", description: "", created: 1, expirationDate: null,
    knowledgeCutoff: null, contextLength: 1000, inputModalities: [], outputModalities: [], tokenizer: null,
    instructType: null, supportedParameters: [], defaultParameters: null,
    pricing: { prompt: null, completion: null, request: null, cacheRead: null, maxCompletionTokens: null },
    moderated: null, zdrAvailable: null, providers: [], benchmarkMetadata: null, ...over,
  });

  it("ACTIVE by default", () => {
    expect(classifyLifecycle(model({}), NOW)).toBe("ACTIVE");
  });
  it("DEPRECATED for a future expiration or a deprecated description", () => {
    expect(classifyLifecycle(model({ expirationDate: "2027-01-01T00:00:00Z" }), NOW)).toBe("DEPRECATED");
    expect(classifyLifecycle(model({ description: "This legacy model is deprecated." }), NOW)).toBe("DEPRECATED");
  });
  it("RETIRED past its expiration", () => {
    expect(classifyLifecycle(model({ expirationDate: "2026-01-01T00:00:00Z" }), NOW)).toBe("RETIRED");
  });
  it("UNKNOWN when the model is absent", () => {
    expect(classifyLifecycle(undefined, NOW)).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------- Manifest

function sampleManifest() {
  return buildManifest({
    campaignId: "frontier-ceiling-2026-07",
    runId: "run-1",
    catalogSnapshotId: "snap-abc",
    promptSnapshotId: "prompt-abc",
    environment: captureEnvironment({ runtime: { version: "v22.0.0", platform: "linux", arch: "x64" } }),
    targetModels: [
      { targetId: "kimi-k3-frontier", requestedSlug: "moonshotai/kimi-k3", canonicalSlug: "moonshotai/kimi-k3", lifecycle: "ACTIVE", provenanceStatus: "complete" },
    ],
    profiles: ["neutral-baseline"],
    budget: { maximumTotalUsd: 500, stopOnBudgetExhaustion: true },
    timestamp: TS,
    generationProvenance: [normalizeGeneration({ id: "gen_1", provider_name: "moonshot" }, { canonicalSlug: "moonshotai/kimi-k3" })],
  });
}

describe("evaluation manifest", () => {
  it("builds deterministically for identical inputs", () => {
    expect(sampleManifest()).toEqual(sampleManifest());
  });
  it("validates against the schema", () => {
    const m = validateManifest(sampleManifest());
    expect(m.schemaVersion).toBe(1);
    expect(m.targetModels[0].lifecycle).toBe("ACTIVE");
  });
  it("is backward compatible with an older manifest missing new fields", () => {
    const older = {
      schemaVersion: 1,
      campaignId: "c", runId: "r", catalogSnapshotId: "s", promptSnapshotId: "p",
      environment: {}, timestamp: TS,
      targetModels: [{ targetId: "t" }], // missing requested/canonical/lifecycle/provenanceStatus
      // no profiles, budget, generationProvenance
    };
    const m = validateManifest(older);
    expect(m.profiles).toEqual([]);
    expect(m.generationProvenance).toEqual([]);
    expect(m.targetModels[0].lifecycle).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------- Reproduce

describe("reproduce comparison", () => {
  const manifest = validateManifest(sampleManifest());
  const env = manifest.environment;

  it("REPRODUCIBLE on a full match", () => {
    const r = compareManifest(manifest, {
      environment: env,
      catalogSnapshotId: "snap-abc",
      promptSnapshotId: "prompt-abc",
      lifecycle: { "kimi-k3-frontier": "ACTIVE" },
      canonicalSlugs: { "moonshotai/kimi-k3": "moonshotai/kimi-k3" },
      providers: { "kimi-k3-frontier": "moonshot" },
    });
    expect(r.verdict).toBe("REPRODUCIBLE");
  });

  it("NOT_REPRODUCIBLE on a catalog mismatch", () => {
    const r = compareManifest(manifest, { catalogSnapshotId: "snap-different", promptSnapshotId: "prompt-abc" });
    expect(r.verdict).toBe("NOT_REPRODUCIBLE");
    expect(r.reasons.some((x) => /catalog/.test(x))).toBe(true);
  });

  it("NOT_REPRODUCIBLE on a prompt mismatch", () => {
    const r = compareManifest(manifest, { catalogSnapshotId: "snap-abc", promptSnapshotId: "prompt-changed" });
    expect(r.verdict).toBe("NOT_REPRODUCIBLE");
  });

  it("NOT_REPRODUCIBLE when a target is now RETIRED", () => {
    const r = compareManifest(manifest, {
      catalogSnapshotId: "snap-abc", promptSnapshotId: "prompt-abc",
      lifecycle: { "kimi-k3-frontier": "RETIRED" },
    });
    expect(r.verdict).toBe("NOT_REPRODUCIBLE");
  });

  it("PARTIALLY_REPRODUCIBLE on a provider diff", () => {
    const r = compareManifest(manifest, {
      environment: env, catalogSnapshotId: "snap-abc", promptSnapshotId: "prompt-abc",
      lifecycle: { "kimi-k3-frontier": "ACTIVE" },
      canonicalSlugs: { "moonshotai/kimi-k3": "moonshotai/kimi-k3" },
      providers: { "kimi-k3-frontier": "together" },
    });
    expect(r.verdict).toBe("PARTIALLY_REPRODUCIBLE");
    expect(r.providerDiffs).toHaveLength(1);
  });

  it("NOT_REPRODUCIBLE on a critical environment (schema) diff", () => {
    const changed = { ...env, catalogSchemaVersion: 999 };
    const r = compareManifest(manifest, { environment: changed, catalogSnapshotId: "snap-abc", promptSnapshotId: "prompt-abc" });
    expect(r.criticalEnvDiff).toBe(true);
    expect(r.verdict).toBe("NOT_REPRODUCIBLE");
  });

  it("PARTIALLY_REPRODUCIBLE on a non-critical environment (platform) diff", () => {
    const changed = { ...env, platform: "darwin" };
    const r = compareManifest(manifest, {
      environment: changed, catalogSnapshotId: "snap-abc", promptSnapshotId: "prompt-abc",
      lifecycle: { "kimi-k3-frontier": "ACTIVE" },
    });
    expect(diffEnvironment(env, changed)).toHaveLength(1);
    expect(r.verdict).toBe("PARTIALLY_REPRODUCIBLE");
  });
});

// ---------------------------------------------------------------- Audit

describe("audit", () => {
  it("passes a complete manifest", () => {
    const result = auditManifest(validateManifest(sampleManifest()));
    expect(result.errors).toBe(0);
    expect(result.items.find((i) => i.check === "Provenance Complete")!.level).toBe("OK");
  });
  it("flags a manifest with missing provenance and no budget", () => {
    const m = validateManifest({
      schemaVersion: 1, campaignId: "c", runId: "r", catalogSnapshotId: "s", promptSnapshotId: "p",
      environment: {}, timestamp: TS,
      targetModels: [{ targetId: "t", provenanceStatus: "missing", lifecycle: "ACTIVE" }],
    });
    const result = auditManifest(m);
    expect(result.errors).toBeGreaterThan(0);
    expect(result.warnings).toBeGreaterThan(0);
  });
});
