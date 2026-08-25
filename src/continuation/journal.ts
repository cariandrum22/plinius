/**
 * Diagnostic-continuation dispatch journal — interruption-safe persistence
 * (Stage C1). Prepares an exclusive-create intent before each cell dispatch,
 * durably transitions it to dispatch_started immediately before the (Stage C2)
 * generation call, and finalizes the run record with an atomic
 * write-temp → fsync → rename → fsync-dir sequence so a crash never leaves a
 * half-written record. All writes are fsync'd; if the platform cannot fsync a
 * file or a directory this module reports the constraint and refuses to proceed
 * rather than silently weakening the durability guarantee.
 *
 * WHY THIS MODULE EXISTS (recorded before it was added, per the directive):
 * interruption safety and atomic journaling are filesystem concerns distinct
 * from the record schema and the campaign driver; isolating them in
 * src/continuation/ (the only permitted new path) lets the offline tests drive
 * them against real temp-directory fixtures.
 *
 * This module opens no network connection and reads no credential.
 */
import { openSync, closeSync, fsyncSync, fstatSync, writeFileSync, readFileSync, writeSync, linkSync, renameSync, existsSync, mkdirSync, readdirSync, unlinkSync, lstatSync, realpathSync } from "fs";
import { join, resolve, dirname, sep } from "path";
import { createHash } from "crypto";

export type IntentState = "prepared_not_dispatched" | "dispatch_started";

export interface DispatchIntent {
  campaignId: string;
  orderIndex: number;
  runId: string;
  target: string;
  benchmark: string;
  attemptIndex: number;
  createdAt: string;
  state: IntentState;
}

/** Raised when the platform cannot honour the durability contract. */
export class FsyncUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsyncUnavailableError";
  }
}

function fsyncFile(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r+");
    fsyncSync(fd);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOSYS" || code === "EINVAL" || code === "ENOTSUP") {
      throw new FsyncUnavailableError(`file fsync unavailable (${code}) for ${path}`);
    }
    throw e;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOSYS" || code === "EINVAL" || code === "ENOTSUP") {
      throw new FsyncUnavailableError(`directory fsync unavailable (${code}) for ${dir}`);
    }
    throw e;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Verify the platform can fsync both a regular file and a directory in `dir`,
 * throwing FsyncUnavailableError otherwise. Call once before journaling so the
 * run refuses to start (rather than silently skipping fsync) on a filesystem
 * that cannot provide the durability the interruption-safety design assumes.
 * The probe is UNLINKED (then the directory is fsync'd) so it leaves ZERO
 * residue — it is never merely renamed aside, and no residue is ever excluded
 * from an emptiness or freshness guard.
 */
export function assertFsyncCapability(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const probe = join(dir, ".fsync-probe");
  writeFileSync(probe, "probe", { mode: 0o600, flag: "w" });
  fsyncFile(probe);
  fsyncDir(dir);
  unlinkSync(probe);
  fsyncDir(dir);
  const residue = readdirSync(dir).filter((e) => e.startsWith(".fsync-probe"));
  if (residue.length > 0) throw new Error(`fsync probe residue not cleaned: ${residue.join(", ")}`);
}

export function intentPath(runsDir: string, runId: string): string {
  return join(runsDir, `${runId}.intent.json`);
}

export function recordPath(runsDir: string, runId: string): string {
  return join(runsDir, `${runId}.json`);
}

export function readIntent(runsDir: string, runId: string): DispatchIntent | null {
  const p = intentPath(runsDir, runId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as DispatchIntent;
}

export function readRecord(runsDir: string, runId: string): Record<string, unknown> | null {
  const p = recordPath(runsDir, runId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

/**
 * Persist a fresh dispatch intent with an EXCLUSIVE create ("wx"): if an intent
 * for this run id already exists the write throws (EEXIST) and the caller must
 * not re-dispatch. The file is fsync'd, then the directory.
 */
export function prepareIntent(runsDir: string, intent: Omit<DispatchIntent, "state">): void {
  const p = intentPath(runsDir, intent.runId);
  const body: DispatchIntent = { ...intent, state: "prepared_not_dispatched" };
  writeFileSync(p, JSON.stringify(body, null, 2), { mode: 0o600, flag: "wx" });
  fsyncFile(p);
  fsyncDir(runsDir);
}

/**
 * Durably transition an existing intent to dispatch_started immediately before
 * the generation call. Written to a temp file, fsync'd, atomically renamed over
 * the intent, then the directory is fsync'd.
 */
export function markDispatchStarted(runsDir: string, runId: string): void {
  const p = intentPath(runsDir, runId);
  const current = JSON.parse(readFileSync(p, "utf-8")) as DispatchIntent;
  const next: DispatchIntent = { ...current, state: "dispatch_started" };
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: "w" });
  fsyncFile(tmp);
  renameSync(tmp, p);
  fsyncDir(runsDir);
}

function fullHex(body: string): string {
  return createHash("sha256").update(Buffer.from(body, "utf-8")).digest("hex");
}
function sha256Of(body: string): string {
  return "sha256:" + fullHex(body);
}

/** The lock file name held for the whole duration of one invocation. */
export const LOCK_FILENAME = ".continuation.lock";

/**
 * An exclusive per-invocation lock. Held (fd kept open) from before the output
 * root is read until the last runtime manifest and directory fsync complete, so
 * no second invocation and no non-lock-holding writer can interleave (F05).
 */
export interface InvocationLock {
  path: string;
  fd: number;
  invocationId: string;
  outputRoot: string;
  /** realpath'd output root captured at acquire — finalize targets are confined to it (F05). */
  realOutputRoot: string;
  /** device / inode of the lock file at acquire — a replacement (unlink+recreate) changes these. */
  dev: number;
  ino: number;
  released: boolean;
}

/**
 * The output root that holds a lock must be a real directory this user owns, with
 * mode exactly 0700 and no symlinked identity (F05). Returns its realpath.
 */
/**
 * Whether a filesystem entry is owned by the executing user (C1-R5-F05). Portable
 * policy: on a platform without `process.getuid` (non-POSIX) ownership cannot be
 * observed, so it is treated as satisfied — recorded here rather than silently
 * skipped. Where uid IS available, a foreign owner is rejected by the callers.
 */
function isOwnedByUser(st: { uid: number }): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return uid == null || st.uid === uid;
}

function assertOutputRootSecure(outputRoot: string): string {
  const lst = lstatSync(outputRoot);
  if (lst.isSymbolicLink() || !lst.isDirectory()) throw new Error(`output root is not a real directory: ${outputRoot}`);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid != null && lst.uid !== uid) throw new Error(`output root not owned by this user (uid ${lst.uid} != ${uid}): ${outputRoot}`);
  if ((lst.mode & 0o777) !== 0o700) throw new Error(`output root mode is not 0700 (0${(lst.mode & 0o777).toString(8)}): ${outputRoot}`);
  return realpathSync(outputRoot);
}

