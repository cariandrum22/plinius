/**
 * Human-review analysis: score distributions and human-vs-evaluator agreement.
 *
 * Before unblinding, only blind-id-level metrics are computed. After the
 * explicit unblinding step, per-target results and human-vs-deterministic /
 * human-vs-judge discrepancies are added. Results are never collapsed into a
 * single overall score.
 */
import { BenchmarkRunRecord } from "../types/benchmark.js";
import { summarizeDeterministic } from "../evaluators/registry.js";
import { NumberStats, numberStats } from "../experiment/stats.js";
import {
  BlindReviewMapping,
  BlindReviewSet,
  HumanReviewRecord,
  PairwiseHumanReview,
} from "./schema.js";
import { UnblindedReview, unblindReviews } from "./import.js";

export interface AnalysisResult {
  reviewSetId: string;
  unblinded: boolean;
  counts: {
    items: number;
    reviews: number;
    reviewers: number;
    reviewedItems: number;
    missingItems: number;
  };
  byDimension: Record<string, NumberStats>;
  overall: NumberStats;
  interReviewer: {
    comparableItems: number;
    qualificationAgreementRate: number | null;
    overallScoreMae: number | null;
  };
  selfConsistency: {
    repeatedPairs: number;
    meanOverallStddev: number | null;
  };
  disagreementExamples: Array<{ blindId: string; overallSpread: number; recommendations: string[] }>;
  // Populated only after unblinding:
  byTarget?: Record<string, { overall: NumberStats; qualifiedRate: number }>;
  vsDeterministic?: {
    compared: number;
    agreementRate: number | null;
    falseQualificationRate: number | null;
    falseRejectionRate: number | null;
    catastrophicMissRate: number | null;
  };
  vsJudge?: {
    compared: number;
    overallMae: number | null;
    rankCorrelation: number | null;
  };
  pairwiseWinRateByTarget?: Record<string, { wins: number; comparisons: number; winRate: number }>;
}

function reviewsByBlindId(reviews: HumanReviewRecord[]): Map<string, HumanReviewRecord[]> {
  const map = new Map<string, HumanReviewRecord[]>();
  for (const r of reviews) {
    const list = map.get(r.blindId) ?? [];
    list.push(r);
    map.set(r.blindId, list);
  }
  return map;
}

