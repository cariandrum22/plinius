# Paid Pass v3.6 selective-recovery Ubuntu runbook

## Authorization boundary

This runbook verifies one signed selective-recovery package offline and stops at
`READY_FOR_EXPLICIT_PAID_GO`. It is not a `PAID_GO`. H3R2A and H3R2B require
separate packages, policies, output roots, and authorizations.

The only new mode is `diagnostic-selective-paid-r1`. A policy-v3 campaign has
exactly one target and one through four explicitly ordered cells. It never
expands the target to the broad matrix. `group` is derived from the target and
is not a policy input.

- H3R2A selects two Terra cells and binds a historical Terra OIDC sentinel.
- H3R2B selects four Muse cells and runs OIDC as its first live sentinel.
- A live sentinel content failure skips the remaining selected cells.
- An unknown cost, HTTP error, or wire-integrity error remains unknown and stops
  scheduling. It is never replaced with zero.
- Retry, resume, fallback, substitution, root reuse, and direct driver execution
  remain prohibited.

## Offline package verification

Use only authority-issued archive paths and SHA-256 values. Extract each package
to a fresh directory with mode `0700`, run `sha256sum --check SHA256SUMS`, and
verify both detached signatures with the full signing-subkey fingerprint:

```text
435C9CF0DE7A2C3900FB24357E622B43290C285E
```

Import `verifyExecutionPackage` and `verifyCampaignPolicy` from the packaged
launcher and `parseCampaignPolicy` from the packaged independent verifier. Check
all read-back fields against the authority table:

- source commit and tree;
- complete payload count and digests;
- policy ID, policy digest, and policy-signature digest;
- campaign ID, stage ID, target, ordered cells, sentinel strategy, and parent
  input count;
- total and per-run caps;
- exact anonymous catalog-capture digests.

No credential, launcher main, driver, output root, or provider request is
permitted during this phase.

## H3R2A historical parent verification

Before a future H3R2A launch, set these authority-issued paths:

```bash
PARENT_EVIDENCE_ROOT='<EXTRACTED_H3R1_EVIDENCE_ROOT>'
PARENT_BUNDLE_PATH='<H3R1_EVIDENCE_ARCHIVE>'
PARENT_VERIFY_REPORT_PATH='<H3R1_GATE_H_VERIFY_REPORT>'
PARENT_GATE_I_LEDGER_PATH='<H3R1_GATE_I_LEDGER>'
```

The signed policy pins the archive, final manifest, Terra run record, Gate H
report, and Gate I ledger. The engine checks secure file metadata, exact bytes,
campaign/stage identity, content-addressed manifest reference, pass/stop status,
clean paid verdict, generation ID, model/provider identity, and settled cost
before reading `OPENROUTER_API_KEY`.

H3R2B has no historical parent. It must not receive H3R2A parent inputs or share
an output root with H3R2A.

## Gate E stop

After every offline value matches, report and stop:

```text
READY_FOR_EXPLICIT_PAID_GO
PAID_GO=false
CREDENTIAL_READS=0
AUTHENTICATED_API_CALLS=0
GENERATION_CALLS=0
PROVIDER_DISPATCH=0
```

A later `PAID_GO` must repeat the exact campaign, mode, policy ID and digest,
budget, secret path, and one fresh output root. Invoke the signed launcher once
and preserve all partial or negative Evidence without repair or rerun.
