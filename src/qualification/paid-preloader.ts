/**
 * Minimal paid-pass preloader decision logic (C1-PAID-R6-F01).
 *
 * WHY THIS MODULE EXISTS: importing the paid driver executes its ENTIRE dependency
 * closure (every `src/**` and `node_modules` module) as a side effect of module
 * initialization — BEFORE the in-driver source gate runs. A tampered dependency, or a
 * rogue `node_modules` symlink target, would therefore have already executed by the
 * time the gate fires. The fix is an EXTERNAL, minimal preloader entry that verifies
 * the executable artifact + the pinned dependency closure and the `node_modules`
 * symlink FIRST, and only THEN dynamically imports the driver.
 *
 * This module is that preloader's PURE decision core. It is deliberately DEPENDENCY-FREE
 * (no imports at all — not even node builtins), so importing it loads no other code:
 * the entry observes the filesystem with node builtins and hands the observation here.
 * Keep it self-contained; never import the paid-campaign module (that would pull the very
 * closure we are trying to verify-before-load).
 */

/** The FULL 40-hex authority fingerprint that must have signed the source manifest. */
export const PAID_PRELOAD_PINNED_SIGNER = "435C9CF0DE7A2C3900FB24357E622B43290C285E";

/** Env marker the preloader sets after a PASS; the driver's paid path refuses to run
 * without it, so paid dispatch can never happen on a driver loaded without preloading. */
export const PAID_PRELOAD_MARKER = "PLINIUS_PAID_PRELOAD_VERIFIED";

/** One pinned executable-closure file: its authority-pinned digest vs the on-disk digest. */
export interface PreloadFileObservation {
  path: string;
  expectedSha256: string;
  /** null when the file is absent / unreadable on disk. */
  actualSha256: string | null;
}

/** Everything the minimal entry observed with node builtins, for the decision. */
export interface PreloadObservation {
  /** The detached signature over the source manifest verified to a real key. */
  signatureVerified: boolean;
  /** The full fingerprint observed from the VALIDSIG line (or null). */
  signerFingerprint: string | null;
  /** `node_modules` MUST be a symlink whose realpath resolves to a directory. */
  nodeModulesIsSymlink: boolean;
  nodeModulesRealpathIsDirectory: boolean;
  /** git HEAD commit + tree vs the manifest's pinned values, and a clean worktree. */
  observedCommit: string;
  expectedCommit: string;
  observedTree: string;
  expectedTree: string;
  worktreeCleanInclUntracked: boolean;
  /** Every file the source manifest pins, with its expected + on-disk digest. */
  files: PreloadFileObservation[];
}

/**
 * Decide whether it is safe to LOAD the paid driver. Fail-closed: a bad signature, an
 * unpinned signer, an unapproved `node_modules`, a dirty worktree, a commit/tree drift,
 * an empty pin set, or ANY missing / mismatched pinned file rejects — and the entry must
 * exit non-zero WITHOUT importing the driver.
 */
export function decidePreload(obs: PreloadObservation): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!obs.signatureVerified) reasons.push("signature_invalid");
  if (obs.signerFingerprint == null || obs.signerFingerprint.toUpperCase() !== PAID_PRELOAD_PINNED_SIGNER) {
    reasons.push(`signer_unpinned:${String(obs.signerFingerprint)}`);
  }
  if (!obs.nodeModulesIsSymlink || !obs.nodeModulesRealpathIsDirectory) reasons.push("node_modules_unapproved");
  if (!obs.worktreeCleanInclUntracked) reasons.push("worktree_dirty_or_untracked");
  if (!obs.expectedCommit || obs.observedCommit !== obs.expectedCommit) reasons.push(`commit_mismatch:${obs.observedCommit}`);
  if (!obs.expectedTree || obs.observedTree !== obs.expectedTree) reasons.push(`tree_mismatch:${obs.observedTree}`);
  if (!Array.isArray(obs.files) || obs.files.length === 0) reasons.push("no_pinned_files");
  for (const f of obs.files ?? []) {
    if (f.actualSha256 == null) reasons.push(`file_missing:${f.path}`);
    else if (f.actualSha256 !== f.expectedSha256) reasons.push(`file_digest_mismatch:${f.path}`);
  }
  return { ok: reasons.length === 0, reasons };
}
