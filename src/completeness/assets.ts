/**
 * Response completeness — rubric and reference asset capture.
 *
 * Two defects are fixed here.
 *
 * The rubric was hashed but never captured: every legacy run carries a
 * `rubricHash` alongside `promptSnapshot.rubric = null`, so the rubric that a
 * run was hashed against could not be recovered from the run itself. The rubric
 * object is now serialized to canonical JSON, that exact UTF-8 string is stored
 * on the snapshot, and the hash is the SHA-256 of those same bytes. Because the
 * canonical serialization is unchanged, the resulting hash is byte-identical to
 * the legacy `rubricHash` — capturing the rubric does not invalidate any
 * historical value.
 *
 * The rubric is captured for the record only. It is never appended to the
 * provider prompt: the model must not see how it will be judged.
 *
 * References are recorded by status and hash. `references.md` is optional in the
 * asset schema, so its absence is reported as `not_applicable_by_schema` with
 * the schema evidence attached, never as a missing file. The reference hash is
 * carried beside the benchmark content hash and is deliberately NOT folded into
 * the content-hash preimage, so historical `benchmarkContentHash` values stay
 * reproducible.
 */
import { createHash } from "crypto";
import { canonicalize } from "../suite/hash.js";

/** Status of a schema-optional asset. */
export type AssetStatus = "present" | "not_applicable_by_schema";

export interface RubricCapture {
  /** Canonical JSON of the loaded rubric object, exactly as stored. */
  canonicalString: string;
  /** SHA-256 of `canonicalString` as UTF-8 bytes, prefixed with the algorithm. */
  rubricHash: string;
  byteLength: number;
}

/**
 * Serialize a loaded rubric to its canonical string and hash those same bytes.
 *
 * The hash is computed over the returned string, so a caller storing
 * `canonicalString` on the snapshot can always re-derive `rubricHash` from it.
 */
export function captureRubric(rubric: unknown): RubricCapture {
  const canonicalString = canonicalize(rubric);
  const bytes = Buffer.from(canonicalString, "utf-8");
  return {
    canonicalString,
    rubricHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    byteLength: bytes.byteLength,
  };
}

/** Schema evidence for an asset class the benchmark schema does not define. */
export const REFERENCE_SCHEMA_EVIDENCE =
  "src/framework/benchmark.ts:65 — BenchmarkAssetSchema.referencesFile defaults to " +
  '"references.md" and the file is optional: src/framework/loader.ts:118 reads it ' +
  "through readOptional(), which yields an empty string when the file is absent.";

export interface ReferenceAssetCapture {
  referenceAssetStatus: AssetStatus;
  /** SHA-256 of the reference bytes, or null when not applicable. */
  referenceAssetHash: string | null;
  referenceAssetBytes: number | null;
  /** Populated only when the status is not_applicable_by_schema. */
  referenceAssetSchemaEvidence: string | null;
}

/**
 * Record the reference asset by status and hash.
 *
 * `references` is the loaded reference text; an empty string means the schema
 * permitted the file to be absent and it was.
 */
export function captureReferenceAsset(references: string): ReferenceAssetCapture {
  if (references.length === 0) {
    return {
      referenceAssetStatus: "not_applicable_by_schema",
      referenceAssetHash: null,
      referenceAssetBytes: null,
      referenceAssetSchemaEvidence: REFERENCE_SCHEMA_EVIDENCE,
    };
  }
  const bytes = Buffer.from(references, "utf-8");
  return {
    referenceAssetStatus: "present",
    referenceAssetHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    referenceAssetBytes: bytes.byteLength,
    referenceAssetSchemaEvidence: null,
  };
}

/** SHA-256 of a raw provider response, serialized canonically for stability. */
export function hashRawResponse(raw: unknown): { sha256: string; byteLength: number } {
  const serialized = raw === undefined ? "null" : canonicalize(raw);
  const bytes = Buffer.from(serialized, "utf-8");
  return {
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    byteLength: bytes.byteLength,
  };
}
