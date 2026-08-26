/**
 * Partitioned hosted paid passes (Paid Pass r1).
 *
 * Two production campaign passes that make hosted OpenRouter calls only and need
 * NO A100 / local runtime / Docker / GPU / Fable attestation:
 *
 *   diagnostic-hosted-paid-r1   — the 15 hosted cells of the existing frozen
 *                                 campaign, minus the historical Claude sentinel.
 *   diagnostic-candidate-paid-r1 — a NEW campaign over four candidate models.
 *
 * Everything in this module is pure and offline: campaign / target / cell
 * definitions, provider-routing construction and wire (de)serialization, live
 * catalog verification (route / endpoint / price / parameter support), budget
 * ceilings, and the wire / resume re-derivation tamper checks. No fs, no network,
 * no credential. The driver's `runPaidPass` orchestrator wires these into the
 * existing journal / dispatch / wire-capture primitives.
 */

// --- provider routing --------------------------------------------------------

/**
 * The ONLY provider-routing fields a paid request may carry. There is no generic
 * `extra` and no arbitrary `sampling.extraParams` path: paid routing is this
 * typed shape and nothing else. `order` is exactly one provider route; fallbacks
 * are off; parameters are required; `maxPrice` is the per-million-token ceiling.
 */
export interface ProviderRouting {
  order: string[];
  allowFallbacks: boolean;
  requireParameters: boolean;
  /** USD per 1,000,000 tokens — same unit as the price ceilings. */
  maxPrice: { prompt: number; completion: number };
}

/** The exact wire shape serialized under `provider` in the request body. */
export interface ProviderRoutingWire {
  order: string[];
  allow_fallbacks: boolean;
  require_parameters: boolean;
  max_price: { prompt: number; completion: number };
}

const PROVIDER_WIRE_KEYS = ["order", "allow_fallbacks", "require_parameters", "max_price"] as const;
const MAX_PRICE_KEYS = ["prompt", "completion"] as const;

/** Build the canonical routing for one paid target: exactly one provider route. */
export function buildProviderRouting(target: PaidTarget): ProviderRouting {
  return {
    order: [target.providerRoute],
    allowFallbacks: false,
    requireParameters: true,
    maxPrice: { prompt: target.priceCeiling.inputPerMTokens, completion: target.priceCeiling.outputPerMTokens },
  };
}

/** Serialize routing to the exact wire `provider` object. No unknown fields. */
export function serializeProviderRouting(routing: ProviderRouting): ProviderRoutingWire {
  return {
    order: [...routing.order],
    allow_fallbacks: routing.allowFallbacks,
    require_parameters: routing.requireParameters,
    max_price: { prompt: routing.maxPrice.prompt, completion: routing.maxPrice.completion },
  };
}

/**
 * Parse and STRICTLY validate a wire `provider` object (as re-parsed from a
 * captured request body). Rejects a missing provider, unknown fields, more than
 * one route, an enabled fallback, or a disabled parameter requirement. Returns a
 * ProviderRouting on success, else an ordered list of reasons.
 */
export function parseProviderRoutingWire(
  wireProvider: unknown,
): { ok: true; routing: ProviderRouting } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (wireProvider == null || typeof wireProvider !== "object" || Array.isArray(wireProvider)) {
    return { ok: false, reasons: ["provider_missing"] };
  }
  const p = wireProvider as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!(PROVIDER_WIRE_KEYS as readonly string[]).includes(k)) reasons.push(`provider_unknown_field:${k}`);
  }
  const order = p.order;
  if (!Array.isArray(order) || order.length !== 1 || typeof order[0] !== "string" || order[0].length === 0) {
    reasons.push("provider_order_not_exactly_one");
  }
  if (p.allow_fallbacks !== false) reasons.push("provider_fallbacks_enabled");
  if (p.require_parameters !== true) reasons.push("provider_require_parameters_disabled");
  const mp = p.max_price;
  if (mp == null || typeof mp !== "object" || Array.isArray(mp)) {
    reasons.push("provider_max_price_missing");
  } else {
    const mpo = mp as Record<string, unknown>;
    for (const k of Object.keys(mpo)) {
      if (!(MAX_PRICE_KEYS as readonly string[]).includes(k)) reasons.push(`provider_max_price_unknown_field:${k}`);
    }
    if (typeof mpo.prompt !== "number") reasons.push("provider_max_price_prompt_invalid");
    if (typeof mpo.completion !== "number") reasons.push("provider_max_price_completion_invalid");
  }
  if (reasons.length > 0) return { ok: false, reasons };
  const mpo = mp as { prompt: number; completion: number };
  return {
    ok: true,
    routing: {
      order: [(order as string[])[0]],
      allowFallbacks: false,
      requireParameters: true,
      maxPrice: { prompt: mpo.prompt, completion: mpo.completion },
    },
  };
}

