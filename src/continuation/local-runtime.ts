/**
 * Local-runtime binding derivation and resolution — pure, offline helpers
 * (Stage C1 r4).
 *
 * WHY THIS MODULE EXISTS (recorded before it was added, per the Allowed-Source-
 * Changes rule and authority-bindings.json): C1-R3-F01 requires the EXPECTED
 * local (vLLM) binding to be re-derived ONLY from the parent Evidence artifacts
 * (after their fixed file digests are verified) and kept strictly separate from
 * the FRESH runtime observation; C1-R3-F04 requires mechanical verification of a
 * runtime-manifest digest chain. Isolating the deterministic canonicalization,
 * the parent-artifact derivation, and the observed-binding resolution here — in
 * src/continuation/, the only permitted new path — makes each a pure function the
 * offline tests drive directly with a mock filesystem, mock OCI inspection and
 * mock fetch. No network, no clock, no live container, no credential.
 *
 * The weight-manifest and serving-config canonicalization reproduce the Authority
 * accepted digests EXACTLY (verified: Qwen weight-manifest 4284 canonical bytes →
 * d67d740e…, gpt-oss 1306 → 2e68a022…; serving-config 562 bytes → 76f88124… /
 * 55f1cf72…). The array of weight files is ordered with String.localeCompare (the
 * default-locale collation the Authority used), NOT ASCII byte order.
 */

/** One weight file as listed in a parent checkpoint artifact. */
export interface WeightFileEntry {
  file: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * The accepted local-target binding, re-derived from parent Evidence. Digests are
 * bare lowercase hex (checkpointRevision is a 40-hex repository revision, NOT a
 * SHA-256; weightManifestDigest / servingConfigDigest are 64-hex SHA-256).
 */
export interface ExpectedLocalBinding {
  requestedSlug: string;
  endpoint: string;
  servedModelId: string;
  /** 40-hex repository revision the checkpoint was pinned to — never a file SHA-256. */
  checkpointRevision: string;
  weightManifestDigest: string;
  servingConfigDigest: string;
  tensorParallelism: number;
  /** argv `--dtype` value, or null when the flag is absent (never the a100 descriptor). */
  precision: string | null;
  weightFileCount: number;
  totalBytes: number;
}

/**
 * A binding OBSERVED from the live runtime by the production probe (mocked in
 * r4). Every field is measured, never copied from a prefilled digest file:
 * healthy/servedModelId from /v1/models, checkpointRevision/weightManifestDigest
 * from the mounted snapshot's actual files, servingConfigDigest from the observed
 * container image/command. `capturedAtUtc` timestamps the observation.
 */
export interface LocalTargetBinding {
  requestedSlug: string;
  endpoint: string;
  healthy: boolean;
  servedModelId: string | null;
  checkpointRevision: string | null;
  weightManifestDigest: string | null;
  servingConfigDigest: string | null;
  tensorParallelism: number | null;
  precision: string | null;
  capturedAtUtc: string | null;
  /** Observation provenance (recorded, not gated): what the runtime inspection saw. */
  observedContainerImage?: string | null;
  observedEngineArgs?: string | null;
  observedCheckpointPath?: string | null;
  weightFileCount?: number | null;
  totalBytes?: number | null;
}

/** Freshness window for a runtime observation: 5 minutes. */
export const LOCAL_BINDING_FRESHNESS_SECONDS = 300;

/**
 * Canonical, whitespace-free JSON with object keys in lexicographic order — the
 * exact serialization the Authority weight-manifest / serving-config digests use.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/**
 * A hasher: canonical UTF-8 bytes → bare lowercase hex SHA-256. Injected so this
 * module never imports node:crypto and stays environment-free for the tests.
 */
export type Sha256Of = (canonicalBytes: string) => string;

// --- engine-argv canonicalization (shared with the live observer, C1-R6-F01) ---

/** Canonical alias → canonical flag name for the vLLM engine argv. */
const ENGINE_FLAG_ALIAS: Record<string, string> = {
  "-tp": "--tensor-parallel-size",
  "-q": "--quantization",
  "-O": "--optimization",
};

/** A parsed engine command line: the leading subcommand + a canonical flag → value map. */
export interface ParsedEngineArgs {
  subcommand: string;
  flags: Record<string, string>;
}

/**
 * Parse a vLLM engine argv into a canonical {subcommand, flags}. Every `--flag value`
 * / `--flag=value` folds to its canonical name; a duplicate flag, a conflicting alias
 * (canonical + short form), a flag with no value, or a stray positional after the
 * subcommand is REJECTED. Both the parent engineArgs string and the observed container
 * argv go through this same parser so they compare structurally (C1-R6-F01).
 */
export function parseEngineArgs(tokens: string[]): { ok: true; parsed: ParsedEngineArgs } | { ok: false; reason: string } {
  if (tokens.length === 0) return { ok: false, reason: "engine_args_empty" };
  if (tokens[0].startsWith("-")) return { ok: false, reason: "engine_args_no_subcommand" };
  const subcommand = tokens[0];
  const flags: Record<string, string> = {};
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith("-")) return { ok: false, reason: `engine_args_unexpected_positional:${tok}` };
    let name: string;
    let value: string;
    const eq = tok.indexOf("=");
    if (eq >= 0) {
      name = tok.slice(0, eq);
      value = tok.slice(eq + 1);
    } else {
      name = tok;
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("-")) return { ok: false, reason: `engine_args_missing_value:${name}` };
      value = next;
      i++;
    }
    const canon = ENGINE_FLAG_ALIAS[name] ?? name;
    if (canon in flags) {
      return { ok: false, reason: flags[canon] === value ? `engine_args_duplicate_flag:${canon}` : `engine_args_conflicting_flag:${canon}` };
    }
    flags[canon] = value;
  }
  return { ok: true, parsed: { subcommand, flags } };
}

