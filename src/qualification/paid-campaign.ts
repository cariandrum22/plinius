/**
 * Policy-driven hosted paid passes.
 *
 * Production campaign passes that make hosted OpenRouter calls only and need
 * NO A100 / local runtime / Docker / GPU / Fable attestation:
 *
 *   diagnostic-hosted-paid-r1   — the 15 hosted cells of the existing frozen
 *                                 campaign, minus the historical Claude sentinel.
 *   diagnostic-candidate-paid-r1 — a campaign over four candidate models.
 *   diagnostic-broad-paid-r1     — a generic 1-24 target screening campaign.
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
  /** Canonical, versioned OpenRouter slug sent on the request wire. */
  slug: string;
  /** Catalog list id whose canonical_slug must resolve exactly to slug. */
  catalogModelId: string;
  /** Exact model id expected in the chat-completions response. */
  responseModelId: string;
  /** Exact model id expected in the generation cost-lookup response. */
  lookupModelId: string;
  /** Exact OpenRouter provider route (endpoint tag). Never inferred from the slug. */
  providerRoute: string;
  /** Exact provider display name expected from catalog, response and cost lookup. */
  providerDisplay: string;
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

export type PaidPassMode =
  | "diagnostic-hosted-paid-r1"
  | "diagnostic-candidate-paid-r1"
  | "diagnostic-broad-paid-r1"
  | "diagnostic-selective-paid-r1"
  | "diagnostic-selective-paid-r2";

export const BROAD_PAID_MAX_TARGETS = 24;
export const BROAD_PAID_MAX_CELLS = 96;

interface PaidModeConstraints {
  totalCapUsd: number;
  perRunCapUsd: number;
  sentinelScope: SentinelScope;
  minTargets: number;
  maxTargets: number;
  maxCells: number;
}

const PAID_MODE_CONSTRAINTS: Record<PaidPassMode, PaidModeConstraints> = {
  "diagnostic-hosted-paid-r1": {
    totalCapUsd: 5,
    perRunCapUsd: 1,
    sentinelScope: "global",
    minTargets: 4,
    maxTargets: 4,
    maxCells: 15,
  },
  "diagnostic-candidate-paid-r1": {
    totalCapUsd: 6,
    perRunCapUsd: 0.75,
    sentinelScope: "per-model",
    minTargets: 4,
    maxTargets: 4,
    maxCells: 16,
  },
  "diagnostic-broad-paid-r1": {
    totalCapUsd: 12,
    perRunCapUsd: 2,
    sentinelScope: "per-model",
    minTargets: 1,
    maxTargets: BROAD_PAID_MAX_TARGETS,
    maxCells: BROAD_PAID_MAX_CELLS,
  },
  "diagnostic-selective-paid-r1": {
    totalCapUsd: 2,
    perRunCapUsd: 0.5,
    sentinelScope: "per-model",
    minTargets: 1,
    maxTargets: 1,
    maxCells: 4,
  },
  "diagnostic-selective-paid-r2": {
    totalCapUsd: 2,
    perRunCapUsd: 0.5,
    sentinelScope: "per-model",
    minTargets: 1,
    maxTargets: 1,
    maxCells: 4,
  },
};

export type SelectiveSentinelKind = "live" | "none";

export interface SelectivePaidCell {
  target: string;
  benchmark: string;
  sentinelKind: SelectiveSentinelKind;
}

export interface BoundedSelectivePaidCell extends SelectivePaidCell {
  /** Exact signed value sent as OpenRouter `max_tokens`. */
  maxTokens: number;
}

export interface HistoricalEvidenceFile {
  file: string;
  sha256: string;
}

export interface HistoricalSentinelEvidence {
  campaignId: string;
  stageId: string;
  evidenceArchive: HistoricalEvidenceFile;
  finalManifest: HistoricalEvidenceFile;
  runRecord: HistoricalEvidenceFile;
  verifyReport: HistoricalEvidenceFile;
  gateILedger: HistoricalEvidenceFile;
}

export interface HistoricalSentinelRequirement {
  kind: "historical";
  target: string;
  benchmark: typeof OIDC_BENCHMARK_ID;
  runId: string;
  generationId: string;
  settledCostUsd: number;
  parentEvidence: HistoricalSentinelEvidence;
}

export interface PaidPassDefinition {
  mode: PaidPassMode;
  campaignId: string;
  stageId: string;
  budget: PaidBudget;
  targets: PaidTarget[];
  sentinelScope: SentinelScope;
  /** Detached-signature policy identity bound into all resulting Evidence. */
  policyId: string;
  /** Present only for selective campaigns. Order and optional v4 bounds are authoritative. */
  selectedCells?: Array<SelectivePaidCell | BoundedSelectivePaidCell>;
  /** A verified prior sentinel may replace a live sentinel only in selective mode. */
  historicalSentinel?: HistoricalSentinelRequirement | null;
}

export const PAID_CAMPAIGN_POLICY_SCHEMA_VERSION = 2;
export const PAID_CAMPAIGN_POLICY_TYPE = "plinius-paid-campaign-policy-v2";
export const SELECTIVE_PAID_CAMPAIGN_POLICY_SCHEMA_VERSION = 3;
export const SELECTIVE_PAID_CAMPAIGN_POLICY_TYPE = "plinius-paid-campaign-policy-v3";
export const BOUNDED_SELECTIVE_PAID_CAMPAIGN_POLICY_SCHEMA_VERSION = 4;
export const BOUNDED_SELECTIVE_PAID_CAMPAIGN_POLICY_TYPE = "plinius-paid-campaign-policy-v4";
export const PAID_CAMPAIGN_POLICY_SIGNER = "435C9CF0DE7A2C3900FB24357E622B43290C285E";
const PAID_POLICY_MAX_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const PAID_POLICY_MAX_CATALOG_AGE_AT_ISSUE_MS = 24 * 60 * 60 * 1000;

export interface LegacyPaidCampaignPolicyDocument {
  schemaVersion: 2;
  policyType: typeof PAID_CAMPAIGN_POLICY_TYPE;
  policyId: string;
  issuedAtUtc: string;
  catalogObservedAtUtc: string;
  expiresAtUtc: string;
  requiredSignerFingerprint: typeof PAID_CAMPAIGN_POLICY_SIGNER;
  pass: Omit<PaidPassDefinition, "policyId">;
}

