/**
 * OpenRouter backend adapter.
 *
 * Wraps the OpenRouter SDK and translates to and from the domain inference
 * types. This is the only place the OpenRouter SDK is referenced; nothing
 * outside this adapter imports OpenRouter-specific types.
 */
import { OpenRouter } from "@openrouter/sdk";
import {
  InferenceBackend,
  InferenceError,
  InferenceRequest,
  InferenceResponse,
} from "../types/inference.js";
import { BackendProvenance, minimalProvenance } from "../types/provenance.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Minimal structural interface of the OpenRouter client used by this adapter.
 * Declaring it here keeps the adapter unit-testable via dependency injection
 * without a live OpenRouter connection.
 */
export interface OpenRouterChatClient {
  chat: {
    send(request: {
      model: string;
      messages: Array<{ role: string; content: string }>;
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      seed?: number;
    }): Promise<{
      id?: string;
      choices: Array<{
        finishReason?: string | null;
        message?: { content?: unknown };
      }>;
      usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      };
    }>;
  };
}

export interface OpenRouterBackendConfig {
  id: string;
  apiKey?: string;
  /** Injectable client, for testing. Defaults to a real OpenRouter client. */
  client?: OpenRouterChatClient;
}

export class OpenRouterBackend implements InferenceBackend {
  readonly id: string;
  readonly type = "openrouter";

  private readonly client: OpenRouterChatClient;

  constructor(config: OpenRouterBackendConfig) {
    this.id = config.id;
    this.client =
      config.client ??
      (new OpenRouter({ apiKey: config.apiKey }) as unknown as OpenRouterChatClient);
  }

  async complete(request: InferenceRequest): Promise<InferenceResponse> {
    const { sampling } = request;
    const startTime = Date.now();

    let completion: Awaited<ReturnType<OpenRouterChatClient["chat"]["send"]>>;
    try {
      completion = await this.client.chat.send({
        model: request.model,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        maxTokens: sampling.maxTokens,
        temperature: sampling.temperature,
        topP: sampling.topP,
        seed: sampling.seed,
      });
    } catch (error) {
      throw new InferenceError(
        "unknown",
        `OpenRouter request failed: ${error instanceof Error ? error.message : String(error)}`,
        { backendId: this.id, cause: error },
      );
    }

    const latencyMs = Date.now() - startTime;
    const choice = completion.choices?.[0];
    if (!choice) {
      throw new InferenceError(
        "invalid_response",
        `OpenRouter backend ${this.id} returned no choices`,
        { backendId: this.id },
      );
    }

    const text =
      typeof choice.message?.content === "string" ? choice.message.content : "";

    return {
      text,
      finishReason: choice.finishReason ?? undefined,
      usage: completion.usage
        ? {
            promptTokens: completion.usage.promptTokens,
            completionTokens: completion.usage.completionTokens,
            totalTokens: completion.usage.totalTokens,
          }
        : undefined,
      latencyMs,
      providerRequestId: completion.id,
    };
  }

  async inspect(): Promise<BackendProvenance> {
    // OpenRouter is a hosted router without a runtime-provenance endpoint;
    // report backend identity and mark deployment fields as unavailable.
    return minimalProvenance({
      backendType: this.type,
      backendUrl: OPENROUTER_BASE_URL,
      capturedAt: new Date().toISOString(),
    });
  }
}