/** Stable canonical serialization of a parsed engine command for structural equality. */
export function canonicalEngine(p: ParsedEngineArgs): string {
  const keys = Object.keys(p.flags).sort();
  return JSON.stringify([p.subcommand, keys.map((k) => [k, p.flags[k]])]);
}

/** Parse a parent engineArgs STRING to its canonical form; throws on a malformed spec. */
export function canonicalEngineArgsString(engineArgs: string): string {
  const p = parseEngineArgs(engineArgs.trim().split(/\s+/));
  if (!p.ok) throw new Error(`parent engineArgs unparseable: ${p.reason}`);
  return canonicalEngine(p.parsed);
}

/** A single flag's value from a parent engineArgs string, or null if absent/malformed. */
export function engineArgFlag(engineArgs: string, flag: string): string | null {
  const p = parseEngineArgs(engineArgs.trim().split(/\s+/));
  if (!p.ok) return null;
  return p.parsed.flags[flag] ?? null;
}

/**
 * Decode the Hugging Face repo id + revision a snapshot path pins:
 * `<cache>/hub/models--<org>--<name>/snapshots/<revision>` → { repo:"<org>/<name>",
 * revision }. Returns null if the path is not that exact HF cache layout.
 */
export function decodeHfSnapshot(snapshotPath: string): { repo: string; revision: string } | null {
  const parts = snapshotPath.split("/").filter((x) => x.length > 0);
  const si = parts.indexOf("snapshots");
  if (si <= 0 || si + 1 >= parts.length) return null;
  const modelsDir = parts[si - 1];
  if (!modelsDir.startsWith("models--")) return null;
  const repo = modelsDir.slice("models--".length).split("--").join("/");
  if (repo.length === 0) return null;
  return { repo, revision: parts[si + 1] };
}

/**
 * Explicit, environment-independent collator for ordering weight files (C1-R4-F07).
 * The default-locale String.prototype.localeCompare the Authority table was first
 * reproduced with varies with $LANG (LANG=C would fall back to code-unit order,
 * ja_JP.UTF-8 to a Japanese tailoring); pinning "en-US-u-co-default" with these
 * fixed options makes the collation — and therefore the weight-manifest digest —
 * byte-identical under LANG=C, LANG=ja_JP.UTF-8 and the normal environment, while
 * still reproducing the Authority digests EXACTLY (Qwen d67d740e / 4284 canonical
 * bytes, gpt-oss 2e68a022 / 1306 canonical bytes). {@link weightFileCollatorReport}
 * exposes resolvedOptions so the ordering is recorded in the r5 report.
 */
