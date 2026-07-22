# Phase 1 Evaluation System

Plinius Phase 1 turns the tool from a general multi-model comparison into a
**capability-evaluation system**: it asks *whether a given local model can
produce expert-level output in a specific domain, and under which
configuration* — not which model is cheapest or fastest.

The pipeline is:

```
benchmark suite (YAML, versioned)
   → experiment (targets × repetitions)
      → run record (canonical JSON, per repetition)
         → deterministic evaluators (executable > structural > rule)
         → LLM judges (decoupled, re-appliable)
            → aggregate verdict (qualified | disqualified | inconclusive | infrastructure_error)
               → capability matrix (raw + derived dimensions)
```

Every layer is independently schema-versioned: benchmark definitions
(`BENCHMARK_SCHEMA_VERSION`), experiments (`EXPERIMENT_SCHEMA_VERSION`), run
records (`BENCHMARK_RECORD_SCHEMA_VERSION`), and the matrix
(`MATRIX_SCHEMA_VERSION`).

## Benchmark suites

Versioned definitions live under `benchmark/suites/<domain>/<id>/`:

```
benchmark/suites/coding/code-ts-001/
  benchmark.yaml     # validated definition (Zod)
  task.md            # task prose
  fixtures/…         # copied into the run workspace (trusted)
  reference/…        # optional reference answer
```

`benchmark.yaml` is **YAML on input only**: it is parsed, then validated and
normalized by a strict Zod schema. Only the normalized domain object is used
internally. Required fields include a stable kebab-case `id` (must equal the
folder name), semantic `version`, `domain`, `difficulty`
(`medium` | `advanced` | `expert`), task text, expected output format, required
constraints, deterministic checks, an LLM-judge rubric, `qualification`
thresholds, `timeoutMs`, `maxOutputTokens`, `tags`, `knownFailureModes`, and a
`prototype` flag.

**Difficulty** reflects realistic professional complexity: *medium* = one
bounded component with explicit constraints; *advanced* = multiple interacting
components with incomplete requirements; *expert* = ambiguous, high-risk,
multi-domain judgment.

**Content hash.** Each benchmark's `contentHash` is a sha256 over the *entire*
canonical input — the validated definition (including rubric and checks), the
task text, and the bytes of every fixture and reference file — so any change to
any input yields a new hash.

List discovered suites:

```bash
plinius suites
```

## Evaluation hierarchy

Evaluators are ordered by authority; a higher-authority verdict is never
silently overridden by a lower one:

1. **executable verifier** — ran a real tool/build/test
2. **deterministic structural checker** — sections, regex, JSON Schema, files
3. **domain-specific rule evaluator**
4. **pairwise LLM judge**
5. **scalar LLM score**

Deterministic evaluators implement a common interface and report
`pass | fail | not_available | error` plus `version`, `authority`, `blocking`,
and structured `evidence`. A blocking check that is `not_available` (missing
tool) makes the result **inconclusive**, never a failure.

### Execution sandbox

All process execution goes through a replaceable `ExecutionSandbox` boundary.
The initial `LocalProcessSandbox` runs commands as ordinary child processes via
`execFile` (no shell, so no argument interpolation).

> **`LocalProcessSandbox` is not a security sandbox.** It isolates the working
> directory and enforces timeouts, but does not confine filesystem, network, or
> syscall access. It only ever runs benchmark-author-defined, allowlisted
> executables with author-defined argv — never commands derived from model
> output.

Allowlisted tools: `node`, `python3`, `cargo`, `tlc`, `apalache-mc`, `lean`,
`coqc`, `tamarin-prover`, `fst`. Unavailable tools are reported `not_available`.

### Coding benchmarks (generated files)

For coding tasks, generated multi-file artifacts are extracted from model
output (a `{"files":[…]}` JSON envelope, or fenced blocks labeled with a path).
Every path is validated against traversal (`..`), absolute paths, Windows/UNC
paths, backslashes, NUL bytes, drive letters, empty segments, and collisions,
and total size / per-file size / file-count limits are enforced. Files are
written into an isolated workspace (fixtures first, then model files with a
`wx` open so a model file can never overwrite a fixture or follow a symlink),
then the configured build/test commands run in the sandbox.

## Experiments and repetition

An experiment (`benchmark/experiments/<id>.yaml`) configures repetitions, seed
strategy (`fixed` | `varying`), sampling, timeout, and concurrency
(Phase 1 defaults to sequential). Each repetition is persisted **independently**
under `benchmark/artifacts/experiments/<id>/`.

```bash
plinius experiment --experiment baseline-smoke
```

Aggregate statistics are computed over repetitions: mean, median, standard
deviation, min, max, pass rate, **catastrophic** failure rate (a badly-failing
answer) and **infrastructure** failure rate (environment/backend failure — kept
separate), and evaluator disagreement rate.

### Aggregate verdict

`aggregate()` produces one of:

- `qualified` — every mandatory threshold satisfied
- `disqualified` — a mandatory threshold violated (a real failure)
- `inconclusive` — a required verifier was `not_available`, or a minimum domain
  score was required but no judge ran
- `infrastructure_error` — runs failed for environmental reasons

Qualification thresholds are per-benchmark:

```yaml
qualification:
  deterministicPassRate: 1.0
  minimumDomainScore: 4.0
  maximumCatastrophicFailureRate: 0.0
  maximumEvaluatorDisagreement: 0.25
```

## LLM judges (decoupled)

Judges only need the persisted candidate text plus the rubric, so they are
independent of generation and of deterministic evaluation and can be
(re-)applied to already stored run records (`applyJudgesToRecord`). Judges are
the lowest authority and never override an executable failure.

## Capability matrix

```bash
plinius matrix --experiment baseline-smoke
```

The matrix (`benchmark/artifacts/reports/matrix_<id>_<ts>.json` + `.md`)
separates two layers and does **not** collapse them into a single composite
score:

- **Raw dimensions** — measured, domain-specific: per-domain scores plus
  Japanese output quality, instruction adherence, refusal rate, formatting
  validity.
- **Derived summary dimensions** — `quality`, `reliability`, `performance`,
  `cost`, kept apart.

**Cost** is itself separated into provider (monetary) cost, latency,
GPU-seconds, and VRAM; any dimension may be `null` when not measurable for a
deployment (e.g. a self-hosted vLLM has no per-token price).

**Prototype** benchmarks and **infrastructure-validation** experiments are
excluded from rankings and qualification, though their measured values still
appear for visibility.

## Baseline (infrastructure validation)

`benchmark/experiments/baseline-smoke.yaml` runs the tiny
`Qwen/Qwen2.5-0.5B-Instruct` vLLM smoke target purely to validate the pipeline.
It is marked `purpose: infrastructure-validation` / `excludeFromRankings: true`
and must never appear in serious model rankings.

## Candidate models (placeholders)

`src/models/registry.ts` lists placeholder model families (DeepSeek-R1 distill,
Qwen reasoning/coder, GLM, Kimi, Llama, smoke-test) with logical identities and
suggested served names. Plinius does **not** download or deploy models —
deployment is owned by AI-Playground.

## Integration testing

- Deterministic tools: install any of the allowlisted tools to exercise real
  `command` checks; without them, those checks report `not_available` and the
  suite still passes.
- Live vLLM: set `PLINIUS_LIVE_VLLM=1` and run `pnpm test:integration` to run
  the opt-in smoke test against a running vLLM server.
- Full pipeline dry-run (needs a reachable vLLM target):
  `plinius experiment --experiment baseline-smoke && plinius matrix --experiment baseline-smoke`.
