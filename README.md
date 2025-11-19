# Plinius

Exploratory AI Project with OpenRouter integration and benchmarking system.

## Features

- TypeScript project with strict type checking
- OpenRouter SDK integration for multiple LLM providers
- Comprehensive benchmark system for evaluating model performance
- Environment variable management with type safety

## Setup

1. Install dependencies:
```bash
pnpm install
```

2. Configure environment variables:
```bash
cp .env.example .env
# Edit .env and add your OPENROUTER_API_KEY
```

3. Run in development mode:
```bash
pnpm run dev
```

## Benchmarks

The project includes a comprehensive benchmarking system with three categories:

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

### Running Benchmarks

```typescript
import { BenchmarkRunner } from "./src/benchmark/runner.js";
import { OpenRouterModels } from "./src/types/openrouter.js";
import { env } from "./src/env.js";

const runner = new BenchmarkRunner({
  apiKey: env.OPENROUTER_API_KEY!,
  model: OpenRouterModels.DEEPSEEK_R1,
});

// Run a single benchmark
const result = await runner.runBenchmarkById("A1");

// Run all benchmarks
const allResults = await runner.runAllBenchmarks();

// Run specific benchmarks
const results = await runner.runBenchmarksByIds(["A1", "B1", "C1"]);
```

### Example Script

```bash
pnpm run dev src/examples/run-benchmark.ts
```

## Evaluation System

The project includes an automated evaluation system that uses GPT-5.1 to assess benchmark responses according to a rigorous rubric.

### Evaluation Criteria

Each response is evaluated on 5 dimensions (0-5 points each, 25 points total):

1. **Structure** - Organization and logical flow
2. **Depth of Reasoning** - Insights, edge cases, and alternatives
3. **Consistency & Coherence** - Internal consistency and correctness
4. **Creativity & Concreteness** - Actionable proposals and specificity
5. **Domain-Specific Correctness** - Appropriate domain expertise

### Running Evaluation

```bash
pnpm run evaluate
```

This will:
- Discover all benchmark result files in `artifacts/result/`
- Evaluate each result using GPT-5.1 **in parallel (5 concurrent evaluations)**
  - **Staggered execution**: Workers start 1s apart, tasks start 500ms apart
  - Prevents rate limiting by avoiding simultaneous API calls
- Save evaluations to `artifacts/evaluation/`
- Generate summary report with average scores by model
- Support resume from interruption (skips already evaluated results)
- Retry failed evaluations with intelligent backoff:
  - Network errors: 5s, 10s, 15s
  - Other errors: 2s, 4s, 8s
- Handle truncated JSON responses gracefully

### Evaluation Output

- Individual evaluation results: `artifacts/evaluation/{benchmark}_{model}_evaluation_{timestamp}.json`
- Summary report: `artifacts/evaluation/summary_{timestamp}.md`
- Progress tracking: `artifacts/evaluation/progress.json`

### Cost Estimation

The evaluation system estimates ~6,000 tokens per evaluation (108 evaluations total):
- Estimated total: ~648,000 tokens
- Estimated cost: ~$2 (at $3/M tokens for GPT-5.1)
- With parallel execution: completes in ~15-20 minutes (vs 1-2 hours serial)

## Project Structure

```
.
├── artifacts/
│   ├── result/          # Benchmark results (108 markdown files)
│   └── evaluation/      # Evaluation results and summaries
├── benchmark/
│   └── prompt/          # Benchmark prompt files (A1.md - C3.md)
├── src/
│   ├── benchmark/       # Benchmark system
│   │   ├── loader.ts    # Load benchmark prompts
│   │   └── runner.ts    # Run benchmarks with OpenRouter
│   ├── evaluation/      # Evaluation system
│   │   ├── evaluator.ts # Evaluation logic with retry
│   │   ├── parser.ts    # Parse benchmark result files
│   │   ├── progress.ts  # Progress tracking and result saving
│   │   └── rubric.ts    # Evaluation rubric and prompts
│   ├── examples/        # Example scripts
│   ├── types/           # TypeScript type definitions
│   │   ├── benchmark.ts # Benchmark types
│   │   ├── evaluation.ts # Evaluation types
│   │   └── openrouter.ts # OpenRouter model types
│   ├── env.ts           # Environment configuration
│   ├── index.ts         # Benchmark execution entry point
│   └── evaluate.ts      # Evaluation execution entry point
├── flake.nix            # Nix development environment
└── package.json
```

## Available Models

The project supports multiple LLM providers via OpenRouter:

- OpenAI (GPT-5.1)
- Anthropic (Claude 4.5 Haiku, Sonnet)
- Google (Gemini 2.5 Pro)
- Meta (Llama 4 Maverick)
- Mistral (Mistral Medium 3.1, Devstral)
- DeepSeek (R1, R1-0528)
- xAI (Grok 4, Grok Code Fast)
- Moonshot AI (Kimi K2)
- Qwen (Qwen3 Max, Qwen3 Coder Plus)
- MiniMax (M1, M2)
- Microsoft (Phi-4, MAI-DS-R1)

## Scripts

- `pnpm run build` - Build TypeScript to JavaScript
- `pnpm run dev` - Run benchmark execution (all 12 models × 9 prompts)
- `pnpm run evaluate` - Run evaluation system (GPT-5.1 evaluates all results)
- `pnpm run start` - Run compiled JavaScript
- `pnpm run typecheck` - Type check without building

## Development Environment

This project uses Nix for reproducible development environments:

```bash
nix develop  # Enter development shell
```

Or use direnv for automatic environment loading:

```bash
direnv allow
```
