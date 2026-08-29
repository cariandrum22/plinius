# Paid Pass v3 Ubuntu execution runbook

## 0. Authority and stop condition

This runbook is not a Paid GO. Paid Pass v3 separates a stable signed engine
from a separately signed, short-lived campaign policy. Do not execute a provider
request until the Mac authority has separately issued all of the following:

- an approved, signed v3 source commit and release tag;
- the signed `plinius-paid-pass-v3` engine package;
- a signed, unexpired campaign policy for exactly one mode;
- the release archive SHA-256 and exact signing fingerprint;
- an explicit one-shot Paid GO naming the mode, budget caps and secret file.

Pinned signing fingerprint:

```text
435C9CF0DE7A2C3900FB24357E622B43290C285E
```

Fail closed on any mismatch. Do not repair, retry, resume, substitute a model,
enable provider fallback, reuse an output root, or start another pass.

## 1. Current authorization boundary

The issued Hosted policy is:

```text
MODE=diagnostic-hosted-paid-r1
POLICY_ID=plinius-hosted-paid-2026-08-29-r1
STAGE=plinius-qualification-2026-08-29-diagnostic-hosted-paid-r2
CELLS=15
MAX_TOTAL_USD=5.00
MAX_PER_RUN_USD=1.00
ONE_SHOT=true
EXPIRES_AT_UTC=2026-09-05T02:30:00Z
```

The policy sends canonical, versioned model slugs. Catalog aliases and expected
response model IDs are pinned separately. The engine requires exactly one
provider route, `allow_fallbacks:false`, `require_parameters:true`, and the
policy price ceilings.

No Candidate policy has been issued. Candidate Pass remains unauthorized even
though the engine understands its mode. Do not construct or infer a Candidate
policy and do not reuse a Hosted GO for Candidate Pass.

## 2. Runtime prohibitions

- Do not clone or switch a repository on Ubuntu.
- Do not run `pnpm`, `tsx`, TypeScript, or a shared `node_modules` tree.
- Do not use Docker, vLLM, a local model endpoint, GPU, or A100.
- Do not set `CONTINUATION_RESUME` or `PLINIUS_LOCAL_BINDING_DIR`.
- Do not print, paste, log, hash, or include `OPENROUTER_API_KEY` in Evidence.
- Do not run `qualification-driver.mjs` directly.
- Do not use the consumed v2 GO, v2 failed output root, or v2 policy values.

## 3. Acquire the release package

The authority message supplies exact values for these placeholders:

```bash
set -Eeuo pipefail
umask 077

RELEASE_TAG='<AUTHORITY_ISSUED_TAG>'
ARCHIVE_NAME='<AUTHORITY_ISSUED_ARCHIVE_NAME>'
ARCHIVE_SHA256='<AUTHORITY_ISSUED_ARCHIVE_SHA256>'
BASE_URL="https://github.com/cariandrum22/plinius/releases/download/${RELEASE_TAG}"
DOWNLOAD_ROOT='/home/ubuntu/plinius-paid-v3/download'

install -d -m 0700 "$DOWNLOAD_ROOT"
test ! -e "$DOWNLOAD_ROOT/$ARCHIVE_NAME"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$DOWNLOAD_ROOT/$ARCHIVE_NAME" \
  "$BASE_URL/$ARCHIVE_NAME"
test "$(sha256sum "$DOWNLOAD_ROOT/$ARCHIVE_NAME" | awk '{print $1}')" = \
  "$ARCHIVE_SHA256"
```

Extract once into a new directory:

```bash
PACKAGE_PARENT='/home/ubuntu/plinius-paid-v3/packages'
PACKAGE_ROOT="$PACKAGE_PARENT/qualification-paid-v3-release"
install -d -m 0700 "$PACKAGE_PARENT"
test ! -e "$PACKAGE_ROOT"
tar -C "$PACKAGE_PARENT" -xzf "$DOWNLOAD_ROOT/$ARCHIVE_NAME"
test -d "$PACKAGE_ROOT"
test ! -L "$PACKAGE_ROOT"
(cd "$PACKAGE_ROOT" && sha256sum --check SHA256SUMS)

ARTIFACT_ROOT="$PACKAGE_ROOT/engine"
POLICY_PATH="$PACKAGE_ROOT/policy/qualification-hosted-paid-2026-08-29-r1.json"
POLICY_SIGNATURE_PATH="${POLICY_PATH}.sig"
MODE='diagnostic-hosted-paid-r1'
```

