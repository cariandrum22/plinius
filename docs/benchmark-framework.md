# Benchmark Framework & Campaign Execution

Phase F turns Plinius from an evaluation *engine* into an evaluation *platform*:
you define **Benchmarks** (evaluation assets), run **Campaigns** (execution
plans), collect **blind human reviews**, and generate reproducible model
evaluation **reports**. It reuses the existing Execution Backend, Prompt
Snapshot, Manifest, Environment, and Provenance primitives — it adds the layer
that ties them into a workflow.

No LLM judge, automated scoring, statistics, Elo/Bradley-Terry, leaderboard, or
web UI are part of this phase — those are explicit non-goals, layered on later.

## Benchmark concept

A **Benchmark** is a backend-independent evaluation asset. It holds a prompt and
a rubric but **never any scores**. Benchmarks live under `benchmark/<category>/`:

```
benchmark/
  software-engineering/
  architecture/
  security/
  formal-reasoning/
  common/               # shared, non-runnable assets (no benchmark.yaml)
```

## Asset structure

Each benchmark is a directory `benchmark/<category>/<id>/`:

```
metadata.yaml    # schema fields
system.md        # the reusable system prompt
user.md          # the task-specific user prompt
rubric.yaml      # evaluation criteria + weights only — never expected answers
references.md    # intent / assumptions / reviewer notes (no leaked solution)
```

**metadata.yaml** — `version` is SemVer; keys may be snake_case (normalized to
camelCase on load). `golden: true` marks longitudinal benchmarks held stable
across releases:

```yaml
id: sec-jwt-review
title: Security review of a JWT authentication flow
version: 1.0.0
category: security
difficulty: hard              # easy | medium | hard | expert
estimated_tokens: 2500
tags: [threat-analysis, security-review]
author: plinius-benchmarks
license: CC-BY-4.0
golden: true
```

**system.md / user.md** — the system and user prompts are kept in **separate
files** and never concatenated. The system prompt is written to be reusable
across benchmarks in a category; the user prompt carries the specific task.

**rubric.yaml** (evaluation criteria only) — a map of criterion name to weight.
Weights are relative and need not sum to 100. Rubrics hold **criteria and
weights only — never expected answers**:

```yaml
Correctness:
  weight: 40
Threat coverage:
  weight: 35
Safe design:
  weight: 25
```

**references.md** — explains the benchmark's intent, assumptions, and reviewer
notes. It must **not reveal the expected solution**; it is documentation for
reviewers and is excluded from the executable content hash.

Inspect assets:

```bash
plinius benchmark list
plinius benchmark show sec-jwt-review
```

The loader computes one canonical content hash over `{metadata, system, user,
rubric}` (no timestamp, references excluded), so an unchanged asset always
hashes identically.

## Campaign concept

A **Campaign** is an *execution plan* over benchmarks. Benchmarks are
backend-independent; the campaign is where backend and model selection happen.
Campaigns live at `campaign/<id>.yaml`:

```yaml
schema_version: 1
id: pilot-frontier
title: Frontier pilot
benchmarks: all                 # "all", or a list of ids / pinned {id, version}
backends: [vllm]
models: [Qwen/Qwen2.5-0.5B-Instruct]
sampling:
  temperature: 0
  seed: 1
  seed_strategy: fixed          # fixed | varying
repetitions: 1
exclude_from_rankings: true
```

A campaign may pin `{id, version, rubric_version}` per benchmark; a version
mismatch fails the run rather than silently evaluating a different asset.

```bash
plinius campaign create my-campaign          # scaffold campaign/my-campaign.yaml
plinius campaign run --campaign pilot-frontier
plinius campaign status  --campaign pilot-frontier
plinius campaign report  --campaign pilot-frontier
```

### Campaign Runner & Execution Artifacts

The runner iterates `backend × model × benchmark × repetition` in **sorted,
deterministic** order. Run ids are content hashes with **no timestamp**, so
re-running an unchanged campaign reproduces the same ids and overwrites the same
files. A single failed generation is captured on its record — it never aborts
the campaign.

Each run persists a self-contained Execution Artifact
(`reports/<campaign>/runs/<runId>.json`) that reuses the existing primitives
(requirement 8):

- **Prompt Snapshot** (`buildPromptSnapshot`) — exact system/user prompt + id
- **Catalog Snapshot** — content-addressed served-model list per backend
- **Manifest** (`buildManifest`) — binds run → catalog/prompt/environment/backend
- **Provenance** — `ExecutionProvenance` + a `GenerationProvenance` (facts only)
- **Environment** (`captureEnvironment`), **Backend**, **Runtime metrics**,
  **Model**, and **Output**

## Review workflow

Reviews are **blind**. A review set is derived from the run records; each run
becomes a task with an opaque blind id and a lifecycle state machine:

```
CREATED → ASSIGNED → IN_REVIEW → REVIEWED → FINALIZED
```

The public review set (`reviews/<campaign>/review-set.json`) carries only the
blind id, benchmark id, and category. The mapping back to model/backend is a
separate **private** artifact (`reviews/<campaign>/private/mapping.json`).
**Reviewer identity is never stored.**

A reviewer records (requirement 10) a `score`, optional per-dimension
`dimensionScores`, a Markdown `comment`, and `strength` / `weakness` / `notes`.
Submitting a review requires the task to be `IN_REVIEW` and moves it to
`REVIEWED`; illegal transitions are rejected.

## Aggregation

After review, results are aggregated **per model** (requirement 11) — simple
aggregation only, no statistics:

- average overall score (mean of reviewed task scores)
- per-category averages
- collected strengths and weaknesses

Blind ids are joined back to models via the private mapping; a task with no
mapping is skipped, never guessed.

## Report

`plinius campaign report` writes both `report.json` (authoritative) and
`report.md` (rendered from it) under `reports/<campaign>/`, containing:
Campaign Summary, Models, Backend, Benchmarks, Review Summary, Cost, Runtime,
and Known Limitations (requirement 13).

## Future judge integration

The rubric and blind-review structures are deliberately judge-ready. A later
phase can add an **LLM judge** as an *additional* scoring source alongside human
review — never replacing it — by scoring the same rubric dimensions the review
set already carries. Because judges are the lowest authority in Plinius's
evaluator hierarchy, a judge score can never override a human or deterministic
verdict. Statistics, ranking, and leaderboards build on top of the aggregated
results and remain out of scope here.
