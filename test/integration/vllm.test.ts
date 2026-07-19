/**
 * Opt-in live integration test against a running vLLM smoke-test model.
 *
 * Skipped unless PLINIUS_LIVE_VLLM=1. Configure via environment:
 *   PLINIUS_LIVE_VLLM=1
 *   VLLM_BASE_URL   (default http://localhost:8000/v1)
 *   VLLM_MODEL      (default Qwen/Qwen2.5-0.5B-Instruct)
 *   VLLM_API_KEY    (optional)
 *   VLLM_PROVENANCE_URL (optional, e.g. http://localhost:8000/runtime-provenance)
 *
 * Run with:
 *   pnpm test:integration
 */
import { describe, it, expect } from "vitest";
import { OpenAICompatibleBackend } from "../../src/backends/openai-compatible.js";

const LIVE = process.env.PLINIUS_LIVE_VLLM === "1";
const baseUrl = process.env.VLLM_BASE_URL ?? "http://localhost:8000/v1";
const model = process.env.VLLM_MODEL ?? "Qwen/Qwen2.5-0.5B-Instruct";

describe.skipIf(!LIVE)("live vLLM smoke test", () => {
  const backend = new OpenAICompatibleBackend({
    id: "local-vllm",
    baseUrl,
    apiKey: process.env.VLLM_API_KEY,
    provenanceUrl: process.env.VLLM_PROVENANCE_URL,
    timeoutMs: 60_000,
  });

  it("returns a valid response and usage data", async () => {
    const res = await backend.complete({
      model,
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
      sampling: { maxTokens: 16, temperature: 0, seed: 0 },
    });

    expect(res.text.length).toBeGreaterThan(0);
    expect(res.usage?.totalTokens ?? 0).toBeGreaterThan(0);
    expect(res.latencyMs).toBeGreaterThan(0);
  });

  it("captures runtime provenance when available", async () => {
    const prov = await backend.inspect();
    expect(prov.backendType).toBe("openai-compatible");
    expect(prov.backendUrl).toBe(baseUrl);
    // Do not assert on optional fields; just confirm structure and no secrets.
    expect(JSON.stringify(prov)).not.toContain(process.env.VLLM_API_KEY ?? "\0");
  });
});