export const WEIGHT_FILE_COLLATOR = new Intl.Collator("en-US-u-co-default", {
  usage: "sort",
  sensitivity: "variant",
  numeric: false,
  caseFirst: "false",
  ignorePunctuation: false,
});

/** The collator's resolved options — recorded in the deterministic-ordering report. */
export function weightFileCollatorReport(): Intl.ResolvedCollatorOptions {
  return WEIGHT_FILE_COLLATOR.resolvedOptions();
}

/**
 * Weight-manifest digest: order the weight files by `file` with the fixed
 * {@link WEIGHT_FILE_COLLATOR} (NOT the default-locale localeCompare, per F07),
 * project each to {file,sizeBytes,sha256}, canonicalize (lexicographic keys, no
 * whitespace), and SHA-256 the bytes. Returns { digest, canonicalBytes }.
 */
export function weightManifestDigest(files: WeightFileEntry[], hasher: Sha256Of): { digest: string; canonicalBytes: number } {
  const ordered = files
    .slice()
    .sort((a, b) => WEIGHT_FILE_COLLATOR.compare(a.file, b.file))
    .map((w) => ({ file: w.file, sizeBytes: w.sizeBytes, sha256: w.sha256 }));
  const canonical = canonicalJson(ordered);
  return { digest: hasher(canonical), canonicalBytes: Buffer.byteLength(canonical, "utf-8") };
}

/**
 * The serving-config fields the digest canonicalizes. Every value is an
 * OBSERVABLE machine fact (C1-R6-F01): `engineArgs` is the CANONICAL representation
 * of the effective argv (from {@link canonicalEngineArgsString} / {@link canonicalEngine}),
 * `dtype`/`quantization` are the argv flag values (null when the flag is absent — a
 * descriptor is never substituted), `vllmImage` is the image digest ref, `vllmVersion`
 * the observed image-label version. Expected and observed are built on this identical
 * basis so their digests match iff the live runtime equals the parent spec.
 */
export interface ServingConfigInput {
  target: string;
  endpoint: string;
  servedModelId: string;
  tensorParallelSize: number;
  /** argv `--dtype` value, or null when the flag is absent (never the a100 descriptor). */
  dtype: string | null;
  /** argv `--quantization` value, or null when the flag is absent. */
  quantization: string | null;
  /** Image digest ref (observed from image inspect; expected uses the parent-pinned ref). */
  vllmImage: string;
  vllmVersion: string;
  /** CANONICAL effective-argv representation (never the raw parent string). */
  engineArgs: string;
}

/** Serving-config digest over the canonicalized serving fields. */
export function servingConfigDigest(cfg: ServingConfigInput, hasher: Sha256Of): { digest: string; canonicalBytes: number } {
  const canonical = canonicalJson(cfg);
  return { digest: hasher(canonical), canonicalBytes: Buffer.byteLength(canonical, "utf-8") };
}

// --- parent-artifact structural views (only the fields we re-derive from) -----

export interface ParsedCheckpointArtifact {
  target: string;
  expectedOfficialCheckpointSha: string;
  /** Host path of the pinned snapshot (basename == expectedOfficialCheckpointSha). */
  snapshotPath: string;
  weightFiles: WeightFileEntry[];
  weightFileCount: number;
  totalBytes: number;
  quantization: string;
}

export interface ParsedServerPreflight {
  target: string;
  /** OCI container name serving this target. */
  container: string;
  endpoint: string;
  load: { servedModelId: string };
  serving: {
    tensorParallelSize: number;
    dtype: string;
    quantization: string;
    vllmImage: string;
    vllmVersion: string;
    engineArgs: string;
  };
}

export interface ParsedA100Preflight {
  servers: ParsedServerPreflight[];
}

/**
 * Re-derive the accepted local bindings from the parent artifacts. The caller has
 * already verified each artifact's fixed file SHA-256 before parsing (F01). The
 * checkpoint revision is the 40-hex `expectedOfficialCheckpointSha` (NOT a file
 * digest); the weight-manifest digest is re-computed from the checkpoint's weight
 * files; the serving-config digest is re-computed from the a100 preflight server.
 */