/**
 * Acquire the invocation lock with an EXCLUSIVE create ("wx"): if a lock file
 * already exists — a concurrent invocation, or a stale lock left by a crash — the
 * create throws and we fail closed (a stale lock is NEVER auto-deleted). The lock
 * records only stage / pid / start-time / a non-secret invocation id; no
 * credential. The fd is kept open by the caller until {@link releaseInvocationLock}.
 * The output root's owner / mode 0700 / realpath identity are verified, and the
 * lock file's device+inode are captured so a later path replacement is detected.
 */
export function acquireInvocationLock(
  outputRoot: string,
  info: { stageId: string; invocationId: string; startedAt: string },
): InvocationLock {
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const realOutputRoot = assertOutputRootSecure(outputRoot);
  const path = join(realOutputRoot, LOCK_FILENAME);
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`invocation lock already held (stale after crash or a concurrent invocation): ${path}; refusing to proceed`);
    throw e;
  }
  const body = JSON.stringify({ stageId: info.stageId, pid: process.pid, invocationId: info.invocationId, startedAt: info.startedAt }, null, 2);
  writeSync(fd, body);
  fsyncSync(fd);
  fsyncDir(realOutputRoot);
  const fst = fstatSync(fd);
  return { path, fd, invocationId: info.invocationId, outputRoot, realOutputRoot, dev: fst.dev, ino: fst.ino, released: false };
}

/**
 * Assert the lock is still ours before a finalize — no unlocked finalize path
 * (F05). The lock is invalid if it was released, the file vanished, it is no
 * longer a regular file, the device/inode at the path differs from what we
 * acquired (an unlink+recreate replacement), the fd we still hold no longer
 * points at that same inode (lock loss / fd stolen), or the recorded invocation
 * id does not match.
 */
export function assertLockHeld(lock: InvocationLock): void {
  if (lock.released) throw new Error("invocation lock already released; refusing to finalize");
  if (!existsSync(lock.path)) throw new Error("invocation lock file lost; refusing to finalize");
  const st = lstatSync(lock.path);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("invocation lock is not a regular file");
  if (st.dev !== lock.dev || st.ino !== lock.ino) throw new Error("invocation lock file was replaced (device/inode changed); refusing to finalize");
  const fst = fstatSync(lock.fd);
  if (fst.dev !== lock.dev || fst.ino !== lock.ino) throw new Error("held lock fd no longer refers to the lock file; refusing to finalize");
  const cur = JSON.parse(readFileSync(lock.path, "utf-8")) as { invocationId?: string };
  if (cur.invocationId !== lock.invocationId) throw new Error("invocation lock not owned by this invocation");
}

/** Release the lock ONLY on clean completion: unlink then fsync the directory. */
export function releaseInvocationLock(lock: InvocationLock): void {
  if (lock.released) return;
  try {
    closeSync(lock.fd);
  } catch {
    /* fd may already be closed */
  }
  if (existsSync(lock.path)) unlinkSync(lock.path);
  fsyncDir(lock.outputRoot);
  lock.released = true;
}

/** The durable identity of a finalized artifact. */
export interface FinalizeResult {
  file: string;
  sha256: string;
  bytes: number;
  /** true when the identical artifact already existed and was reused (idempotent). */
  reused: boolean;
}

/** Unique temp-file counter — never a fixed `.tmp` name, so writers cannot collide. */
let tmpCounter = 0;

/**
 * Atomically finalize any artifact (run record, catalog, summary, manifest):
 * write to an EXCLUSIVELY-created, uniquely-named temp sibling, fsync it, rename
 * it into place, then fsync the directory. The output area is append-only:
 *
 *  - If the final path already exists it must be a REGULAR FILE whose content is
 *    byte-identical to `body`; that is an idempotent no-op (reused=true). Any
 *    other pre-existing content is a hard error — never an overwrite.
 *  - The temp file is created with an exclusive ("wx"), unique name (pid+counter)
 *    so a stale or concurrent `.tmp` never silently collides.
 *  - Permission, fsync and I/O faults PROPAGATE (the temp is cleaned up first);
 *    a durability failure is never swallowed and never reported as success.
 */
