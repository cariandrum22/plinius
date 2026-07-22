import { describe, it, expect, vi } from "vitest";
import {
  OpenRouterBackend,
  OpenRouterChatClient,
} from "../src/backends/openrouter.js";
import { InferenceRequest } from "../src/types/inference.js";

const request: InferenceRequest = {
  model: "openai/gpt-5.1",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Explain gravity." },
  ],
  sampling: { maxTokens: 16000, temperature: 0.1, topP: 0.95 },
};

function fakeClient(
  send: OpenRouterChatClient["chat"]["send"],
): OpenRouterChatClient {
  return { chat: { send } };
}

describe("OpenRouterBackend", () => {
  it("preserves the existing OpenRouter request mapping and parses the response", async () => {
    const send = vi.fn(async () => ({
      id: "gen-123",
      choices: [
        {
          finishReason: "stop",
          message: { content: "Gravity is a force." },
        },
      ],
      usage: {
        promptTokens: 30,
        completionTokens: 5,
        totalTokens: 35,
      },
    }));

    const backend = new OpenRouterBackend({
      id: "openrouter",
      client: fakeClient(send),
    });

    const res = await backend.complete(request);

    // Same fields the legacy runner passed to openRouter.chat.send.
    expect(send).toHaveBeenCalledWith({
      model: "openai/gpt-5.1",
      messages: request.messages,
      maxTokens: 16000,
      temperature: 0.1,
      topP: 0.95,
      seed: undefined,
    });

    expect(res.text).toBe("Gravity is a force.");
    expect(res.finishReason).toBe("stop");
    expect(res.providerRequestId).toBe("gen-123");
    expect(res.usage).toEqual({
      promptTokens: 30,
      completionTokens: 5,
      totalTokens: 35,
    });
  });

  it("returns empty text when content is not a string (legacy behavior)", async () => {
    const send = vi.fn(async () => ({
      id: "gen-2",
      choices: [{ finishReason: "stop", message: { content: null } }],
    }));
    const backend = new OpenRouterBackend({
      id: "openrouter",
      client: fakeClient(send),
    });

    const res = await backend.complete(request);
    expect(res.text).toBe("");
  });

  it("normalizes SDK failures into InferenceError", async () => {
    const send = vi.fn(async () => {
      throw new Error("rate limited");
    });
    const backend = new OpenRouterBackend({
      id: "openrouter",
      client: fakeClient(send),
    });

    await expect(backend.complete(request)).rejects.toMatchObject({
      name: "InferenceError",
      backendId: "openrouter",
    });
  });

  it("reports minimal provenance without secrets", async () => {
    const backend = new OpenRouterBackend({
      id: "openrouter",
      client: fakeClient(vi.fn()),
    });
    const prov = await backend.inspect();
    expect(prov.backendType).toBe("openrouter");
    expect(prov.backendUrl).toBe("https://openrouter.ai/api/v1");
    expect(prov.missingFields.length).toBeGreaterThan(0);
  });
});