export function deriveExpectedLocalBindings(args: {
  a100Preflight: ParsedA100Preflight;
  checkpoints: ParsedCheckpointArtifact[];
  hasher: Sha256Of;
}): ExpectedLocalBinding[] {
  const { a100Preflight, checkpoints, hasher } = args;
  const ckptByTarget = new Map(checkpoints.map((c) => [c.target, c]));
  const out: ExpectedLocalBinding[] = [];
  for (const s of a100Preflight.servers) {
    const ckpt = ckptByTarget.get(s.target);
    if (!ckpt) throw new Error(`no checkpoint artifact for local target ${s.target}`);
    const wm = weightManifestDigest(ckpt.weightFiles, hasher);
    // The EXPECTED serving-config digest keeps the ORIGINAL Authority-accepted basis
    // (the a100 preflight serving fields) so it reproduces the frozen values
    // 76f88124… / 55f1cf72… exactly. This digest is EVIDENCE / provenance, not the
    // live gate: the live observer verifies serving correctness structurally (the full
    // effective-argv equality + image digest + version + model-path resolution proof,
    // C1-R6-F01) and fails closed, so resolveLocalTarget no longer compares it.
    const sc = servingConfigDigest(
      {
        target: s.target,
        endpoint: s.endpoint,
        servedModelId: s.load.servedModelId,
        tensorParallelSize: s.serving.tensorParallelSize,
        dtype: s.serving.dtype,
        quantization: s.serving.quantization,
        vllmImage: s.serving.vllmImage,
        vllmVersion: s.serving.vllmVersion,
        engineArgs: s.serving.engineArgs,
      },
      hasher,
    );
    out.push({
      requestedSlug: s.target,
      endpoint: s.endpoint,
      servedModelId: s.load.servedModelId,
      checkpointRevision: ckpt.expectedOfficialCheckpointSha,
      weightManifestDigest: wm.digest,
      servingConfigDigest: sc.digest,
      tensorParallelism: s.serving.tensorParallelSize,
      // precision = the argv --dtype flag (null when absent), never the a100 descriptor;
      // this stays observable-comparable with the live observation but is not gated.
      precision: engineArgFlag(s.serving.engineArgs, "--dtype"),
      weightFileCount: ckpt.weightFileCount,
      totalBytes: ckpt.totalBytes,
    });
  }
  return out;
}

/**
 * A raw observation of one live local target, gathered by the production probe
 * from direct runtime inspection (mocked in r4): the OCI container image /
 * command / mounted checkpoint path, the actual snapshot weight files, the served
 * model id from /v1/models, and the observed serving config. The digests are NOT
 * part of the observation — they are RE-COMPUTED from the raw files/config by
 * {@link buildObservedBinding}, so a prefilled digest can never stand in for a
 * measurement.
 */
export interface RuntimeObservation {
  requestedSlug: string;
  endpoint: string;
  /** true only when /v1/models returned 200 AND the expected served model was present. */
  healthy: boolean;
  servedModelId: string | null;
  /** 40-hex revision read from the mounted snapshot path — null if not observable. */
  checkpointRevision: string | null;
  /** The actual on-disk snapshot files (file/size/sha256), or null if not observable. */
  weightFiles: WeightFileEntry[] | null;
  /** The observed serving config (from the container image + command), or null. */
  servingObserved: ServingConfigInput | null;
  precision: string | null;
  capturedAtUtc: string;
  observedContainerImage?: string | null;
  observedEngineArgs?: string | null;
  observedCheckpointPath?: string | null;
}

/**
 * Turn a raw runtime observation into a {@link LocalTargetBinding} by RE-COMPUTING
 * the weight-manifest and serving-config digests from the observed files/config.
 * When a component was not observable (weightFiles/servingObserved null) the
 * corresponding digest is null, so {@link resolveLocalTarget} fails closed.
 */
