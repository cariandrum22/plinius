/**
 * External minimal preloader for the paid passes (C1-PAID-R6-F01 / C1-PAID-R7-F01/F02).
 *
 * This is the ONLY sanctioned entry point for a paid pass; the driver refuses a direct
 * paid invocation. It is launched by the project's standard runner:
 *
 *     pnpm paid:preload        # = tsx qualification-paid-preload.mts
 *
 * It is fully SELF-CONTAINED: it imports NOTHING from the project (not even the preloader
 * decision core), so no part of the paid driver's dependency closure — and no other
 * project file that could be tampered — executes before verification. Its own bytes are
 * the single trust root, pinned by the authority source manifest. It:
 *
 *   1. verifies the source manifest's detached signature (pinned FULL fingerprint) with a
 *      PINNED-ABSOLUTE gpg (never $PATH), via an argument vector (no shell);
 *   2. verifies git HEAD commit + tree against the manifest and a clean worktree
 *      (untracked included; only an APPROVED node_modules symlink → directory tolerated),
 *      using a PINNED-ABSOLUTE git;
 *   3. re-hashes EVERY file the manifest pins (the executable closure);
 *   4. only on a full PASS sets the marker and dynamically imports the driver, invoking
 *      its paid entry — so tampered dependency code never runs.
 *
 * The pure decision is duplicated in src/qualification/paid-preloader.ts ONLY for unit
 * testing; this entry inlines an identical `decide` so it depends on nothing.
 */
import { readFileSync, lstatSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_SIGNER = "435C9CF0DE7A2C3900FB24357E622B43290C285E";
const PRELOAD_MARKER = "PLINIUS_PAID_PRELOAD_VERIFIED";
const GPG_CANDIDATES = ["/usr/bin/gpg", "/bin/gpg", "/usr/local/bin/gpg"];
const GIT_CANDIDATES = ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"];

const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function pinnedBinary(candidates: string[]): string {
  for (const c of candidates) {
    try {
      const st = lstatSync(c);
      if (st.isFile() && !st.isSymbolicLink()) return c;
    } catch {
      /* next */
    }
  }
  throw new Error(`no pinned absolute binary among: ${candidates.join(", ")}`);
}

interface PreObs {
  signatureVerified: boolean;
  signerFingerprint: string | null;
  nodeModulesApproved: boolean;
  observedCommit: string;
  expectedCommit: string;
  observedTree: string;
  expectedTree: string;
  worktreeCleanInclUntracked: boolean;
  files: Array<{ path: string; expectedSha256: string; actualSha256: string | null }>;
}

/** Identical to decidePreload in src/qualification/paid-preloader.ts (unit-tested there). */
function decide(o: PreObs): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!o.signatureVerified) reasons.push("signature_invalid");
  if (o.signerFingerprint == null || o.signerFingerprint.toUpperCase() !== PINNED_SIGNER) reasons.push(`signer_unpinned:${String(o.signerFingerprint)}`);
  if (!o.nodeModulesApproved) reasons.push("node_modules_unapproved");
  if (!o.worktreeCleanInclUntracked) reasons.push("worktree_dirty_or_untracked");
  if (!o.expectedCommit || o.observedCommit !== o.expectedCommit) reasons.push(`commit_mismatch:${o.observedCommit}`);
  if (!o.expectedTree || o.observedTree !== o.expectedTree) reasons.push(`tree_mismatch:${o.observedTree}`);
  if (!Array.isArray(o.files) || o.files.length === 0) reasons.push("no_pinned_files");
  for (const f of o.files ?? []) {
    if (f.actualSha256 == null) reasons.push(`file_missing:${f.path}`);
    else if (f.actualSha256 !== f.expectedSha256) reasons.push(`file_digest_mismatch:${f.path}`);
  }
  return { ok: reasons.length === 0, reasons };
}

function observe(): PreObs {
  const repo = dirname(fileURLToPath(import.meta.url));
  const manifestPath = process.env.PAID_SOURCE_MANIFEST_PATH;
  if (!manifestPath) throw new Error("PAID_SOURCE_MANIFEST_PATH is required for the paid preloader");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { commit: string; tree: string; files: Array<{ path: string; sha256: string }> };
  const gpg = pinnedBinary(GPG_CANDIDATES);
  const gitBin = pinnedBinary(GIT_CANDIDATES);

  let signatureVerified = false;
  let signerFingerprint: string | null = null;
  try {
    const out = execFileSync(gpg, ["--status-fd=1", "--verify", manifestPath + ".sig", manifestPath], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const valid = out.split("\n").find((l) => l.includes("[GNUPG:] VALIDSIG"));
    if (valid) {
      signatureVerified = true;
      signerFingerprint = valid.trim().split(/\s+/)[2] ?? null;
    }
  } catch {
    signatureVerified = false;
  }

  let nodeModulesApproved = false;
  try {
    const nm = join(repo, "node_modules");
    if (lstatSync(nm).isSymbolicLink()) nodeModulesApproved = statSync(realpathSync(nm)).isDirectory();
  } catch {
    nodeModulesApproved = false;
  }

  const git = (args: string[]) => execFileSync(gitBin, ["-C", repo, ...args], { encoding: "utf-8" }).trim();
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"])
    .split("\n")
    .filter((l) => l.length > 0 && !(l === "?? node_modules" && nodeModulesApproved));

  return {
    signatureVerified,
    signerFingerprint,
    nodeModulesApproved,
    observedCommit: git(["rev-parse", "HEAD"]),
    expectedCommit: manifest.commit,
    observedTree: git(["rev-parse", "HEAD^{tree}"]),
    expectedTree: manifest.tree,
    worktreeCleanInclUntracked: status.length === 0,
    files: (manifest.files ?? []).map((f) => {
      let actualSha256: string | null = null;
      try {
        actualSha256 = sha256Hex(readFileSync(join(repo, f.path)));
      } catch {
        actualSha256 = null;
      }
      return { path: f.path, expectedSha256: f.sha256, actualSha256 };
    }),
  };
}

async function preloadAndRun(): Promise<void> {
  const decision = decide(observe());
  if (!decision.ok) {
    console.error("PAID_PRELOAD_REJECTED:", decision.reasons.join(","));
    process.exit(2);
  }
  console.error("PAID_PRELOAD_OK: closure verified; loading driver");
  process.env[PRELOAD_MARKER] = "1";
  // Only NOW is the driver (and its whole closure) loaded — after verification.
  const driver = (await import("./qualification-driver.mjs")) as { paidMain: (mode: string) => Promise<void>; resolveDriverMode: (raw: string | undefined) => string };
  const mode = driver.resolveDriverMode(process.env.PLINIUS_DRIVER_MODE);
  if (mode !== "diagnostic-hosted-paid-r1" && mode !== "diagnostic-candidate-paid-r1") {
    throw new Error(`preloader only launches paid modes; got ${mode}`);
  }
  await driver.paidMain(mode);
}

preloadAndRun().catch((e) => {
  console.error("PAID_PRELOAD ERROR:", e);
  process.exit(1);
});
