/**
 * Campaign budgets and spend tracking.
 *
 * Budgets stop execution safely; budget exhaustion is classified as a campaign
 * control event, NOT a model failure. An explicit acknowledgement is required
 * when the upper-bound estimate exceeds the total budget.
 */
import { z } from "zod";

export const BudgetSchema = z.object({
  maximumTotalUsd: z.number().nonnegative(),
  maximumPerTargetUsd: z.number().nonnegative().optional(),
  maximumPerRunUsd: z.number().nonnegative().optional(),
  stopOnBudgetExhaustion: z.boolean().default(true),
});
export type Budget = z.infer<typeof BudgetSchema>;

function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = camelizeKeys(v);
    }
    return out;
  }
  return value;
}

export function parseBudget(raw: unknown): Budget {
  return BudgetSchema.parse(camelizeKeys(raw));
}

export interface CampaignCostEstimate {
  minUsd: number;
  expectedUsd: number;
  upperUsd: number;
}

/** Estimate a campaign's cost from per-run estimates. */
export function estimateCampaign(perRunEstimatesUsd: number[], runs: number): CampaignCostEstimate {
  if (perRunEstimatesUsd.length === 0 || runs === 0) {
    return { minUsd: 0, expectedUsd: 0, upperUsd: 0 };
  }
  const min = Math.min(...perRunEstimatesUsd);
  const max = Math.max(...perRunEstimatesUsd);
  const mean = perRunEstimatesUsd.reduce((a, b) => a + b, 0) / perRunEstimatesUsd.length;
  return { minUsd: min * runs, expectedUsd: mean * runs, upperUsd: max * runs };
}

/** True when the upper-bound estimate exceeds the total budget. */
export function requiresAcknowledgement(estimate: CampaignCostEstimate, budget: Budget): boolean {
  return estimate.upperUsd > budget.maximumTotalUsd;
}

export type RunDecision =
  | { allowed: true }
  | { allowed: false; reason: string; classification: "budget_exhausted" | "per_target_exhausted" | "per_run_exceeds" };

export class BudgetTracker {
  private total = 0;
  private readonly perTarget = new Map<string, number>();

  constructor(private readonly budget: Budget) {}

  get spentTotal(): number {
    return this.total;
  }

  spentForTarget(targetId: string): number {
    return this.perTarget.get(targetId) ?? 0;
  }

  /** Decide whether a run with the given estimated cost may proceed. */
  canRun(targetId: string, estimatedCostUsd: number): RunDecision {
    if (this.budget.maximumPerRunUsd !== undefined && estimatedCostUsd > this.budget.maximumPerRunUsd) {
      return { allowed: false, reason: `run estimate ${estimatedCostUsd} > per-run cap ${this.budget.maximumPerRunUsd}`, classification: "per_run_exceeds" };
    }
    if (this.total + estimatedCostUsd > this.budget.maximumTotalUsd) {
      return { allowed: false, reason: "total budget would be exceeded", classification: "budget_exhausted" };
    }
    if (
      this.budget.maximumPerTargetUsd !== undefined &&
      this.spentForTarget(targetId) + estimatedCostUsd > this.budget.maximumPerTargetUsd
    ) {
      return { allowed: false, reason: "per-target budget would be exceeded", classification: "per_target_exhausted" };
    }
    return { allowed: true };
  }

  /** Record actual spend after a run completes. */
  record(targetId: string, actualCostUsd: number): void {
    this.total += actualCostUsd;
    this.perTarget.set(targetId, this.spentForTarget(targetId) + actualCostUsd);
  }

  isExhausted(): boolean {
    return this.total >= this.budget.maximumTotalUsd;
  }
}

/**
 * Budget exhaustion is a control event, not a model failure. Callers stamp this
 * on skipped runs so they are never counted as model quality failures.
 */
export function budgetStopIsModelFailure(): boolean {
  return false;
}
