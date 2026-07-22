/**
 * Cost accounting.
 *
 * Cost is kept strictly separate from quality — there is no default single
 * quality/cost composite. Per-run cost is estimated from list pricing and, when
 * retrievable, reconciled against OpenRouter's actual generation cost.
 */
import { ModelPricing } from "../catalog/schema.js";

export interface UsageTokens {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  nativeTokens: number;
}

export interface CostRecord {
  usage: UsageTokens;
  listPriceEstimateUsd: number;
  /** OpenRouter's reported generation cost, when retrievable. */
  actualCostUsd: number | null;
  requestId: string | null;
  generationId: string | null;
  /** actualCost - listEstimate, when both known. */
  reconciliationDeltaUsd: number | null;
  reconciled: boolean;
}

export function emptyUsage(): UsageTokens {
  return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, nativeTokens: 0 };
}

/**
 * Estimate list-price cost. Reasoning tokens are billed at the completion rate;
 * cached tokens use the cache-read rate when available (falling back to prompt).
 */
export function estimateListCost(usage: UsageTokens, pricing: ModelPricing): number {
  const prompt = pricing.prompt ?? 0;
  const completion = pricing.completion ?? 0;
  const cacheRead = pricing.cacheRead ?? prompt;
  const request = pricing.request ?? 0;
  const billedPrompt = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (
    billedPrompt * prompt +
    usage.cachedTokens * cacheRead +
    (usage.completionTokens + usage.reasoningTokens) * completion +
    request
  );
}

export function buildCostRecord(
  usage: UsageTokens,
  pricing: ModelPricing,
  meta: { actualCostUsd?: number | null; requestId?: string | null; generationId?: string | null } = {},
): CostRecord {
  const listPriceEstimateUsd = estimateListCost(usage, pricing);
  const actualCostUsd = meta.actualCostUsd ?? null;
  return {
    usage,
    listPriceEstimateUsd,
    actualCostUsd,
    requestId: meta.requestId ?? null,
    generationId: meta.generationId ?? null,
    reconciliationDeltaUsd: actualCostUsd !== null ? actualCostUsd - listPriceEstimateUsd : null,
    reconciled: actualCostUsd !== null,
  };
}

/** Effective cost of a run, preferring actual over the list estimate. */
export function effectiveCost(cost: CostRecord): number {
  return cost.actualCostUsd ?? cost.listPriceEstimateUsd;
}

export interface CostEfficiency {
  totalCostUsd: number;
  runs: number;
  passingRuns: number;
  qualifiedRuns: number;
  humanQualityPoints: number;
  costPerBenchmark: number | null;
  costPerPassingRun: number | null;
  costPerQualifiedRun: number | null;
  costPerQualityPoint: number | null;
}

/** Aggregate cost-efficiency metrics. Quality inputs are provided separately. */
export function computeCostEfficiency(input: {
  costs: CostRecord[];
  benchmarks: number;
  passingRuns: number;
  qualifiedRuns: number;
  humanQualityPoints: number;
}): CostEfficiency {
  const totalCostUsd = input.costs.reduce((s, c) => s + effectiveCost(c), 0);
  const div = (n: number, d: number): number | null => (d > 0 ? n / d : null);
  return {
    totalCostUsd,
    runs: input.costs.length,
    passingRuns: input.passingRuns,
    qualifiedRuns: input.qualifiedRuns,
    humanQualityPoints: input.humanQualityPoints,
    costPerBenchmark: div(totalCostUsd, input.benchmarks),
    costPerPassingRun: div(totalCostUsd, input.passingRuns),
    costPerQualifiedRun: div(totalCostUsd, input.qualifiedRuns),
    costPerQualityPoint: div(totalCostUsd, input.humanQualityPoints),
  };
}
