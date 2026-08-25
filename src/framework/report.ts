/**
 * Benchmark Framework — Campaign Report (requirement 13).
 *
 * Produces both a machine-readable JSON report and a derived Markdown view from
 * the campaign spec, run records, review set, and per-model aggregates. The JSON
 * is authoritative; the Markdown is rendered from it. No scoring or statistics
 * are computed here beyond the simple aggregates already produced — the report
 * only summarizes facts.
 */
import { CampaignSpec } from "./campaign.js";
import { FrameworkRunRecord, RunAttempt } from "./runner.js";
import { ReviewSet, reviewStateCounts } from "./review.js";
import { ModelAggregate } from "./aggregate.js";

/**
 * Campaign report schema version.
 *
 * Version 2 is a breaking shape change over version 1. The cost summary now sums
 * EVERY attempt of every logical run (version 1 summed only each run's headline,
 * i.e. its final attempt) and counts logical runs and attempts as distinct
 * units. Version 2 also carries no `succeeded`/`failed` fields: the collapsed
 * "succeeded" count of the old pipeline — which reported truncated and empty
 * runs as successes — is deliberately absent, replaced by the separate transport
 * / response / final-completeness / qualification counts. No migration is
 * provided; version 1 reports are read-only historical artifacts.
 */
export const REPORT_SCHEMA_VERSION = 2;

export interface BackendSummary {
  backend: string;
  backendVersion: string;
  runs: number;
  costModel: string;
}

export interface BenchmarkSummary {
  benchmarkId: string;
  version: string;
  category: string;
  runs: number;
}

/**
 * Cost accounting.
 *
 * Every figure here is summed over ATTEMPTS, not logical runs: a retried run's
 * earlier attempts each incurred cost and must be counted. Logical runs and
 * attempts are reported as separate units, and an attempt whose cost is unknown
 * is counted as unknown — never coerced to $0.
 */
export interface CostSummary {
  /** Sum over every attempt with a known cost. Null when no attempt cost is known. */
  totalEstimatedUsd: number | null;
  /** One per backend×model×benchmark×repetition. */
  logicalRuns: number;
  /** Total attempts across all logical runs (≥ logicalRuns). */
  attempts: number;
  attemptsWithKnownCost: number;
  attemptsWithUnknownCost: number;
  byBackend: {
    backend: string;
    costModel: string;
    estimatedUsd: number | null;
    attempts: number;
    attemptsWithKnownCost: number;
  }[];
}

/**
 * Per-attempt costs for one record, with a fail-compatible fallback: a legacy
 * record that predates the attempts array is treated as exactly one attempt
 * carrying the headline cost, so it is neither dropped nor double-counted.
 */
function attemptCostsOf(r: FrameworkRunRecord): { costModel: string; estimatedUsd: number | null }[] {
  const attempts = (r as { attempts?: RunAttempt[] }).attempts;
  if (Array.isArray(attempts) && attempts.length > 0) {
    return attempts.map((a) => ({
      costModel: a.cost?.costModel ?? "UNKNOWN",
      estimatedUsd: a.cost?.estimatedUsd ?? null,
    }));
  }
  return [{ costModel: r.cost?.costModel ?? "UNKNOWN", estimatedUsd: r.cost?.estimatedUsd ?? null }];
}

/**
 * Runtime counts.
 *
 * The four completeness levels are reported separately and never merged. A
 * transport success is only that: it says the call came back, not that a usable
 * answer did. `qualified` is the sole count that means a complete final answer
 * on an accepted terminal finish reason.
 */
export interface RuntimeSummary {
  totalRuns: number;
  /** Logical runs and attempts are counted separately. */
  logicalRuns: number;
  attempts: number;
  /** The call completed at the transport layer. NOT a quality signal. */
  transportOk: number;
  transportFailed: number;
  /** A readable provider payload came back. */
  responseReceived: number;
  /** Non-empty final answer, distinct from reasoning. */
  finalComplete: number;
  emptyFinal: number;
  reasoningOnly: number;
  truncated: number;
  filtered: number;
  normalizerError: number;
  /** Complete final answer AND accepted terminal finish reason. */
  qualified: number;
  notQualified: number;
  /** Canonical finish reason histogram. */
  finishReasons: Record<string, number>;
  averageLatencyMs: number | null;
}

