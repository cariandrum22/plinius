/**
 * Limited qualification campaign driver — plinius-qualification-2026-08-22-v1.
 *
 * Drives the frozen 6-target x 4-benchmark matrix through the repaired
 * completeness pipeline. Order is fixed before execution and the two sentinel
 * cells run first: if either fails to produce an accepted, non-empty final
 * answer, nothing else is started.
 *
 * Every response is stored verbatim with its digest, reasoning and final answer
 * are kept apart, and each hosted generation's actual billed cost is looked up
 * by generation id. Nothing here relaxes a parameter or substitutes a target to
 * make a run pass.
 */
import { mkdir, writeFile } from "fs/promises";
import { readFileSync, readdirSync, existsSync, lstatSync, realpathSync, createReadStream } from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

import { loadBenchmarkById } from "./src/framework/loader.js";
import { buildPromptSnapshot } from "./src/prompt/snapshot.js";
import { captureRubric, captureReferenceAsset, hashRawResponse } from "./src/completeness/assets.js";
import { mapFinishReason, finishReasonTable } from "./src/completeness/finish-reason.js";
import type { CanonicalFinishReason, FinishReasonMapping } from "./src/completeness/finish-reason.js";
import { normalizeCompletion } from "./src/completeness/normalize.js";
import type { NormalizedCompletion } from "./src/completeness/normalize.js";
import { classifyRun } from "./src/completeness/status.js";
import type { RunStatuses } from "./src/completeness/status.js";
import { OpenAICompatibleBackend } from "./src/backends/openai-compatible.js";
import type { FetchFn } from "./src/backends/openai-compatible.js";
import type { ChatMessage } from "./src/types/inference.js";
import { InferenceError } from "./src/types/inference.js";
import { canonicalHash } from "./src/suite/hash.js";
import type { Cell, ContinuationSummary, PersistedRecordShape, PlanExpectation, ExpectedRequestPlan } from "./src/continuation/plan.js";
import {
  deriveContinuationPlan,
  classifyResume,
  sentinelAccepted,
  deepEqual,
  summarizeContinuation,
  planConsistency,
  validateRecordComplete,
  computeContinuationValidation,
  recordTerminalBlocker,
  resumeWireConsistency,
  resumeReDerive,
  deriveResponseOutcome,
  CONTINUATION_EXTENSION_SCHEMA_VERSION,
} from "./src/continuation/plan.js";
import {
  assertFsyncCapability,
  assertEmptyOutputRoot,
  assertResumeRootAllowlist,
  verifyRuntimeManifestChain,
  computePlanDigest,
  RUNTIME_MANIFEST_SCHEMA_VERSION,
  acquireInvocationLock,
  releaseInvocationLock,
  prepareIntent,
  markDispatchStarted,
  finalizeRecord,
  finalizeArtifact,
  verifyReferencedArtifact,
  readIntent,
  readRecord,
} from "./src/continuation/journal.js";
import type { InvocationLock } from "./src/continuation/journal.js";
import {
  resolveLocalTarget,
  deriveExpectedLocalBindings,
  buildObservedBinding,
} from "./src/continuation/local-runtime.js";
import {
  encodeWireBody,
  sanitizeHeaders,
} from "./src/continuation/wire.js";
import type {
  AttemptWireEvidence,
  WireBodyPreimage,
  CostLookupPollEvidence,
  CostLookupWireEvidence,
} from "./src/continuation/wire.js";
import {
  observeLocalRuntime,
  deriveExpectedLocalRuntimes,
} from "./src/continuation/runtime-observer.js";
import type {
  ExpectedLocalRuntime,
  ObserverDeps,
  ObserverFs,
  CommandResult,
} from "./src/continuation/runtime-observer.js";
import type {
  ExpectedLocalBinding,
  LocalTargetBinding,
  RuntimeObservation,
  Sha256Of,
  ParsedCheckpointArtifact,
  ParsedA100Preflight,
} from "./src/continuation/local-runtime.js";

const CAMPAIGN_ID = "plinius-qualification-2026-08-22-v1";
const OR_BASE = "https://openrouter.ai/api/v1";

/**
 * Attempts allowed per logical run. This campaign runs a single attempt per
 * cell; the record shape supports more, but no continuation mode or retry policy
 * is implemented here.
 */
const MAX_ATTEMPTS = 1;

/** Schema version for run records emitted by this corrected driver (A-07). */
export const QUALIFICATION_RUN_SCHEMA_VERSION = 2;

// Credentials and the evidence root are read lazily inside main() only, so
// importing this module for offline testing touches no credential and makes no
// network call.
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

const BENCHMARKS = [
  { id: "se-concurrency-atomic-stats-012", expect: "sha256:b2905ae9ed34a4644fb3f92185e55e415167f2b8559cfddbdbb6daecac258c5b", finalBudget: 8192 },
  { id: "arch-exactly-once-003", expect: "sha256:efecfc2ae16d237e74f275e1d989b3828fbfa246bccc5f8a8da6d0e40960090a", finalBudget: 12288 },
  { id: "sec-oidc-id-token-validation-001", expect: "sha256:5c0ee69752d1221e27364ddbdee738020c66207415df1f0bc143eb0cff7c9dd9", finalBudget: 8192 },
  { id: "formal-spec-idempotent-api-003", expect: "sha256:7cdc567c83286aac8d8cdc5a88fe77f2ea238416a5fb727a4e79e29c9eae079b", finalBudget: 8192 },
];

const REASONING_BUDGET = 16384;
const SHARED_CAP = 32768;

interface TargetCfg {
  slug: string;
  backend: "openrouter" | "vllm";
  baseUrl: string;
  apiKey?: string;
  temperature?: number;
  topP?: number;
  seed?: number;
  timeoutMs: number;
  /** true when reasoning and final answer share one completion cap. */
  sharedCap: boolean;
}

const TARGETS: TargetCfg[] = [
  { slug: "openai/gpt-5.6-sol-pro", backend: "openrouter", baseUrl: OR_BASE, seed: 1, timeoutMs: 600_000, sharedCap: false },
  { slug: "anthropic/claude-opus-5", backend: "openrouter", baseUrl: OR_BASE, temperature: 0, timeoutMs: 600_000, sharedCap: false },
  { slug: "google/gemini-3.7-flash", backend: "openrouter", baseUrl: OR_BASE, temperature: 0, topP: 1, seed: 1, timeoutMs: 600_000, sharedCap: false },
  { slug: "deepseek/deepseek-v4-flash-0731", backend: "openrouter", baseUrl: OR_BASE, temperature: 0, topP: 1, seed: 1, timeoutMs: 600_000, sharedCap: false },
  { slug: "Qwen/Qwen3.8-27B", backend: "vllm", baseUrl: "http://localhost:8001/v1", temperature: 0, topP: 1, seed: 1, timeoutMs: 900_000, sharedCap: true },
  { slug: "openai/gpt-oss-20b", backend: "vllm", baseUrl: "http://localhost:8002/v1", temperature: 0, topP: 1, seed: 1, timeoutMs: 900_000, sharedCap: true },
];

/** The two cells that must run first and must both pass. */
const SENTINELS = [
  { target: "anthropic/claude-opus-5", benchmark: "sec-oidc-id-token-validation-001" },
  { target: "openai/gpt-5.6-sol-pro", benchmark: "sec-oidc-id-token-validation-001" },
];

function sha256Hex(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");
}

async function fetchLiveCatalog(dir: string, orKey: string) {
  const fetchedAt = new Date().toISOString();
  const res = await fetch(`${OR_BASE}/models`, { headers: { Authorization: `Bearer ${orKey}` } });
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (!/^set-cookie$/i.test(k)) headers[k] = v;
  });
  const file = join(dir, "live-openrouter-catalog.json");
  await writeFile(file, text, "utf-8");
  return {
    fetchedAtUtc: fetchedAt,
    endpoint: `${OR_BASE}/models`,
    httpStatus: res.status,
    httpHeaders: headers,
    sizeBytes: Buffer.byteLength(text, "utf-8"),
    sha256: `sha256:${sha256Hex(text)}`,
    file: "live-openrouter-catalog.json",
    parsed: JSON.parse(text) as { data: Array<Record<string, any>> },
  };
}

/** Injectable effects for {@link generationCost} — real clock / sleep / fetch in
 * production; the offline tests pass a no-op sleep and a mock fetch. */
export interface GenerationCostDeps {
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  fetchFn?: FetchFn;
}

/** Actual billed cost for one generation, by generation id. Every poll's whole wire
 * evidence — url / method / status / allowlisted headers / byte-preserving raw body
 * (base64 + sha + length) / receipt time / parse result — is kept, even on non-200,
 * invalid JSON, missing data or the final failure, so nothing is lost (F02). */
export async function generationCost(id: string, orKey: string, deps: GenerationCostDeps = {}): Promise<GenerationCostResult> {
  const nowFn = deps.now ?? (() => new Date().toISOString());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchFn = deps.fetchFn ?? (globalThis.fetch as FetchFn);
  const url = `${OR_BASE}/generation?id=${encodeURIComponent(id)}`;
  const polls: CostLookupPollEvidence[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(attempt === 0 ? 1500 : 2500);
    try {
      const res = await fetchFn(url, { headers: { Authorization: `Bearer ${orKey}` } });
      // arrayBuffer() preserves the exact response bytes (never a .text() re-encode).
      const rawBytes = new Uint8Array(await res.arrayBuffer());
      const preimage = encodeWireBody(rawBytes);
      // Decompose the outcome (C1-R6-F02): jsonParsed = JSON syntax, dataPresent = a
      // `data` object — both independent of the HTTP status.
      let jsonParsed = false;
      let jsonError: string | null = null;
      let d: any = null;
      try {
        const body = JSON.parse(Buffer.from(rawBytes).toString("utf-8"));
        jsonParsed = true;
        d = body?.data ?? null;
      } catch (pe) {
        jsonError = `invalid json: ${(pe as Error).message}`;
      }
      polls.push({
        pollIndex: attempt,
        kind: "http_response",
        url,
        method: "GET",
        receivedAtUtc: nowFn(),
        httpStatus: res.status,
        headers: sanitizeHeaders(res.headers as unknown as Iterable<[string, string]>),
        body: preimage,
        jsonParsed,
        jsonError,
        dataPresent: d != null && typeof d === "object",
      });
      // Success = 200 + valid JSON + data (a non-200 JSON body is a retry, not success).
      if (res.status === 200 && jsonParsed && d != null && typeof d === "object") {
        return {
          lookupOk: true,
          generationId: d.id ?? id,
          rawBodySha256: preimage.sha256,
          rawBodyBytes: preimage.bytes,
          rawBodyPreimage: preimage,
          httpStatus: res.status,
          wire: { polls, finalOk: true },
          actualCostUsd: d.total_cost ?? null,
          upstreamInferenceCost: d.upstream_inference_cost ?? null,
          provider: d.provider_name ?? null,
          responseModelId: d.model ?? null,
          tokensPrompt: d.tokens_prompt ?? null,
          tokensCompletion: d.tokens_completion ?? null,
          nativeTokensPrompt: d.native_tokens_prompt ?? null,
          nativeTokensCompletion: d.native_tokens_completion ?? null,
          nativeTokensReasoning: d.native_tokens_reasoning ?? null,
          cacheDiscount: d.cache_discount ?? null,
          latencyMs: d.latency ?? null,
          generationTimeMs: d.generation_time ?? null,
          finishReasonUpstream: d.finish_reason ?? null,
          nativeFinishReason: d.native_finish_reason ?? null,
          streamed: d.streamed ?? null,
          raw: d,
        };
      }
    } catch (e) {
      polls.push({
        pollIndex: attempt,
        kind: "transport_error",
        url,
        method: "GET",
        receivedAtUtc: nowFn(),
        error: `fetch error: ${(e as Error).message}`,
      });
    }
  }
  // Final failure — still return every poll's wire evidence, nothing lost.
  return { lookupOk: false, generationId: id, actualCostUsd: null, wire: { polls, finalOk: false } };
}

// --- record assembly (pure, offline) ----------------------------------------

