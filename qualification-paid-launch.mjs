#!/usr/bin/env node
// @ts-check
/**
 * Dependency-free Paid Pass v3.2 launcher.
 *
 * Fable must verify the signed execution manifest and launcher digest before
 * invoking `/usr/bin/node qualification-paid-launch.mjs`. This launcher then
 * independently verifies the complete isolated package before importing the
 * bundled driver. It never reads an API credential.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const ARTIFACT_SCHEMA_VERSION = 1;
export const GRANT_SCHEMA_VERSION = 2;
export const ARTIFACT_TYPE = "plinius-paid-pass-v3";
export const PINNED_SIGNER = "435C9CF0DE7A2C3900FB24357E622B43290C285E";
export const CAMPAIGN_POLICY_SCHEMA_VERSION = 2;
export const CAMPAIGN_POLICY_TYPE = "plinius-paid-campaign-policy-v2";
export const MANIFEST_NAME = "qualification-paid-execution-manifest.json";
export const SIGNATURE_NAME = `${MANIFEST_NAME}.sig`;
export const LAUNCHER_NAME = "qualification-paid-launch.mjs";
export const RUNNER_NAME = "qualification-driver.mjs";
export const VERIFIER_NAME = "qualification-paid-verify.mjs";
const MODES = new Set(["diagnostic-hosted-paid-r1", "diagnostic-candidate-paid-r1"]);
const GPG_CANDIDATES = ["/usr/bin/gpg", "/bin/gpg", "/opt/homebrew/bin/gpg", "/usr/local/bin/gpg", join(homedir(), ".nix-profile/bin/gpg")];

/** @param {Buffer | Uint8Array | string} bytes */
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** @param {string} value */
function safeRelativePath(value) {
  return value.length > 0 && !value.includes("\\") && !value.startsWith("/") && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** @param {string[]} candidates */
function pinnedBinary(candidates) {
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      const st = lstatSync(resolved);
      const immutableNixTarget = resolved.startsWith("/nix/store/");
      if (st.isFile() && !st.isSymbolicLink() && (resolved === candidate || immutableNixTarget)) return resolved;
    } catch {
      // Continue to the next authority-approved absolute path.
    }
  }
  throw new Error(`no pinned gpg binary found (${candidates.join(",")})`);
}

/** @param {Buffer} manifest @param {Buffer} signature */
function verifyDetachedSignature(manifest, signature) {
  const dir = mkdtempSync(join(tmpdir(), "plinius-paid-launch-"));
  try {
    chmodSync(dir, 0o700);
    const manifestPath = join(dir, "manifest.json");
    const signaturePath = join(dir, "manifest.json.sig");
    writeFileSync(manifestPath, manifest, { mode: 0o600 });
    writeFileSync(signaturePath, signature, { mode: 0o600 });
    const output = execFileSync(pinnedBinary(GPG_CANDIDATES), ["--batch", "--status-fd=1", "--verify", signaturePath, manifestPath], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const line = output.split("\n").find((item) => item.includes("[GNUPG:] VALIDSIG "));
    return line?.trim().split(/\s+/)[2] ?? "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {string} root @param {string} candidate */
function underRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

/** @param {string} path @param {number} uid @param {boolean} directory */
function assertSecurePath(path, uid, directory) {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile())) throw new Error(`insecure artifact type: ${path}`);
  if (!directory && st.nlink !== 1) throw new Error(`artifact has multiple hard links: ${path}`);
  if (typeof process.getuid === "function" && st.uid !== uid) throw new Error(`artifact owner mismatch: ${path}`);
  if ((st.mode & 0o077) !== 0) throw new Error(`artifact permissions expose group/other: ${path}`);
}

/** @param {string} root @param {number} uid */
function walkFiles(root, uid) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        assertSecurePath(absolute, uid, true);
        walk(absolute);
      }
      else files.push(relative(root, absolute).split(sep).join("/"));
    }
  };
  walk(root);
  return files.sort();
}

