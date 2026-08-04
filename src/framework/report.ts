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
import { FrameworkRunRecord } from "./runner.js";
import { ReviewSet, reviewStateCounts } from "./review.js";
import { ModelAggregate } from "./aggregate.js";

export const REPORT_SCHEMA_VERSION = 1;

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

export interface CostSummary {
  totalEstimatedUsd: number | null;
  runsWithCost: number;
  runsWithoutCost: number;
  byBackend: { backend: string; costModel: string; estimatedUsd: number | null }[];
}

export interface RuntimeSummary {
  totalRuns: number;
  succeeded: number;
  failed: number;
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

  // Cost.
  const withCost = records.filter((r) => r.cost.estimatedUsd !== null);
  const costByBackend = new Map<string, { costModel: string; estimatedUsd: number | null }>();
  for (const r of records) {
    const c = costByBackend.get(r.backend) ?? { costModel: r.cost.costModel, estimatedUsd: null };
    if (r.cost.estimatedUsd !== null) c.estimatedUsd = (c.estimatedUsd ?? 0) + r.cost.estimatedUsd;
    costByBackend.set(r.backend, c);
  }
  const cost: CostSummary = {
    totalEstimatedUsd: withCost.length > 0 ? round(sum(withCost.map((r) => r.cost.estimatedUsd!))) : null,
    runsWithCost: withCost.length,
    runsWithoutCost: records.length - withCost.length,
    byBackend: [...costByBackend.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([backend, c]) => ({
        backend,
        costModel: c.costModel,
        estimatedUsd: c.estimatedUsd === null ? null : round(c.estimatedUsd),
      })),
  };

  // Runtime.
  const failed = records.filter((r) => r.error !== null).length;
  const latencies = records
    .map((r) => (typeof r.metrics.latencyMs === "number" ? r.metrics.latencyMs : null))
    .filter((x): x is number => x !== null);
  const runtime: RuntimeSummary = {
    totalRuns: records.length,
    succeeded: records.length - failed,
    failed,
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
  p(`- Runs: ${report.runtime.totalRuns} (succeeded ${report.runtime.succeeded}, failed ${report.runtime.failed})`);
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
  p(`- Total estimated: ${report.cost.totalEstimatedUsd === null ? "unknown" : `$${report.cost.totalEstimatedUsd}`}`);
  p(`- Runs with cost: ${report.cost.runsWithCost} · without: ${report.cost.runsWithoutCost}`);
  for (const b of report.cost.byBackend) {
    p(`  - ${b.backend}: ${b.costModel}${b.estimatedUsd === null ? "" : ` ($${b.estimatedUsd})`}`);
  }
  p();

  p(`## Runtime`);
  p();
  p(`- Total runs: ${report.runtime.totalRuns}`);
  p(`- Succeeded: ${report.runtime.succeeded} · Failed: ${report.runtime.failed}`);
  p(`- Average latency: ${report.runtime.averageLatencyMs === null ? "unknown" : `${report.runtime.averageLatencyMs} ms`}`);
  p();

  p(`## Known Limitations`);
  p();
  for (const l of report.knownLimitations) p(`- ${l}`);
  p();

  return lines.join("\n");
}
