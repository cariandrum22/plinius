/**
 * External minimal preloader for the paid passes (C1-PAID-R6-F01).
 *
 * This is the ONLY sanctioned entry point for a paid pass. It imports NOTHING from the
 * project except the dependency-free `decidePreload` core, so no part of the paid
 * driver's closure executes before verification. It:
 *
 *   1. verifies the authority source manifest's detached signature (pinned full
 *      fingerprint) with gpg via an argument vector (no shell);
 *   2. verifies git HEAD commit + tree against the manifest and a clean worktree
 *      (untracked included, only an APPROVED node_modules symlink tolerated);
 *   3. re-hashes EVERY file the manifest pins (the executable closure) and requires a
 *      match;
 *   4. only on a full PASS sets the marker and dynamically imports the driver, invoking
 *      its paid entry.
 *
 * A rejection exits non-zero WITHOUT importing the driver, so tampered dependency code
 * never runs. This file is not tsc-checked (rootDir is src); its logic core
 * (`decidePreload`) is pure and unit-tested.
 */
import { readFileSync, lstatSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { decidePreload, PAID_PRELOAD_MARKER, type PreloadObservation, type PreloadFileObservation } from "./src/qualification/paid-preloader.js";

const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function observe(): PreloadObservation {
  const repo = dirname(fileURLToPath(import.meta.url));
  const manifestPath = process.env.PAID_SOURCE_MANIFEST_PATH;
  if (!manifestPath) throw new Error("PAID_SOURCE_MANIFEST_PATH is required for the paid preloader");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { commit: string; tree: string; files: Array<{ path: string; sha256: string }> };

  // (1) detached-signature verification via an argument vector (no shell).
  let signatureVerified = false;
  let signerFingerprint: string | null = null;
  try {
    const out = execFileSync("gpg", ["--status-fd=1", "--verify", manifestPath + ".sig", manifestPath], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const valid = out.split("\n").find((l) => l.includes("[GNUPG:] VALIDSIG"));
    if (valid) {
      signatureVerified = true;
      signerFingerprint = valid.trim().split(/\s+/)[2] ?? null;
    }
  } catch {
    signatureVerified = false;
  }

  // (2) node_modules must be an approved symlink → directory.
  let nodeModulesIsSymlink = false;
  let nodeModulesRealpathIsDirectory = false;
  try {
    const nm = join(repo, "node_modules");
    if (lstatSync(nm).isSymbolicLink()) {
      nodeModulesIsSymlink = true;
      nodeModulesRealpathIsDirectory = statSync(realpathSync(nm)).isDirectory();
    }
  } catch {
    nodeModulesIsSymlink = false;
  }

  // (3) git state (execFile, no shell).
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"])
    .split("\n")
    .filter((l) => l.length > 0 && !(l === "?? node_modules" && nodeModulesIsSymlink && nodeModulesRealpathIsDirectory));

  // (4) re-hash every pinned closure file.
  const files: PreloadFileObservation[] = (manifest.files ?? []).map((f) => {
    let actualSha256: string | null = null;
    try {
      actualSha256 = sha256Hex(readFileSync(join(repo, f.path)));
    } catch {
      actualSha256 = null;
    }
    return { path: f.path, expectedSha256: f.sha256, actualSha256 };
  });

  return {
    signatureVerified,
    signerFingerprint,
    nodeModulesIsSymlink,
    nodeModulesRealpathIsDirectory,
    observedCommit: git(["rev-parse", "HEAD"]),
    expectedCommit: manifest.commit,
    observedTree: git(["rev-parse", "HEAD^{tree}"]),
    expectedTree: manifest.tree,
    worktreeCleanInclUntracked: status.length === 0,
    files,
  };
}

async function preloadAndRun(): Promise<void> {
  const decision = decidePreload(observe());
  if (!decision.ok) {
    console.error("PAID_PRELOAD_REJECTED:", decision.reasons.join(","));
    process.exit(2);
  }
  console.error("PAID_PRELOAD_OK: closure verified; loading driver");
  process.env[PAID_PRELOAD_MARKER] = "1";
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