/** The output half of one attempt: every normalized field, verbatim. */
interface AttemptOutput {
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

interface GenerationProvenanceFacts {
  provider: string | null;
  generationId: string | null;
  requestedSlug: string;
  responseModelId: string | null;
  actualCostUsd: number | null;
  latencyMs: number | null;
  createdAt: string | null;
}

interface ExecutionProvenanceFacts {
  endpoint: string | null;
  model: string | null;
  created: string | null;
  requestId: string | null;
  backendMetadata: Record<string, unknown> | null;
}

/** Everything one attempt records, once its raw response is in hand. */
export interface QualificationAttemptFacts {
  attemptIndex: number;
  timestamp: string;
  backend: string;
  requestedSlug: string;
  endpoint: string;
  raw: unknown;
  text: string | null;
  rawFinish: string | null;
  transportError: { kind: string; message: string } | null;
  usage: unknown;
  latencyMs: number;
  cost: { costModel: string; actualCostUsd: number | null; lookup?: unknown };
  routing: Record<string, unknown> | null;
  /** Byte-preserving wire evidence for this attempt (F02) — request/response/cost-lookup. */
  wire?: AttemptWireEvidence;
}

/** A complete attempt record — nothing about the attempt is elided. */
export interface QualificationAttempt {
  attemptIndex: number;
  timestamp: string;
  status: RunStatuses;
  output: AttemptOutput;
  rawResponse: unknown;
  rawResponseSha256: string | null;
  rawResponseBytes: number | null;
  finishReasonMapping: FinishReasonMapping;
  finishReasonTable: Record<string, CanonicalFinishReason>;
  metrics: { latencyMs: number; usage: unknown };
  cost: { costModel: string; actualCostUsd: number | null; lookup?: unknown };
  routing: Record<string, unknown> | null;
  generationProvenance: GenerationProvenanceFacts;
  executionProvenance: ExecutionProvenanceFacts;
  error: { kind: string; message: string } | null;
  /** The attempt's byte-preserving wire evidence (F02), or null if none was captured. */
  wire: AttemptWireEvidence | null;
}

/**
 * Build ONE complete attempt record. Pure, offline, deterministic — no network,
 * no clock, no environment. A transport-failed attempt records no provenance:
 * it never borrows a request id, model id, or provider from anywhere else.
 */
export function buildQualificationAttempt(facts: QualificationAttemptFacts): QualificationAttempt {
  // C1-R6-F02: the received-response headline (output / finish mapping / status) is
  // produced by the SHARED pure derivation deriveResponseOutcome(raw) — the exact same
  // function the resume path re-runs on the stored wire bytes, so a persisted headline
  // that contradicts the wire is caught on resume. A transport failure has no response.
  const outcome = facts.transportError ? null : deriveResponseOutcome(facts.raw);
  const finish = outcome ? outcome.finishReasonMapping : mapFinishReason(facts.rawFinish);
  const status = outcome ? outcome.status : classifyRun({ transportError: facts.transportError, normalized: null, finishReason: finish });
  const rawDigest = facts.raw === null || facts.raw === undefined ? null : hashRawResponse(facts.raw);
  const rawObj = (facts.raw ?? null) as Record<string, unknown> | null;
  const genId =
    (rawObj?.id as string | undefined) ??
    (facts.routing?.generationId as string | undefined) ??
    null;
  const createdAt = rawObj?.created != null ? String(rawObj.created) : null;
  const responseModelId =
    (rawObj?.model as string | undefined) ??
    (facts.routing?.responseModelId as string | undefined) ??
    null;

  const generationProvenance: GenerationProvenanceFacts = facts.transportError
    ? {
        provider: null,
        generationId: null,
        requestedSlug: facts.requestedSlug,
        responseModelId: null,
        actualCostUsd: null,
        latencyMs: null,
        createdAt: null,
      }
    : {
        provider: (facts.routing?.provider as string | undefined) ?? facts.backend,
        generationId: genId,
        requestedSlug: facts.requestedSlug,
        responseModelId,
        actualCostUsd: facts.cost?.actualCostUsd ?? null,
        latencyMs: facts.latencyMs,
        createdAt,
      };

  const executionProvenance: ExecutionProvenanceFacts = facts.transportError
    ? { endpoint: null, model: null, created: null, requestId: null, backendMetadata: null }
    : { endpoint: facts.endpoint, model: responseModelId, created: createdAt, requestId: genId, backendMetadata: null };

  return {
    attemptIndex: facts.attemptIndex,
    timestamp: facts.timestamp,
    status,
    output: outcome
      ? outcome.output
      : {
          text: null,
          finishReason: facts.rawFinish,
          reasoningText: null,
          reasoningSource: "none",
          finalAnswer: null,
          finalAnswerSource: "none",
          finalAnswerIsEmpty: true,
          reasoningOnly: false,
          normalizerError: null,
        },
    rawResponse: facts.raw ?? null,
    rawResponseSha256: rawDigest?.sha256 ?? null,
    rawResponseBytes: rawDigest?.byteLength ?? null,
    finishReasonMapping: finish,
    finishReasonTable: outcome ? outcome.finishReasonTable : finishReasonTable(),
    metrics: { latencyMs: facts.latencyMs, usage: facts.usage ?? null },
    cost: facts.cost,
    routing: facts.routing,
    generationProvenance,
    executionProvenance,
    error: facts.transportError,
    wire: facts.wire ?? null,
  };
}

/** The identity of a run, shared by all of its attempts. */
export interface QualificationRecordHeader {
  runId: string;
  sentinel: boolean;
  orderIndex: number;
  benchmarkId: string;
  benchmarkVersion: string;
  benchmarkContentHash: string;
  rubricHash: string;
  referenceAsset: unknown;
  category: string;
  golden: boolean;
  backend: string;
  requestedSlug: string;
  resolvedSlug: string;
  substitutionUsed: boolean;
  fallbackUsed: boolean;
  endpoint: string;
  timestamp: string;
  promptSnapshot: unknown;
  sampling: unknown;
}

export interface QualificationRunRecord {
  schemaVersion: number;
  runId: string;
  campaignId: string;
  sentinel: boolean;
  orderIndex: number;
  benchmarkId: string;
  benchmarkVersion: string;
  benchmarkContentHash: string;
  rubricHash: string;
  referenceAsset: unknown;
  category: string;
  golden: boolean;
  backend: string;
  requestedSlug: string;
  resolvedSlug: string;
  substitutionUsed: boolean;
  fallbackUsed: boolean;
  endpoint: string;
  timestamp: string;
  promptSnapshot: unknown;
  sampling: unknown;
  rawResponse: unknown;
  rawResponseSha256: string | null;
  rawResponseBytes: number | null;
  output: AttemptOutput;
  finishReasonMapping: FinishReasonMapping;
  finishReasonTable: Record<string, CanonicalFinishReason>;
  status: RunStatuses;
  metrics: { latencyMs: number; usage: unknown };
  cost: { costModel: string; actualCostUsd: number | null; lookup?: unknown };
  routing: Record<string, unknown> | null;
  generationProvenance: GenerationProvenanceFacts;
  executionProvenance: ExecutionProvenanceFacts;
  error: { kind: string; message: string } | null;
  attemptCount: number;
  attempts: QualificationAttempt[];
}

/**
 * Assemble the run record from its header and attempts. Every headline field —
 * output, raw response, digest, cost, routing, provenance, error — is derived
 * from the FINAL attempt and nothing else, so the headline can never disagree
 * with the attempt it came from.
 */
export function buildQualificationRunRecord(
  header: QualificationRecordHeader,
  attempts: QualificationAttempt[],
): QualificationRunRecord {
  if (attempts.length === 0) throw new Error(`run ${header.runId} has no attempts`);
  const last = attempts[attempts.length - 1];
  return {
    schemaVersion: QUALIFICATION_RUN_SCHEMA_VERSION,
    runId: header.runId,
    campaignId: CAMPAIGN_ID,
    sentinel: header.sentinel,
    orderIndex: header.orderIndex,
    benchmarkId: header.benchmarkId,
    benchmarkVersion: header.benchmarkVersion,
    benchmarkContentHash: header.benchmarkContentHash,
    rubricHash: header.rubricHash,
    referenceAsset: header.referenceAsset,
    category: header.category,
    golden: header.golden,
    backend: header.backend,
    requestedSlug: header.requestedSlug,
    resolvedSlug: header.resolvedSlug,
    substitutionUsed: header.substitutionUsed,
    fallbackUsed: header.fallbackUsed,
    endpoint: header.endpoint,
    timestamp: header.timestamp,
    promptSnapshot: header.promptSnapshot,
    sampling: header.sampling,
    rawResponse: last.rawResponse,
    rawResponseSha256: last.rawResponseSha256,
    rawResponseBytes: last.rawResponseBytes,
    output: last.output,
    finishReasonMapping: last.finishReasonMapping,
    finishReasonTable: last.finishReasonTable,
    status: last.status,
    metrics: last.metrics,
    cost: last.cost,
    routing: last.routing,
    generationProvenance: last.generationProvenance,
    executionProvenance: last.executionProvenance,
    error: last.error,
    attemptCount: attempts.length,
    attempts,
  };
}

// --- frozen order (shared by default and continuation modes) ----------------

/**
 * Re-derive the frozen 24-cell execution order from the same rules the default
 * campaign uses: the two sentinels first, then the target x benchmark matrix,
 * skipping any cell already emitted. Deterministic, pure, offline.
 */
export function buildFrozenOrder(): Cell[] {
  const order: Cell[] = [];
  for (const s of SENTINELS) order.push({ target: s.target, benchmark: s.benchmark, sentinel: true });
  for (const t of TARGETS) {
    for (const b of BENCHMARKS) {
      if (order.some((o) => o.target === t.slug && o.benchmark === b.id)) continue;
      order.push({ target: t.slug, benchmark: b.id, sentinel: false });
    }
  }
  return order;
}

// --- diagnostic continuation mode -------------------------------------------

/** Schema version for continuation run records — same accepted v2 (A-07). */
export const CONTINUATION_RUN_SCHEMA_VERSION = QUALIFICATION_RUN_SCHEMA_VERSION;

export const CONTINUATION_STAGE_ID = "plinius-qualification-2026-08-22-diagnostic-continuation-driver-r1";

/** The three authority files whose RAW SHA-256 gate the continuation. */
export interface HistoricalDigestExpectation {
  parentBundlePath: string;
  parentBundleSha256: string;
  frozenDefinitionPath: string;
  frozenDefinitionSha256: string;
  historicalRunPath: string;
  historicalRunSha256: string;
}

export interface DigestVerifyResult {
  ok: boolean;
  details: Array<{ name: string; path: string; expected: string; actual: string; match: boolean }>;
}

/**
 * Verify the RAW SHA-256 of the parent Evidence bundle, the frozen campaign
 * definition, and the historical failed run against the authority values, read
 * from the actual files. Canonical digests are auxiliary and never rescue a raw
 * mismatch, so only raw digests are checked here.
 */
export function verifyHistoricalDigestsFromFiles(exp: HistoricalDigestExpectation): DigestVerifyResult {
  const check = (name: string, path: string, expected: string) => {
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    return { name, path, expected, actual, match: actual === expected };
  };
  const details = [
    check("parentBundle", exp.parentBundlePath, exp.parentBundleSha256),
    check("frozenDefinition", exp.frozenDefinitionPath, exp.frozenDefinitionSha256),
    check("historicalRun", exp.historicalRunPath, exp.historicalRunSha256),
  ];
  return { ok: details.every((d) => d.match), details };
}

/** Everything the record builders need for one cell, computed without network. */
export interface CellPlan {
  runId: string;
  orderIndex: number;
  requestedSlug: string;
  backend: string;
  benchmarkId: string;
  endpoint: string;
  maxTokens: number;
  sampling: unknown;
  header: Omit<QualificationRecordHeader, "timestamp">;
}

/** Catalog / target resolution from a fresh preflight (network in C2, mocked in tests). */
export interface TargetResolution {
  requestedSlug: string;
  backend: string;
  resolvedSlug: string | null;
  resolvedExactly: boolean;
  substitutionUsed: boolean;
  fallbackUsed: boolean;
}

export interface CatalogArtifact {
  fetchedAtUtc: string;
  endpoint: string;
  httpStatus: number;
  /** Digest of the raw body, re-derivable from the body stored alongside it. */
  rawBodySha256: string;
  byteLength: number;
  /** Timing of the fetch, so freshness is computed — never hardcoded. */
  requestStartedUtc: string;
  responseReceivedUtc: string;
  evaluatedAtUtc: string;
  /** Response headers, credentials and set-cookie stripped. */
  httpHeaders: Record<string, string>;
  ageSeconds: number | null;
  freshnessThresholdSeconds: number;
  freshnessOk: boolean;
}

// The observed / accepted local-binding types and the fail-closed gate now live
// in src/continuation/local-runtime.ts (the derivation + resolution is a pure,
// tsc-checked, independently-tested rule). Re-exported here for the driver's
// callers and the offline tests.
export type { ExpectedLocalBinding, LocalTargetBinding } from "./src/continuation/local-runtime.js";
export { resolveLocalTarget };

export interface PreflightResult {
  ok: boolean;
  reasons: string[];
  catalog: CatalogArtifact;
  rawBody: string;
  resolution: TargetResolution[];
  /** Observed local-target bindings, persisted alongside the catalog. */
  localBindings?: LocalTargetBinding[];
}

export const CATALOG_FRESHNESS_SECONDS = 1800; // 30 minutes

/** Actual billed-cost lookup result for one generation (injectable in tests). */
export interface GenerationCostResult {
  lookupOk: boolean;
  generationId: string;
  actualCostUsd: number | null;
  provider?: string | null;
  responseModelId?: string | null;
  nativeFinishReason?: string | null;
  upstreamInferenceCost?: number | null;
  nativeTokensReasoning?: number | null;
  /** The lookup's own captured wire evidence, so its generation id / model / provider
   * / actual cost are re-derivable from the raw body it returned (F03). */
  rawBodySha256?: string | null;
  rawBodyBytes?: number | null;
  httpStatus?: number | null;
  /** Byte-preserving preimage of the FINAL (successful) poll body (F02). */
  rawBodyPreimage?: WireBodyPreimage | null;
  /** Per-poll wire evidence — every poll kept whole, even non-200 / invalid JSON / no data (F02). */
  wire?: CostLookupWireEvidence;
  [k: string]: unknown;
}

/** The request body actually sent to the provider (never the plan re-labelled). */
export interface RequestBody {
  model: string;
  maxTokens: number;
  temperature: number | null;
  topP: number | null;
  seed: number | null;
}

/** The captured request actually transmitted, plus response identity from the payload. */
export interface GenerateFacts {
  raw: unknown;
  text: string | null;
  rawFinish: string | null;
  transportError: { kind: string; message: string } | null;
  usage: unknown;
  latencyMs: number;
  cost: { costModel: string; actualCostUsd: number | null; lookup?: unknown };
  routing: Record<string, unknown> | null;
  /** The request body ACTUALLY transmitted — parsed from the captured wire body, never the plan. */
  requestSent: RequestBody;
  /** Digest / byte length of the serialized wire body captured at the fetch boundary. */
  requestWireSha256?: string | null;
  requestWireBytes?: number | null;
  requestUrl?: string | null;
  requestMethod?: string | null;
  /** Raw RESPONSE wire body captured (byte-identical) before any parse, plus its
   * digest / byte length / HTTP status / receipt time / sanitized headers. Kept on
   * non-2xx / empty / malformed / no-choice — so the parsed payload and its digest
   * are always re-derivable from the stored wire bytes (F03). */
  responseWireSha256?: string | null;
  responseWireBytes?: number | null;
  responseHttpStatus?: number | null;
  responseReceivedUtc?: string | null;
  responseHeaders?: Record<string, string> | null;
  /** The generation-cost lookup's own captured wire evidence (hosted only). */
  costLookupWireSha256?: string | null;
  costLookupWireBytes?: number | null;
  costLookupHttpStatus?: number | null;
  /** Response identity, from the raw payload — NOT the request slug. */
  responseModelId: string | null;
  responseGenerationId: string | null;
  responseProvider: string | null;
  /** The SAME identity as reported by the independent generation-cost lookup, for cross-check. */
  generationLookupModelId?: string | null;
  generationLookupGenerationId?: string | null;
  generationLookupProvider?: string | null;
  /** Byte-preserving wire preimage — request body, response body, and every cost-lookup
   * poll — captured with arrayBuffer()-equivalent, so every parsed field is re-derivable
   * from the stored bytes on resume (F02/F03). */
  wire?: AttemptWireEvidence;
}

/**
 * The local (vLLM) preflight result (F06): the OCI inspection + snapshot hashing +
 * /v1/models health for every local target, the observed bindings, and the durable
 * local-runtime artifact body to finalize BEFORE the OpenRouter catalog is fetched.
 */
export interface LocalPreflightResult {
  ok: boolean;
  reasons: string[];
  observed: LocalTargetBinding[];
  artifactBody: string;
}

export interface RunContinuationOptions {
  outputRoot: string;
  generate: (cell: Cell, plan: CellPlan, req: RequestBody) => Promise<GenerateFacts>;
  verifyHistoricalDigests: () => DigestVerifyResult;
  /** OpenRouter catalog preflight (step 6). Runs ONLY after the local gate passes (F06). */
  preflight: () => Promise<PreflightResult>;
  /** Local (vLLM) preflight (steps 2-4). When present it runs — and its artifact is
   * finalized (step 5) — BEFORE the catalog fetch; a local gate failure means zero
   * OpenRouter calls, zero catalog artifact, zero generation (F06). */
  localPreflight?: () => Promise<LocalPreflightResult>;
  planCell: (cell: Cell, orderIndex: number) => Promise<CellPlan>;
  buildRequest?: (cell: Cell, plan: CellPlan, resolution: TargetResolution) => RequestBody;
  order?: Cell[];
  now?: () => string;
  isResume?: boolean;
  stageId?: string;
  historicalOutcome?: string;
  originalCampaignOverallStatus?: string;
  /** Ordered preflight/dispatch event sink — the F06 mock event-trace test asserts on it. */
  onEvent?: (event: string) => void;
  /** The fresh request plan (exact endpoint URL + benchmark messages) for resume re-derivation (F02). */
  resumeRequestPlan?: (cell: Cell, plan: CellPlan, resolution: TargetResolution) => Promise<ExpectedRequestPlan | null>;
}

export interface RunContinuationResult {
  summary: ContinuationSummary;
  stopped: string | null;
  digestVerification: DigestVerifyResult;
  catalog: CatalogArtifact | null;
  dispatchedRunIds: string[];
  resumeSkippedRunIds: string[];
  runsDir: string;
  /** Always set on return — a durable summary is part of a successful finalize. */
  summaryFile: string;
  /** Per-invocation immutable runtime manifest binding catalog/records/summary/journal/priors. */
  runtimeManifestFile: string;
}

function fullSha(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");
}

/** Sampling core (temperature/topP/seed) for request-vs-plan comparison. */
function samplingCore(s: { temperature?: number | null; topP?: number | null; seed?: number | null }): {
  temperature: number | null;
  topP: number | null;
  seed: number | null;
} {
  return { temperature: s.temperature ?? null, topP: s.topP ?? null, seed: s.seed ?? null };
}

/** Default request builder: model = catalog-resolved slug; sampling/max from plan. */
export function defaultBuildRequest(cell: Cell, plan: CellPlan, resolution: TargetResolution): RequestBody {
  const s = plan.sampling as { temperature?: number | null; topP?: number | null; seed?: number | null };
  return {
    model: resolution.resolvedSlug ?? cell.target,
    maxTokens: plan.maxTokens,
    temperature: s.temperature ?? null,
    topP: s.topP ?? null,
    seed: s.seed ?? null,
  };
}

function planExpectationFrom(plan: CellPlan, resolution: TargetResolution): PlanExpectation {
  const h = plan.header;
  return {
    campaignId: CAMPAIGN_ID,
    runId: plan.runId,
    orderIndex: plan.orderIndex,
    benchmarkId: h.benchmarkId,
    benchmarkVersion: h.benchmarkVersion,
    benchmarkContentHash: h.benchmarkContentHash,
    requestedSlug: h.requestedSlug,
    resolvedSlug: resolution.resolvedSlug ?? h.requestedSlug,
    backend: h.backend,
    endpoint: h.endpoint,
    promptId: (h.promptSnapshot as { promptId?: string } | undefined)?.promptId ?? "",
    sampling: h.sampling,
    maxTokens: plan.maxTokens,
    substitutionUsed: resolution.substitutionUsed,
    fallbackUsed: resolution.fallbackUsed,
  };
}

function costKnownOf(cost: { costModel?: string; actualCostUsd?: number | null } | null | undefined): boolean {
  return cost != null && (cost.costModel === "FREE" || (cost.actualCostUsd !== null && cost.actualCostUsd !== undefined));
}
function provenanceOf(r: {
  generationProvenance?: { generationId?: string | null } | null;
  executionProvenance?: { requestId?: string | null } | null;
}): boolean {
  return r.generationProvenance?.generationId != null && r.executionProvenance?.requestId != null;
}

interface Tallies {
  executed: number;
  passed: number;
  failed: number;
  attempts: number;
  resumeSkipped: number;
  resumeSkippedPassed: number;
  resumeSkippedFailed: number;
  resumeSkippedAttempts: number;
  catalog: CatalogArtifact | null;
  catalogRef: { file: string; sha256: string; bytes: number } | null;
  /** The finalized local-runtime preflight artifact ref (typed, F04), or null offline. */
  localRuntimeRef: { kind: "local-runtime"; file: string; sha256: string; bytes: number } | null;
  dispatchedRunIds: string[];
  resumeSkippedRunIds: string[];
  recordDigests: Array<{ runId: string; file: string; sha256: string; bytes: number }>;
}

/**
 * Drive the diagnostic continuation over the 23 cells that follow the historical
 * Anthropic sentinel. A fresh catalog + resolution preflight runs before the
 * first dispatch and any missing/alias/stale resolution stops at dispatch 0. The
 * request body actually built is checked against the plan BEFORE dispatch; the
 * resolved slug and response model id are compared AFTER. Every dispatched
 * outcome — including drift, cost/provenance gaps and provider throws — is
 * finalized as a complete record BEFORE any stop decision, so a billed outcome
 * is never lost. The historical index-0 cell is never handed to `generate`.
 * MAX_ATTEMPTS stays 1. This function opens no network connection; `generate`
 * and `preflight` are the only outward calls and are injected.
 */
let invocationCounter = 0;

export async function runContinuation(opts: RunContinuationOptions): Promise<RunContinuationResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const order = opts.order ?? buildFrozenOrder();
  const stageId = opts.stageId ?? CONTINUATION_STAGE_ID;
  const historicalOutcome =
    opts.historicalOutcome ?? "content_filter/refusal (provider policy) — qualification failure, retained";
  const originalStatus = opts.originalCampaignOverallStatus ?? "scoped_incomplete";
  const buildRequest = opts.buildRequest ?? defaultBuildRequest;
  const runsDir = join(opts.outputRoot, "runs");