export function finalizeArtifact(dir: string, filename: string, body: string, lock: InvocationLock): FinalizeResult {
  assertLockHeld(lock);
  // The filename must be a bare basename — never a traversal or a separator (F05).
  if (typeof filename !== "string" || filename.length === 0 || filename.includes("\0"))
    throw new Error(`finalize filename invalid: ${JSON.stringify(filename)}`);
  if (filename.includes("/") || filename.includes(sep) || filename.includes("\\") || filename === "." || filename === "..")
    throw new Error(`finalize filename traversal rejected: ${filename}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The target directory must be the lock's OWN output root, or its runs/ subdir —
  // never a different root, a symlinked-away directory, or a path with a symlink
  // ancestor (realpath collapses all of those and they will not compare equal).
  const realDir = realpathSync(dir);
  const realRuns = join(lock.realOutputRoot, "runs");
  if (realDir !== lock.realOutputRoot && realDir !== realRuns)
    throw new Error(`finalize target ${realDir} is outside the lock's output root ${lock.realOutputRoot}; refusing to finalize`);
  const final = join(dir, filename);
  const bytes = Buffer.byteLength(body, "utf-8");
  const sha = sha256Of(body);
  if (existsSync(final)) {
    const st = lstatSync(final);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`artifact path is not a regular file: ${filename}`);
    if (readFileSync(final, "utf-8") !== body)
      throw new Error(`artifact already exists with different content: ${filename}; refusing to overwrite`);
    return { file: filename, sha256: sha, bytes, reused: true };
  }
  const tmp = join(dir, `.${filename}.${process.pid}.${tmpCounter++}.tmp`);
  writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
  try {
    fsyncFile(tmp);
    // Atomic NO-REPLACE: linkSync throws EEXIST if `final` appeared between our
    // existence check and now (a racing writer), so we can NEVER overwrite a file
    // some other writer created — renameSync would have replaced it (F05 TOCTOU).
    try {
      linkSync(tmp, final);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        const cur = readFileSync(final, "utf-8");
        unlinkSync(tmp);
        if (cur !== body) throw new Error(`artifact appeared with different content: ${filename}; refusing to overwrite`);
        fsyncDir(dir);
        return { file: filename, sha256: sha, bytes, reused: true };
      }
      throw e;
    }
    unlinkSync(tmp); // the hard link `final` now carries the content; drop the temp name
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup; the original fault below is what matters */
    }
    throw e;
  }
  fsyncDir(dir);
  return { file: filename, sha256: sha, bytes, reused: false };
}

/** Finalize a run record under runsDir/<runId>.json (append-only, atomic). Lock required (F05). */
export function finalizeRecord(runsDir: string, runId: string, recordJson: string, lock: InvocationLock): FinalizeResult {
  return finalizeArtifact(runsDir, `${runId}.json`, recordJson, lock);
}

/**
 * Content-addressed top-level artifact KINDS — the single registry every allowlist,
 * suffix check, orphan sweep and manifest-ref check derives from (C1-R5-F04). The r5
 * gap was that the production local-runtime preflight (`local-runtime-preflight-…`)
 * was created by the driver but MISSING from this set, so a legitimate resume of a
 * real run tripped the resume allowlist as an "unauthorized entry" before the manifest
 * was ever verified. Defining the kinds once — instead of duplicating a regex per
 * prefix — keeps them from drifting apart again.
 */
export const CONTENT_ADDRESSED_KINDS = [
  "continuation-summary",
  "catalog-preflight",
  "continuation-runtime-manifest",
  "local-runtime-preflight",
] as const;
const CONTENT_ADDRESSED_TOP = new RegExp(`^(?:${CONTENT_ADDRESSED_KINDS.join("|")})-[0-9a-f]{64}\\.json$`);
const CONTENT_ADDRESS_CAPTURE = new RegExp(`^(?:${CONTENT_ADDRESSED_KINDS.join("|")})-([0-9a-f]{64})\\.json$`);
const RUNTIME_MANIFEST_NAME = /^continuation-runtime-manifest-[0-9a-f]{64}\.json$/;

/** The 64-hex content-address embedded in a top-level artifact filename, or null. */
export function contentAddressSuffix(filename: string): string | null {
  const m = CONTENT_ADDRESS_CAPTURE.exec(filename);
  return m ? m[1] : null;
}

/**
 * A reference's `file` must be a TOP-LEVEL basename inside the output root — never
 * an absolute path, `..`, `.`, or any value containing a path separator / NUL —
 * and, once resolved against the realpath'd root, its parent must be exactly that
 * root (no traversal, no symlinked ancestor).
 */
function containedBasename(
  outputRoot: string,
  file: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof file !== "string" || file.length === 0 || file.includes("\0")) return { ok: false, reason: "catalog_ref_invalid_name" };
  if (file.includes("/") || file.includes(sep) || file.includes("\\")) return { ok: false, reason: "catalog_ref_path_separator" };
  if (file === "." || file === "..") return { ok: false, reason: "catalog_ref_dot_component" };
  let realRoot: string;
  try {
    realRoot = realpathSync(outputRoot);
  } catch {
    return { ok: false, reason: "catalog_ref_root_absent" };
  }
  const p = resolve(realRoot, file);
  if (dirname(p) !== realRoot) return { ok: false, reason: "catalog_ref_escapes_root" };
  return { ok: true, path: p };
}

/**
 * Verify a record's catalog-artifact reference against what is on disk: the
 * reference must name a contained top-level basename; the file must exist, be a
 * regular file (not a symlink/dir), not be hardlinked, its content digest must
 * equal the recorded reference digest, AND — since it is content-addressed — the
 * 64-hex suffix in its filename must equal the full SHA-256 of its body. A
 * resume-skip is only allowed when ALL of this holds.
 */
/** The artifact KIND a reference must be — its filename prefix is kind-specific (F04). */
export type ArtifactRefKind = "catalog" | "local-runtime";
const KIND_PREFIX: Record<ArtifactRefKind, string> = { catalog: "catalog-preflight", "local-runtime": "local-runtime-preflight" };

/**
 * Verify a record's artifact reference of an EXPECTED KIND against what is on disk
 * (C1-R6-F04): the reference is a TYPED ref (kind / file / sha256 / bytes), its
 * filename prefix MUST match the expected kind (a catalog artifact can never stand in
 * for a local-runtime ref, or vice-versa), and its optional `kind` tag must agree.
 * The file must be a contained, owner-only, non-hardlinked regular file; its body
 * digest AND byte length are recomputed; and — since it is content-addressed — the
 * 64-hex filename suffix must equal the full SHA-256 of its body. A resume-skip is
 * only allowed when ALL of this holds.
 */
