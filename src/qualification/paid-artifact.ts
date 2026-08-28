/**
 * Paid artifact launch-grant contract.
 *
 * The actual trust decision is external: Fable verifies the signed execution
 * package and launches its committed dependency-free launcher. This module does
 * not claim that application code can authenticate its own loader. It only
 * prevents accidental/direct invocation and binds the running bundle to the
 * execution manifest that the external launcher already verified.
 */

export const PAID_ARTIFACT_SCHEMA_VERSION = 1;
export const PAID_LAUNCH_GRANT_SCHEMA_VERSION = 1;
export const PAID_ARTIFACT_TYPE = "plinius-paid-pass-v2";
export const PAID_ARTIFACT_PINNED_SIGNER = "435C9CF0DE7A2C3900FB24357E622B43290C285E";
export const PAID_ARTIFACT_LAUNCHER = "qualification-paid-launch.mjs";
export const PAID_ARTIFACT_RUNNER = "qualification-driver.mjs";
export const PAID_ARTIFACT_VERIFIER = "qualification-paid-verify.mjs";
export const PAID_EXECUTION_MANIFEST = "qualification-paid-execution-manifest.json";

export type PaidArtifactMode = "diagnostic-hosted-paid-r1" | "diagnostic-candidate-paid-r1";

export interface PaidExecutionFile {
  path: string;
  sha256: string;
  bytes: number;
  role: "launcher" | "runner" | "verifier" | "benchmark";
}

export interface PaidExecutionManifest {
  schemaVersion: number;
  artifactType: string;
  createdAtUtc: string;
  source: { commit: string; tree: string };
  requiredSignerFingerprint: string;
  allowedModes: PaidArtifactMode[];
  launcher: string;
  runner: string;
  verifier: string;
  files: PaidExecutionFile[];
}

export interface PaidLaunchGrant {
  schemaVersion: number;
  artifactType: string;
  artifactRoot: string;
  executionManifestPath: string;
  executionManifestSha256: string;
  executionSignaturePath: string;
  executionSignatureSha256: string;
  launcherPath: string;
  launcherSha256: string;
  runnerPath: string;
  runnerSha256: string;
  signerFingerprint: string;
  mode: PaidArtifactMode;
  nonce: string;
  verifiedAtUtc: string;
}

export interface PaidLaunchObservation {
  artifactRoot: string;
  executionManifestPath: string;
  executionManifestSha256: string;
  executionSignaturePath: string;
  executionSignatureSha256: string;
  launcherPath: string;
  launcherSha256: string;
  runnerPath: string;
  runnerSha256: string;
  processEntryPath: string;
  manifest: PaidExecutionManifest;
}

const GRANT_KEYS = [
  "artifactRoot",
  "artifactType",
  "executionManifestPath",
  "executionManifestSha256",
  "executionSignaturePath",
  "executionSignatureSha256",
  "launcherPath",
  "launcherSha256",
  "mode",
  "nonce",
  "runnerPath",
  "runnerSha256",
  "schemaVersion",
  "signerFingerprint",
  "verifiedAtUtc",
] as const;

function exactKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function fileFor(manifest: PaidExecutionManifest, path: string, role: PaidExecutionFile["role"]): PaidExecutionFile | undefined {
  return manifest.files.find((file) => file.path === path && file.role === role);
}

/** Validate the in-memory grant against fresh observations made by the bundle. */
export function verifyPaidLaunchGrant(
  grant: PaidLaunchGrant,
  observed: PaidLaunchObservation,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (grant == null || typeof grant !== "object" || !exactKeys(grant, GRANT_KEYS)) {
    return { ok: false, reasons: ["launch_grant_shape"] };
  }
  if (grant.schemaVersion !== PAID_LAUNCH_GRANT_SCHEMA_VERSION) reasons.push("launch_grant_schema");
  if (grant.artifactType !== PAID_ARTIFACT_TYPE) reasons.push("launch_grant_artifact_type");
  if (!/^[0-9a-f]{64}$/.test(grant.nonce)) reasons.push("launch_grant_nonce");
  if (!Number.isFinite(Date.parse(grant.verifiedAtUtc))) reasons.push("launch_grant_time");
  if (grant.signerFingerprint.toUpperCase() !== PAID_ARTIFACT_PINNED_SIGNER) reasons.push("launch_grant_signer");

  for (const key of [
    "artifactRoot",
    "executionManifestPath",
    "executionManifestSha256",
    "executionSignaturePath",
    "executionSignatureSha256",
    "launcherPath",
    "launcherSha256",
    "runnerPath",
    "runnerSha256",
  ] as const) {
    if (grant[key] !== observed[key]) reasons.push(`launch_grant_${key}_mismatch`);
  }
  if (observed.processEntryPath !== observed.launcherPath) reasons.push("launch_process_entry_not_launcher");

  const manifest = observed.manifest;
  if (manifest.schemaVersion !== PAID_ARTIFACT_SCHEMA_VERSION) reasons.push("execution_manifest_schema");
  if (manifest.artifactType !== PAID_ARTIFACT_TYPE) reasons.push("execution_manifest_artifact_type");
  if (manifest.requiredSignerFingerprint.toUpperCase() !== PAID_ARTIFACT_PINNED_SIGNER) reasons.push("execution_manifest_signer");
  if (!manifest.allowedModes.includes(grant.mode)) reasons.push("launch_mode_not_allowed");
  if (manifest.launcher !== PAID_ARTIFACT_LAUNCHER || manifest.runner !== PAID_ARTIFACT_RUNNER || manifest.verifier !== PAID_ARTIFACT_VERIFIER) {
    reasons.push("execution_manifest_entrypoints");
  }
  const launcher = fileFor(manifest, PAID_ARTIFACT_LAUNCHER, "launcher");
  const runner = fileFor(manifest, PAID_ARTIFACT_RUNNER, "runner");
  if (launcher?.sha256 !== grant.launcherSha256) reasons.push("execution_manifest_launcher_digest");
  if (runner?.sha256 !== grant.runnerSha256) reasons.push("execution_manifest_runner_digest");
  return { ok: reasons.length === 0, reasons };
}
