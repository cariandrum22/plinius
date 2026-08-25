/**
 * Diagnostic-continuation planning — pure, offline helpers (Stage C1).
 *
 * WHY THIS MODULE EXISTS (recorded before it was added, per the Stage C1
 * directive's Allowed-Source-Changes rule): the continuation mode needs
 * non-trivial, independently testable logic that has nothing to do with the
 * live campaign driver — re-deriving and validating the frozen 24-cell order,
 * separating the historical fixed failure (index 0) from the 23 continuation
 * cells, classifying resume/interruption state from on-disk journal + record
 * evidence, deciding whether the OpenAI sentinel is acceptable, and computing
 * the continuation summary accounting. Keeping it here (src/continuation/, the
 * only new path the directive permits) makes every rule a pure function that the
 * offline tests exercise directly, with no network, no clock, and no filesystem.
 *
 * This module performs NO I/O. It never imports the driver (that would break the
 * tsc rootDir), so records read from disk are typed structurally. It does import
 * the pure raw-response hasher so a resume-skip can RE-DERIVE an attempt's digest
 * and byte length from the stored body (a tampered digest is never trusted); that
 * helper performs no I/O either.
 */
import type { RunStatuses } from "../completeness/status.js";
import { classifyRun } from "../completeness/status.js";
import { hashRawResponse } from "../completeness/assets.js";
import { normalizeCompletion } from "../completeness/normalize.js";
import type { NormalizedCompletion } from "../completeness/normalize.js";
import { mapFinishReason, finishReasonTable } from "../completeness/finish-reason.js";
import type { FinishReasonMapping, CanonicalFinishReason } from "../completeness/finish-reason.js";
import { verifyWireBody, reDeriveResponseIdentity, reDeriveRequestIdentity, verifyCostLookupChain, parseWireJson } from "./wire.js";
import type { AttemptWireEvidence } from "./wire.js";

/** The output half of one attempt: every normalized field, verbatim (shared shape). */
export interface AttemptOutput {
  text: string | null;
  finishReason: string | null;
  reasoningText: string | null;
  reasoningSource: string;
  finalAnswer: string | null;
  finalAnswerSource: string;
  finalAnswerIsEmpty: boolean;
  reasoningOnly: boolean;
  normalizerError: string | null;
}

/**
 * The COMMON pure derivation of a received response's headline (C1-R6-F02): given the
 * raw response object (parsed from the response wire bytes), reconstruct the text,
 * finish reason, normalized output, finish-reason mapping/table, run status (with no
 * transport failure) and the response identity — the SAME derivation the driver uses
 * when it first writes the record and the resume path uses to re-derive it, so a
 * persisted output / finish / status / validation that contradicts the wire is
 * rejected. The text is extracted from the raw exactly as an OpenAI-compatible backend
 * does (choices[0].message.content), so the wire is the single source of truth.
 */
export interface WireResponseOutcome {
  text: string | null;
  rawFinish: string | null;
  output: AttemptOutput;
  finishReasonMapping: FinishReasonMapping;
  finishReasonTable: Record<string, CanonicalFinishReason>;
  status: RunStatuses;
  responseModelId: string | null;
  responseGenerationId: string | null;
  responseProvider: string | null;
}

export function deriveResponseOutcome(raw: unknown): WireResponseOutcome {
  const rawObj = (raw ?? null) as Record<string, unknown> | null;
  const choices = Array.isArray(rawObj?.choices) ? (rawObj!.choices as Array<Record<string, unknown>>) : [];
  const first = (choices[0] ?? {}) as { finish_reason?: unknown; message?: { content?: unknown } };
  const rawFinish = typeof first.finish_reason === "string" ? first.finish_reason : null;
  const text = typeof first.message?.content === "string" ? (first.message.content as string) : null;
  const normalized: NormalizedCompletion = normalizeCompletion({ rawResponse: raw, text });
  const finish = mapFinishReason(rawFinish);
  const status = classifyRun({ transportError: null, normalized, finishReason: finish });
  return {
    text,
    rawFinish,
    output: {
      text,
      finishReason: rawFinish,
      reasoningText: normalized.reasoningText ?? null,
      reasoningSource: normalized.reasoningSource ?? "none",
      finalAnswer: normalized.finalAnswer ?? null,
      finalAnswerSource: normalized.finalAnswerSource ?? "none",
      finalAnswerIsEmpty: normalized.finalAnswerIsEmpty ?? true,
      reasoningOnly: normalized.reasoningOnly ?? false,
      normalizerError: normalized.normalizerError ?? null,
    },
    finishReasonMapping: finish,
    finishReasonTable: finishReasonTable(),
    status,
    responseModelId: typeof rawObj?.model === "string" ? (rawObj.model as string) : null,
    responseGenerationId: typeof rawObj?.id === "string" ? (rawObj.id as string) : null,
    responseProvider: typeof rawObj?.provider === "string" ? (rawObj.provider as string) : null,
  };
}

/**
 * Continuation-extension schema version (C1-R4-F02). The base run record keeps
 * schemaVersion 2; the wire-preimage extension is versioned SEPARATELY so its shape
 * change is never silent. Version 2 is the byte-preserving preimage era (r4 stored
 * wire digests only — the implicit v1); a resume requires this exact version so an
 * older, preimage-less record is not mistaken for complete.
 */
export const CONTINUATION_EXTENSION_SCHEMA_VERSION = 3;

/** One matrix cell in the frozen execution order. */
export interface Cell {
  target: string;
  benchmark: string;
  sentinel: boolean;
}

/** The historical, already-executed sentinel — index 0, never re-dispatched. */
export const EXPECTED_HISTORICAL_CELL = {
  target: "anthropic/claude-opus-5",
  benchmark: "sec-oidc-id-token-validation-001",
} as const;

/** The first continuation dispatch — index 1, the OpenAI Security sentinel. */
export const EXPECTED_FIRST_CONTINUATION_CELL = {
  target: "openai/gpt-5.6-sol-pro",
  benchmark: "sec-oidc-id-token-validation-001",
} as const;

