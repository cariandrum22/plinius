# Configuration Guide

Plinius separates two concerns:

- **Deployment-aware targets & backends** — `src/experiment/config.ts`
  (which model, on which backend deployment). This is what `plinius benchmark`
  and `plinius targets` read.
- **Execution defaults & evaluator models** — `src/config.ts`
  (max tokens / temperature / top-p, and the evaluator model list).

## Backends & Targets (`src/experiment/config.ts`)

A **backend** is a deployment; a **target** binds a logical model to a backend.
Plinius intentionally keeps five identities distinct:

| Identity            | Field                       | Example                        |
| ------------------- | --------------------------- | ------------------------------ |
| Benchmark target ID | `TargetConfig.id`           | `qwen-smoke-vllm`              |
| Logical model       | `TargetConfig.model`        | `Qwen/Qwen2.5-0.5B-Instruct`  |
| Served model name   | `TargetConfig.servedModelName` | `Qwen/Qwen2.5-0.5B-Instruct` |
| Backend identity    | `TargetConfig.backend`      | `local-vllm`                  |
| Runtime identity    | captured provenance         | image digest, revision, ...    |

```typescript
export const defaultExperimentConfig: ExperimentConfig = {
  backends: {
    openrouter: { type: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
    "local-vllm": {
      type: "openai-compatible",
      baseUrl: "http://vllm:8000/v1",
      apiKeyEnv: "VLLM_API_KEY",              // optional; omit for open servers
      provenanceUrl: "http://vllm:8000/runtime-provenance", // optional
      // timeoutMs, extraParams are also supported
    },
  },
  targets: [
    {
      id: "qwen-smoke-vllm",
      backend: "local-vllm",
      model: "Qwen/Qwen2.5-0.5B-Instruct",
      servedModelName: "Qwen/Qwen2.5-0.5B-Instruct",
      seed: 0,
      // sampling: { temperature: 0 }, promptProfile: "neutral"
    },
  ],
};
```

### Backend types

- `openrouter` — the hosted OpenRouter router. Requires an API key
  (`apiKeyEnv`, default `OPENROUTER_API_KEY`).
- `openai-compatible` — any service speaking the OpenAI `/chat/completions`
  contract: **vLLM**, Ollama, LM Studio, etc. `baseUrl` must include the API
  version segment (e.g. `/v1`). API key is optional. `provenanceUrl` points at
  a machine-readable runtime-provenance JSON endpoint if the server exposes one.

Credentials are resolved from the environment at runtime via `apiKeyEnv`; they
are never stored in configuration or written to result artifacts.

### Prompt profiles (`src/prompts/profiles.ts`)

System prompts are external experiment inputs. Built-in profiles:

- `none` — no system prompt (only the user message)
- `neutral` — a minimal neutral baseline (`"You are a helpful assistant."`)

Add named profiles to `PROMPT_PROFILES`. Chain-of-thought instructions are never
added automatically. Select a profile with `--prompt-profile <id>` or per-target
via `TargetConfig.promptProfile`. The exact rendered messages are persisted in
every result record.

### Runtime provenance

For `openai-compatible` backends with a `provenanceUrl`, Plinius fetches the
runtime-provenance JSON once per target and attaches it to each result. Expected
(all fields optional; unavailable ones are marked in `missingFields`):

```json
{
  "runtime": { "name": "vllm", "version": "0.6.3" },
  "container": { "image": "vllm/vllm-openai:v0.6.3", "digest": "sha256:..." },
  "model": { "repo": "Qwen/Qwen2.5-0.5B-Instruct", "revision": "main", "servedName": "..." },
  "engine": { "dtype": "bfloat16", "quantization": null, "tensorParallelSize": 1, "maxModelLen": 32768 },
  "gpu": { "count": 1, "model": "NVIDIA A10G" },
  "vllmArgs": { "--gpu-memory-utilization": 0.9 }
}
```

The parser tolerates common `snake_case`/flat key spellings. A missing
provenance endpoint never fails an otherwise valid benchmark. The vLLM
container/GPU lifecycle is owned by AI-Playground, not Plinius.

---

## Execution defaults (`src/config.ts`)

`src/config.ts` holds shared benchmark parameters, evaluator models, and cost
estimation helpers.

## Model Configuration

### Benchmark Models (deprecated)

