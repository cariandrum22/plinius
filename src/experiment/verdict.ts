/**
 * Aggregation of repeated runs into a qualification verdict.
 *
 * Distinguishes four aggregate outcomes:
 *   - `qualified`            — every mandatory threshold satisfied.
 *   - `disqualified`         — a mandatory threshold was violated (real failure).
 *   - `inconclusive`         — a required verifier could not run (not_available),
 *                              or judges were required but absent.
 *   - `infrastructure_error` — runs failed for environmental reasons (backend /
 *                              sandbox), so no judgment about the model is valid.
 *
 * Catastrophic failure (the model produced a badly-failing answer) and
 * infrastructure failure (the environment failed) are tracked separately.
 */
import { Qualification } from "../suite/schema.js";
import { BenchmarkRunRecord } from "../types/benchmark.js";
import { summarizeDeterministic } from "../evaluators/registry.js";
import { looksLikeRefusal } from "../evaluation/judge.js";
import { NumberStats, disagreementRate, numberStats, rate } from "./stats.js";

export type AggregateStatus =
  | "qualified"
  | "disqualified"
  | "inconclusive"
  | "infrastructure_error";

export interface RepetitionSignal {
  backendError: boolean;
  emptyOutput: boolean;
  blockingFail: boolean;
  blockingNotAvailable: boolean;
  deterministicError: boolean;
  refusal: boolean;
  formatValid: boolean;
  /** Per-judge score on the rubric scale. */
  judgeOverallScores: number[];
  /** Per-judge score normalized to [0, 1]. */
  judgeNormalizedScores: number[];
  latencyMs: number | null;
}

/** Build a normalized signal from a persisted run record. */
export function deriveRepetitionSignal(record: BenchmarkRunRecord): RepetitionSignal {
  const det = summarizeDeterministic(record.deterministicEvaluations ?? []);
  const text = record.response?.text ?? "";
  const judges = record.judgeEvaluations ?? [];
  const refusal = judges.some((j) => j.refusal) || (!!record.response && looksLikeRefusal(text));

  return {
    backendError: !!record.error || !record.response,
    emptyOutput: !!record.response && text.trim().length === 0,
    blockingFail: det.hasBlockingFailure,
    blockingNotAvailable: det.hasBlockingNotAvailable,
    deterministicError: det.hasError,
    refusal,
    formatValid: judges.length === 0 ? true : judges.every((j) => j.formatValid),
    judgeOverallScores: judges.map((j) => j.overall),
    judgeNormalizedScores: judges.map((j) => j.normalizedScore),
    latencyMs: record.response?.latencyMs ?? null,
  };
}

function isInfrastructure(s: RepetitionSignal): boolean {
  return s.backendError || s.deterministicError;
}

function isCatastrophic(s: RepetitionSignal): boolean {
  return s.emptyOutput || s.blockingFail || s.refusal;
}

export interface AggregateResult {
  status: AggregateStatus;
  repetitions: number;
  deterministicPassRate: number;
  passRate: number;
  catastrophicFailureRate: number;
  infrastructureFailureRate: number;
  evaluatorDisagreementRate: number;
  domainScore: NumberStats;
  latency: NumberStats;
  /** Which thresholds were violated (empty when qualified). */
  violations: string[];
  /** Human-readable reason for the status. */
  reason: string;
}

export function aggregate(
  signals: RepetitionSignal[],
  qualification: Qualification,
  disagreementThreshold = 0.2,
): AggregateResult {
  const n = signals.length;
  const infra = signals.filter(isInfrastructure);
  const decidable = signals.filter((s) => !isInfrastructure(s));

  const infrastructureFailureRate = rate(infra.length, n);
  const domainScoreSamples = decidable
    .filter((s) => s.judgeOverallScores.length > 0)
    .map((s) => s.judgeOverallScores.reduce((a, b) => a + b, 0) / s.judgeOverallScores.length);
  const domainScore = numberStats(domainScoreSamples);
  const latency = numberStats(
    signals.map((s) => s.latencyMs).filter((v): v is number => v !== null),
  );
  const evaluatorDisagreementRate = disagreementRate(
    decidable.map((s) => s.judgeNormalizedScores),
    disagreementThreshold,
  );

  const blockingAllPassed = decidable.filter(
    (s) => !s.blockingFail && !s.blockingNotAvailable,
  ).length;
  const deterministicPassRate = rate(blockingAllPassed, decidable.length);
  const passRate = rate(
    decidable.filter((s) => !isCatastrophic(s) && !s.blockingNotAvailable).length,
    decidable.length,
  );
  const catastrophicFailureRate = rate(
    decidable.filter(isCatastrophic).length,
    decidable.length,
  );

  const empty = (): AggregateResult => ({
    status: "inconclusive",
    repetitions: n,
    deterministicPassRate,
    passRate,
    catastrophicFailureRate,
    infrastructureFailureRate,
    evaluatorDisagreementRate,
    domainScore,
    latency,
    violations: [],
    reason: "",
  });

  if (n === 0) return { ...empty(), reason: "no repetitions" };

  // Environment failed everywhere → no valid judgment about the model.
  if (infra.length === n) {
    return { ...empty(), status: "infrastructure_error", reason: "all repetitions failed for infrastructure reasons" };
  }

  // A required (blocking) verifier could not run and nothing failed decisively.
  const hasBlockingNotAvailable = decidable.some((s) => s.blockingNotAvailable);
  const anyBlockingFail = decidable.some((s) => s.blockingFail);
  if (hasBlockingNotAvailable && !anyBlockingFail) {
    return {
      ...empty(),
      status: "inconclusive",
      reason: "a required verifier was not_available; cannot confirm pass",
    };
  }

  // Threshold checks.
  const violations: string[] = [];
  if (deterministicPassRate < qualification.deterministicPassRate) {
    violations.push(
      `deterministic pass rate ${deterministicPassRate.toFixed(2)} < ${qualification.deterministicPassRate}`,
    );
  }
  if (catastrophicFailureRate > qualification.maximumCatastrophicFailureRate) {
    violations.push(
      `catastrophic failure rate ${catastrophicFailureRate.toFixed(2)} > ${qualification.maximumCatastrophicFailureRate}`,
    );
  }
  if (evaluatorDisagreementRate > qualification.maximumEvaluatorDisagreement) {
    violations.push(
      `evaluator disagreement ${evaluatorDisagreementRate.toFixed(2)} > ${qualification.maximumEvaluatorDisagreement}`,
    );
  }
  if (qualification.minimumDomainScore > 0) {
    if (domainScore.mean === null) {
      return {
        ...empty(),
        status: "inconclusive",
        reason: "a minimum domain score is required but no judge scores are present",
        violations,
      };
    }
    if (domainScore.mean < qualification.minimumDomainScore) {
      violations.push(
        `domain score ${domainScore.mean.toFixed(2)} < ${qualification.minimumDomainScore}`,
      );
    }
  }

  if (violations.length === 0) {
    return {
      status: "qualified",
      repetitions: n,
      deterministicPassRate,
      passRate,
      catastrophicFailureRate,
      infrastructureFailureRate,
      evaluatorDisagreementRate,
      domainScore,
      latency,
      violations,
      reason: "all mandatory thresholds satisfied",
    };
  }

  return {
    status: "disqualified",
    repetitions: n,
    deterministicPassRate,
    passRate,
    catastrophicFailureRate,
    infrastructureFailureRate,
    evaluatorDisagreementRate,
    domainScore,
    latency,
    violations,
    reason: `threshold(s) violated: ${violations.join("; ")}`,
  };
}
