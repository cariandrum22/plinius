/**
 * Reasoning-mode normalization.
 *
 * Providers expose reasoning differently. Plinius keeps a normalized reasoning
 * profile AND the exact provider request, and persists enough to know what was
 * requested vs accepted. A minimum-reasoning run must never be compared against
 * a maximum-reasoning run as if equivalent, so each run records its comparison
 * class (fixed-budget vs best-supported-quality).
 */
import { ReasoningConfig } from "./profiles.js";

export type ReasoningComparisonClass = "fixed-budget" | "best-supported-quality" | "none";

export interface ReasoningRequest {
  /** Exact provider request fragment merged into the request body. */
  exactRequest: Record<string, unknown>;
  requestedEffort: string | null;
  requestedMaxTokens: number | null;
  comparisonClass: ReasoningComparisonClass;
}

/**
 * Build the exact OpenRouter `reasoning` request from a normalized config.
 * `comparisonClass` distinguishes a pinned equal budget (fixed-budget) from a
 * per-model best effort (best-supported-quality).
 */
export function buildReasoningRequest(
  reasoning: ReasoningConfig | undefined,
  comparisonClass: ReasoningComparisonClass = "best-supported-quality",
): ReasoningRequest {
  if (!reasoning || !reasoning.enabled) {
    return { exactRequest: {}, requestedEffort: null, requestedMaxTokens: null, comparisonClass: "none" };
  }
  const reasoningParam: Record<string, unknown> = {};
  if (reasoning.effort) reasoningParam.effort = reasoning.effort;
  if (reasoning.maxTokens !== undefined) reasoningParam.max_tokens = reasoning.maxTokens;
  if (reasoning.exclude !== undefined) reasoningParam.exclude = reasoning.exclude;

  return {
    exactRequest: { reasoning: reasoningParam },
    requestedEffort: reasoning.effort ?? null,
    requestedMaxTokens: reasoning.maxTokens ?? null,
    comparisonClass: reasoning.maxTokens !== undefined ? "fixed-budget" : comparisonClass,
  };
}

export interface ReasoningProvenance {
  normalizedProfile: ReasoningConfig | null;
  exactRequest: Record<string, unknown>;
  requestedEffort: string | null;
  acceptedEffort: string | null;
  reasoningTokens: number | null;
  reasoningReturned: boolean;
  reasoningExcluded: boolean;
  multiTurnReasoningPreserved: boolean;
  comparisonClass: ReasoningComparisonClass;
  providerWarnings: string[];
}

export interface ReasoningResponseMeta {
  acceptedEffort?: string;
  reasoningTokens?: number;
  reasoningText?: string;
  excluded?: boolean;
  multiTurnPreserved?: boolean;
  warnings?: string[];
}

/** Fold a provider response's reasoning metadata into a persisted provenance. */
export function recordReasoning(
  reasoning: ReasoningConfig | undefined,
  request: ReasoningRequest,
  response: ReasoningResponseMeta = {},
): ReasoningProvenance {
  return {
    normalizedProfile: reasoning ?? null,
    exactRequest: request.exactRequest,
    requestedEffort: request.requestedEffort,
    acceptedEffort: response.acceptedEffort ?? null,
    reasoningTokens: response.reasoningTokens ?? null,
    reasoningReturned: typeof response.reasoningText === "string" && response.reasoningText.length > 0,
    reasoningExcluded: response.excluded ?? reasoning?.exclude ?? false,
    multiTurnReasoningPreserved: response.multiTurnPreserved ?? false,
    comparisonClass: request.comparisonClass,
    providerWarnings: response.warnings ?? [],
  };
}
