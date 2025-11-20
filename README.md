# Plinius

AI Model Benchmark & Evaluation System with multi-evaluator cross-validation.

## Features

- **Unified CLI** - Single entry point for all operations
- **Multi-Model Benchmarking** - Test 13+ models across multiple providers
- **Cross-Validation** - Evaluate with multiple evaluators (GPT-5.1, Claude Sonnet 4.5, Gemini 3.0)
- **Dynamic Configuration** - Auto-discovery of prompts and configurable model lists
- **Detailed Reports** - Markdown reports with rankings, analysis, and insights

## Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env and add your OPENROUTER_API_KEY

# Run the full pipeline
plinius benchmark    # Run benchmarks
plinius evaluate     # Evaluate results
plinius compare      # Generate reports
```

## CLI Usage

```bash
plinius <command> [options]

Commands:
  benchmark    Run benchmark prompts against models
  evaluate     Evaluate benchmark results with multiple evaluators
  compare      Compare evaluations across evaluators
  clean        Remove benchmark artifacts

Options:
  -h, --help     Show help message
  -v, --version  Show version number

Examples:
  plinius benchmark              # Run all benchmarks
  plinius evaluate               # Evaluate results with all evaluators
  plinius compare                # Generate comparison report
  plinius clean                  # Remove all artifacts
  plinius clean benchmark        # Remove only benchmark results
  plinius clean evaluate         # Remove only evaluation data
  plinius clean reports          # Remove only reports
```

## Benchmark Categories

Prompts are automatically discovered from `benchmark/prompt/`.

### A: Quantitative Finance & Algorithms
- **A1**: Abstract Market Generation Model Estimation
- **A2**: Constrained Alpha Construction
- **A3**: Portfolio Risk Decomposition

### B: Formal Verification (F*/Coq)
- **B1**: Monad Laws Proof Structure Design
- **B2**: F* Dijkstra Monad for Non-Interference
- **B3**: Type-Level Secret Key Logging Prevention

### C: Business Strategy & Decision Making
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

- **Benchmark results**: `benchmark/artifacts/result/{prompt}_{model}_{timestamp}.md`
- **Evaluations**: `benchmark/artifacts/evaluation/{prompt}_{model}_{evaluator}_evaluation_{timestamp}.json`
- **Reports**: `benchmark/artifacts/reports/`

## Configuration

Edit `src/config.ts` to customize:

```typescript
// Models to benchmark
export const BENCHMARK_MODELS: OpenRouterModel[] = [
  OpenRouterModels.GPT_5_1,
  OpenRouterModels.CLAUDE_4_5_HAIKU,
  OpenRouterModels.GEMINI_3_0_PREVIEW,
  // ... add or remove models
];

// Models to use as evaluators
export const EVALUATOR_MODELS: OpenRouterModel[] = [
  OpenRouterModels.GPT_5_1,
  OpenRouterModels.CLAUDE_4_5_SONNET,
  OpenRouterModels.GEMINI_3_0_PREVIEW,
];
```

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
│   ├── benchmark/           # Benchmark system
│   │   ├── loader.ts        # Load and discover prompts
│   │   └── runner.ts        # Run benchmarks
│   ├── commands/            # CLI commands
│   │   ├── benchmark.ts     # Benchmark command
│   │   ├── evaluate.ts      # Evaluate command
│   │   ├── compare.ts       # Compare command
│   │   └── clean.ts         # Clean command
│   ├── evaluation/          # Evaluation system
│   │   ├── evaluator.ts     # Evaluation logic
│   │   ├── parser.ts        # Parse result files
│   │   ├── progress.ts      # Progress tracking
│   │   └── rubric.ts        # Evaluation rubric
│   ├── types/               # TypeScript definitions
│   ├── cli.ts               # CLI entry point
│   ├── config.ts            # Central configuration
│   └── env.ts               # Environment setup
├── flake.nix                # Nix development environment
└── package.json
```

## Available Models

The project supports 13+ models via OpenRouter:

| Provider | Models |
|----------|--------|
| OpenAI | GPT-5.1 |
| Anthropic | Claude 4.5 Haiku, Sonnet |
| Google | Gemini 3.0 Preview, Gemini 2.5 Pro |
| Meta | Llama 4 Maverick |
| Mistral | Mistral Medium 3.1 |
| DeepSeek | DeepSeek R1-0528 |
| xAI | Grok 4 |
| Moonshot AI | Kimi K2 Thinking |
| Qwen | Qwen3 Max |
| MiniMax | MiniMax M2 |
| Microsoft | Phi-4 Reasoning Plus, MAI-DS-R1 |

## Scripts

```bash
pnpm run build      # Build TypeScript
pnpm run typecheck  # Type check only
pnpm run start      # Run compiled CLI
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
