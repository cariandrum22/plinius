/**
 * Benchmark Framework — Campaign Runner.
 *
 * Executes a Campaign deterministically: for every (backend × model × benchmark
 * × repetition), in sorted order, it renders the prompt, executes against the
 * Execution Backend, and persists a self-contained Execution Artifact that
 * reuses the existing Prompt Snapshot, Catalog Snapshot, Manifest, Environment,
 * and Provenance primitives.
 *
 * Generation and artifact capture only — no scoring, no judging. IDs are content
 * hashes with no timestamp, so re-running an unchanged campaign reproduces the
 * same run ids and overwrites the same files.
 */
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { ChatMessage } from "../types/inference.js";
import { ExecutionBackend } from "../backend/interface.js";
import { BackendError } from "../backend/errors.js";
import { ModelDescriptor } from "../backend/types.js";
import { buildPromptSnapshot, PromptSnapshot } from "../prompt/snapshot.js";
import { captureEnvironment, EvaluationEnvironment } from "../environment/environment.js";
import { buildManifest, EvaluationManifest } from "../manifest/manifest.js";
import {
  GenerationProvenance,
  GENERATION_PROVENANCE_SCHEMA_VERSION,
  classifyProvenance,
} from "../provenance/schema.js";
import { canonicalHash } from "../suite/hash.js";
import {
  captureReferenceAsset,
  captureRubric,
  hashRawResponse,
  ReferenceAssetCapture,
} from "../completeness/assets.js";
import {
  CanonicalFinishReason,
  FinishReasonMapping,
  finishReasonTable,
  mapFinishReason,
} from "../completeness/finish-reason.js";
import { normalizeCompletion, NormalizedCompletion } from "../completeness/normalize.js";
import {
  classifyRun,
  FinalCompletenessStatus,
  QualificationStatus,
  ResponseStatus,
  TransportStatus,
} from "../completeness/status.js";
import { LoadedFrameworkBenchmark } from "./loader.js";
import { CampaignSpec } from "./campaign.js";

/**
 * Framework run record schema version.
 *
 * Version 2 is a breaking shape change over version 1: every attempt now carries
 * its own `generationProvenance`, and the record's headline `generationProvenance`
 * is derived strictly from the final attempt (so a run whose last attempt is a
 * transport failure never inherits an earlier attempt's request id or model
 * metadata). No migration is provided — version 1 records (the sentinel run
 * record and the parent Evidence) are read-only historical artifacts and are
 * never rewritten in place. The `schemaVersion` field is the sole discriminator.
 */
export const FRAMEWORK_RUN_SCHEMA_VERSION = 2;

/** A minimal, content-addressed catalog snapshot for any backend. */
export interface FrameworkCatalogSnapshot {
  snapshotId: string;
  backend: string;
  backendVersion: string;
  models: ModelDescriptor[];
}

/**
 * One execution's captured output.
 *
 * `text` is the message content as delivered. `reasoningText` and `finalAnswer`
 * are the separated halves — reasoning is never substituted for the final
 * answer, and an empty final answer stays empty rather than borrowing the
 * reasoning to look complete.
 */
export interface RunOutput {
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

/** The four independent statuses of one run. Never collapsed into one flag. */
export interface RunStatusRecord {
  transport: TransportStatus;
  response: ResponseStatus;
  finalCompleteness: FinalCompletenessStatus;
  qualification: QualificationStatus;
  failureReasons: string[];
}

/**
 * One attempt at a logical run. Every attempt is retained — including the ones
 * that failed and the cost they incurred — so a retried run never hides its
 * first outcome.
 */
export interface RunAttempt {
  attemptIndex: number;
  timestamp: string;
  status: RunStatusRecord;
  output: RunOutput;
  /** The provider payload verbatim, exactly as received. */
  rawResponse: unknown;
  rawResponseSha256: string | null;
  rawResponseBytes: number | null;
  finishReasonMapping: FinishReasonMapping;
  metrics: Record<string, number | null>;
  cost: { costModel: string; estimatedUsd: number | null };
  executionProvenance: unknown;
  /**
   * The GenerationProvenance for THIS attempt only. A failed transport attempt
   * carries the empty provenance (no endpoint, request id, or model metadata);
   * it never inherits provenance from an earlier attempt of the same run.
   */
  generationProvenance: GenerationProvenance;
  error: { kind: string; message: string } | null;
}

function emptyOutput(): RunOutput {
  return {
    text: null,
    finishReason: null,
    reasoningText: null,
    reasoningSource: "none",
    finalAnswer: null,
    finalAnswerSource: "none",
    finalAnswerIsEmpty: true,
    reasoningOnly: false,
    normalizerError: null,
  };
}

function toRunOutput(text: string | null, finishReason: string | null, n: NormalizedCompletion): RunOutput {
  return {
    text,
    finishReason,
    reasoningText: n.reasoningText,
    reasoningSource: n.reasoningSource,
    finalAnswer: n.finalAnswer,
    finalAnswerSource: n.finalAnswerSource,
    finalAnswerIsEmpty: n.finalAnswerIsEmpty,
    reasoningOnly: n.reasoningOnly,
    normalizerError: n.normalizerError,
  };
}

/** A self-contained Execution Artifact (requirement 8). */
export interface FrameworkRunRecord {
  schemaVersion: number;
  runId: string;
  campaignId: string;
  benchmarkId: string;
  benchmarkVersion: string;
  benchmarkContentHash: string;
  rubricHash: string;
  golden: boolean;
  category: string;
  backend: string;
  backendVersion: string;
  model: string;
  repetitionIndex: number;
  timestamp: string;
  excludeFromRankings: boolean;