export interface CampaignReport {
  schemaVersion: number;
  generatedAt: string;
  campaign: { id: string; title: string; description: string; excludeFromRankings: boolean };
  models: ModelAggregate[];
  backends: BackendSummary[];
  benchmarks: BenchmarkSummary[];
  reviewSummary: {
    reviewSetId: string | null;
    total: number;
    states: Record<string, number>;
  };
  cost: CostSummary;
  runtime: RuntimeSummary;
  knownLimitations: string[];
}

function round(value: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export interface BuildReportInput {
  spec: CampaignSpec;
  records: FrameworkRunRecord[];
  aggregates: ModelAggregate[];
  reviewSet: ReviewSet | null;
  generatedAt: string;
}

export function buildCampaignReport(input: BuildReportInput): CampaignReport {
  const { spec, records } = input;

  // Backends.
  const backendMap = new Map<string, BackendSummary>();
  for (const r of records) {
    const existing = backendMap.get(r.backend);
    if (existing) existing.runs += 1;
    else
      backendMap.set(r.backend, {
        backend: r.backend,
        backendVersion: r.backendVersion,
        runs: 1,
        costModel: r.cost.costModel,
      });
  }
  const backends = [...backendMap.values()].sort((a, b) => a.backend.localeCompare(b.backend));

  // Benchmarks.
  const benchMap = new Map<string, BenchmarkSummary>();
  for (const r of records) {
    const existing = benchMap.get(r.benchmarkId);
    if (existing) existing.runs += 1;
    else
      benchMap.set(r.benchmarkId, {
        benchmarkId: r.benchmarkId,
        version: r.benchmarkVersion,
        category: r.category,
        runs: 1,
      });
  }
  const benchmarks = [...benchMap.values()].sort((a, b) => a.benchmarkId.localeCompare(b.benchmarkId));

  // Cost — summed over EVERY attempt of every logical run. A retried run's
  // earlier attempts still cost money and are never dropped from the total.
  const allAttemptCosts = records.flatMap((r) => attemptCostsOf(r));
  const knownAttemptCosts = allAttemptCosts.filter((c) => c.estimatedUsd !== null);
  const costByBackend = new Map<
    string,
    { costModel: string; estimatedUsd: number | null; attempts: number; attemptsWithKnownCost: number }
  >();
  for (const r of records) {
    const costs = attemptCostsOf(r);
    const c =
      costByBackend.get(r.backend) ??
      { costModel: r.cost?.costModel ?? costs[0]?.costModel ?? "UNKNOWN", estimatedUsd: null, attempts: 0, attemptsWithKnownCost: 0 };
    for (const ac of costs) {
      c.attempts += 1;
      if (ac.estimatedUsd !== null) {
        c.estimatedUsd = (c.estimatedUsd ?? 0) + ac.estimatedUsd;
        c.attemptsWithKnownCost += 1;
      }
    }
    costByBackend.set(r.backend, c);
  }
  const cost: CostSummary = {
    totalEstimatedUsd:
      knownAttemptCosts.length > 0 ? round(sum(knownAttemptCosts.map((c) => c.estimatedUsd!))) : null,
    logicalRuns: records.length,
    attempts: allAttemptCosts.length,
    attemptsWithKnownCost: knownAttemptCosts.length,
    attemptsWithUnknownCost: allAttemptCosts.length - knownAttemptCosts.length,
    byBackend: [...costByBackend.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([backend, c]) => ({
        backend,
        costModel: c.costModel,
        estimatedUsd: c.estimatedUsd === null ? null : round(c.estimatedUsd),
        attempts: c.attempts,
        attemptsWithKnownCost: c.attemptsWithKnownCost,
      })),
  };

  // Runtime. Each completeness level is counted on its own terms; a transport
  // success is never promoted into a quality result.
  const failed = records.filter((r) => r.error !== null).length;
  const countFinal = (s: string) =>
    records.filter((r) => r.status?.finalCompleteness === s).length;
  const finishReasons: Record<string, number> = {};
  for (const r of records) {
    const key = r.finishReasonMapping?.canonical ?? "unknown";
    finishReasons[key] = (finishReasons[key] ?? 0) + 1;
  }
  const qualified = records.filter((r) => r.status?.qualification === "pass").length;
  const latencies = records
    .map((r) => (typeof r.metrics.latencyMs === "number" ? r.metrics.latencyMs : null))
    .filter((x): x is number => x !== null);
  const runtime: RuntimeSummary = {
    totalRuns: records.length,
    logicalRuns: records.length,
    attempts: records.reduce((n, r) => n + (r.attemptCount ?? 1), 0),
    transportOk: records.filter((r) => r.status?.transport === "ok").length,
    transportFailed: records.filter((r) => r.status?.transport !== "ok").length,
    responseReceived: records.filter((r) => r.status?.response === "received").length,
    finalComplete: countFinal("complete"),
    emptyFinal: countFinal("empty_final"),
    reasoningOnly: countFinal("reasoning_only"),
    truncated: countFinal("truncated"),
    filtered: countFinal("filtered"),
    normalizerError: countFinal("normalizer_error"),
    qualified,
    notQualified: records.length - qualified,
    finishReasons,
    averageLatencyMs: latencies.length > 0 ? round(sum(latencies) / latencies.length, 1) : null,
  };

  // Known limitations (facts only).
  const knownLimitations: string[] = [
    "No LLM judge in this phase — scores come from blind human review only.",
    "Simple aggregation only — no statistical analysis, ranking, Elo, or Bradley-Terry.",
  ];
  if (spec.excludeFromRankings) {
    knownLimitations.push("Campaign is marked excludeFromRankings; results must not contribute to rankings.");
  }
  if (failed > 0) knownLimitations.push(`${failed} run(s) failed to generate and carry no output.`);
  const unreviewedModels = input.aggregates.filter((m) => m.reviewedCount === 0).map((m) => m.model);
  if (!input.reviewSet) {
    knownLimitations.push("No review set finalized — model scores are not yet available.");
  } else if (unreviewedModels.length > 0) {
    knownLimitations.push(`No reviewed scores for: ${unreviewedModels.join(", ")}.`);
  }

  const stateCounts = input.reviewSet ? reviewStateCounts(input.reviewSet) : {};

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    campaign: {
      id: spec.id,
      title: spec.title,
      description: spec.description,
      excludeFromRankings: spec.excludeFromRankings,
    },
    models: input.aggregates,
    backends,
    benchmarks,
    reviewSummary: {
      reviewSetId: input.reviewSet?.reviewSetId ?? null,
      total: input.reviewSet?.tasks.length ?? 0,
      states: stateCounts,
    },
    cost,
    runtime,
    knownLimitations,
  };
}

