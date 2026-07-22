# Execution Backend Architecture

Plinius executes evaluations through an **Execution Backend** abstraction so the
same campaign can run against OpenRouter, a local vLLM server, and (in future)
other inference services — without leaking any backend-specific concept into the
CLI or the evaluation logic.

## Architecture

```
CLI / commands
      │  (never depends on a concrete backend)
BackendRegistry ──get(name)──▶ ExecutionBackend
                                   ├─ OpenRouter  (src/backend/openrouter/)
                                   └─ vLLM        (src/backend/vllm/)
```

All backend code lives under `src/backend/` (singular). The pre-existing
`src/backends/` (plural) inference adapters are reused internally by the new
backends; they are not part of the public Execution Backend contract.

## Backend Interface (`src/backend/interface.ts`)

Every backend implements:

```
name() · version() · metadata()
capabilities(model?) · discoverModels() · resolveModel()
execute() · stream() · estimateCost() · provenance() · health()
```

Metadata: `backendName`, `backendVersion`, `vendor`, `apiVersion`.

**Common concepts only.** Anything vendor-specific (vLLM GPU / tensor-parallel /
KV-cache / FlashAttention, provider quantization, …) is carried in the opaque
`backendMetadata` extension field on `ModelDescriptor` and `ExecutionProvenance`,
never as a first-class interface field. This is what lets Anthropic / Gemini /
Ollama / SGLang backends be added later without breaking the contract.

## Capability model (`src/backend/capabilities.ts`)

Capabilities (`chat`, `completion`, `reasoning`, `jsonMode`, `structuredOutput`,
`vision`, `audio`, `toolCalling`, `seed`, `temperature`, `topP`, `topK`, `minP`,
`logprobs`, `streaming`, `batch`, `multimodal`) plus `maxContextLength` /
`maxOutputLength`.

Each capability is `supported`, `unsupported`, or `unknown`. **Capabilities
record facts only — never guesses.** Absence of evidence is `unknown`, not
`unsupported`. This preserves Plinius's fact/inference separation.

## Registry (`src/backend/registry.ts`)

Backends are obtained via `BackendRegistry`. Factories are lazy, so building the
registry needs no network or credentials. The default backend is `openrouter`.

```bash
plinius --backend openrouter ...
plinius --backend vllm ...
```

## OpenRouter backend

Wraps the catalog client, the OpenRouter SDK inference adapter, generation
provenance, and pricing. `discoverModels`/`resolveModel`/`capabilities` come from
a catalog snapshot; `resolveModel` resolves mutable aliases to canonical slugs.
Cost model: `METERED` (list-price estimate; actual cost reconciled via the
Generation API). Health checks API connectivity and authentication.

## vLLM backend

Targets only the OpenAI-compatible surface: `GET /v1/models`,
`POST /v1/chat/completions`, `POST /v1/completions`.

- **Discovery**: `GET /v1/models` → `id`, `owned_by`, `permission` (in
  `backendMetadata`), and `max_model_len` when present.
- **Resolution**: canonical only — no aliases.
- **Capabilities**: only contract-guaranteed facts (`chat`, `completion`,
  `streaming`) are `supported`; everything else is `unknown`.
- **Provenance**: execution-time provenance is built from the response. There is
  no generation-lookup endpoint, so `provenance(id)` returns `null`. Hardware
  provenance (CUDA / driver / GPU / TP / PP / quantization / KV cache /
  FlashAttention) is **`null` unless it can actually be observed** — never
  guessed — and lives in `backendMetadata`.
- **Cost model**: `FREE` (local execution).
- **Health**: `GET /v1/models` reachable and serving ≥1 model.

## Health check

```bash
plinius backend list
plinius backend info vllm
plinius backend health           # all backends
plinius backend health openrouter
```

## Provenance & runtime metrics

`execute()` returns `RuntimeMetrics` (latency, prompt/completion/total tokens,
prompt/generation TPS, queue time — `null` when unavailable) and an
`ExecutionProvenance` (backend, endpoint, model, requestId, seed, sampling,
finishReason, usage, plus `backendMetadata`).

## Cost model

`FREE` · `FIXED` · `METERED` · `UNKNOWN`. OpenRouter is `METERED`; vLLM defaults
to `FREE`. Cost stays separate from quality — there is no composite score.

## Manifest / Audit / Reproduce

Evaluation manifests record `backend`, `backendVersion`, `backendCapabilities`,
and `backendHealth` (all optional for backward compatibility). `plinius audit`
adds Backend Present / Backend Healthy / Capabilities Recorded / Runtime Metrics
Recorded checks. `plinius reproduce` reports a backend change (e.g. OpenRouter →
vLLM) and classifies such a run `PARTIALLY_REPRODUCIBLE`.

## Future backends

The interface is designed to also host: OpenAI Responses API, Anthropic Messages
API, Gemini API, Ollama, LM Studio, SGLang, llama.cpp, and HuggingFace TGI. Each
would map its vendor specifics into `backendMetadata` and declare only the
capabilities it can actually confirm.