/** Exact equality of two routings (order, flags, and both price ceilings). */
export function providerRoutingEqual(a: ProviderRouting, b: ProviderRouting): boolean {
  return (
    a.order.length === b.order.length &&
    a.order.every((v, i) => v === b.order[i]) &&
    a.allowFallbacks === b.allowFallbacks &&
    a.requireParameters === b.requireParameters &&
    a.maxPrice.prompt === b.maxPrice.prompt &&
    a.maxPrice.completion === b.maxPrice.completion
  );
}

// --- targets, budgets, benchmarks, passes ------------------------------------

export interface PriceCeiling {
  /** USD per 1,000,000 prompt (input) tokens. */
  inputPerMTokens: number;
  /** USD per 1,000,000 completion (output) tokens. */
  outputPerMTokens: number;
}

export interface PaidSampling {
  temperature: number | null;
  topP: number | null;
  seed: number | null;
}

export interface PaidTarget {
  slug: string;
  /** Exact OpenRouter provider route (endpoint tag). Never inferred from the slug. */
  providerRoute: string;
  priceCeiling: PriceCeiling;
  /** Per-target sampling — built individually, never forced uniform across targets. */
  sampling: PaidSampling;
}

/**
 * The OpenRouter parameter names a target's request actually carries (for the
 * capability check). `max_tokens` is always sent; the sampling flags are added
 * only when set. Routing is NOT a parameter and is never listed here.
 */
export function paidUsedParams(target: PaidTarget): string[] {
  const params = ["max_tokens"];
  if (target.sampling.temperature !== null) params.push("temperature");
  if (target.sampling.topP !== null) params.push("top_p");
  if (target.sampling.seed !== null) params.push("seed");
  return params;
}

export interface PaidBudget {
  totalCapUsd: number;
  perRunCapUsd: number;
}

export type SentinelScope = "global" | "per-model";

export interface PaidPassDefinition {
  mode: "diagnostic-hosted-paid-r1" | "diagnostic-candidate-paid-r1";
  campaignId: string;
  stageId: string;
  budget: PaidBudget;
  targets: PaidTarget[];
  sentinelScope: SentinelScope;
}

/** The four frozen benchmarks, reused by hash. finalBudget matches the driver. */
export const PAID_BENCHMARKS = [
  { id: "se-concurrency-atomic-stats-012", contentHash: "sha256:b2905ae9ed34a4644fb3f92185e55e415167f2b8559cfddbdbb6daecac258c5b", finalBudget: 8192 },
  { id: "arch-exactly-once-003", contentHash: "sha256:efecfc2ae16d237e74f275e1d989b3828fbfa246bccc5f8a8da6d0e40960090a", finalBudget: 12288 },
  { id: "sec-oidc-id-token-validation-001", contentHash: "sha256:5c0ee69752d1221e27364ddbdee738020c66207415df1f0bc143eb0cff7c9dd9", finalBudget: 8192 },
  { id: "formal-spec-idempotent-api-003", contentHash: "sha256:7cdc567c83286aac8d8cdc5a88fe77f2ea238416a5fb727a4e79e29c9eae079b", finalBudget: 8192 },
] as const;

export const PAID_REASONING_BUDGET = 16384;
export const OIDC_BENCHMARK_ID = "sec-oidc-id-token-validation-001";

/** Deterministic benchmark order used to lay out cells. */
const BENCHMARK_ORDER = PAID_BENCHMARKS.map((b) => b.id);

/** max_tokens for a hosted paid cell (all paid targets are non-shared-cap). */
export function paidCellMaxTokens(benchmarkId: string): number {
  const b = PAID_BENCHMARKS.find((x) => x.id === benchmarkId);
  if (!b) throw new Error(`unknown paid benchmark ${benchmarkId}`);
  return b.finalBudget + PAID_REASONING_BUDGET;
}

// Hosted Pass A — same frozen campaign, hosted targets only. Provider routes and
// per-target price ceilings are fixed authority values.
export const HOSTED_PAID_CAMPAIGN_ID = "plinius-qualification-2026-08-22-v1";
export const HOSTED_PAID_STAGE_ID = "plinius-qualification-2026-08-22-diagnostic-hosted-paid-r1";

