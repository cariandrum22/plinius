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

### suites

List versioned benchmark suites discovered under `benchmark/suites/`, grouped by
domain, with version, difficulty, prototype flag, check count, and content hash.

```bash
plinius suites
```

### experiment

Run a versioned experiment: repeated runs of suite benchmarks against the
experiment's targets. Each repetition is persisted independently under
`benchmark/artifacts/experiments/<id>/`. Phase 1 runs sequentially.

```bash
plinius experiment --experiment <id|path>
```

- `--experiment <id>` resolves `benchmark/experiments/<id>.yaml` (a path is also
  accepted).

### matrix

Build a capability matrix (machine-readable JSON + derived Markdown) from a
completed experiment's run records. Raw domain-specific dimensions and derived
summary dimensions (quality / reliability / performance / cost) are kept
separate; prototype and infrastructure-validation entries are excluded from
rankings.

```bash
plinius matrix --experiment <id>
```

Output: `benchmark/artifacts/reports/matrix_<id>_<timestamp>.json` (+ `.md`).

For the full Phase 1 design, see [`phase1-evaluation.md`](phase1-evaluation.md).

### models

OpenRouter catalog synchronization and discovery. Sync writes immutable,
content-addressed snapshots and never modifies experiment or cohort definitions.

```bash
plinius models sync --backend openrouter        # OPENROUTER_API_KEY optional
plinius models sync --fixture <path>            # offline snapshot from a raw file
plinius models list --sort intelligence-high-to-low --min-context 131072 --zdr
plinius models inspect moonshotai/kimi-k3
plinius models diff <snapshot-a.json> <snapshot-b.json>
plinius models recommend                        # human-reviewable proposal only
```

Snapshots and recommendations are written under `benchmark/artifacts/catalog/`.
Cohorts, profiles, and budgets live in `benchmark/campaign/`. See the Japanese
guide [`online-campaign.ja.md`](online-campaign.ja.md).

### reproduce / audit

Reproducibility and provenance tooling over an evaluation manifest. See
[`reproducibility.md`](reproducibility.md).

```bash
plinius reproduce --manifest <manifest.json> [--catalog <snapshot.json>] [--prompt <prompt.json>]
plinius audit --manifest <manifest.json> [--prompt <prompt.json>]
```

`reproduce` verdicts: REPRODUCIBLE / PARTIALLY_REPRODUCIBLE / NOT_REPRODUCIBLE.
`audit` classifies each check OK / WARNING / ERROR.

### blind / human-review

Generate and manage blind human-review packets. Public commands never reveal
model identities; joining reviews to identities requires an explicit `unblind`.

```bash
plinius blind create --experiment <id> --config benchmark/blind-review/baseline-calibration.yaml
plinius blind inspect --review-set <id>
plinius blind validate --review-set <id>            # scans public artifacts for leakage
plinius human-review import --review-set <id> --input reviews.json [--update]
plinius human-review report --review-set <id>       # blind (blind IDs only)
plinius human-review report --review-set <id> --unblind
plinius human-review unblind --review-set <id>      # explicit; output is PRIVATE
```

Output lives under `benchmark/artifacts/blind-review/<id>/` with separate
`public/` (shareable) and `private/` (mapping + manifest) subtrees. See the
Japanese guide [`blind-review.ja.md`](blind-review.ja.md).

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
