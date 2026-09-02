#!/usr/bin/env node
// @ts-check
/** Build a source-tree-independent Paid Pass v3.6 engine package on the Mac authority. */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseCampaignPolicy } from "../qualification-paid-verify.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_SIGNER = "435C9CF0DE7A2C3900FB24357E622B43290C285E";
const MANIFEST = "qualification-paid-execution-manifest.json";
const BENCHMARK_IDS = [
  "software-engineering/se-concurrency-atomic-stats-012",
  "architecture/arch-exactly-once-003",
  "security/sec-oidc-id-token-validation-001",
  "formal-reasoning/formal-spec-idempotent-api-003",
];
const GPG_CANDIDATES = ["/opt/homebrew/bin/gpg", "/usr/local/bin/gpg", "/usr/bin/gpg", join(homedir(), ".nix-profile/bin/gpg")];

/** @param {Buffer | string} body */
const sha256 = (body) => `sha256:${createHash("sha256").update(body).digest("hex")}`;

/** @param {string} root */
function walk(root) {
  /** @type {string[]} */ const out = [];
  /** @param {string} dir */
  const visit = (dir) => {
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else out.push(path);
    }
  };
  visit(root);
  return out.sort();
}

/** @param {string[]} candidates */
function pinnedBinary(candidates) {
  for (const path of candidates) {
    try {
      const resolved = realpathSync(path);
      const st = lstatSync(resolved);
      const immutableNixTarget = resolved.startsWith("/nix/store/");
      if (st.isFile() && !st.isSymbolicLink() && (resolved === path || immutableNixTarget)) return resolved;
    } catch {
      // Continue.
    }
  }
  throw new Error("no pinned gpg binary available");
}

/** @param {string[]} args */
function git(args) {
  return execFileSync("/usr/bin/git", ["-C", REPO, ...args], { encoding: "utf-8" }).trim();
}

/** @param {string[]} argv */
function parseArgs(argv) {
  let output = join(REPO, "build", "qualification-paid-v3.6-release");
  let policy = "";
  let sign = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--output") output = resolve(argv[++i] ?? "");
    else if (argv[i] === "--policy") policy = resolve(argv[++i] ?? "");
    else if (argv[i] === "--no-sign") sign = false;
    else if (argv[i] === "--sign") sign = true;
    else throw new Error(`unknown build argument: ${argv[i]}`);
  }
  if (!policy) throw new Error("--policy is required; no campaign policy is selected implicitly");
  return { output, policy, sign };
}