export function verifyReferencedArtifact(
  outputRoot: string,
  ref: { file?: string; sha256?: string; bytes?: number; kind?: string } | null | undefined,
  kind: ArtifactRefKind,
): { ok: boolean; reason: string } {
  if (!ref || typeof ref.file !== "string" || typeof ref.sha256 !== "string")
    return { ok: false, reason: `missing_${kind}_ref` };
  const c = containedBasename(outputRoot, ref.file);
  if (!c.ok) return { ok: false, reason: c.reason };
  // Kind gate: the filename prefix must be this kind's, and any `kind` tag must agree —
  // so a catalog ref presented as a local-runtime ref (or vice-versa) is rejected (F04).
  if (!new RegExp(`^${KIND_PREFIX[kind]}-[0-9a-f]{64}\\.json$`).test(ref.file))
    return { ok: false, reason: `ref_kind_mismatch:expected_${kind}` };
  if (ref.kind != null && ref.kind !== kind) return { ok: false, reason: `ref_kind_tag_mismatch:expected_${kind}` };
  if (!existsSync(c.path)) return { ok: false, reason: `${kind}_ref_absent` };
  const st = lstatSync(c.path);
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: `${kind}_ref_not_regular_file` };
  if (st.nlink !== 1) return { ok: false, reason: `${kind}_ref_hardlinked` };
  if (!isOwnedByUser(st)) return { ok: false, reason: `${kind}_ref_not_owned` };
  const body = readFileSync(c.path, "utf-8");
  if (sha256Of(body) !== ref.sha256) return { ok: false, reason: `${kind}_ref_digest_mismatch` };
  if (ref.bytes != null && ref.bytes !== Buffer.byteLength(body, "utf-8")) return { ok: false, reason: `${kind}_ref_bytes_mismatch` };
  const suffix = contentAddressSuffix(ref.file);
  if (suffix == null) return { ok: false, reason: `${kind}_ref_not_content_addressed` };
  if (suffix !== fullHex(body)) return { ok: false, reason: `${kind}_ref_filename_digest_mismatch` };
  return { ok: true, reason: "ok" };
}

/**
 * Fresh (non-resume) run guard: the ENTIRE output root must be absent or empty
 * before any artifact is created — not merely the runs/ subdirectory. The single
 * exception is the invocation lock we just acquired (it is created before this
 * check, per F05). No other entry is excluded.
 */
export function assertEmptyOutputRoot(outputRoot: string): void {
  if (!existsSync(outputRoot)) return;
  const entries = readdirSync(outputRoot).filter((e) => e !== LOCK_FILENAME);
  if (entries.length > 0) {
    throw new Error(`output root is not empty (${entries.length} entries); refusing to overwrite`);
  }
}

/** Reject a symlink, a hardlinked entry, or any group/other permission bit. */
function assertSafeEntry(path: string, label: string): import("fs").Stats {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`${label} is a symlink: ${path}`);
  return st;
}

/**
 * Resume guard: every entry under the output root must be an authorized artifact,
 * with NO room for a stray file the way `runs/*.json` used to allow. The runs
 * directory may hold ONLY the exact `<runId>.json` / `<runId>.intent.json` files
 * derived from the freshly re-planned run ids; the top level may hold only the
 * driver manifest and content-addressed summary / catalog / runtime-manifest
 * artifacts. Symlinks, hardlinks (nlink>1), non-regular files, directories where
 * a file is expected, and group/other-writable modes are all rejected.
 */
export function assertResumeRootAllowlist(outputRoot: string, validRunIds: string[]): void {
  if (!existsSync(outputRoot)) return;
  const allowedTop = new Set(["runs", "continuation-driver-manifest.json", LOCK_FILENAME]);
  for (const e of readdirSync(outputRoot)) {
    const st = assertSafeEntry(join(outputRoot, e), `resume output root entry ${e}`);
    if (e === "runs") {
      if (!st.isDirectory()) throw new Error(`resume output root: runs is not a directory`);
      continue;
    }
    if (!st.isFile()) throw new Error(`resume output root has non-regular entry: ${e}`);
    if (st.nlink !== 1) throw new Error(`resume output root entry is hardlinked: ${e}`);
    if ((st.mode & 0o077) !== 0) throw new Error(`resume output root entry has unexpected mode: ${e}`);
    if (!isOwnedByUser(st)) throw new Error(`resume output root entry not owned by this user: ${e}`);
    if (!allowedTop.has(e) && !CONTENT_ADDRESSED_TOP.test(e))
      throw new Error(`resume output root has unauthorized entry: ${e}`);
    // Content address: a summary/catalog/manifest's 64-hex filename suffix MUST
    // equal the full SHA-256 of its body — a renamed or tampered artifact whose
    // name and body disagree is rejected (F02).
    const suffix = contentAddressSuffix(e);
    if (suffix != null && suffix !== fullHex(readFileSync(join(outputRoot, e), "utf-8")))
      throw new Error(`resume output root artifact filename/body digest mismatch: ${e}`);
  }
  const runsDir = join(outputRoot, "runs");
  if (existsSync(runsDir)) {
    const allowedRuns = new Set<string>();
    for (const id of validRunIds) {
      allowedRuns.add(`${id}.json`);
      allowedRuns.add(`${id}.intent.json`);
    }
    for (const e of readdirSync(runsDir)) {
      const st = assertSafeEntry(join(runsDir, e), `resume runs entry ${e}`);
      if (!st.isFile()) throw new Error(`resume runs directory has non-regular entry: ${e}`);
      if (st.nlink !== 1) throw new Error(`resume runs entry is hardlinked: ${e}`);
      if ((st.mode & 0o077) !== 0) throw new Error(`resume runs entry has unexpected mode: ${e}`);
      if (!isOwnedByUser(st)) throw new Error(`resume runs entry not owned by this user: ${e}`);
      if (!allowedRuns.has(e)) throw new Error(`resume runs directory has unauthorized entry: ${e}`);
    }
  }
}