  // (0) EXCLUSIVE invocation lock BEFORE the output root is read (F05). A stale
  // lock from a crash, or a concurrent invocation, fails closed here (no overwrite,
  // no dispatch). Held until the last runtime manifest + directory fsync complete.
  const invocationId = `${stageId}#${invocationCounter++}`;
  const lock: InvocationLock = acquireInvocationLock(opts.outputRoot, {
    stageId,
    invocationId,
    startedAt: now(),
  });

  const t: Tallies = {
    executed: 0,
    passed: 0,
    failed: 0,
    attempts: 0,
    resumeSkipped: 0,
    resumeSkippedPassed: 0,
    resumeSkippedFailed: 0,
    resumeSkippedAttempts: 0,
    catalog: null,
    catalogRef: null,
    localRuntimeRef: null,
    dispatchedRunIds: [],
    resumeSkippedRunIds: [],
    recordDigests: [],
  };

  // (1) STEP-1 OFFLINE GATE (F06): historical raw digests AND the fresh continuation
  // plan, both before any local inspection, catalog fetch or dispatch. The plan is
  // re-derived offline (no network) up front so the resume allowlist, the run-id
  // duplicate check, and the plan-digest binding written into every runtime manifest
  // are all available even on an early historical-mismatch stop.
  const dv = opts.verifyHistoricalDigests();
  const { continuation } = deriveContinuationPlan(order);
  const plans: Array<{ cell: Cell; orderIndex: number; plan: CellPlan }> = [];
  for (let i = 0; i < continuation.length; i++) {
    const cell = continuation[i];
    plans.push({ cell, orderIndex: i + 1, plan: await opts.planCell(cell, i + 1) });
  }
  const validRunIds = plans.map((p) => p.plan.runId);
  const planDigest = computePlanDigest(CAMPAIGN_ID, stageId, validRunIds);

