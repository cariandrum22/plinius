/**
 * Capability matrix generation.
 *
 * The matrix separates two layers, by design:
 *
 *   - RAW dimensions: directly measured, domain-specific signals (per-domain
 *     scores, Japanese output quality, instruction adherence, refusal rate,
 *     formatting validity).
 *   - DERIVED summary dimensions: quality / reliability / performance / cost.
 *
 * These are kept apart and are NOT collapsed into a single composite score.
 * Prototype benchmarks and infrastructure-validation experiments never count
 * toward qualification or rankings, though their measured values are still
 * shown for pipeline visibility.
 *
 * `MATRIX_SCHEMA_VERSION` is versioned independently.
 */
import { Domain } from "../suite/schema.js";
import { BenchmarkRunRecord } from "../types/benchmark.js";
import { LoadedBenchmark } from "../suite/loader.js";
import {
  AggregateResult,
  AggregateStatus,
  aggregate,
  deriveRepetitionSignal,
} from "../experiment/verdict.js";
import { CostBreakdown, deriveCost } from "./cost.js";

export const MATRIX_SCHEMA_VERSION = 1;

const DOMAINS: Domain[] = [
  "architecture",
  "security",
  "coding",
  "formal",
  "writing",
  "fiction",
];

export interface DomainCell {
  domain: Domain;
  benchmarkCount: number;
  excludedBenchmarkCount: number;
  /** Verdict over non-excluded benchmarks; "inconclusive" if none. */
  status: AggregateStatus;
  domainScoreMean: number | null;
  passRate: number | null;
  catastrophicFailureRate: number | null;
  evaluatorDisagreementRate: number | null;
  qualified: boolean;
}

export interface RawDimensions {
  domains: Record<Domain, DomainCell | null>;
  japaneseOutputQuality: number | null;
  instructionAdherence: number | null;
  refusalRate: number | null;
  formattingValidity: number | null;
}

export interface DerivedDimensions {
  quality: {
    domainScoreMean: number | null;
    qualifiedDomainCount: number;
    measuredDomainCount: number;
  };
  reliability: {
    passRate: number | null;
    catastrophicFailureRate: number | null;
    infrastructureFailureRate: number | null;
    evaluatorDisagreementRate: number | null;
  };
  performance: {
    latencyMsMean: number | null;
    tokensPerSecond: number | null;
  };
  cost: CostBreakdown;
}

export interface CapabilityMatrixEntry {
  targetId: string;
  model: string;
  excludedFromRankings: boolean;
  raw: RawDimensions;
  derived: DerivedDimensions;
  qualifiedDomains: Domain[];
}

export interface CapabilityMatrix {
  schemaVersion: number;
  generatedAt: string;
  experimentId?: string;
  disagreementThreshold: number;
  entries: CapabilityMatrixEntry[];
}

export interface BuildMatrixOptions {
  experimentId?: string;
  /** Force-exclude every entry (e.g. infrastructure-validation experiment). */
  excludeFromRankings?: boolean;
  disagreementThreshold?: number;
}