interface ManifestRef {
  file?: string;
  sha256?: string;
  bytes?: number;
  runId?: string;
}
interface RuntimeManifestBody {
  manifestSchemaVersion?: number;
  campaignId?: string;
  stageId?: string;
  invocationId?: string;
  planDigest?: string;
  requiredRefs?: string[];
  records?: ManifestRef[];
  intents?: ManifestRef[];
  summary?: ManifestRef | null;
  catalogArtifact?: ManifestRef | null;
  localRuntimeArtifact?: ManifestRef | null;
  priorRuntimeManifests?: ManifestRef[];
}

/**
 * Strict runtime-manifest schema version. Bumped 2→3 for C1-R6-F03 (records / intents
 * required as arrays, prior bytes verified, strict crash-frontier). A manifest at any
 * other version is read-only HISTORICAL — it is rejected by the chain verifier and so
 * is never usable for a resume-skip.
 */
export const RUNTIME_MANIFEST_SCHEMA_VERSION = 3;

export interface ManifestChainResult {
  ok: boolean;
  reason: string;
  head: string | null;
  length: number;
}

/**
 * The fresh-plan binding a resume verifies every manifest against (F04): the
 * campaign / stage identity, the exact run ids the freshly re-derived plan
 * produced, a digest over that plan, and whether a zero-manifest crash frontier
 * (records on disk that no manifest has bound yet) is permitted here.
 */
export interface VerifyManifestChainOptions {
  validRunIds: string[];
  campaignId: string;
  stageId: string;
  planDigest: string;
  allowCrashFrontier: boolean;
}

/**
 * Digest binding a fresh plan: campaign, stage and the sorted run ids. Written
 * into every runtime manifest and re-derived at resume so a manifest produced
 * against a DIFFERENT plan (reshaped order, swapped run ids) is rejected (F04).
 */
export function computePlanDigest(campaignId: string, stageId: string, validRunIds: string[]): string {
  const canonical = JSON.stringify({ campaignId, stageId, runIds: [...validRunIds].sort() });
  return "sha256:" + fullHex(canonical);
}

/** A content-addressed local-runtime preflight artifact name (F01/F06). */
const LOCAL_RUNTIME_PREFLIGHT_NAME = /^local-runtime-preflight-[0-9a-f]{64}\.json$/;

/**
 * Resolve and containment-check ONE manifest reference (F04). A top-level ref must
 * be a bare basename directly under the realpath'd root; a run / intent ref must be
 * exactly `runs/<runId>.json` / `runs/<runId>.intent.json` for a runId the fresh
 * plan produced. In every case the resolved path's parent must be the realpath'd
 * root (or its runs/ subdir), and the file must be a regular, non-hardlinked,
 * owner-only entry with no symlinked ancestor — an absolute path, `..`, an extra
 * separator, a symlink, a hardlink or a group/other mode bit is rejected.
 */
function manifestRefContained(
  realRoot: string,
  ref: ManifestRef,
  kind: "top" | "run" | "intent",
  validRunIds: Set<string>,
): { ok: true; path: string } | { ok: false; reason: string } {
  const file = ref.file;
  if (typeof file !== "string" || file.length === 0 || file.includes("\0")) return { ok: false, reason: "manifest_ref_invalid_name" };
  if (file.includes("\\")) return { ok: false, reason: "manifest_ref_backslash" };
  if (file.startsWith("/")) return { ok: false, reason: "manifest_ref_absolute" };
  if (file.split("/").some((c) => c === "..")) return { ok: false, reason: "manifest_ref_dot_dot" };
  const realRuns = join(realRoot, "runs");
  let expectedDir: string;
  let basename: string;
  if (kind === "top") {
    if (file.includes("/") || file.includes(sep)) return { ok: false, reason: "manifest_ref_top_not_basename" };
    expectedDir = realRoot;
    basename = file;
  } else {
    // Exactly `runs/<name>` — one separator, prefix "runs/".
    const parts = file.split("/");
    if (parts.length !== 2 || parts[0] !== "runs") return { ok: false, reason: "manifest_ref_not_in_runs" };
    basename = parts[1];
    if (basename.length === 0 || basename.includes(sep)) return { ok: false, reason: "manifest_ref_bad_run_name" };
    const suffix = kind === "run" ? ".json" : ".intent.json";
    const id = basename.endsWith(suffix) ? basename.slice(0, -suffix.length) : null;
    if (id == null || (kind === "run" && basename.endsWith(".intent.json"))) return { ok: false, reason: "manifest_ref_wrong_suffix" };
    if (!validRunIds.has(id)) return { ok: false, reason: `manifest_ref_run_not_in_plan:${id}` };
    expectedDir = realRuns;
  }
  const p = join(expectedDir, basename);
  if (!existsSync(p)) return { ok: false, reason: `manifest_ref_absent:${file}` };
  // Reject any symlinked ancestor: the realpath of the parent must equal expectedDir.
  let realParent: string;
  try {
    realParent = realpathSync(dirname(p));
  } catch {
    return { ok: false, reason: `manifest_ref_parent_unresolved:${file}` };
  }
  if (realParent !== expectedDir) return { ok: false, reason: `manifest_ref_escapes_root:${file}` };
  const st = lstatSync(p);
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: `manifest_ref_not_regular_file:${file}` };
  if (st.nlink !== 1) return { ok: false, reason: `manifest_ref_hardlinked:${file}` };
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: `manifest_ref_mode:${file}` };
  if (!isOwnedByUser(st)) return { ok: false, reason: `manifest_ref_not_owned:${file}` };
  return { ok: true, path: p };
}

/** The content-addressed / journal artifact kind a manifest reference points at. */
type RefArtifactKind = "record" | "intent" | "summary" | "catalog" | "localRuntime";