  /**
   * Finalize durably (F05): the summary AND a per-invocation runtime manifest are
   * written with the same temp+fsync+atomic-rename+dir-fsync policy as records; a
   * persistence fault is NOT swallowed (finalizeArtifact throws and the campaign
   * fails closed), and both files are ALWAYS returned — never null on a normal
   * continuation. The runtime manifest binds the catalog, every run record (this
   * invocation's dispatched + any resume-skipped), the summary, the journal
   * intents, and all PRIOR runtime manifests, so a multi-invocation digest chain
   * is mechanically verifiable.
   */
  const finalize = (stopped: string | null, t: Tallies): RunContinuationResult => {
    const summary = summarizeContinuation({
      campaignId: CAMPAIGN_ID,
      stageId,
      executed: t.executed,
      passed: t.passed,
      failed: t.failed,
      attempts: t.attempts,
      resumeSkipped: t.resumeSkipped,
      resumeSkippedPassed: t.resumeSkippedPassed,
      resumeSkippedFailed: t.resumeSkippedFailed,
      resumeSkippedAttempts: t.resumeSkippedAttempts,
      historicalOutcome,
      originalCampaignOverallStatus: originalStatus,
      continuationStopped: stopped,
    });
    const summaryBody = JSON.stringify({ ...summary, digestVerification: dv, catalog: t.catalog, stopped }, null, 2);
    // Content address is now the FULL SHA-256 (64 hex), matching the body digest
    // exactly (F02) — the 16-hex short identity is gone from all new r4 output.
    const summaryRes = finalizeArtifact(opts.outputRoot, `continuation-summary-${fullSha(summaryBody)}.json`, summaryBody, lock);

    // Runtime manifest — digest + byte bindings over every artifact this invocation
    // touched, plus the fresh-plan binding (planDigest / campaign / stage / invocation)
    // the resume chain verifier re-derives and matches (F04).
    const withBytes = (rel: string): { bytes: number; sha256: string } => {
      const b = readFileSync(join(opts.outputRoot, rel), "utf-8");
      return { bytes: Buffer.byteLength(b, "utf-8"), sha256: "sha256:" + fullSha(b) };
    };
    const records = [...t.recordDigests];
    for (const rid of t.resumeSkippedRunIds) {
      const rel = `runs/${rid}.json`;
      if (existsSync(join(opts.outputRoot, rel))) records.push({ runId: rid, file: rel, ...withBytes(rel) });
    }
    const intents = existsSync(runsDir)
      ? readdirSync(runsDir)
          .filter((f) => f.endsWith(".intent.json"))
          .sort()
          .map((f) => ({ file: `runs/${f}`, ...withBytes(`runs/${f}`) }))
      : [];
    const priorManifests = existsSync(opts.outputRoot)
      ? readdirSync(opts.outputRoot)
          .filter((f) => /^continuation-runtime-manifest-[0-9a-f]{64}\.json$/.test(f))
          .sort()
          .map((f) => ({ file: f, ...withBytes(f) }))
      : [];
    const requiredRefs = [
      ...(t.catalogRef ? [t.catalogRef.file] : []),
      ...(t.localRuntimeRef ? [t.localRuntimeRef.file] : []),
      summaryRes.file,
      ...records.map((r) => r.file),
      ...intents.map((r) => r.file),
      ...priorManifests.map((r) => r.file),
    ];
    const manifestBody = JSON.stringify(
      {
        manifestSchemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
        campaignId: CAMPAIGN_ID,
        stageId,
        invocationId,
        planDigest,
        stopped,
        catalogArtifact: t.catalogRef,
        localRuntimeArtifact: t.localRuntimeRef,
        summary: { file: summaryRes.file, sha256: summaryRes.sha256, bytes: summaryRes.bytes },
        records,
        intents,
        priorRuntimeManifests: priorManifests,
        requiredRefs,
      },
      null,
      2,
    );
    const manifestRes = finalizeArtifact(opts.outputRoot, `continuation-runtime-manifest-${fullSha(manifestBody)}.json`, manifestBody, lock);

    // Clean completion: release the invocation lock (unlink + dir fsync) LAST.
    releaseInvocationLock(lock);

    return {
      summary,
      stopped,
      digestVerification: dv,
      catalog: t.catalog,
      dispatchedRunIds: t.dispatchedRunIds,
      resumeSkippedRunIds: t.resumeSkippedRunIds,
      runsDir,
      summaryFile: summaryRes.file,
      runtimeManifestFile: manifestRes.file,
    };
  };

  if (!dv.ok) return finalize("historical_digest_mismatch", t);

  // (2) Output-root guards (whole root; resume allowlist derived from the run ids
  // re-derived in step 1) + probe. On resume the structural allowlist is followed by
  // a mechanical verification of the runtime-manifest digest chain against the fresh
  // plan (F04): a fork, gap, cycle, orphan, plan-digest mismatch, off-plan run ref,
  // or a 1-byte change to any manifest-bound record stops before any dispatch. An
  // output root holding artifacts but NO manifest is a crash frontier the resume
  // path validates per-record; a summary with no manifest is manual_recovery_required.
  if (!opts.isResume) assertEmptyOutputRoot(opts.outputRoot);
  else {
    assertResumeRootAllowlist(opts.outputRoot, validRunIds);
    const chain = verifyRuntimeManifestChain(opts.outputRoot, {
      validRunIds,
      campaignId: CAMPAIGN_ID,
      stageId,
      planDigest,
      allowCrashFrontier: true,
    });
    if (!chain.ok) return finalize(`manifest_chain_invalid:${chain.reason}`, t);
  }
  assertFsyncCapability(runsDir);
  opts.onEvent?.("gate:historical_and_plan");

  // (3) LOCAL preflight (F06 steps 2-5): OCI inspection → snapshot hash → /v1/models,
  // then the local-runtime artifact is finalized DURABLY, all BEFORE the OpenRouter
  // catalog is fetched. A local gate failure returns here — so zero OpenRouter calls,
  // zero catalog artifact and zero generation happen when the local runtime is not
  // exactly as the parent Evidence pinned it.
  if (opts.localPreflight) {
    const lp = await opts.localPreflight();
    const lrBody = lp.artifactBody;
    const lrRes = finalizeArtifact(opts.outputRoot, `local-runtime-preflight-${fullSha(lrBody)}.json`, lrBody, lock);
    t.localRuntimeRef = { kind: "local-runtime", file: lrRes.file, sha256: lrRes.sha256, bytes: lrRes.bytes };
    opts.onEvent?.("local:finalize");
    if (!lp.ok) return finalize(`local_preflight_failed:${lp.reasons.join(",")}`, t);
  }

  // (4) Fresh catalog + resolution preflight (F06 steps 6-7), immediately before the
  // first dispatch. The raw body is preserved in the artifact and its digest/byte
  // length RE-DERIVED and verified; the artifact is persisted durably BEFORE any
  // correctness decision, so a bad HTTP status / malformed body / digest mismatch
  // still leaves Evidence.
  opts.onEvent?.("catalog:fetch");
  const pf = await opts.preflight();
  t.catalog = pf.catalog;
  const rederivedSha = "sha256:" + fullSha(pf.rawBody);
  const rederivedBytes = Buffer.byteLength(pf.rawBody, "utf-8");
  const catalogBody = JSON.stringify(
    { catalog: pf.catalog, rawBody: pf.rawBody, resolution: pf.resolution, localBindings: pf.localBindings ?? null },
    null,
    2,
  );
  const catalogRes = finalizeArtifact(opts.outputRoot, `catalog-preflight-${fullSha(catalogBody)}.json`, catalogBody, lock);
  t.catalogRef = { file: catalogRes.file, sha256: catalogRes.sha256, bytes: catalogRes.bytes };
  opts.onEvent?.("catalog:finalize");
  const catalogArtifactRef = {
    kind: "catalog" as const,
    file: catalogRes.file,
    sha256: catalogRes.sha256,
    bytes: catalogRes.bytes,
    fetchedAtUtc: pf.catalog.fetchedAtUtc,
    rawBodySha256: pf.catalog.rawBodySha256,
  };
  if (rederivedSha !== pf.catalog.rawBodySha256 || rederivedBytes !== pf.catalog.byteLength)
    return finalize("catalog_raw_digest_mismatch", t);
  if (!pf.ok) return finalize(`catalog_preflight_failed:${pf.reasons.join(",")}`, t);
  if (!pf.catalog.freshnessOk) return finalize("catalog_stale", t);
  const resolutionBySlug = new Map(pf.resolution.map((r) => [r.requestedSlug, r]));

  const seen = new Set<string>();
  let stopped: string | null = null;

