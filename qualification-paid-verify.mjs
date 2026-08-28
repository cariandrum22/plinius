#!/usr/bin/env node
// @ts-check
/** Independent post-transfer verifier for Paid Pass v2 Evidence. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const EVIDENCE_SCHEMA_VERSION = 5;
export const EXECUTION_SCHEMA_VERSION = 1;
export const EXECUTION_ARTIFACT_TYPE = "plinius-paid-pass-v2";
export const PINNED_SIGNER = "435C9CF0DE7A2C3900FB24357E622B43290C285E";
export const HISTORICAL_PARENT_DIGESTS = [
  "sha256:5464aac6862ee2b001cae40ac861d43b64abb9b0cd705bfa539252104963c66e",
  "sha256:eba5485902b6fa8307dc4cf1e3ff4c4bf99175f9e63eaedd0c81102332fae86d",
  "sha256:05390908e2dcadc2f029292a98be21ccc13b7e39ee8ce3b8d3660d455a1ff026",
];
const GPG_CANDIDATES = ["/opt/homebrew/bin/gpg", "/usr/local/bin/gpg", "/usr/bin/gpg", "/bin/gpg"];
const PASS_IDENTITIES = new Map([
  ["plinius-qualification-2026-08-22-diagnostic-hosted-paid-r1", { campaignId: "plinius-qualification-2026-08-22-v1", mode: "diagnostic-hosted-paid-r1", totalCells: 15, totalCapUsd: 5, perRunCapUsd: 1 }],
  ["plinius-qualification-2026-08-26-diagnostic-candidate-paid-r1", { campaignId: "plinius-qualification-2026-08-26-candidate-r1", mode: "diagnostic-candidate-paid-r1", totalCells: 16, totalCapUsd: 6, perRunCapUsd: 0.75 }],
]);
const TARGETS = new Map([
  ["openai/gpt-5.6-sol-pro", { route: "openai", prompt: 2, completion: 10, temperature: null, topP: null, seed: 1 }],
  ["anthropic/claude-opus-5", { route: "claude-on-aws", prompt: 5, completion: 25, temperature: null, topP: null, seed: null }],
  ["google/gemini-3.7-flash", { route: "google-vertex/global", prompt: 0.375, completion: 1.875, temperature: null, topP: null, seed: 1 }],
  ["deepseek/deepseek-v4-flash-0731", { route: "deepinfra/fp8", prompt: 0.08, completion: 0.18, temperature: 0, topP: 1, seed: 1 }],
  ["z-ai/glm-5.3", { route: "z-ai/fp8", prompt: 1.4, completion: 4.4, temperature: 0, topP: null, seed: null }],
  ["moonshotai/kimi-k3", { route: "moonshotai/mxfp4", prompt: 3, completion: 15, temperature: null, topP: null, seed: null }],
  ["qwen/qwen3.8-max", { route: "alibaba", prompt: 2, completion: 6, temperature: 0, topP: null, seed: 1 }],
  ["anthropic/claude-sonnet-5", { route: "anthropic", prompt: 2, completion: 10, temperature: null, topP: null, seed: null }],
]);
const BENCHMARKS = new Map([
  ["se-concurrency-atomic-stats-012", { promptTokens: 6858, maxTokens: 24576 }],
  ["arch-exactly-once-003", { promptTokens: 5541, maxTokens: 28672 }],
  ["sec-oidc-id-token-validation-001", { promptTokens: 4298, maxTokens: 24576 }],
  ["formal-spec-idempotent-api-003", { promptTokens: 4835, maxTokens: 24576 }],
]);
const BENCHMARK_ORDER = [...BENCHMARKS.keys()];
const OIDC_BENCHMARK = "sec-oidc-id-token-validation-001";
const HOSTED_TARGETS = ["openai/gpt-5.6-sol-pro", "anthropic/claude-opus-5", "google/gemini-3.7-flash", "deepseek/deepseek-v4-flash-0731"];
const CANDIDATE_TARGETS = ["z-ai/glm-5.3", "moonshotai/kimi-k3", "qwen/qwen3.8-max", "anthropic/claude-sonnet-5"];

function hostedCells() {
  const cells = [{ target: HOSTED_TARGETS[0], benchmark: OIDC_BENCHMARK, sentinel: true }];
  for (const target of HOSTED_TARGETS) {
    for (const benchmark of BENCHMARK_ORDER) {
      if (target === "anthropic/claude-opus-5" && benchmark === OIDC_BENCHMARK) continue;
      if (target === HOSTED_TARGETS[0] && benchmark === OIDC_BENCHMARK) continue;
      cells.push({ target, benchmark, sentinel: false });
    }
  }
  return cells;
}

function candidateCells() {
  const cells = [];
  for (const target of CANDIDATE_TARGETS) {
    cells.push({ target, benchmark: OIDC_BENCHMARK, sentinel: true });
    for (const benchmark of BENCHMARK_ORDER) {
      if (benchmark !== OIDC_BENCHMARK) cells.push({ target, benchmark, sentinel: false });
    }
  }
  return cells;
}

const PASS_CELLS = new Map([
  ["plinius-qualification-2026-08-22-diagnostic-hosted-paid-r1", hostedCells()],
  ["plinius-qualification-2026-08-26-diagnostic-candidate-paid-r1", candidateCells()],
]);

/** @param {Buffer | Uint8Array | string} body */
const sha256 = (body) => `sha256:${createHash("sha256").update(body).digest("hex")}`;
/** @param {unknown} value */
const json = (value) => JSON.stringify(value);
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const object = (value) => value != null && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @returns {value is number} */
const finiteNonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
/** @param {unknown} value */
const catalogPrice = (value) => (typeof value === "number" || (typeof value === "string" && value.length > 0)) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const NORMAL_TERMINATION = new Set(["stop", "stop_sequence", "end_turn", "eos", "eos_token", "complete", "completed", "finish_reason_stop"]);
const THINK_BLOCK = /<think>([\s\S]*?)<\/think>/gi;
const OPEN_THINK = /<think>([\s\S]*)$/i;
const ORPHAN_CLOSE_THINK = /^([\s\S]*?)<\/think>([\s\S]*)$/i;

