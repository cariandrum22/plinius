import { describe, it, expect } from "vitest";
import { BenchmarkRunner, hashContent } from "../src/benchmark/runner.js";
import {
  InferenceBackend,
  InferenceError,
  InferenceRequest,
  InferenceResponse,
} from "../src/types/inference.js";
import { BackendProvenance } from "../src/types/provenance.js";
import { Benchmark, BenchmarkCategory } from "../src/types/benchmark.js";
import { TargetConfig } from "../src/experiment/config.js";
import { renderMessages } from "../src/prompts/profiles.js";

const benchmark: Benchmark = {
  id: "A1",
  category: BenchmarkCategory.Quantitative,
  title: "Sample",
  description: "Sample benchmark",
  content: "What is 2 + 2?",
};

const target: TargetConfig = {
  id: "qwen-smoke-vllm",
  backend: "local-vllm",
  model: "Qwen/Qwen2.5-0.5B-Instruct",
  servedModelName: "Qwen/Qwen2.5-0.5B-Instruct",
  seed: 7,
};

class RecordingBackend implements InferenceBackend {
  readonly id = "local-vllm";
  readonly type = "openai-compatible";
  lastRequest?: InferenceRequest;

  constructor(private readonly response: InferenceResponse) {}

  async complete(request: InferenceRequest): Promise<InferenceResponse> {
    this.lastRequest = request;
    return this.response;
  }
}

class FailingBackend implements InferenceBackend {
  readonly id = "local-vllm";
  readonly type = "openai-compatible";
  async complete(): Promise<InferenceResponse> {
    throw new InferenceError("http", "boom", { status: 500 });
  }
}

const okResponse: InferenceResponse = {
  text: "4",
  finishReason: "stop",
  usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
  latencyMs: 42,
  providerRequestId: "chatcmpl-1",
};

describe("BenchmarkRunner", () => {
  it("persists the exact rendered messages and identities", async () => {
    const backend = new RecordingBackend(okResponse);
    const runner = new BenchmarkRunner({
      backend,
      target,
      promptProfile: "neutral",
      sampling: { maxTokens: 128, temperature: 0.1, topP: 0.9 },
    });

    const record = await runner.runBenchmark(benchmark);

    const expectedMessages = renderMessages("neutral", benchmark.content);
    // The persisted messages equal exactly what was sent to the backend.
    expect(record.messages).toEqual(expectedMessages);
    expect(backend.lastRequest?.messages).toEqual(expectedMessages);
    expect(record.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });

    // Distinct identities preserved.
    expect(record.targetId).toBe("qwen-smoke-vllm");
    expect(record.backendId).toBe("local-vllm");
    expect(record.backendType).toBe("openai-compatible");
    expect(record.model).toBe("Qwen/Qwen2.5-0.5B-Instruct");
    expect(record.servedModelName).toBe("Qwen/Qwen2.5-0.5B-Instruct");
    expect(record.promptProfile).toBe("neutral");

    // Sampling and seed captured (target seed overrides).
    expect(record.seed).toBe(7);
    expect(record.sampling).toMatchObject({
      maxTokens: 128,
      temperature: 0.1,
      topP: 0.9,
      seed: 7,
    });

    // Response, usage, latency, finish reason captured.
    expect(record.response).toMatchObject({
      text: "4",
      finishReason: "stop",
      latencyMs: 42,
      usage: { totalTokens: 11 },
    });

    // Content hash present and stable.
    expect(record.benchmark.contentHash).toBe(hashContent(benchmark.content));
  });

  it('supports the "none" profile (no system prompt)', async () => {
    const backend = new RecordingBackend(okResponse);
    const runner = new BenchmarkRunner({
      backend,
      target,
      promptProfile: "none",
      sampling: {},
    });
    const record = await runner.runBenchmark(benchmark);
    expect(record.messages).toHaveLength(1);
    expect(record.messages[0].role).toBe("user");
  });

  it("captures errors for failed runs instead of throwing", async () => {
    const runner = new BenchmarkRunner({
      backend: new FailingBackend(),
      target,
      promptProfile: "none",
      sampling: {},
    });
    const record = await runner.runBenchmark(benchmark);
    expect(record.response).toBeUndefined();
    expect(record.error).toMatchObject({
      kind: "http",
      status: 500,
      message: "boom",
    });
  });

  it("never writes credentials into the record", async () => {
    const provenance: BackendProvenance = {
      backendType: "openai-compatible",
      backendUrl: "http://vllm:8000/v1",
      missingFields: [],
      capturedAt: "2026-07-19T00:00:00.000Z",
    };
    const runner = new BenchmarkRunner({
      backend: new RecordingBackend(okResponse),
      target,
      promptProfile: "neutral",
      sampling: { maxTokens: 1 },
      provenance,
      pliniusCommit: "abc123",
    });
    const record = await runner.runBenchmark(benchmark);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toMatch(/api[_-]?key/i);
    expect(record.provenance?.backendUrl).toBe("http://vllm:8000/v1");
    expect(record.pliniusCommit).toBe("abc123");
  });
});
