# Paid Pass v3.4 broad-screening Ubuntu runbook

## 0. Authorization boundary

This runbook is not a `PAID_GO`. It prepares and verifies one signed broad
campaign, then stops at `READY_FOR_EXPLICIT_PAID_GO`. A separate authorization
is required for each of H1, H2, and H3.

The v3.4 engine adds `diagnostic-broad-paid-r1` with these immutable engine
limits:

- 1 through 24 targets;
- four frozen benchmarks per target and at most 96 logical cells;
- one OIDC sentinel per model;
- `MAX_TOTAL_USD <= 12.00` and `MAX_PER_RUN_USD <= 2.00`;
- no resume, retry, model substitution, alias, automatic fallback, or direct
  driver execution.

Each signed policy may set lower limits. The planned campaign limits are H1
`$3.00/$0.75`, H2 `$5.00/$1.00`, and H3 `$12.00/$2.00`. Completion of one
campaign does not authorize the next campaign.

Broad H1-H3 sends no reasoning-effort field. The signed policy pins only the
supported `temperature`, `topP`, and `seed` fields, and the engine rejects an
unknown profile field. Reasoning-profile comparisons require a later engine
schema, policy, output root, and authorization.

Pinned signing fingerprint:

```text
435C9CF0DE7A2C3900FB24357E622B43290C285E
```

Fail closed on every mismatch. Never repair a path, infer a missing value, reuse
an output root, or rerun a consumed command.

## 1. Authority-issued values

The Mac authority must provide all placeholders below. Do not infer them from a
previous package or campaign.

```bash
set -Eeuo pipefail
umask 077

PACKAGE_ARCHIVE='<AUTHORITY_ISSUED_LOCAL_ARCHIVE_PATH>'
PACKAGE_ARCHIVE_SHA256='<64_HEX_DIGEST>'
PACKAGE_NAME='<AUTHORITY_ISSUED_PACKAGE_DIRECTORY_NAME>'
PACKAGE_PARENT='/home/ubuntu/plinius-paid-v3.4/packages'
PACKAGE_ROOT="$PACKAGE_PARENT/$PACKAGE_NAME"
ARTIFACT_ROOT="$PACKAGE_ROOT/engine"
POLICY_PATH="$PACKAGE_ROOT/policy/<AUTHORITY_ISSUED_POLICY_FILENAME>.json"
POLICY_SIGNATURE_PATH="${POLICY_PATH}.sig"
MODE='diagnostic-broad-paid-r1'

test "$(sha256sum "$PACKAGE_ARCHIVE" | awk '{print $1}')" = "$PACKAGE_ARCHIVE_SHA256"
gzip --test "$PACKAGE_ARCHIVE"
tar -tzf "$PACKAGE_ARCHIVE" >/dev/null
install -d -m 0700 "$PACKAGE_PARENT"
test ! -e "$PACKAGE_ROOT"
tar -C "$PACKAGE_PARENT" -xzf "$PACKAGE_ARCHIVE"
test -d "$PACKAGE_ROOT"
test ! -L "$PACKAGE_ROOT"
(cd "$PACKAGE_ROOT" && sha256sum --check SHA256SUMS)
```

## 2. Offline signature and package verification

The pinned public key must already be installed through an authenticated
authority channel. Never retrieve it by short key ID from a public keyserver.

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

Use only exports from the signed dependency-free launcher and independent
verifier. This validates the recursive package, detached signatures, policy
validity window, canonical policy bytes, broad-mode limits, and exact cell
count. It does not import the runner or read a credential.