  promptSnapshot: PromptSnapshot;
  catalogSnapshotId: string;
  environment: EvaluationEnvironment;

  /**
   * Reference asset status and hash. Carried beside the content hash and
   * deliberately NOT folded into the content-hash preimage, so historical
   * `benchmarkContentHash` values stay reproducible.
   */
  referenceAsset: ReferenceAssetCapture;

  output: RunOutput;
  metrics: Record<string, number | null>;
  cost: { costModel: string; estimatedUsd: number | null };
  executionProvenance: unknown;
  /** Headline provenance — derived strictly from the final attempt. */
  generationProvenance: GenerationProvenance;
  provenanceStatus: string;

  /** The final attempt's provider payload, verbatim, and its digest. */
  rawResponse: unknown;
  rawResponseSha256: string | null;
  rawResponseBytes: number | null;

  /** Raw provider finish reason, its canonical mapping, and the table used. */
  finishReasonMapping: FinishReasonMapping;
  finishReasonTable: Record<string, CanonicalFinishReason>;

  /** The four independent statuses of this logical run. */
  status: RunStatusRecord;

  /** One logical run, one or more attempts. Every attempt is retained. */
  attemptCount: number;
  attempts: RunAttempt[];

  /** Reuses the existing EvaluationManifest binding. */
  manifest: EvaluationManifest;

