#!/usr/bin/env node
// @ts-check
/** Build a source-tree-independent Paid Pass v2 package on the Mac authority. */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_SIGNER = "435C9CF0DE7A2C3900FB24357E622B43290C285E";
const MANIFEST = "qualification-paid-execution-manifest.json";
const BENCHMARK_IDS = [
  "software-engineering/se-concurrency-atomic-stats-012",
  "architecture/arch-exactly-once-003",
  "security/sec-oidc-id-token-validation-001",
  "formal-reasoning/formal-spec-idempotent-api-003",
];
const GPG_CANDIDATES = ["/opt/homebrew/bin/gpg", "/usr/local/bin/gpg", "/usr/bin/gpg"];

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
      const st = lstatSync(path);
      if (st.isFile() && !st.isSymbolicLink()) return path;
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
  let output = join(REPO, "build", "qualification-paid-v2");
  let sign = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--output") output = resolve(argv[++i] ?? "");
    else if (argv[i] === "--no-sign") sign = false;
    else if (argv[i] === "--sign") sign = true;
    else throw new Error(`unknown build argument: ${argv[i]}`);
  }
  return { output, sign };
}

async function main() {
  const { output, sign } = parseArgs(process.argv.slice(2));
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") throw new Error("paid artifact build requires a completely clean committed worktree");
  const buildRoot = join(REPO, "build");
  if (output === REPO || !output.startsWith(`${buildRoot}${sep}`)) throw new Error("output must be beneath the repository build directory");
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true, mode: 0o700 });

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
    outfile: join(output, "qualification-driver.mjs"),
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
        "// Plinius Paid Pass v2 isolated driver bundle.",
        'import { createRequire as __pliniusCreateRequire } from "node:module";',
        'const require = __pliniusCreateRequire(process.cwd() + "/qualification-driver.mjs");',
      ].join("\n"),
    },
  });
  cpSync(join(REPO, "qualification-paid-launch.mjs"), join(output, "qualification-paid-launch.mjs"));
  cpSync(join(REPO, "qualification-paid-verify.mjs"), join(output, "qualification-paid-verify.mjs"));
  for (const id of BENCHMARK_IDS) {
    cpSync(join(REPO, "benchmark", id), join(output, "benchmark", id), { recursive: true, dereference: false, errorOnExist: true });
  }

  /** @param {string} path */
  const roleFor = (path) => path === "qualification-paid-launch.mjs" ? "launcher" : path === "qualification-driver.mjs" ? "runner" : path === "qualification-paid-verify.mjs" ? "verifier" : "benchmark";
  const files = walk(output).map((absolute) => {
    const path = relative(output, absolute).split(sep).join("/");
    const body = readFileSync(absolute);
    chmodSync(absolute, 0o600);
    return { path, sha256: sha256(body), bytes: body.length, role: roleFor(path) };
  });
  const manifest = {
    schemaVersion: 1,
    artifactType: "plinius-paid-pass-v2",
    createdAtUtc: new Date().toISOString(),
    source: { commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]) },
    requiredSignerFingerprint: PINNED_SIGNER,
    allowedModes: ["diagnostic-hosted-paid-r1", "diagnostic-candidate-paid-r1"],
    launcher: "qualification-paid-launch.mjs",
    runner: "qualification-driver.mjs",
    verifier: "qualification-paid-verify.mjs",
    files,
  };
  const manifestPath = join(output, MANIFEST);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (sign) {
    const signaturePath = `${manifestPath}.sig`;
    execFileSync(pinnedBinary(GPG_CANDIDATES), ["--batch", "--yes", "--local-user", PINNED_SIGNER, "--output", signaturePath, "--detach-sign", manifestPath], { stdio: "inherit" });
    chmodSync(signaturePath, 0o600);
  } else {
    console.warn("UNSIGNED TEST ARTIFACT: launcher will reject it until the detached signature is added");
  }
  console.log(JSON.stringify({ output: realpathSync(output), manifest: basename(manifestPath), manifestSha256: sha256(readFileSync(manifestPath)), signed: sign }, null, 2));
}

main().catch((error) => {
  console.error("PAID ARTIFACT BUILD FAILED:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
