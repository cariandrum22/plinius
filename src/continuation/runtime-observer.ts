/**
 * Production local-runtime OBSERVER — pure logic over injected effects (Stage C1 r5).
 *
 * WHY THIS MODULE EXISTS (recorded before it was added, per the Allowed-Source-
 * Changes rule and r5 authority-bindings.json): C1-R4-F01 requires the value that
 * replaces continuationMain()'s `observe: async () => null` to (1) inspect the OCI
 * runtime via a SHELL-FREE argv array with a timeout and bounded output, (2) confirm
 * the container is unique / running / expected-image / command / mount / target,
 * (3) walk ONLY the OCI-confirmed snapshot / model-cache root, (4) stream-recompute
 * each file's size and SHA-256, (5) resolve symlinks within the realpath'd root to
 * regular files, (6) reject missing / extra / duplicate / path-escape / size /
 * digest mismatch, (7) match the snapshot basename + container `--revision` + parent
 * expected revision, and (8) check ${baseUrl}/models HTTP 200 with the exact served
 * model present — capturing capturedAtUtc only AFTER all of that, and failing closed
 * (returning no observation) the moment the OCI tool, container or mount cannot be
 * observed.
 *
 * These are live-runtime effects, distinct from the pure parent-artifact derivation
 * in local-runtime.ts and the filesystem journaling in journal.ts. This module holds
 * only the ORDERED LOGIC; every effect — the shell-free command runner, the
 * filesystem view (realpath / lstat / readdir / streaming file hash) and the
 * /v1/models fetch — is INJECTED, so the offline tests drive the REAL observer with a
 * mock command runner, mock filesystem and mock fetch (never by injecting a finished
 * RuntimeObservation). It imports no node:child_process, no node:fs, no node:crypto
 * and opens no network connection: the driver wires the node-backed effects.
 */
import type {
  WeightFileEntry,
  RuntimeObservation,
  ServingConfigInput,
  ParsedA100Preflight,
  ParsedCheckpointArtifact,
} from "./local-runtime.js";
import { parseEngineArgs, canonicalEngine, decodeHfSnapshot } from "./local-runtime.js";
// Re-exported so the offline tests keep importing these argv helpers from the observer.
export { parseEngineArgs, decodeHfSnapshot } from "./local-runtime.js";

/** The full expected local runtime, derived from the parent A100 preflight + checkpoint artifacts. */
export interface ExpectedLocalRuntime {
  requestedSlug: string;
  containerName: string;
  endpoint: string;
  servedModelId: string;
  vllmImage: string;
  vllmVersion: string;
  engineArgs: string;
  dtype: string;
  quantization: string;
  tensorParallelSize: number;
  /** 40-hex checkpoint revision the snapshot is pinned to. */
  checkpointRevision: string;
  /** Host path of the pinned snapshot (its basename must equal checkpointRevision). */
  snapshotPath: string;
  /** The complete expected file list of the snapshot (file / sizeBytes / sha256). */
  weightFiles: WeightFileEntry[];
}

/**
 * Derive the full expected local runtime for each vLLM target from the parent A100
 * preflight (container / endpoint / served model / image / engine args) and the
 * checkpoint artifacts (snapshot path / 40-hex revision / expected file list). The
 * caller has already verified each parent artifact's fixed file SHA-256 before parse
 * (F01); this only projects the verified fields.
 */
export function deriveExpectedLocalRuntimes(args: {
  a100Preflight: ParsedA100Preflight;
  checkpoints: ParsedCheckpointArtifact[];
}): ExpectedLocalRuntime[] {
  const ckptByTarget = new Map(args.checkpoints.map((c) => [c.target, c]));
  const out: ExpectedLocalRuntime[] = [];
  for (const s of args.a100Preflight.servers) {
    const ckpt = ckptByTarget.get(s.target);
    if (!ckpt) throw new Error(`no checkpoint artifact for local target ${s.target}`);
    out.push({
      requestedSlug: s.target,
      containerName: s.container,
      endpoint: s.endpoint,
      servedModelId: s.load.servedModelId,
      vllmImage: s.serving.vllmImage,
      vllmVersion: s.serving.vllmVersion,
      engineArgs: s.serving.engineArgs,
      dtype: s.serving.dtype,
      quantization: s.serving.quantization,
      tensorParallelSize: s.serving.tensorParallelSize,
      checkpointRevision: ckpt.expectedOfficialCheckpointSha,
      snapshotPath: ckpt.snapshotPath,
      weightFiles: ckpt.weightFiles,
    });
  }
  return out;
}

