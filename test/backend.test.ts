import { describe, it, expect } from "vitest";
import { InferenceBackend, InferenceRequest, InferenceResponse } from "../src/backend/../types/inference.js";
import {
  CAPABILITIES,
  buildCapabilities,
  capabilitiesFromSupportedParameters,
  unknownCapabilities,
} from "../src/backend/capabilities.js";
import { BackendRegistry, DEFAULT_BACKEND } from "../src/backend/registry.js";
import { OpenRouterExecutionBackend } from "../src/backend/openrouter/index.js";
import { VllmExecutionBackend } from "../src/backend/vllm/index.js";
import { OpenRouterCatalogClient } from "../src/catalog/client.js";
import { buildManifest, validateManifest } from "../src/manifest/manifest.js";
import { auditManifest } from "../src/manifest/audit.js";
import { compareManifest } from "../src/manifest/reproduce.js";
import { captureEnvironment } from "../src/environment/environment.js";
import { loadFixtureRaw } from "./helpers/catalog-fixture.js";

// --- stubs -------------------------------------------------------------------

class StubInference implements InferenceBackend {
  readonly id = "stub";
  readonly type = "openai-compatible";
  async complete(_req: InferenceRequest): Promise<InferenceResponse> {
    return {
      text: "hello world",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      latencyMs: 100,
      providerRequestId: "req_1",
    };
  }
}

async function fixtureFetch(): Promise<Response> {
  return new Response(JSON.stringify(await loadFixtureRaw()), { status: 200 });
}

const NOW = () => "2026-07-20T00:00:00.000Z";

// --- capabilities ------------------------------------------------------------

describe("capability model", () => {
  it("defaults every capability to unknown (no guessing)", () => {
    const caps = unknownCapabilities();
    expect(CAPABILITIES.every((c) => caps[c] === "unknown")).toBe(true);
  });
  it("maps supported_parameters to supported; absent stays unknown", () => {
    const overrides = capabilitiesFromSupportedParameters(["temperature", "seed", "tools", "response_format"]);
    const caps = buildCapabilities(overrides, { maxContextLength: 1000 });
    expect(caps.capabilities.temperature).toBe("supported");
    expect(caps.capabilities.seed).toBe("supported");
    expect(caps.capabilities.toolCalling).toBe("supported");
    expect(caps.capabilities.jsonMode).toBe("supported");
    expect(caps.capabilities.topK).toBe("unknown"); // absent → unknown, not unsupported
    expect(caps.maxContextLength).toBe(1000);
  });
});

// --- registry ----------------------------------------------------------------

describe("backend registry", () => {
  it("registers, lists, and gets by name with a default", () => {
    const reg = new BackendRegistry();
    reg.register("openrouter", () => new OpenRouterExecutionBackend({ inferenceBackend: new StubInference() }));
    reg.register("vllm", () => new VllmExecutionBackend({ inferenceBackend: new StubInference() }));
    expect(reg.list()).toEqual(["openrouter", "vllm"]);
    expect(DEFAULT_BACKEND).toBe("openrouter");
    expect(reg.get().name()).toBe("openrouter");
    expect(() => reg.get("nope")).toThrow(/Unknown backend/);
  });
});

// --- OpenRouter adapter ------------------------------------------------------

function openRouterBackend(apiKey?: string) {
  return new OpenRouterExecutionBackend({
    apiKey,
    catalogClient: new OpenRouterCatalogClient({ fetchFn: fixtureFetch }),
    inferenceBackend: new StubInference(),
    now: NOW,
  });
}

describe("OpenRouter execution backend", () => {
  it("has metadata", () => {
    const b = openRouterBackend();
    expect(b.metadata().vendor).toBe("OpenRouter");
    expect(b.name()).toBe("openrouter");
  });
  it("discovers models from the catalog", async () => {
    const models = await openRouterBackend().discoverModels();
    expect(models.find((m) => m.id === "moonshotai/kimi-k3")).toBeDefined();
  });
  it("resolves a mutable alias to canonical", async () => {
    const r = await openRouterBackend().resolveModel("~anthropic/claude-sonnet-latest");
    expect(r.isAlias).toBe(true);
    expect(r.resolvedModel).toBe("anthropic/claude-sonnet-4.7");
  });
  it("derives capabilities from supported_parameters", async () => {
    const caps = await openRouterBackend().capabilities("moonshotai/kimi-k3");
    expect(caps.capabilities.chat).toBe("supported");
    expect(caps.capabilities.seed).toBe("supported");
    expect(caps.capabilities.toolCalling).toBe("supported");
  });
  it("executes and records METERED cost + runtime metrics", async () => {
    const result = await openRouterBackend().execute({ model: "moonshotai/kimi-k3", messages: [{ role: "user", content: "hi" }], sampling: { temperature: 0, seed: 1 } });
    expect(result.text).toBe("hello world");
    expect(result.cost.costModel).toBe("METERED");
    expect(result.cost.estimatedUsd).toBeGreaterThan(0);
    expect(result.metrics.completionTokens).toBe(5);
    expect(result.provenance.backend).toBe("openrouter");
    expect(result.provenance.requestId).toBe("req_1");
  });
  it("health requires api + auth", async () => {
    expect((await openRouterBackend("key").health()).healthy).toBe(true);
    expect((await openRouterBackend().health()).healthy).toBe(false); // no api key
  });
});

// --- vLLM adapter ------------------------------------------------------------