export const REQUIRED_ORIGINAL = 24;
export const HISTORICAL_FIXED = 1;
export const REQUIRED_CONTINUATION = 23;

/**
 * Terminal status when all 23 continuation cells finish but the retained
 * historical Anthropic provider-policy failure keeps the campaign from passing.
 */
export const DIAGNOSTIC_COMPLETE_WITH_PROVIDER_POLICY_FAILURE =
  "diagnostic_complete_with_provider_policy_failure";

/**
 * Validate that `order` is exactly the frozen 24-cell order, with the historical
 * Anthropic cell at index 0 and the OpenAI Security sentinel at index 1, both
 * flagged as sentinels. Throws on any deviation — the continuation must not run
 * against a reshaped order.
 */
export function validateFrozenOrder(order: Cell[]): void {
  if (order.length !== REQUIRED_ORIGINAL) {
    throw new Error(`frozen order must have ${REQUIRED_ORIGINAL} cells, got ${order.length}`);
  }
  const c0 = order[0];
  if (
    c0.target !== EXPECTED_HISTORICAL_CELL.target ||
    c0.benchmark !== EXPECTED_HISTORICAL_CELL.benchmark ||
    c0.sentinel !== true
  ) {
    throw new Error(
      `index 0 must be the historical sentinel ${EXPECTED_HISTORICAL_CELL.target} x ` +
        `${EXPECTED_HISTORICAL_CELL.benchmark}, got ${c0.target} x ${c0.benchmark} (sentinel=${c0.sentinel})`,
    );
  }
  const c1 = order[1];
  if (
    c1.target !== EXPECTED_FIRST_CONTINUATION_CELL.target ||
    c1.benchmark !== EXPECTED_FIRST_CONTINUATION_CELL.benchmark ||
    c1.sentinel !== true
  ) {
    throw new Error(
      `index 1 must be the OpenAI sentinel ${EXPECTED_FIRST_CONTINUATION_CELL.target} x ` +
        `${EXPECTED_FIRST_CONTINUATION_CELL.benchmark}, got ${c1.target} x ${c1.benchmark} (sentinel=${c1.sentinel})`,
    );
  }
}

/** The historical fixed failure plus the strict 23-cell continuation slice. */
export interface ContinuationPlan {
  historicalFixed: Cell;
  continuation: Cell[];
}

/**
 * Split the frozen order into the historical fixed failure (index 0, referenced
 * only) and the 23 continuation cells (`order.slice(1)`). Validates first.
 */
export function deriveContinuationPlan(order: Cell[]): ContinuationPlan {
  validateFrozenOrder(order);
  const continuation = order.slice(1);
  if (continuation.length !== REQUIRED_CONTINUATION) {
    throw new Error(`continuation slice must be ${REQUIRED_CONTINUATION} cells, got ${continuation.length}`);
  }
  return { historicalFixed: order[0], continuation };
}