/**
 * Verify a complete isolated artifact package without importing project code.
 * Tests may inject signature verification; production always uses pinned gpg.
 * @param {string} artifactRoot
 * @param {{verifySignature?: (manifest:Buffer, signature:Buffer)=>string}} [options]
 */
export function verifyExecutionPackage(artifactRoot, options = {}) {
  const requestedRoot = resolve(artifactRoot);
  const requestedStat = lstatSync(requestedRoot);
  const requestedUid = typeof process.getuid === "function" ? process.getuid() : requestedStat.uid;
  assertSecurePath(requestedRoot, requestedUid, true);
  const root = realpathSync(artifactRoot);
  if (root !== requestedRoot) throw new Error("artifact root must be a canonical non-symlink path");
  const rootStat = statSync(root);
  const uid = typeof process.getuid === "function" ? process.getuid() : rootStat.uid;
  assertSecurePath(root, uid, true);
  const manifestPath = join(root, MANIFEST_NAME);
  const signaturePath = join(root, SIGNATURE_NAME);
  assertSecurePath(manifestPath, uid, false);
  assertSecurePath(signaturePath, uid, false);
  const manifestBytes = readFileSync(manifestPath);
  const signatureBytes = readFileSync(signaturePath);
  const manifest = /** @type {any} */ (JSON.parse(manifestBytes.toString("utf-8")));
  if (manifest.schemaVersion !== ARTIFACT_SCHEMA_VERSION || manifest.artifactType !== ARTIFACT_TYPE) throw new Error("execution manifest identity mismatch");
  if (manifest.requiredSignerFingerprint !== PINNED_SIGNER) throw new Error("execution manifest signer mismatch");
  if (manifest.launcher !== LAUNCHER_NAME || manifest.runner !== RUNNER_NAME || manifest.verifier !== VERIFIER_NAME) throw new Error("execution manifest entrypoint mismatch");
  if (!Array.isArray(manifest.allowedModes) || manifest.allowedModes.length !== MODES.size || manifest.allowedModes.some((/** @type {string} */ mode) => !MODES.has(mode))) throw new Error("execution manifest modes mismatch");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("execution manifest has no files");

  const expectedFiles = new Set([MANIFEST_NAME, SIGNATURE_NAME]);
  const seen = new Set();
  /** @type {Buffer | null} */
  let runnerBytes = null;
  for (const file of manifest.files) {
    if (file == null || typeof file !== "object" || !safeRelativePath(file.path) || !/^sha256:[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error("invalid execution manifest file entry");
    if (seen.has(file.path)) throw new Error(`duplicate execution file: ${file.path}`);
    seen.add(file.path);
    expectedFiles.add(file.path);
    const absolute = join(root, file.path);
    if (!underRoot(root, resolve(absolute))) throw new Error(`execution file escapes root: ${file.path}`);
    assertSecurePath(absolute, uid, false);
    const body = readFileSync(absolute);
    if (body.length !== file.bytes || sha256(body) !== file.sha256) throw new Error(`execution file digest mismatch: ${file.path}`);
    if (file.path === RUNNER_NAME && file.role === "runner") runnerBytes = body;
  }
  for (const [path, role] of [[LAUNCHER_NAME, "launcher"], [RUNNER_NAME, "runner"], [VERIFIER_NAME, "verifier"]]) {
    if (!manifest.files.some((/** @type {any} */ file) => file.path === path && file.role === role)) throw new Error(`missing ${role} entry`);
  }
  const actualFiles = walkFiles(root, uid);
  if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort())) throw new Error("execution package file set mismatch");

  const fingerprint = (options.verifySignature ?? verifyDetachedSignature)(manifestBytes, signatureBytes).toUpperCase();
  if (fingerprint !== PINNED_SIGNER) throw new Error(`execution signature signer mismatch: ${fingerprint}`);
  if (runnerBytes == null) throw new Error("verified execution package has no runner bytes");
  return { root, manifestPath, signaturePath, manifestBytes, signatureBytes, runnerBytes, manifest, fingerprint };
}