function spearman(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const rank = (values: number[]): number[] => {
    const sorted = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(n).fill(0);
    for (let i = 0; i < n; i++) ranks[sorted[i][1]] = i + 1;
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

export interface AnalyzeInput {
  set: BlindReviewSet;
  reviews: HumanReviewRecord[];
  /** Provide to unblind and compute per-target + evaluator comparisons. */
  mapping?: BlindReviewMapping;
  runRecordsById?: Map<string, BenchmarkRunRecord>;
  pairwiseReviews?: PairwiseHumanReview[];
}

export function analyze(input: AnalyzeInput): AnalysisResult {
  const { set, reviews } = input;
  const dimensionIds = set.items[0]?.scoringRubric.dimensions.map((d) => d.id) ?? [];

  const byDimension: Record<string, NumberStats> = {};
  for (const dim of dimensionIds) {
    byDimension[dim] = numberStats(
      reviews.map((r) => r.scores[dim]).filter((v): v is number => typeof v === "number"),
    );
  }
  const overall = numberStats(reviews.map((r) => r.overallScore));

  const grouped = reviewsByBlindId(reviews);
  const reviewedItems = grouped.size;

  // Inter-reviewer agreement over items with >= 2 reviewers.
  let comparableItems = 0;
  const qualMatches: number[] = [];
  const overallMaes: number[] = [];
  const disagreementExamples: AnalysisResult["disagreementExamples"] = [];
  for (const [blindId, list] of grouped) {
    if (list.length < 2) continue;
    comparableItems++;
    const recs = list.map((r) => r.qualificationRecommendation);
    const allSame = recs.every((r) => r === recs[0]);
    qualMatches.push(allSame ? 1 : 0);
    const overalls = list.map((r) => r.overallScore);
    const spread = Math.max(...overalls) - Math.min(...overalls);
    // Mean absolute pairwise difference in overall score.
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < overalls.length; i++)
      for (let j = i + 1; j < overalls.length; j++) {
        sum += Math.abs(overalls[i] - overalls[j]);
        pairs++;
      }
    if (pairs > 0) overallMaes.push(sum / pairs);
    if (spread >= 2 || !allSame) {
      disagreementExamples.push({ blindId, overallSpread: spread, recommendations: recs });
    }
  }
  disagreementExamples.sort((a, b) => b.overallSpread - a.overallSpread);

  // Reviewer self-consistency: same (reviewer, blindId) reviewed more than once.
  const byReviewerBlind = new Map<string, number[]>();
  for (const r of reviews) {
    const key = `${r.reviewerId}::${r.blindId}`;
    const list = byReviewerBlind.get(key) ?? [];
    list.push(r.overallScore);
    byReviewerBlind.set(key, list);
  }
  const selfStddevs: number[] = [];
  for (const scores of byReviewerBlind.values()) {
    if (scores.length >= 2) {
      const s = numberStats(scores).stddev;
      if (s !== null) selfStddevs.push(s);
    }
  }

  const result: AnalysisResult = {
    reviewSetId: set.reviewSetId,
    unblinded: false,
    counts: {
      items: set.items.length,
      reviews: reviews.length,
      reviewers: new Set(reviews.map((r) => r.reviewerId)).size,
      reviewedItems,
      missingItems: set.items.length - reviewedItems,
    },
    byDimension,
    overall,
    interReviewer: {
      comparableItems,
      qualificationAgreementRate: qualMatches.length ? avg(qualMatches) : null,
      overallScoreMae: overallMaes.length ? avg(overallMaes) : null,
    },
    selfConsistency: {
      repeatedPairs: selfStddevs.length,
      meanOverallStddev: selfStddevs.length ? avg(selfStddevs) : null,
    },
    disagreementExamples: disagreementExamples.slice(0, 10),
  };

  // --- Unblinded sections ---
  if (input.mapping) {
    const { unblinded } = unblindReviews(reviews, input.mapping);
    result.unblinded = true;
    result.byTarget = perTarget(unblinded);

    if (input.runRecordsById) {
      result.vsDeterministic = compareDeterministic(unblinded, input.runRecordsById);
      result.vsJudge = compareJudge(unblinded, input.runRecordsById);
    }
    if (input.pairwiseReviews && input.mapping.pairwiseMapping) {
      result.pairwiseWinRateByTarget = pairwiseWinRate(
        input.pairwiseReviews,
        input.mapping.pairwiseMapping,
      );
    }
  }

  return result;
}

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function perTarget(reviews: UnblindedReview[]): Record<string, { overall: NumberStats; qualifiedRate: number }> {
  const byTarget = new Map<string, UnblindedReview[]>();
  for (const r of reviews) {
    const list = byTarget.get(r.targetId) ?? [];
    list.push(r);
    byTarget.set(r.targetId, list);
  }
  const out: Record<string, { overall: NumberStats; qualifiedRate: number }> = {};
  for (const [targetId, list] of byTarget) {
    out[targetId] = {
      overall: numberStats(list.map((r) => r.overallScore)),
      qualifiedRate: list.filter((r) => r.qualificationRecommendation === "qualified").length / list.length,
    };
  }
  return out;
}

function compareDeterministic(
  reviews: UnblindedReview[],
  records: Map<string, BenchmarkRunRecord>,
): AnalysisResult["vsDeterministic"] {
  let compared = 0;
  let agree = 0;
  let falseQual = 0;
  let falseRej = 0;
  let catastrophicMiss = 0;
  let positiveHuman = 0;
  let negativeHuman = 0;
  for (const review of reviews) {
    const record = records.get(review.runRecordId);
    const evals = record?.deterministicEvaluations;
    if (!record || !evals || evals.length === 0) continue;
    const summary = summarizeDeterministic(evals);
    const detPass = !summary.hasBlockingFailure && summary.blockingPassRate === 1;
    const detBlockingFail = summary.hasBlockingFailure;
    const humanPositive = review.qualificationRecommendation === "qualified";
    compared++;
    if (humanPositive === detPass) agree++;
    if (humanPositive) {
      positiveHuman++;
      if (detBlockingFail) {
        falseQual++;
        catastrophicMiss++;
      }
    } else {
      negativeHuman++;
      if (detPass) falseRej++;
    }
  }
  if (compared === 0) return { compared, agreementRate: null, falseQualificationRate: null, falseRejectionRate: null, catastrophicMissRate: null };
  return {
    compared,
    agreementRate: agree / compared,
    falseQualificationRate: positiveHuman ? falseQual / positiveHuman : null,
    falseRejectionRate: negativeHuman ? falseRej / negativeHuman : null,
    catastrophicMissRate: positiveHuman ? catastrophicMiss / positiveHuman : null,
  };
}

function compareJudge(
  reviews: UnblindedReview[],
  records: Map<string, BenchmarkRunRecord>,
): AnalysisResult["vsJudge"] {
  const humanNorm: number[] = [];
  const judgeNorm: number[] = [];
  for (const review of reviews) {
    const record = records.get(review.runRecordId);
    const judges = record?.judgeEvaluations;
    if (!judges || judges.length === 0) continue;
    const judgeScore = avg(judges.map((j) => j.normalizedScore));
    humanNorm.push(review.overallScore / 5);
    judgeNorm.push(judgeScore);
  }
  const compared = humanNorm.length;
  if (compared === 0) return { compared, overallMae: null, rankCorrelation: null };
  const mae = avg(humanNorm.map((h, i) => Math.abs(h - judgeNorm[i])));
  return { compared, overallMae: mae, rankCorrelation: spearman(humanNorm, judgeNorm) };
}

function pairwiseWinRate(
  reviews: PairwiseHumanReview[],
  mapping: NonNullable<BlindReviewMapping["pairwiseMapping"]>,
): Record<string, { wins: number; comparisons: number; winRate: number }> {
  const byBlindId = new Map(mapping.map((m) => [m.blindId, m]));
  const tally = new Map<string, { wins: number; comparisons: number }>();
  const bump = (target: string, win: number) => {
    const t = tally.get(target) ?? { wins: 0, comparisons: 0 };
    t.wins += win;
    t.comparisons += 1;
    tally.set(target, t);
  };
  for (const review of reviews) {
    const m = byBlindId.get(review.blindId);
    if (!m) continue;
    // Map A/B choice to the concrete targets.
    let aWin = 0;
    let bWin = 0;
    switch (review.choice) {
      case "a_clearly_better":
      case "a_slightly_better":
        aWin = 1;
        break;
      case "b_clearly_better":
      case "b_slightly_better":
        bWin = 1;
        break;
      case "equivalent":
        aWin = 0.5;
        bWin = 0.5;
        break;
    }
    bump(m.aTargetId, aWin);
    bump(m.bTargetId, bWin);
  }
  const out: Record<string, { wins: number; comparisons: number; winRate: number }> = {};
  for (const [target, t] of tally) {
    out[target] = { wins: t.wins, comparisons: t.comparisons, winRate: t.comparisons ? t.wins / t.comparisons : 0 };
  }
  return out;
}