/** Structural view of a persisted run record read back from disk. */
export interface PersistedRecordShape {
  schemaVersion?: number;
  runId?: string;
  campaignId?: string;
  orderIndex?: number;
  sentinel?: boolean;
  benchmarkId?: string;
  benchmarkVersion?: string;
  benchmarkContentHash?: string;
  requestedSlug?: string;
  resolvedSlug?: string;
  backend?: string;
  endpoint?: string;
  substitutionUsed?: boolean;
  fallbackUsed?: boolean;
  promptSnapshot?: { promptId?: string } | null;
  sampling?: { maxTokens?: number } & Record<string, unknown>;
  rawResponse?: unknown;
  rawResponseSha256?: string | null;
  rawResponseBytes?: number | null;
  output?: Record<string, unknown>;
  finishReasonMapping?: unknown;
  finishReasonTable?: unknown;
  metrics?: { latencyMs?: number; usage?: unknown };
  error?: { kind: string; message: string } | null;
  cost?: { costModel?: string; actualCostUsd?: number | null } | null;
  routing?: Record<string, unknown> | null;
  generationProvenance?: { generationId?: string | null } | null;
  executionProvenance?: { requestId?: string | null } | null;
  status?: RunStatuses;
  attemptCount?: number;
  attempts?: Array<Record<string, unknown>>;
  /** Live resolution + request/response drift result — required on a continuation record. */
  continuationValidation?: { ok?: boolean; reasons?: string[] } | null;
  /** Response identity, recorded apart from the requested slug — required (may be null on transport failure). */
  responseModelId?: string | null;
  responseGenerationId?: string | null;
  responseProvider?: string | null;
  /** Digest / byte length of the request body ACTUALLY transmitted at the fetch boundary. */
  requestWireSha256?: string | null;
  requestWireBytes?: number | null;
  /** Digest / byte length of the raw RESPONSE body captured byte-identical (F02/F03). */
  responseWireSha256?: string | null;
  responseWireBytes?: number | null;
  responseProviderHeader?: string | null;
  costLookupWireSha256?: string | null;
  costLookupWireBytes?: number | null;
  /** Continuation-extension schema version — required on an r5 record (F02). */
  continuationExtensionSchemaVersion?: number;
  /** Byte-preserving wire evidence (request/response/cost-lookup preimages) — required (F02). */
  wire?: AttemptWireEvidence | null;
  /** Reference to the immutable catalog-preflight artifact this record was dispatched under — required. */
  catalogArtifactRef?: { file?: string; sha256?: string } | null;
  /** For a LOCAL (vLLM) record: reference to the verified local-runtime preflight artifact (F03). */
  localRuntimeArtifactRef?: { file?: string; sha256?: string } | null;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
function isDigest(v: unknown): boolean {
  return typeof v === "string" && DIGEST_RE.test(v);
}
function costKnown(cost: PersistedRecordShape["cost"]): boolean {
  return cost != null && (cost.costModel === "FREE" || (cost.actualCostUsd !== null && cost.actualCostUsd !== undefined));
}
function provenancePresent(r: { generationProvenance?: { generationId?: string | null } | null; executionProvenance?: { requestId?: string | null } | null }): boolean {
  return (
    r.generationProvenance != null &&
    r.generationProvenance.generationId != null &&
    r.executionProvenance != null &&
    r.executionProvenance.requestId != null
  );
}
function attemptCostKnown(at: Record<string, unknown>): boolean {
  const c = at.cost as { costModel?: string; actualCostUsd?: number | null } | null | undefined;
  return c != null && (c.costModel === "FREE" || (c.actualCostUsd !== null && c.actualCostUsd !== undefined));
}
function attemptProvenancePresent(at: Record<string, unknown>): boolean {
  const g = at.generationProvenance as { generationId?: string | null } | null | undefined;
  const e = at.executionProvenance as { requestId?: string | null } | null | undefined;
  return g?.generationId != null && e?.requestId != null;
}

const ATTEMPT_REQUIRED = [
  "attemptIndex",
  "timestamp",
  "status",
  "output",
  "rawResponse",
  "rawResponseSha256",
  "rawResponseBytes",
  "finishReasonMapping",
  "finishReasonTable",
  "metrics",
  "cost",
  "routing",
  "generationProvenance",
  "executionProvenance",
  "error",
] as const;
const OUTPUT_REQUIRED = [
  "text",
  "finishReason",
  "reasoningText",
  "reasoningSource",
  "finalAnswer",
  "finalAnswerSource",
  "finalAnswerIsEmpty",
  "reasoningOnly",
  "normalizerError",
] as const;
const STATUS_REQUIRED = ["transport", "response", "finalCompleteness", "qualification", "failureReasons"] as const;

function validateAttempt(a: unknown, i: number): string[] {
  const reasons: string[] = [];
  if (a == null || typeof a !== "object") return [`attempt ${i} not an object`];
  const at = a as Record<string, unknown>;
  for (const f of ATTEMPT_REQUIRED) {
    if (!(f in at) || at[f] === undefined) reasons.push(`attempt ${i} missing ${f}`);
  }
  const status = at.status as Record<string, unknown> | undefined;
  if (status && typeof status === "object") {
    for (const s of STATUS_REQUIRED) if (!(s in status)) reasons.push(`attempt ${i} status missing ${s}`);
  }
  const output = at.output as Record<string, unknown> | undefined;
  if (output && typeof output === "object") {
    for (const o of OUTPUT_REQUIRED) if (!(o in output)) reasons.push(`attempt ${i} output missing ${o}`);
  }
  // Every attempt must carry wire evidence (F02) — a record with no wire fields is
  // never complete. A transport failure has no response body, but the evidence
  // object (with the request it tried and a null response body) must still exist.
  const wire = at.wire as AttemptWireEvidence | null | undefined;
  const wireOk = wire != null && typeof wire === "object" && wire.response != null && wire.request != null;
  if (!wireOk) reasons.push(`attempt ${i} wire evidence missing`);
  const transportFailed = at.error != null || (status && status.transport === "failed");
  // A NON-transport attempt — whether or not it got a usable response — must record
  // WHAT it actually sent: the request URL, method and canonical byte-preserving
  // preimage (C1-R5-F02). A transport failure that never opened the socket may lack
  // a body, but a received-response attempt must have the full request evidence.
  if (!transportFailed && wireOk) {
    const req = wire!.request;
    if (req.url == null || req.method == null) reasons.push(`attempt ${i} request wire url/method missing`);
    const qb = verifyWireBody(req.body);
    if (!qb.ok) reasons.push(`attempt ${i} request wire preimage ${qb.reason}`);
  }
  if (transportFailed) {
    if (at.error == null) reasons.push(`attempt ${i} transport failed but error null`);
    if (at.rawResponse != null) reasons.push(`attempt ${i} transport failed but rawResponse present`);
  } else {
    if (at.rawResponse == null) reasons.push(`attempt ${i} response received but rawResponse null`);
    if (!isDigest(at.rawResponseSha256)) reasons.push(`attempt ${i} missing/invalid rawResponseSha256`);
    if (typeof at.rawResponseBytes !== "number") reasons.push(`attempt ${i} missing rawResponseBytes`);
    // RE-DERIVE the digest and byte length from the stored body: a tampered
    // digest or byte length (Authority attempt-forgery case) is not complete.
    if (at.rawResponse != null && isDigest(at.rawResponseSha256)) {
      const h = hashRawResponse(at.rawResponse);
      if (h.sha256 !== at.rawResponseSha256) reasons.push(`attempt ${i} rawResponseSha256 does not match stored body`);
      if (typeof at.rawResponseBytes === "number" && h.byteLength !== at.rawResponseBytes)
        reasons.push(`attempt ${i} rawResponseBytes does not match stored body`);
    }
    // F02: the byte-preserving RESPONSE preimage must be present with its status /
    // receipt time, and its digest / byte length must recompute from the canonical
    // stored base64 (a received response with no preimage, or a tampered one, is not
    // complete).
    if (wireOk) {
      const resp = wire!.response;
      if (resp.httpStatus == null || resp.receivedAtUtc == null) reasons.push(`attempt ${i} response wire status/receipt missing`);
      const rb = verifyWireBody(resp.body);
      if (!rb.ok) reasons.push(`attempt ${i} response wire preimage ${rb.reason}`);
      // Every cost-lookup poll (not just the final one) must be self-consistent when
      // a chain was recorded (C1-R5-F02).
      if (wire!.costLookup != null) {
        const chain = verifyCostLookupChain(wire!.costLookup);
        if (!chain.ok) reasons.push(`attempt ${i} cost-lookup ${chain.reason}`);
      }
    }
    // A response-received attempt must carry billed cost and full provenance.
    if (!attemptCostKnown(at)) reasons.push(`attempt ${i} cost missing`);
    if (!attemptProvenancePresent(at)) reasons.push(`attempt ${i} provenance missing`);
  }
  return reasons;
}

export interface CompletenessResult {
  complete: boolean;
  reasons: string[];
}

/**
 * Full schema-v2 completeness check for a persisted record — the resume-skip
 * gate. Every required top-level and per-attempt field must be present; a
 * transport failure must still be a fully-formed attempt (an `attempts: [{}]`
 * shell is NOT complete); a response-received outcome must carry raw payload +
 * digest + byte length, billed cost and generation/execution provenance.
 */
export function validateRecordComplete(r: PersistedRecordShape | null | undefined): CompletenessResult {
  const reasons: string[] = [];
  if (!r) return { complete: false, reasons: ["null record"] };
  if (r.schemaVersion !== 2) reasons.push("schemaVersion!=2");
  if (r.continuationExtensionSchemaVersion !== CONTINUATION_EXTENSION_SCHEMA_VERSION)
    reasons.push("continuationExtensionSchemaVersion mismatch");
  const topRequired = [
    "runId",
    "campaignId",
    "orderIndex",
    "benchmarkId",
    "requestedSlug",
    "resolvedSlug",
    "backend",
    "endpoint",
    "output",
    "status",
    "finishReasonMapping",
    "metrics",
    "cost",
    "routing",
    "generationProvenance",
    "executionProvenance",
    "attemptCount",
  ] as const;
  for (const f of topRequired) {
    if ((r as Record<string, unknown>)[f] === undefined) reasons.push(`missing ${f}`);
  }
  if (!Array.isArray(r.attempts) || r.attempts.length === 0) {
    reasons.push("no attempts");
    return { complete: false, reasons };
  }
  if (r.attemptCount !== r.attempts.length) reasons.push("attemptCount != attempts.length");
  r.attempts.forEach((a, i) => reasons.push(...validateAttempt(a, i)));

  // Continuation-specific required fields: the validation verdict, the response
  // identity (recorded apart from the requested slug), and the catalog artifact
  // reference must all be present and well-shaped.
  const cv = r.continuationValidation;
  if (cv == null || typeof cv !== "object" || typeof (cv as { ok?: unknown }).ok !== "boolean")
    reasons.push("continuationValidation missing/invalid");
  if (!("responseModelId" in (r as object))) reasons.push("responseModelId missing");
  const ref = r.catalogArtifactRef;
  if (ref == null || typeof (ref as { file?: unknown }).file !== "string" || typeof (ref as { sha256?: unknown }).sha256 !== "string")
    reasons.push("catalogArtifactRef missing/invalid");

  // The headline MUST byte/structurally equal the final attempt — a record whose
  // top-level output/digest/cost/provenance disagrees with the attempt it claims
  // to summarize (Authority headline-forgery case) is not complete.
  const last = r.attempts[r.attempts.length - 1] as Record<string, unknown>;
  const rr = r as unknown as Record<string, unknown>;
  const HEADLINE = [
    "output",
    "rawResponse",
    "rawResponseSha256",
    "rawResponseBytes",
    "finishReasonMapping",
    "metrics",
    "cost",
    "routing",
    "generationProvenance",
    "executionProvenance",
    "error",
    "status",
    "wire",
  ];
  for (const f of HEADLINE) {
    if (!deepEqual(rr[f], last[f])) reasons.push(`headline ${f} != final attempt`);
  }

  const transportFailed = r.status?.transport === "failed" || r.error != null;
  if (transportFailed) {
    if (r.error == null) reasons.push("transport failed but error null");
    if (r.rawResponse != null) reasons.push("transport failed but rawResponse present");
  } else {
    if (r.rawResponse == null) reasons.push("response received but rawResponse null");
    if (!isDigest(r.rawResponseSha256)) reasons.push("missing/invalid rawResponseSha256");
    if (typeof r.rawResponseBytes !== "number") reasons.push("missing rawResponseBytes");
    if (!costKnown(r.cost)) reasons.push("cost missing");
    if (!provenancePresent(r)) reasons.push("provenance missing");
  }
  return { complete: reasons.length === 0, reasons };
}

/** Boolean form of {@link validateRecordComplete}. */
export function isRecordComplete(r: PersistedRecordShape | null | undefined): boolean {
  return validateRecordComplete(r).complete;
}

/**
 * A record that reached a terminal STOP the first time it was written stays a
 * blocker forever: it must never be silently resume-skipped so the run walks past
 * it to later cells. A recorded continuation-validation failure, or a
 * response-received record missing billed cost / provenance, is such a sticky
 * blocker. Returns the stop reason, or null when the record is a clean outcome.
 */
export function recordTerminalBlocker(r: PersistedRecordShape): string | null {
  const cv = r.continuationValidation;
  if (cv != null && cv.ok === false) return "sticky_continuation_validation_failed";
  const transportFailed = r.status?.transport === "failed" || r.error != null;
  if (!transportFailed) {
    if (!costKnown(r.cost)) return "sticky_incomplete_billing_or_provenance";
    if (!provenancePresent(r)) return "sticky_incomplete_billing_or_provenance";
  }
  return null;
}

/** Everything a resume-skip must match against the freshly re-derived plan. */
export interface PlanExpectation {
  campaignId: string;
  runId: string;
  orderIndex: number;
  benchmarkId: string;
  benchmarkVersion: string;
  benchmarkContentHash: string;
  requestedSlug: string;
  resolvedSlug: string;
  backend: string;
  endpoint: string;
  promptId: string;
  sampling: unknown;
  maxTokens: number;
  substitutionUsed: boolean;
  fallbackUsed: boolean;
}

/**
 * Full plan consistency for a resume-skip: campaign, run id, order index,
 * benchmark id/version/content-hash, requested/resolved slug, backend, endpoint,
 * prompt id, sampling, max output, and substitution/fallback must all match the
 * freshly re-derived plan — a run id match alone is not enough.
 */
export function planConsistency(r: PersistedRecordShape, e: PlanExpectation): { consistent: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const eq = (field: string, got: unknown, want: unknown) => {
    if (!deepEqual(got, want)) reasons.push(`${field}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  };
  eq("campaignId", r.campaignId, e.campaignId);
  eq("runId", r.runId, e.runId);
  eq("orderIndex", r.orderIndex, e.orderIndex);
  eq("benchmarkId", r.benchmarkId, e.benchmarkId);
  eq("benchmarkVersion", r.benchmarkVersion, e.benchmarkVersion);
  eq("benchmarkContentHash", r.benchmarkContentHash, e.benchmarkContentHash);
  eq("requestedSlug", r.requestedSlug, e.requestedSlug);
  eq("resolvedSlug", r.resolvedSlug, e.resolvedSlug);
  eq("backend", r.backend, e.backend);
  eq("endpoint", r.endpoint, e.endpoint);
  eq("promptId", r.promptSnapshot?.promptId, e.promptId);
  eq("sampling", r.sampling, e.sampling);
  eq("maxTokens", r.sampling?.maxTokens, e.maxTokens);
  eq("substitutionUsed", r.substitutionUsed ?? false, e.substitutionUsed);
  eq("fallbackUsed", r.fallbackUsed ?? false, e.fallbackUsed);
  return { consistent: reasons.length === 0, reasons };
}

/** Live resolution + request/response drift check (recorded, never thrown). */
export interface ContinuationValidation {
  ok: boolean;
  reasons: string[];
  expected: { requestedSlug: string; resolvedSlug: string; maxTokens: number; sampling: unknown };
  observed: {
    requestModel: string;
    requestMaxTokens: number;
    requestSampling: unknown;
    responseModelId: string | null;
    responseReceived: boolean;
    resolvedSlug: string;
    resolvedExactly: boolean;
    substitutionUsed: boolean;
    fallbackUsed: boolean;
    /** Provider / routing metadata from the raw payload and the generation lookup. */
    responseProvider?: string | null;
    responseGenerationId?: string | null;
    lookupModelId?: string | null;
    lookupGenerationId?: string | null;
    lookupProvider?: string | null;
    /** true for a hosted (OpenRouter) target; false for a local (vLLM) target. */
    isHosted?: boolean;
  };
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Compare what the plan intended against what was actually resolved and sent.
 * The request body actually transmitted (model, max output, sampling) is checked
 * against the plan; catalog resolution must be exact with no substitution or
 * fallback. Observed values are the real request/resolution — never the plan
 * re-labelled as an observation.
 */
export function computeContinuationValidation(args: {
  expected: { requestedSlug: string; resolvedSlug: string; maxTokens: number; sampling: unknown };
  observed: ContinuationValidation["observed"];
}): ContinuationValidation {
  const { expected: e, observed: o } = args;
  const reasons: string[] = [];
  if (o.requestModel !== e.resolvedSlug) reasons.push(`request model ${o.requestModel} != resolved ${e.resolvedSlug}`);
  if (o.resolvedSlug !== e.resolvedSlug) reasons.push(`resolved slug ${o.resolvedSlug} != expected ${e.resolvedSlug}`);
  if (e.resolvedSlug !== e.requestedSlug) reasons.push(`resolved ${e.resolvedSlug} != requested ${e.requestedSlug}`);
  if (!o.resolvedExactly) reasons.push("resolution not exact");
  if (o.substitutionUsed) reasons.push("substitution used");
  if (o.fallbackUsed) reasons.push("fallback used");
  if (o.requestMaxTokens !== e.maxTokens) reasons.push(`request maxTokens ${o.requestMaxTokens} != ${e.maxTokens}`);
  if (!deepEqual(o.requestSampling, e.sampling)) reasons.push("request sampling drift");
  // Response routing drift: a missing response model id, OR a NON-NULL response
  // model id that is not the exact expected model (wrong model / alias /
  // substituted model — the Authority wrong-model case).
  if (o.responseReceived && o.responseModelId == null) reasons.push("response received without response model id (routing drift)");
  if (o.responseReceived && o.responseModelId != null && o.responseModelId !== e.resolvedSlug)
    reasons.push(`response model ${o.responseModelId} != expected ${e.resolvedSlug} (routing drift)`);
  // The raw payload and the generation lookup must agree on model / generation id
  // / provider — a mismatch means the response was routed somewhere unaccounted.
  if (o.lookupModelId != null && o.responseModelId != null && o.lookupModelId !== o.responseModelId)
    reasons.push(`generation-lookup model ${o.lookupModelId} != response model ${o.responseModelId}`);
  if (o.lookupGenerationId != null && o.responseGenerationId != null && o.lookupGenerationId !== o.responseGenerationId)
    reasons.push(`generation-lookup id ${o.lookupGenerationId} != response generation id ${o.responseGenerationId}`);
  if (o.lookupProvider != null && o.responseProvider != null && o.lookupProvider !== o.responseProvider)
    reasons.push(`generation-lookup provider ${o.lookupProvider} != response provider ${o.responseProvider}`);
  // Hosted provenance (F03): a hosted response received without a transport failure
  // must carry BOTH an independent response provider AND a generation-lookup
  // provider (non-empty) that agree, and a generation id present on both sides — a
  // provider/genId that is null on either side (both null previously passed) is a
  // routing gap, not a pass. A local (vLLM) target is exempt.
  if (o.isHosted === true && o.responseReceived) {
    if (!isNonEmpty(o.responseProvider)) reasons.push("hosted response provider missing");
    if (!isNonEmpty(o.lookupProvider)) reasons.push("hosted generation-lookup provider missing");
    if (!isNonEmpty(o.responseGenerationId)) reasons.push("hosted response generation id missing");
    if (!isNonEmpty(o.lookupGenerationId)) reasons.push("hosted generation-lookup id missing");
    if (!isNonEmpty(o.lookupModelId)) reasons.push("hosted generation-lookup model missing");
  }
  return { ok: reasons.length === 0, reasons, expected: e, observed: o };
}

/**
 * Re-derive the response identity from the record's STORED raw response body and
 * require the stored headline identity AND the freshly re-derived plan to agree
 * (F04). On resume the persisted `continuationValidation` / `responseModelId` /
 * routing are NOT trusted: a record whose `rawResponse.model` is the wrong model
 * is rejected even when its top-level `responseModelId` and `continuationValidation`
 * were both forged to look correct, because this reads the wire body itself. A
 * transport-failed record has no response body to re-derive and passes here.
 */
export function resumeWireConsistency(
  r: PersistedRecordShape,
  expected: { resolvedSlug: string },
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const transportFailed = r.status?.transport === "failed" || r.error != null;
  if (transportFailed) return { ok: true, reasons };
  const raw = r.rawResponse as Record<string, unknown> | null | undefined;
  if (raw == null || typeof raw !== "object") {
    reasons.push("rawResponse missing for a received response");
    return { ok: false, reasons };
  }
  const wireModel = typeof raw.model === "string" ? raw.model : null;
  const wireGenId = typeof raw.id === "string" ? raw.id : null;
  const wireProvider = typeof raw.provider === "string" ? raw.provider : null;
  // Stored headline identity must equal what the wire body actually says.
  if (r.responseModelId != null && wireModel != null && r.responseModelId !== wireModel)
    reasons.push(`stored responseModelId ${r.responseModelId} != wire model ${wireModel}`);
  if (r.responseGenerationId != null && wireGenId != null && r.responseGenerationId !== wireGenId)
    reasons.push(`stored responseGenerationId ${r.responseGenerationId} != wire generation id ${wireGenId}`);
  if (r.responseProvider != null && wireProvider != null && r.responseProvider !== wireProvider)
    reasons.push(`stored responseProvider ${r.responseProvider} != wire provider ${wireProvider}`);
  // The wire model itself must be the exact resolved slug — a wrong-model wire body
  // (the Authority F04 case) is caught regardless of any forged top-level fields.
  if (wireModel == null) reasons.push("wire response model missing");
  else if (wireModel !== expected.resolvedSlug)
    reasons.push(`wire response model ${wireModel} != expected ${expected.resolvedSlug}`);
  return { ok: reasons.length === 0, reasons };
}

/**
 * Resume re-derivation from the STORED WIRE BYTES (C1-R4-F03). On resume neither the
 * parsed rawResponse nor any persisted verdict is trusted as the source of truth:
 * this recomputes the digest and byte length from the stored response preimage,
 * re-parses the request / response / cost-lookup polls, and reconstructs the response
 * identity, provider, cost and routing from those bytes — then requires the persisted
 * headline to deep-equal the re-derived values. A hosted response provider, generation
 * id and model are re-derived INDEPENDENTLY on both the response and the lookup side
 * and must match exactly. A local (vLLM) record must carry a verified local-runtime
 * artifact reference. Any missing wire, digest mismatch, request drift, wrong model,
 * provider mismatch, lookup failure or unknown cost is a (sticky) blocker. A
 * transport-failed record has no response body to re-derive and passes here.
 */
/** The exact request the fresh plan intends — the resume comparison deep-equals against it. */
export interface ExpectedRequestPlan {
  /** The exact chat-completions endpoint URL the plan dispatches to. */
  url: string;
  /** The exact messages the frozen benchmark supplies. */
  messages: unknown;
}

/** The set of request-body keys an OpenAI-compatible dispatch is allowed to send (F02). */
const ALLOWED_REQUEST_KEYS = new Set(["model", "messages", "max_tokens", "temperature", "top_p", "seed"]);

export function resumeReDerive(
  r: PersistedRecordShape,
  expected: { resolvedSlug: string; isHosted: boolean; maxTokens?: number; sampling?: unknown; request?: ExpectedRequestPlan },
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const transportFailed = r.status?.transport === "failed" || r.error != null;
  if (transportFailed) return { ok: true, reasons };

  const wire = r.wire;
  if (wire == null || typeof wire !== "object" || wire.response == null || wire.request == null) {
    reasons.push("wire evidence missing for a received response");
    return { ok: false, reasons };
  }

  // (1) Recompute the response digest + byte length from the stored bytes and require
  // the persisted headline wire digest / length to match.
  const rb = verifyWireBody(wire.response.body);
  if (!rb.ok) {
    reasons.push(`response wire ${rb.reason}`);
    return { ok: false, reasons };
  }
  const respBody = wire.response.body as { sha256: string; bytes: number };
  if (r.responseWireSha256 != null && r.responseWireSha256 !== respBody.sha256)
    reasons.push("persisted responseWireSha256 != response preimage digest");
  if (r.responseWireBytes != null && r.responseWireBytes !== respBody.bytes)
    reasons.push("persisted responseWireBytes != response preimage length");

  // (2) Re-parse the response bytes → identity (never the parsed rawResponse object).
  const id = reDeriveResponseIdentity(wire.response.body);
  if (!id.ok) {
    reasons.push(`response re-derive ${id.reason}`);
    return { ok: false, reasons };
  }
  const { model, generationId, provider, usage } = id.identity;

  // (3) The wire model must be the exact resolved slug (wrong-model routing caught).
  if (model == null) reasons.push("re-derived response model missing");
  else if (model !== expected.resolvedSlug) reasons.push(`re-derived response model ${model} != expected ${expected.resolvedSlug}`);

  // (4) Persisted headline identity/usage must deep-equal the re-derived values — the
  // response wire is the single source of truth for model / generation id / usage, so
  // a headline forged to look correct while the stored bytes disagree (C1-R5-F02) is
  // rejected here. (The finish reason headline is the NORMALIZED mapping, not the raw
  // wire token, so it is re-derived and mapped by the record builder, not compared raw.)
  if (!deepEqual(r.responseModelId ?? null, model ?? null)) reasons.push("persisted responseModelId != re-derived");
  if (!deepEqual(r.responseGenerationId ?? null, generationId ?? null)) reasons.push("persisted responseGenerationId != re-derived");
  const headlineUsage = (r.metrics as { usage?: unknown } | undefined)?.usage ?? null;
  if (usage != null && !deepEqual(headlineUsage, usage)) reasons.push("persisted metrics.usage != re-derived response usage");

  // (4b) FULL headline re-derivation from the wire (C1-R6-F02): the output, finish-reason
  // mapping and run status are re-derived by the SAME pure derivation the driver used,
  // and the persisted values must deep-equal them. A record whose wire says content_filter
  // but whose persisted status claims qualification=pass (or whose output / finish mapping
  // is forged) is rejected here regardless of any other consistent-looking field.
  const wireRaw = parseWireJson(wire.response.body);
  if (wireRaw.ok) {
    const outcome = deriveResponseOutcome(wireRaw.value);
    if (r.output !== undefined && !deepEqual(r.output, outcome.output)) reasons.push("persisted output != re-derived from wire");
    if (r.finishReasonMapping !== undefined && !deepEqual(r.finishReasonMapping, outcome.finishReasonMapping))
      reasons.push("persisted finishReasonMapping != re-derived from wire");
    if (r.status !== undefined && !deepEqual(r.status, outcome.status)) reasons.push("persisted status != re-derived from wire");
    if (r.responseProvider != null && outcome.responseProvider != null && !deepEqual(r.responseProvider, outcome.responseProvider))
      reasons.push("persisted responseProvider != re-derived from wire");
  }

  // (5) Request drift (C1-R6-F02): the request URL must be the fresh plan's EXACT
  // endpoint, the method POST, and the body — parsed from its stored bytes — must
  // deep-equal the fresh request plan on model, messages, max output and sampling,
  // with NO field outside the allowed set. The request wire is REQUIRED.
  if (wire.request.url == null || wire.request.method == null) reasons.push("request wire url/method missing");
  if (expected.request != null && wire.request.url !== expected.request.url)
    reasons.push(`request URL ${wire.request.url} != plan endpoint ${expected.request.url}`);
  if (wire.request.method != null && wire.request.method !== "POST")
    reasons.push(`request method ${wire.request.method} != POST`);
  const rqParsed = parseWireJson(wire.request.body);
  if (!rqParsed.ok) reasons.push(`request wire ${rqParsed.reason}`);
  else {
    const body = (rqParsed.value ?? {}) as Record<string, unknown>;
    // Allowed field set: no smuggled request field.
    for (const k of Object.keys(body)) if (!ALLOWED_REQUEST_KEYS.has(k)) reasons.push(`request body has unexpected field ${k}`);
    const q = reDeriveRequestIdentity(wire.request.body);
    if (!q.ok) reasons.push(`request wire ${q.reason}`);
    else {
      const id = q.identity;
      if (id.model == null) reasons.push("re-derived request model missing");
      else if (id.model !== expected.resolvedSlug) reasons.push(`re-derived request model ${id.model} != expected ${expected.resolvedSlug} (request drift)`);
      if (expected.maxTokens != null && id.maxTokens !== expected.maxTokens)
        reasons.push(`re-derived request maxTokens ${id.maxTokens} != ${expected.maxTokens}`);
      if (expected.sampling !== undefined) {
        const s = (expected.sampling ?? {}) as { temperature?: number | null; topP?: number | null; seed?: number | null };
        if (!deepEqual({ temperature: id.temperature, topP: id.topP, seed: id.seed }, { temperature: s.temperature ?? null, topP: s.topP ?? null, seed: s.seed ?? null }))
          reasons.push("re-derived request sampling drift");
      }
    }
    if (expected.request != null && !deepEqual(body.messages ?? null, expected.request.messages ?? null))
      reasons.push("re-derived request messages != plan messages");
  }

  if (expected.isHosted) {
    // (6) Hosted: re-derive provider / generation id / model / cost from the WHOLE
    // cost-lookup poll chain (every poll, not just the final one — C1-R5-F02) and
    // require exact agreement with the response.
    const chain = verifyCostLookupChain(wire.costLookup);
    if (!chain.ok) {
      reasons.push(`cost-lookup ${chain.reason}`);
    } else if (!chain.finalOk || chain.finalCost == null) {
      reasons.push("hosted cost-lookup not final-ok");
    } else {
      const c = chain.finalCost;
      if (!isNonEmpty(provider)) reasons.push("re-derived response provider missing");
      if (!isNonEmpty(c.provider)) reasons.push("re-derived lookup provider missing");
      if (isNonEmpty(provider) && isNonEmpty(c.provider) && provider !== c.provider)
        reasons.push(`re-derived lookup provider ${c.provider} != response provider ${provider}`);
      if (!deepEqual(generationId ?? null, c.generationId ?? null)) reasons.push("re-derived lookup generation id != response generation id");
      if (!deepEqual(model ?? null, c.model ?? null)) reasons.push("re-derived lookup model != response model");
      if (c.actualCostUsd == null) reasons.push("re-derived cost unknown");
      if (!deepEqual(r.cost?.actualCostUsd ?? null, c.actualCostUsd ?? null)) reasons.push("persisted cost != re-derived cost");
      if (r.responseProvider != null && provider != null && r.responseProvider !== provider)
        reasons.push("persisted responseProvider != re-derived response provider");
    }
  } else {
    // (7) Local (vLLM): the record must carry a verified local-runtime artifact ref.
    const lr = r.localRuntimeArtifactRef;
    if (lr == null || typeof lr.file !== "string" || typeof lr.sha256 !== "string")
      reasons.push("local record missing local-runtime artifact reference");
  }

  return { ok: reasons.length === 0, reasons };
}

export type ResumeDecision = "dispatch" | "skip" | "stop";

export interface ResumeClassification {
  decision: ResumeDecision;
  reason: string;
}

/**
 * Decide, from journal + record evidence, what to do with one cell on (re)entry.
 * Fail-closed: an interrupted dispatch (dispatch_started with no record) is an
 * uncertain outcome and stops; a leftover prepared intent also stops; an
 * incomplete or plan-inconsistent record stops; only a complete, consistent
 * record is skipped; a truly clean cell is dispatched.
 */
export function classifyResume(args: {
  record: PersistedRecordShape | null;
  recordConsistent: boolean;
  /** A sticky terminal blocker on the record (see {@link recordTerminalBlocker}). */
  terminalBlocker?: string | null;
  intentState: "prepared_not_dispatched" | "dispatch_started" | null;
}): ResumeClassification {
  if (args.record != null) {
    // A recorded terminal blocker (a prior sticky continuation-validation failure or
    // an incomplete billing/provenance stop) is authoritative and reported first: it
    // stays a blocker forever and is never resume-skipped or re-dispatched (F03).
    if (args.terminalBlocker) return { decision: "stop", reason: args.terminalBlocker };
    if (!args.recordConsistent) return { decision: "stop", reason: "record_inconsistent_with_plan" };
    if (isRecordComplete(args.record)) return { decision: "skip", reason: "complete_record" };
    return { decision: "stop", reason: "incomplete_record_present" };
  }
  if (args.intentState === "dispatch_started") return { decision: "stop", reason: "attempt_outcome_uncertain" };
  if (args.intentState === "prepared_not_dispatched") return { decision: "stop", reason: "intent_present_no_record" };
  return { decision: "dispatch", reason: "fresh" };
}

/**
 * Whether the OpenAI sentinel result clears the gate. Every one of the failure
 * conditions the directive enumerates — qualification failure, content filter,
 * empty final, reasoning-only, length truncation, unknown finish, transport
 * failure — collapses into `qualification !== "pass"` or `transport === "failed"`.
 * On top of that the sentinel must carry a known billed cost and full provenance.
 */
export function sentinelAccepted(r: PersistedRecordShape): { accepted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!r.status || r.status.qualification !== "pass") {
    reasons.push(`qualification=${r.status?.qualification ?? "unknown"}`);
  }
  if (r.status && r.status.transport === "failed") reasons.push("transport_failed");
  const costKnown =
    r.cost != null && (r.cost.costModel === "FREE" || (r.cost.actualCostUsd !== null && r.cost.actualCostUsd !== undefined));
  if (!costKnown) reasons.push("cost_missing");
  const provenancePresent =
    r.generationProvenance != null &&
    r.generationProvenance.generationId != null &&
    r.executionProvenance != null &&
    r.executionProvenance.requestId != null;
  if (!provenancePresent) reasons.push("provenance_missing");
  if (r.substitutionUsed === true) reasons.push("substitution_used");
  if (r.fallbackUsed === true) reasons.push("fallback_used");
  // The recorded request/response drift verdict must itself have passed — a
  // sentinel whose continuationValidation failed never clears the gate.
  const cv = r.continuationValidation;
  if (cv == null || cv.ok !== true) reasons.push("continuation_validation_failed");
  return { accepted: reasons.length === 0, reasons };
}

/** Stable structural equality via sorted-key JSON — for sampling/param drift. */
export function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",") + "}";
}

export interface ContinuationSummary {
  campaignId: string;
  stageId: string;
  requiredOriginal: number;
  historicalFixed: number;
  requiredContinuation: number;
  /** THIS invocation only. */
  executedThisInvocation: number;
  passedThisInvocation: number;
  failedThisInvocation: number;
  attemptsThisInvocation: number;
  resumeSkippedThisInvocation: number;
  /** CUMULATIVE across prior resume-skipped + this invocation. */
  cumulativeTerminalContinuation: number;
  cumulativePassedContinuation: number;
  cumulativeFailedContinuation: number;
  cumulativeAttemptsContinuation: number;
  /** Continuation cells never reached (remaining after an early stop). */
  notAttemptedContinuation: number;
  historicalOutcome: string;
  originalCampaignOverallStatus: string;
  continuationStopped: string | null;
  overallStatus: string;
}

/**
 * Compute the continuation accounting. Fields are explicitly named for THIS
 * invocation vs the CUMULATIVE total (this invocation + prior resume-skipped
 * records), so the cumulative 23 / pass / fail / attempt totals are mechanically
 * consistent after a resume. Completing all 23 continuation cells does NOT make
 * the campaign pass: with the historical provider-policy failure retained, a
 * clean sweep is reported as `diagnostic_complete_with_provider_policy_failure`.
 */
export function summarizeContinuation(args: {
  campaignId: string;
  stageId: string;
  executed: number;
  passed: number;
  failed: number;
  attempts: number;
  resumeSkipped: number;
  resumeSkippedPassed: number;
  resumeSkippedFailed: number;
  resumeSkippedAttempts: number;
  historicalOutcome: string;
  originalCampaignOverallStatus: string;
  continuationStopped: string | null;
}): ContinuationSummary {
  const cumulativeTerminal = args.executed + args.resumeSkipped;
  const notAttempted = REQUIRED_CONTINUATION - cumulativeTerminal;
  const overallStatus = args.continuationStopped
    ? `continuation_halted:${args.continuationStopped}`
    : notAttempted === 0
      ? DIAGNOSTIC_COMPLETE_WITH_PROVIDER_POLICY_FAILURE
      : "continuation_incomplete";
  return {
    campaignId: args.campaignId,
    stageId: args.stageId,
    requiredOriginal: REQUIRED_ORIGINAL,
    historicalFixed: HISTORICAL_FIXED,
    requiredContinuation: REQUIRED_CONTINUATION,
    executedThisInvocation: args.executed,
    passedThisInvocation: args.passed,
    failedThisInvocation: args.failed,
    attemptsThisInvocation: args.attempts,
    resumeSkippedThisInvocation: args.resumeSkipped,
    cumulativeTerminalContinuation: cumulativeTerminal,
    cumulativePassedContinuation: args.passed + args.resumeSkippedPassed,
    cumulativeFailedContinuation: args.failed + args.resumeSkippedFailed,
    cumulativeAttemptsContinuation: args.attempts + args.resumeSkippedAttempts,
    notAttemptedContinuation: notAttempted,
    historicalOutcome: args.historicalOutcome,
    originalCampaignOverallStatus: args.originalCampaignOverallStatus,
    continuationStopped: args.continuationStopped,
    overallStatus,
  };
}