/**
 * Authenticate a short-lived campaign policy before loading the runner. The
 * retained bytes, rather than a reopenable path, cross the launcher boundary.
 * @param {string} policyPath
 * @param {string} signaturePath
 * @param {string} mode
 * @param {{verifySignature?: (manifest:Buffer, signature:Buffer)=>string, now?:()=>Date}} [options]
 */
export function verifyCampaignPolicy(policyPath, signaturePath, mode, options = {}) {
  const requestedPolicyPath = resolve(policyPath);
  const requestedSignaturePath = resolve(signaturePath);
  const requestedStat = lstatSync(requestedPolicyPath);
  const uid = typeof process.getuid === "function" ? process.getuid() : requestedStat.uid;
  assertSecurePath(requestedPolicyPath, uid, false);
  assertSecurePath(requestedSignaturePath, uid, false);
  const realPolicyPath = realpathSync(policyPath);
  const realSignaturePath = realpathSync(signaturePath);
  if (realPolicyPath !== requestedPolicyPath || realSignaturePath !== requestedSignaturePath) throw new Error("campaign policy paths must be canonical non-symlink paths");
  assertSecurePath(realPolicyPath, uid, false);
  assertSecurePath(realSignaturePath, uid, false);
  const policyBytes = readFileSync(realPolicyPath);
  const signatureBytes = readFileSync(realSignaturePath);
  const policy = JSON.parse(policyBytes.toString("utf-8"));
  if (policy.schemaVersion !== CAMPAIGN_POLICY_SCHEMA_VERSION || policy.policyType !== CAMPAIGN_POLICY_TYPE) throw new Error("campaign policy identity mismatch");
  if (policy.requiredSignerFingerprint !== PINNED_SIGNER) throw new Error("campaign policy signer mismatch");
  if (policy.pass?.mode !== mode || !MODES.has(mode)) throw new Error("campaign policy mode mismatch");
  /** @param {unknown} value */
  const canonicalUtc = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return NaN;
    const canonical = new Date(parsed).toISOString();
    return value === canonical || value === canonical.replace(".000Z", "Z") ? parsed : NaN;
  };
  const issued = canonicalUtc(policy.issuedAtUtc);
  const expires = canonicalUtc(policy.expiresAtUtc);
  const now = (options.now ?? (() => new Date()))().getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 5 * 60 * 1000 || expires <= now || expires <= issued || expires - issued > 7 * 24 * 60 * 60 * 1000) {
    throw new Error("campaign policy time window invalid");
  }
  const fingerprint = (options.verifySignature ?? verifyDetachedSignature)(policyBytes, signatureBytes).toUpperCase();
  if (fingerprint !== PINNED_SIGNER) throw new Error(`campaign policy signature signer mismatch: ${fingerprint}`);
  return {
    policyPath: realPolicyPath,
    signaturePath: realSignaturePath,
    policyBytes,
    signatureBytes,
    policySha256: sha256(policyBytes),
    signatureSha256: sha256(signatureBytes),
    fingerprint,
  };
}

