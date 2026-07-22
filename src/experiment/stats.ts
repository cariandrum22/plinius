/**
 * Numeric aggregation helpers for repeated runs.
 *
 * Pure functions over number series: no I/O, no domain coupling.
 */
export interface NumberStats {
  count: number;
  mean: number | null;
  median: number | null;
  stddev: number | null;
  min: number | null;
  max: number | null;
}

export function numberStats(values: number[]): NumberStats {
  if (values.length === 0) {
    return { count: 0, mean: null, median: null, stddev: null, min: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const median =
    n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;

  return {
    count: n,
    mean,
    median,
    stddev: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[n - 1],
  };
}

export function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Evaluator disagreement across a run's judges. Given, per judge, a normalized
 * [0,1] score for a run, disagreement is flagged when the spread (max - min)
 * exceeds `threshold`. Returns the fraction of runs that disagree.
 */
export function disagreementRate(
  perRunJudgeScores: number[][],
  threshold = 0.2,
): number {
  const comparable = perRunJudgeScores.filter((scores) => scores.length >= 2);
  if (comparable.length === 0) return 0;
  const disagreeing = comparable.filter((scores) => {
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    return max - min > threshold;
  });
  return rate(disagreeing.length, comparable.length);
}
