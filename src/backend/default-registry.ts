/**
 * Default backend registry wiring. Factories are lazy: building the registry
 * requires no network access or credentials.
 */
import { resolveEnv } from "../env.js";
import { BackendRegistry } from "./registry.js";
import { OpenRouterExecutionBackend } from "./openrouter/index.js";
import { VllmExecutionBackend } from "./vllm/index.js";

export function createDefaultRegistry(): BackendRegistry {
  const registry = new BackendRegistry();
  registry.register("openrouter", () => new OpenRouterExecutionBackend({ apiKey: resolveEnv("OPENROUTER_API_KEY") }));
  registry.register(
    "vllm",
    () =>
      new VllmExecutionBackend({
        baseUrl: resolveEnv("VLLM_BASE_URL") ?? "http://localhost:8000/v1",
        apiKey: resolveEnv("VLLM_API_KEY"),
      }),
  );
  return registry;
}
