/**
 * Benchmark Framework — Result Aggregation (requirement 11).
 *
 * Simple aggregation only: per-model average score, per-category averages, and
 * collected strengths/weaknesses. NO statistical analysis, NO ranking, NO Elo /
 * Bradley-Terry — those are explicit non-goals for this phase.
 *
 * Scores come from the blind review set; the private mapping joins each blind id
 * back to its model. Aggregation is pure and deterministic (models and
 * categories are emitted in sorted order).
 */
import { ReviewMapping, ReviewSet } from "./review.js";

export interface CategoryScore {
  category: string;
  averageScore: number;
  reviewedCount: number;
}

export interface ModelAggregate {
  model: string;
  /** Mean overall score across all reviewed tasks for this model. */
  averageScore: number | null;
  reviewedCount: number;
  categorySummary: CategoryScore[];
  strengths: string[];
  weaknesses: string[];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate reviewed scores per model. Only tasks in REVIEWED or FINALIZED with
 * a comment contribute. Blind ids are joined to models via the private mapping.
 */
export function aggregateResults(set: ReviewSet, mapping: ReviewMapping): ModelAggregate[] {
  const modelByBlindId = new Map<string, { model: string; benchmarkId: string }>();
  for (const entry of mapping.entries) {
    modelByBlindId.set(entry.blindId, { model: entry.model, benchmarkId: entry.benchmarkId });
  }

  // model -> { scores, category -> scores, strengths, weaknesses }
  interface Acc {
    scores: number[];
    byCategory: Map<string, number[]>;
    strengths: string[];
    weaknesses: string[];
  }
  const acc = new Map<string, Acc>();

  for (const task of set.tasks) {
    if ((task.state !== "REVIEWED" && task.state !== "FINALIZED") || !task.comment) continue;
    const joined = modelByBlindId.get(task.blindId);
    if (!joined) continue; // no mapping → cannot attribute; skipped (never guessed)

    let a = acc.get(joined.model);
    if (!a) {
      a = { scores: [], byCategory: new Map(), strengths: [], weaknesses: [] };
      acc.set(joined.model, a);
    }
    a.scores.push(task.comment.score);
    const catScores = a.byCategory.get(task.category) ?? [];
    catScores.push(task.comment.score);
    a.byCategory.set(task.category, catScores);
    if (task.comment.strength.trim()) a.strengths.push(task.comment.strength.trim());
    if (task.comment.weakness.trim()) a.weaknesses.push(task.comment.weakness.trim());
  }

  const models = [...acc.keys()].sort();
  return models.map((model) => {
    const a = acc.get(model)!;
    const categorySummary: CategoryScore[] = [...a.byCategory.keys()]
      .sort()
      .map((category) => {
        const scores = a.byCategory.get(category)!;
        return { category, averageScore: mean(scores) ?? 0, reviewedCount: scores.length };
      });
    return {
      model,
      averageScore: mean(a.scores),
      reviewedCount: a.scores.length,
      categorySummary,
      strengths: a.strengths,
      weaknesses: a.weaknesses,
    };
  });
}
