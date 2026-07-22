# Plinius

Backend-independent AI model benchmark & evaluation system with multi-evaluator
cross-validation. Benchmark targets are decoupled from any single provider: the
same runner evaluates OpenRouter-hosted models, a local **vLLM** deployment, or
any other OpenAI-compatible service (Ollama, LM Studio, ...).

## Features

- **Backend-independent runner** - One inference abstraction, many backends
  (OpenRouter, generic OpenAI-compatible / vLLM)
- **Deployment-aware targets** - A target binds a logical model to a concrete
  backend deployment; target id, logical model, served model name, backend id,
  and runtime identity are all kept distinct
- **External prompt profiles** - System prompts are experiment inputs
  (`none`, `neutral`, or custom); the exact rendered messages are persisted
- **Runtime provenance capture** - vLLM runtime/model/GPU provenance is attached
  to each result, with credentials stripped and missing fields marked
- **Canonical JSON artifacts** - Reproducible per-run records; Markdown is a
  derived view
- **Cross-Validation** - Evaluate with multiple evaluators
- **Phase 1 capability evaluation** - Versioned benchmark suites, an
  authority-ordered evaluator hierarchy (executable > structural > rule >
  judge), isolated file extraction + execution, repeated runs with aggregate
  statistics, and a raw/derived capability matrix. See
  [`docs/phase1-evaluation.md`](docs/phase1-evaluation.md).

## Phase 1 evaluation (quick start)

```bash
# List versioned benchmark suites (benchmark/suites/)
plinius suites

# Run the infrastructure-validation baseline against the vLLM smoke target,
# then build a capability matrix (excluded from rankings)
plinius experiment --experiment baseline-smoke
plinius matrix --experiment baseline-smoke
```

## Blind human review (Japanese)

Generate reproducible, identity-blinded Japanese review packets from experiment
run records, import human scores, and compare them with automated evaluation.
Model identities are removed from the reviewer packet and kept in a separate
private mapping; unblinding is an explicit operation. See
[`docs/blind-review.ja.md`](docs/blind-review.ja.md).

```bash
plinius blind create --experiment <id> --config benchmark/blind-review/baseline-calibration.yaml
plinius human-review import --review-set <id> --input reviews.json
plinius human-review report --review-set <id>            # blind IDs only
plinius human-review unblind --review-set <id>           # explicit
```

## Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env: add OPENROUTER_API_KEY (and VLLM_API_KEY if your vLLM needs auth)

# List configured targets
plinius targets

# Benchmark a local vLLM smoke-test model
plinius benchmark --target qwen-smoke-vllm