  for (const { cell, orderIndex, plan } of plans) {
    if (seen.has(plan.runId)) {
      stopped = "duplicate_run_id";
      break;
    }
    seen.add(plan.runId);

    const resolution = resolutionBySlug.get(cell.target);
    if (!resolution || !resolution.resolvedExactly) {
      stopped = `unresolved_target:${cell.target}`;
      break;
    }
    const expectation = planExpectationFrom(plan, resolution);

    // Resume classification: FULL completeness + plan consistency + digest re-derivation
    // + sticky terminal blocker + catalog-artifact-reference verification.
    const existing = readRecord(runsDir, plan.runId) as PersistedRecordShape | null;
    let recordConsistent = true;
    let terminalBlocker: string | null = null;
    if (existing) {
      const pc = planConsistency(existing, expectation);
      let digestOk: boolean;
      if (existing.rawResponse == null) {
        digestOk = existing.rawResponseSha256 == null;
      } else {
        const h = hashRawResponse(existing.rawResponse);
        digestOk = existing.rawResponseSha256 === h.sha256 && existing.rawResponseBytes === h.byteLength;
      }
      // F03/F04: re-derive the response identity from the STORED WIRE BYTES (not the
      // parsed rawResponse or persisted verdict) and require it to agree with the
      // headline AND the freshly re-derived plan. resumeWireConsistency guards the
      // parsed-object headline; resumeReDerive recomputes digest/length from the
      // stored base64, re-parses request/response/cost-lookup, and requires the
      // persisted headline (identity/provider/cost) to deep-equal the re-derived
      // values — a wrong-model wire body, a provider mismatch, an unknown cost or a
      // missing preimage is caught even when the top-level fields and cv were forged
      // consistently.
      const wire = resumeWireConsistency(existing, { resolvedSlug: expectation.resolvedSlug });
      // The fresh request plan (exact endpoint URL + benchmark messages) the resume
      // re-derivation deep-equals the stored request wire against (C1-R6-F02).
      const requestPlan = opts.resumeRequestPlan ? await opts.resumeRequestPlan(cell, plan, resolution) : null;
      const rederive = resumeReDerive(existing, {
        resolvedSlug: expectation.resolvedSlug,
        isHosted: existing.backend === "openrouter",
        maxTokens: expectation.maxTokens,
        sampling: expectation.sampling,
        request: requestPlan ?? undefined,
      });
      recordConsistent = pc.consistent && digestOk && wire.ok && rederive.ok;
      terminalBlocker = recordTerminalBlocker(existing);
    }
    const intent = readIntent(runsDir, plan.runId);
    const cls = classifyResume({ record: existing, recordConsistent, terminalBlocker, intentState: intent?.state ?? null });

    if (cls.decision === "stop") {
      stopped = cls.reason;
      break;
    }
    if (cls.decision === "skip") {
      // A resume-skip is only allowed once the record's catalog reference is
      // proven against a real, digest-matching on-disk artifact OF THE CATALOG KIND.
      const refCheck = verifyReferencedArtifact(opts.outputRoot, existing?.catalogArtifactRef, "catalog");
      if (!refCheck.ok) {
        stopped = `catalog_ref_invalid:${refCheck.reason}`;
        break;
      }
      // A LOCAL (vLLM) record must ALSO prove its local-runtime preflight reference as a
      // real, contained, content-addressed, digest+byte-matching LOCAL-RUNTIME artifact —
      // a catalog artifact can never stand in for it (C1-R6-F04). And it must bind to the
      // CURRENT invocation's fresh local observation: if the live runtime changed, the
      // freshly-finalized local-runtime artifact has a different content address than the
      // record's ref, so the run fails closed instead of skipping.
      if (existing?.backend !== "openrouter") {
        const lrCheck = verifyReferencedArtifact(opts.outputRoot, existing?.localRuntimeArtifactRef, "local-runtime");
        if (!lrCheck.ok) {
          stopped = `local_runtime_ref_invalid:${lrCheck.reason}`;
          break;
        }
        if (t.localRuntimeRef == null || existing?.localRuntimeArtifactRef?.file !== t.localRuntimeRef.file) {
          stopped = "local_runtime_binding_changed";
          break;
        }
      }
      t.resumeSkipped++;
      t.resumeSkippedRunIds.push(plan.runId);
      if (existing?.status?.qualification === "pass") t.resumeSkippedPassed++;
      else t.resumeSkippedFailed++;
      t.resumeSkippedAttempts += typeof existing?.attemptCount === "number" ? existing.attemptCount : 0;
      if (orderIndex === 1) {
        const acc = sentinelAccepted(existing as PersistedRecordShape);
        if (!acc.accepted) {
          stopped = `openai_sentinel_not_accepted:${acc.reasons.join(",")}`;
          break;
        }
      }
      continue;
    }

    // Pre-dispatch: build the request and verify it matches the plan BEFORE sending.
    const req = buildRequest(cell, plan, resolution);
    const preReasons: string[] = [];
    if (req.model !== (resolution.resolvedSlug ?? cell.target)) preReasons.push(`request model ${req.model}`);
    if (req.maxTokens !== plan.maxTokens) preReasons.push(`request maxTokens ${req.maxTokens} != ${plan.maxTokens}`);
    if (!deepEqual(samplingCore(req), samplingCore(plan.sampling as Record<string, number | null>)))
      preReasons.push("request sampling drift");
    if (preReasons.length > 0) {
      stopped = `request_payload_drift:${preReasons.join(",")}`;
      break; // stop BEFORE creating an intent or dispatching
    }

    // Dispatch: intent (exclusive) → dispatch_started → generate. The FIRST real
    // dispatch is the OpenAI sentinel (orderIndex 1) — emitted so the F06 event trace
    // proves generation happens only after the local + catalog gates (step 8).
    if (orderIndex === 1) opts.onEvent?.("dispatch:sentinel");
    const timestamp = now();
    prepareIntent(runsDir, {
      campaignId: CAMPAIGN_ID,
      orderIndex,
      runId: plan.runId,
      target: cell.target,
      benchmark: cell.benchmark,
      attemptIndex: 0,
      createdAt: timestamp,
    });
    markDispatchStarted(runsDir, plan.runId);

    let facts: GenerateFacts;
    try {
      facts = await opts.generate(cell, plan, req);
    } catch (err: any) {
      // A provider throw is still a terminal transport-failure outcome.
      facts = {
        raw: null,
        text: null,
        rawFinish: null,
        transportError: { kind: err?.kind ?? "unknown", message: err?.message ?? String(err) },
        usage: null,
        latencyMs: 0,
        cost: {
          costModel: plan.backend === "openrouter" ? "METERED" : "FREE",
          actualCostUsd: plan.backend === "openrouter" ? null : 0,
        },
        routing: null,
        requestSent: req,
        requestWireSha256: null,
        requestWireBytes: null,
        responseModelId: null,
        responseGenerationId: null,
        responseProvider: null,
      };
    }

    const attempt = buildQualificationAttempt({
      attemptIndex: 0,
      timestamp,
      backend: plan.backend,
      requestedSlug: plan.requestedSlug,
      endpoint: plan.endpoint,
      raw: facts.raw,
      text: facts.text,
      rawFinish: facts.rawFinish,
      transportError: facts.transportError,
      usage: facts.usage,
      latencyMs: facts.latencyMs,
      cost: facts.cost,
      routing: facts.routing,
      wire: facts.wire,
    });
    const hdr = {
      ...plan.header,
      timestamp,
      resolvedSlug: resolution.resolvedSlug ?? cell.target,
      substitutionUsed: resolution.substitutionUsed,
      fallbackUsed: resolution.fallbackUsed,
    };
    const baseRecord = buildQualificationRunRecord(hdr, [attempt]);
    const cv = computeContinuationValidation({
      expected: {
        requestedSlug: cell.target,
        resolvedSlug: resolution.resolvedSlug ?? cell.target,
        maxTokens: plan.maxTokens,
        sampling: plan.sampling,
      },
      observed: {
        requestModel: facts.requestSent.model,
        requestMaxTokens: facts.requestSent.maxTokens,
        requestSampling: {
          maxTokens: facts.requestSent.maxTokens,
          temperature: facts.requestSent.temperature,
          topP: facts.requestSent.topP,
          seed: facts.requestSent.seed,
          temperatureSent: facts.requestSent.temperature !== null,
          topPSent: facts.requestSent.topP !== null,
          seedSent: facts.requestSent.seed !== null,
        },
        responseModelId: facts.responseModelId,
        responseReceived: facts.transportError == null && facts.raw != null,
        resolvedSlug: resolution.resolvedSlug ?? cell.target,
        resolvedExactly: resolution.resolvedExactly,
        substitutionUsed: resolution.substitutionUsed,
        fallbackUsed: resolution.fallbackUsed,
        responseProvider: facts.responseProvider,
        responseGenerationId: facts.responseGenerationId,
        lookupModelId: facts.generationLookupModelId ?? null,
        lookupGenerationId: facts.generationLookupGenerationId ?? null,
        lookupProvider: facts.generationLookupProvider ?? null,
        isHosted: plan.backend === "openrouter",
      },
    });
    const finalRecord = {
      ...baseRecord,
      // Continuation EXTENSION schema version (F02): the base record stays schema v2;
      // the wire-preimage extension is versioned separately so its shape change is
      // never silent.
      continuationExtensionSchemaVersion: CONTINUATION_EXTENSION_SCHEMA_VERSION,
      continuationValidation: cv,
      responseModelId: facts.responseModelId,
      responseGenerationId: facts.responseGenerationId,
      responseProvider: facts.responseProvider,
      requestWireSha256: facts.requestWireSha256 ?? null,
      requestWireBytes: facts.requestWireBytes ?? null,
      // Raw response + cost-lookup wire evidence (F02/F03): digest / bytes / status,
      // AND the byte-preserving preimage (in the final attempt's wire evidence), so
      // the parsed payload and its identity are re-derivable from stored bytes. The
      // headline wire digest is derived ONLY from the final attempt's stored bytes.
      responseWireSha256: facts.responseWireSha256 ?? null,
      responseWireBytes: facts.responseWireBytes ?? null,
      responseHttpStatus: facts.responseHttpStatus ?? null,
      responseReceivedUtc: facts.responseReceivedUtc ?? null,
      responseHeaders: facts.responseHeaders ?? null,
      costLookupWireSha256: facts.costLookupWireSha256 ?? null,
      costLookupWireBytes: facts.costLookupWireBytes ?? null,
      costLookupHttpStatus: facts.costLookupHttpStatus ?? null,
      wire: facts.wire ?? null,
      catalogArtifactRef,
      // A local (vLLM) record binds to the verified local-runtime preflight artifact
      // finalized before the catalog fetch (F01/F03); a hosted record has none.
      localRuntimeArtifactRef: plan.backend !== "openrouter" ? t.localRuntimeRef : null,
    };
    // ALWAYS persist the (billed) outcome before any stop decision.
    const recRes = finalizeRecord(runsDir, plan.runId, JSON.stringify(finalRecord, null, 2), lock);
    t.recordDigests.push({ runId: plan.runId, file: `runs/${plan.runId}.json`, sha256: recRes.sha256, bytes: recRes.bytes });
    t.executed++;
    t.attempts += baseRecord.attemptCount;
    if (baseRecord.status.qualification === "pass") t.passed++;
    else t.failed++;
    t.dispatchedRunIds.push(plan.runId);

    // Stop decisions AFTER persistence.
    if (!cv.ok) {
      stopped = `continuation_validation_failed:${cv.reasons.join(",")}`;
      break;
    }
    if (baseRecord.error == null && (!costKnownOf(baseRecord.cost) || !provenanceOf(baseRecord))) {
      stopped = "incomplete_billing_or_provenance";
      break;
    }
    if (orderIndex === 1) {
      const acc = sentinelAccepted(finalRecord as unknown as PersistedRecordShape);
      if (!acc.accepted) {
        stopped = `openai_sentinel_not_accepted:${acc.reasons.join(",")}`;
        break;
      }
    }
    // Non-sentinel failures (incl. transport) are recorded and do NOT stop the run.
  }

  return finalize(stopped, t);
}

/**
 * Real, network-touching cell planner used by the live continuation entrypoint.
 * Reproduces exactly the run-id, prompt-snapshot, sampling and header
 * derivation the default campaign uses, so a continuation cell's run id equals
 * the id it would have had in the full campaign. Reads benchmark assets from
 * disk (no network, no credential).
 */
export async function defaultPlanCell(cell: Cell, orderIndex: number): Promise<CellPlan> {
  const t = TARGETS.find((x) => x.slug === cell.target);
  const bcfg = BENCHMARKS.find((b) => b.id === cell.benchmark);
  if (!t || !bcfg) throw new Error(`unknown cell ${cell.target} x ${cell.benchmark}`);
  const l = await loadBenchmarkById(cell.benchmark);
  if (l.contentHash !== bcfg.expect) {
    throw new Error(`content hash mismatch for ${cell.benchmark}: ${l.contentHash} != ${bcfg.expect}`);
  }
  const rubric = captureRubric(l.rubric);
  const reference = captureReferenceAsset(l.references);
  const promptSnapshot = buildPromptSnapshot({
    systemPrompt: l.systemPrompt,
    userPrompt: l.userPrompt,
    rubric: rubric.canonicalString,
  });
  const maxTokens = t.sharedCap ? SHARED_CAP : bcfg.finalBudget + REASONING_BUDGET;
  const runId = `run-${canonicalHash({
    campaignId: CAMPAIGN_ID,
    benchmarkId: l.asset.id,
    benchmarkContentHash: l.contentHash,
    backend: t.backend,
    model: t.slug,
    repetitionIndex: 0,
    promptId: promptSnapshot.promptId,
  }).slice(7, 23)}`;
  const sampling = {
    maxTokens,
    temperature: t.temperature ?? null,
    topP: t.topP ?? null,
    seed: t.seed ?? null,
    temperatureSent: t.temperature !== undefined,
    topPSent: t.topP !== undefined,
    seedSent: t.seed !== undefined,
  };
  return {
    runId,
    orderIndex,
    requestedSlug: t.slug,
    backend: t.backend,
    benchmarkId: l.asset.id,
    endpoint: t.baseUrl,
    maxTokens,
    sampling,
    header: {
      runId,
      sentinel: cell.sentinel,
      orderIndex,
      benchmarkId: l.asset.id,
      benchmarkVersion: l.asset.version,
      benchmarkContentHash: l.contentHash,
      rubricHash: rubric.rubricHash,
      referenceAsset: reference,
      category: l.asset.category,
      golden: l.asset.golden,
      backend: t.backend,
      requestedSlug: t.slug,
      resolvedSlug: t.slug,
      substitutionUsed: false,
      fallbackUsed: false,
      endpoint: t.baseUrl,
      promptSnapshot,
      sampling,
    },
  };
}

