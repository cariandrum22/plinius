/**
 * Three-stage campaign execution plan.
 *
 * Prototype calibration does not immediately run every model across every
 * repetition. Stage 1 is a cheap protocol smoke test, Stage 2 a two-repetition
 * screening, and Stage 3 the calibrated campaign — the last only after human
 * review of Stage 2.
 */
import { Cohort } from "./cohort.js";

export interface PlanStage {
  stage: 1 | 2 | 3;
  name: string;
  description: string;
  targetIds: string[];
  benchmarkSelector: "one-cheap" | "six-prototype" | "approved";
  repetitions: number;
  profiles: string[];
  blindReview: boolean;
  excludePrototypeFromQualification: boolean;
  requiresHumanReviewBefore: boolean;
  verifies?: string[];
}

export interface CampaignPlan {
  cohortId: string;
  cohortVersion: string;
  stages: PlanStage[];
}

export function buildCampaignPlan(cohort: Cohort): CampaignPlan {
  const targetIds = cohort.targets.map((t) => t.id);
  const neutral = ["neutral-baseline"];

  return {
    cohortId: cohort.id,
    cohortVersion: cohort.version,
    stages: [
      {
        stage: 1,
        name: "protocol-smoke-test",
        description: "One inexpensive benchmark per target to verify the protocol.",
        targetIds,
        benchmarkSelector: "one-cheap",
        repetitions: 1,
        profiles: neutral,
        blindReview: false,
        excludePrototypeFromQualification: true,
        requiresHumanReviewBefore: false,
        verifies: [
          "availability",
          "parameter-support",
          "response-parsing",
          "reasoning-metadata",
          "usage-data",
          "provider-provenance",
          "cost-retrieval",
          "finish-reasons",
          "content-filter-behavior",
        ],
      },
      {
        stage: 2,
        name: "screening",
        description: "Six prototype benchmarks, two repetitions, neutral baseline.",
        targetIds,
        benchmarkSelector: "six-prototype",
        repetitions: 2,
        profiles: neutral,
        blindReview: false,
        excludePrototypeFromQualification: true,
        requiresHumanReviewBefore: false,
      },
      {
        stage: 3,
        name: "calibrated-campaign",
        description: "Approved benchmarks, five repetitions, neutral + high-reasoning, blind Japanese review.",
        targetIds,
        benchmarkSelector: "approved",
        repetitions: 5,
        profiles: [...neutral, "high-reasoning"],
        blindReview: true,
        excludePrototypeFromQualification: true,
        requiresHumanReviewBefore: true,
      },
    ],
  };
}