export interface SelectivePaidCampaignPolicyDocument {
  schemaVersion: 3;
  policyType: typeof SELECTIVE_PAID_CAMPAIGN_POLICY_TYPE;
  policyId: string;
  issuedAtUtc: string;
  catalogObservedAtUtc: string;
  expiresAtUtc: string;
  requiredSignerFingerprint: typeof PAID_CAMPAIGN_POLICY_SIGNER;
  pass: Omit<PaidPassDefinition, "policyId"> & {
    mode: "diagnostic-selective-paid-r1";
    selectedCells: SelectivePaidCell[];
    historicalSentinel: HistoricalSentinelRequirement | null;
  };
}

export interface BoundedSelectivePaidCampaignPolicyDocument {
  schemaVersion: 4;
  policyType: typeof BOUNDED_SELECTIVE_PAID_CAMPAIGN_POLICY_TYPE;
  policyId: string;
  issuedAtUtc: string;
  catalogObservedAtUtc: string;
  expiresAtUtc: string;
  requiredSignerFingerprint: typeof PAID_CAMPAIGN_POLICY_SIGNER;
  pass: Omit<PaidPassDefinition, "policyId"> & {
    mode: "diagnostic-selective-paid-r2";
    selectedCells: BoundedSelectivePaidCell[];
    historicalSentinel: HistoricalSentinelRequirement | null;
  };
}

export type PaidCampaignPolicyDocument =
  | LegacyPaidCampaignPolicyDocument
  | SelectivePaidCampaignPolicyDocument
  | BoundedSelectivePaidCampaignPolicyDocument;

export interface LoadedPaidCampaignPolicy {
  document: PaidCampaignPolicyDocument;
  pass: PaidPassDefinition;
  cells: PaidCell[];
  sha256: string;
}

function exactObjectKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nullableFinite(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function sha256Identity(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function safeEvidenceFile(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240 &&
    !value.includes("\\") && !value.startsWith("/") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function parseCanonicalUtc(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z") ? parsed : null;
}

/**
 * Parse the exact detached-signature policy bytes retained by the launcher.
 * Canonical pretty JSON is mandatory, eliminating duplicate/ambiguous encodings.
 * The engine retains hard budget maxima even when the signing authority changes
 * model identities or prices in a later short-lived policy.
 */
export function parsePaidCampaignPolicy(
  bytes: Buffer,
  expectedMode: PaidPassDefinition["mode"],
  nowUtc: string,
): LoadedPaidCampaignPolicy {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf-8"));
  } catch {
    throw new Error("paid campaign policy is not JSON");
  }
  const canonical = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf-8");
  if (!canonical.equals(bytes)) throw new Error("paid campaign policy is not canonical JSON");
  if (!exactObjectKeys(value, ["schemaVersion", "policyType", "policyId", "issuedAtUtc", "catalogObservedAtUtc", "expiresAtUtc", "requiredSignerFingerprint", "pass"])) {
    throw new Error("paid campaign policy field set mismatch");
  }
  const selectiveR1 = expectedMode === "diagnostic-selective-paid-r1";
  const selectiveR2 = expectedMode === "diagnostic-selective-paid-r2";
  const selective = selectiveR1 || selectiveR2;
  const policyIdentityOk = selectiveR1
    ? value.schemaVersion === SELECTIVE_PAID_CAMPAIGN_POLICY_SCHEMA_VERSION && value.policyType === SELECTIVE_PAID_CAMPAIGN_POLICY_TYPE
    : selectiveR2
      ? value.schemaVersion === BOUNDED_SELECTIVE_PAID_CAMPAIGN_POLICY_SCHEMA_VERSION && value.policyType === BOUNDED_SELECTIVE_PAID_CAMPAIGN_POLICY_TYPE
      : value.schemaVersion === PAID_CAMPAIGN_POLICY_SCHEMA_VERSION && value.policyType === PAID_CAMPAIGN_POLICY_TYPE;
  if (!policyIdentityOk) {
    throw new Error("paid campaign policy identity mismatch");
  }
  if (value.requiredSignerFingerprint !== PAID_CAMPAIGN_POLICY_SIGNER) throw new Error("paid campaign policy signer mismatch");
  if (typeof value.policyId !== "string" || !/^[a-z0-9][a-z0-9._-]{7,127}$/.test(value.policyId)) throw new Error("paid campaign policy id invalid");
  const issued = parseCanonicalUtc(value.issuedAtUtc);
  const observed = parseCanonicalUtc(value.catalogObservedAtUtc);
  const expires = parseCanonicalUtc(value.expiresAtUtc);
  const now = parseCanonicalUtc(nowUtc);
  if (issued == null || observed == null || expires == null || now == null) throw new Error("paid campaign policy timestamp invalid");
  if (observed > issued || issued - observed > PAID_POLICY_MAX_CATALOG_AGE_AT_ISSUE_MS) throw new Error("paid campaign policy catalog observation stale");
  if (issued > now + 5 * 60 * 1000) throw new Error("paid campaign policy issued in future");
  if (expires <= now || expires <= issued || expires - issued > PAID_POLICY_MAX_VALIDITY_MS) throw new Error("paid campaign policy expired or overlong");

  const passValue = value.pass;
  const expectedPassKeys = selective
    ? ["mode", "campaignId", "stageId", "budget", "targets", "sentinelScope", "selectedCells", "historicalSentinel"]
    : ["mode", "campaignId", "stageId", "budget", "targets", "sentinelScope"];
  if (!exactObjectKeys(passValue, expectedPassKeys)) throw new Error("paid campaign pass field set mismatch");
  if (passValue.mode !== expectedMode) throw new Error("paid campaign policy mode mismatch");
  if (typeof passValue.campaignId !== "string" || !/^[a-z0-9][a-z0-9._-]{7,127}$/.test(passValue.campaignId)) throw new Error("paid campaign id invalid");
  if (typeof passValue.stageId !== "string" || !/^[a-z0-9][a-z0-9._-]{7,159}$/.test(passValue.stageId)) throw new Error("paid campaign stage invalid");
  const constraints = PAID_MODE_CONSTRAINTS[expectedMode];
  if (passValue.sentinelScope !== constraints.sentinelScope) throw new Error("paid campaign sentinel scope mismatch");

  if (!exactObjectKeys(passValue.budget, ["totalCapUsd", "perRunCapUsd"])) throw new Error("paid campaign budget field set mismatch");
  const budget = passValue.budget as unknown as PaidBudget;
  if (!finitePositive(budget.totalCapUsd) || !finitePositive(budget.perRunCapUsd) || budget.totalCapUsd > constraints.totalCapUsd || budget.perRunCapUsd > constraints.perRunCapUsd) {
    throw new Error("paid campaign budget exceeds engine cap");
  }

  if (!Array.isArray(passValue.targets) || passValue.targets.length < constraints.minTargets || passValue.targets.length > constraints.maxTargets) {
    throw new Error(`paid campaign target count must be ${constraints.minTargets}-${constraints.maxTargets}`);
  }
  const targets: PaidTarget[] = passValue.targets.map((raw, index) => {
    if (!exactObjectKeys(raw, ["slug", "catalogModelId", "responseModelId", "lookupModelId", "providerRoute", "providerDisplay", "priceCeiling", "sampling"])) {
      throw new Error(`paid campaign target ${index} field set mismatch`);
    }
    for (const field of ["slug", "catalogModelId", "responseModelId", "lookupModelId", "providerRoute", "providerDisplay"] as const) {
      if (typeof raw[field] !== "string" || raw[field].length === 0 || raw[field].length > 160) throw new Error(`paid campaign target ${index} ${field} invalid`);
    }
    for (const field of ["slug", "catalogModelId", "responseModelId", "lookupModelId", "providerRoute"] as const) {
      const identifier = raw[field] as string;
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(identifier) || identifier.split("/").some((part) => part === "" || part === "." || part === "..")) {
        throw new Error(`paid campaign target ${index} ${field} unsafe`);
      }
    }
    if (/[^\x20-\x7e]/.test(raw.providerDisplay as string)) throw new Error(`paid campaign target ${index} providerDisplay unsafe`);
    if (!exactObjectKeys(raw.priceCeiling, ["inputPerMTokens", "outputPerMTokens"]) ||
      !finitePositive(raw.priceCeiling.inputPerMTokens) || !finitePositive(raw.priceCeiling.outputPerMTokens)) {
      throw new Error(`paid campaign target ${index} price ceiling invalid`);
    }
    if (!exactObjectKeys(raw.sampling, ["temperature", "topP", "seed"]) ||
      !nullableFinite(raw.sampling.temperature) || !nullableFinite(raw.sampling.topP) ||
      (raw.sampling.temperature !== null && (raw.sampling.temperature < 0 || raw.sampling.temperature > 2)) ||
      (raw.sampling.topP !== null && (raw.sampling.topP <= 0 || raw.sampling.topP > 1)) ||
      !(raw.sampling.seed === null || (Number.isSafeInteger(raw.sampling.seed) && Number(raw.sampling.seed) >= 0))) {
      throw new Error(`paid campaign target ${index} sampling invalid`);
    }
    return {
      slug: raw.slug as string,
      catalogModelId: raw.catalogModelId as string,
      responseModelId: raw.responseModelId as string,
      lookupModelId: raw.lookupModelId as string,
      providerRoute: raw.providerRoute as string,
      providerDisplay: raw.providerDisplay as string,
      priceCeiling: raw.priceCeiling as unknown as PriceCeiling,
      sampling: raw.sampling as unknown as PaidSampling,
    };
  });
  for (const field of ["slug", "catalogModelId", "responseModelId", "lookupModelId"] as const) {
    if (new Set(targets.map((target) => target[field])).size !== targets.length) throw new Error(`paid campaign duplicate target ${field}`);
  }
  const pass: PaidPassDefinition = {
    mode: expectedMode,
    campaignId: passValue.campaignId as string,
    stageId: passValue.stageId as string,
    budget: { ...budget },
    targets,
    sentinelScope: constraints.sentinelScope,
    policyId: value.policyId,
  };
  let cells: PaidCell[];
  if (selective) {
    if (!Array.isArray(passValue.selectedCells)) throw new Error("paid selective cells missing");
    const selectedCells: Array<SelectivePaidCell | BoundedSelectivePaidCell> = passValue.selectedCells.map((raw, index) => {
      const expectedFields = selectiveR2 ? ["target", "benchmark", "sentinelKind", "maxTokens"] : ["target", "benchmark", "sentinelKind"];
      if (!exactObjectKeys(raw, expectedFields)) throw new Error(`paid selective cell ${index} field set mismatch`);
      if (typeof raw.target !== "string" || typeof raw.benchmark !== "string" || (raw.sentinelKind !== "live" && raw.sentinelKind !== "none")) {
        throw new Error(`paid selective cell ${index} invalid`);
      }
      if (selectiveR2) {
        const baseline = paidCellMaxTokens(raw.benchmark);
        if (!Number.isSafeInteger(raw.maxTokens) || Number(raw.maxTokens) < baseline || Number(raw.maxTokens) > BOUNDED_SELECTIVE_MAX_TOKENS) {
          throw new Error(`paid selective cell ${index} maxTokens invalid`);
        }
        return { target: raw.target, benchmark: raw.benchmark, sentinelKind: raw.sentinelKind, maxTokens: Number(raw.maxTokens) };
      }
      return { target: raw.target, benchmark: raw.benchmark, sentinelKind: raw.sentinelKind };
    });
    let historicalSentinel: HistoricalSentinelRequirement | null = null;
    if (passValue.historicalSentinel !== null) {
      const raw = passValue.historicalSentinel;
      if (!exactObjectKeys(raw, ["kind", "target", "benchmark", "runId", "generationId", "settledCostUsd", "parentEvidence"])) {
        throw new Error("paid historical sentinel field set mismatch");
      }
      if (raw.kind !== "historical" || typeof raw.target !== "string" || raw.benchmark !== OIDC_BENCHMARK_ID ||
        typeof raw.runId !== "string" || !/^run-[0-9a-f]{16}$/.test(raw.runId) ||
        typeof raw.generationId !== "string" || !/^gen-[A-Za-z0-9_-]{8,160}$/.test(raw.generationId) ||
        !finitePositive(raw.settledCostUsd)) {
        throw new Error("paid historical sentinel identity invalid");
      }
      const pe = raw.parentEvidence;
      if (!exactObjectKeys(pe, ["campaignId", "stageId", "evidenceArchive", "finalManifest", "runRecord", "verifyReport", "gateILedger"]) ||
        typeof pe.campaignId !== "string" || !/^[a-z0-9][a-z0-9._-]{7,127}$/.test(pe.campaignId) ||
        typeof pe.stageId !== "string" || !/^[a-z0-9][a-z0-9._-]{7,159}$/.test(pe.stageId)) {
        throw new Error("paid historical sentinel parent Evidence invalid");
      }
      const parseEvidenceFile = (file: unknown, label: string): HistoricalEvidenceFile => {
        if (!exactObjectKeys(file, ["file", "sha256"]) || !safeEvidenceFile(file.file) || !sha256Identity(file.sha256)) {
          throw new Error(`paid historical sentinel ${label} invalid`);
        }
        return { file: file.file, sha256: file.sha256 };
      };
      historicalSentinel = {
        kind: "historical",
        target: raw.target,
        benchmark: OIDC_BENCHMARK_ID,
        runId: raw.runId,
        generationId: raw.generationId,
        settledCostUsd: raw.settledCostUsd,
        parentEvidence: {
          campaignId: pe.campaignId,
          stageId: pe.stageId,
          evidenceArchive: parseEvidenceFile(pe.evidenceArchive, "archive"),
          finalManifest: parseEvidenceFile(pe.finalManifest, "final manifest"),
          runRecord: parseEvidenceFile(pe.runRecord, "run record"),
          verifyReport: parseEvidenceFile(pe.verifyReport, "verify report"),
          gateILedger: parseEvidenceFile(pe.gateILedger, "Gate I ledger"),
        },
      };
      const parentFiles = historicalSentinelParentFiles(historicalSentinel);
      if (new Set(parentFiles.map((file) => file.file)).size !== parentFiles.length) throw new Error("paid historical sentinel duplicate parent file");
      if (historicalSentinel.parentEvidence.runRecord.file !== `runs/${historicalSentinel.runId}.json`) throw new Error("paid historical sentinel run record path mismatch");
      if (historicalSentinel.parentEvidence.finalManifest.file !== `paid-pass-manifest-${historicalSentinel.parentEvidence.finalManifest.sha256.slice(7)}.json`) {
        throw new Error("paid historical sentinel final manifest path mismatch");
      }
    }
    cells = buildSelectivePaidCells(targets, selectedCells, historicalSentinel);
    pass.selectedCells = selectedCells;
    pass.historicalSentinel = historicalSentinel;
  } else {
    cells = constraints.sentinelScope === "global" ? buildHostedPaidCells(targets) : buildPerModelPaidCells(targets);
  }
  if (cells.length > constraints.maxCells) throw new Error(`paid campaign exceeds ${constraints.maxCells} logical cells`);
  return {
    document: value as unknown as PaidCampaignPolicyDocument,
    pass,
    cells,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

/** The four frozen benchmarks, reused by hash. finalBudget matches the driver. */
export const PAID_BENCHMARKS = [
  { id: "se-concurrency-atomic-stats-012", contentHash: "sha256:b2905ae9ed34a4644fb3f92185e55e415167f2b8559cfddbdbb6daecac258c5b", finalBudget: 8192 },
  { id: "arch-exactly-once-003", contentHash: "sha256:efecfc2ae16d237e74f275e1d989b3828fbfa246bccc5f8a8da6d0e40960090a", finalBudget: 12288 },
  { id: "sec-oidc-id-token-validation-001", contentHash: "sha256:5c0ee69752d1221e27364ddbdee738020c66207415df1f0bc143eb0cff7c9dd9", finalBudget: 8192 },
  { id: "formal-spec-idempotent-api-003", contentHash: "sha256:7cdc567c83286aac8d8cdc5a88fe77f2ea238416a5fb727a4e79e29c9eae079b", finalBudget: 8192 },
] as const;

export const PAID_REASONING_BUDGET = 16384;
export const BOUNDED_SELECTIVE_MAX_TOKENS = 65536;
export const OIDC_BENCHMARK_ID = "sec-oidc-id-token-validation-001";

/** Deterministic benchmark order used to lay out cells. */
const BENCHMARK_ORDER = PAID_BENCHMARKS.map((b) => b.id);

/** max_tokens for a hosted paid cell (all paid targets are non-shared-cap). */
export function paidCellMaxTokens(benchmarkId: string): number {
  const b = PAID_BENCHMARKS.find((x) => x.id === benchmarkId);
  if (!b) throw new Error(`unknown paid benchmark ${benchmarkId}`);
  return b.finalBudget + PAID_REASONING_BUDGET;
}

/** Resolve the exact request ceiling without changing any pre-v4 policy behavior. */
export function paidCellMaxTokensForPass(pass: PaidPassDefinition, cell: PaidCell): number {
  if (pass.mode !== "diagnostic-selective-paid-r2") return paidCellMaxTokens(cell.benchmark);
  const selected = pass.selectedCells?.find((candidate) => candidate.target === cell.target && candidate.benchmark === cell.benchmark);
  if (selected == null || !("maxTokens" in selected)) throw new Error(`bounded selective maxTokens missing for ${cell.target} x ${cell.benchmark}`);
  return selected.maxTokens;
}

// Hosted Pass A — same frozen campaign, hosted targets only. Provider routes and
// per-target price ceilings are fixed authority values.
export const HOSTED_PAID_CAMPAIGN_ID = "plinius-qualification-2026-08-22-v1";
export const HOSTED_PAID_STAGE_ID = "plinius-qualification-2026-08-22-diagnostic-hosted-paid-r1";

// Sampling is built individually per target and is limited to parameters the fixed
// provider route SUPPORTS: an unsupported field is null (never sent), so the request
// carries no capability-invalid parameter.
export const HOSTED_PAID_TARGETS: PaidTarget[] = [
  { slug: "openai/gpt-5.6-sol-pro-20260709", catalogModelId: "openai/gpt-5.6-sol-pro", responseModelId: "openai/gpt-5.6-sol-pro", lookupModelId: "openai/gpt-5.6-sol-pro-20260709", providerRoute: "openai", providerDisplay: "OpenAI", priceCeiling: { inputPerMTokens: 2.0, outputPerMTokens: 10.0 }, sampling: { temperature: null, topP: null, seed: 1 } },
  { slug: "anthropic/claude-opus-5-20260723", catalogModelId: "anthropic/claude-opus-5", responseModelId: "anthropic/claude-opus-5", lookupModelId: "anthropic/claude-opus-5-20260723", providerRoute: "claude-on-aws", providerDisplay: "Claude Platform on AWS", priceCeiling: { inputPerMTokens: 5.0, outputPerMTokens: 25.0 }, sampling: { temperature: null, topP: null, seed: null } },
  { slug: "google/gemini-3.7-flash-20260813", catalogModelId: "google/gemini-3.7-flash", responseModelId: "google/gemini-3.7-flash", lookupModelId: "google/gemini-3.7-flash-20260813", providerRoute: "google-vertex/global", providerDisplay: "Google", priceCeiling: { inputPerMTokens: 0.75, outputPerMTokens: 3.75 }, sampling: { temperature: null, topP: null, seed: 1 } },
  { slug: "deepseek/deepseek-v4-flash-20260731", catalogModelId: "deepseek/deepseek-v4-flash-0731", responseModelId: "deepseek/deepseek-v4-flash-0731", lookupModelId: "deepseek/deepseek-v4-flash-20260731", providerRoute: "deepinfra/fp8", providerDisplay: "DeepInfra", priceCeiling: { inputPerMTokens: 0.08, outputPerMTokens: 0.18 }, sampling: { temperature: 0, topP: 1, seed: 1 } },
];

export const HOSTED_PAID_PASS: PaidPassDefinition = {
  mode: "diagnostic-hosted-paid-r1",
  campaignId: HOSTED_PAID_CAMPAIGN_ID,
  stageId: HOSTED_PAID_STAGE_ID,
  budget: { totalCapUsd: 5.0, perRunCapUsd: 1.0 },
  targets: HOSTED_PAID_TARGETS,
  sentinelScope: "global",
  policyId: "plinius-hosted-paid-2026-08-30-r2",
};

// Candidate Pass — new campaign; four candidate models with frozen Step 2.2 routes
// and ceilings. Provider routes are the exact frozen strings.
export const CANDIDATE_PAID_CAMPAIGN_ID = "plinius-qualification-2026-08-26-candidate-r1";
export const CANDIDATE_PAID_STAGE_ID = "plinius-qualification-2026-08-26-diagnostic-candidate-paid-r1";

// provider.order carries the OpenRouter provider SLUG (endpoint tag), never a
// display name: z-ai/fp8, moonshotai/mxfp4, alibaba, anthropic.
export const CANDIDATE_PAID_TARGETS: PaidTarget[] = [
  { slug: "z-ai/glm-5.3", catalogModelId: "z-ai/glm-5.3", responseModelId: "z-ai/glm-5.3", lookupModelId: "z-ai/glm-5.3", providerRoute: "z-ai/fp8", providerDisplay: "Z.AI", priceCeiling: { inputPerMTokens: 1.4, outputPerMTokens: 4.4 }, sampling: { temperature: 0, topP: null, seed: null } },
  { slug: "moonshotai/kimi-k3", catalogModelId: "moonshotai/kimi-k3", responseModelId: "moonshotai/kimi-k3", lookupModelId: "moonshotai/kimi-k3", providerRoute: "moonshotai/mxfp4", providerDisplay: "Moonshot AI", priceCeiling: { inputPerMTokens: 3.0, outputPerMTokens: 15.0 }, sampling: { temperature: null, topP: null, seed: null } },
  { slug: "qwen/qwen3.8-max", catalogModelId: "qwen/qwen3.8-max", responseModelId: "qwen/qwen3.8-max", lookupModelId: "qwen/qwen3.8-max", providerRoute: "alibaba", providerDisplay: "Alibaba", priceCeiling: { inputPerMTokens: 2.0, outputPerMTokens: 6.0 }, sampling: { temperature: 0, topP: null, seed: 1 } },
  { slug: "anthropic/claude-sonnet-5", catalogModelId: "anthropic/claude-sonnet-5", responseModelId: "anthropic/claude-sonnet-5", lookupModelId: "anthropic/claude-sonnet-5", providerRoute: "anthropic", providerDisplay: "Anthropic", priceCeiling: { inputPerMTokens: 2.0, outputPerMTokens: 10.0 }, sampling: { temperature: null, topP: null, seed: null } },
];

export const CANDIDATE_PAID_PASS: PaidPassDefinition = {
  mode: "diagnostic-candidate-paid-r1",
  campaignId: CANDIDATE_PAID_CAMPAIGN_ID,
  stageId: CANDIDATE_PAID_STAGE_ID,
  budget: { totalCapUsd: 6.0, perRunCapUsd: 0.75 },
  targets: CANDIDATE_PAID_TARGETS,
  sentinelScope: "per-model",
  policyId: "plinius-candidate-paid-unissued",
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
const HOSTED_HISTORICAL_SENTINEL = { targetIndex: 1, benchmark: OIDC_BENCHMARK_ID };
/** The campaign sentinel that runs first and gates the remaining 14 cells. */
const HOSTED_CAMPAIGN_SENTINEL = { targetIndex: 0, benchmark: OIDC_BENCHMARK_ID };

/**
 * Hosted Pass A: exactly 15 cells. The gpt-5.6-sol-pro OIDC cell is the single
 * campaign sentinel (first); the claude-opus-5 OIDC cell is the historical
 * sentinel and is excluded. All cells share the one global group.
 */
export function buildHostedPaidCells(targets: PaidTarget[]): PaidCell[] {
  if (targets.length !== 4) throw new Error("hosted paid policy must define exactly four targets");
  const group = "hosted-global";
  const campaignSentinelTarget = targets[HOSTED_CAMPAIGN_SENTINEL.targetIndex].slug;
  const historicalSentinelTarget = targets[HOSTED_HISTORICAL_SENTINEL.targetIndex].slug;
  const cells: PaidCell[] = [
    { target: campaignSentinelTarget, benchmark: HOSTED_CAMPAIGN_SENTINEL.benchmark, sentinel: true, group },
  ];
  for (const t of targets) {
    for (const b of BENCHMARK_ORDER) {
      if (t.slug === historicalSentinelTarget && b === HOSTED_HISTORICAL_SENTINEL.benchmark) continue; // historical
      if (t.slug === campaignSentinelTarget && b === HOSTED_CAMPAIGN_SENTINEL.benchmark) continue; // already first
      cells.push({ target: t.slug, benchmark: b, sentinel: false, group });
    }
  }
  return cells;
}

/**
 * Per-model paid layout. Each target's OIDC cell is that target's own sentinel
 * and runs first within its group; a sentinel failure skips only that target's
 * remaining three cells.
 */
export function buildPerModelPaidCells(targets: PaidTarget[]): PaidCell[] {
  if (targets.length < 1 || targets.length > BROAD_PAID_MAX_TARGETS) {
    throw new Error(`per-model paid policy must define 1-${BROAD_PAID_MAX_TARGETS} targets`);
  }
  const cells: PaidCell[] = [];
  for (const t of targets) {
    cells.push({ target: t.slug, benchmark: OIDC_BENCHMARK_ID, sentinel: true, group: t.slug });
    for (const b of BENCHMARK_ORDER) {
      if (b === OIDC_BENCHMARK_ID) continue;
      cells.push({ target: t.slug, benchmark: b, sentinel: false, group: t.slug });
    }
  }
  if (cells.length > BROAD_PAID_MAX_CELLS) throw new Error(`per-model paid policy exceeds ${BROAD_PAID_MAX_CELLS} logical cells`);
  return cells;
}

/**
 * Policy-v3 selective layout. It is deliberately limited to one target and the
 * four frozen benchmarks so recovery campaigns cannot accidentally combine
 * models or re-expand a target to the broad four-cell matrix.
 */
export function buildSelectivePaidCells(
  targets: PaidTarget[],
  selectedCells: Array<SelectivePaidCell | BoundedSelectivePaidCell>,
  historicalSentinel: HistoricalSentinelRequirement | null,
): PaidCell[] {
  if (targets.length !== 1) throw new Error("selective paid policy must define exactly one target");
  if (selectedCells.length < 1 || selectedCells.length > PAID_BENCHMARKS.length) {
    throw new Error(`selective paid selection must define 1-${PAID_BENCHMARKS.length} cells`);
  }
  const target = targets[0];
  const seen = new Set<string>();
  const cells = selectedCells.map((selected, index): PaidCell => {
    if (selected.target !== target.slug) throw new Error(`selective paid cell ${index} references a policy-external target`);
    if (!BENCHMARK_ORDER.includes(selected.benchmark as (typeof BENCHMARK_ORDER)[number])) {
      throw new Error(`selective paid cell ${index} references an unknown benchmark`);
    }
    const key = `${selected.target}\u0000${selected.benchmark}`;
    if (seen.has(key)) throw new Error(`selective paid cell ${index} duplicates a selected cell`);
    seen.add(key);
    return { target: selected.target, benchmark: selected.benchmark, sentinel: selected.sentinelKind === "live", group: selected.target };
  });
  const liveSentinels = selectedCells.filter((cell) => cell.sentinelKind === "live");
  if (historicalSentinel == null) {
    if (liveSentinels.length !== 1 || selectedCells[0].sentinelKind !== "live" || selectedCells[0].benchmark !== OIDC_BENCHMARK_ID) {
      throw new Error("selective paid live sentinel must be the first OIDC cell");
    }
  } else {
    if (historicalSentinel.target !== target.slug || historicalSentinel.benchmark !== OIDC_BENCHMARK_ID) {
      throw new Error("selective paid historical sentinel target or benchmark mismatch");
    }
    if (liveSentinels.length !== 0) throw new Error("selective paid historical campaign cannot include a live sentinel");
    if (selectedCells.some((cell) => cell.target === historicalSentinel.target && cell.benchmark === historicalSentinel.benchmark)) {
      throw new Error("selective paid historical sentinel cannot be redispatched");
    }
  }
  return cells;
}

export const HISTORICAL_SENTINEL_PARENT_ORDER = [
  "evidenceArchive",
  "finalManifest",
  "runRecord",
  "verifyReport",
  "gateILedger",
] as const;

export type HistoricalSentinelParentRole = (typeof HISTORICAL_SENTINEL_PARENT_ORDER)[number];

export type HistoricalSentinelEvidenceBodies = Record<HistoricalSentinelParentRole, Buffer>;

/** Ordered parent files copied into selective Evidence and checked independently. */
export function historicalSentinelParentFiles(requirement: HistoricalSentinelRequirement): HistoricalEvidenceFile[] {
  return HISTORICAL_SENTINEL_PARENT_ORDER.map((role) => requirement.parentEvidence[role]);
}

/**
 * Re-derive an accepted historical sentinel from pinned parent bytes. This does
 * not trust the prior verifier's `ok`; the final manifest, run record, and Gate I
 * ledger are checked against each other and against the signed requirement.
 */
export function verifyHistoricalSentinelEvidence(
  requirement: HistoricalSentinelRequirement,
  target: PaidTarget,
  bodies: HistoricalSentinelEvidenceBodies,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const require = (reason: string, condition: boolean): void => {
    if (!condition) reasons.push(reason);
  };
  for (const role of HISTORICAL_SENTINEL_PARENT_ORDER) {
    const expected = requirement.parentEvidence[role];
    require(`${role}_digest`, `sha256:${createHash("sha256").update(bodies[role]).digest("hex")}` === expected.sha256);
  }
  let manifest: Record<string, unknown> | null = null;
  let record: Record<string, unknown> | null = null;
  let report: Record<string, unknown> | null = null;
  try {
    manifest = JSON.parse(bodies.finalManifest.toString("utf-8")) as Record<string, unknown>;
    require("final_manifest_content_address", requirement.parentEvidence.finalManifest.file === `paid-pass-manifest-${requirement.parentEvidence.finalManifest.sha256.slice(7)}.json`);
    require("final_manifest_campaign", manifest.campaignId === requirement.parentEvidence.campaignId);
    require("final_manifest_stage", manifest.stageId === requirement.parentEvidence.stageId);
    const records = Array.isArray(manifest.records) ? manifest.records as Array<Record<string, unknown>> : [];
    const ref = records.find((item) => item.runId === requirement.runId);
    require("final_manifest_run_ref", ref?.file === requirement.parentEvidence.runRecord.file && ref?.sha256 === requirement.parentEvidence.runRecord.sha256);
  } catch {
    reasons.push("final_manifest_parse");
  }
  try {
    record = JSON.parse(bodies.runRecord.toString("utf-8")) as Record<string, unknown>;
    const status = record.status as Record<string, unknown> | undefined;
    const verdict = record.paidVerdict as Record<string, unknown> | undefined;
    const raw = record.rawResponse as Record<string, unknown> | undefined;
    const choices = Array.isArray(raw?.choices) ? raw.choices as Array<Record<string, unknown>> : [];
    const attempt = Array.isArray(record.attempts) ? record.attempts[0] as Record<string, unknown> | undefined : undefined;
    const finish = attempt?.finishReasonMapping as Record<string, unknown> | undefined;
    const provenance = attempt?.generationProvenance as Record<string, unknown> | undefined;
    require("run_identity", record.runId === requirement.runId && record.campaignId === requirement.parentEvidence.campaignId);
    require("run_target", record.requestedSlug === requirement.target && record.resolvedSlug === requirement.target && target.slug === requirement.target);
    require("run_benchmark", record.benchmarkId === requirement.benchmark && record.sentinel === true);
    require("run_no_substitution", record.substitutionUsed === false && record.fallbackUsed === false);
    require("run_status", status?.qualification === "pass" && Array.isArray(status.failureReasons) && status.failureReasons.length === 0);
    require("run_paid_integrity", verdict?.ok === true && verdict.responseQualified === true && Array.isArray(verdict.validationReasons) && verdict.validationReasons.length === 0);
    require("run_finish", choices[0]?.finish_reason === "stop" && finish?.canonical === "stop" && finish?.accepted === true);
    require("run_generation", raw?.id === requirement.generationId && provenance?.generationId === requirement.generationId);
    require("run_model", raw?.model === target.responseModelId && provenance?.requestedSlug === target.slug && provenance?.responseModelId === target.responseModelId);
    require("run_provider", raw?.provider === target.providerDisplay);
    require("run_cost", record.billedCostUsd === requirement.settledCostUsd && provenance?.actualCostUsd === requirement.settledCostUsd);
  } catch {
    reasons.push("run_record_parse");
  }
  try {
    report = JSON.parse(bodies.verifyReport.toString("utf-8")) as Record<string, unknown>;
    const summary = report.summary as Record<string, unknown> | undefined;
    const coverage = summary?.costCoverage as Record<string, unknown> | undefined;
    require("verify_report_ok", report.ok === true && Array.isArray(report.reasons) && report.reasons.length === 0);
    require("verify_report_manifest", report.manifestFile === requirement.parentEvidence.finalManifest.file);
    require("verify_report_identity", summary?.campaignId === requirement.parentEvidence.campaignId && summary?.stageId === requirement.parentEvidence.stageId);
    require("verify_report_settled", Array.isArray(coverage?.settledRunIds) && coverage.settledRunIds.includes(requirement.runId));
  } catch {
    reasons.push("verify_report_parse");
  }
  try {
    const lines = bodies.gateILedger.toString("utf-8").trimEnd().split("\n");
    const header = lines.shift()?.replace(/\r$/, "").split(",") ?? [];
    if (header.some((field) => field.includes('"')) || new Set(header).size !== header.length) throw new Error("ledger header");
    const currentHeader = [
      "order_index", "run_id", "requested_model", "response_model", "benchmark_id", "sentinel", "response_created_utc",
      "response_generation_id", "response_provider", "response_http_status", "lookup_generation_id", "lookup_provider", "lookup_model",
      "cost_state", "settled_cost_usd", "status", "finish_reason", "validation_reasons", "cost_poll_count", "cost_lookup_final_ok",
    ];
    const legacyH2Header = [
      "order_index", "run_id", "model", "benchmark_id", "sentinel", "response_created_utc", "openrouter_generation_id", "provider",
      "lookup_model", "settled_cost_usd", "status", "finish_reason",
    ];
    const hasExactHeader = (expected: string[]): boolean =>
      header.length === expected.length && header.every((field, index) => field === expected[index]);
    const schema = hasExactHeader(currentHeader) ? "current" : hasExactHeader(legacyH2Header) ? "legacy-h2" : null;
    if (schema == null) throw new Error("unsupported ledger schema");
    const rows = lines.map((line) => line.replace(/\r$/, "").split(","));
    if (rows.some((row) => row.length !== header.length || row.some((field) => field.includes('"')))) throw new Error("ledger row");
    const entries = rows.map((row) => Object.fromEntries(header.map((key, index) => [key, row[index]])));
    const matches = entries.filter((entry) => entry.run_id === requirement.runId);
    require("gate_i_unique_run", matches.length === 1);
    const entry = matches[0];
    if (schema === "current") {
      require("gate_i_identity", entry?.requested_model === target.slug && entry?.response_model === target.responseModelId && entry?.lookup_model === target.lookupModelId && entry?.benchmark_id === requirement.benchmark && entry?.sentinel === "true");
      require("gate_i_generation", entry?.response_generation_id === requirement.generationId && entry?.lookup_generation_id === requirement.generationId);
      require("gate_i_provider", entry?.response_provider === target.providerDisplay && entry?.lookup_provider === target.providerDisplay);
      require("gate_i_settled", entry?.cost_state === "settled" && Number(entry?.settled_cost_usd) === requirement.settledCostUsd);
      require("gate_i_verdict", entry?.status === "pass" && entry?.finish_reason === "stop" && entry?.validation_reasons === "" && entry?.cost_lookup_final_ok === "true");
    } else {
      // H2's pinned Gate I extractor predates the expanded route columns. Its
      // exact schema still binds the requested model, lookup model, generation,
      // provider, settled cost, and clean pass verdict needed for re-derivation.
      require("gate_i_identity", entry?.model === target.slug && entry?.lookup_model === target.lookupModelId && entry?.benchmark_id === requirement.benchmark && entry?.sentinel === "true");
      require("gate_i_generation", entry?.openrouter_generation_id === requirement.generationId);
      require("gate_i_provider", entry?.provider === target.providerDisplay);
      require("gate_i_settled", Number(entry?.settled_cost_usd) === requirement.settledCostUsd);
      require("gate_i_verdict", entry?.status === "pass" && entry?.finish_reason === "stop");
    }
  } catch {
    reasons.push("gate_i_ledger_parse");
  }
  return { ok: reasons.length === 0, reasons };
}

/** Compatibility name for the original four-target Candidate Pass. */
export const buildCandidatePaidCells = buildPerModelPaidCells;

/** The cells and pass definition for a given mode. */
export function paidPassFor(mode: PaidPassDefinition["mode"]): { pass: PaidPassDefinition; cells: PaidCell[] } {
  if (mode === "diagnostic-hosted-paid-r1") return { pass: HOSTED_PAID_PASS, cells: buildHostedPaidCells(HOSTED_PAID_TARGETS) };
  if (mode === "diagnostic-candidate-paid-r1") return { pass: CANDIDATE_PAID_PASS, cells: buildCandidatePaidCells(CANDIDATE_PAID_TARGETS) };
  if (mode === "diagnostic-broad-paid-r1") throw new Error("broad paid mode requires a signed campaign policy");
  if (mode === "diagnostic-selective-paid-r1") throw new Error("selective paid mode requires a signed campaign policy");
  if (mode === "diagnostic-selective-paid-r2") throw new Error("bounded selective paid mode requires a signed campaign policy");
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
  /** Canonical request slug represented by this catalog entry. */
  id: string;
  /** Public catalog id that resolved to id through canonical_slug. */
  catalogModelId: string;
  canonicalSlug: string;
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

function decimalFraction(value: number | string): { numerator: bigint; denominator: bigint } | null {
  const text = typeof value === "number" ? value.toString() : value;
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  let numerator = sign * BigInt(`${match[2]}${fraction}`);
  const scale = fraction.length - exponent;
  if (scale < 0) numerator *= 10n ** BigInt(-scale);
  return { numerator, denominator: scale > 0 ? 10n ** BigInt(scale) : 1n };
}

/** Compare a catalog per-token decimal with a policy per-million-token ceiling exactly. */
function exceedsPerMillionCeiling(catalogPerToken: number | string, policyPerMillion: number): boolean | null {
  const catalog = decimalFraction(catalogPerToken);
  const ceiling = decimalFraction(policyPerMillion);
  if (!catalog || !ceiling || catalog.numerator < 0n || ceiling.numerator < 0n) return null;
  return catalog.numerator * 1_000_000n * ceiling.denominator >
    ceiling.numerator * catalog.denominator;
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
  if (model.catalogModelId !== target.catalogModelId) reasons.push(`catalog_model_id_mismatch:${model.catalogModelId}`);
  if (model.canonicalSlug !== target.slug) reasons.push(`canonical_slug_mismatch:${model.canonicalSlug}`);
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
  else if (ep.providerName !== target.providerDisplay) reasons.push(`provider_display_name_mismatch:${ep.providerName}`);

  const promptPerToken = toPerToken(ep.pricing.prompt);
  const completionPerToken = toPerToken(ep.pricing.completion);
  if (promptPerToken == null || completionPerToken == null) {
    reasons.push("price_unknown");
  } else {
    const promptOver = exceedsPerMillionCeiling(ep.pricing.prompt!, target.priceCeiling.inputPerMTokens);
    const completionOver = exceedsPerMillionCeiling(ep.pricing.completion!, target.priceCeiling.outputPerMTokens);
    if (promptOver == null || completionOver == null) reasons.push("price_decimal_invalid");
    else {
      if (promptOver) reasons.push("price_over_input_ceiling");
      if (completionOver) reasons.push("price_over_output_ceiling");
    }
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
  /** Exact model identity OpenRouter must report for this canonical request. */
  responseModelId: string;
  /** Exact model identity the generation cost lookup must report. */
  lookupModelId: string;
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
 *   - response: model equals the policy-pinned response identity, generation id present;
 *   - provider provenance: the response provider AND the independent cost-lookup
 *     provider BOTH equal the fixed catalog display name exactly (a "close but
 *     different" provider such as Azure on a DeepInfra route fails);
 *   - lookup identity: model equals the independently policy-pinned lookup identity,
 *     while the generation id agrees with the response (a missing lookup is a failure).
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
  if (observed.responseModelId !== expected.responseModelId) reasons.push(`response_model_mismatch:${String(observed.responseModelId)}`);
  if (observed.responseGenerationId == null || observed.responseGenerationId.length === 0) reasons.push("response_generation_id_missing");

  // Provider provenance — EXACT display match on both the response and the lookup.
  if (observed.responseProvider == null || observed.responseProvider.length === 0) reasons.push("response_provider_missing");
  else if (observed.responseProvider !== expected.providerDisplay) reasons.push(`response_provider_mismatch:${observed.responseProvider}`);
  if (observed.lookupProvider == null || observed.lookupProvider.length === 0) reasons.push("lookup_provider_missing");
  else if (observed.lookupProvider !== expected.providerDisplay) reasons.push(`lookup_provider_mismatch:${observed.lookupProvider}`);

  // Independent cost-lookup model identity is REQUIRED and policy-pinned separately.
  if (observed.lookupModelId == null || observed.lookupModelId.length === 0) reasons.push("lookup_model_missing");
  else if (observed.lookupModelId !== expected.lookupModelId) reasons.push(`lookup_model_mismatch:${observed.lookupModelId}`);
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
  /** Durable classification when response headers arrived but the body did not. */
  responseBodyError: ResponseBodyReadError | null;
  costLookup: CostLookupWireEvidence | null;
}

export interface ResponseBodyReadError {
  kind: "timeout" | "read_error";
  message: string;
  timeoutMs: number;
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
  const responseBodyError = raw.responseBodyError;
  if (responseBodyError !== null) {
    if (!exactObjectKeys(responseBodyError, ["kind", "message", "timeoutMs"]) ||
      (responseBodyError.kind !== "timeout" && responseBodyError.kind !== "read_error") ||
      typeof responseBodyError.message !== "string" || responseBodyError.message.length === 0 || responseBodyError.message.length > 256 ||
      /[^\x20-\x7e]/.test(responseBodyError.message) || !Number.isSafeInteger(responseBodyError.timeoutMs) || responseBodyError.timeoutMs <= 0) {
      reasons.push("response_body_error_invalid");
    } else {
      reasons.push(`response_body_${responseBodyError.kind}`);
    }
    if (raw.responseBody !== null) reasons.push("response_body_error_with_preimage");
  }
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
  /** Detached-signature campaign policy bytes retained and verified by launcher. */
  campaignPolicy: PaidManifestRef | null;
  campaignPolicySignature: PaidManifestRef | null;
  parentInputs: PaidManifestRef[];
  catalogArtifact: PaidManifestRef | null;
  rawObservations: PaidManifestRef[];
  records: PaidManifestRef[];
  wires: PaidManifestRef[];
  intents: PaidManifestRef[];
  summary: PaidManifestRef;
}

/** Full signing-subkey fingerprint pinned by the Paid Pass v3 execution manifest. */
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
  /** Policy-derived parent cardinality. Legacy policy-v2 defaults to three. */
  expectedParentInputCount?: number;
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
 *  - a parent-input count different from the policy-derived expectation;
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
  check("campaign_policy", manifest.campaignPolicy, true);
  check("campaign_policy_signature", manifest.campaignPolicySignature, true);
  const expectedParentInputCount = opts.expectedParentInputCount ?? PAID_PARENT_INPUT_COUNT;
  if ((manifest.parentInputs ?? []).length !== expectedParentInputCount) reasons.push(`parent_input_count:${(manifest.parentInputs ?? []).length}`);
  checkList("parent_input", manifest.parentInputs, expectedParentInputCount > 0);
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
  if (typeof a.campaignPolicyId !== "string" || a.campaignPolicyId.length === 0) reasons.push("attestation_campaign_policy_id_missing");
  if (typeof a.campaignPolicySha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(a.campaignPolicySha256)) reasons.push("attestation_campaign_policy_digest_missing");
  if (typeof a.campaignPolicySignatureSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(a.campaignPolicySignatureSha256)) reasons.push("attestation_campaign_policy_signature_digest_missing");
  if (a.campaignPolicySignerFingerprint !== PAID_CAMPAIGN_POLICY_SIGNER) reasons.push("attestation_campaign_policy_signer_unpinned");
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
