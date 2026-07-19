/**
 * Deployment-aware experiment configuration.
 *
 * A benchmark *target* couples a logical model to a concrete backend
 * deployment. The configuration keeps five identities distinct:
 *
 *   - target id            (`TargetConfig.id`)        — the benchmark selector
 *   - logical model        (`TargetConfig.model`)     — the model under study
 *   - served model name    (`TargetConfig.servedModelName`) — what the API wants
 *   - backend identity     (`TargetConfig.backend`)   — which deployment
 *   - runtime identity     (captured provenance)      — the running artifact
 */
import { SamplingConfig } from "../types/inference.js";
import { PromptProfileId } from "../prompts/profiles.js";
import { OpenRouterModels } from "../types/openrouter.js";

/** OpenRouter-hosted backend. */
export interface OpenRouterBackendDef {
  type: "openrouter";
  /** Environment variable holding the API key. Defaults to OPENROUTER_API_KEY. */
  apiKeyEnv?: string;
}

/** Generic OpenAI-compatible backend (vLLM, Ollama, LM Studio, ...). */
export interface OpenAICompatibleBackendDef {
  type: "openai-compatible";
  /** Base URL including version segment, e.g. http://vllm:8000/v1. */
  baseUrl: string;
  /** Environment variable holding the API key. Optional (unauthenticated ok). */
  apiKeyEnv?: string;
  /** Machine-readable runtime-provenance JSON endpoint, if the server exposes one. */
  provenanceUrl?: string;
  /** Default request timeout in milliseconds. */
  timeoutMs?: number;
  /** Additional request parameters merged into every request body. */
  extraParams?: Record<string, unknown>;
}

export type BackendDef = OpenRouterBackendDef | OpenAICompatibleBackendDef;

/** A benchmark target: a logical model bound to a backend deployment. */
export interface TargetConfig {
  /** Benchmark target ID used with `--target`. */
  id: string;
  /** Backend identity — a key in {@link ExperimentConfig.backends}. */
  backend: string;
  /** Logical model identity (what is being studied). */
  model: string;
  /**
   * Concrete served model name the backend expects. Defaults to `model`.
   * For vLLM this is the `--served-model-name` value.
   */
  servedModelName?: string;
  /** Deterministic seed for reproducibility, when the backend supports it. */
  seed?: number;
  /** Per-target sampling overrides merged over the run defaults. */
  sampling?: Partial<SamplingConfig>;
  /** Default prompt profile for this target (overridable on the CLI). */
  promptProfile?: PromptProfileId;
}

export interface ExperimentConfig {
  targets: TargetConfig[];
  backends: Record<string, BackendDef>;
}

/**
 * Default OpenRouter backend id used for the built-in OpenRouter targets.
 */
export const DEFAULT_OPENROUTER_BACKEND = "openrouter";

/**
 * Logical OpenRouter models turned into default benchmark targets so that
 * existing OpenRouter benchmarks keep running under the target model.
 */
const OPENROUTER_TARGET_MODELS: string[] = [
  OpenRouterModels.GPT_5_1,
  OpenRouterModels.CLAUDE_4_5_HAIKU,
  OpenRouterModels.GEMINI_3_PRO_PREVIEW,
  OpenRouterModels.GEMINI_2_5_PRO,
  OpenRouterModels.LLAMA_4_MAVERIC,
  OpenRouterModels.MISTRAL_MEDIUM_3_1,
  OpenRouterModels.DEEPSEEK_R1_0528,
  OpenRouterModels.GROK_4,
  OpenRouterModels.KIMI_K2_THINKING,
  OpenRouterModels.QWEN_3_MAX,
  OpenRouterModels.MINIMAX_M2,
  OpenRouterModels.PHI_4_REASONING_PLUS,
  OpenRouterModels.MAI_DS_R1,
];

/** Derive a stable, filesystem-friendly target id from an OpenRouter model. */
function openRouterTargetId(model: string): string {
  const short = model.split("/").pop() ?? model;
  return `${short.replace(/[^a-zA-Z0-9.]+/g, "-").toLowerCase()}-openrouter`;
}

/**
 * Default experiment configuration.
 *
 * Contains the pre-existing OpenRouter models (as targets) plus a local vLLM
 * smoke-test target. Edit this to add or remove targets and backends. The
 * vLLM container/GPU lifecycle is owned by AI-Playground, not Plinius.
 */
export const defaultExperimentConfig: ExperimentConfig = {
  backends: {
    [DEFAULT_OPENROUTER_BACKEND]: {
      type: "openrouter",
      apiKeyEnv: "OPENROUTER_API_KEY",
    },
    "local-vllm": {
      type: "openai-compatible",
      baseUrl: "http://vllm:8000/v1",
      apiKeyEnv: "VLLM_API_KEY",
      provenanceUrl: "http://vllm:8000/runtime-provenance",
    },
  },
  targets: [
    ...OPENROUTER_TARGET_MODELS.map<TargetConfig>((model) => ({
      id: openRouterTargetId(model),
      backend: DEFAULT_OPENROUTER_BACKEND,
      model,
    })),
    {
      id: "qwen-smoke-vllm",
      backend: "local-vllm",
      model: "Qwen/Qwen2.5-0.5B-Instruct",
      servedModelName: "Qwen/Qwen2.5-0.5B-Instruct",
      seed: 0,
    },
  ],
};

/** Look up a target by id, throwing a clear error if it is unknown. */
export function getTarget(
  config: ExperimentConfig,
  targetId: string,
): TargetConfig {
  const target = config.targets.find((t) => t.id === targetId);
  if (!target) {
    const available = config.targets.map((t) => t.id).join(", ");
    throw new Error(
      `Unknown target "${targetId}". Available targets: ${available || "(none)"}`,
    );
  }
  return target;
}

/** Resolve the served model name for a target (defaults to the logical model). */
export function resolvedServedModelName(target: TargetConfig): string {
  return target.servedModelName ?? target.model;
}