/** Reproduce the driver's pass/fail response classification without importing it.
 * @param {unknown} response */
function responseQualified(response) {
  if (!object(response) || !Array.isArray(response.choices) || !object(response.choices[0])) return false;
  const choice = response.choices[0];
  if (!object(choice.message) || typeof choice.message.content !== "string" || typeof choice.finish_reason !== "string") return false;
  const finish = choice.finish_reason.trim().toLowerCase();
  if (!NORMAL_TERMINATION.has(finish)) return false;
  const content = choice.message.content;
  let finalAnswer = content;
  THINK_BLOCK.lastIndex = 0;
  if (THINK_BLOCK.test(content)) {
    THINK_BLOCK.lastIndex = 0;
    finalAnswer = content.replace(THINK_BLOCK, "");
  } else {
    const orphan = ORPHAN_CLOSE_THINK.exec(content);
    if (orphan) finalAnswer = orphan[2];
    else {
      const open = OPEN_THINK.exec(content);
      if (open) finalAnswer = content.slice(0, open.index);
    }
  }
  return finalAnswer.trim().length > 0;
}

/** @param {string} value */
function safeRelative(value) {
  return value.length > 0 && !value.includes("\\") && !value.startsWith("/") && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** @param {string[]} candidates */
function pinnedBinary(candidates) {
  for (const candidate of candidates) {
    try {
      const st = lstatSync(candidate);
      if (st.isFile() && !st.isSymbolicLink()) return candidate;
    } catch {
      // Continue.
    }
  }
  throw new Error("no pinned gpg binary available");
}

/** @param {string} root */
function walk(root) {
  /** @type {string[]} */ const files = [];
  /** @type {string[]} */ const directories = [];
  /** @param {string} dir */
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        directories.push(rel);
        visit(absolute);
      } else files.push(rel);
    }
  };
  visit(root);
  return { files: files.sort(), directories: directories.sort() };
}

/** @param {unknown} preimage */
function decodePreimage(preimage) {
  if (!object(preimage)) return { ok: false, jsonOk: false, reason: "preimage_not_object", bytes: null, value: null };
  const p = /** @type {Record<string, unknown>} */ (preimage);
  if (p.encoding !== "base64" || typeof p.base64 !== "string" || typeof p.sha256 !== "string" || !Number.isSafeInteger(p.bytes)) return { ok: false, jsonOk: false, reason: "preimage_shape", bytes: null, value: null };
  const bytes = Buffer.from(p.base64, "base64");
  if (bytes.toString("base64") !== p.base64) return { ok: false, jsonOk: false, reason: "preimage_base64_noncanonical", bytes: null, value: null };
  if (bytes.length !== p.bytes || sha256(bytes) !== p.sha256) return { ok: false, jsonOk: false, reason: "preimage_digest", bytes: null, value: null };
  try {
    return { ok: true, jsonOk: true, reason: null, bytes, value: JSON.parse(bytes.toString("utf-8")) };
  } catch {
    return { ok: true, jsonOk: false, reason: "preimage_not_json", bytes, value: null };
  }
}

/** @param {Buffer} body */
function decodeEnvelope(body) {
  const envelope = JSON.parse(body.toString("utf-8"));
  const keys = object(envelope) ? Object.keys(envelope).sort() : [];
  if (json(keys) !== json(["base64", "bytes", "encoding", "sha256", "sourceBasename"])) throw new Error("anchor envelope field set");
  if (envelope.encoding !== "base64" || typeof envelope.base64 !== "string" || typeof envelope.sha256 !== "string" || !Number.isSafeInteger(envelope.bytes)) throw new Error("anchor envelope shape");
  if (typeof envelope.sourceBasename !== "string" || basename(envelope.sourceBasename) !== envelope.sourceBasename) throw new Error("anchor envelope basename");
  const inner = Buffer.from(envelope.base64, "base64");
  if (inner.toString("base64") !== envelope.base64 || inner.length !== envelope.bytes || sha256(inner) !== envelope.sha256) throw new Error("anchor envelope digest");
  return { envelope, inner };
}