interface BenchmarkAggregate {
  benchmarkId: string;
  domain: Domain;
  excluded: boolean;
  records: BenchmarkRunRecord[];
  result: AggregateResult;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Fraction of records satisfying `predicate` among those where it applies. */
function conditionalRate(
  records: BenchmarkRunRecord[],
  applies: (r: BenchmarkRunRecord) => boolean,
  predicate: (r: BenchmarkRunRecord) => boolean,
): number | null {
  const applicable = records.filter(applies);
  if (applicable.length === 0) return null;
  return applicable.filter(predicate).length / applicable.length;
}

function hasStructuralBlocking(r: BenchmarkRunRecord): boolean {
  return (r.deterministicEvaluations ?? []).some(
    (e) => e.authority === "structural" && e.blocking,
  );
}

function structuralBlockingAllPass(r: BenchmarkRunRecord): boolean {
  const structural = (r.deterministicEvaluations ?? []).filter(
    (e) => e.authority === "structural" && e.blocking,
  );
  return structural.length > 0 && structural.every((e) => e.status === "pass");
}

function buildDomainCell(
  domain: Domain,
  aggregates: BenchmarkAggregate[],
): DomainCell | null {
  const inDomain = aggregates.filter((a) => a.domain === domain);
  if (inDomain.length === 0) return null;

  const ranked = inDomain.filter((a) => !a.excluded);
  const scoreSamples = ranked
    .map((a) => a.result.domainScore.mean)
    .filter((v): v is number => v !== null);

  const status: AggregateStatus =
    ranked.length === 0
      ? "inconclusive"
      : ranked.every((a) => a.result.status === "qualified")
        ? "qualified"
        : ranked.some((a) => a.result.status === "disqualified")
          ? "disqualified"
          : ranked.some((a) => a.result.status === "infrastructure_error")
            ? "infrastructure_error"
            : "inconclusive";

  return {
    domain,
    benchmarkCount: inDomain.length,
    excludedBenchmarkCount: inDomain.filter((a) => a.excluded).length,
    status,
    domainScoreMean: mean(scoreSamples),
    passRate: mean(ranked.map((a) => a.result.passRate)),
    catastrophicFailureRate: mean(ranked.map((a) => a.result.catastrophicFailureRate)),
    evaluatorDisagreementRate: mean(ranked.map((a) => a.result.evaluatorDisagreementRate)),
    qualified: ranked.length > 0 && status === "qualified",
  };
}

function buildEntry(
  targetId: string,
  model: string,
  records: BenchmarkRunRecord[],
  benchmarksById: Map<string, LoadedBenchmark>,
  options: BuildMatrixOptions,
): CapabilityMatrixEntry {
  const disagreementThreshold = options.disagreementThreshold ?? 0.2;

  // Group this target's records by benchmark id.
  const byBenchmark = new Map<string, BenchmarkRunRecord[]>();
  for (const record of records) {
    const list = byBenchmark.get(record.benchmark.id) ?? [];
    list.push(record);
    byBenchmark.set(record.benchmark.id, list);
  }

  const aggregates: BenchmarkAggregate[] = [];
  for (const [benchmarkId, reps] of byBenchmark) {
    const loaded = benchmarksById.get(benchmarkId);
    const domain = (loaded?.definition.domain ?? reps[0].benchmark.domain) as Domain;
    const excluded =
      !!options.excludeFromRankings ||
      !!loaded?.definition.prototype ||
      !!reps[0].benchmark.prototype;
    const qualification =
      loaded?.definition.qualification ?? {
        deterministicPassRate: 1,
        minimumDomainScore: 0,
        maximumCatastrophicFailureRate: 0,
        maximumEvaluatorDisagreement: 0.25,
      };
    const result = aggregate(
      reps.map(deriveRepetitionSignal),
      qualification,
      disagreementThreshold,
    );
    aggregates.push({ benchmarkId, domain, excluded, records: reps, result });
  }

  const domains = Object.fromEntries(
    DOMAINS.map((d) => [d, buildDomainCell(d, aggregates)]),
  ) as Record<Domain, DomainCell | null>;

  // Raw cross-cutting dimensions (measured over ALL records for visibility).
  const withResponse = records.filter((r) => !!r.response);
  const refusalRate = conditionalRate(
    withResponse,
    () => true,
    (r) => deriveRepetitionSignal(r).refusal,
  );
  const instructionAdherence = conditionalRate(
    records,
    hasStructuralBlocking,
    structuralBlockingAllPass,
  );
  const formattingValidity = conditionalRate(
    withResponse,
    (r) => (r.judgeEvaluations?.length ?? 0) > 0 || hasStructuralBlocking(r),
    (r) => {
      const judgeOk = (r.judgeEvaluations ?? []).every((j) => j.formatValid);
      const structuralOk = !hasStructuralBlocking(r) || structuralBlockingAllPass(r);
      return judgeOk && structuralOk;
    },
  );
  const japaneseSamples = withResponse
    .filter((r) => {
      const loaded = benchmarksById.get(r.benchmark.id);
      return loaded?.definition.tags.includes("japanese");
    })
    .flatMap((r) => (r.judgeEvaluations ?? []).map((j) => j.normalizedScore));
  const japaneseOutputQuality = mean(japaneseSamples);

  const raw: RawDimensions = {
    domains,
    japaneseOutputQuality,
    instructionAdherence,
    refusalRate,
    formattingValidity,
  };

  // Derived summary dimensions — each separated, never collapsed.
  const rankedAggregates = aggregates.filter((a) => !a.excluded);
  const measuredDomainCells = DOMAINS.map((d) => domains[d]).filter(
    (c): c is DomainCell => c !== null,
  );
  const qualifiedDomains = measuredDomainCells
    .filter((c) => c.qualified)
    .map((c) => c.domain);

  const derived: DerivedDimensions = {
    quality: {
      domainScoreMean: mean(
        measuredDomainCells
          .map((c) => c.domainScoreMean)
          .filter((v): v is number => v !== null),
      ),
      qualifiedDomainCount: qualifiedDomains.length,
      measuredDomainCount: measuredDomainCells.length,
    },
    reliability: {
      passRate: mean(rankedAggregates.map((a) => a.result.passRate)),
      catastrophicFailureRate: mean(
        rankedAggregates.map((a) => a.result.catastrophicFailureRate),
      ),
      infrastructureFailureRate: mean(
        aggregates.map((a) => a.result.infrastructureFailureRate),
      ),
      evaluatorDisagreementRate: mean(
        rankedAggregates.map((a) => a.result.evaluatorDisagreementRate),
      ),
    },
    performance: {
      latencyMsMean: deriveCost(records).latencyMsMean,
      tokensPerSecond: deriveCost(records).tokensPerSecond,
    },
    cost: deriveCost(records),
  };

  return {
    targetId,
    model,
    excludedFromRankings:
      !!options.excludeFromRankings || aggregates.every((a) => a.excluded),
    raw,
    derived,
    qualifiedDomains,
  };
}

/**
 * Build a capability matrix from a set of run records. Records are grouped by
 * target; each benchmark is aggregated with its own qualification thresholds.
 */
export function buildCapabilityMatrix(
  records: BenchmarkRunRecord[],
  benchmarksById: Map<string, LoadedBenchmark>,
  options: BuildMatrixOptions = {},
): CapabilityMatrix {
  const byTarget = new Map<string, BenchmarkRunRecord[]>();
  for (const record of records) {
    const list = byTarget.get(record.targetId) ?? [];
    list.push(record);
    byTarget.set(record.targetId, list);
  }

  const entries: CapabilityMatrixEntry[] = [];
  for (const [targetId, targetRecords] of byTarget) {
    const model = targetRecords[0]?.model ?? targetId;
    entries.push(buildEntry(targetId, model, targetRecords, benchmarksById, options));
  }
  entries.sort((a, b) => a.targetId.localeCompare(b.targetId));

  return {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    experimentId: options.experimentId,
    disagreementThreshold: options.disagreementThreshold ?? 0.2,
    entries,
  };
}