// Sampling is built individually per target and is limited to parameters the fixed
// provider route SUPPORTS: an unsupported field is null (never sent), so the request
// carries no capability-invalid parameter.
export const HOSTED_PAID_TARGETS: PaidTarget[] = [
  { slug: "openai/gpt-5.6-sol-pro", providerRoute: "openai", priceCeiling: { inputPerMTokens: 2.0, outputPerMTokens: 10.0 }, sampling: { temperature: null, topP: null, seed: 1 } },
  { slug: "anthropic/claude-opus-5", providerRoute: "claude-on-aws", priceCeiling: { inputPerMTokens: 5.0, outputPerMTokens: 25.0 }, sampling: { temperature: null, topP: null, seed: null } },
  { slug: "google/gemini-3.7-flash", providerRoute: "google-vertex/global", priceCeiling: { inputPerMTokens: 0.375, outputPerMTokens: 1.875 }, sampling: { temperature: null, topP: null, seed: 1 } },
  { slug: "deepseek/deepseek-v4-flash-0731", providerRoute: "deepinfra/fp8", priceCeiling: { inputPerMTokens: 0.08, outputPerMTokens: 0.18 }, sampling: { temperature: 0, topP: 1, seed: 1 } },
];

export const HOSTED_PAID_PASS: PaidPassDefinition = {
  mode: "diagnostic-hosted-paid-r1",
  campaignId: HOSTED_PAID_CAMPAIGN_ID,
  stageId: HOSTED_PAID_STAGE_ID,
  budget: { totalCapUsd: 5.0, perRunCapUsd: 1.0 },
  targets: HOSTED_PAID_TARGETS,
  sentinelScope: "global",
};

// Candidate Pass — new campaign; four candidate models with frozen Step 2.2 routes
// and ceilings. Provider routes are the exact frozen strings.
export const CANDIDATE_PAID_CAMPAIGN_ID = "plinius-qualification-2026-08-26-candidate-r1";
export const CANDIDATE_PAID_STAGE_ID = "plinius-qualification-2026-08-26-diagnostic-candidate-paid-r1";

// provider.order carries the OpenRouter provider SLUG (endpoint tag), never a
// display name: z-ai/fp8, moonshotai/mxfp4, alibaba, anthropic.
export const CANDIDATE_PAID_TARGETS: PaidTarget[] = [
  { slug: "z-ai/glm-5.3", providerRoute: "z-ai/fp8", priceCeiling: { inputPerMTokens: 1.4, outputPerMTokens: 4.4 }, sampling: { temperature: 0, topP: null, seed: null } },
  { slug: "moonshotai/kimi-k3", providerRoute: "moonshotai/mxfp4", priceCeiling: { inputPerMTokens: 3.0, outputPerMTokens: 15.0 }, sampling: { temperature: null, topP: null, seed: null } },
  { slug: "qwen/qwen3.8-max", providerRoute: "alibaba", priceCeiling: { inputPerMTokens: 2.0, outputPerMTokens: 6.0 }, sampling: { temperature: 0, topP: null, seed: 1 } },
  { slug: "anthropic/claude-sonnet-5", providerRoute: "anthropic", priceCeiling: { inputPerMTokens: 2.0, outputPerMTokens: 10.0 }, sampling: { temperature: null, topP: null, seed: null } },
];

export const CANDIDATE_PAID_PASS: PaidPassDefinition = {
  mode: "diagnostic-candidate-paid-r1",
  campaignId: CANDIDATE_PAID_CAMPAIGN_ID,
  stageId: CANDIDATE_PAID_STAGE_ID,
  budget: { totalCapUsd: 6.0, perRunCapUsd: 0.75 },
  targets: CANDIDATE_PAID_TARGETS,
  sentinelScope: "per-model",
};

// --- cells -------------------------------------------------------------------

/**
 * One paid cell. `group` is the sentinel grouping: a single shared group for
 * global-sentinel passes, or the target slug for per-model passes. A sentinel
 * failure stops only its own group.
 */
export interface PaidCell {
  target: string;
  benchmark: string;
  sentinel: boolean;
  group: string;
}

/** The historical Claude sentinel cell that is NOT re-run in Hosted Pass A. */
const HOSTED_HISTORICAL_SENTINEL = { target: "anthropic/claude-opus-5", benchmark: OIDC_BENCHMARK_ID };
/** The campaign sentinel that runs first and gates the remaining 14 cells. */
const HOSTED_CAMPAIGN_SENTINEL = { target: "openai/gpt-5.6-sol-pro", benchmark: OIDC_BENCHMARK_ID };

