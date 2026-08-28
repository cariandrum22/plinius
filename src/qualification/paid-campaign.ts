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

import { createHash } from "node:crypto";

import {
  parseWireJson,
  reDeriveRequestIdentity,
  reDeriveResponseIdentity,
  verifyCostLookupChain,
} from "../continuation/wire.js";
import type { WireBodyPreimage, CostLookupWireEvidence } from "../continuation/wire.js";
import { deriveResponseOutcome } from "../continuation/plan.js";
import type { WireResponseOutcome } from "../continuation/plan.js";

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
  /** The provider DISPLAY name (e.g. "DeepInfra") — the value a response/lookup reports. */
  providerName: string | null;
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
  /** The matched endpoint's provider DISPLAY name — the exact value a response and
   * the cost lookup must report, derived from the verified catalog (never guessed). */
  providerDisplay?: string;
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
  if (ep.providerName == null || ep.providerName.length === 0) reasons.push("provider_display_name_missing");

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
    providerDisplay: ep.providerName ?? undefined,
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
  /** The EXACT sorted set of top-level keys actually present on the request wire, so a
   * smuggled extra field (a `models` fallback) or a present-but-null sampling field is
   * caught by an exact-set comparison against the plan (C1-PAID-R5-F01/F03). */
  requestKeys: string[];
  /** The `stream` value actually sent (the backend always sends `false`). */
  stream: unknown;
  /** The response HTTP status actually observed — a non-200 is NEVER a pass (F02). */
  responseHttpStatus: number | null;
  responseModelId: string | null;
  responseProvider: string | null;
  responseGenerationId: string | null;
  lookupModelId: string | null;
  lookupGenerationId: string | null;
  lookupProvider: string | null;
  /** The cost-lookup poll URLs actually observed, for the endpoint-binding check (F03). */
  costPollUrls: string[];
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
  /** The exact provider DISPLAY name (from the verified catalog) the response and
   * the cost lookup must BOTH report — a different provider is a provenance failure. */
  providerDisplay: string;
  /** The base URL whose `/generation?id=<responseGenerationId>` every cost poll must
   * target — a poll against an attacker-chosen endpoint is rejected (F03). */
  costLookupBaseUrl: string;
}

/** The EXACT top-level request key set the OpenAI-compatible backend transmits for a
 * paid dispatch: model / messages / stream / max_tokens / provider are ALWAYS present;
 * a sampling key is present IFF the plan sends that (non-null) value. */
function expectedRequestKeys(expected: ExpectedDispatch): string[] {
  const keys = ["max_tokens", "messages", "model", "provider", "stream"];
  if (expected.temperature !== null) keys.push("temperature");
  if (expected.topP !== null) keys.push("top_p");
  if (expected.seed !== null) keys.push("seed");
  return keys.sort();
}

function stableJson(v: unknown): string {
  return JSON.stringify(v);
}

/**
 * Verify a dispatch's full identity — RE-DERIVED BY THE CALLER FROM THE STORED WIRE
 * BYTES (request / response / cost-lookup preimages), never from an adapter's
 * convenience fields — against the plan:
 *
 *   - request: exact URL, POST method, model, provider routing, max_tokens (which
 *     MUST be present in the wire — no fallback), every sampling field, and the
 *     exact messages;
 *   - response: model equals the requested model, generation id present;
 *   - provider provenance: the response provider AND the independent cost-lookup
 *     provider BOTH equal the fixed catalog display name exactly (a "close but
 *     different" provider such as Azure on a DeepInfra route fails);
 *   - lookup identity: model and generation id are PRESENT and agree with the
 *     response (a missing lookup is a failure, never a pass).
 *
 * Any single mismatch is a reason; the caller fails closed AFTER the billed
 * outcome is durably saved.
 */