/** @param {Buffer} manifest @param {Buffer} signature */
function verifyDetachedSignature(manifest, signature) {
  const dir = mkdtempSync(join(tmpdir(), "plinius-paid-verify-"));
  try {
    const manifestPath = join(dir, "manifest.json");
    const signaturePath = join(dir, "manifest.json.sig");
    writeFileSync(manifestPath, manifest, { mode: 0o600 });
    writeFileSync(signaturePath, signature, { mode: 0o600 });
    chmodSync(dir, 0o700);
    const output = execFileSync(pinnedBinary(GPG_CANDIDATES), ["--batch", "--status-fd=1", "--verify", signaturePath, manifestPath], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const line = output.split("\n").find((item) => item.includes("[GNUPG:] VALIDSIG "));
    return line?.trim().split(/\s+/)[2]?.toUpperCase() ?? "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Verify Evidence without importing the driver or any project dependency.
 * @param {string} evidenceRoot
 * @param {{manifestFile?: string, verifySignature?: (manifest:Buffer, signature:Buffer)=>string, parentDigests?: string[]}} [options]
 */
export function verifyPaidEvidence(evidenceRoot, options = {}) {
  /** @type {string[]} */ const reasons = [];
  /** @param {string} reason @param {boolean} condition */
  const require = (reason, condition) => { if (!condition) reasons.push(reason); };
  /** @type {string} */ let root;
  try {
    root = realpathSync(evidenceRoot);
    const rootStat = lstatSync(root);
    const uid = typeof process.getuid === "function" ? process.getuid() : rootStat.uid;
    require("root_not_real_directory", rootStat.isDirectory() && !rootStat.isSymbolicLink());
    require("root_owner", rootStat.uid === uid);
    require("root_mode", (rootStat.mode & 0o777) === 0o700);
    const tree = walk(root);
    require("unexpected_directory", json(tree.directories) === json(tree.directories.filter((dir) => dir === "runs")));
    for (const directory of tree.directories) {
      const st = lstatSync(join(root, directory));
      require(`directory_metadata:${directory}`, st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o777) === 0o700);
    }
    const manifests = tree.files.filter((file) => /^paid-pass-manifest-[0-9a-f]{64}\.json$/.test(file));
    const manifestFile = options.manifestFile ?? (manifests.length === 1 ? manifests[0] : "");
    require("manifest_count", manifests.length === 1 && manifests[0] === manifestFile);
    require("manifest_path", safeRelative(manifestFile));
    if (!manifestFile) return { ok: false, reasons, manifestFile: null, summary: null };
    const manifestPath = join(root, manifestFile);
    const manifestStat = lstatSync(manifestPath);
    require("manifest_metadata", manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.nlink === 1 && manifestStat.uid === uid && (manifestStat.mode & 0o177) === 0);
    const manifestBytes = readFileSync(manifestPath);
    require("manifest_content_address", manifestFile.endsWith(`${sha256(manifestBytes).slice(7)}.json`));
    const manifest = JSON.parse(manifestBytes.toString("utf-8"));
    require("manifest_schema", manifest.manifestSchemaVersion === EVIDENCE_SCHEMA_VERSION);
    const identity = PASS_IDENTITIES.get(manifest.stageId);
    require("manifest_stage", identity != null);
    require("manifest_campaign", identity != null && manifest.campaignId === identity.campaignId);
    if (identity == null) return { ok: false, reasons, manifestFile, summary: null };

    /** @type {Array<[string, boolean | number]>} */
    const specs = [
      ["executionManifest", true], ["executionSignature", true], ["executionAttestation", true], ["catalogArtifact", true], ["summary", true],
      ["parentInputs", 3], ["rawObservations", -1], ["records", -1], ["wires", -1], ["intents", -1],
    ];
    /** @type {Map<string, Buffer>} */ const bodies = new Map();
    /** @type {Set<string>} */ const bound = new Set();
    /** @param {string} label @param {any} ref */
    const checkRef = (label, ref) => {
      if (!object(ref) || typeof ref.file !== "string" || !safeRelative(ref.file) || typeof ref.sha256 !== "string" || !Number.isSafeInteger(ref.bytes)) {
        reasons.push(`${label}_ref_shape`);
        return;
      }
      if (bound.has(ref.file)) reasons.push(`duplicate_ref:${ref.file}`);
      bound.add(ref.file);
      try {
        const path = join(root, ref.file);
        const st = lstatSync(path);
        require(`${label}_metadata:${ref.file}`, st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === uid && (st.mode & 0o177) === 0);
        const body = readFileSync(path);
        require(`${label}_digest:${ref.file}`, body.length === ref.bytes && sha256(body) === ref.sha256);
        if (basename(ref.file).startsWith("paid-")) {
          require(`${label}_content_addressed_name:${ref.file}`, basename(ref.file).endsWith(`${ref.sha256.slice("sha256:".length)}.json`));
        }
        bodies.set(ref.file, body);
      } catch {
        reasons.push(`${label}_missing:${ref.file}`);
      }
    };
    for (const [field, cardinality] of specs) {
      const value = manifest[field];
      if (Array.isArray(value)) {
        if (cardinality === -1) require(`${field}_empty`, value.length > 0);
        else require(`${field}_count`, value.length === cardinality);
        for (const ref of value) checkRef(field, ref);
      } else {
        require(`${field}_absent`, cardinality === true && object(value));
        if (object(value)) checkRef(field, value);
      }
    }
    require("disk_file_set", json(tree.files) === json([manifestFile, ...bound].sort()));

    const executionManifestBody = bodies.get(manifest.executionManifest?.file ?? "");
    const executionSignatureBody = bodies.get(manifest.executionSignature?.file ?? "");
    const executionAttestationBody = bodies.get(manifest.executionAttestation?.file ?? "");
    let executionManifest = null;
    let executionManifestInner = null;
    let executionSignatureInner = null;
    try {
      if (executionManifestBody == null || executionSignatureBody == null) throw new Error("execution anchor body missing");
      const execution = decodeEnvelope(executionManifestBody);
      const signature = decodeEnvelope(executionSignatureBody);
      executionManifestInner = execution.inner;
      executionSignatureInner = signature.inner;
      executionManifest = /** @type {any} */ (JSON.parse(execution.inner.toString("utf-8")));
      require("execution_manifest_schema", executionManifest.schemaVersion === EXECUTION_SCHEMA_VERSION && executionManifest.artifactType === EXECUTION_ARTIFACT_TYPE);
      require("execution_manifest_signer", executionManifest.requiredSignerFingerprint === PINNED_SIGNER);
      require("execution_manifest_source", /^[0-9a-f]{40}$/.test(executionManifest.source?.commit ?? "") && /^[0-9a-f]{40}$/.test(executionManifest.source?.tree ?? ""));
      require("execution_manifest_entrypoints", executionManifest.launcher === "qualification-paid-launch.mjs" && executionManifest.runner === "qualification-driver.mjs" && executionManifest.verifier === "qualification-paid-verify.mjs");
      require("execution_manifest_mode", Array.isArray(executionManifest.allowedModes) && json([...executionManifest.allowedModes].sort()) === json(["diagnostic-candidate-paid-r1", "diagnostic-hosted-paid-r1"]));
      require("execution_manifest_files", Array.isArray(executionManifest.files) && executionManifest.files.some((/** @type {any} */ file) => file.path === "qualification-paid-launch.mjs" && file.role === "launcher") && executionManifest.files.some((/** @type {any} */ file) => file.path === "qualification-driver.mjs" && file.role === "runner") && executionManifest.files.some((/** @type {any} */ file) => file.path === "qualification-paid-verify.mjs" && file.role === "verifier"));
      const executionPaths = new Set();
      for (const file of executionManifest.files ?? []) {
        require("execution_manifest_file_shape", typeof file.path === "string" && safeRelative(file.path) && /^sha256:[0-9a-f]{64}$/.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && ["launcher", "runner", "verifier", "benchmark"].includes(file.role));
        require(`execution_manifest_duplicate:${String(file.path)}`, !executionPaths.has(file.path));
        executionPaths.add(file.path);
      }
      const fingerprint = (options.verifySignature ?? verifyDetachedSignature)(execution.inner, signature.inner).toUpperCase();
      require("execution_signature", fingerprint === PINNED_SIGNER);
    } catch (error) {
      reasons.push(`execution_envelope:${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (executionAttestationBody == null) throw new Error("execution attestation body missing");
      const attestation = JSON.parse(executionAttestationBody.toString("utf-8"));
      require("execution_attestation_identity", attestation.campaignId === manifest.campaignId && attestation.stageId === manifest.stageId);
      require("execution_attestation_signature", attestation.signatureVerified === true && attestation.signerFingerprint === PINNED_SIGNER && attestation.pinnedSigner === PINNED_SIGNER);
      require("execution_attestation_manifest_digest", executionManifestInner != null && attestation.manifestSha256 === sha256(executionManifestInner));
      require("execution_attestation_signature_digest", executionSignatureInner != null && attestation.signatureSha256 === sha256(executionSignatureInner));
      require("execution_attestation_artifact", attestation.artifactType === EXECUTION_ARTIFACT_TYPE && attestation.artifactSchemaVersion === EXECUTION_SCHEMA_VERSION);
      require("execution_attestation_runner", executionManifest != null && executionManifest.files.some((/** @type {any} */ file) => file.role === "runner" && file.sha256 === attestation.runnerSha256));
      require("execution_attestation_launcher", executionManifest != null && executionManifest.files.some((/** @type {any} */ file) => file.role === "launcher" && file.sha256 === attestation.launcherSha256));
    } catch (error) {
      reasons.push(`execution_attestation_parse:${error instanceof Error ? error.message : String(error)}`);
    }
    const expectedParentDigests = options.parentDigests ?? HISTORICAL_PARENT_DIGESTS;
    require("parent_digest_policy", expectedParentDigests.length === 3);
    for (let index = 0; index < 3; index++) {
      try {
        const parentRef = manifest.parentInputs[index];
        if (parentRef == null) throw new Error("parent ref missing");
        const body = bodies.get(parentRef.file);
        if (body == null) throw new Error("parent body missing");
        const decoded = decodeEnvelope(body);
        require(`parent_digest:${index}`, decoded.envelope.sha256 === expectedParentDigests[index]);
      } catch (error) {
        reasons.push(`parent_envelope:${index}:${error instanceof Error ? error.message : String(error)}`);
      }
    }

    /** @type {Record<string, string>} */ let providerDisplay = {};
    try {
      const catalogBody = bodies.get(manifest.catalogArtifact.file);
      if (catalogBody == null) throw new Error("catalog body missing");
      const catalog = JSON.parse(catalogBody.toString("utf-8"));
      require("catalog_identity", catalog.campaignId === manifest.campaignId && catalog.stageId === manifest.stageId && catalog.ok === true && Array.isArray(catalog.reasons) && catalog.reasons.length === 0);
      require("catalog_budget", catalog.budget?.totalCapUsd === identity.totalCapUsd && catalog.budget?.perRunCapUsd === identity.perRunCapUsd);
      const passCells = PASS_CELLS.get(manifest.stageId) ?? [];
      const targetSlugs = [...new Set(passCells.map((cell) => cell.target))];
      const evidence = Array.isArray(catalog.catalogEvidence) ? catalog.catalogEvidence : [];
      const expectedEndpoints = new Set([
        "https://openrouter.ai/api/v1/models",
        ...targetSlugs.map((slug) => `https://openrouter.ai/api/v1/models/${slug}/endpoints`),
      ]);
      require("catalog_evidence_count", evidence.length === expectedEndpoints.size);
      const rawByEndpoint = new Map();
      for (const entry of evidence) {
        const raw = Buffer.from(entry.rawBodyBase64 ?? "", "base64");
        require("catalog_base64", raw.toString("base64") === entry.rawBodyBase64);
        require("catalog_raw_digest", raw.length === entry.byteLength && sha256(raw) === entry.rawBodySha256);
        require("catalog_http", entry.httpStatus === 200 && entry.transportError == null);
        require(`catalog_endpoint:${String(entry.endpoint)}`, expectedEndpoints.has(entry.endpoint) && !rawByEndpoint.has(entry.endpoint));
        rawByEndpoint.set(entry.endpoint, JSON.parse(raw.toString("utf-8")));
      }
      require("catalog_endpoint_set", json([...rawByEndpoint.keys()].sort()) === json([...expectedEndpoints].sort()));

      const models = rawByEndpoint.get("https://openrouter.ai/api/v1/models")?.data;
      require("catalog_models_shape", Array.isArray(models));
      providerDisplay = {};
      for (const slug of targetSlugs) {
        const target = TARGETS.get(slug);
        const matchingModels = Array.isArray(models) ? models.filter((model) => object(model) && model.id === slug) : [];
        require(`catalog_model_exact:${slug}`, matchingModels.length === 1 && (matchingModels[0].canonical_slug == null || matchingModels[0].canonical_slug === slug));
        const endpointPayload = rawByEndpoint.get(`https://openrouter.ai/api/v1/models/${slug}/endpoints`);
        const endpoints = endpointPayload?.data?.endpoints;
        require(`catalog_endpoints_shape:${slug}`, Array.isArray(endpoints));
        if (target == null || !Array.isArray(endpoints)) continue;
        const matches = endpoints.filter((endpoint) => object(endpoint) && endpoint.tag === target.route);
        require(`catalog_route_exact:${slug}`, matches.length === 1);
        if (matches.length !== 1) continue;
        const endpoint = matches[0];
        const promptPrice = catalogPrice(endpoint.pricing?.prompt);
        const completionPrice = catalogPrice(endpoint.pricing?.completion);
        require(`catalog_price:${slug}`, promptPrice != null && promptPrice <= target.prompt / 1_000_000 && completionPrice != null && completionPrice <= target.completion / 1_000_000 && !(promptPrice === 0 && completionPrice === 0));
        const display = typeof endpoint.provider_name === "string" ? endpoint.provider_name : typeof endpoint.name === "string" ? endpoint.name : "";
        require(`catalog_provider_display:${slug}`, display.length > 0);
        if (display.length > 0) providerDisplay[slug] = display;
        const maxPrompt = Math.max(...passCells.filter((cell) => cell.target === slug).map((cell) => BENCHMARKS.get(cell.benchmark)?.promptTokens ?? Number.POSITIVE_INFINITY));
        const maxTokens = Math.max(...passCells.filter((cell) => cell.target === slug).map((cell) => BENCHMARKS.get(cell.benchmark)?.maxTokens ?? Number.POSITIVE_INFINITY));
        require(`catalog_context:${slug}`, Number.isFinite(endpoint.context_length) && endpoint.context_length >= maxPrompt + maxTokens);
        require(`catalog_completion:${slug}`, endpoint.max_completion_tokens == null || (Number.isFinite(endpoint.max_completion_tokens) && endpoint.max_completion_tokens >= maxTokens));
        const supported = new Set(Array.isArray(endpoint.supported_parameters) ? endpoint.supported_parameters : []);
        const requiredParams = ["max_tokens"];
        if (target.temperature !== null) requiredParams.push("temperature");
        if (target.topP !== null) requiredParams.push("top_p");
        if (target.seed !== null) requiredParams.push("seed");
        require(`catalog_parameters:${slug}`, requiredParams.every((parameter) => supported.has(parameter)));
      }
      require("catalog_provider_display_set", json(Object.keys(catalog.providerDisplay ?? {}).sort()) === json(targetSlugs.slice().sort()) && targetSlugs.every((slug) => catalog.providerDisplay?.[slug] === providerDisplay[slug]));
      const verification = Array.isArray(catalog.verification) ? catalog.verification : [];
      require("catalog_verification_set", verification.length === targetSlugs.length && targetSlugs.every((slug) => verification.some((/** @type {any} */ entry) => entry?.slug === slug && entry.ok === true && Array.isArray(entry.reasons) && entry.reasons.length === 0 && entry.providerDisplay === providerDisplay[slug])));
      const totalCeiling = passCells.reduce((sum, cell) => {
        const target = TARGETS.get(cell.target);
        const benchmark = BENCHMARKS.get(cell.benchmark);
        return target && benchmark ? sum + (benchmark.promptTokens * target.prompt + benchmark.maxTokens * target.completion) / 1_000_000 : Number.POSITIVE_INFINITY;
      }, 0);
      require("catalog_budget_ceiling", Number.isFinite(totalCeiling) && totalCeiling <= identity.totalCapUsd && passCells.every((cell) => {
        const target = TARGETS.get(cell.target);
        const benchmark = BENCHMARKS.get(cell.benchmark);
        return target != null && benchmark != null && (benchmark.promptTokens * target.prompt + benchmark.maxTokens * target.completion) / 1_000_000 <= identity.perRunCapUsd;
      }));
      if (catalog.totalCeilingUsd !== undefined) {
        require("catalog_total_ceiling", finiteNonnegative(catalog.totalCeilingUsd) && Math.abs(catalog.totalCeilingUsd - totalCeiling) < 1e-12);
      }
    } catch (error) {
      reasons.push(`catalog_parse:${error instanceof Error ? error.message : String(error)}`);
    }

    /** @param {any[]} refs */
    const refsByRun = (refs) => new Map(refs.map((/** @type {any} */ ref) => [ref.runId, ref]));
    const records = refsByRun(manifest.records);
    const raws = refsByRun(manifest.rawObservations);
    require("record_run_ids", records.size === manifest.records.length && !records.has(undefined));
    require("raw_run_ids", raws.size === manifest.rawObservations.length && !raws.has(undefined));
    require("record_raw_run_set", json([...records.keys()].sort()) === json([...raws.keys()].sort()));
    /** @type {Map<string, any[]>} */ const wireByRun = new Map();
    for (const ref of manifest.wires) {
      try {
        const wireBody = bodies.get(ref.file);
        if (wireBody == null) throw new Error("wire body missing");
        const fragment = JSON.parse(wireBody.toString("utf-8"));
        require("wire_ref_run_id", fragment.runId === ref.runId);
        const list = wireByRun.get(fragment.runId) ?? [];
        list.push(fragment);
        wireByRun.set(fragment.runId, list);
      } catch (error) {
        reasons.push(`wire_parse:${ref.file}:${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let billedTotal = 0;
    /** @type {string[]} */ const settledCostRunIds = [];
    /** @type {string[]} */ const unknownCostRunIds = [];
    /** @type {string[]} */ const invalidCostRunIds = [];
    let passed = 0;
    let failed = 0;
    const expectedCells = PASS_CELLS.get(manifest.stageId) ?? [];
    const observedCells = new Set();
    for (const [runId, recordRef] of records) {
      try {
        const recordBody = bodies.get(recordRef.file);
        if (recordBody == null) throw new Error("record body missing");
        const record = JSON.parse(recordBody.toString("utf-8"));
        const rawRef = raws.get(runId);
        if (rawRef == null) throw new Error("raw ref missing");
        const rawBody = bodies.get(rawRef.file);
        if (rawBody == null) throw new Error("raw body missing");
        const raw = JSON.parse(rawBody.toString("utf-8"));
        require(`record_identity:${runId}`, record.runId === runId && recordRef.runId === runId && raw.runId === runId && record.campaignId === manifest.campaignId);
        const expectedCell = Number.isSafeInteger(record.orderIndex) ? expectedCells[record.orderIndex - 1] : undefined;
        const cellKey = `${String(record.requestedSlug)}\u0000${String(record.benchmarkId)}`;
        require(`record_cell:${runId}`, expectedCell != null && expectedCell.target === record.requestedSlug && expectedCell.benchmark === record.benchmarkId && expectedCell.sentinel === record.sentinel && !observedCells.has(cellKey));
        observedCells.add(cellKey);
        require(`record_raw_ref:${runId}`, json(record.rawObservationRef) === json({ file: rawRef.file, sha256: rawRef.sha256, bytes: rawRef.bytes }));
        const fragments = wireByRun.get(runId) ?? [];
        const requests = fragments.filter((fragment) => fragment.stage === "request");
        const responses = fragments.filter((fragment) => fragment.stage === "response");
        const pollFragments = fragments.filter((fragment) => fragment.stage === "cost_poll").sort((a, b) => a.pollIndex - b.pollIndex);
        require(`wire_request_count:${runId}`, requests.length === 1);
        require(`wire_response_count:${runId}`, responses.length <= 1);
        if (requests.length === 1) require(`raw_request_fragment:${runId}`, raw.requestUrl === requests[0].url && raw.requestMethod === requests[0].method && json(raw.requestBody) === json(requests[0].preimage));
        if (responses.length === 1) require(`raw_response_fragment:${runId}`, raw.responseHttpStatus === responses[0].httpStatus && json(raw.responseBody) === json(responses[0].preimage));
        else require(`raw_response_absent:${runId}`, raw.responseHttpStatus == null && raw.responseBody == null);
        const rawPolls = raw.costLookup?.polls ?? [];
        require(`raw_cost_fragments:${runId}`, json(rawPolls) === json(pollFragments.map((fragment) => fragment.poll)));

        const requestDecoded = decodePreimage(raw.requestBody);
        require(`request_preimage:${runId}:${requestDecoded.reason}`, requestDecoded.ok && requestDecoded.jsonOk);
        const request = /** @type {any} */ (requestDecoded.value ?? {});
        const target = TARGETS.get(record.requestedSlug);
        require(`target_known:${runId}`, target != null);
        if (target != null) {
          const expectedKeys = ["max_tokens", "messages", "model", "provider", "stream"];
          if (target.temperature !== null) expectedKeys.push("temperature");
          if (target.topP !== null) expectedKeys.push("top_p");
          if (target.seed !== null) expectedKeys.push("seed");
          require(`request_keys:${runId}`, json(Object.keys(request).sort()) === json(expectedKeys.sort()));
          require(`request_model:${runId}`, request.model === record.requestedSlug && requests[0]?.url === "https://openrouter.ai/api/v1/chat/completions" && requests[0]?.method === "POST" && request.stream === false);
          require(`request_sampling:${runId}`, (request.temperature ?? null) === target.temperature && (request.top_p ?? null) === target.topP && (request.seed ?? null) === target.seed && request.max_tokens === record.sampling?.maxTokens);
          require(`request_messages:${runId}`, json(request.messages) === json([{ role: "system", content: record.promptSnapshot?.systemPrompt }, { role: "user", content: record.promptSnapshot?.userPrompt }]));
          require(`request_routing:${runId}`, json(request.provider) === json({ order: [target.route], allow_fallbacks: false, require_parameters: true, max_price: { prompt: target.prompt, completion: target.completion } }));
        }

        let billed = null;
        let response = null;
        if (raw.responseBody != null) {
          const responseDecoded = decodePreimage(raw.responseBody);
          require(`response_preimage:${runId}:${responseDecoded.reason}`, responseDecoded.ok && responseDecoded.jsonOk);
          response = responseDecoded.value;
        }
        let finalData = null;
        for (let index = 0; index < rawPolls.length; index++) {
          const poll = rawPolls[index];
          require(`cost_poll_index:${runId}:${index}`, poll.pollIndex === index && poll.method === "GET");
          if (poll.kind === "http_response") {
            const decoded = decodePreimage(poll.body);
            require(`cost_preimage:${runId}:${index}:${decoded.reason}`, decoded.ok);
            const data = decoded.jsonOk && object(decoded.value) ? decoded.value.data : null;
            require(`cost_flags:${runId}:${index}`, poll.jsonParsed === decoded.jsonOk && poll.dataPresent === object(data) && (decoded.jsonOk || typeof poll.jsonError === "string"));
            if (index < rawPolls.length - 1) require(`cost_nonterminal:${runId}:${index}`, !(poll.httpStatus === 200 && object(data)));
            else if (poll.httpStatus === 200 && object(data)) finalData = data;
          } else require(`cost_transport_shape:${runId}:${index}`, poll.kind === "transport_error" && typeof poll.error === "string");
        }
        require(`cost_final_ok:${runId}`, raw.costLookup == null || raw.costLookup.finalOk === (finalData != null));
        if (finalData != null) {
          billed = finalData.total_cost;
          require(`cost_value:${runId}`, finiteNonnegative(billed));
          require(`cost_identity:${runId}`, response != null && finalData.id === response.id && finalData.model === response.model && finalData.provider_name === response.provider);
          require(`cost_url:${runId}`, rawPolls.every((/** @type {any} */ poll) => poll.url === `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(response?.id ?? "")}`));
        }
        require(`record_billed_cost:${runId}`, Object.is(record.billedCostUsd, billed));
        if (finiteNonnegative(billed)) {
          billedTotal += billed;
          settledCostRunIds.push(runId);
        } else if (billed == null) unknownCostRunIds.push(runId);
        else invalidCostRunIds.push(runId);
        const verdictPass = record.paidVerdict?.ok === true;
        const responsePass = responseQualified(response);
        require(`record_response_qualification:${runId}`, record.paidVerdict?.responseQualified === responsePass);
        require(`record_verdict_status:${runId}`, verdictPass ? record.status?.qualification === "pass" : record.status?.qualification === "fail");
        if (verdictPass) {
          require(`passing_response:${runId}`, raw.responseHttpStatus === 200 && response?.model === record.requestedSlug && typeof response?.id === "string" && response.id.length > 0);
          require(`passing_provider:${runId}`, response?.provider === providerDisplay[record.requestedSlug] && finalData?.provider_name === providerDisplay[record.requestedSlug]);
          require(`passing_cost:${runId}`, finiteNonnegative(billed) && billed <= identity.perRunCapUsd);
          require(`passing_completion:${runId}`, responsePass);
          passed++;
        } else failed++;
      } catch (error) {
        reasons.push(`run_verify:${String(runId)}:${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const intents = manifest.intents.map((/** @type {any} */ ref) => {
        const body = bodies.get(ref.file);
        if (body == null) throw new Error("intent body missing");
        return JSON.parse(body.toString("utf-8"));
      });
      require("intent_count", intents.length === records.size);
      require("intent_run_set", json(intents.map((/** @type {any} */ intent) => intent.runId).sort()) === json([...records.keys()].sort()));
      require("intent_states", intents.every((/** @type {any} */ intent) => intent.state === "dispatch_started" && intent.campaignId === manifest.campaignId));
      const summaryBody = bodies.get(manifest.summary.file);
      if (summaryBody == null) throw new Error("summary body missing");
      const summary = JSON.parse(summaryBody.toString("utf-8"));
      require("summary_identity", summary.campaignId === manifest.campaignId && summary.stageId === manifest.stageId && summary.mode === identity.mode);
      require("summary_budget", summary.budget?.totalCapUsd === identity.totalCapUsd && summary.budget?.perRunCapUsd === identity.perRunCapUsd);
      require("summary_counts", summary.totalCells === identity.totalCells && summary.dispatched === records.size && summary.passed === passed && summary.failed === failed && summary.dispatched === summary.passed + summary.failed);
      require("summary_cost", finiteNonnegative(summary.spentUsd) && Math.abs(summary.spentUsd - billedTotal) < 1e-12 && summary.spentUsd <= identity.totalCapUsd);
      const coverage = summary.costCoverage;
      const coverageKeys = object(coverage) ? Object.keys(coverage).sort() : [];
      require("summary_cost_coverage_shape", json(coverageKeys) === json(["complete", "invalidCostRunIds", "settledRunIds", "settledTotalUsd", "unknownCostRunIds"].sort()));
      require("summary_settled_cost_runs", Array.isArray(coverage?.settledRunIds) && json([...coverage.settledRunIds].sort()) === json([...settledCostRunIds].sort()));
      require("summary_unknown_cost_runs", Array.isArray(coverage?.unknownCostRunIds) && json([...coverage.unknownCostRunIds].sort()) === json([...unknownCostRunIds].sort()));
      require("summary_invalid_cost_runs", Array.isArray(coverage?.invalidCostRunIds) && json([...coverage.invalidCostRunIds].sort()) === json([...invalidCostRunIds].sort()));
      require("summary_settled_total", finiteNonnegative(coverage?.settledTotalUsd) && Math.abs(coverage.settledTotalUsd - billedTotal) < 1e-12);
      require("summary_cost_coverage_complete", coverage?.complete === (unknownCostRunIds.length === 0 && invalidCostRunIds.length === 0));
      return { ok: reasons.length === 0, reasons, manifestFile, summary };
    } catch (error) {
      reasons.push(`summary_parse:${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, reasons, manifestFile, summary: null };
    }
  } catch (error) {
    reasons.push(`fatal:${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, reasons, manifestFile: null, summary: null };
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  let root = "";
  let manifestFile;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--root") root = argv[++index] ?? "";
    else if (argv[index] === "--manifest") manifestFile = argv[++index];
    else throw new Error(`unknown verifier argument: ${argv[index]}`);
  }
  if (!root) throw new Error("--root is required");
  return { root, manifestFile };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = verifyPaidEvidence(args.root, { manifestFile: args.manifestFile });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
}

function invokedDirectly() {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    main();
  } catch (error) {
    console.error("PAID EVIDENCE VERIFY ERROR:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