/**
 * Hosted Pass A: exactly 15 cells. The gpt-5.6-sol-pro OIDC cell is the single
 * campaign sentinel (first); the claude-opus-5 OIDC cell is the historical
 * sentinel and is excluded. All cells share the one global group.
 */
export function buildHostedPaidCells(): PaidCell[] {
  const group = "hosted-global";
  const cells: PaidCell[] = [
    { target: HOSTED_CAMPAIGN_SENTINEL.target, benchmark: HOSTED_CAMPAIGN_SENTINEL.benchmark, sentinel: true, group },
  ];
  for (const t of HOSTED_PAID_TARGETS) {
    for (const b of BENCHMARK_ORDER) {
      if (t.slug === HOSTED_HISTORICAL_SENTINEL.target && b === HOSTED_HISTORICAL_SENTINEL.benchmark) continue; // historical
      if (t.slug === HOSTED_CAMPAIGN_SENTINEL.target && b === HOSTED_CAMPAIGN_SENTINEL.benchmark) continue; // already first
      cells.push({ target: t.slug, benchmark: b, sentinel: false, group });
    }
  }
  return cells;
}

/**
 * Candidate Pass: exactly 16 cells (4 targets x 4 benchmarks). Each target's OIDC
 * cell is that target's own sentinel and runs first within its group; a sentinel
 * failure skips only that target's remaining 3 cells.
 */
export function buildCandidatePaidCells(): PaidCell[] {
  const cells: PaidCell[] = [];
  for (const t of CANDIDATE_PAID_TARGETS) {
    cells.push({ target: t.slug, benchmark: OIDC_BENCHMARK_ID, sentinel: true, group: t.slug });
    for (const b of BENCHMARK_ORDER) {
      if (b === OIDC_BENCHMARK_ID) continue;
      cells.push({ target: t.slug, benchmark: b, sentinel: false, group: t.slug });
    }
  }
  return cells;
}

/** The cells and pass definition for a given mode. */
export function paidPassFor(mode: PaidPassDefinition["mode"]): { pass: PaidPassDefinition; cells: PaidCell[] } {
  if (mode === "diagnostic-hosted-paid-r1") return { pass: HOSTED_PAID_PASS, cells: buildHostedPaidCells() };
  if (mode === "diagnostic-candidate-paid-r1") return { pass: CANDIDATE_PAID_PASS, cells: buildCandidatePaidCells() };
  throw new Error(`unknown paid mode ${mode}`);
}

// --- catalog verification ----------------------------------------------------

/** One provider endpoint for a model, as re-shaped from the OpenRouter endpoints call. */
export interface ProviderEndpointInfo {
  /** The provider route tag, e.g. "openai", "deepinfra/fp8". */
  tag: string;
  /** USD PER TOKEN (OpenRouter catalog unit) — string or number; null when unknown. */
  pricing: { prompt: number | string | null; completion: number | string | null };
  contextLength: number | null;
  maxCompletionTokens: number | null;
  supportedParameters: string[];
  /** True for a free/zero-cost route, which paid passes reject. */
  isFree?: boolean;
}

/** One catalog model with its provider endpoints. */
export interface CatalogModelInfo {
  id: string;
  /** True when the id is an alias / auto-router rather than a concrete model. */
  isAlias?: boolean;
  isAutoRouter?: boolean;
  endpoints: ProviderEndpointInfo[];
}

export interface CatalogVerifyNeed {
  /** Upper-bound completion tokens the cell may request. */
  maxTokens: number;
  /** Upper-bound prompt tokens (for context sizing and the ceiling estimate). */
  promptTokens: number;
  /** The sampling parameters the request will actually send (must be supported). */
  usedParams: string[];
}

export interface CatalogVerifyResult {
  ok: boolean;
  reasons: string[];
  /** The matched endpoint's per-token price, when resolvable. */
  endpointPricePerToken?: { prompt: number; completion: number };
}

function toPerToken(value: number | string | null): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Verify one paid target against the live catalog for its exact model + provider
 * route: the model exists and is not an alias/auto-router; exactly one endpoint
 * carries the pinned route and it is not free; its per-token input/output price is
 * known and at or below the ceiling; context and max-completion satisfy the token
 * requirement; and every used parameter is supported. Any failure is a reason and
 * the caller fails closed before dispatch.
 */
