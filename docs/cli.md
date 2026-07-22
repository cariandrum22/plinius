# CLI Reference

Plinius provides a unified command-line interface for running benchmarks, evaluations, and comparisons.

## Installation

After building the project, the CLI is available as `plinius`:

```bash
pnpm run build
```

## Commands

### benchmark

Run benchmark prompts against configured models.

```bash
plinius benchmark [--target <id>] [--prompt-profile <id>]
```

**What it does:**
- Discovers all `.md` files in `benchmark/prompt/`
- Runs each prompt against the selected target(s) via their backend
- Captures runtime provenance for each target (when available)
- Saves a canonical JSON record and a derived Markdown view to
  `benchmark/artifacts/result/`
- Skips runs whose JSON record already exists (resume)

**Options:**
- `--target <id>` — run a single configured target (default: all targets).
  List targets with `plinius targets`.
- `--prompt-profile <id>` — `none` | `neutral` | a custom profile id.

**Output format:** `{prompt}_{targetId}_{timestamp}.json` (+ `.md`)

**Example:**
```bash
plinius benchmark --target qwen-smoke-vllm
# === Plinius Benchmark Runner ===
# Targets: qwen-smoke-vllm
# Prompts: 9
# ...
# ✓ A1 → qwen-smoke-vllm (812ms, 1324 tokens) → A1_qwen-smoke-vllm_....json
```

### targets

List configured benchmark targets and their backends.

```bash
plinius targets
```

### evaluate

Evaluate benchmark results with multiple evaluators.

```bash
plinius evaluate
```

**What it does:**
- Discovers all result files in `benchmark/artifacts/result/`
- Evaluates each result with all models in `EVALUATOR_MODELS`
- Saves evaluations to `benchmark/artifacts/evaluation/`
- Supports resume from interruption (skips existing evaluations)

**Output format:** `{prompt}_{model}_{evaluator}_evaluation_{timestamp}.json`

**Features:**
- Parallel execution (5 concurrent evaluations)
- Automatic retry with backoff
- Progress tracking
- Cost estimation

### compare

Generate comparison reports across evaluators.

```bash
plinius compare
```

**What it does:**
- Loads all evaluation results
- Calculates average scores across evaluators
- Generates rankings by category and overall
- Analyzes evaluator agreement and potential biases
- Saves reports to `benchmark/artifacts/reports/`

**Output files:**
- `comparison_{timestamp}.md` - Full comparison report
- `rankings_{timestamp}.md` - Model rankings
- `summary_{timestamp}.md` - Executive summary

### clean

Remove benchmark artifacts.

```bash
plinius clean [target]
```

**Targets:**
- `benchmark` - Remove only benchmark results
- `evaluate` - Remove only evaluation data
- `reports` - Remove only reports
- `all` (default) - Remove all artifacts

**Examples:**
```bash
plinius clean              # Remove all artifacts
plinius clean benchmark    # Remove only benchmark results
plinius clean evaluate     # Remove only evaluation data
plinius clean reports      # Remove only reports
```

**Behavior:**
- Shows summary before deletion (file count, size)
- Preserves `.gitkeep` files in directories
- Reports what was deleted

## Options

### Help

```bash
plinius --help
plinius -h
```

### Version

```bash
plinius --version
plinius -v
```

## Examples

### Full Pipeline

```bash
# 1. Run benchmarks on all models
plinius benchmark

# 2. Evaluate all results
plinius evaluate

# 3. Generate comparison report
plinius compare
```

### Fresh Start

```bash
# Clean everything and start over
plinius clean
plinius benchmark
plinius evaluate
plinius compare
```

### Re-run Evaluation Only

```bash
# Clean evaluations but keep benchmark results
plinius clean evaluate
plinius clean reports
plinius evaluate
plinius compare
```

## Environment Variables

The CLI requires:

```bash
OPENROUTER_API_KEY=your-api-key-here
```

Set this in `.env` file or export directly.

## Exit Codes

- `0` - Success
- `1` - Error (unknown command, execution error)

## Notes

- All paths are relative to the current working directory
- The CLI expects `benchmark/prompt/` and `benchmark/artifacts/` to exist
- Results include timestamps to avoid overwriting previous runs
- Parallel execution helps with large benchmark runs