## 4. Verify both detached signatures

The pinned public key must already be present in the executing user's GPG
keyring through an authority-approved channel. Do not fetch a key by key ID from
an unauthenticated keyserver.

```bash
test -x /usr/bin/gpg
test -x /usr/bin/node

verify_pinned_signature() {
  local signature="$1"
  local body="$2"
  local status fingerprint
  status="$(/usr/bin/gpg --batch --status-fd=1 --verify "$signature" "$body" 2>/dev/null)"
  fingerprint="$(printf '%s\n' "$status" | awk '$1=="[GNUPG:]" && $2=="VALIDSIG" {print $3}')"
  test "$fingerprint" = '435C9CF0DE7A2C3900FB24357E622B43290C285E'
}

verify_pinned_signature \
  "$ARTIFACT_ROOT/qualification-paid-execution-manifest.json.sig" \
  "$ARTIFACT_ROOT/qualification-paid-execution-manifest.json"
verify_pinned_signature "$POLICY_SIGNATURE_PATH" "$POLICY_PATH"
```

Invoke only the dependency-free launcher verification exports. This verifies
the recursive engine file set, every signed digest, file ownership/mode, policy
signature, policy mode and policy validity window. It does not load the runner,
read a credential, call the catalog, or dispatch.

```bash
/usr/bin/node --input-type=module - \
  "$ARTIFACT_ROOT" "$POLICY_PATH" "$POLICY_SIGNATURE_PATH" "$MODE" <<'NODE'
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [artifactRoot, policyPath, signaturePath, mode] = process.argv.slice(2);
const launcher = await import(pathToFileURL(join(artifactRoot, "qualification-paid-launch.mjs")));
const engine = launcher.verifyExecutionPackage(artifactRoot);
const policy = launcher.verifyCampaignPolicy(policyPath, signaturePath, mode);
console.log(JSON.stringify({
  artifactType: engine.manifest.artifactType,
  commit: engine.manifest.source.commit,
  tree: engine.manifest.source.tree,
  payloadFiles: engine.manifest.files.length,
  engineSigner: engine.fingerprint,
  policySha256: policy.policySha256,
  policySignatureSha256: policy.signatureSha256,
  policySigner: policy.fingerprint,
  mode,
}, null, 2));
NODE
```

Verify the fixed parent inputs without reading the secret:

```bash
PARENT_EVIDENCE_ROOT='/home/ubuntu/plinius-evidence/plinius-qualification-2026-08-22-exec'
PARENT_BUNDLE_PATH='/home/ubuntu/plinius-evidence/plinius-qualification-2026-08-22-exec-evidence.tar.gz'

test "$(sha256sum "$PARENT_BUNDLE_PATH" | awk '{print $1}')" = \
  '5464aac6862ee2b001cae40ac861d43b64abb9b0cd705bfa539252104963c66e'
test "$(sha256sum "$PARENT_EVIDENCE_ROOT/campaign/frozen-campaign-definition.json" | awk '{print $1}')" = \
  'eba5485902b6fa8307dc4cf1e3ff4c4bf99175f9e63eaedd0c81102332fae86d'
test "$(sha256sum "$PARENT_EVIDENCE_ROOT/campaign/runs/run-d43bb9bcd2a03c20.json" | awk '{print $1}')" = \
  '05390908e2dcadc2f029292a98be21ccc13b7e39ee8ce3b8d3660d455a1ff026'

test -z "${OPENROUTER_API_KEY+x}"
test -z "${CONTINUATION_RESUME+x}"
test -z "${PLINIUS_LOCAL_BINDING_DIR+x}"
printf '%s\n' 'READY_FOR_EXPLICIT_PAID_GO'
```

Stop here. Package verification is not authorization to dispatch.