> **Deprecated.** Benchmark selection is now target-driven — see
> [Backends & Targets](#backends--targets-srcexperimentconfigts). `BENCHMARK_MODELS`
> is no longer read by the runner and is kept only for reference.

Historically, models tested during benchmark runs were listed as:

```typescript
export const BENCHMARK_MODELS: OpenRouterModel[] = [
  OpenRouterModels.GPT_5_1,
  OpenRouterModels.CLAUDE_4_5_HAIKU,
  OpenRouterModels.GEMINI_3_0_PREVIEW,
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
```

Add or remove models from this list to customize your benchmark runs.

### Evaluator Models

Models that evaluate benchmark responses:

```typescript
export const EVALUATOR_MODELS: OpenRouterModel[] = [
  OpenRouterModels.GPT_5_1,
  OpenRouterModels.CLAUDE_4_5_SONNET,
  OpenRouterModels.GEMINI_3_0_PREVIEW,
];
```

Using multiple evaluators enables cross-validation and reduces evaluator bias.

## Available Models

All available models are defined in `src/types/openrouter.ts`:

```typescript
export const OpenRouterModels = {
  // OpenAI
  GPT_5_1: "openai/gpt-5.1",

  // Anthropic
  CLAUDE_4_5_HAIKU: "anthropic/claude-haiku-4.5",
  CLAUDE_4_5_SONNET: "anthropic/claude-sonnet-4.5",

  // Google
  GEMINI_3_0_PREVIEW: "google/gemini-3.0-preview",
  GEMINI_2_5_PRO: "google/gemini-2.5-pro",

  // Meta
  LLAMA_4_MAVERIC: "meta-llama/llama-4-maverick",

  // Mistral
  MISTRAL_MEDIUM_3_1: "mistralai/mistral-medium-3.1",
  DEVSTRAL_MEDIUM: "mistralai/devstral-medium",

  // DeepSeek
  DEEPSEEK_R1: "deepseek/deepseek-r1",
  DEEPSEEK_R1_0528: "deepseek/deepseek-r1-0528",

  // xAI
  GROK_4: "x-ai/grok-4",
  GROK_4_FAST: "x-ai/x-ai/grok-4-fast",
  GROK_CODE_FAST_1: "x-ai/grok-code-fast-1",

  // Moonshot AI
  KIMI_K2_THINKING: "moonshotai/kimi-k2-thinking",
  KIMI_K2_0905: "moonshotai/kimi-k2-0905",

  // Qwen
  QWEN_3_MAX: "qwen/qwen3-max",
  QWEN_3_CODER_PLUS: "qwen/qwen3-coder-plus",

  // MiniMax
  MINIMAX_M2: "minimax/minimax-m2",
  MINIMAX_M1: "minimax/minimax-m1",

  // Microsoft
  PHI_4_REASONING_PLUS: "microsoft/phi-4-reasoning-plus",
  MAI_DS_R1: "microsoft/mai-ds-r1",
};
```

## Benchmark Parameters

Default execution parameters:

```typescript
export const defaultBenchmarkConfig: BenchmarkConfig = {
  maxTokens: 16000,      // Maximum response tokens
  temperature: 0.1,      // Low temperature for consistent results
  topP: 0.95,            // Nucleus sampling parameter
};
```

### Interfaces

```typescript
export interface BenchmarkConfig {
  maxTokens: number;
  temperature: number;
  topP: number;
}
```

## Cost Estimation

Configure cost estimation parameters:

```typescript
export const defaultCostConfig: CostConfig = {
  estimatedPromptTokens: 2000,           // Average input tokens per task
  estimatedCompletionTokens: 12000,      // Average output tokens per task
  costPerMillionPromptTokens: 2.0,       // $/1M input tokens
  costPerMillionCompletionTokens: 6.0,   // $/1M output tokens
};
```

### Usage

```typescript
import { estimateCost, defaultCostConfig } from "./config.js";

const totalTasks = 117; // 13 models × 9 prompts
const estimate = estimateCost(totalTasks, defaultCostConfig);

console.log(`Total tokens: ${estimate.totalPromptTokens + estimate.totalCompletionTokens}`);
console.log(`Estimated cost: $${estimate.totalCost.toFixed(2)}`);
```

## Utility Functions

### Model Name Helpers

```typescript
// Get short name from model ID
getShortModelName("openai/gpt-5.1");           // "gpt-5.1"

// Get display name
getDisplayModelName("openai/gpt-5.1");         // "GPT-5.1"

// Get provider
getModelProvider("anthropic/claude-haiku-4.5"); // "anthropic"

// Sanitize for filenames
sanitizeModelName("openai/gpt-5.1");           // "openai_gpt-5.1"
```

### Prompt Discovery

```typescript
import { discoverBenchmarkIds, getPromptDir } from "./config.js";

// Get prompt directory path
const dir = getPromptDir(); // "{cwd}/benchmark/prompt"

// Discover all benchmark IDs
const ids = await discoverBenchmarkIds(); // ["A1", "A2", "A3", ...]
```

## Environment Variables

Required:

```bash
OPENROUTER_API_KEY=your-api-key-here
```

Set in `.env` file:

```bash
cp .env.example .env
# Edit .env and add your API key
```

## Directory Structure

The configuration assumes this directory structure:

```
{cwd}/
├── benchmark/
│   ├── prompt/              # Benchmark prompts
│   └── artifacts/
│       ├── result/          # Benchmark results
│       ├── evaluation/      # Evaluation data
│       └── reports/         # Generated reports
```

## Adding New Models

1. Add the model to `src/types/openrouter.ts`:

```typescript
export const OpenRouterModels = {
  // ... existing models
  NEW_MODEL: "provider/model-name",
};
```

2. Add to `src/config.ts` arrays as needed:

```typescript
export const BENCHMARK_MODELS: OpenRouterModel[] = [
  // ... existing models
  OpenRouterModels.NEW_MODEL,
];
```

3. If the provider is new, update the `getModelProvider()` function in `src/types/openrouter.ts`.

## Best Practices

1. **Start small**: Test with 1-2 models before running full benchmarks
2. **Monitor costs**: Use `estimateCost()` to check before large runs
3. **Balance evaluators**: Use evaluators from different providers to reduce bias
4. **Keep prompts consistent**: Store prompts in `benchmark/prompt/` with clear naming
