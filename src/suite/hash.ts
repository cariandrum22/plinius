/**
 * Canonical JSON serialization for content hashing.
 *
 * Object keys are emitted in sorted order at every level so that logically
 * equal values always produce byte-identical output (and therefore identical
 * hashes), regardless of authoring key order.
 */
import { createHash } from "crypto";

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/** sha256 of the canonical serialization, prefixed with the algorithm. */
export function canonicalHash(value: unknown): string {
  const digest = createHash("sha256").update(canonicalize(value), "utf-8");
  return `sha256:${digest.digest("hex")}`;
}

/** sha256 of raw bytes, prefixed with the algorithm. */
export function bytesHash(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