/**
 * Parse a referenced artifact's BODY and verify its own strict schema version and
 * identity binding (C1-R5-F03) — a manifest that references a file whose digest
 * matches but whose body is the wrong campaign / stage / run, an unversioned local
 * preflight, or a malformed record is rejected. Returns a reason on failure, or null.
 */
function bindReferencedBody(
  body: string,
  kind: RefArtifactKind,
  file: string,
  opts: { campaignId: string; stageId: string },
): string | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return `manifest_ref_body_unparseable:${file}`;
  }
  if (o == null || typeof o !== "object") return `manifest_ref_body_not_object:${file}`;
  const runIdFromFile = (suffix: string): string => file.slice("runs/".length, file.length - suffix.length);
  switch (kind) {
    case "record": {
      if (o.schemaVersion !== 2) return `manifest_record_schema_version:${file}`;
      if (o.campaignId !== opts.campaignId) return `manifest_record_campaign:${file}`;
      if (o.runId !== runIdFromFile(".json")) return `manifest_record_runid:${file}`;
      return null;
    }
    case "intent": {
      if (o.campaignId !== opts.campaignId) return `manifest_intent_campaign:${file}`;
      if (o.runId !== runIdFromFile(".intent.json")) return `manifest_intent_runid:${file}`;
      if (o.state !== "prepared_not_dispatched" && o.state !== "dispatch_started") return `manifest_intent_state:${file}`;
      return null;
    }
    case "summary": {
      if (o.campaignId !== opts.campaignId) return `manifest_summary_campaign:${file}`;
      if (o.stageId !== opts.stageId) return `manifest_summary_stage:${file}`;
      return null;
    }
    case "catalog": {
      if (typeof o.catalog !== "object" || o.catalog == null) return `manifest_catalog_shape:${file}`;
      if (typeof o.rawBody !== "string") return `manifest_catalog_rawbody:${file}`;
      return null;
    }
    case "localRuntime": {
      if (o.localRuntimePreflightSchemaVersion !== 1) return `manifest_local_runtime_schema_version:${file}`;
      if (typeof o.ok !== "boolean") return `manifest_local_runtime_shape:${file}`;
      return null;
    }
  }
}

/**
 * Verify the per-invocation runtime-manifest digest chain (F04). Each invocation
 * writes one immutable, content-addressed runtime manifest that binds the digests
 * of its catalog, records, intents, summary, and EVERY prior manifest. On resume
 * the whole chain is verified mechanically:
 *
 *  - the manifests must form a single linear chain genesis→head: sorted by the
 *    number of priors they list, those counts must be 0,1,2,… and each manifest's
 *    prior set must be exactly the manifests before it (a fork, a gap, a cycle, or
 *    two heads is rejected);
 *  - each recorded prior digest must equal the prior file's on-disk digest;
 *  - every artifact a manifest references (record / intent / summary / catalog)
 *    must exist with a byte-identical digest (a 1-byte change to a manifest-bound
 *    record is caught here);
 *  - every runtime manifest and every content-addressed summary on disk must be
 *    part of the chain (an orphan manifest / summary is rejected).
 *
 * Records that exist but are not yet in any manifest belong to the in-flight
 * (possibly crashed) invocation and are validated per-record by the resume path;
 * they are not treated as orphans here.
 */
