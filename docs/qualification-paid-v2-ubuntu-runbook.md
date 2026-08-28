# Paid Pass v2 Ubuntu execution runbook

## 0. Authority and stop condition

This runbook is not a Paid GO. Do not execute a provider request until the Mac
authority has separately issued all of the following:

- an approved, signed Paid Pass v2 commit;
- a signed `plinius-paid-pass-v2` execution artifact built from that commit;
- the artifact archive digest and the exact signing fingerprint;
- an explicit GO naming exactly one pass and one fresh output root.

The currently reviewed r8 artifact is not v2 and must not be reused. An unsigned
artifact, a source checkout, `tsx`, `pnpm`, or a shared `node_modules` tree is not
an acceptable Ubuntu runtime.

Pinned signing fingerprint:

```text
435C9CF0DE7A2C3900FB24357E622B43290C285E
```

Fail closed on any mismatch. Do not repair, retry, resume, substitute a model,
enable provider fallback, reuse an output root, or start the other pass.

## 1. Fixed pass definitions

Choose only the pass named by the explicit GO.

### Hosted Pass A

```text
MODE=diagnostic-hosted-paid-r1
STAGE=plinius-qualification-2026-08-22-diagnostic-hosted-paid-r1
CELLS=15
TOTAL_CAP_USD=5.00
PER_RUN_CAP_USD=1.00
```

Pinned routes:

```text
openai/gpt-5.6-sol-pro              -> openai
anthropic/claude-opus-5             -> claude-on-aws
google/gemini-3.7-flash             -> google-vertex/global
deepseek/deepseek-v4-flash-0731     -> deepinfra/fp8
```

### Candidate Pass

```text
MODE=diagnostic-candidate-paid-r1
STAGE=plinius-qualification-2026-08-26-diagnostic-candidate-paid-r1
CELLS=16
TOTAL_CAP_USD=6.00
PER_RUN_CAP_USD=0.75
```

Pinned routes:

```text
z-ai/glm-5.3             -> z-ai/fp8
moonshotai/kimi-k3       -> moonshotai/mxfp4
qwen/qwen3.8-max         -> alibaba
anthropic/claude-sonnet-5 -> anthropic
```

## 2. Runtime prohibitions

- Do not clone or switch a repository on Ubuntu.
- Do not run `pnpm install`, `pnpm`, `tsx`, TypeScript, or source files.
- Do not use Docker, vLLM, local model endpoints, GPU, or A100.
- Do not set `CONTINUATION_RESUME` or `PLINIUS_LOCAL_BINDING_DIR`.
- Do not expose, print, paste, or include `OPENROUTER_API_KEY` in logs or Evidence.
- Do not run the bundled `qualification-driver.mjs` directly.
- Do not use an artifact or attestation from an earlier run.

## 3. Required Ubuntu inputs

The control plane must place these inputs on Ubuntu before execution:

```text
ARTIFACT_ROOT=<absolute path to the freshly transferred signed v2 artifact directory>
PARENT_EVIDENCE_ROOT=/home/ubuntu/plinius-evidence/plinius-qualification-2026-08-22-exec
PARENT_BUNDLE_PATH=/home/ubuntu/plinius-evidence/plinius-qualification-2026-08-22-exec-evidence.tar.gz
SECRET_FILE=<absolute path to a root/user-owned mode-0600 file containing only the OpenRouter key>
```

The parent inputs are fixed by these SHA-256 values:

```text
parent bundle:       5464aac6862ee2b001cae40ac861d43b64abb9b0cd705bfa539252104963c66e
frozen definition:   eba5485902b6fa8307dc4cf1e3ff4c4bf99175f9e63eaedd0c81102332fae86d
historical run:      05390908e2dcadc2f029292a98be21ccc13b7e39ee8ce3b8d3660d455a1ff026
```

Required files under the parent root:

```text
campaign/frozen-campaign-definition.json
campaign/runs/run-d43bb9bcd2a03c20.json
```

## 4. Non-mutating preflight

Run these checks without reading `SECRET_FILE`:

```bash
set -Eeuo pipefail
umask 077

: "${ARTIFACT_ROOT:?}"
: "${PARENT_EVIDENCE_ROOT:?}"
: "${PARENT_BUNDLE_PATH:?}"
: "${MODE:?}"

test -x /usr/bin/node
/usr/bin/node --version
test -d "$ARTIFACT_ROOT"
test ! -L "$ARTIFACT_ROOT"
test -f "$ARTIFACT_ROOT/qualification-paid-execution-manifest.json"
test -f "$ARTIFACT_ROOT/qualification-paid-execution-manifest.json.sig"
test -f "$ARTIFACT_ROOT/qualification-paid-launch.mjs"
test -f "$ARTIFACT_ROOT/qualification-driver.mjs"
test -f "$ARTIFACT_ROOT/qualification-paid-verify.mjs"
test ! -L "$ARTIFACT_ROOT/qualification-paid-launch.mjs"
test ! -L "$ARTIFACT_ROOT/qualification-driver.mjs"
test ! -L "$ARTIFACT_ROOT/qualification-paid-verify.mjs"

test "$(sha256sum "$PARENT_BUNDLE_PATH" | awk '{print $1}')" = \
  "5464aac6862ee2b001cae40ac861d43b64abb9b0cd705bfa539252104963c66e"
test "$(sha256sum "$PARENT_EVIDENCE_ROOT/campaign/frozen-campaign-definition.json" | awk '{print $1}')" = \
  "eba5485902b6fa8307dc4cf1e3ff4c4bf99175f9e63eaedd0c81102332fae86d"
test "$(sha256sum "$PARENT_EVIDENCE_ROOT/campaign/runs/run-d43bb9bcd2a03c20.json" | awk '{print $1}')" = \
  "05390908e2dcadc2f029292a98be21ccc13b7e39ee8ce3b8d3660d455a1ff026"

test -z "${CONTINUATION_RESUME+x}"
test -z "${PLINIUS_LOCAL_BINDING_DIR+x}"
```

Fable must then independently verify all of the following without importing the
driver:

1. The detached signature over
   `qualification-paid-execution-manifest.json` is valid under the complete
   pinned fingerprint.
2. Artifact root and directories are real owner-controlled directories with mode
   `0700`; files are regular, non-symlink, single-link, owner-controlled files
   with mode `0600`.
3. The recursive artifact file set exactly matches the signed manifest.
4. Every file byte length and SHA-256 matches the signed manifest.
5. Manifest type is `plinius-paid-pass-v2`; launcher, runner, verifier and mode
   are exact.
6. The only approved process entry is `/usr/bin/node` with
   `qualification-paid-launch.mjs`; the bundled driver is never the process entry.

On success, report the artifact manifest digest, signature digest, signer
fingerprint, launcher digest, runner digest, selected mode and fresh output path.
Then stop and wait for the explicit Paid GO.

## 5. Prepare one fresh output root

After the GO, create exactly one new root. Never reuse a root, including one left
by a failed preflight or interrupted run.

```bash
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
CONTINUATION_OUTPUT_ROOT="/home/ubuntu/plinius-paid-v2/${RUN_ID}/${MODE}"
install -d -m 0700 "$CONTINUATION_OUTPUT_ROOT"
test -z "$(find "$CONTINUATION_OUTPUT_ROOT" -mindepth 1 -print -quit)"
export CONTINUATION_OUTPUT_ROOT PARENT_EVIDENCE_ROOT PARENT_BUNDLE_PATH
export PLINIUS_DRIVER_MODE="$MODE"
unset CONTINUATION_RESUME PLINIUS_LOCAL_BINDING_DIR
```

Record `CONTINUATION_OUTPUT_ROOT` before continuing. The Hosted and Candidate
passes require different roots and different explicit GOs.

## 6. Paid one-shot execution

Confirm `SECRET_FILE` is a regular non-symlink file, owned by the executing user,
with mode `0600`. Do not print its contents.