```bash
/usr/bin/node --input-type=module - \
  "$ARTIFACT_ROOT" "$POLICY_PATH" "$POLICY_SIGNATURE_PATH" "$MODE" <<'NODE'
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [artifactRoot, policyPath, signaturePath, mode] = process.argv.slice(2);
const launcher = await import(pathToFileURL(join(artifactRoot, "qualification-paid-launch.mjs")));
const verifier = await import(pathToFileURL(join(artifactRoot, "qualification-paid-verify.mjs")));
const engine = launcher.verifyExecutionPackage(artifactRoot);
const signedPolicy = launcher.verifyCampaignPolicy(policyPath, signaturePath, mode);
const parsed = verifier.parseCampaignPolicy(signedPolicy.policyBytes);
if (parsed.identity.mode !== mode) throw new Error("deep policy mode mismatch");
if (!engine.manifest.allowedModes.includes(mode)) throw new Error("execution mode not allowed");
console.log(JSON.stringify({
  artifactType: engine.manifest.artifactType,
  commit: engine.manifest.source.commit,
  tree: engine.manifest.source.tree,
  payloadFiles: engine.manifest.files.length,
  engineSigner: engine.fingerprint,
  policyId: parsed.identity.policyId,
  campaignId: parsed.identity.campaignId,
  stageId: parsed.identity.stageId,
  mode: parsed.identity.mode,
  targets: parsed.targets.size,
  cells: parsed.identity.totalCells,
  maxTotalUsd: parsed.identity.totalCapUsd,
  maxPerRunUsd: parsed.identity.perRunCapUsd,
  policySha256: signedPolicy.policySha256,
  policySignatureSha256: signedPolicy.signatureSha256,
  policySigner: signedPolicy.fingerprint,
}, null, 2));
NODE
```

Compare every printed value with the authority-issued values. Stop on any
difference.

## 3. Parent Evidence and secret metadata

```bash
PARENT_EVIDENCE_ROOT='<AUTHORITY_ISSUED_PARENT_EVIDENCE_ROOT>'
PARENT_BUNDLE_PATH='<AUTHORITY_ISSUED_PARENT_BUNDLE_PATH>'
PARENT_BUNDLE_SHA256='<AUTHORITY_ISSUED_PARENT_BUNDLE_SHA256>'
PARENT_DEFINITION_SHA256='<AUTHORITY_ISSUED_PARENT_DEFINITION_SHA256>'
PARENT_RUN_SHA256='<AUTHORITY_ISSUED_PARENT_RUN_SHA256>'
SECRET_FILE='/home/ubuntu/.secrets/openrouter-api-key'

test "$(sha256sum "$PARENT_BUNDLE_PATH" | awk '{print $1}')" = "$PARENT_BUNDLE_SHA256"
test "$(sha256sum "$PARENT_EVIDENCE_ROOT/campaign/frozen-campaign-definition.json" | awk '{print $1}')" = "$PARENT_DEFINITION_SHA256"
test "$(sha256sum "$PARENT_EVIDENCE_ROOT/campaign/runs/run-d43bb9bcd2a03c20.json" | awk '{print $1}')" = "$PARENT_RUN_SHA256"

test -f "$SECRET_FILE"
test ! -L "$SECRET_FILE"
test "$(stat -c '%u' "$SECRET_FILE")" = "$(id -u)"
test "$(stat -c '%a' "$SECRET_FILE")" = '600'
test "$(stat -c '%h' "$SECRET_FILE")" = '1'
test "$(stat -c '%s' "$SECRET_FILE")" -eq 73 -o "$(stat -c '%s' "$SECRET_FILE")" -eq 74

test -z "${OPENROUTER_API_KEY+x}"
test -z "${CONTINUATION_RESUME+x}"
test -z "${PLINIUS_LOCAL_BINDING_DIR+x}"
printf '%s\n' 'READY_FOR_EXPLICIT_PAID_GO'
```

Stop here. Do not read the secret contents, create an output root, fetch the
catalog, or invoke the launcher until a campaign-specific `PAID_GO` is received.

## 4. One-shot execution template after a separate GO

This section is a template, not authorization. The authorization must repeat the
exact policy ID, mode, policy digest, total cap, per-run cap, secret path, and
`ONE_SHOT=true`. The authority then issues one exact fresh output path.