export function verifyPaidTargetAgainstCatalog(
  model: CatalogModelInfo | undefined,
  target: PaidTarget,
  need: CatalogVerifyNeed,
): CatalogVerifyResult {
  const reasons: string[] = [];
  if (!model) return { ok: false, reasons: ["model_missing"] };
  if (model.id !== target.slug) reasons.push(`model_slug_mismatch:${model.id}`);
  if (model.isAlias) reasons.push("model_is_alias");
  if (model.isAutoRouter) reasons.push("model_is_auto_router");

  const matches = model.endpoints.filter((e) => e.tag === target.providerRoute);
  if (matches.length === 0) {
    reasons.push(`provider_endpoint_missing:${target.providerRoute}`);
    return { ok: false, reasons };
  }
  if (matches.length > 1) reasons.push(`provider_endpoint_ambiguous:${target.providerRoute}`);
  const ep = matches[0];
  if (ep.isFree) reasons.push("provider_endpoint_free");

  const promptPerToken = toPerToken(ep.pricing.prompt);
  const completionPerToken = toPerToken(ep.pricing.completion);
  if (promptPerToken == null || completionPerToken == null) {
    reasons.push("price_unknown");
  } else {
    const inputCeilPerToken = target.priceCeiling.inputPerMTokens / 1_000_000;
    const outputCeilPerToken = target.priceCeiling.outputPerMTokens / 1_000_000;
    if (promptPerToken > inputCeilPerToken) reasons.push("price_over_input_ceiling");
    if (completionPerToken > outputCeilPerToken) reasons.push("price_over_output_ceiling");
  }

  if (ep.contextLength == null || ep.contextLength < need.promptTokens + need.maxTokens) {
    reasons.push("context_insufficient");
  }
  if (ep.maxCompletionTokens != null && ep.maxCompletionTokens < need.maxTokens) {
    reasons.push("max_completion_insufficient");
  }
  const supported = new Set(ep.supportedParameters);
  for (const p of need.usedParams) {
    if (!supported.has(p)) reasons.push(`parameter_unsupported:${p}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    endpointPricePerToken:
      promptPerToken != null && completionPerToken != null ? { prompt: promptPerToken, completion: completionPerToken } : undefined,
  };
}

// --- budget ------------------------------------------------------------------

/**
 * Upper-bound USD cost for one cell from the catalog ceiling: prompt tokens at the
 * input ceiling plus max completion tokens at the output ceiling. Used for the
 * pre-dispatch budget check; the actual billed cost is looked up afterwards.
 */
export function estimateCellCeilingUsd(target: PaidTarget, promptTokens: number, maxTokens: number): number {
  return (promptTokens / 1_000_000) * target.priceCeiling.inputPerMTokens + (maxTokens / 1_000_000) * target.priceCeiling.outputPerMTokens;
}

export interface BudgetCheckResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Pre-dispatch budget gate: the next cell's ceiling estimate must not exceed the
 * per-run cap, and the cumulative actual spend plus this estimate must not exceed
 * the total pass cap. Both are checked independently, before any provider call.
 */
export function checkBudgetBeforeDispatch(spentUsd: number, estimateUsd: number, budget: PaidBudget): BudgetCheckResult {
  const reasons: string[] = [];
  if (estimateUsd > budget.perRunCapUsd) reasons.push("per_run_cap_exceeded");
  if (spentUsd + estimateUsd > budget.totalCapUsd) reasons.push("total_cap_exceeded");
  return { ok: reasons.length === 0, reasons };
}

// --- wire / resume re-derivation tamper check --------------------------------

export interface PaidWireExpectation {
  model: string;
  routing: ProviderRouting;
}

/**
 * Re-derive the paid request identity from a STORED request-wire body (the same
 * bytes captured at dispatch) and require the model and the full provider routing
 * — order, fallbacks, parameter requirement and both price ceilings — to match
 * the expectation exactly. A tampered model, a mutated route, an enabled
 * fallback, an unknown provider field, or a changed max_price is caught here.
 */
export function verifyPaidRequestWire(
  wireBody: unknown,
  expected: PaidWireExpectation,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (wireBody == null || typeof wireBody !== "object" || Array.isArray(wireBody)) {
    return { ok: false, reasons: ["wire_body_invalid"] };
  }
  const b = wireBody as Record<string, unknown>;
  if (b.model !== expected.model) reasons.push(`wire_model_mismatch:${String(b.model)}`);
  const parsed = parseProviderRoutingWire(b.provider);
  if (!parsed.ok) {
    reasons.push(...parsed.reasons);
  } else if (!providerRoutingEqual(parsed.routing, expected.routing)) {
    reasons.push("wire_routing_mismatch");
  }
  return { ok: reasons.length === 0, reasons };
}

// --- effective budget validation --------------------------------------------

/**
 * Validate a settled ACTUAL cost (not the pre-dispatch estimate): it must be a
 * finite, non-negative number, at or below the per-run cap, and it must not push
 * the cumulative spend past the total cap. A null / non-finite / negative /
 * over-cap cost is rejected — never coerced to 0 and never silently accepted.
 */
export function validatePaidActualCost(
  actualCostUsd: number | null | undefined,
  spentBeforeUsd: number,
  budget: PaidBudget,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (actualCostUsd == null || typeof actualCostUsd !== "number" || !Number.isFinite(actualCostUsd)) {
    return { ok: false, reasons: ["cost_unknown_or_not_finite"] };
  }
  if (actualCostUsd < 0) reasons.push("cost_negative");
  if (actualCostUsd > budget.perRunCapUsd) reasons.push("per_run_cap_exceeded_actual");
  if (spentBeforeUsd + actualCostUsd > budget.totalCapUsd) reasons.push("total_cap_exceeded_actual");
  return { ok: reasons.length === 0, reasons };
}

// --- full request/response re-derivation -------------------------------------

/** The request/response identity re-derived from the captured wire, for one cell. */
export interface ObservedDispatch {
  requestUrl: string | null;
  requestMethod: string | null;
  model: string | null;
  routing: ProviderRouting | undefined;
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  seed: number | null;
  messages: unknown;
  responseModelId: string | null;
  responseProvider: string | null;
  responseGenerationId: string | null;
  lookupModelId: string | null;
  lookupGenerationId: string | null;
  lookupProvider: string | null;
}

/** What the plan expects the dispatch to have been, for exact comparison. */
export interface ExpectedDispatch {
  requestUrl: string;
  model: string;
  routing: ProviderRouting;
  maxTokens: number;
  temperature: number | null;
  topP: number | null;
  seed: number | null;
  messages: unknown;
}

function stableJson(v: unknown): string {
  return JSON.stringify(v);
}

/**
 * Verify a dispatch's full identity, re-derived from the captured wire, against
 * the plan: request URL and POST method, model, provider routing, max_tokens and
 * every sampling field, the exact messages, the response model and provider, and
 * the generation-cost lookup identity (model + generation id agree with the
 * response). Any single mismatch is a reason; the caller fails closed AFTER the
 * billed outcome is durably saved.
 */
export function verifyPaidDispatch(observed: ObservedDispatch, expected: ExpectedDispatch): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (observed.requestUrl !== expected.requestUrl) reasons.push(`request_url_mismatch:${String(observed.requestUrl)}`);
  if (observed.requestMethod !== "POST") reasons.push(`request_method_mismatch:${String(observed.requestMethod)}`);
  if (observed.model !== expected.model) reasons.push(`request_model_mismatch:${String(observed.model)}`);
  if (observed.routing == null || !providerRoutingEqual(observed.routing, expected.routing)) reasons.push("request_routing_mismatch");
  if (observed.maxTokens !== expected.maxTokens) reasons.push(`request_max_tokens_mismatch:${String(observed.maxTokens)}`);
  if (observed.temperature !== expected.temperature) reasons.push("request_temperature_mismatch");
  if (observed.topP !== expected.topP) reasons.push("request_top_p_mismatch");
  if (observed.seed !== expected.seed) reasons.push("request_seed_mismatch");
  if (stableJson(observed.messages) !== stableJson(expected.messages)) reasons.push("request_messages_mismatch");
  if (observed.responseModelId !== expected.model) reasons.push(`response_model_mismatch:${String(observed.responseModelId)}`);
  if (observed.responseProvider == null || observed.responseProvider.length === 0) reasons.push("response_provider_missing");
  // The independent cost-lookup identity must agree with the response identity.
  if (observed.lookupModelId != null && observed.lookupModelId !== observed.responseModelId) reasons.push("lookup_model_mismatch");
  if (observed.lookupGenerationId != null && observed.responseGenerationId != null && observed.lookupGenerationId !== observed.responseGenerationId)
    reasons.push("lookup_generation_id_mismatch");
  return { ok: reasons.length === 0, reasons };
}
