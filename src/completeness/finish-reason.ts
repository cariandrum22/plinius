/**
 * Response completeness — finish reason mapping.
 *
 * A provider's raw finish reason is never overwritten: it is recorded verbatim
 * and mapped, through the explicit table below, onto a canonical reason. Only
 * genuinely normal terminations map to the canonical stop; every other outcome
 * (truncation, filtering, timeout, cancellation, provider error, an unparseable
 * response, or anything unrecognised) maps to a non-accepted reason and must
 * never be counted as a success.
 */

/** Canonical finish reasons. Exactly one of these is accepted as terminal. */
export type CanonicalFinishReason =
  "stop" | "length" | "content_filter" | "timeout" | "cancelled" | "provider_error" | "normalizer_error" | "unknown";

/** The single canonical reason that a completed generation may carry. */
export const CANONICAL_STOP: CanonicalFinishReason = "stop";

/**
 * Raw provider finish reasons that denote a normal end of generation. Matching
 * is case-insensitive on the trimmed raw value. Anything absent from this table
 * is deliberately NOT treated as a normal termination.
 */
const NORMAL_TERMINATION: readonly string[] = [
  "stop",
  "stop_sequence",
  "end_turn",
  "eos",
  "eos_token",
  "complete",
  "completed",
  "finish_reason_stop",
];

/** Raw finish reasons that denote truncation against an output cap. */
const TRUNCATION: readonly string[] = [
  "length",
  "max_tokens",
  "max_output_tokens",
  "model_length",
  "finish_reason_max_tokens",
];

/** Raw finish reasons that denote provider-side content filtering. */
const CONTENT_FILTER: readonly string[] = [
  "content_filter",
  "content_filtered",
  "safety",
  "blocklist",
  "prohibited_content",
  "finish_reason_safety",
];

const TIMEOUT: readonly string[] = ["timeout", "timed_out", "deadline_exceeded"];
const CANCELLED: readonly string[] = ["cancelled", "canceled", "aborted", "client_closed"];
const PROVIDER_ERROR: readonly string[] = ["error", "provider_error", "failed", "internal_error"];

export interface FinishReasonMapping {
  /** The provider's value, verbatim and unmodified (null when none was sent). */
  raw: string | null;
  canonical: CanonicalFinishReason;
  /** True only for the canonical stop. */
  accepted: boolean;
  /** Which table matched, for auditability. */
  matchedTable: string;
}

/** Map one raw provider finish reason onto its canonical reason. */
export function mapFinishReason(raw: string | null | undefined): FinishReasonMapping {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return { raw: raw ?? null, canonical: "unknown", accepted: false, matchedTable: "absent" };
  }
  const key = raw.trim().toLowerCase();
  const tables: Array<[readonly string[], CanonicalFinishReason, string]> = [
    [NORMAL_TERMINATION, "stop", "normal_termination"],
    [TRUNCATION, "length", "truncation"],
    [CONTENT_FILTER, "content_filter", "content_filter"],
    [TIMEOUT, "timeout", "timeout"],
    [CANCELLED, "cancelled", "cancelled"],
    [PROVIDER_ERROR, "provider_error", "provider_error"],
  ];
  for (const [table, canonical, name] of tables) {
    if (table.includes(key)) {
      return { raw, canonical, accepted: canonical === CANONICAL_STOP, matchedTable: name };
    }
  }
  return { raw, canonical: "unknown", accepted: false, matchedTable: "unrecognised" };
}

/** The full mapping table, persisted alongside run records for auditability. */
export function finishReasonTable(): Record<string, CanonicalFinishReason> {
  const table: Record<string, CanonicalFinishReason> = {};
  for (const r of NORMAL_TERMINATION) table[r] = "stop";
  for (const r of TRUNCATION) table[r] = "length";
  for (const r of CONTENT_FILTER) table[r] = "content_filter";
  for (const r of TIMEOUT) table[r] = "timeout";
  for (const r of CANCELLED) table[r] = "cancelled";
  for (const r of PROVIDER_ERROR) table[r] = "provider_error";
  return table;
}

/** Canonical reasons that may be counted as an accepted terminal outcome. */
export const ACCEPTED_TERMINAL_REASONS: ReadonlySet<CanonicalFinishReason> = new Set([CANONICAL_STOP]);