function vllmBackend(models: unknown[] = [{ id: "Qwen/Qwen2.5-0.5B-Instruct", owned_by: "vllm", max_model_len: 32768 }]) {
  const fetchFn = async (input: string): Promise<Response> => {
    if (input.endsWith("/models")) return new Response(JSON.stringify({ data: models }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
  return new VllmExecutionBackend({ baseUrl: "http://vllm:8000/v1", fetchFn, inferenceBackend: new StubInference(), now: NOW });
}

describe("vLLM execution backend", () => {
  it("discovers served models (canonical only)", async () => {
    const models = await vllmBackend().discoverModels();
    expect(models[0].id).toBe("Qwen/Qwen2.5-0.5B-Instruct");
    expect(models[0].canonicalSlug).toBe(models[0].id);
  });
  it("resolves only served models; no aliases", async () => {
    const b = vllmBackend();
    expect((await b.resolveModel("Qwen/Qwen2.5-0.5B-Instruct")).found).toBe(true);
    const missing = await b.resolveModel("other/model");
    expect(missing.found).toBe(false);
    expect(missing.isAlias).toBe(false);
  });
  it("marks only contract-guaranteed capabilities; the rest unknown", async () => {
    const caps = await vllmBackend().capabilities("Qwen/Qwen2.5-0.5B-Instruct");
    expect(caps.capabilities.chat).toBe("supported");
    expect(caps.capabilities.completion).toBe("supported");
    expect(caps.capabilities.temperature).toBe("unknown"); // not guessed
    expect(caps.maxContextLength).toBe(32768);
  });
  it("executes with FREE cost and no hardware provenance (null, not guessed)", async () => {
    const result = await vllmBackend().execute({ model: "Qwen/Qwen2.5-0.5B-Instruct", messages: [{ role: "user", content: "hi" }] });
    expect(result.cost.costModel).toBe("FREE");
    expect(result.cost.estimatedUsd).toBe(0);
    expect(result.provenance.backend).toBe("vllm");
    expect(result.provenance.backendMetadata).toBeNull();
  });
  it("has no generation-lookup provenance endpoint", async () => {
    expect(await vllmBackend().provenance("x")).toBeNull();
  });
  it("reports health from /models", async () => {
    expect((await vllmBackend().health()).healthy).toBe(true);
    expect((await vllmBackend([]).health()).healthy).toBe(false); // no models served
  });
});

// --- manifest / audit / reproduce integration --------------------------------

function manifestWithBackend(backend: string) {
  return buildManifest({
    campaignId: "c", runId: "r", catalogSnapshotId: "snap-1", promptSnapshotId: "prompt-1",
    environment: captureEnvironment({ runtime: { version: "v22", platform: "linux", arch: "x64" } }),
    targetModels: [{ targetId: "t", requestedSlug: null, canonicalSlug: "a/b", lifecycle: "ACTIVE", provenanceStatus: "complete" }],
    profiles: ["neutral-baseline"],
    budget: { maximumTotalUsd: 100, stopOnBudgetExhaustion: true },
    timestamp: "2026-07-20T00:00:00.000Z",
    generationProvenance: [{
      schemaVersion: 1, provider: "moonshot", endpoint: null, generationId: "g1", model: "a/b",
      canonicalSlug: "a/b", requestedSlug: null,
      pricing: { totalCostUsd: 0.01, promptCostUsd: null, completionCostUsd: null },
      latencyMs: 120, createdAt: null, region: null, contextLength: null, quantization: null, providerMetadata: null,
    }],
    backend, backendVersion: "1.0.0",
    backendCapabilities: buildCapabilities({ chat: "supported" }),
    backendHealth: { healthy: true, checkedAt: "2026-07-20T00:00:00.000Z" },
  });
}

describe("manifest backend integration", () => {
  it("persists and validates backend fields", () => {
    const m = validateManifest(manifestWithBackend("openrouter"));
    expect(m.backend).toBe("openrouter");
    expect(m.backendVersion).toBe("1.0.0");
  });
  it("stays backward compatible with a manifest that has no backend", () => {
    const older = validateManifest({
      schemaVersion: 1, campaignId: "c", runId: "r", catalogSnapshotId: "s", promptSnapshotId: "p",
      environment: {}, timestamp: "2026-07-20T00:00:00.000Z", targetModels: [],
    });
    expect(older.backend).toBeNull();
  });
  it("audit reports backend presence, health, capabilities, and runtime metrics", () => {
    const result = auditManifest(validateManifest(manifestWithBackend("openrouter")));
    const byCheck = Object.fromEntries(result.items.map((i) => [i.check, i.level]));
    expect(byCheck["Backend Present"]).toBe("OK");
    expect(byCheck["Backend Healthy"]).toBe("OK");
    expect(byCheck["Capabilities Recorded"]).toBe("OK");
    expect(byCheck["Runtime Metrics Recorded"]).toBe("OK");
  });
  it("reproduce flags a backend change as PARTIALLY_REPRODUCIBLE", () => {
    const m = validateManifest(manifestWithBackend("openrouter"));
    const r = compareManifest(m, {
      environment: m.environment, catalogSnapshotId: "snap-1", promptSnapshotId: "prompt-1",
      backend: "vllm", lifecycle: { t: "ACTIVE" },
    });
    expect(r.backendMatch).toBe(false);
    expect(r.verdict).toBe("PARTIALLY_REPRODUCIBLE");
    expect(r.reasons.some((x) => /backend changed/.test(x))).toBe(true);
  });
});