# Benchmark all configured targets, then evaluate and compare
plinius benchmark
plinius evaluate
plinius compare
```

## Backends & Targets

A **backend** describes a deployment; a **target** binds a logical model to a
backend. Both are configured in [`src/experiment/config.ts`](src/experiment/config.ts):

```typescript
export const defaultExperimentConfig: ExperimentConfig = {
  backends: {
    openrouter: { type: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
    "local-vllm": {
      type: "openai-compatible",
      baseUrl: "http://vllm:8000/v1",
      apiKeyEnv: "VLLM_API_KEY",              // optional
      provenanceUrl: "http://vllm:8000/runtime-provenance",
    },
  },
  targets: [
    {
      id: "qwen-smoke-vllm",                  // benchmark target id (--target)
      backend: "local-vllm",                  // backend identity
      model: "Qwen/Qwen2.5-0.5B-Instruct",    // logical model identity
      servedModelName: "Qwen/Qwen2.5-0.5B-Instruct", // what the API expects
      seed: 0,                                // optional deterministic seed
    },
    // ...OpenRouter targets
  ],
};
```

The vLLM container / GPU lifecycle is **not** managed by Plinius — that is the
responsibility of the [AI-Playground](https://github.com/cariandrum22) repo.
Plinius only consumes the OpenAI-compatible API and the optional
`runtime-provenance` JSON endpoint it exposes.

### Prompt profiles

System prompts are external inputs, selected per run:

```bash
plinius benchmark --target qwen-smoke-vllm --prompt-profile none     # no system prompt
plinius benchmark --target qwen-smoke-vllm --prompt-profile neutral  # neutral baseline
```

Profiles are defined in [`src/prompts/profiles.ts`](src/prompts/profiles.ts).
Chain-of-thought instructions are never added automatically. The exact rendered
messages are stored in every result record.

### Live vLLM integration test

Unit tests never touch the network. An opt-in test exercises a running vLLM:

```bash
PLINIUS_LIVE_VLLM=1 VLLM_BASE_URL=http://localhost:8000/v1 \
  VLLM_MODEL=Qwen/Qwen2.5-0.5B-Instruct pnpm test:integration
```

## CLI Usage

```bash
plinius <command> [options]

Commands:
  benchmark    Run benchmark prompts against configured targets
  targets      List configured benchmark targets
  evaluate     Evaluate benchmark results with multiple evaluators
  compare      Compare evaluations across evaluators
  clean        Remove benchmark artifacts

Benchmark options:
  --target <id>            Run a single target (default: all targets)
  --prompt-profile <id>    none | neutral | <custom>

Global options:
  -h, --help     Show help message
  -v, --version  Show version number

Examples:
  plinius targets                              # List configured targets
  plinius benchmark                            # Run all targets
  plinius benchmark --target qwen-smoke-vllm   # Run one target (vLLM)
  plinius benchmark --prompt-profile neutral   # Neutral baseline prompt
  plinius evaluate                             # Evaluate results
  plinius clean benchmark                      # Remove benchmark results
```

## Benchmark Categories

Prompts are automatically discovered from `benchmark/prompt/`.

**Note:** The included prompts are samples. You can modify or replace them with your own prompts.

#### A: Quantitative Finance & Algorithms

- **A1**: Abstract Market Generation Model Estimation
- **A2**: Constrained Alpha Construction
- **A3**: Portfolio Risk Decomposition

#### B: Formal Verification (F\*/Coq)

- **B1**: Monad Laws Proof Structure Design
- **B2**: F\* Dijkstra Monad for Non-Interference
- **B3**: Type-Level Secret Key Logging Prevention

#### C: Business Strategy & Decision Making

- **C1**: Decision Tree Under Uncertainty
- **C2**: Causal Modeling of Business Metrics
- **C3**: Strategic Analysis Through Abstraction

See [docs/prompts.md](docs/prompts.md) for prompt creation guidelines.

## Evaluation System

The multi-evaluator system uses three evaluators for cross-validation:

- **GPT-5.1** (OpenAI)
- **Claude Sonnet 4.5** (Anthropic)
- **Gemini 3.0 Preview** (Google)

### Evaluation Criteria

Each response is evaluated on 5 dimensions (0-5 points each, 25 points total):

1. **Structure** - Organization and logical flow
2. **Depth of Reasoning** - Insights, edge cases, and alternatives
3. **Consistency & Coherence** - Internal consistency and correctness
4. **Creativity & Concreteness** - Actionable proposals and specificity
5. **Domain-Specific Correctness** - Appropriate domain expertise

### Pipeline

```bash
# 1. Run benchmarks (models × prompts)
plinius benchmark

# 2. Evaluate with all evaluators (evaluators × results)
plinius evaluate

# 3. Generate comparison report
plinius compare
```

### Output Files

- **Benchmark results (canonical JSON)**: `benchmark/artifacts/result/{prompt}_{targetId}_{timestamp}.json`
- **Benchmark results (derived Markdown)**: `benchmark/artifacts/result/{prompt}_{targetId}_{timestamp}.md`
- **Evaluations**: `benchmark/artifacts/evaluation/{prompt}_{model}_{evaluator}_evaluation_{timestamp}.json`
- **Reports**: `benchmark/artifacts/reports/`

Each JSON record captures enough to reproduce the run: benchmark id + content
hash, target/backend/model identities, the exact messages, sampling parameters
and seed, response + token usage + latency + finish reason, runtime provenance,
the Plinius commit SHA, and error information for failed runs. Backend
credentials are never written to artifacts.

## Configuration

Benchmark targets and backends live in
[`src/experiment/config.ts`](src/experiment/config.ts) (see
[Backends & Targets](#backends--targets) above). Shared execution defaults
(max tokens, temperature, top-p) remain in `src/config.ts`, and evaluator
models are configured there too.

See [docs/configuration.md](docs/configuration.md) for detailed configuration options.

## Project Structure

```
.
├── benchmark/
│   ├── prompt/              # Benchmark prompts (A1.md - C3.md)
│   └── artifacts/
│       ├── result/          # Benchmark results
│       ├── evaluation/      # Evaluation results
│       └── reports/         # Generated reports
├── docs/
│   ├── prompts.md           # Prompt creation guide
│   ├── cli.md               # CLI reference
│   └── configuration.md     # Configuration guide
├── src/
│   ├── backends/            # Inference backend adapters
│   │   ├── openai-compatible.ts  # Generic OpenAI-compatible (vLLM, Ollama, ...)
│   │   ├── openrouter.ts    # OpenRouter adapter
│   │   └── factory.ts       # Build backends from config
│   ├── benchmark/           # Benchmark system
│   │   ├── loader.ts        # Load and discover prompts
│   │   └── runner.ts        # Backend-independent runner
│   ├── commands/            # CLI commands
│   │   ├── benchmark.ts     # Benchmark command (target-driven)
│   │   ├── targets.ts       # List targets
│   │   ├── evaluate.ts      # Evaluate command
│   │   ├── compare.ts       # Compare command
│   │   └── clean.ts         # Clean command
│   ├── experiment/
│   │   └── config.ts        # Targets & backends configuration
│   ├── prompts/
│   │   └── profiles.ts      # System prompt profiles
│   ├── evaluation/          # Evaluation system
│   ├── types/               # Domain types (inference, provenance, ...)
│   ├── cli.ts               # CLI entry point
│   ├── config.ts            # Execution defaults & evaluator models
│   └── env.ts               # Environment setup
├── test/                    # vitest unit + opt-in integration tests
├── flake.nix                # Nix development environment
└── package.json
```

## Available Models

The project supports 13+ models via OpenRouter:

| Provider    | Models                             |
| ----------- | ---------------------------------- |
| OpenAI      | GPT-5.1                            |
| Anthropic   | Claude 4.5 Haiku, Sonnet           |
| Google      | Gemini 3.0 Preview, Gemini 2.5 Pro |
| Meta        | Llama 4 Maverick                   |
| Mistral     | Mistral Medium 3.1                 |
| DeepSeek    | DeepSeek R1-0528                   |
| xAI         | Grok 4                             |
| Moonshot AI | Kimi K2 Thinking                   |
| Qwen        | Qwen3 Max                          |
| MiniMax     | MiniMax M2                         |
| Microsoft   | Phi-4 Reasoning Plus, MAI-DS-R1    |

## Scripts

```bash
pnpm run build            # Build TypeScript
pnpm run typecheck        # Type check only
pnpm run test             # Run unit tests (no network access required)
pnpm run test:integration # Opt-in live vLLM test (requires PLINIUS_LIVE_VLLM=1)
pnpm run targets          # List configured targets
pnpm run start            # Run compiled CLI
```

## Development Environment

This project uses Nix for reproducible development:

```bash
nix develop    # Enter development shell
```

Or use direnv:

```bash
direnv allow
```

## Documentation

- [CLI Reference](docs/cli.md)
- [Configuration Guide](docs/configuration.md)
- [Prompt Creation Guide](docs/prompts.md)