```bash
test -f "$SECRET_FILE"
test ! -L "$SECRET_FILE"
test "$(stat -c '%u' "$SECRET_FILE")" = "$(id -u)"
test "$(stat -c '%a' "$SECRET_FILE")" = "600"
```

Execute exactly once, with shell tracing disabled. Supplying the environment is
not authorization by itself; the separate explicit GO is mandatory.

```bash
set +e
set +x
OPENROUTER_API_KEY="$(<"$SECRET_FILE")" \
  /usr/bin/node "$ARTIFACT_ROOT/qualification-paid-launch.mjs" \
  --artifact-root "$ARTIFACT_ROOT" \
  --mode "$MODE"
RUN_EXIT=$?
unset OPENROUTER_API_KEY
set -e
if [ "$RUN_EXIT" -ne 0 ]; then
  printf 'PAID PASS FAILED: exit=%s root=%s\n' "$RUN_EXIT" "$CONTINUATION_OUTPUT_ROOT" >&2
  exit "$RUN_EXIT"
fi
```

The launcher must verify the signed package before loading the exact retained
runner bytes. The driver performs the anonymous catalog and budget gates before
reading `OPENROUTER_API_KEY`. It then dispatches each cell at most once with one
pinned provider, `allow_fallbacks:false`, and `require_parameters:true`.

If the command exits nonzero, is interrupted, reports an unknown cost, exceeds a
cap, fails a sentinel, or reports any digest/wire/provider mismatch, stop. Do not
rerun the command and do not use the output root again.

## 7. Post-run checks and transfer

Do not delete or modify the output root. Confirm there is exactly one final
content-addressed manifest:

```bash
mapfile -t FINAL_MANIFESTS < <(
  find "$CONTINUATION_OUTPUT_ROOT" -maxdepth 1 \
    -type f -name 'paid-pass-manifest-*.json' -print
)
test "${#FINAL_MANIFESTS[@]}" -eq 1
printf 'FINAL_MANIFEST=%s\n' "${FINAL_MANIFESTS[0]}"
```

Create a transfer archive without changing the Evidence:

```bash
EVIDENCE_PARENT="$(dirname "$CONTINUATION_OUTPUT_ROOT")"
EVIDENCE_NAME="$(basename "$CONTINUATION_OUTPUT_ROOT")"
EVIDENCE_ARCHIVE="${EVIDENCE_PARENT}/${EVIDENCE_NAME}-evidence.tar.gz"
tar -C "$EVIDENCE_PARENT" -czf "$EVIDENCE_ARCHIVE" "$EVIDENCE_NAME"
sha256sum "$EVIDENCE_ARCHIVE" > "${EVIDENCE_ARCHIVE}.sha256"
chmod 0600 "$EVIDENCE_ARCHIVE" "${EVIDENCE_ARCHIVE}.sha256"
```

Transfer the archive and digest to the Mac authority. Keep the Ubuntu originals
until Mac read-back succeeds.

The Mac authority must extract into a fresh mode-0700 directory and run the
independently reviewed verifier from the signed v2 artifact, not a verifier copied
from the Evidence:

```bash
<authority-pinned-node> <reviewed-artifact>/qualification-paid-verify.mjs \
  --root <freshly-extracted-evidence-root>
```

Acceptance requires verifier exit `0` and `"ok": true`. A valid Evidence
container does not by itself mean every model passed; inspect `summary.passed`,
`summary.failed`, `summary.stopped`, and `summary.costCoverage`. In particular,
`costCoverage.complete` must be true for a fully settled campaign.

## 8. Final report

Report all of the following:

- selected mode, stage, artifact manifest digest and signer fingerprint;
- output root, final manifest filename and Evidence archive digest;
- dispatched, passed, failed, skipped and stopped values;
- settled total USD and the settled/unknown/invalid cost run IDs;
- OpenRouter catalog/provider/generation call counts and token totals;
- Mac verifier result;
- confirmation that no retry, resume, fallback, substitution, source checkout,
  local model, GPU or A100 was used.

Do not start the second pass unless a new explicit GO supplies a new fresh output
root. No EC2 or A100 stop action is required for these hosted-only passes.