  error: { kind: string; message: string } | null;
}

/** Deterministic run id: content hash of the identifying inputs (no timestamp). */
export function computeRunId(parts: {
  campaignId: string;
  benchmarkId: string;
  benchmarkContentHash: string;
  backend: string;
  model: string;
  repetitionIndex: number;
  promptId: string;
}): string {
  return `run-${canonicalHash(parts).slice("sha256:".length, "sha256:".length + 16)}`;
}

/** Build a content-addressed catalog snapshot from a backend's served models. */
export function buildCatalogSnapshot(
  backend: string,
  backendVersion: string,
  models: ModelDescriptor[],
): FrameworkCatalogSnapshot {
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
  const snapshotId = `catalog-${canonicalHash({ backend, models: sorted }).slice("sha256:".length, "sha256:".length + 16)}`;
  return { snapshotId, backend, backendVersion, models: sorted };
}

/** Map ExecutionProvenance + cost/metrics to a GenerationProvenance (facts only). */
function toGenerationProvenance(
  backend: string,
  model: string,
  provenance: {
    endpoint: string | null;
    model: string | null;
    created: string | null;
    requestId: string | null;
    backendMetadata: Record<string, unknown> | null;
  },
  costUsd: number | null,
  latencyMs: number | null,
): GenerationProvenance {
  const gp: GenerationProvenance = {
    schemaVersion: GENERATION_PROVENANCE_SCHEMA_VERSION,
    provider: backend,
    endpoint: provenance.endpoint,
    generationId: provenance.requestId,
    model: provenance.model ?? model,
    canonicalSlug: provenance.model ?? model,
    requestedSlug: model,
    pricing: { totalCostUsd: costUsd, promptCostUsd: null, completionCostUsd: null },
    latencyMs,
    createdAt: provenance.created,
    region: null,
    contextLength: null,
    quantization: null,
    providerMetadata: provenance.backendMetadata,
  };
  return gp;
}

/** Provenance for an attempt that produced no response (e.g. transport failure). */
function emptyGenerationProvenance(backend: string, model: string): GenerationProvenance {
  return toGenerationProvenance(
    backend,
    model,
    { endpoint: null, model: null, created: null, requestId: null, backendMetadata: null },
    null,
    null,
  );
}

function seedFor(spec: CampaignSpec, rep: number): number {
  return spec.sampling.seedStrategy === "fixed"
    ? spec.sampling.seed
    : spec.sampling.seed + rep;
}

export interface RunCampaignDeps {
  spec: CampaignSpec;
  benchmarks: LoadedFrameworkBenchmark[];
  /** Resolve a registered backend by name. */
  resolveBackend: (name: string) => ExecutionBackend;
  /** Directory to write execution artifacts into. */
  outputDir: string;
  /** Injected clock for the timestamp field (never used in any id). */
  now: () => string;
  /**
   * Attempts allowed per logical run. Defaults to 1. Retries stop as soon as an
   * attempt qualifies; every attempt made is kept on the record either way.
   */
  maxAttempts?: number;
  /** Optional per-record progress callback. */
  onRecord?: (record: FrameworkRunRecord, file: string) => void;
}

export interface RunCampaignResult {
  records: FrameworkRunRecord[];
  catalogs: FrameworkCatalogSnapshot[];
  /** Logical runs and attempts are counted separately and never conflated. */
  logicalRunCount: number;
  attemptCount: number;
}

/**
 * Run the campaign. Backends, models, and benchmarks are iterated in sorted
 * order; each repetition is an independent artifact. Individual execution
 * failures are captured on the record — the campaign never throws for a single
 * failed generation.
 */
export async function runCampaign(deps: RunCampaignDeps): Promise<RunCampaignResult> {
  const { spec } = deps;
  const backends = [...spec.backends].sort();
  const models = [...spec.models].sort();
  const benchmarks = [...deps.benchmarks].sort((a, b) => a.asset.id.localeCompare(b.asset.id));
  const environment = captureEnvironment();

  await mkdir(deps.outputDir, { recursive: true });

  const catalogs: FrameworkCatalogSnapshot[] = [];
  const catalogByBackend = new Map<string, FrameworkCatalogSnapshot>();
  const records: FrameworkRunRecord[] = [];

  for (const backendName of backends) {
    const backend = deps.resolveBackend(backendName);
    const backendVersion = backend.version();

    // One catalog snapshot per backend, captured once.
    if (!catalogByBackend.has(backendName)) {
      let discovered: ModelDescriptor[] = [];
      try {
        discovered = await backend.discoverModels();
      } catch {
        discovered = [];
      }
      const snapshot = buildCatalogSnapshot(backendName, backendVersion, discovered);
      catalogByBackend.set(backendName, snapshot);
      catalogs.push(snapshot);
    }
    const catalog = catalogByBackend.get(backendName)!;

    for (const model of models) {
      for (const loaded of benchmarks) {
        const { asset } = loaded;
        // The rubric is hashed from the very bytes that get stored, so the hash
        // is always re-derivable from the snapshot itself.
        const rubricCapture = captureRubric(loaded.rubric);
        const rubricHash = rubricCapture.rubricHash;
        const referenceAsset = captureReferenceAsset(loaded.references);

        // The provider sees the system and user prompts only. The rubric is
        // captured for the record but never sent — the model must not be shown
        // the criteria it will be judged against.
        const messages: ChatMessage[] = [];
        if (loaded.systemPrompt) messages.push({ role: "system", content: loaded.systemPrompt });
        messages.push({ role: "user", content: loaded.userPrompt });

        const promptSnapshot = buildPromptSnapshot({
          systemPrompt: loaded.systemPrompt,
          userPrompt: loaded.userPrompt,
          rubric: rubricCapture.canonicalString,
        });

        for (let rep = 0; rep < spec.repetitions; rep++) {
          const seed = seedFor(spec, rep);
          const runId = computeRunId({
            campaignId: spec.id,
            benchmarkId: asset.id,
            benchmarkContentHash: loaded.contentHash,
            backend: backendName,
            model,
            repetitionIndex: rep,
            promptId: promptSnapshot.promptId,
          });

          // One logical run, one or more attempts. Every attempt is retained
          // with its own cost and failed response; the run's headline fields
          // come from the last attempt.
          const maxAttempts = Math.max(1, deps.maxAttempts ?? 1);
          const attempts: RunAttempt[] = [];

          for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
            let attemptError: { kind: string; message: string } | null = null;
            let rawResponse: unknown = null;
            let attemptOutput: RunOutput = emptyOutput();
            let attemptMetrics: Record<string, number | null> = {};
            let attemptCost = { costModel: "UNKNOWN", estimatedUsd: null as number | null };
            let attemptProvenance: unknown = null;
            let finishMapping: FinishReasonMapping = mapFinishReason(null);
            let normalized: NormalizedCompletion | null = null;
            // Each attempt owns its provenance. It stays empty unless THIS attempt
            // produced a response, so a later transport failure cannot inherit an
            // earlier attempt's request id or model metadata.
            let attemptGenerationProvenance: GenerationProvenance = emptyGenerationProvenance(
              backendName,
              model,
            );

            try {
              const result = await backend.execute({
                model,
                messages,
                sampling: {
                  temperature: spec.sampling.temperature,
                  topP: spec.sampling.topP,
                  maxTokens: spec.sampling.maxTokens ?? asset.estimatedTokens,
                  seed,
                },
              });
              rawResponse = result.raw;
              normalized = normalizeCompletion({ rawResponse: result.raw, text: result.text });
              finishMapping = mapFinishReason(result.finishReason);
              attemptOutput = toRunOutput(result.text, result.finishReason, normalized);
              attemptMetrics = { ...result.metrics };
              attemptCost = { costModel: result.cost.costModel, estimatedUsd: result.cost.estimatedUsd };
              attemptProvenance = result.provenance;
              attemptGenerationProvenance = toGenerationProvenance(
                backendName,
                model,
                result.provenance,
                result.cost.estimatedUsd,
                result.metrics.latencyMs,
              );
            } catch (err) {
              attemptError =
                err instanceof BackendError
                  ? { kind: err.kind, message: err.message }
                  : { kind: "unknown", message: err instanceof Error ? err.message : String(err) };
            }

            const status = classifyRun({
              transportError: attemptError,
              normalized,
              finishReason: finishMapping,
            });
            const rawDigest = rawResponse === null ? null : hashRawResponse(rawResponse);
            attempts.push({
              attemptIndex,
              timestamp: deps.now(),
              status,
              output: attemptOutput,
              rawResponse,
              rawResponseSha256: rawDigest?.sha256 ?? null,
              rawResponseBytes: rawDigest?.byteLength ?? null,
              finishReasonMapping: finishMapping,
              metrics: attemptMetrics,
              cost: attemptCost,
              executionProvenance: attemptProvenance,
              generationProvenance: attemptGenerationProvenance,
              error: attemptError,
            });

            if (status.qualification === "pass") break;
          }

          // Every headline field — output, cost, error, and provenance — is
          // derived from the final attempt and nothing else.
          const last = attempts[attempts.length - 1];
          const output = last.output;
          const metrics = last.metrics;
          const cost = last.cost;
          const executionProvenance = last.executionProvenance;
          const generationProvenance = last.generationProvenance;
          const error = last.error;

          const provenanceStatus = classifyProvenance(generationProvenance);
          const manifest = buildManifest({
            campaignId: spec.id,
            runId,
            catalogSnapshotId: catalog.snapshotId,
            promptSnapshotId: promptSnapshot.promptId,
            environment,
            targetModels: [
              {
                targetId: `${backendName}:${model}`,
                requestedSlug: model,
                canonicalSlug: generationProvenance.canonicalSlug,
                lifecycle: "UNKNOWN",
                provenanceStatus,
              },
            ],
            profiles: [],
            timestamp: deps.now(),
            generationProvenance: [generationProvenance],
            backend: backendName,
            backendVersion,
          });

          const record: FrameworkRunRecord = {
            schemaVersion: FRAMEWORK_RUN_SCHEMA_VERSION,
            runId,
            campaignId: spec.id,
            benchmarkId: asset.id,
            benchmarkVersion: asset.version,
            benchmarkContentHash: loaded.contentHash,
            rubricHash,
            golden: asset.golden,
            category: asset.category,
            backend: backendName,
            backendVersion,
            model,
            repetitionIndex: rep,
            timestamp: deps.now(),
            excludeFromRankings: spec.excludeFromRankings,
            promptSnapshot,
            catalogSnapshotId: catalog.snapshotId,
            environment,
            referenceAsset,
            output,
            metrics,
            cost,
            executionProvenance,
            generationProvenance,
            provenanceStatus,
            rawResponse: last.rawResponse,
            rawResponseSha256: last.rawResponseSha256,
            rawResponseBytes: last.rawResponseBytes,
            finishReasonMapping: last.finishReasonMapping,
            finishReasonTable: finishReasonTable(),
            status: last.status,
            attemptCount: attempts.length,
            attempts,
            manifest,
            error,
          };

          const file = join(deps.outputDir, `${runId}.json`);
          await writeFile(file, JSON.stringify(record, null, 2), "utf-8");
          records.push(record);
          deps.onRecord?.(record, file);
        }
      }
    }
  }

  // Persist catalog snapshots alongside the run records.
  const catalogDir = join(deps.outputDir, "catalog");
  await mkdir(catalogDir, { recursive: true });
  for (const catalog of catalogs) {
    await writeFile(
      join(catalogDir, `${catalog.snapshotId}.json`),
      JSON.stringify(catalog, null, 2),
      "utf-8",
    );
  }

  return {
    records,
    catalogs,
    logicalRunCount: records.length,
    attemptCount: records.reduce((sum, r) => sum + r.attemptCount, 0),
  };
}