/** Render the JSON report as Markdown. Deterministic; derived from the report. */
export function renderReportMarkdown(report: CampaignReport): string {
  const lines: string[] = [];
  const p = (s = "") => lines.push(s);

  p(`# Campaign Report — ${report.campaign.title}`);
  p();
  p(`- **Campaign:** \`${report.campaign.id}\``);
  p(`- **Generated:** ${report.generatedAt}`);
  if (report.campaign.description) p(`- **Description:** ${report.campaign.description}`);
  p(`- **Excluded from rankings:** ${report.campaign.excludeFromRankings ? "yes" : "no"}`);
  p();

  p(`## Campaign Summary`);
  p();
  p(
    `- Runs: ${report.runtime.logicalRuns} logical / ${report.runtime.attempts} attempts ` +
      `(qualified ${report.runtime.qualified}, not qualified ${report.runtime.notQualified})`,
  );
  p(
    `- Transport ok ${report.runtime.transportOk} · response received ${report.runtime.responseReceived} · ` +
      `final complete ${report.runtime.finalComplete} — a transport success is not a complete answer`,
  );
  p(`- Models: ${report.models.length}`);
  p(`- Backends: ${report.backends.map((b) => b.backend).join(", ") || "—"}`);
  p(`- Benchmarks: ${report.benchmarks.length}`);
  p();

  p(`## Models`);
  p();
  if (report.models.length === 0) {
    p(`_No reviewed model results yet._`);
  } else {
    p(`| Model | Avg score | Reviewed | Categories |`);
    p(`|---|---|---|---|`);
    for (const m of report.models) {
      const cats = m.categorySummary.map((c) => `${c.category}:${round(c.averageScore, 2)}`).join(", ");
      p(`| ${m.model} | ${m.averageScore === null ? "—" : round(m.averageScore, 2)} | ${m.reviewedCount} | ${cats || "—"} |`);
    }
    p();
    for (const m of report.models) {
      if (m.strengths.length === 0 && m.weaknesses.length === 0) continue;
      p(`### ${m.model}`);
      if (m.strengths.length > 0) {
        p(`**Strengths**`);
        for (const s of m.strengths) p(`- ${s}`);
      }
      if (m.weaknesses.length > 0) {
        p(`**Weaknesses**`);
        for (const w of m.weaknesses) p(`- ${w}`);
      }
      p();
    }
  }
  p();

  p(`## Backend`);
  p();
  p(`| Backend | Version | Runs | Cost model |`);
  p(`|---|---|---|---|`);
  for (const b of report.backends) p(`| ${b.backend} | ${b.backendVersion} | ${b.runs} | ${b.costModel} |`);
  p();

  p(`## Benchmarks`);
  p();
  p(`| Benchmark | Version | Category | Runs |`);
  p(`|---|---|---|---|`);
  for (const b of report.benchmarks) p(`| ${b.benchmarkId} | ${b.version} | ${b.category} | ${b.runs} |`);
  p();

  p(`## Review Summary`);
  p();
  if (report.reviewSummary.reviewSetId) {
    p(`- Review set: \`${report.reviewSummary.reviewSetId}\` (${report.reviewSummary.total} tasks)`);
    const states = Object.entries(report.reviewSummary.states)
      .map(([s, n]) => `${s}: ${n}`)
      .join(", ");
    p(`- States: ${states}`);
  } else {
    p(`_No review set created._`);
  }
  p();

  p(`## Cost`);
  p();
  p(
    `- Total estimated: ${report.cost.totalEstimatedUsd === null ? "unknown" : `$${report.cost.totalEstimatedUsd}`} ` +
      `(summed over all attempts)`,
  );
  p(
    `- Logical runs: ${report.cost.logicalRuns} · attempts: ${report.cost.attempts} ` +
      `(cost known ${report.cost.attemptsWithKnownCost}, unknown ${report.cost.attemptsWithUnknownCost})`,
  );
  for (const b of report.cost.byBackend) {
    p(
      `  - ${b.backend}: ${b.costModel}${b.estimatedUsd === null ? "" : ` ($${b.estimatedUsd})`} ` +
        `over ${b.attempts} attempt(s)`,
    );
  }
  p();

  p(`## Runtime`);
  p();
  p(`- Total runs: ${report.runtime.totalRuns}`);
  p(
    `- Qualified: ${report.runtime.qualified} · Not qualified: ${report.runtime.notQualified} ` +
      `(empty final ${report.runtime.emptyFinal}, reasoning-only ${report.runtime.reasoningOnly}, ` +
      `truncated ${report.runtime.truncated}, filtered ${report.runtime.filtered}, ` +
      `normalizer error ${report.runtime.normalizerError}, transport failed ${report.runtime.transportFailed})`,
  );
  p(`- Average latency: ${report.runtime.averageLatencyMs === null ? "unknown" : `${report.runtime.averageLatencyMs} ms`}`);
  p();

  p(`## Known Limitations`);
  p();
  for (const l of report.knownLimitations) p(`- ${l}`);
  p();

  return lines.join("\n");
}
