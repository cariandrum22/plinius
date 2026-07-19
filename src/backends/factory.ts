/**
 * Build inference backends from experiment configuration.
 */
import { InferenceBackend } from "../types/inference.js";
import {
  BackendDef,
  ExperimentConfig,
} from "../experiment/config.js";
import { OpenAICompatibleBackend } from "./openai-compatible.js";
import { OpenRouterBackend, OpenRouterChatClient } from "./openrouter.js";

/** Resolves environment variables. Injectable for testing. */
export type EnvResolver = (name: string) => string | undefined;

const defaultEnvResolver: EnvResolver = (name) => process.env[name];

export interface BuildBackendOptions {
  /** Environment resolver (defaults to process.env). */
  env?: EnvResolver;
  /** Injectable OpenRouter client, for testing. */
  openRouterClient?: OpenRouterChatClient;
  /** Injectable fetch for OpenAI-compatible backends, for testing. */
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Instantiate a backend adapter from its definition. API keys are resolved
 * from the environment here; they are never stored in the configuration.
 */
export function buildBackend(
  backendId: string,
  def: BackendDef,
  options: BuildBackendOptions = {},
): InferenceBackend {
  const env = options.env ?? defaultEnvResolver;

  switch (def.type) {
    case "openrouter": {
      const apiKey = env(def.apiKeyEnv ?? "OPENROUTER_API_KEY");
      return new OpenRouterBackend({
        id: backendId,
        apiKey,
        client: options.openRouterClient,
      });
    }
    case "openai-compatible": {
      const apiKey = def.apiKeyEnv ? env(def.apiKeyEnv) : undefined;
      return new OpenAICompatibleBackend({
        id: backendId,
        baseUrl: def.baseUrl,
        apiKey,
        provenanceUrl: def.provenanceUrl,
        timeoutMs: def.timeoutMs,
        extraParams: def.extraParams,
        fetchFn: options.fetchFn,
      });
    }
    default: {
      const exhaustive: never = def;
      throw new Error(
        `Unsupported backend type: ${(exhaustive as BackendDef).type}`,
      );
    }
  }
}

/** Resolve the backend for a target id, validating the reference. */
export function buildBackendForTarget(
  config: ExperimentConfig,
  backendId: string,
  options: BuildBackendOptions = {},
): InferenceBackend {
  const def = config.backends[backendId];
  if (!def) {
    const available = Object.keys(config.backends).join(", ");
    throw new Error(
      `Unknown backend "${backendId}". Available backends: ${available || "(none)"}`,
    );
  }
  return buildBackend(backendId, def, options);
}
