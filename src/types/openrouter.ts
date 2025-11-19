/**
 * Type definitions for available models on OpenRouter
 */
export const OpenRouterModels = {
  // OpenAI Models
  GPT_5_1: "openai/gpt-5.1",

  // Anthropic Models
  CLAUDE_4_5_HAIKU: "anthropic/claude-haiku-4.5",
  CLAUDE_4_5_SONNET: "anthropic/claude-sonnet-4.5",

  // Google Models
  GEMINI_2_5_PRO: "google/gemini-2.5-pro",

  // Meta Models
  LLAMA_4_MAVERIC: "meta-llama/llama-4-maverick",

  // Mistral Models
  MISTRAL_MEDIUM_3_1: "mistralai/mistral-medium-3.1",
  DEVSTRAL_MEDIUM: "mistralai/devstral-medium",

  // DeepSeek Models
  DEEPSEEK_R1: "deepseek/deepseek-r1",
  DEEPSEEK_R1_0528: "deepseek/deepseek-r1-0528",

  // xAI Models (Grok)
  GROK_4_FAST: "x-ai/x-ai/grok-4-fast",
  GROK_CODE_FAST_1: "x-ai/grok-code-fast-1",
  GROK_4: "x-ai/grok-4",

  // Moonshot AI Models (Kimi)
  KIMI_LINEAR_48B_A3B_INSTRUCT: "moonshotai/kimi-linear-48b-a3b-instruct",
  KIMI_K2_THINKING: "moonshotai/kimi-k2-thinking",
  KIMI_K2_0905: "moonshotai/kimi-k2-0905",

  // Qwen Models
  QWEN_3_MAX: "qwen/qwen3-max",
  QWEN_3_CODER_PLUS: "qwen/qwen3-coder-plus",

  // MiniMax Models
  MINIMAX_M2: "minimax/minimax-m2",
  MINIMAX_M1: "minimax/minimax-m1",

  // Microsoft Models
  PHI_4_REASONING_PLUS: "microsoft/phi-4-reasoning-plus",
  MAI_DS_R1: "microsoft/mai-ds-r1",
  PHI_4_MULTIMODAL_INSTRUCT: "microsoft/phi-4-multimodal-instruct",
} as const;

/**
 * OpenRouterModel type: type of values from OpenRouterModels
 */
export type OpenRouterModel =
  (typeof OpenRouterModels)[keyof typeof OpenRouterModels];

/**
 * Model provider categories
 */
export enum ModelProvider {
  OpenAI = "openai",
  Anthropic = "anthropic",
  Google = "google",
  Meta = "meta",
  Mistral = "mistral",
  DeepSeek = "deepseek",
  XAI = "x-ai",
  Moonshot = "moonshot",
  Qwen = "qwen",
  MiniMax = "minimax",
  Microsoft = "microsoft",
}

/**
 * Get the provider from a model name
 */
export function getModelProvider(model: OpenRouterModel): ModelProvider {
  const provider = model.split("/")[0];
  switch (provider) {
    case "openai":
      return ModelProvider.OpenAI;
    case "anthropic":
      return ModelProvider.Anthropic;
    case "google":
      return ModelProvider.Google;
    case "meta-llama":
      return ModelProvider.Meta;
    case "mistralai":
      return ModelProvider.Mistral;
    case "deepseek":
      return ModelProvider.DeepSeek;
    case "x-ai":
      return ModelProvider.XAI;
    case "moonshot":
    case "moonshotai":
      return ModelProvider.Moonshot;
    case "qwen":
      return ModelProvider.Qwen;
    case "minimax":
      return ModelProvider.MiniMax;
    case "microsoft":
      return ModelProvider.Microsoft;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