async function main() {
  const { output, policy, sign } = parseArgs(process.argv.slice(2));
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") throw new Error("paid artifact build requires a completely clean committed worktree");
  const buildRoot = join(REPO, "build");
  if (output === REPO || !output.startsWith(`${buildRoot}${sep}`)) throw new Error("output must be beneath the repository build directory");
  const policyRoot = realpathSync(join(REPO, "policy"));
  const policyPath = realpathSync(policy);
  if (!policyPath.startsWith(`${policyRoot}${sep}`) || resolve(policy) !== policyPath) throw new Error("policy must be a canonical path beneath the repository policy directory");
  const policyStat = lstatSync(policyPath);
  if (!policyStat.isFile() || policyStat.isSymbolicLink() || policyStat.nlink !== 1) throw new Error("policy must be a regular non-symlink single-link file");
  const policyBytes = readFileSync(policyPath);
  const policyDocument = JSON.parse(policyBytes.toString("utf-8"));
  if (!Buffer.from(`${JSON.stringify(policyDocument, null, 2)}\n`, "utf-8").equals(policyBytes)) throw new Error("policy must be canonical pretty JSON");
  const policyIdentityOk =
    (policyDocument.schemaVersion === 2 && policyDocument.policyType === "plinius-paid-campaign-policy-v2") ||
    (policyDocument.schemaVersion === 3 && policyDocument.policyType === "plinius-paid-campaign-policy-v3");
  if (!policyIdentityOk || policyDocument.requiredSignerFingerprint !== PINNED_SIGNER) {
    throw new Error("policy identity or signer mismatch");
  }
  parseCampaignPolicy(policyBytes);

  rmSync(output, { recursive: true, force: true });
  const engineOutput = join(output, "engine");
  const policyOutput = join(output, "policy");
  mkdirSync(engineOutput, { recursive: true, mode: 0o700 });
  mkdirSync(policyOutput, { recursive: true, mode: 0o700 });

  await build({
    stdin: {
      contents: [
        'import { realpathSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        'export { paidArtifactMain } from "./qualification-driver.mts";',
        'let direct = false;',
        'try { direct = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch {}',
        'if (direct) {',
        '  console.error("PAID ARTIFACT DRIVER REJECTED: invoke qualification-paid-launch.mjs");',
        '  process.exitCode = 1;',
        '}',
      ].join("\n"),
      resolveDir: REPO,
      sourcefile: "qualification-paid-bundle-entry.mjs",
      loader: "js",
    },
    outfile: join(engineOutput, "qualification-driver.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    sourcemap: false,
    legalComments: "none",
    treeShaking: true,
    define: { __PLINIUS_PAID_BUNDLE__: "true" },
    banner: {
      js: [
        "// Plinius Paid Pass v3.6 isolated driver bundle.",
        'import { createRequire as __pliniusCreateRequire } from "node:module";',
        'const require = __pliniusCreateRequire(process.cwd() + "/qualification-driver.mjs");',
      ].join("\n"),
    },
  });
  const runnerPath = join(engineOutput, "qualification-driver.mjs");
  const runnerText = readFileSync(runnerPath, "utf-8");
  const policyTargets = Array.isArray(policyDocument.pass?.targets) ? policyDocument.pass.targets : [];
  const policyModelIdentifiers = new Set(policyTargets.flatMap((/** @type {any} */ target) => [target.slug, target.catalogModelId, target.responseModelId, target.lookupModelId]));
  for (const identifier of policyModelIdentifiers) {
    if (typeof identifier !== "string" || identifier.length === 0) throw new Error("policy contains an invalid model identifier");
    if (runnerText.includes(identifier)) throw new Error(`policy model identifier leaked into stable engine bundle: ${identifier}`);
  }
  cpSync(join(REPO, "qualification-paid-launch.mjs"), join(engineOutput, "qualification-paid-launch.mjs"));
  cpSync(join(REPO, "qualification-paid-verify.mjs"), join(engineOutput, "qualification-paid-verify.mjs"));
  for (const id of BENCHMARK_IDS) {
    cpSync(join(REPO, "benchmark", id), join(engineOutput, "benchmark", id), { recursive: true, dereference: false, errorOnExist: true });
  }

  /** @param {string} path */
  const roleFor = (path) => path === "qualification-paid-launch.mjs" ? "launcher" : path === "qualification-driver.mjs" ? "runner" : path === "qualification-paid-verify.mjs" ? "verifier" : "benchmark";
  const files = walk(engineOutput).map((absolute) => {
    const path = relative(engineOutput, absolute).split(sep).join("/");
    const body = readFileSync(absolute);
    chmodSync(absolute, 0o600);
    return { path, sha256: sha256(body), bytes: body.length, role: roleFor(path) };
  });
  const manifest = {
    schemaVersion: 1,
    artifactType: "plinius-paid-pass-v3",
    createdAtUtc: new Date().toISOString(),
    source: { commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]) },
    requiredSignerFingerprint: PINNED_SIGNER,
    allowedModes: ["diagnostic-hosted-paid-r1", "diagnostic-candidate-paid-r1", "diagnostic-broad-paid-r1", "diagnostic-selective-paid-r1"],
    launcher: "qualification-paid-launch.mjs",
    runner: "qualification-driver.mjs",
    verifier: "qualification-paid-verify.mjs",
    files,
  };
  const manifestPath = join(engineOutput, MANIFEST);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const packagedPolicyPath = join(policyOutput, basename(policyPath));
  cpSync(policyPath, packagedPolicyPath, { dereference: false, errorOnExist: true });
  chmodSync(packagedPolicyPath, 0o600);
  if (sign) {
    const signaturePath = `${manifestPath}.sig`;
    execFileSync(pinnedBinary(GPG_CANDIDATES), ["--batch", "--yes", "--local-user", PINNED_SIGNER, "--output", signaturePath, "--detach-sign", manifestPath], { stdio: "inherit" });
    chmodSync(signaturePath, 0o600);
    const policySignaturePath = `${packagedPolicyPath}.sig`;
    execFileSync(pinnedBinary(GPG_CANDIDATES), ["--batch", "--yes", "--local-user", PINNED_SIGNER, "--output", policySignaturePath, "--detach-sign", packagedPolicyPath], { stdio: "inherit" });
    chmodSync(policySignaturePath, 0o600);
  } else {
    console.warn("UNSIGNED TEST PACKAGE: launcher will reject it until both detached signatures are added");
  }
  const checksumBody = walk(output)
    .map((absolute) => `${sha256(readFileSync(absolute)).slice("sha256:".length)}  ${relative(output, absolute).split(sep).join("/")}`)
    .join("\n") + "\n";
  const checksumsPath = join(output, "SHA256SUMS");
  writeFileSync(checksumsPath, checksumBody, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({
    packageRoot: realpathSync(output),
    artifactRoot: realpathSync(engineOutput),
    manifest: relative(output, manifestPath),
    manifestSha256: sha256(readFileSync(manifestPath)),
    policy: relative(output, packagedPolicyPath),
    policySha256: sha256(readFileSync(packagedPolicyPath)),
    checksumsSha256: sha256(readFileSync(checksumsPath)),
    signed: sign,
  }, null, 2));
}

main().catch((error) => {
  console.error("PAID ARTIFACT BUILD FAILED:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