```bash
AUTHORIZED_POLICY_ID='<FROM_PAID_GO>'
AUTHORIZED_POLICY_SHA256='<FROM_PAID_GO>'
AUTHORIZED_MAX_TOTAL_USD='<FROM_PAID_GO>'
AUTHORIZED_MAX_PER_RUN_USD='<FROM_PAID_GO>'
CONTINUATION_OUTPUT_ROOT='<AUTHORITY_ISSUED_FRESH_OUTPUT_ROOT>'

test "$(sha256sum "$POLICY_PATH" | awk '{print "sha256:"$1}')" = "$AUTHORIZED_POLICY_SHA256"

/usr/bin/node --input-type=module - \
  "$ARTIFACT_ROOT" "$POLICY_PATH" "$MODE" "$AUTHORIZED_POLICY_ID" \
  "$AUTHORIZED_MAX_TOTAL_USD" "$AUTHORIZED_MAX_PER_RUN_USD" <<'NODE'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [root, policyPath, mode, policyId, total, perRun] = process.argv.slice(2);
const verifier = await import(pathToFileURL(join(root, "qualification-paid-verify.mjs")));
const parsed = verifier.parseCampaignPolicy(readFileSync(policyPath));
if (parsed.identity.mode !== mode || parsed.identity.policyId !== policyId ||
    parsed.identity.totalCapUsd !== Number(total) ||
    parsed.identity.perRunCapUsd !== Number(perRun)) {
  throw new Error("PAID_GO does not match signed policy");
}
NODE

test ! -e "$CONTINUATION_OUTPUT_ROOT"
install -d -m 0700 "$CONTINUATION_OUTPUT_ROOT"
test -z "$(find "$CONTINUATION_OUTPUT_ROOT" -mindepth 1 -print -quit)"

export CONTINUATION_OUTPUT_ROOT PARENT_EVIDENCE_ROOT PARENT_BUNDLE_PATH
export PLINIUS_DRIVER_MODE="$MODE"
unset CONTINUATION_RESUME PLINIUS_LOCAL_BINDING_DIR OPENROUTER_API_KEY

set +e
set +x
OPENROUTER_API_KEY="$(<"$SECRET_FILE")" \
  /usr/bin/node "$ARTIFACT_ROOT/qualification-paid-launch.mjs" \
    --artifact-root "$ARTIFACT_ROOT" \
    --policy "$POLICY_PATH" \
    --policy-signature "$POLICY_SIGNATURE_PATH" \
    --mode "$MODE"
PAID_RUN_EXIT=$?
unset OPENROUTER_API_KEY
set -e
printf 'PAID_RUN_EXIT=%s\n' "$PAID_RUN_EXIT"
```

Invoke the launcher exactly once. Stop after every success, rejection, catalog
drift, transport failure, unknown cost, or integrity failure. Do not run an
external retry or continue with another campaign.

## 5. Verify and archive Evidence

Do not edit the output root. If it contains a final manifest, run the signed
independent verifier before archiving. Preserve negative Evidence even when no
final manifest exists.

```bash
if find "$CONTINUATION_OUTPUT_ROOT" -maxdepth 1 -type f \
    -name 'paid-pass-manifest-*.json' -print -quit | grep -q .; then
  /usr/bin/node "$ARTIFACT_ROOT/qualification-paid-verify.mjs" \
    --root "$CONTINUATION_OUTPUT_ROOT"
fi

EVIDENCE_PARENT="$(dirname "$CONTINUATION_OUTPUT_ROOT")"
EVIDENCE_NAME="$(basename "$CONTINUATION_OUTPUT_ROOT")"
EVIDENCE_ARCHIVE="${EVIDENCE_PARENT}/${EVIDENCE_NAME}-evidence.tar.gz"
test ! -e "$EVIDENCE_ARCHIVE"
tar --format=posix --sort=name --mtime='UTC 1970-01-01' \
  --owner=0 --group=0 --numeric-owner \
  -C "$EVIDENCE_PARENT" -cf - "$EVIDENCE_NAME" | gzip -n >"$EVIDENCE_ARCHIVE"
sha256sum "$EVIDENCE_ARCHIVE" >"${EVIDENCE_ARCHIVE}.sha256"
chmod 0600 "$EVIDENCE_ARCHIVE" "${EVIDENCE_ARCHIVE}.sha256"
gzip --test "$EVIDENCE_ARCHIVE"
tar -tzf "$EVIDENCE_ARCHIVE" >/dev/null
```

Transfer the archive, checksum, and exact signed v3.4 package to the Mac. The Mac
authority rechecks the archive digest, extracts to a fresh directory, reruns the
signed independent verifier, recomputes every manifest entry, and reconciles
generation IDs and settled costs with OpenRouter Activity before authorizing the
next campaign.

## 6. Required report

Report package archive digest, commit, tree, signer, policy ID and digests,
campaign/stage IDs, target/cell counts, output root, exit code, stop reason,
dispatch/pass/fail/skip counts, generation IDs, tokens, cost coverage, settled
cost, final manifest, Evidence archive digest, Mac read-back, and Activity
reconciliation. Explicitly report unknown costs and confirm that no retry,
resume, fallback, substitution, direct driver, source checkout, package manager,
local model, Docker, GPU, or A100 was used.
