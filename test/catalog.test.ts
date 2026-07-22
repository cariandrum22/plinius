import { describe, it, expect } from "vitest";
import { RawModelsResponseSchema } from "../src/catalog/schema.js";
import { buildSnapshot, computeSnapshotId, findModel } from "../src/catalog/snapshot.js";
import { OpenRouterCatalogClient } from "../src/catalog/client.js";
import { diffSnapshots } from "../src/catalog/diff.js";
import { resolveModel, reconcileReturnedModel } from "../src/catalog/resolve.js";
import { sortModels } from "../src/catalog/filter.js";
import { FETCHED_AT, LIVE_TARGETS, fixtureSnapshot, loadFixtureRaw } from "./helpers/catalog-fixture.js";

describe("(1) catalog parsing", () => {
  it("parses and normalizes the fixture, including all initial live targets", async () => {
    const snapshot = await fixtureSnapshot();
    expect(snapshot.schemaVersion).toBe(1);
    for (const id of LIVE_TARGETS) {
      const m = findModel(snapshot, id);
      expect(m, `missing ${id}`).toBeDefined();
      expect(m!.contextLength).toBeGreaterThan(0);
    }
    // Kimi K3 is available as a target.
    expect(findModel(snapshot, "moonshotai/kimi-k3")).toBeDefined();
  });
});

describe("(1b) catalog client with a mock fetch", () => {
  it("fetches /models via injected fetch", async () => {
    const raw = await loadFixtureRaw();
    const client = new OpenRouterCatalogClient({
      fetchFn: async () => new Response(JSON.stringify(raw), { status: 200 }),
    });
    const models = await client.getModels();
    expect(models.length).toBeGreaterThanOrEqual(12);
  });
  it("throws on a non-ok response", async () => {
    const client = new OpenRouterCatalogClient({
      fetchFn: async () => new Response("nope", { status: 500, statusText: "err" }),
    });
    await expect(client.getModels()).rejects.toThrow(/failed/);
  });
});

describe("(2) canonical-slug resolution & (3) mutable-alias snapshotting", () => {
  it("resolves a pinned canonical slug to itself", async () => {
    const snapshot = await fixtureSnapshot();
    const r = resolveModel("moonshotai/kimi-k3", snapshot, FETCHED_AT);
    expect(r.found).toBe(true);
    expect(r.resolvedSlug).toBe("moonshotai/kimi-k3");
    expect(r.aliasMismatch).toBe(false);
  });
  it("resolves a ~alias to its canonical slug and records the mismatch", async () => {
    const snapshot = await fixtureSnapshot();
    const r = resolveModel("~anthropic/claude-sonnet-latest", snapshot, FETCHED_AT);
    expect(r.isAlias).toBe(true);
    expect(r.resolvedSlug).toBe("anthropic/claude-sonnet-4.7");
    expect(r.aliasMismatch).toBe(true);
    expect(r.snapshotId).toBe(snapshot.snapshotId);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("flags an unavailable model", async () => {
    const snapshot = await fixtureSnapshot();
    const r = resolveModel("nonexistent/model", snapshot, FETCHED_AT);
    expect(r.found).toBe(false);
    expect(r.resolvedSlug).toBeNull();
  });
  it("reconciles the actual returned model", async () => {
    const snapshot = await fixtureSnapshot();
    const r = resolveModel("~anthropic/claude-sonnet-latest", snapshot, FETCHED_AT);
    expect(reconcileReturnedModel(r, "anthropic/claude-sonnet-4.7")).toHaveLength(0);
    expect(reconcileReturnedModel(r, "anthropic/claude-sonnet-9.9").length).toBeGreaterThan(0);
  });
});

describe("(4) catalog diff", () => {
  it("detects added, removed, changed, and expired models", async () => {
    const raw = (await loadFixtureRaw()) as { data: Array<Record<string, unknown>> };
    const before = buildSnapshot({
      rawModels: RawModelsResponseSchema.parse({ data: raw.data.slice(0, raw.data.length - 2) }).data,
      fetchedAt: FETCHED_AT,
    });
    const afterData = raw.data.map((m) => ({ ...m }));
    (afterData[0].pricing as Record<string, unknown>).prompt = "0.000001"; // price change
    const after = buildSnapshot({ rawModels: RawModelsResponseSchema.parse({ data: afterData }).data, fetchedAt: FETCHED_AT });

    const diff = diffSnapshots(before, after);
    expect(diff.added.length).toBe(2);
    expect(diff.changed.some((c) => c.id === "moonshotai/kimi-k3")).toBe(true);
    expect(diff.expired).toContain("openai/gpt-legacy-4o");
  });
});

describe("(14) expired-model detection & (20) snapshot reproducibility", () => {
  it("marks expired models", async () => {
    const snapshot = await fixtureSnapshot();
    const legacy = findModel(snapshot, "openai/gpt-legacy-4o");
    expect(legacy!.expirationDate).toBe("2026-01-01T00:00:00Z");
  });
  it("produces an identical snapshotId for identical raw input", async () => {
    const a = await fixtureSnapshot();
    const b = await fixtureSnapshot();
    expect(a.snapshotId).toBe(b.snapshotId);
    expect(computeSnapshotId(a.models)).toBe(computeSnapshotId(b.models));
    // fetch time does not affect the id
    const raw = RawModelsResponseSchema.parse(await loadFixtureRaw());
    const c = buildSnapshot({ rawModels: raw.data, fetchedAt: "2099-01-01T00:00:00Z" });
    expect(c.snapshotId).toBe(a.snapshotId);
  });
});

describe("sorting", () => {
  it("(intelligence) orders by metadata, nulls last", async () => {
    const snapshot = await fixtureSnapshot();
    const sorted = sortModels(snapshot.models, "intelligence-high-to-low");
    expect(sorted[0].id).toBe("anthropic/claude-fable-5"); // intelligence 80
  });
});