/** @param {ReturnType<typeof verifyExecutionPackage>} verified @param {string} mode */
/** @param {ReturnType<typeof verifyExecutionPackage>} verified @param {string} mode @param {ReturnType<typeof verifyCampaignPolicy>} campaignPolicy */
export function createLaunchGrant(verified, mode, campaignPolicy) {
  if (!MODES.has(mode)) throw new Error(`unsupported paid mode: ${mode}`);
  if (campaignPolicy == null || campaignPolicy.fingerprint !== PINNED_SIGNER) throw new Error("verified campaign policy required");
  const byPath = new Map(verified.manifest.files.map((/** @type {any} */ file) => [file.path, file]));
  const launcherPath = realpathSync(join(verified.root, LAUNCHER_NAME));
  const runnerPath = realpathSync(join(verified.root, RUNNER_NAME));
  return Object.freeze({
    schemaVersion: GRANT_SCHEMA_VERSION,
    artifactType: ARTIFACT_TYPE,
    artifactRoot: verified.root,
    executionManifestPath: verified.manifestPath,
    executionManifestSha256: sha256(verified.manifestBytes),
    executionSignaturePath: verified.signaturePath,
    executionSignatureSha256: sha256(verified.signatureBytes),
    launcherPath,
    launcherSha256: byPath.get(LAUNCHER_NAME).sha256,
    runnerPath,
    runnerSha256: byPath.get(RUNNER_NAME).sha256,
    signerFingerprint: verified.fingerprint,
    campaignPolicyPath: campaignPolicy.policyPath,
    campaignPolicySha256: campaignPolicy.policySha256,
    campaignPolicyBase64: campaignPolicy.policyBytes.toString("base64"),
    campaignPolicySignaturePath: campaignPolicy.signaturePath,
    campaignPolicySignatureSha256: campaignPolicy.signatureSha256,
    campaignPolicySignatureBase64: campaignPolicy.signatureBytes.toString("base64"),
    campaignPolicySignerFingerprint: campaignPolicy.fingerprint,
    mode,
    nonce: randomBytes(32).toString("hex"),
    verifiedAtUtc: new Date().toISOString(),
  });
}

/**
 * Import the exact runner bytes retained by package verification. Importing the
 * path again would reopen a verify/use race for a same-UID replacement between
 * digest validation and module loading.
 * @param {ReturnType<typeof verifyExecutionPackage>} verified
 * @param {ReturnType<typeof createLaunchGrant>} grant
 */
export async function loadVerifiedRunner(verified, grant) {
  if (sha256(verified.runnerBytes) !== grant.runnerSha256) throw new Error("verified runner bytes no longer match launch grant");
  const specifier = `data:text/javascript;base64,${verified.runnerBytes.toString("base64")}#${grant.runnerSha256.slice(7)}`;
  return import(specifier);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  let root = dirname(fileURLToPath(import.meta.url));
  let mode = process.env.PLINIUS_DRIVER_MODE ?? "";
  let policy = "";
  let policySignature = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--artifact-root") root = argv[++i] ?? "";
    else if (argv[i] === "--mode") mode = argv[++i] ?? "";
    else if (argv[i] === "--policy") policy = argv[++i] ?? "";
    else if (argv[i] === "--policy-signature") policySignature = argv[++i] ?? "";
    else throw new Error(`unknown launcher argument: ${argv[i]}`);
  }
  if (!policy || !policySignature) throw new Error("--policy and --policy-signature are required");
  return { root, mode, policy, policySignature };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const verified = verifyExecutionPackage(args.root);
  const campaignPolicy = verifyCampaignPolicy(args.policy, args.policySignature, args.mode);
  const grant = createLaunchGrant(verified, args.mode, campaignPolicy);
  process.chdir(verified.root);
  const driver = await loadVerifiedRunner(verified, grant);
  if (typeof driver.paidArtifactMain !== "function") throw new Error("bundled driver has no paidArtifactMain export");
  const processEntryPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
  await driver.paidArtifactMain(grant, {
    artifactRoot: grant.artifactRoot,
    executionManifestPath: grant.executionManifestPath,
    executionManifestSha256: grant.executionManifestSha256,
    executionSignaturePath: grant.executionSignaturePath,
    executionSignatureSha256: grant.executionSignatureSha256,
    launcherPath: grant.launcherPath,
    launcherSha256: grant.launcherSha256,
    runnerPath: grant.runnerPath,
    runnerSha256: grant.runnerSha256,
    campaignPolicyPath: grant.campaignPolicyPath,
    campaignPolicySha256: grant.campaignPolicySha256,
    campaignPolicySignaturePath: grant.campaignPolicySignaturePath,
    campaignPolicySignatureSha256: grant.campaignPolicySignatureSha256,
    campaignPolicySignerFingerprint: grant.campaignPolicySignerFingerprint,
    processEntryPath,
    manifest: verified.manifest,
  });
}

function invokedDirectly() {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error("PAID ARTIFACT LAUNCH REJECTED:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