/** The result of one shell-free command invocation. */
export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the binary could not be executed at all (ENOENT / spawn failure). */
  error?: string;
}

/** A shell-free command runner: argv array, timeout, bounded output. Never a shell string. */
export type CommandRunner = (argv: string[], opts: { timeoutMs: number; maxBytes: number }) => CommandResult;

export interface ObserverStat {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** The filesystem view the observer needs — injected so tests use a mock filesystem. */
export interface ObserverFs {
  realpath(p: string): string;
  lstat(p: string): ObserverStat;
  readdir(p: string): string[];
  /** Streaming size + SHA-256 of a regular file — bare lowercase hex (no prefix). */
  hashFile(p: string): Promise<{ sizeBytes: number; sha256: string }>;
}

/** A minimal fetch for the /v1/models health check — a mock in tests. */
export type ModelsFetch = (url: string) => Promise<{ status: number; text(): Promise<string> }>;

export interface ObserverDeps {
  runCommand: CommandRunner;
  fs: ObserverFs;
  fetchModels: ModelsFetch;
  now: () => string;
  ociBinary?: string;
  commandTimeoutMs?: number;
  commandMaxBytes?: number;
}

/** One OCI mount as reported by `inspect`. */
interface OciMount {
  Type?: string;
  Source?: string;
  Destination?: string;
}
interface OciInspect {
  State?: { Running?: boolean };
  Image?: string;
  Config?: { Image?: string; Cmd?: string[]; Entrypoint?: string[]; Env?: string[] };
  Args?: string[];
  Mounts?: OciMount[];
}

/** Read one env var (KEY=value) from a container's Config.Env list, or null. */
function envValue(env: string[] | undefined, key: string): string | null {
  if (!Array.isArray(env)) return null;
  const prefix = `${key}=`;
  for (const e of env) if (typeof e === "string" && e.startsWith(prefix)) return e.slice(prefix.length);
  return null;
}

/**
 * The container-internal Hugging Face HUB cache directory, from the container env
 * (C1-R6-F01): HF_HUB_CACHE wins; else HF_HOME + "/hub"; else TRANSFORMERS_CACHE;
 * else the documented default `/root/.cache/huggingface/hub`. Trailing slashes are
 * trimmed so the derived snapshot path compares exactly.
 */
function containerHubCache(env: string[] | undefined): string {
  const strip = (p: string) => p.replace(/\/+$/, "");
  const hubCache = envValue(env, "HF_HUB_CACHE");
  if (hubCache) return strip(hubCache);
  const hfHome = envValue(env, "HF_HOME");
  if (hfHome) return strip(hfHome) + "/hub";
  const tc = envValue(env, "TRANSFORMERS_CACHE");
  if (tc) return strip(tc);
  return "/root/.cache/huggingface/hub";
}

/** `image inspect` output — the pinned image's id, repo digests and labels (C1-R5-F01). */
interface OciImageInspect {
  Id?: string;
  RepoDigests?: string[];
  Config?: { Labels?: Record<string, string> };
}

/** Label keys, in priority order, a vLLM image may carry its version under. */
const IMAGE_VERSION_LABELS = ["org.opencontainers.image.version", "vllm.version", "version"];

function pathBasename(p: string): string {
  const parts = p.split("/").filter((x) => x.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

/** Is `child` equal to or strictly inside `root` (both already realpath'd)? */
function isInside(root: string, child: string): boolean {
  return child === root || child.startsWith(root.endsWith("/") ? root : root + "/");
}

/**
 * Normalize + validate an expected/observed weight-file relative path (C1-R5-F05):
 * an absolute path, a `.`/`..` component, a backslash, an empty segment, a NUL or a
 * leading/trailing separator is rejected before it can be hashed or matched.
 */
export function normalizeWeightRel(rel: string): { ok: true; rel: string } | { ok: false; reason: string } {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) return { ok: false, reason: "weight_path_invalid" };
  if (rel.startsWith("/")) return { ok: false, reason: "weight_path_absolute" };
  if (rel.includes("\\")) return { ok: false, reason: "weight_path_backslash" };
  const segs = rel.split("/");
  for (const s of segs) {
    if (s.length === 0) return { ok: false, reason: "weight_path_empty_segment" };
    if (s === "." || s === "..") return { ok: false, reason: "weight_path_dot_segment" };
  }
  return { ok: true, rel: segs.join("/") };
}

export interface ObservationResult {
  observation: RuntimeObservation | null;
  reasons: string[];
}

/**
 * Observe ONE local target against its parent-derived expectation, in the fixed
 * order OCI inspect → snapshot hash → /v1/models. Returns a fully-measured
 * {@link RuntimeObservation} only when every check passes; otherwise the observation
 * is null (fail closed) and `reasons` explains why. capturedAtUtc is sampled ONLY
 * after the OCI inspection, the file hashing and the health check have all completed.
 */
export async function observeLocalRuntime(expected: ExpectedLocalRuntime, deps: ObserverDeps): Promise<ObservationResult> {
  const reasons: string[] = [];
  const oci = deps.ociBinary ?? "docker";
  const timeoutMs = deps.commandTimeoutMs ?? 15_000;
  const maxBytes = deps.commandMaxBytes ?? 4_000_000;
  const fail = (r: string): ObservationResult => {
    reasons.push(r);
    return { observation: null, reasons };
  };

  // (1) OCI inspection — shell-free argv, timeout, bounded output.
  const inspect = deps.runCommand(
    [oci, "inspect", "--type", "container", "--format", "{{json .}}", expected.containerName],
    { timeoutMs, maxBytes },
  );
  if (inspect.error) return fail(`oci_tool_unavailable:${inspect.error}`);
  if (inspect.timedOut) return fail("oci_inspect_timeout");
  if (inspect.status !== 0) return fail(`oci_inspect_status:${inspect.status ?? "null"}`);
  const lines = inspect.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return fail("oci_container_not_found");
  if (lines.length > 1) return fail("oci_container_not_unique");
  let info: OciInspect;
  try {
    info = JSON.parse(lines[0]) as OciInspect;
  } catch {
    return fail("oci_inspect_unparseable");
  }
  if (info.State?.Running !== true) return fail("oci_container_not_running");
  if (info.Config?.Image !== expected.vllmImage) return fail("oci_image_mismatch");

  // (1a) Effective argv → engine command. The live command is PARSED from the actual
  // container argv (never assumed) and compared STRUCTURALLY against the expected
  // engineArgs the parent pinned: served model, revision, tensor parallelism, dtype,
  // quantization, model and every other flag must match token-for-token. A wrong
  // `--tensor-parallel-size 99`, `--dtype float16` or extra `--quantization awq`
  // therefore makes the observation null here (C1-R5-F01) — the r5 code transcribed
  // these from the expected values and so never noticed.
  const rawTokens = [...(info.Config?.Entrypoint ?? []), ...(info.Config?.Cmd ?? []), ...(info.Args ?? [])];
  const serveIdx = rawTokens.indexOf("serve");
  if (serveIdx < 0) return fail("oci_command_no_serve_subcommand");
  const liveTokens = rawTokens.slice(serveIdx);
  const liveParsed = parseEngineArgs(liveTokens);
  if (!liveParsed.ok) return fail(`oci_command_${liveParsed.reason}`);
  const expParsed = parseEngineArgs(expected.engineArgs.trim().split(/\s+/));
  if (!expParsed.ok) return fail(`expected_${expParsed.reason}`);
  const liveFlags = liveParsed.parsed.flags;

  // (1b) Revision / served-model / model must match the parent AND the HF repo the
  // snapshot path encodes — the argv must load the exact pinned checkpoint. These
  // specific-field checks give granular reasons before the catch-all structural check.
  if (liveFlags["--revision"] !== expected.checkpointRevision) return fail("oci_command_revision_mismatch");
  if (liveFlags["--served-model-name"] !== expected.servedModelId) return fail("oci_command_served_model_mismatch");
  const hf = decodeHfSnapshot(expected.snapshotPath);
  if (hf == null) return fail("snapshot_path_not_hf_layout");
  if (liveFlags["--model"] !== hf.repo) return fail("oci_command_model_path_mismatch");

  // (1c) FULL structural equality — every remaining flag (tensor parallelism, dtype,
  // quantization and any other engine arg) must match token-for-token. A wrong
  // `--tensor-parallel-size 99`, `--dtype float16` or extra `--quantization awq`
  // makes the observation null here (C1-R5-F01) — the r5 code transcribed these from
  // the expected values and so never noticed.
  if (canonicalEngine(liveParsed.parsed) !== canonicalEngine(expParsed.parsed)) return fail("oci_command_engine_args_mismatch");

  // (1d) Image identity + version — observed from the live OCI image, NEVER the parent
  // string (C1-R5-F01). The pinned digest ref must be one the image actually carries,
  // and the version must come from an observable label; an unobservable version fails
  // closed (return to authority — do not guess).
  // Config.Image was already confirmed to equal the parent-pinned digest ref above;
  // inspect that exact image to observe its repo digests + version label.
  const imageRef = expected.vllmImage;
  const imgInspect = deps.runCommand([oci, "image", "inspect", "--format", "{{json .}}", imageRef], { timeoutMs, maxBytes });
  if (imgInspect.error) return fail(`oci_image_tool_unavailable:${imgInspect.error}`);
  if (imgInspect.timedOut) return fail("oci_image_inspect_timeout");
  if (imgInspect.status !== 0) return fail(`oci_image_inspect_status:${imgInspect.status ?? "null"}`);
  const imgLines = imgInspect.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (imgLines.length !== 1) return fail("oci_image_inspect_not_unique");
  let imgInfo: OciImageInspect;
  try {
    imgInfo = JSON.parse(imgLines[0]) as OciImageInspect;
  } catch {
    return fail("oci_image_inspect_unparseable");
  }
  const repoDigests = Array.isArray(imgInfo.RepoDigests) ? imgInfo.RepoDigests : [];
  if (!repoDigests.includes(expected.vllmImage)) return fail("oci_image_digest_mismatch");
  // The image digest is the value the LIVE inspect reported (the matching RepoDigest);
  // the parent-pinned ref is used only as the comparison target (C1-R6-F01).
  const observedImageDigest = repoDigests.find((d) => d === expected.vllmImage) as string;
  const labels = imgInfo.Config?.Labels ?? {};
  let observedVersion: string | null = null;
  for (const key of IMAGE_VERSION_LABELS) {
    const v = labels[key];
    if (typeof v === "string" && v.length > 0) {
      observedVersion = v;
      break;
    }
  }
  if (observedVersion == null) return fail("oci_image_version_unobservable");
  if (observedVersion !== expected.vllmVersion) return fail("oci_image_version_mismatch");

  // (1e) Mount binding: EXACTLY ONE mount whose realpath'd Source contains the snapshot
  // (a second covering mount is ambiguous and rejected). From that mount's Source →
  // Destination mapping the container-internal checkpoint path is derived mechanically,
  // so an unused mount that merely happens to contain the snapshot no longer passes
  // (C1-R5-F01).
  let realSnapshot: string;
  try {
    realSnapshot = deps.fs.realpath(expected.snapshotPath);
  } catch {
    return fail("snapshot_path_unresolved");
  }
  let modelCacheRoot: string | null = null;
  let containerCheckpointPath: string | null = null;
  for (const m of info.Mounts ?? []) {
    if (typeof m.Source !== "string") continue;
    let realSource: string;
    try {
      realSource = deps.fs.realpath(m.Source);
    } catch {
      continue;
    }
    if (!isInside(realSource, realSnapshot)) continue;
    if (modelCacheRoot != null) return fail("oci_mount_ambiguous");
    modelCacheRoot = realSource;
    const rel = realSnapshot === realSource ? "" : realSnapshot.slice(realSource.length).replace(/^\/+/, "");
    const dest = typeof m.Destination === "string" ? m.Destination.replace(/\/+$/, "") : null;
    if (dest == null) return fail("oci_mount_no_destination");
    containerCheckpointPath = rel.length > 0 ? `${dest}/${rel}` : dest;
  }
  if (modelCacheRoot == null || containerCheckpointPath == null) return fail("oci_mount_not_covering_snapshot");

  // Snapshot basename must equal the pinned revision (and the command revision).
  if (pathBasename(realSnapshot) !== expected.checkpointRevision) return fail("snapshot_basename_revision_mismatch");

  // (1e) HF-repo → snapshot RESOLUTION PROOF (C1-R6-F01). `--model` is a HF repository
  // id (not a container path); prove it resolves to THIS snapshot mechanically from the
  // container env (HF_HUB_CACHE / HF_HOME / TRANSFORMERS_CACHE / default), the HF cache
  // layout and the mount destination — the container-internal path the repo id resolves
  // to must be EXACTLY the mount-derived snapshot path. An unused mount, an ambiguous
  // default cache or a different snapshot no longer passes.
  const modelsDirName = "models--" + hf.repo.split("/").join("--");
  const hubCache = containerHubCache(info.Config?.Env);
  const resolvedContainerPath = `${hubCache}/${modelsDirName}/snapshots/${expected.checkpointRevision}`;
  if (resolvedContainerPath !== containerCheckpointPath) return fail("oci_model_path_not_resolved");

  // (2) Snapshot hashing — walk ONLY the confirmed snapshot root under the cache root.
  const snapStat = deps.fs.lstat(realSnapshot);
  if (snapStat.isSymbolicLink() || !snapStat.isDirectory()) return fail("snapshot_not_directory");
  // Reject a DUPLICATE expected path before any hashing, and normalize every expected
  // relative path (no absolute / `.` / `..` / separator ambiguity) — a silent Map
  // overwrite of a duplicate expectation is gone (C1-R5-F05).
  const expectedByFile = new Map<string, WeightFileEntry>();
  for (const w of expected.weightFiles) {
    const n = normalizeWeightRel(w.file);
    if (!n.ok) return fail(`expected_${n.reason}:${w.file}`);
    if (expectedByFile.has(n.rel)) return fail(`expected_duplicate_file:${n.rel}`);
    expectedByFile.set(n.rel, w);
  }
  const seen = new Set<string>();
  const measured: WeightFileEntry[] = [];

  // Recursive walk collecting every regular file (relative path from the snapshot).
  const walk = async (dirAbs: string, relPrefix: string): Promise<string | null> => {
    let entries: string[];
    try {
      entries = deps.fs.readdir(dirAbs);
    } catch {
      return `snapshot_readdir_failed:${relPrefix || "."}`;
    }
    for (const name of entries) {
      const abs = `${dirAbs}/${name}`;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const lst = deps.fs.lstat(abs);
      let target = abs;
      let st = lst;
      const wasSymlink = lst.isSymbolicLink();
      if (wasSymlink) {
        // A symlink must resolve to a REGULAR FILE inside the model-cache root — a
        // symlink to a directory is NOT recursively walked (C1-R5-F05).
        let real: string;
        try {
          real = deps.fs.realpath(abs);
        } catch {
          return `snapshot_symlink_unresolved:${rel}`;
        }
        if (!isInside(modelCacheRoot as string, real)) return `snapshot_symlink_escape:${rel}`;
        target = real;
        st = deps.fs.lstat(real);
        if (!st.isFile()) return `snapshot_symlink_not_regular_file:${rel}`;
      } else if (st.isDirectory()) {
        const e = await walk(target, rel);
        if (e) return e;
        continue;
      }
      if (!st.isFile()) return `snapshot_non_regular_file:${rel}`;
      const nr = normalizeWeightRel(rel);
      if (!nr.ok) return `snapshot_${nr.reason}:${rel}`;
      if (seen.has(rel)) return `snapshot_duplicate_file:${rel}`;
      seen.add(rel);
      const exp = expectedByFile.get(rel);
      if (!exp) return `snapshot_extra_file:${rel}`;
      const h = await deps.fs.hashFile(target);
      if (h.sizeBytes !== exp.sizeBytes) return `snapshot_size_mismatch:${rel}`;
      if (h.sha256 !== exp.sha256) return `snapshot_digest_mismatch:${rel}`;
      measured.push({ file: rel, sizeBytes: h.sizeBytes, sha256: h.sha256 });
    }
    return null;
  };
  const walkError = await walk(realSnapshot, "");
  if (walkError) return fail(walkError);
  for (const rel of expectedByFile.keys()) if (!seen.has(rel)) return fail(`snapshot_missing_file:${rel}`);

  // (3) /v1/models — HTTP 200 and the EXACT served model present.
  let health: { status: number; text(): Promise<string> };
  try {
    health = await deps.fetchModels(`${expected.endpoint.replace(/\/$/, "")}/models`);
  } catch (e) {
    return fail(`models_fetch_error:${(e as Error).message}`);
  }
  if (health.status !== 200) return fail(`models_http_${health.status}`);
  let modelIds: string[];
  try {
    const body = JSON.parse(await health.text()) as { data?: Array<{ id?: unknown }> };
    modelIds = Array.isArray(body.data) ? body.data.map((m) => m.id).filter((x): x is string => typeof x === "string") : [];
  } catch {
    return fail("models_body_unparseable");
  }
  if (!modelIds.includes(expected.servedModelId)) return fail("models_served_model_absent");

  // capturedAtUtc AFTER OCI inspection + file hashing + /v1/models (F01).
  const capturedAtUtc = deps.now();
  // The serving config is built ENTIRELY from OBSERVED values (C1-R6-F01): served model /
  // tensor parallelism / dtype / quantization from the LIVE argv this run parsed and gated;
  // engineArgs is the CANONICAL representation of the live effective argv; the image digest
  // is the digest the live image inspect reported; the version is the observed image label.
  // A flag ABSENT from the live argv (e.g. gpt-oss has no --dtype / --quantization) is
  // recorded as null — the expected descriptor is NEVER substituted.
  const observedTp = Number(liveFlags["--tensor-parallel-size"]);
  if (!Number.isInteger(observedTp)) return fail("oci_command_tp_not_integer");
  const observedDtype = liveFlags["--dtype"] ?? null;
  const observedQuant = liveFlags["--quantization"] ?? null;
  const canonicalLiveEngine = canonicalEngine(liveParsed.parsed);
  const servingObserved: ServingConfigInput = {
    target: expected.requestedSlug,
    endpoint: expected.endpoint,
    servedModelId: liveFlags["--served-model-name"],
    tensorParallelSize: observedTp,
    dtype: observedDtype,
    quantization: observedQuant,
    vllmImage: observedImageDigest,
    vllmVersion: observedVersion,
    engineArgs: canonicalLiveEngine,
  };
  const observation: RuntimeObservation = {
    requestedSlug: expected.requestedSlug,
    endpoint: expected.endpoint,
    healthy: true,
    servedModelId: liveFlags["--served-model-name"],
    checkpointRevision: liveFlags["--revision"],
    weightFiles: measured,
    servingObserved,
    precision: observedDtype,
    capturedAtUtc,
    observedContainerImage: observedImageDigest,
    observedEngineArgs: liveTokens.join(" "),
    observedCheckpointPath: containerCheckpointPath,
  };
  return { observation, reasons };
}

/**
 * Build a production `observe(target)` compatible with makeLocalBindingProbe. It
 * looks up the target's parent-derived expectation and runs {@link observeLocalRuntime};
 * an unobservable target (no expectation, or any failed check) yields null so the
 * local gate fails closed before any dispatch (F01).
 */
export function makeProductionObserver(
  expected: ExpectedLocalRuntime[],
  deps: ObserverDeps,
): (target: { slug: string; baseUrl: string }) => Promise<RuntimeObservation | null> {
  const bySlug = new Map(expected.map((e) => [e.requestedSlug, e]));
  return async (target) => {
    const exp = bySlug.get(target.slug);
    if (!exp) return null;
    const { observation } = await observeLocalRuntime(exp, deps);
    return observation;
  };
}