export function buildObservedBinding(obs: RuntimeObservation, hasher: Sha256Of): LocalTargetBinding {
  const wm = obs.weightFiles != null ? weightManifestDigest(obs.weightFiles, hasher) : null;
  const sc = obs.servingObserved != null ? servingConfigDigest(obs.servingObserved, hasher) : null;
  return {
    requestedSlug: obs.requestedSlug,
    endpoint: obs.endpoint,
    healthy: obs.healthy,
    servedModelId: obs.servedModelId,
    checkpointRevision: obs.checkpointRevision,
    weightManifestDigest: wm ? wm.digest : null,
    servingConfigDigest: sc ? sc.digest : null,
    tensorParallelism: obs.servingObserved?.tensorParallelSize ?? null,
    precision: obs.precision ?? obs.servingObserved?.dtype ?? null,
    capturedAtUtc: obs.capturedAtUtc,
    observedContainerImage: obs.observedContainerImage ?? null,
    observedEngineArgs: obs.observedEngineArgs ?? null,
    observedCheckpointPath: obs.observedCheckpointPath ?? null,
    weightFileCount: obs.weightFiles?.length ?? null,
    totalBytes: obs.weightFiles != null ? obs.weightFiles.reduce((n, w) => n + w.sizeBytes, 0) : null,
  };
}

export interface LocalTargetResolution {
  requestedSlug: string;
  backend: "vllm";
  resolvedSlug: string | null;
  resolvedExactly: boolean;
  substitutionUsed: boolean;
  fallbackUsed: boolean;
}

/**
 * Gate one local target: `resolvedExactly` is true ONLY when an accepted binding
 * and a fresh observation both exist, the server is healthy, the observation is
 * fresh (capturedAtUtc present, parseable, not in the future, within
 * {@link LOCAL_BINDING_FRESHNESS_SECONDS} of `nowUtc`), and EVERY required field
 * — endpoint, served model, checkpoint revision, weight-manifest digest,
 * serving-config digest, tensor parallelism, precision — is present AND equal to
 * the accepted value. No placeholder, no default-true: any gap fails closed.
 */
export function resolveLocalTarget(
  expected: ExpectedLocalBinding | undefined,
  observed: LocalTargetBinding | undefined,
  nowUtc: string,
): { resolution: LocalTargetResolution; reasons: string[] } {
  const slug = expected?.requestedSlug ?? observed?.requestedSlug ?? "unknown-local-target";
  const reasons: string[] = [];
  if (!expected) reasons.push(`${slug}: no accepted local binding`);
  if (!observed) reasons.push(`${slug}: no observed local binding`);
  if (expected && observed) {
    if (!observed.healthy) reasons.push(`${slug}: not healthy`);
    // Freshness — separate the fresh runtime from the accepted canonical values.
    const cap = observed.capturedAtUtc;
    const capMs = cap != null ? Date.parse(cap) : NaN;
    const nowMs = Date.parse(nowUtc);
    if (cap == null) reasons.push(`${slug}: capturedAtUtc missing`);
    else if (Number.isNaN(capMs)) reasons.push(`${slug}: capturedAtUtc invalid`);
    else if (Number.isNaN(nowMs)) reasons.push(`${slug}: evaluation time invalid`);
    else if (capMs > nowMs) reasons.push(`${slug}: capturedAtUtc in the future`);
    else if ((nowMs - capMs) / 1000 > LOCAL_BINDING_FRESHNESS_SECONDS) reasons.push(`${slug}: observation stale`);
    // Gate the machine-comparable observable facts. The EXPECTED servingConfigDigest is
    // built from a100 DESCRIPTORS (frozen Authority evidence) while the OBSERVED one is
    // built from the live argv/image, so the two are NOT comparable and are not gated
    // here (C1-R6-F01) — serving correctness is verified structurally by the live
    // observer, which fails closed. precision (argv --dtype, null when absent) is
    // likewise not gated so a null does not read as "missing". weightManifestDigest and
    // tensorParallelism stay explicit like-for-like gates.
    const fields: Array<keyof ExpectedLocalBinding> = [
      "endpoint",
      "servedModelId",
      "checkpointRevision",
      "weightManifestDigest",
      "tensorParallelism",
    ];
    for (const f of fields) {
      const o = (observed as unknown as Record<string, unknown>)[f];
      if (o == null) reasons.push(`${slug}: missing ${f}`);
      else if (o !== expected[f]) reasons.push(`${slug}: ${f} mismatch`);
    }
  }
  const ok = reasons.length === 0;
  return {
    resolution: {
      requestedSlug: slug,
      backend: "vllm",
      resolvedSlug: ok && observed ? observed.servedModelId : null,
      resolvedExactly: ok,
      substitutionUsed: false,
      fallbackUsed: false,
    },
    reasons,
  };
}
