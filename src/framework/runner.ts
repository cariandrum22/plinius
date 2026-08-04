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
import { LoadedFrameworkBenchmark } from "./loader.js";
import { CampaignSpec } from "./campaign.js";

export const FRAMEWORK_RUN_SCHEMA_VERSION = 1;

/** A minimal, content-addressed catalog snapshot for any backend. */
export interface FrameworkCatalogSnapshot {
  snapshotId: string;
  backend: string;
  backendVersion: string;
  models: ModelDescriptor[];
}

/** One execution's captured output. */
export interface RunOutput {
  text: string | null;
  finishReason: string | null;
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

  output: RunOutput;
  metrics: Record<string, number | null>;
  cost: { costModel: string; estimatedUsd: number | null };
  executionProvenance: unknown;
  provenanceStatus: string;

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
  /** Optional per-record progress callback. */
  onRecord?: (record: FrameworkRunRecord, file: string) => void;
}

export interface RunCampaignResult {
  records: FrameworkRunRecord[];
  catalogs: FrameworkCatalogSnapshot[];
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
        const rubricHash = canonicalHash(loaded.rubric);
        const messages: ChatMessage[] = [];
        if (loaded.systemPrompt) messages.push({ role: "system", content: loaded.systemPrompt });
        messages.push({ role: "user", content: loaded.userPrompt });

        const promptSnapshot = buildPromptSnapshot({
          systemPrompt: loaded.systemPrompt,
          userPrompt: loaded.userPrompt,
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

          let output: RunOutput = { text: null, finishReason: null };
          let metrics: Record<string, number | null> = {};
          let cost = { costModel: "UNKNOWN", estimatedUsd: null as number | null };
          let executionProvenance: unknown = null;
          let generationProvenance: GenerationProvenance = toGenerationProvenance(
            backendName,
            model,
            { endpoint: null, model: null, created: null, requestId: null, backendMetadata: null },
            null,
            null,
          );
          let error: { kind: string; message: string } | null = null;

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
            output = { text: result.text, finishReason: result.finishReason };
            metrics = { ...result.metrics };
            cost = { costModel: result.cost.costModel, estimatedUsd: result.cost.estimatedUsd };
            executionProvenance = result.provenance;
            generationProvenance = toGenerationProvenance(
              backendName,
              model,
              result.provenance,
              result.cost.estimatedUsd,
              result.metrics.latencyMs,
            );
          } catch (err) {
            error =
              err instanceof BackendError
                ? { kind: err.kind, message: err.message }
                : { kind: "unknown", message: err instanceof Error ? err.message : String(err) };
          }

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
            output,
            metrics,
            cost,
            executionProvenance,
            provenanceStatus,
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

  return { records, catalogs };
}