## 5. One-shot execution after a separate GO

Only after receiving a matching explicit Paid GO, create one fresh output root.
Never reuse a path, including one left by a failed catalog preflight.

```bash
SECRET_FILE='/home/ubuntu/.secrets/openrouter-api-key'
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
CONTINUATION_OUTPUT_ROOT="/home/ubuntu/plinius-paid-v3/runs/${RUN_ID}/${MODE}"

test ! -e "$CONTINUATION_OUTPUT_ROOT"
install -d -m 0700 "$CONTINUATION_OUTPUT_ROOT"
test -z "$(find "$CONTINUATION_OUTPUT_ROOT" -mindepth 1 -print -quit)"

test -f "$SECRET_FILE"
test ! -L "$SECRET_FILE"
test "$(stat -c '%u' "$SECRET_FILE")" = "$(id -u)"
test "$(stat -c '%a' "$SECRET_FILE")" = '600'
test "$(stat -c '%h' "$SECRET_FILE")" = '1'

export CONTINUATION_OUTPUT_ROOT PARENT_EVIDENCE_ROOT PARENT_BUNDLE_PATH
export PLINIUS_DRIVER_MODE="$MODE"
unset CONTINUATION_RESUME PLINIUS_LOCAL_BINDING_DIR OPENROUTER_API_KEY
printf 'AUTHORIZED_OUTPUT_ROOT=%s\n' "$CONTINUATION_OUTPUT_ROOT"
```

Execute the launcher exactly once with shell tracing disabled. Reading the
secret into the child environment is part of the paid invocation and must not
occur before the explicit GO.

```bash
set +e
set +x
OPENROUTER_API_KEY="$(<"$SECRET_FILE")" \
  /usr/bin/node "$ARTIFACT_ROOT/qualification-paid-launch.mjs" \
    --artifact-root "$ARTIFACT_ROOT" \
    --policy "$POLICY_PATH" \
    --policy-signature "$POLICY_SIGNATURE_PATH" \
    --mode "$MODE"
RUN_EXIT=$?
unset OPENROUTER_API_KEY
set -e
printf 'PAID_RUN_EXIT=%s\n' "$RUN_EXIT"
```

Stop after this one invocation, whether it succeeds or fails. Do not retry the
launcher, catalog, a cell, or cost lookup outside the engine's fixed behavior.

## 6. Seal and transfer Evidence

Do not modify the output root. Archive success or negative preflight Evidence in
the same way:

```bash
EVIDENCE_PARENT="$(dirname "$CONTINUATION_OUTPUT_ROOT")"
EVIDENCE_NAME="$(basename "$CONTINUATION_OUTPUT_ROOT")"
EVIDENCE_ARCHIVE="${EVIDENCE_PARENT}/${EVIDENCE_NAME}-evidence.tar.gz"
test ! -e "$EVIDENCE_ARCHIVE"
tar -C "$EVIDENCE_PARENT" -czf "$EVIDENCE_ARCHIVE" "$EVIDENCE_NAME"
sha256sum "$EVIDENCE_ARCHIVE" > "${EVIDENCE_ARCHIVE}.sha256"
chmod 0600 "$EVIDENCE_ARCHIVE" "${EVIDENCE_ARCHIVE}.sha256"
```

For a completed run, require exactly one final manifest and run the independent
verifier from the signed engine package after transfer to the Mac:

```bash
/usr/bin/node "$ARTIFACT_ROOT/qualification-paid-verify.mjs" \
  --root "$CONTINUATION_OUTPUT_ROOT"
```

A catalog-preflight failure intentionally has no billed runs and may not have a
final pass manifest. Preserve and transfer that negative Evidence unchanged;
do not turn it into a completed run or invoke the paid launcher again.

## 7. Final report

Report the release tag/archive digest, engine commit/tree/signature, policy ID,
policy/signature digests, mode, output root, exit code, final manifest if any,
catalog/provider/generation/token/cost counts, Evidence archive digest, and Mac
read-back result. Explicitly confirm that no retry, resume, fallback,
substitution, source checkout, local model, GPU, or A100 was used.
