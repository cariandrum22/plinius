/**
 * Backend-independent benchmark runner.
 *
 * The runner is decoupled from any inference vendor: it is given an
 * {@link InferenceBackend} and a prompt profile, renders the exact messages,
 * executes the request, and produces a canonical {@link BenchmarkRunRecord}.
 * It imports no OpenRouter-specific model types.
 */
import { createHash } from "crypto";
import { Benchmark } from "../types/benchmark.js";
import {
  BENCHMARK_RECORD_SCHEMA_VERSION,
  BenchmarkRunRecord,
} from "../types/benchmark.js";
import {
  InferenceBackend,
  InferenceError,
  SamplingConfig,
} from "../types/inference.js";
import { BackendProvenance } from "../types/provenance.js";
import { PromptProfileId, renderMessages } from "../prompts/profiles.js";
import { TargetConfig, resolvedServedModelName } from "../experiment/config.js";

export interface BenchmarkRunnerConfig {
  backend: InferenceBackend;
  target: TargetConfig;
  /** Prompt profile used to render the system/user messages. */
  promptProfile: PromptProfileId;
  /** Sampling parameters applied to every run. */
  sampling: SamplingConfig;
  /** Runtime provenance captured for the deployment (optional). */
  provenance?: BackendProvenance;
  /** Plinius commit SHA to stamp into records, when known. */
  pliniusCommit?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/** Compute a stable content hash for a benchmark prompt. */
export function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf-8").digest("hex")}`;
}

export class BenchmarkRunner {
  private readonly backend: InferenceBackend;
  private readonly target: TargetConfig;
  private readonly promptProfile: PromptProfileId;
  private readonly sampling: SamplingConfig;
  private readonly provenance?: BackendProvenance;
  private readonly pliniusCommit?: string;
  private readonly timeoutMs?: number;

  constructor(config: BenchmarkRunnerConfig) {
    this.backend = config.backend;
    this.target = config.target;
    this.promptProfile = config.promptProfile;
    this.sampling = config.sampling;
    this.provenance = config.provenance;
    this.pliniusCommit = config.pliniusCommit;
    this.timeoutMs = config.timeoutMs;
  }

  /**
   * Run a single benchmark and return its canonical record. Backend failures
   * are captured in `record.error` rather than thrown, so a failed run is
   * still a persistable artifact.
   */
  async runBenchmark(benchmark: Benchmark): Promise<BenchmarkRunRecord> {
    const messages = renderMessages(this.promptProfile, benchmark.content);
    const servedModelName = resolvedServedModelName(this.target);
    const sampling: SamplingConfig = {
      ...this.sampling,
      seed: this.target.seed ?? this.sampling.seed,
    };

    const record: BenchmarkRunRecord = {
      schemaVersion: BENCHMARK_RECORD_SCHEMA_VERSION,
      benchmark: {
        id: benchmark.id,
        contentHash: hashContent(benchmark.content),
      },
      targetId: this.target.id,
      backendId: this.backend.id,
      backendType: this.backend.type,
      model: this.target.model,
      servedModelName,
      promptProfile: String(this.promptProfile),
      messages,
      sampling,
      seed: sampling.seed,
      timestamp: new Date().toISOString(),
      pliniusCommit: this.pliniusCommit,
      provenance: this.provenance,
    };

    try {
      const response = await this.backend.complete({
        model: servedModelName,
        messages,
        sampling,
        timeoutMs: this.timeoutMs,
      });

      record.response = {
        text: response.text,
        finishReason: response.finishReason,
        usage: response.usage,
        latencyMs: response.latencyMs,
        providerRequestId: response.providerRequestId,
        rawMetadata: response.rawMetadata,
      };
    } catch (error) {
      record.error = normalizeError(error);
    }

    return record;
  }
}

function normalizeError(error: unknown): BenchmarkRunRecord["error"] {
  if (error instanceof InferenceError) {
    return { kind: error.kind, message: error.message, status: error.status };
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Persist benchmark records as the canonical JSON artifact.
 */
export async function saveBenchmarkRecords(
  records: BenchmarkRunRecord[],
  outputPath: string,
): Promise<void> {
  const { writeFile } = await import("fs/promises");
  await writeFile(outputPath, JSON.stringify(records, null, 2), "utf-8");
}

/**
 * Derive a human-readable Markdown report from a canonical record.
 * Markdown is a derived view; JSON remains the source of truth.
 */
export function formatRecordAsMarkdown(record: BenchmarkRunRecord): string {
  const usage = record.response?.usage;
  const lines: string[] = [
    `# Benchmark Result: ${record.benchmark.id} — ${record.targetId}`,
    "",
    `**Timestamp:** ${record.timestamp}`,
    `**Target:** ${record.targetId}`,
    `**Backend:** ${record.backendId} (${record.backendType})`,
    `**Logical model:** ${record.model}`,
    `**Served model:** ${record.servedModelName}`,
    `**Prompt profile:** ${record.promptProfile}`,
    `**Seed:** ${record.seed ?? "N/A"}`,
  ];

  if (record.response) {
    lines.push(
      `**Latency:** ${record.response.latencyMs}ms`,
      `**Finish reason:** ${record.response.finishReason ?? "N/A"}`,
      `**Tokens:** ${usage?.totalTokens ?? "N/A"} (prompt: ${usage?.promptTokens ?? "N/A"}, completion: ${usage?.completionTokens ?? "N/A"})`,
    );
  }

  if (record.provenance) {
    const p = record.provenance;
    lines.push(
      "",
      "## Runtime Provenance",
      "",
      `- Backend URL: ${p.backendUrl ?? "N/A"}`,
      `- Runtime: ${p.runtime?.name ?? "N/A"} ${p.runtime?.version ?? ""}`.trim(),
      `- Image: ${p.containerImage ?? "N/A"} (${p.containerDigest ?? "no digest"})`,
      `- Model repo: ${p.modelRepo ?? "N/A"} @ ${p.modelRevision ?? "N/A"}`,
      `- dtype/quant: ${p.dtype ?? "N/A"} / ${p.quantization === null ? "none" : (p.quantization ?? "N/A")}`,
      `- TP size: ${p.tensorParallelSize ?? "N/A"}, max_model_len: ${p.maxModelLen ?? "N/A"}`,
      `- GPU: ${p.gpu?.count ?? "N/A"} × ${p.gpu?.model ?? "N/A"}`,
    );
    if (p.missingFields.length > 0) {
      lines.push(`- Missing provenance fields: ${p.missingFields.join(", ")}`);
    }
  }

  lines.push(
    "",
    "---",
    "",
    "## Prompt (exact messages)",
    "",
    "```json",
    JSON.stringify(record.messages, null, 2),
    "```",
    "",
    "---",
    "",
    "## Response",
    "",
  );

  if (record.error) {
    lines.push(`**ERROR (${record.error.kind}):** ${record.error.message}`);
  } else {
    lines.push(record.response?.text ?? "");
  }

  return lines.join("\n") + "\n";
}
