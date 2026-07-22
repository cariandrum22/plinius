# Reproducibility & Provenance

This document describes the reproducibility hardening layer: how Plinius records
*what was evaluated* so that a run can be audited and re-checked long after the
OpenRouter catalog has moved on. It changes no evaluation logic.

## Design: content-addressed snapshots

Every immutable artifact is identified by a **content hash, never a timestamp**:

- **Catalog snapshot** — `snap-<hash>` over the normalized model list.
- **Prompt snapshot** — `prompt-<hash>` over the prompt inputs + rendered text.

Identical inputs always produce the same id, so two machines building a snapshot
from the same source agree byte-for-byte. Fetch time is stored as a separate
field and never affects the id.

## Prompt Snapshot (`src/prompt/`)

`PROMPT_SCHEMA_VERSION`. A snapshot captures `systemPrompt`, `userPrompt`,
`fewShot`, `rubric`, `variables`, and the `renderedPrompt` (after `{{variable}}`
expansion). The evaluation depends on the prompt as much as the model, so it is
pinned.

### Prompt Fingerprint

Independent of the snapshot id, a fingerprint stores per-part SHA-256 hashes:
`systemHash`, `userHash`, `renderedHash`. A single-character change to any part
is detectable, and the change is localized to the affected part.

## Generation Provenance (`src/provenance/`)

`GENERATION_PROVENANCE_SCHEMA_VERSION`. From the OpenRouter Generation API
(`GET /generation?id=`) Plinius stores `provider`, `endpoint`, `generationId`,
`model`, `canonicalSlug`, `requestedSlug`, `pricing`, `latency`, `createdAt`,
`region`, `contextLength`, `quantization`, and opaque `providerMetadata`.

**Anything OpenRouter does not return is stored as `null`. Nothing is guessed.**

### Provenance status

- `complete` — a generation id AND a provider are present.
- `partial` — only one of them is present.
- `missing` — neither is present.

## Evaluation Environment (`src/environment/`)

`ENVIRONMENT_SCHEMA_VERSION`. Each run records the Plinius version, the campaign
/ catalog / prompt schema versions, the reasoning-normalizer version, the CLI
version, Node version, platform, architecture, and (when available) the
OpenRouter API version. Undeterminable fields are `null`. The environment is
machine-specific and is captured, not hashed into ids.

Critical fields for comparability: the campaign / catalog / prompt schema
versions and the reasoning-normalizer version. A change in any of these makes
results **not** comparable.

## Model Lifecycle (`src/campaign/lifecycle.ts`)

- `ACTIVE` — normal evaluation target.
- `DEPRECATED` — warned in new campaigns (future expiration or catalog marks it).
- `RETIRED` — past its expiration; new evaluation is forbidden, viewing only.
- `UNKNOWN` — not determinable (absent from the snapshot).

Discovery only auto-proposes `ACTIVE` models.

## Evaluation Manifest (`src/manifest/`)

`MANIFEST_SCHEMA_VERSION`. One self-describing record per run:

```
campaignId · runId · catalogSnapshotId · promptSnapshotId · environment
targetModels[{ targetId, requestedSlug, canonicalSlug, lifecycle, provenanceStatus }]
profiles · budget · timestamp · generationProvenance[]
```

The manifest alone answers "what was evaluated". `buildManifest` is deterministic
given its inputs (timestamp injected). The schema is lenient: newly-added fields
default so older manifests still validate, and unknown fields are preserved.

## `plinius reproduce`

```bash
plinius reproduce --manifest <manifest.json> [--catalog <snapshot.json>] [--prompt <prompt.json>]
```

Compares the manifest against current state and reports catalog match, prompt
match, environment diffs, lifecycle diffs, alias diffs, and provider diffs, with
a verdict:

- **REPRODUCIBLE** — catalog + prompt match, no diffs, no lifecycle change.
- **PARTIALLY_REPRODUCIBLE** — identity matches but non-critical differences exist
  (platform, provider, alias drift, deprecation).
- **NOT_REPRODUCIBLE** — catalog or prompt mismatch, a critical schema version
  change, or a now-RETIRED target.

## `plinius audit`

```bash
plinius audit --manifest <manifest.json> [--prompt <prompt.json>]
```

Checks Catalog Snapshot, Prompt Snapshot, Budget Recorded, Provenance Complete,
Fingerprint Match, and Lifecycle, each classified `OK` / `WARNING` / `ERROR`.

## Reproducibility guarantees & limits

**Guaranteed reproducible** (identical ids/fingerprints): the exact prompt,
rubric, variables, sampling+reasoning request, catalog snapshot the run resolved
against, and the schema/normalizer versions.

**Cannot be guaranteed** — these are recorded and surfaced, not controlled:

- **OpenRouter provider changes** — the same model may route to a different
  provider; provenance records the actual provider, and a diff is reported.
- **Model updates behind an alias** — a mutable alias may point at a newer
  canonical model; both requested and resolved slugs are stored, and alias drift
  is reported.
- **Quantization changes** — a provider endpoint may change quantization; it is
  recorded when exposed, but bit-for-bit output equivalence is never claimed.
- **Model retirement** — a retired model cannot be re-evaluated; historical
  manifests remain viewable.
- **Non-determinism at the provider** — even with a fixed seed, some providers do
  not guarantee identical outputs.
