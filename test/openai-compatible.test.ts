import { describe, it, expect, vi } from "vitest";
import {
  OpenAICompatibleBackend,
  FetchFn,
} from "../src/backends/openai-compatible.js";
import { InferenceError, InferenceRequest } from "../src/types/inference.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sampleRequest: InferenceRequest = {
  model: "Qwen/Qwen2.5-0.5B-Instruct",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "2+2?" },
  ],
  sampling: { maxTokens: 128, temperature: 0.1, topP: 0.9, seed: 42 },
};

const openAiSuccess = {
  id: "chatcmpl-abc123",
  model: "Qwen/Qwen2.5-0.5B-Instruct",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "4" },
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 },
};

describe("OpenAICompatibleBackend request serialization", () => {
  it("serializes an OpenAI-compatible chat completions body", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(openAiSuccess));
    const backend = new OpenAICompatibleBackend({
      id: "local-vllm",
      baseUrl: "http://vllm:8000/v1/",
      apiKey: "secret-key",
      fetchFn,
    });

    await backend.complete(sampleRequest);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    // Trailing slash on baseUrl is normalized.
    expect(url).toBe("http://vllm:8000/v1/chat/completions");
    expect(init?.method).toBe("POST");

    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-key");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      model: "Qwen/Qwen2.5-0.5B-Instruct",
      stream: false,
      max_tokens: 128,
      temperature: 0.1,
      top_p: 0.9,
      seed: 42,
    });
    expect(body.messages).toEqual(sampleRequest.messages);
  });

  it("omits the Authorization header when no API key is set", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(openAiSuccess));
    const backend = new OpenAICompatibleBackend({
      id: "open-server",
      baseUrl: "http://localhost:11434/v1",
      fetchFn,
    });

    await backend.complete(sampleRequest);
    const headers = fetchFn.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("merges backend and per-request extra params", () => {
    const backend = new OpenAICompatibleBackend({
      id: "x",
      baseUrl: "http://x/v1",
      extraParams: { chat_template_kwargs: { enable_thinking: false } },
      fetchFn: async () => jsonResponse(openAiSuccess),
    });
    const body = backend.buildRequestBody({
      ...sampleRequest,
      sampling: { ...sampleRequest.sampling, extraParams: { top_k: 5 } },
    });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.top_k).toBe(5);
  });
});

describe("OpenAICompatibleBackend response parsing", () => {
  it("parses text, finish reason, request id and usage", async () => {
    const backend = new OpenAICompatibleBackend({
      id: "local-vllm",
      baseUrl: "http://vllm:8000/v1",
      fetchFn: async () => jsonResponse(openAiSuccess),
    });

    const res = await backend.complete(sampleRequest);
    expect(res.text).toBe("4");
    expect(res.finishReason).toBe("stop");
    expect(res.providerRequestId).toBe("chatcmpl-abc123");
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("normalizes snake_case usage to camelCase", () => {
    const backend = new OpenAICompatibleBackend({
      id: "x",
      baseUrl: "http://x/v1",
      fetchFn: async () => jsonResponse(openAiSuccess),
    });
    const res = backend.parseResponse(openAiSuccess, 5);
    expect(res.usage).toEqual({
      promptTokens: 20,
      completionTokens: 1,
      totalTokens: 21,
    });
  });

  it("leaves usage undefined when the server omits it", () => {
    const backend = new OpenAICompatibleBackend({
      id: "x",
      baseUrl: "http://x/v1",
      fetchFn: async () => jsonResponse(openAiSuccess),
    });
    const res = backend.parseResponse(
      { ...openAiSuccess, usage: undefined },
      5,
    );
    expect(res.usage).toBeUndefined();
  });
});

describe("OpenAICompatibleBackend error normalization", () => {
  it("normalizes HTTP errors", async () => {
    const backend = new OpenAICompatibleBackend({
      id: "local-vllm",
      baseUrl: "http://vllm:8000/v1",
      fetchFn: async () =>
        new Response("model not found", { status: 404 }),
    });

    await expect(backend.complete(sampleRequest)).rejects.toMatchObject({
      kind: "http",
      status: 404,
      backendId: "local-vllm",
    });
  });

  it("normalizes timeouts (aborted request)", async () => {
    const backend = new OpenAICompatibleBackend({
      id: "local-vllm",
      baseUrl: "http://vllm:8000/v1",
      fetchFn: async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    });

    const error = await backend.complete(sampleRequest).catch((e) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect(error.kind).toBe("timeout");
  });

  it("normalizes network errors", async () => {
    const backend = new OpenAICompatibleBackend({
      id: "local-vllm",
      baseUrl: "http://vllm:8000/v1",
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    await expect(backend.complete(sampleRequest)).rejects.toMatchObject({
      kind: "network",
    });
  });

  it("rejects an invalid model response (no choices/content)", async () => {
    const backend = new OpenAICompatibleBackend({
      id: "local-vllm",
      baseUrl: "http://vllm:8000/v1",
      fetchFn: async () => jsonResponse({ id: "x", choices: [] }),
    });

    await expect(backend.complete(sampleRequest)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("rejects non-JSON responses", async () => {
    const backend = new OpenAICompatibleBackend({
      id: "local-vllm",
      baseUrl: "http://vllm:8000/v1",
      fetchFn: async () => new Response("<html>oops</html>", { status: 200 }),
    });

    await expect(backend.complete(sampleRequest)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });
});
