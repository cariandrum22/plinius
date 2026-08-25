/**
 * Response completeness — the four independent statuses.
 *
 * The old pipeline collapsed everything into a single "succeeded" count, so a
 * transport-level success was indistinguishable from a complete answer. These
 * four statuses are deliberately separate and are never merged:
 *
 *   transport          — did the HTTP/SDK call complete at all?
 *   response           — did a readable provider payload come back?
 *   finalCompleteness  — is there a non-empty final answer, distinct from reasoning?
 *   qualification      — does the run satisfy every acceptance rule?
 *
 * A run qualifies only when all four line up. Truncation, filtering, timeouts,
 * cancellations, provider errors, normalizer errors and unknown outcomes are
 * never counted as success at any level above transport.
 */
import { CanonicalFinishReason, FinishReasonMapping } from "./finish-reason.js";
import { NormalizedCompletion } from "./normalize.js";

export type TransportStatus = "ok" | "failed";
export type ResponseStatus = "received" | "not_received" | "unreadable";
export type FinalCompletenessStatus =
  "complete" | "empty_final" | "reasoning_only" | "truncated" | "filtered" | "normalizer_error" | "not_received";
export type QualificationStatus = "pass" | "fail";

export interface RunStatuses {
  transport: TransportStatus;
  response: ResponseStatus;
  finalCompleteness: FinalCompletenessStatus;
  qualification: QualificationStatus;
  /** Every reason the run failed to qualify, in evaluation order. */
  failureReasons: string[];
}

export interface ClassifyInput {
  /** Null when the call itself failed (network, HTTP, timeout, ...). */
  transportError: { kind: string; message: string } | null;
  /** Null when no payload was received. */
  normalized: NormalizedCompletion | null;
  finishReason: FinishReasonMapping;
}

/**
 * Classify one attempt. Deterministic and side-effect free — the same inputs
 * always yield the same statuses.
 */
export function classifyRun(input: ClassifyInput): RunStatuses {
  const failureReasons: string[] = [];

  if (input.transportError) {
    return {
      transport: "failed",
      response: "not_received",
      finalCompleteness: "not_received",
      qualification: "fail",
      failureReasons: [`transport ${input.transportError.kind}: ${input.transportError.message}`],
    };
  }

  if (!input.normalized) {
    return {
      transport: "ok",
      response: "not_received",
      finalCompleteness: "not_received",
      qualification: "fail",
      failureReasons: ["no provider payload was received"],
    };
  }

  const n = input.normalized;
  const response: ResponseStatus = n.normalizerError ? "unreadable" : "received";
  if (n.normalizerError) failureReasons.push(`normalizer error: ${n.normalizerError}`);

  let finalCompleteness: FinalCompletenessStatus;
  if (n.normalizerError) {
    finalCompleteness = "normalizer_error";
  } else if (n.reasoningOnly) {
    finalCompleteness = "reasoning_only";
    failureReasons.push("provider returned reasoning but no final answer");
  } else if (n.finalAnswerIsEmpty) {
    // Attribute the empty answer to the provider's own reason where it explains it.
    if (input.finishReason.canonical === "content_filter") {
      finalCompleteness = "filtered";
    } else if (input.finishReason.canonical === "length") {
      finalCompleteness = "truncated";
    } else {
      finalCompleteness = "empty_final";
    }
    failureReasons.push("final answer is empty or whitespace only");
  } else if (input.finishReason.canonical === "length") {
    finalCompleteness = "truncated";
  } else if (input.finishReason.canonical === "content_filter") {
    finalCompleteness = "filtered";
  } else {
    finalCompleteness = "complete";
  }

  if (!input.finishReason.accepted) {
    failureReasons.push(
      `finish reason ${JSON.stringify(input.finishReason.raw)} maps to canonical ` +
        `"${input.finishReason.canonical}", which is not an accepted terminal reason`,
    );
  }

  const qualification: QualificationStatus =
    finalCompleteness === "complete" && input.finishReason.accepted && !n.normalizerError ? "pass" : "fail";

  return { transport: "ok", response, finalCompleteness, qualification, failureReasons };
}

/** Canonical reasons that must never contribute to a success count. */
export function isSuccessCountable(
  canonical: CanonicalFinishReason,
  finalCompleteness: FinalCompletenessStatus,
): boolean {
  return canonical === "stop" && finalCompleteness === "complete";
}