export function verifyPaidDispatch(observed: ObservedDispatch, expected: ExpectedDispatch): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (observed.requestUrl !== expected.requestUrl) reasons.push(`request_url_mismatch:${String(observed.requestUrl)}`);
  if (observed.requestMethod !== "POST") reasons.push(`request_method_mismatch:${String(observed.requestMethod)}`);
  if (observed.model !== expected.model) reasons.push(`request_model_mismatch:${String(observed.model)}`);
  if (observed.routing == null || !providerRoutingEqual(observed.routing, expected.routing)) reasons.push("request_routing_mismatch");
  if (observed.maxTokens == null) reasons.push("request_max_tokens_missing");
  else if (observed.maxTokens !== expected.maxTokens) reasons.push(`request_max_tokens_mismatch:${String(observed.maxTokens)}`);
  if (observed.temperature !== expected.temperature) reasons.push("request_temperature_mismatch");
  if (observed.topP !== expected.topP) reasons.push("request_top_p_mismatch");
  if (observed.seed !== expected.seed) reasons.push("request_seed_mismatch");
  if (stableJson(observed.messages) !== stableJson(expected.messages)) reasons.push("request_messages_mismatch");
  // The backend always sends a non-streaming request; a `stream:true` is a different call.
  if (observed.stream !== false) reasons.push(`request_stream_not_false:${String(observed.stream)}`);
  // EXACT top-level field set — this is what makes both a smuggled `models` fallback AND
  // a present-but-null sampling field (an "unsent" field added as explicit null) fail,
  // and it admits the real backend's `stream` field (F01/F03).
  if (stableJson(observed.requestKeys) !== stableJson(expectedRequestKeys(expected))) {
    reasons.push(`request_field_set_mismatch:${observed.requestKeys.join(",")}`);
  }

  // A non-200 response is NEVER a pass — even when the body is success-shaped and the
  // adapter reached a generation id and a cost lookup from an HTTP-error body (F02).
  if (observed.responseHttpStatus !== 200) reasons.push(`response_http_status:${String(observed.responseHttpStatus)}`);
  if (observed.responseModelId !== expected.model) reasons.push(`response_model_mismatch:${String(observed.responseModelId)}`);
  if (observed.responseGenerationId == null || observed.responseGenerationId.length === 0) reasons.push("response_generation_id_missing");

  // Provider provenance — EXACT display match on both the response and the lookup.
  if (observed.responseProvider == null || observed.responseProvider.length === 0) reasons.push("response_provider_missing");
  else if (observed.responseProvider !== expected.providerDisplay) reasons.push(`response_provider_mismatch:${observed.responseProvider}`);
  if (observed.lookupProvider == null || observed.lookupProvider.length === 0) reasons.push("lookup_provider_missing");
  else if (observed.lookupProvider !== expected.providerDisplay) reasons.push(`lookup_provider_mismatch:${observed.lookupProvider}`);

  // Independent cost-lookup identity is REQUIRED and must agree with the response.
  if (observed.lookupModelId == null || observed.lookupModelId.length === 0) reasons.push("lookup_model_missing");
  else if (observed.lookupModelId !== observed.responseModelId) reasons.push("lookup_model_mismatch");
  if (observed.lookupGenerationId == null || observed.lookupGenerationId.length === 0) reasons.push("lookup_generation_id_missing");
  else if (observed.lookupGenerationId !== observed.responseGenerationId) reasons.push("lookup_generation_id_mismatch");

  // Every cost poll must target the generation endpoint for THIS response's own
  // generation id — an attacker-chosen cost URL (a different id or host) is rejected (F03).
  if (observed.responseGenerationId != null && observed.responseGenerationId.length > 0) {
    const expectedCostUrl = `${expected.costLookupBaseUrl}/generation?id=${encodeURIComponent(observed.responseGenerationId)}`;
    if (observed.costPollUrls.length === 0) reasons.push("cost_poll_urls_missing");
    for (const u of observed.costPollUrls) {
      if (u !== expectedCostUrl) reasons.push(`cost_poll_url_mismatch:${u}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * A guaranteed upper bound on the token count of a string: every token encodes at
 * least one byte, so the token count never exceeds the UTF-8 byte length. Adding a
 * fixed margin covers chat-template overhead. Used for the budget ceiling estimate.
 */
export function tokenUpperBound(text: string, marginTokens = 2048): number {
  return Buffer.byteLength(text, "utf-8") + marginTokens;
}

// --- byte-preserving raw-observation re-derivation ---------------------------

/**
 * The raw, byte-preserving observation of one dispatch as persisted to disk — built
 * SOLELY from what the durable wire sink captured at the fetch boundary (never from
 * an adapter's returned convenience object). Request / response are canonical wire
 * preimages; the cost lookup is the whole poll chain.
 */
export interface PaidRawObservation {
  runId: string;
  /** URL / method observed at the fetch boundary (never a plan/convenience value). */
  requestUrl: string | null;
  requestMethod: string | null;
  requestBody: WireBodyPreimage | null;
  responseHttpStatus: number | null;
  responseBody: WireBodyPreimage | null;
  costLookup: CostLookupWireEvidence | null;
}

export interface PaidReDerivation {
  ok: boolean;
  reasons: string[];
  observed: ObservedDispatch;
  /** The BILLED cost re-derived from the cost-lookup chain's terminal poll (never facts.cost). */
  billedCostUsd: number | null;
  /** The received-response headline re-derived from the RESPONSE WIRE BYTES — status,
   * output, finish mapping, identity — so the record is built from the wire, not facts. */
  responseOutcome: WireResponseOutcome | null;
}

/**
 * Re-derive one dispatch ENTIRELY from a raw observation READ BACK FROM DISK, with
 * NO trust in any adapter-returned object (C1-PAID-R4-F01/F02/F06):
 *
 *  - request/response preimages verify with CANONICAL base64 round-trip + digest +
 *    byte length (a non-canonical / smuggled-byte payload is rejected);
 *  - the request wire's top-level fields are EXACTLY the allowed set (a `models` or
 *    other fallback field fails), and its model / max_tokens / sampling / routing are
 *    re-derived from the bytes;
 *  - the response identity AND the full received-response outcome (status, output,
 *    finish mapping) are re-derived from the response bytes via the shared
 *    `deriveResponseOutcome`;
 *  - the WHOLE cost-lookup poll chain is verified (contiguous index, url/method,
 *    canonical bodies, self-consistent parse/data flags, single terminal data-bearing
 *    poll at HTTP 200, `finalOk` consistency) and the billed cost is taken only from
 *    that verified terminal poll.
 *
 * Any failure is a reason; the caller fails closed AFTER the raw observation is durable.
 */
export function reDerivePaidFromRawObservation(raw: PaidRawObservation): PaidReDerivation {
  const reasons: string[] = [];

  // (1) Request wire — canonical integrity + identity + routing. The EXACT top-level
  // key set (against the plan) is enforced in verifyPaidDispatch, which knows which
  // sampling fields the plan sends; here we only re-derive what the bytes contain.
  const reqParsed = parseWireJson(raw.requestBody);
  if (!reqParsed.ok) reasons.push(`request_${reqParsed.reason}`);
  const reqObj = (reqParsed.ok ? (reqParsed.value ?? {}) : {}) as Record<string, unknown>;
  const requestKeys = reqParsed.ok ? Object.keys(reqObj).sort() : [];
  const reqId = reDeriveRequestIdentity(raw.requestBody);
  const parsedRouting = reqObj.provider !== undefined ? parseProviderRoutingWire(reqObj.provider) : { ok: false as const, reasons: [] };

  // (2) Response wire — canonical integrity + identity + full outcome from the bytes.
  const resParsed = parseWireJson(raw.responseBody);
  if (!resParsed.ok) reasons.push(`response_${resParsed.reason}`);
  const resId = reDeriveResponseIdentity(raw.responseBody);
  const responseOutcome = resParsed.ok ? deriveResponseOutcome(resParsed.value) : null;

  // (3) Cost-lookup chain — full walk, billed cost only from the verified terminal poll.
  const chain = verifyCostLookupChain(raw.costLookup);
  let billedCostUsd: number | null = null;
  let lookupModelId: string | null = null;
  let lookupGenerationId: string | null = null;
  let lookupProvider: string | null = null;
  if (!chain.ok) {
    reasons.push(`cost_${chain.reason}`);
  } else if (!chain.finalOk || chain.finalCost == null) {
    reasons.push("cost_lookup_not_settled");
  } else {
    billedCostUsd = chain.finalCost.actualCostUsd;
    lookupModelId = chain.finalCost.model;
    lookupGenerationId = chain.finalCost.generationId;
    lookupProvider = chain.finalCost.provider;
  }

  const costPollUrls = (raw.costLookup?.polls ?? [])
    .map((p) => (typeof (p as { url?: unknown }).url === "string" ? ((p as { url: string }).url) : null))
    .filter((u): u is string => u != null);

  const observed: ObservedDispatch = {
    requestUrl: raw.requestUrl,
    requestMethod: raw.requestMethod,
    model: reqId.ok ? reqId.identity.model : null,
    routing: parsedRouting.ok ? parsedRouting.routing : undefined,
    maxTokens: reqId.ok ? reqId.identity.maxTokens : null,
    temperature: reqId.ok ? reqId.identity.temperature : null,
    topP: reqId.ok ? reqId.identity.topP : null,
    seed: reqId.ok ? reqId.identity.seed : null,
    messages: reqObj.messages ?? null,
    requestKeys,
    stream: reqObj.stream,
    responseHttpStatus: raw.responseHttpStatus,
    responseModelId: resId.ok ? resId.identity.model : null,
    responseProvider: resId.ok ? resId.identity.provider : null,
    responseGenerationId: resId.ok ? resId.identity.generationId : null,
    lookupModelId,
    lookupGenerationId,
    lookupProvider,
    costPollUrls,
  };
  return { ok: reasons.length === 0, reasons, observed, billedCostUsd, responseOutcome };
}

// --- strict binding manifest verifier ---------------------------------------

export interface PaidManifestRef {
  file: string;
  sha256: string;
  bytes: number;
  runId?: string;
}

export interface PaidBindingManifest {
  executionManifest: PaidManifestRef | null;
  /** Detached signature over the isolated execution manifest. */
  executionSignature: PaidManifestRef | null;
  /** Launcher observation binding signature, manifest, runner and campaign. */
  executionAttestation: PaidManifestRef | null;
  parentInputs: PaidManifestRef[];
  catalogArtifact: PaidManifestRef | null;
  rawObservations: PaidManifestRef[];
  records: PaidManifestRef[];
  wires: PaidManifestRef[];
  intents: PaidManifestRef[];
  summary: PaidManifestRef;
}

/** Full signing-subkey fingerprint pinned by the Paid Pass v2 execution manifest. */
export const PAID_EXECUTION_MANIFEST_SIGNER = "435C9CF0DE7A2C3900FB24357E622B43290C285E";

/** The exact number of parent-input anchors a paid pass binds (bundle + frozen
 * campaign definition + historical run). */
export const PAID_PARENT_INPUT_COUNT = 3;

/** The filesystem metadata of one bound artifact, as observed by lstat. */
export interface PaidArtifactStat {
  isRegularFile: boolean;
  isSymbolicLink: boolean;
  ownerUid: number;
  mode: number;
  /** Hard-link count — a bound artifact must be a sole link (nlink === 1). */
  nlink: number;
}

/** Optional cross-checks beyond the per-ref digest match. */
export interface PaidManifestVerifyOptions {
  /** Every file under the output root (RECURSIVELY, across subdirectories) that the
   * manifest is expected to bind (relative paths). When provided, the set of bound refs
   * must EQUAL it — a stray file in ANY subdir (orphan-dir/unbound.json) is caught. */
  diskFiles?: string[];
  /** lstat metadata per bound file. When provided, EVERY bound artifact must be a
   * regular non-symlink, owned by `executingUid`, mode ≤ 0600, single hard link — so an
   * external-symlink / hardlinked / other-owned artifact cannot be sealed (F04). */
  statFile?: (file: string) => PaidArtifactStat | null;
  executingUid?: number;
  /** The manifest's own schema version / campaign / stage must match these (F04). */
  expectedSchemaVersion?: number;
  expectedCampaignId?: string;
  expectedStageId?: string;
}

/**
 * A ref path is safe ONLY as a clean RELATIVE path under the output root — no absolute
 * path, no traversal, no backslash, no leading-dot. The whole execution-package authentication
 * trail and the parent inputs are COPIED INTO the output root as content-addressed
 * artifacts (C1-PAID-R5-F04/F06), so the Evidence is self-contained and portable — an
 * absolute Ubuntu path is never a valid bound ref.
 */
function isSafeRefPath(file: string): boolean {
  if (typeof file !== "string" || file.length === 0) return false;
  if (file.includes("\\")) return false;
  if (file.startsWith("/")) return false; // absolute — NOT portable Evidence
  if (file.startsWith("./") || file.startsWith("../")) return false;
  return !file.split("/").some((seg) => seg === ".." || seg === "" || seg === ".");
}

/**
 * Verify a strict binding manifest against the artifacts on disk, FAIL-CLOSED
 * (C1-PAID-R4-F04 / C1-PAID-R5-F04). Beyond the per-ref digest+bytes match this rejects:
 *
 *  - a null execution manifest / signature / attestation / catalog artifact / summary;
 *  - empty records / wires / raw observations / intents (a paid pass that dispatched
 *    nothing must not certify as complete);
 *  - a parent-input count other than exactly PAID_PARENT_INPUT_COUNT;
 *  - a duplicate `file` anywhere across the whole manifest;
 *  - ANY absolute or traversal path (the Evidence must be a self-contained relative tree);
 *  - when `diskFiles` is given, any surplus (a bound file not on disk, or a disk file —
 *    in ANY subdirectory — left unbound) — the referenced set must EQUAL the disk set.
 *
 * `readFile` returns a bound file's bytes or null when absent. The driver calls this
 * on the complete pre-seal candidate before a final manifest filename exists.
 */
export function verifyPaidManifest(
  manifest: PaidBindingManifest,
  readFile: (file: string) => Buffer | null,
  opts: PaidManifestVerifyOptions = {},
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const seen = new Set<string>();
  const bound: string[] = [];

  // Manifest self-identity: schema version + campaign + stage must match (F04).
  const m = manifest as unknown as { manifestSchemaVersion?: number; campaignId?: string; stageId?: string };
  if (opts.expectedSchemaVersion !== undefined && m.manifestSchemaVersion !== opts.expectedSchemaVersion) reasons.push(`manifest_schema_version:${String(m.manifestSchemaVersion)}`);
  if (opts.expectedCampaignId !== undefined && m.campaignId !== opts.expectedCampaignId) reasons.push(`manifest_campaign:${String(m.campaignId)}`);
  if (opts.expectedStageId !== undefined && m.stageId !== opts.expectedStageId) reasons.push(`manifest_stage:${String(m.stageId)}`);

  const check = (label: string, ref: PaidManifestRef | null, required: boolean) => {
    if (!ref) {
      if (required) reasons.push(`${label}_absent`);
      return;
    }
    if (!isSafeRefPath(ref.file)) {
      reasons.push(`${label}_unsafe_path:${ref.file}`);
      return;
    }
    if (seen.has(ref.file)) reasons.push(`duplicate_ref:${ref.file}`);
    seen.add(ref.file);
    bound.push(ref.file);
    // Filesystem metadata: a bound artifact must be a regular, non-symlink, single-link
    // file owned by the executing uid with no group/other permission (F04).
    if (opts.statFile) {
      const st = opts.statFile(ref.file);
      if (st == null) reasons.push(`${label}_stat_missing:${ref.file}`);
      else {
        if (st.isSymbolicLink || !st.isRegularFile) reasons.push(`${label}_not_regular_file:${ref.file}`);
        if (st.nlink !== 1) reasons.push(`${label}_multiple_hardlinks:${ref.file}`);
        if (opts.executingUid !== undefined && st.ownerUid !== opts.executingUid) reasons.push(`${label}_owner_mismatch:${ref.file}`);
        if ((st.mode & 0o177) !== 0) reasons.push(`${label}_mode_insecure:${ref.file}`);
      }
    }
    const buf = readFile(ref.file);
    if (buf == null) {
      reasons.push(`${label}_missing:${ref.file}`);
      return;
    }
    const sha = "sha256:" + createHash("sha256").update(buf).digest("hex");
    if (sha !== ref.sha256) reasons.push(`${label}_sha_mismatch:${ref.file}`);
    if (buf.length !== ref.bytes) reasons.push(`${label}_bytes_mismatch:${ref.file}`);
  };
  const checkList = (label: string, refs: PaidManifestRef[] | undefined, requireNonEmpty: boolean) => {
    const list = refs ?? [];
    if (requireNonEmpty && list.length === 0) reasons.push(`${label}_empty`);
    for (const r of list) check(label, r, true);
  };

  // Isolated execution-package authentication trail — all three are mandatory.
  check("execution_manifest", manifest.executionManifest, true);
  check("execution_signature", manifest.executionSignature, true);
  check("execution_attestation", manifest.executionAttestation, true);
  if ((manifest.parentInputs ?? []).length !== PAID_PARENT_INPUT_COUNT) reasons.push(`parent_input_count:${(manifest.parentInputs ?? []).length}`);
  checkList("parent_input", manifest.parentInputs, true);
  check("catalog", manifest.catalogArtifact, true);
  checkList("raw_observation", manifest.rawObservations, true);
  checkList("record", manifest.records, true);
  checkList("wire", manifest.wires, true);
  checkList("intent", manifest.intents, true);
  check("summary", manifest.summary, true);

  // Exact output-root file-set completeness — no surplus (in ANY subdir), no shortfall.
  if (opts.diskFiles) {
    const boundSet = new Set(bound);
    const disk = new Set(opts.diskFiles);
    for (const f of disk) if (!boundSet.has(f)) reasons.push(`unbound_disk_file:${f}`);
    for (const f of boundSet) if (!disk.has(f)) reasons.push(`bound_file_absent_on_disk:${f}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Verify the execution attestation: it binds campaign+stage, a verified detached
 * signature by the exact pinned fingerprint, and the execution manifest/signature
 * digests. A manifest cannot pass by referencing an inert attestation file.
 */
export function verifyPaidExecutionAttestation(
  attestation: unknown,
  expected: { campaignId: string; stageId: string },
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const a = (attestation ?? null) as Record<string, unknown> | null;
  if (a == null || typeof a !== "object") return { ok: false, reasons: ["attestation_not_object"] };
  if (a.campaignId !== expected.campaignId) reasons.push(`attestation_campaign_mismatch:${String(a.campaignId)}`);
  if (a.stageId !== expected.stageId) reasons.push(`attestation_stage_mismatch:${String(a.stageId)}`);
  if (a.signatureVerified !== true) reasons.push("attestation_signature_not_verified");
  if (typeof a.signerFingerprint !== "string" || a.signerFingerprint.toUpperCase() !== PAID_EXECUTION_MANIFEST_SIGNER) {
    reasons.push(`attestation_signer_unpinned:${String(a.signerFingerprint)}`);
  }
  if (typeof a.manifestSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(a.manifestSha256)) reasons.push("attestation_manifest_digest_missing");
  if (typeof a.signatureSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(a.signatureSha256)) reasons.push("attestation_signature_digest_missing");
  return { ok: reasons.length === 0, reasons };
}

/**
 * A content-addressed artifact's filename MUST embed the SHA-256 of its own bytes as
 * `<prefix>-<64hex>.json`, so the name and the content can never disagree (the manifest
 * itself is verified this way, since it cannot contain its own digest).
 */
export function verifyContentAddressedName(filename: string, body: Buffer): boolean {
  const m = filename.match(/-([0-9a-f]{64})\.json$/);
  if (!m) return false;
  return m[1] === createHash("sha256").update(body).digest("hex");
}