async function main() {
  const EVIDENCE = requireEnv("EVIDENCE_ROOT");
  const OR_KEY = requireEnv("OPENROUTER_API_KEY");
  const outDir = join(EVIDENCE, "campaign");
  const runsDir = join(outDir, "runs");
  await mkdir(runsDir, { recursive: true });

  // --- assets ---------------------------------------------------------------
  const loaded = [];
  for (const b of BENCHMARKS) {
    const l = await loadBenchmarkById(b.id);
    if (l.contentHash !== b.expect) {
      throw new Error(`content hash mismatch for ${b.id}: ${l.contentHash} != ${b.expect}`);
    }
    loaded.push({ cfg: b, l });
  }
  console.log(`assets verified: ${loaded.length}/4 content hashes match`);

  // --- live catalog, immediately before the first hosted attempt -------------
  const catalog = await fetchLiveCatalog(outDir, OR_KEY);
  const ids = new Set(catalog.parsed.data.map((m) => m.id));
  const resolution = TARGETS.filter((t) => t.backend === "openrouter").map((t) => {
    const m = catalog.parsed.data.find((x) => x.id === t.slug);
    return {
      requestedSlug: t.slug,
      resolvedExactly: ids.has(t.slug),
      resolvedSlug: ids.has(t.slug) ? t.slug : null,
      substitutionUsed: false,
      catalogContextLength: m?.context_length ?? null,
      catalogMaxCompletionTokens: m?.top_provider?.max_completion_tokens ?? null,
      catalogModerated: m?.top_provider?.is_moderated ?? null,
      supportedParameters: m?.supported_parameters ?? null,
      unitPrice: m?.pricing ?? null,
    };
  });
  const unresolved = resolution.filter((r) => !r.resolvedExactly);
  if (unresolved.length > 0) {
    throw new Error(`exact target resolution failed: ${unresolved.map((r) => r.requestedSlug).join(", ")}`);
  }
  console.log(`catalog fetched ${catalog.fetchedAtUtc}; exact resolution ${resolution.length}/${resolution.length}`);

  // --- frozen run order: sentinels first (shared derivation) -----------------
  const order = buildFrozenOrder();
  await writeFile(
    join(outDir, "frozen-campaign-definition.json"),
    JSON.stringify(
      {
        campaignId: CAMPAIGN_ID,
        frozenAtUtc: new Date().toISOString(),
        requiredLogicalRuns: 24,
        targets: TARGETS.map((t) => ({
          slug: t.slug,
          backend: t.backend,
          endpoint: t.baseUrl,
          temperature: t.temperature ?? "unsupported — not sent",
          topP: t.topP ?? "unsupported — not sent",
          seed: t.seed ?? "unsupported — not sent",
          timeoutMs: t.timeoutMs,
          maxAttempts: MAX_ATTEMPTS,
          sharedCompletionCap: t.sharedCap,
        })),
        benchmarks: BENCHMARKS,
        reasoningBudgetTokens: REASONING_BUDGET,
        sharedCompletionCapTokens: SHARED_CAP,
        executionOrder: order,
        sentinelRule:
          "The first two cells are sentinels. Each is inspected immediately after it returns; a content_filter, empty final, length truncation or any non-accepted finish reason stops the campaign before the remaining cells start.",
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`run order frozen: ${order.length} cells, ${SENTINELS.length} sentinels first`);

  // --- execute ---------------------------------------------------------------
  const records: QualificationRunRecord[] = [];
  let aborted: string | null = null;

  for (const cell of order) {
    const t = TARGETS.find((x) => x.slug === cell.target)!;
    const entry = loaded.find((x) => x.cfg.id === cell.benchmark)!;
    const { l } = entry;

    const rubric = captureRubric(l.rubric);
    const reference = captureReferenceAsset(l.references);
    const promptSnapshot = buildPromptSnapshot({
      systemPrompt: l.systemPrompt,
      userPrompt: l.userPrompt,
      rubric: rubric.canonicalString,
    });
    const maxTokens = t.sharedCap ? SHARED_CAP : entry.cfg.finalBudget + REASONING_BUDGET;

    const runId = `run-${canonicalHash({
      campaignId: CAMPAIGN_ID,
      benchmarkId: l.asset.id,
      benchmarkContentHash: l.contentHash,
      backend: t.backend,
      model: t.slug,
      repetitionIndex: 0,
      promptId: promptSnapshot.promptId,
    }).slice(7, 23)}`;

    const backend = new OpenAICompatibleBackend({
      id: t.backend,
      baseUrl: t.baseUrl,
      apiKey: t.backend === "openrouter" ? OR_KEY : t.apiKey,
      timeoutMs: t.timeoutMs,
    });

    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let raw: unknown = null;
    let text: string | null = null;
    let rawFinish: string | null = null;
    let transportError: { kind: string; message: string } | null = null;
    let usage: any = null;

    try {
      const resp = await backend.complete({
        model: t.slug,
        messages: [
          { role: "system", content: l.systemPrompt },
          { role: "user", content: l.userPrompt },
        ],
        sampling: {
          maxTokens,
          temperature: t.temperature,
          topP: t.topP,
          seed: t.seed,
        },
        timeoutMs: t.timeoutMs,
      });
      raw = resp.rawMetadata ?? null;
      text = resp.text;
      rawFinish = resp.finishReason ?? null;
      usage = resp.usage ?? null;
    } catch (err: any) {
      transportError = { kind: err?.kind ?? "unknown", message: err?.message ?? String(err) };
    }
    const latencyMs = Date.now() - t0;

    // Actual billed cost, by generation id, for hosted targets.
    let cost: { costModel: string; actualCostUsd: number | null; lookup?: unknown } = {
      costModel: t.backend === "openrouter" ? "METERED" : "FREE",
      actualCostUsd: t.backend === "openrouter" ? null : 0,
    };
    let routing: Record<string, unknown> | null = null;
    const genId = (raw as any)?.id ?? null;
    if (t.backend === "openrouter" && genId) {
      const g = await generationCost(genId, OR_KEY);
      cost = { costModel: "METERED", actualCostUsd: g.actualCostUsd, lookup: g };
      routing = {
        provider: g.provider ?? (raw as any)?.provider ?? null,
        responseModelId: (raw as any)?.model ?? g.responseModelId ?? null,
        generationId: genId,
        nativeFinishReason: g.nativeFinishReason ?? null,
        upstreamInferenceCost: g.upstreamInferenceCost ?? null,
        internalReasoningTokens: g.nativeTokensReasoning ?? null,
      };
    } else if (t.backend === "vllm") {
      routing = { provider: "local-vllm", responseModelId: (raw as any)?.model ?? null, generationId: genId };
    }

    // A single attempt this campaign (MAX_ATTEMPTS === 1). The attempt is built
    // complete — every normalized field, the raw body with its digest and byte
    // length, the finish-reason mapping, metrics, cost and its lookup, routing,
    // and generation/execution provenance — and the record's headline is then
    // derived from it, never assembled independently.
    const attempt = buildQualificationAttempt({
      attemptIndex: 0,
      timestamp: startedAt,
      backend: t.backend,
      requestedSlug: t.slug,
      endpoint: t.baseUrl,
      raw,
      text,
      rawFinish,
      transportError,
      usage,
      latencyMs,
      cost,
      routing,
    });

    const record = buildQualificationRunRecord(
      {
        runId,
        sentinel: cell.sentinel,
        orderIndex: order.indexOf(cell),
        benchmarkId: l.asset.id,
        benchmarkVersion: l.asset.version,
        benchmarkContentHash: l.contentHash,
        rubricHash: rubric.rubricHash,
        referenceAsset: reference,
        category: l.asset.category,
        golden: l.asset.golden,
        backend: t.backend,
        requestedSlug: t.slug,
        resolvedSlug: t.slug,
        substitutionUsed: false,
        fallbackUsed: false,
        endpoint: t.baseUrl,
        timestamp: startedAt,
        promptSnapshot,
        sampling: {
          maxTokens,
          temperature: t.temperature ?? null,
          topP: t.topP ?? null,
          seed: t.seed ?? null,
          temperatureSent: t.temperature !== undefined,
          topPSent: t.topP !== undefined,
          seedSent: t.seed !== undefined,
        },
      },
      [attempt],
    );
    const status = record.status;
    const finish = record.finishReasonMapping;

    const file = join(runsDir, `${runId}.json`);
    await writeFile(file, JSON.stringify(record, null, 2), "utf-8");
    records.push(record);

    const tag = cell.sentinel ? "SENTINEL" : "        ";
    console.log(
      `${tag} [${String(order.indexOf(cell) + 1).padStart(2)}/24] ${t.slug} x ${l.asset.id} -> ` +
        `finish=${finish.raw} canonical=${finish.canonical} final=${status.finalCompleteness} ` +
        `qual=${status.qualification} cost=${cost.actualCostUsd ?? "n/a"} ${latencyMs}ms`,
    );

    if (cell.sentinel && status.qualification !== "pass") {
      aborted = `sentinel ${t.slug} x ${l.asset.id} did not pass: ${status.failureReasons.join("; ")}`;
      console.log(`ABORT: ${aborted}`);
      break;
    }
  }

  const summary = {
    campaignId: CAMPAIGN_ID,
    completedUtc: new Date().toISOString(),
    aborted,
    required: 24,
    executed: records.length,
    passed: records.filter((r) => r.status.qualification === "pass").length,
    failed: records.filter((r) => r.status.qualification !== "pass").length,
    skipped: 24 - records.length,
    substituted: 0,
    attempts: records.reduce((n, r) => n + r.attemptCount, 0),
    emptyFinal: records.filter((r) => r.output.finalAnswerIsEmpty).length,
    catalog: { ...catalog, parsed: undefined },
    targetResolution: resolution,
  };
  await writeFile(join(outDir, "campaign-summary.json"), JSON.stringify(summary, null, 2), "utf-8");
  console.log(
    `\nDONE executed=${summary.executed} passed=${summary.passed} failed=${summary.failed} ` +
      `skipped=${summary.skipped} emptyFinal=${summary.emptyFinal} aborted=${aborted ?? "no"}`,
  );
}

// --- live continuation entrypoint (Stage C2 only; never invoked in C1) -------

/** Authority raw SHA-256 values that gate the continuation, as bare hex. */
const HISTORICAL_DIGESTS = {
  parentBundleSha256: "5464aac6862ee2b001cae40ac861d43b64abb9b0cd705bfa539252104963c66e",
  frozenDefinitionSha256: "eba5485902b6fa8307dc4cf1e3ff4c4bf99175f9e63eaedd0c81102332fae86d",
  historicalRunSha256: "05390908e2dcadc2f029292a98be21ccc13b7e39ee8ce3b8d3660d455a1ff026",
} as const;

export interface LivePreflightArgs {
  orKey: string;
  now: () => string;
  /** Injectable fetch — defaults to global fetch. Tests drive the REAL function with a mock. */
  fetchFn?: FetchFn;
  /** Accepted local-target bindings (from parent Evidence's accepted preflight). */
  expectedLocalBindings?: ExpectedLocalBinding[];
  /** Observe live local-target bindings (health / served model / digests). */
  localBindingProbe?: (targets: TargetCfg[], fetchFn: FetchFn) => Promise<LocalTargetBinding[]>;
  /** Local bindings ALREADY observed by the separate local preflight (F06). When
   * given they are used as-is (no re-observation), keeping the local resolution
   * consistent with the local-runtime artifact finalized before the catalog fetch. */
  precomputedObserved?: LocalTargetBinding[];
}

/**
 * Fresh catalog + target resolution preflight for the live continuation
 * (Stage C2). Fetches the OpenRouter model catalog, resolves the 4 hosted targets
 * by EXACT slug, and gates the 2 local (vLLM) targets through
 * {@link resolveLocalTarget} against their accepted bindings — there is no
 * placeholder resolution. The RAW body is preserved verbatim (returned as
 * `rawBody`, digested for the catalog artifact) and NEVER parsed before it is
 * captured, so a non-200 / empty / malformed / schema-mismatched response still
 * yields durable Evidence and a `ok:false` stop rather than a thrown, lost body.
 * Freshness is computed from the response-receipt and evaluation timestamps, not
 * hardcoded. Network is used here (injectable for tests); in Stage C1/r3 the tests
 * drive this exact function through a mock fetch.
 */
export async function livePreflight(args: LivePreflightArgs): Promise<PreflightResult> {
  const { orKey, now } = args;
  const fetchFn = args.fetchFn ?? (globalThis.fetch as FetchFn);
  const endpoint = `${OR_BASE}/models`;
  const reasons: string[] = [];

  const requestStartedUtc = now();
  let httpStatus = 0;
  let text = "";
  const httpHeaders: Record<string, string> = {};
  try {
    const res = await fetchFn(endpoint, { headers: { Authorization: `Bearer ${orKey}` } });
    httpStatus = res.status;
    text = await res.text(); // RAW body captured before any parse
    res.headers.forEach((v, k) => {
      if (!/^(set-cookie|authorization)$/i.test(k)) httpHeaders[k] = v;
    });
  } catch (e) {
    reasons.push(`catalog fetch error: ${(e as Error).message}`);
  }
  const responseReceivedUtc = now();

  let parsed: { data?: Array<{ id?: string }> } | null = null;
  try {
    parsed = JSON.parse(text) as { data?: Array<{ id?: string }> };
  } catch {
    reasons.push("catalog malformed json");
  }
  if (parsed != null && !Array.isArray(parsed.data)) reasons.push("catalog schema mismatch (data not array)");
  const ids = new Set((parsed?.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string"));

  const hosted = TARGETS.filter((x) => x.backend === "openrouter");
  const localTargets = TARGETS.filter((x) => x.backend === "vllm");
  const observed = args.precomputedObserved ?? (args.localBindingProbe ? await args.localBindingProbe(localTargets, fetchFn) : []);
  const observedBySlug = new Map(observed.map((o) => [o.requestedSlug, o]));
  const expectedBySlug = new Map((args.expectedLocalBindings ?? []).map((e) => [e.requestedSlug, e]));

  // Single evaluation timestamp — used both for catalog freshness and for the
  // local-binding observation-freshness gate (5-minute window).
  const evaluatedAtUtc = now();
  const resolution: TargetResolution[] = TARGETS.map((x) => {
    if (x.backend === "openrouter") {
      const exact = ids.has(x.slug);
      return {
        requestedSlug: x.slug,
        backend: x.backend,
        resolvedSlug: exact ? x.slug : null,
        resolvedExactly: exact,
        substitutionUsed: false,
        fallbackUsed: false,
      };
    }
    const r = resolveLocalTarget(expectedBySlug.get(x.slug), observedBySlug.get(x.slug), evaluatedAtUtc);
    reasons.push(...r.reasons);
    return r.resolution;
  });

  const byteLength = Buffer.byteLength(text, "utf-8");
  const ageSeconds = Math.max(0, Math.round((Date.parse(evaluatedAtUtc) - Date.parse(responseReceivedUtc)) / 1000));
  const catalog: CatalogArtifact = {
    fetchedAtUtc: requestStartedUtc,
    endpoint,
    httpStatus,
    rawBodySha256: "sha256:" + createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex"),
    byteLength,
    requestStartedUtc,
    responseReceivedUtc,
    evaluatedAtUtc,
    httpHeaders,
    ageSeconds,
    freshnessThresholdSeconds: CATALOG_FRESHNESS_SECONDS,
    freshnessOk: ageSeconds <= CATALOG_FRESHNESS_SECONDS,
  };

  if (httpStatus !== 200) reasons.push(`catalog http ${httpStatus}`);
  if (text.length === 0) reasons.push("catalog empty body");
  if (hosted.length !== 4) reasons.push(`expected 4 hosted targets, got ${hosted.length}`);
  const missingHosted = resolution.filter((r) => r.backend === "openrouter" && !r.resolvedExactly);
  if (missingHosted.length > 0) reasons.push(`unresolved hosted: ${missingHosted.map((m) => m.requestedSlug).join(",")}`);

  return { ok: reasons.length === 0, reasons, catalog, rawBody: text, resolution, localBindings: observed };
}

/** Arguments to {@link dispatchViaBackend}. */
export interface DispatchArgs {
  backendId: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  isHosted: boolean;
  req: RequestBody;
  messages: ChatMessage[];
  /** Injectable fetch — tests drive this exact adapter through a mock. */
  fetchFn: FetchFn;
  /** Independent billed-cost + routing lookup, by generation id. */
  costLookup?: (generationId: string) => Promise<GenerationCostResult>;
  /** Clock for the response-receipt timestamp — injected in tests. */
  now?: () => string;
}

/**
 * The real dispatch adapter, separated so the offline tests exercise it directly
 * through an injectable fetch. It CAPTURES the actual serialized request body at
 * the fetch boundary (the authorization header is never captured) and derives
 * `requestSent` from that wire body — never from the plan object. It also captures
 * the response bytes: an HTTP-error / invalid-JSON / no-choice outcome is a
 * RECEIVED response (its raw evidence is preserved and classified as a failed
 * response), NOT a transport failure, which is reserved for the fetch never
 * completing (network / timeout).
 */
export async function dispatchViaBackend(args: DispatchArgs): Promise<GenerateFacts> {
  const now = args.now ?? (() => new Date().toISOString());
  let capturedReqBody = "";
  let capturedUrl: string | null = null;
  let capturedMethod: string | null = null;
  let capturedResStatus: number | null = null;
  let capturedResBytes: Uint8Array | null = null;
  let capturedResBody: string | null = null;
  let capturedResHeaders: Record<string, string> = {};
  let responseReceivedUtc: string | null = null;
  const capturing: FetchFn = async (url, init) => {
    capturedUrl = url;
    capturedMethod = (init?.method as string) ?? "GET";
    capturedReqBody = typeof init?.body === "string" ? init.body : "";
    const res = await args.fetchFn(url, init);
    responseReceivedUtc = now();
    // Allowlisted response headers only — authorization / cookie / set-cookie / any
    // credential-bearing header is dropped by the strict allowlist (F02).
    try {
      capturedResHeaders = sanitizeHeaders(res.headers as unknown as Iterable<[string, string]>);
    } catch {
      capturedResHeaders = {};
    }
    // arrayBuffer() preserves the EXACT response bytes — never a .text() decode/re-encode.
    try {
      const clone = res.clone();
      capturedResStatus = res.status;
      capturedResBytes = new Uint8Array(await clone.arrayBuffer());
      capturedResBody = Buffer.from(capturedResBytes).toString("utf-8");
    } catch {
      capturedResStatus = res.status;
      capturedResBytes = null;
      capturedResBody = null;
    }
    return res;
  };

  const backend = new OpenAICompatibleBackend({
    id: args.backendId,
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    timeoutMs: args.timeoutMs,
    fetchFn: capturing,
  });

  const t0 = Date.now();
  let raw: unknown = null;
  let text: string | null = null;
  let rawFinish: string | null = null;
  let transportError: { kind: string; message: string } | null = null;
  let usage: unknown = null;
  try {
    const resp = await backend.complete({
      model: args.req.model,
      messages: args.messages,
      sampling: {
        maxTokens: args.req.maxTokens,
        temperature: args.req.temperature ?? undefined,
        topP: args.req.topP ?? undefined,
        seed: args.req.seed ?? undefined,
      },
      timeoutMs: args.timeoutMs,
    });
    raw = resp.rawMetadata ?? null;
    text = resp.text;
    rawFinish = resp.finishReason ?? null;
    usage = resp.usage ?? null;
  } catch (err) {
    const kind = err instanceof InferenceError ? err.kind : ((err as { kind?: string })?.kind ?? "unknown");
    const message = err instanceof Error ? err.message : String(err);
    if ((kind === "http" || kind === "invalid_response") && capturedResBody != null) {
      // A provider RESPONSE was received — keep the raw evidence, do not misclassify.
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(capturedResBody);
      } catch {
        parsedBody = { __nonJson: true, __rawBody: capturedResBody };
      }
      const bodyObj = typeof parsedBody === "object" && parsedBody != null ? (parsedBody as Record<string, unknown>) : { value: parsedBody };
      raw = { __httpStatus: capturedResStatus, __providerError: kind, ...bodyObj };
      text = null;
      rawFinish = ((raw as { choices?: Array<{ finish_reason?: string }> }).choices?.[0]?.finish_reason) ?? null;
      transportError = null;
    } else {
      transportError = { kind, message };
    }
  }
  const latencyMs = Date.now() - t0;

  // The request body ACTUALLY transmitted, parsed from the captured wire bytes.
  let wireModel = args.req.model;
  let wireMax: number | null = args.req.maxTokens;
  let wireTemp: number | null = null;
  let wireTopP: number | null = null;
  let wireSeed: number | null = null;
  try {
    const w = JSON.parse(capturedReqBody) as Record<string, unknown>;
    if (typeof w.model === "string") wireModel = w.model;
    wireMax = typeof w.max_tokens === "number" ? w.max_tokens : null;
    wireTemp = typeof w.temperature === "number" ? w.temperature : null;
    wireTopP = typeof w.top_p === "number" ? w.top_p : null;
    wireSeed = typeof w.seed === "number" ? w.seed : null;
  } catch {
    /* no wire body captured (e.g. the fetch never ran) — drift will be flagged */
  }
  const requestSent: RequestBody = { model: wireModel, maxTokens: wireMax ?? args.req.maxTokens, temperature: wireTemp, topP: wireTopP, seed: wireSeed };
  // Byte-preserving wire preimages (F02): base64 + sha-over-raw-bytes + byte length.
  // Digest / bytes are taken from the preimage's own raw bytes, never a re-encode.
  const requestPreimage: WireBodyPreimage | null = capturedReqBody ? encodeWireBody(capturedReqBody) : null;
  const responsePreimage: WireBodyPreimage | null = capturedResBytes != null ? encodeWireBody(capturedResBytes) : null;
  const requestWireSha256 = requestPreimage?.sha256 ?? null;
  const requestWireBytes = requestPreimage?.bytes ?? null;
  const responseWireSha256 = responsePreimage?.sha256 ?? null;
  const responseWireBytes = responsePreimage?.bytes ?? null;

  const genId = (raw as { id?: string } | null)?.id ?? null;
  const responseModelId = (raw as { model?: string } | null)?.model ?? null;
  // Hosted response provider is taken INDEPENDENTLY from the raw payload (or a
  // sanitized provider header), never substituted from the lookup.
  const payloadProvider = (raw as { provider?: string } | null)?.provider ?? null;
  const headerProvider = capturedResHeaders["x-provider-name"] ?? capturedResHeaders["x-provider"] ?? null;
  let responseProvider: string | null = payloadProvider ?? headerProvider ?? (args.isHosted ? null : "local-vllm");
  let cost: { costModel: string; actualCostUsd: number | null; lookup?: unknown } = {
    costModel: args.isHosted ? "METERED" : "FREE",
    actualCostUsd: args.isHosted ? null : 0,
  };
  let routing: Record<string, unknown> | null = null;
  let lookupModelId: string | null = null;
  let lookupGenId: string | null = null;
  let lookupProvider: string | null = null;
  let costLookupWireSha256: string | null = null;
  let costLookupWireBytes: number | null = null;
  let costLookupHttpStatus: number | null = null;
  let costLookupWire: CostLookupWireEvidence | null = null;
  if (args.isHosted && genId && args.costLookup && transportError == null) {
    const g = await args.costLookup(genId);
    cost = { costModel: "METERED", actualCostUsd: g.actualCostUsd, lookup: g };
    lookupModelId = g.responseModelId ?? null;
    lookupGenId = g.generationId ?? null;
    lookupProvider = g.provider ?? null;
    costLookupWireSha256 = g.rawBodySha256 ?? null;
    costLookupWireBytes = g.rawBodyBytes ?? null;
    costLookupHttpStatus = g.httpStatus ?? null;
    costLookupWire = g.wire ?? null;
    // The lookup provider is recorded, but does NOT overwrite the independently
    // observed response provider (F03) — a hosted mismatch is a validation failure,
    // not something to paper over by copying the lookup value into the response.
    routing = {
      provider: responseProvider,
      lookupProvider,
      responseModelId: responseModelId ?? lookupModelId,
      generationId: genId,
      nativeFinishReason: g.nativeFinishReason ?? null,
      upstreamInferenceCost: g.upstreamInferenceCost ?? null,
      internalReasoningTokens: g.nativeTokensReasoning ?? null,
    };
  } else if (!args.isHosted) {
    routing = { provider: "local-vllm", responseModelId, generationId: genId };
  }

  return {
    raw,
    text,
    rawFinish,
    transportError,
    usage,
    latencyMs,
    cost,
    routing,
    requestSent,
    requestWireSha256,
    requestWireBytes,
    requestUrl: capturedUrl,
    requestMethod: capturedMethod,
    responseWireSha256,
    responseWireBytes,
    responseHttpStatus: capturedResStatus,
    responseReceivedUtc,
    responseHeaders: capturedResHeaders,
    costLookupWireSha256,
    costLookupWireBytes,
    costLookupHttpStatus,
    responseModelId,
    responseGenerationId: genId,
    responseProvider,
    generationLookupModelId: lookupModelId,
    generationLookupGenerationId: lookupGenId,
    generationLookupProvider: lookupProvider,
    wire: {
      request: { url: capturedUrl, method: capturedMethod, body: requestPreimage },
      response: {
        httpStatus: capturedResStatus,
        receivedAtUtc: responseReceivedUtc,
        headers: capturedResHeaders,
        body: responsePreimage,
      },
      costLookup: costLookupWire,
    },
  };
}

/** Dispatch one continuation cell against its live backend (Stage C2). */
async function liveGenerate(cell: Cell, plan: CellPlan, req: RequestBody, orKey: string, fetchFn?: FetchFn): Promise<GenerateFacts> {
  const t = TARGETS.find((x) => x.slug === cell.target);
  if (!t) throw new Error(`unknown target ${cell.target}`);
  const l = await loadBenchmarkById(cell.benchmark);
  return dispatchViaBackend({
    backendId: t.backend,
    baseUrl: t.baseUrl,
    apiKey: t.backend === "openrouter" ? orKey : t.apiKey,
    timeoutMs: t.timeoutMs,
    isHosted: t.backend === "openrouter",
    req,
    messages: [
      { role: "system", content: l.systemPrompt },
      { role: "user", content: l.userPrompt },
    ],
    fetchFn: fetchFn ?? (globalThis.fetch as FetchFn),
    costLookup: t.backend === "openrouter" ? (id) => generationCost(id, orKey) : undefined,
  });
}

/**
 * Live continuation entrypoint. Writes only into a fresh output root OUTSIDE the
 * parent Evidence. This runs the actual 23-cell continuation and therefore makes
 * network calls — it belongs to Stage C2 and is never invoked during Stage C1.
 */
/** Fixed file SHA-256 of the 4 parent local-authority artifacts (verified before parse, F01). */
export const PARENT_LOCAL_ARTIFACT_DIGESTS = {
  a100Preflight: "30ffa0e7d8d10b1470c66519c4aae7af71139977f339d46ffc5b9b2c0b4a2db0",
  qwenCheckpoint: "9eac6a8940991f17e25af6b6a0c1107d2934aa6eb13893fba09b351e39b82c31",
  gptossCheckpoint: "b75d875327d58a1e8cc91d7f2ae0c4091d65e839ffb923f58cbda4c0e9fe35c9",
  catalogResolution: "8bd4fa2d78d2545f7c80da5d0fd9081250f8cf68cad7715f2c5d38dcfb16ce44",
} as const;

const bareSha256: Sha256Of = (canonical: string) => createHash("sha256").update(Buffer.from(canonical, "utf-8")).digest("hex");

/**
 * Re-derive the accepted local (vLLM) bindings ONLY from the parent Evidence
 * artifacts (F01). Each artifact's FIXED file SHA-256 is verified — and its being
 * a regular file, not a symlink — BEFORE it is parsed; the values (checkpoint
 * revision, weight-manifest digest, serving-config digest, …) are then re-derived,
 * never read from an arbitrary bindings directory.
 */
function readParentLocalArtifacts(parentRoot: string): {
  a100: ParsedA100Preflight;
  checkpoints: ParsedCheckpointArtifact[];
} {
  const readVerified = (rel: string, expectedDigest: string): unknown => {
    const p = join(parentRoot, rel);
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`parent local artifact is not a regular file: ${rel}`);
    const buf = readFileSync(p);
    const actual = createHash("sha256").update(buf).digest("hex");
    if (actual !== expectedDigest) throw new Error(`parent local artifact digest mismatch: ${rel} (${actual} != ${expectedDigest})`);
    return JSON.parse(buf.toString("utf-8"));
  };
  const a100 = readVerified("artifacts/06-a100-preflight.json", PARENT_LOCAL_ARTIFACT_DIGESTS.a100Preflight) as ParsedA100Preflight;
  const qwen = readVerified("artifacts/06-local-checkpoint-qwen3.8-27b.json", PARENT_LOCAL_ARTIFACT_DIGESTS.qwenCheckpoint) as ParsedCheckpointArtifact;
  const gptoss = readVerified("artifacts/06-local-checkpoint-gpt-oss-20b.json", PARENT_LOCAL_ARTIFACT_DIGESTS.gptossCheckpoint) as ParsedCheckpointArtifact;
  // Defense in depth: verify the catalog-resolution artifact's fixed digest too.
  readVerified("artifacts/05-openrouter-catalog-and-resolution.json", PARENT_LOCAL_ARTIFACT_DIGESTS.catalogResolution);
  return { a100, checkpoints: [qwen, gptoss] };
}

export function loadExpectedLocalBindingsFromParent(parentRoot: string): ExpectedLocalBinding[] {
  const { a100, checkpoints } = readParentLocalArtifacts(parentRoot);
  return deriveExpectedLocalBindings({ a100Preflight: a100, checkpoints, hasher: bareSha256 });
}

/**
 * Re-derive the full expected local RUNTIME (container / image / engine args / served
 * model / snapshot path / 40-hex revision / expected file list) ONLY from the parent
 * artifacts, after verifying each file's fixed SHA-256 (F01) — the specification the
 * production observer inspects the live container and snapshot against.
 */
export function loadExpectedLocalRuntimesFromParent(parentRoot: string): ExpectedLocalRuntime[] {
  const { a100, checkpoints } = readParentLocalArtifacts(parentRoot);
  return deriveExpectedLocalRuntimes({ a100Preflight: a100, checkpoints });
}

/**
 * Node-backed observer effects (F01). A SHELL-FREE command runner (spawnSync with an
 * argv array, timeout and bounded output — never a shell string), a filesystem view
 * that STREAM-hashes each file, and a /v1/models fetch. Used only by the live
 * continuation entrypoint (Stage C2); the offline tests drive observeLocalRuntime
 * with mock effects instead.
 */
export function nodeObserverDeps(now: () => string): ObserverDeps {
  const runCommand = (argv: string[], opts: { timeoutMs: number; maxBytes: number }): CommandResult => {
    const r = spawnSync(argv[0], argv.slice(1), {
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBytes,
      shell: false,
      encoding: "utf-8",
    });
    if (r.error) {
      const timedOut = (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" || r.signal === "SIGTERM";
      return { status: null, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut, error: timedOut ? undefined : r.error.message };
    }
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.signal === "SIGTERM" };
  };
  const fs: ObserverFs = {
    realpath: (p) => realpathSync(p),
    lstat: (p) => lstatSync(p),
    readdir: (p) => readdirSync(p),
    hashFile: (p) =>
      new Promise((resolvePromise, reject) => {
        const h = createHash("sha256");
        let size = 0;
        const s = createReadStream(p);
        s.on("data", (c: Buffer) => {
          size += c.length;
          h.update(c);
        });
        s.on("error", reject);
        s.on("end", () => resolvePromise({ sizeBytes: size, sha256: h.digest("hex") }));
      }),
  };
  const fetchModels = async (url: string) => {
    const res = await fetch(url);
    return { status: res.status, text: () => res.text() };
  };
  return { runCommand, fs, fetchModels, now, ociBinary: "docker" };
}

/**
 * Build a local-binding probe. Each target's raw runtime observation comes from
 * `observe` (live OCI inspection + snapshot hashing + /v1/models, wired by the
 * Stage C2 operator; mocked in the offline tests). The digests are RE-COMPUTED
 * from the raw files/config by {@link buildObservedBinding}, never read from a
 * prefilled file. When a target is not observable the probe emits a null binding,
 * so the gate fails closed BEFORE any dispatch.
 */
export function makeLocalBindingProbe(deps: {
  now: () => string;
  observe: (target: { slug: string; baseUrl: string }) => Promise<RuntimeObservation | null>;
  hasher?: Sha256Of;
}): (targets: TargetCfg[], fetchFn: FetchFn) => Promise<LocalTargetBinding[]> {
  const hasher = deps.hasher ?? bareSha256;
  return async (targets) => {
    const out: LocalTargetBinding[] = [];
    for (const t of targets) {
      const obs = await deps.observe({ slug: t.slug, baseUrl: t.baseUrl });
      if (obs == null) {
        out.push({
          requestedSlug: t.slug,
          endpoint: t.baseUrl,
          healthy: false,
          servedModelId: null,
          checkpointRevision: null,
          weightManifestDigest: null,
          servingConfigDigest: null,
          tensorParallelism: null,
          precision: null,
          capturedAtUtc: deps.now(),
        });
      } else {
        out.push(buildObservedBinding(obs, hasher));
      }
    }
    return out;
  };
}

async function continuationMain() {
  const outputRoot = requireEnv("CONTINUATION_OUTPUT_ROOT");
  const orKey = requireEnv("OPENROUTER_API_KEY");
  const parentRoot = requireEnv("PARENT_EVIDENCE_ROOT");
  const parentBundlePath = requireEnv("PARENT_BUNDLE_PATH");
  const now = () => new Date().toISOString();
  const exp: HistoricalDigestExpectation = {
    parentBundlePath,
    parentBundleSha256: HISTORICAL_DIGESTS.parentBundleSha256,
    frozenDefinitionPath: join(parentRoot, "campaign", "frozen-campaign-definition.json"),
    frozenDefinitionSha256: HISTORICAL_DIGESTS.frozenDefinitionSha256,
    historicalRunPath: join(parentRoot, "campaign", "runs", "run-d43bb9bcd2a03c20.json"),
    historicalRunSha256: HISTORICAL_DIGESTS.historicalRunSha256,
  };

  // F01: expected local bindings are re-derived ONLY from the parent artifacts. An
  // arbitrary PLINIUS_LOCAL_BINDING_DIR is REJECTED (no expected value may come
  // from an arbitrary directory).
  if (process.env.PLINIUS_LOCAL_BINDING_DIR) {
    throw new Error("PLINIUS_LOCAL_BINDING_DIR is not permitted: expected local bindings are derived only from parent Evidence");
  }
  const expectedLocalBindings = loadExpectedLocalBindingsFromParent(parentRoot);
  const expectedLocalRuntimes = loadExpectedLocalRuntimesFromParent(parentRoot);

  // F01/F06: the PRODUCTION observer inspects the live OCI runtime (shell-free argv,
  // timeout, bounded output), stream-hashes the confirmed snapshot, and checks
  // /v1/models — for every local target — BEFORE the OpenRouter catalog is fetched.
  // The observed binding's digests are RE-COMPUTED from the measured files (never a
  // prefilled digest); an unobservable target (OCI tool / container / mount absent,
  // or any mismatch) yields no observation, so the local gate fails closed with zero
  // OpenRouter calls, zero catalog artifact and zero generation.
  const observerDeps = nodeObserverDeps(now);
  const expectedBindingBySlug = new Map(expectedLocalBindings.map((b) => [b.requestedSlug, b]));
  let observedLocal: LocalTargetBinding[] = [];
  const localPreflight = async (): Promise<LocalPreflightResult> => {
    const reasons: string[] = [];
    const observed: LocalTargetBinding[] = [];
    const resolutions: Array<{ slug: string; resolvedExactly: boolean; reasons: string[] }> = [];
    const evaluatedAtUtc = now();
    for (const expRuntime of expectedLocalRuntimes) {
      const { observation, reasons: obsReasons } = await observeLocalRuntime(expRuntime, observerDeps);
      const binding: LocalTargetBinding =
        observation != null
          ? buildObservedBinding(observation, bareSha256)
          : {
              requestedSlug: expRuntime.requestedSlug,
              endpoint: expRuntime.endpoint,
              healthy: false,
              servedModelId: null,
              checkpointRevision: null,
              weightManifestDigest: null,
              servingConfigDigest: null,
              tensorParallelism: null,
              precision: null,
              capturedAtUtc: now(),
            };
      observed.push(binding);
      const r = resolveLocalTarget(expectedBindingBySlug.get(expRuntime.requestedSlug), binding, evaluatedAtUtc);
      reasons.push(...obsReasons.map((x) => `${expRuntime.requestedSlug}:${x}`), ...r.reasons);
      resolutions.push({ slug: expRuntime.requestedSlug, resolvedExactly: r.resolution.resolvedExactly, reasons: r.reasons });
    }
    observedLocal = observed;
    const ok = expectedLocalRuntimes.length > 0 && resolutions.every((x) => x.resolvedExactly);
    const artifactBody = JSON.stringify(
      { localRuntimePreflightSchemaVersion: 1, evaluatedAtUtc, ok, observed, resolutions, reasons },
      null,
      2,
    );
    return { ok, reasons, observed, artifactBody };
  };

  const result = await runContinuation({
    outputRoot,
    generate: (cell, plan, req) => liveGenerate(cell, plan, req, orKey),
    verifyHistoricalDigests: () => verifyHistoricalDigestsFromFiles(exp),
    localPreflight,
    preflight: () => livePreflight({ orKey, now, expectedLocalBindings, precomputedObserved: observedLocal }),
    planCell: defaultPlanCell,
    buildRequest: defaultBuildRequest,
    now,
    isResume: process.env.CONTINUATION_RESUME === "1",
    // The fresh request plan the resume re-derivation deep-equals the stored request
    // wire against (F02): the exact chat-completions URL + the frozen benchmark messages.
    resumeRequestPlan: async (cell) => {
      const t = TARGETS.find((x) => x.slug === cell.target);
      if (!t) return null;
      const l = await loadBenchmarkById(cell.benchmark);
      return {
        url: `${t.baseUrl}/chat/completions`,
        messages: [
          { role: "system", content: l.systemPrompt },
          { role: "user", content: l.userPrompt },
        ],
      };
    },
  });
  console.log(
    `CONTINUATION executed=${result.summary.executedThisInvocation} ` +
      `cumulativeTerminal=${result.summary.cumulativeTerminalContinuation} ` +
      `passed=${result.summary.cumulativePassedContinuation} failed=${result.summary.cumulativeFailedContinuation} ` +
      `stopped=${result.stopped ?? "no"} overall=${result.summary.overallStatus} ` +
      `summary=${result.summaryFile} manifest=${result.runtimeManifestFile}`,
  );
}

/**
 * Resolve the driver mode. Fail-closed BEFORE any network or credential access:
 * an absent or unknown mode is rejected. The default 24-cell campaign runs only
 * under the explicit "default" mode; the diagnostic continuation runs only under
 * "diagnostic-continuation-r1".
 */
export function resolveDriverMode(raw: string | undefined): "default" | "diagnostic-continuation-r1" {
  if (raw === "default") return "default";
  if (raw === "diagnostic-continuation-r1") return "diagnostic-continuation-r1";
  throw new Error(
    `unknown or absent driver mode ${JSON.stringify(raw)}; set PLINIUS_DRIVER_MODE=default or diagnostic-continuation-r1`,
  );
}

/**
 * Run only when this file is executed directly, never when it is imported (e.g.
 * by the offline tests). This keeps import side-effect free: no mode resolution,
 * no network call and no credential read happen on import.
 */
function invokedDirectly(): boolean {
  try {
    const entry = process.argv[1];
    return entry != null && fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const mode = resolveDriverMode(process.env.PLINIUS_DRIVER_MODE);
  const entry = mode === "diagnostic-continuation-r1" ? continuationMain : main;
  entry().catch((e) => {
    console.error("DRIVER ERROR:", e);
    process.exit(1);
  });
}