export function verifyRuntimeManifestChain(outputRoot: string, opts: VerifyManifestChainOptions): ManifestChainResult {
  if (!existsSync(outputRoot)) return { ok: true, reason: "no_output_root", head: null, length: 0 };
  let realRoot: string;
  try {
    realRoot = realpathSync(outputRoot);
  } catch {
    return { ok: false, reason: "output_root_unresolved", head: null, length: 0 };
  }
  const validRunIds = new Set(opts.validRunIds);
  const entries = readdirSync(realRoot);
  const manifestFiles = entries.filter((f) => RUNTIME_MANIFEST_NAME.test(f));

  // A record/summary/catalog/local-runtime artifact on disk with ZERO manifests is
  // either the in-flight crash frontier (records the resume path validates per
  // record) or unrecoverable corruption. A terminal artifact (summary) can never
  // exist without a manifest in the clean flow, so its presence at 0 manifests is
  // always manual_recovery_required; otherwise it is a crash frontier only when the
  // caller explicitly permits one.
  if (manifestFiles.length === 0) {
    const hasSummary = entries.some((e) => /^continuation-summary-[0-9a-f]{64}\.json$/.test(e));
    const hasArtifacts = entries.some(
      (e) =>
        /^continuation-summary-[0-9a-f]{64}\.json$/.test(e) ||
        /^catalog-preflight-[0-9a-f]{64}\.json$/.test(e) ||
        LOCAL_RUNTIME_PREFLIGHT_NAME.test(e) ||
        e === "runs",
    );
    if (!hasArtifacts) return { ok: true, reason: "empty_root", head: null, length: 0 };
    if (hasSummary || !opts.allowCrashFrontier)
      return { ok: false, reason: "manual_recovery_required:artifacts_without_manifest", head: null, length: 0 };
    return { ok: true, reason: "crash_frontier_no_manifest", head: null, length: 0 };
  }

  const bodyOf = (f: string): string => readFileSync(join(realRoot, f), "utf-8");

  const parsed = new Map<string, RuntimeManifestBody>();
  for (const f of manifestFiles) {
    // Content address must hold (name suffix == body digest).
    const suffix = contentAddressSuffix(f);
    if (suffix == null || suffix !== fullHex(bodyOf(f)))
      return { ok: false, reason: `manifest_content_address_mismatch:${f}`, head: null, length: 0 };
    let body: RuntimeManifestBody;
    try {
      body = JSON.parse(bodyOf(f)) as RuntimeManifestBody;
    } catch {
      return { ok: false, reason: `manifest_unparseable:${f}`, head: null, length: 0 };
    }
    // Strict schema + required identity fields + fresh-plan binding (F04).
    if (body.manifestSchemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION)
      return { ok: false, reason: `manifest_schema_version:${f}`, head: null, length: 0 };
    for (const field of ["campaignId", "stageId", "invocationId", "planDigest"] as const) {
      if (typeof body[field] !== "string" || (body[field] as string).length === 0)
        return { ok: false, reason: `manifest_missing_${field}:${f}`, head: null, length: 0 };
    }
    // records / intents / priors / requiredRefs are REQUIRED arrays — never omittable
    // (C1-R6-F03): a manifest that drops its records or intents is malformed.
    for (const arr of ["records", "intents", "priorRuntimeManifests", "requiredRefs"] as const) {
      if (!Array.isArray(body[arr])) return { ok: false, reason: `manifest_missing_${arr}:${f}`, head: null, length: 0 };
    }
    if (body.campaignId !== opts.campaignId) return { ok: false, reason: `manifest_campaign_mismatch:${f}`, head: null, length: 0 };
    if (body.stageId !== opts.stageId) return { ok: false, reason: `manifest_stage_mismatch:${f}`, head: null, length: 0 };
    if (body.planDigest !== opts.planDigest) return { ok: false, reason: `manifest_plan_digest_mismatch:${f}`, head: null, length: 0 };
    parsed.set(f, body);
  }

  // Single genesis / single head / unique linear predecessor chain. Sort by prior
  // count; counts must be exactly 0,1,…,n-1 (one genesis, no gap, no two heads) and
  // each manifest's prior set must be EXACTLY the manifests before it, with zero
  // duplicates and byte-matching digests (a fork, cycle, gap or duplicate prior is
  // rejected).
  const sorted = [...manifestFiles].sort(
    (a, b) => (parsed.get(a)!.priorRuntimeManifests?.length ?? 0) - (parsed.get(b)!.priorRuntimeManifests?.length ?? 0),
  );
  for (let i = 0; i < sorted.length; i++) {
    const body = parsed.get(sorted[i])!;
    const priors = body.priorRuntimeManifests ?? [];
    if (priors.length !== i)
      return { ok: false, reason: `manifest_chain_fork_or_gap_at:${sorted[i]}`, head: null, length: 0 };
    const expectedPriorSet = new Set(sorted.slice(0, i));
    const seenPrior = new Set<string>();
    for (const p of priors) {
      if (typeof p.file !== "string" || !expectedPriorSet.has(p.file))
        return { ok: false, reason: `manifest_prior_not_in_chain:${sorted[i]}`, head: null, length: 0 };
      if (seenPrior.has(p.file)) return { ok: false, reason: `manifest_duplicate_prior:${sorted[i]}`, head: null, length: 0 };
      seenPrior.add(p.file);
      if (p.file === sorted[i]) return { ok: false, reason: `manifest_cycle:${sorted[i]}`, head: null, length: 0 };
      // A prior ref must match BOTH its recorded SHA-256 AND byte length (C1-R6-F03) —
      // a false prior-manifest bytes value is rejected.
      const priorBody = bodyOf(p.file);
      if (p.sha256 !== "sha256:" + fullHex(priorBody))
        return { ok: false, reason: `manifest_prior_digest_mismatch:${p.file}`, head: null, length: 0 };
      if (typeof p.bytes !== "number" || p.bytes !== Buffer.byteLength(priorBody, "utf-8"))
        return { ok: false, reason: `manifest_prior_bytes_mismatch:${p.file}`, head: null, length: 0 };
    }
    if (seenPrior.size !== expectedPriorSet.size)
      return { ok: false, reason: `manifest_prior_cardinality:${sorted[i]}`, head: null, length: 0 };
  }

  // Every artifact a manifest binds must be contained, digest-identical, byte-length
  // identical, its referenced BODY schema/identity-bound, and — for run/intent refs —
  // an exact fresh-plan run id. requiredRefs must be EXACTLY the set of refs the
  // manifest lists (no empty array, no false bytes slipping through — C1-R5-F03).
  const referenced = new Set<string>();
  for (const f of manifestFiles) referenced.add(f);
  for (const f of manifestFiles) {
    const body = parsed.get(f)!;
    // A clean flow always writes a summary; a manifest with none is malformed.
    if (body.summary == null) return { ok: false, reason: `manifest_missing_summary:${f}`, head: null, length: 0 };
    const boundRefFiles: string[] = [];
    const check = (
      ref: ManifestRef,
      containKind: "top" | "run" | "intent",
      artifactKind: RefArtifactKind,
    ): ManifestChainResult | null => {
      if (typeof ref.sha256 !== "string") return { ok: false, reason: `manifest_ref_malformed:${f}`, head: null, length: 0 };
      const c = manifestRefContained(realRoot, ref, containKind, validRunIds);
      if (!c.ok) return { ok: false, reason: `${c.reason} (in ${f})`, head: null, length: 0 };
      if (typeof ref.bytes !== "number") return { ok: false, reason: `manifest_ref_bytes_missing:${ref.file}`, head: null, length: 0 };
      const diskBody = readFileSync(c.path, "utf-8");
      if (ref.sha256 !== "sha256:" + fullHex(diskBody))
        return { ok: false, reason: `manifest_ref_digest_mismatch:${ref.file}`, head: null, length: 0 };
      if (ref.bytes !== Buffer.byteLength(diskBody, "utf-8"))
        return { ok: false, reason: `manifest_ref_bytes_mismatch:${ref.file}`, head: null, length: 0 };
      const bindReason = bindReferencedBody(diskBody, artifactKind, ref.file as string, {
        campaignId: opts.campaignId,
        stageId: opts.stageId,
      });
      if (bindReason) return { ok: false, reason: `${bindReason} (in ${f})`, head: null, length: 0 };
      referenced.add(ref.file as string);
      boundRefFiles.push(ref.file as string);
      return null;
    };
    for (const r of body.records ?? []) {
      const e = check(r, "run", "record");
      if (e) return e;
    }
    for (const r of body.intents ?? []) {
      const e = check(r, "intent", "intent");
      if (e) return e;
    }
    const topKinds: Array<[ManifestRef | null | undefined, RefArtifactKind]> = [
      [body.summary, "summary"],
      [body.catalogArtifact, "catalog"],
      [body.localRuntimeArtifact, "localRuntime"],
    ];
    for (const [r, k] of topKinds) {
      if (r) {
        const e = check(r, "top", k);
        if (e) return e;
      }
    }
    // requiredRefs must be EXACTLY the multiset of refs bound above (records + intents
    // + summary + catalog + local-runtime) with no duplicate, missing or extra entry.
    const required = body.requiredRefs ?? [];
    if (required.some((x) => typeof x !== "string")) return { ok: false, reason: `manifest_requiredRefs_nonstring:${f}`, head: null, length: 0 };
    const reqSet = new Set(required);
    if (reqSet.size !== required.length) return { ok: false, reason: `manifest_requiredRefs_duplicate:${f}`, head: null, length: 0 };
    const boundSet = new Set(boundRefFiles);
    // priorRuntimeManifests are ALSO required refs (the chain the driver records).
    for (const pm of body.priorRuntimeManifests ?? []) if (typeof pm.file === "string") boundSet.add(pm.file);
    if (reqSet.size !== boundSet.size || [...boundSet].some((x) => !reqSet.has(x)))
      return { ok: false, reason: `manifest_requiredRefs_mismatch:${f}`, head: null, length: 0 };
  }

  // Orphan sweep: every content-addressed artifact on disk — summary, catalog,
  // local-runtime preflight, runtime manifest — AND every run record / intent must
  // be chain-referenced. Records/intents NOT referenced belong only to the in-flight
  // crash frontier (validated per-record by the resume path) and are allowed solely
  // when the caller permits a crash frontier.
  for (const e of entries) {
    const isTopArtifact =
      /^continuation-summary-[0-9a-f]{64}\.json$/.test(e) ||
      /^catalog-preflight-[0-9a-f]{64}\.json$/.test(e) ||
      LOCAL_RUNTIME_PREFLIGHT_NAME.test(e) ||
      RUNTIME_MANIFEST_NAME.test(e);
    if (isTopArtifact && !referenced.has(e)) return { ok: false, reason: `orphan_artifact:${e}`, head: null, length: 0 };
  }
  // STRICT crash frontier (C1-R6-F03): the run artifacts under runs/ that no manifest
  // binds must form a SINGLE in-flight invocation — exactly ONE run id, that id in the
  // fresh plan, its files an allowed {intent} / {intent,record} / {record} combination,
  // and each body binding to this campaign / run id with an allowed intent state. More
  // than one frontier run id, an off-plan id, an arbitrary body, or an undecidable state
  // is manual_recovery_required — allowCrashFrontier is NO blanket exemption.
  const runsDir = join(realRoot, "runs");
  if (existsSync(runsDir)) {
    const frontier = new Map<string, { record?: string; intent?: string }>();
    for (const e of readdirSync(runsDir)) {
      const rel = `runs/${e}`;
      if (referenced.has(rel)) continue;
      if (!opts.allowCrashFrontier) return { ok: false, reason: `orphan_run_artifact:${rel}`, head: null, length: 0 };
      const isIntent = e.endsWith(".intent.json");
      const id = isIntent ? e.slice(0, -".intent.json".length) : e.endsWith(".json") ? e.slice(0, -".json".length) : null;
      if (id == null || id.length === 0 || !validRunIds.has(id))
        return { ok: false, reason: `manual_recovery_required:orphan_run_artifact:${rel}`, head: null, length: 0 };
      // Safe entry (regular file, owner, mode, no symlink/hardlink).
      const st = lstatSync(join(runsDir, e));
      if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || !isOwnedByUser(st))
        return { ok: false, reason: `manual_recovery_required:frontier_unsafe_entry:${rel}`, head: null, length: 0 };
      const slot = frontier.get(id) ?? {};
      if (isIntent) slot.intent = e;
      else slot.record = e;
      frontier.set(id, slot);
    }
    if (frontier.size > 1) return { ok: false, reason: "manual_recovery_required:multiple_crash_frontiers", head: null, length: 0 };
    if (frontier.size === 1) {
      const [[id, slot]] = [...frontier.entries()];
      // Validate the intent body (state ∈ prepared/dispatch_started, matching identity).
      if (slot.intent) {
        let it: { campaignId?: unknown; runId?: unknown; state?: unknown };
        try {
          it = JSON.parse(readFileSync(join(runsDir, slot.intent), "utf-8"));
        } catch {
          return { ok: false, reason: "manual_recovery_required:frontier_intent_unparseable", head: null, length: 0 };
        }
        if (it.campaignId !== opts.campaignId || it.runId !== id)
          return { ok: false, reason: "manual_recovery_required:frontier_intent_identity", head: null, length: 0 };
        if (it.state !== "prepared_not_dispatched" && it.state !== "dispatch_started")
          return { ok: false, reason: "manual_recovery_required:frontier_intent_state", head: null, length: 0 };
      }
      // Validate the record body (schema v2, matching identity) — an arbitrary {} body
      // is undecidable and requires manual recovery.
      if (slot.record) {
        let rec: { schemaVersion?: unknown; campaignId?: unknown; runId?: unknown };
        try {
          rec = JSON.parse(readFileSync(join(runsDir, slot.record), "utf-8"));
        } catch {
          return { ok: false, reason: "manual_recovery_required:frontier_record_unparseable", head: null, length: 0 };
        }
        if (rec.schemaVersion !== 2 || rec.campaignId !== opts.campaignId || rec.runId !== id)
          return { ok: false, reason: "manual_recovery_required:frontier_record_identity", head: null, length: 0 };
      }
    }
  }

  return { ok: true, reason: "ok", head: sorted[sorted.length - 1], length: sorted.length };
}
