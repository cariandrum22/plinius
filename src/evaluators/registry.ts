/**
 * Runs the deterministic-evaluator layer for a benchmark and summarizes it.
 *
 * Evaluators run in authority order (most authoritative first) so that logs
 * read top-down from executable verifiers to structural checks. A blocking
 * check that cannot run (`not_available`) never counts as a failure — it makes
 * the deterministic layer inconclusive.
 */
import { AUTHORITY_RANK, DeterministicCheck } from "../suite/schema.js";
import { buildEvaluator } from "./checks.js";
import { DeterministicEvaluation, EvaluationInput } from "./types.js";

export interface DeterministicSummary {
  total: number;
  passed: number;
  failed: number;
  notAvailable: number;
  errored: number;
  /** Blocking checks only, among those that produced a pass/fail verdict. */
  blockingPassRate: number | null;
  /** A blocking check produced `fail`. */
  hasBlockingFailure: boolean;
  /** A blocking check could not run (missing tool/environment). */
  hasBlockingNotAvailable: boolean;
  /** An infrastructure error prevented a verdict. */
  hasError: boolean;
}

export async function runDeterministicChecks(
  checks: DeterministicCheck[],
  input: EvaluationInput,
): Promise<DeterministicEvaluation[]> {
  const evaluators = checks
    .map(buildEvaluator)
    .sort((a, b) => AUTHORITY_RANK[a.authority] - AUTHORITY_RANK[b.authority]);

  const results: DeterministicEvaluation[] = [];
  for (const evaluator of evaluators) {
    results.push(await evaluator.evaluate(input));
  }
  return results;
}

export function summarizeDeterministic(
  evaluations: DeterministicEvaluation[],
): DeterministicSummary {
  const blocking = evaluations.filter((e) => e.blocking);
  const blockingDecided = blocking.filter(
    (e) => e.status === "pass" || e.status === "fail",
  );
  const blockingPassed = blockingDecided.filter((e) => e.status === "pass");

  return {
    total: evaluations.length,
    passed: evaluations.filter((e) => e.status === "pass").length,
    failed: evaluations.filter((e) => e.status === "fail").length,
    notAvailable: evaluations.filter((e) => e.status === "not_available").length,
    errored: evaluations.filter((e) => e.status === "error").length,
    blockingPassRate:
      blockingDecided.length === 0 ? null : blockingPassed.length / blockingDecided.length,
    hasBlockingFailure: blocking.some((e) => e.status === "fail"),
    hasBlockingNotAvailable: blocking.some((e) => e.status === "not_available"),
    hasError: evaluations.some((e) => e.status === "error"),
  };
}
