/**
 * Benchmark Framework — Blind Review Workflow (requirements 9 + 10).
 *
 * A review set is a DERIVED artifact built from campaign run records. Each run
 * becomes a blind Review Task with an opaque blind id (reusing the blind-id
 * primitive) and a lifecycle state machine:
 *
 *   CREATED → ASSIGNED → IN_REVIEW → REVIEWED → FINALIZED
 *
 * Reviewer identity is never stored. The public review set carries only the
 * blind id, benchmark id, and category; the mapping from blind id back to the
 * run (model/backend) is a separate private artifact. This module is pure — the
 * command layer handles persistence and the public/private split.
 */
import { z } from "zod";
import { assignBlindIds } from "../blind/blind-id.js";

export const REVIEW_SCHEMA_VERSION = 1;
export const REVIEW_MAPPING_SCHEMA_VERSION = 1;

export const REVIEW_STATES = [
  "CREATED",
  "ASSIGNED",
  "IN_REVIEW",
  "REVIEWED",
  "FINALIZED",
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** Allowed forward transitions. Any other transition is rejected. */
const TRANSITIONS: Record<ReviewState, ReviewState | null> = {
  CREATED: "ASSIGNED",
  ASSIGNED: "IN_REVIEW",
  IN_REVIEW: "REVIEWED",
  REVIEWED: "FINALIZED",
  FINALIZED: null,
};

export function canTransition(from: ReviewState, to: ReviewState): boolean {
  return TRANSITIONS[from] === to;
}

/** Reviewer comment (requirement 10). `comment` is Markdown. No reviewer id. */
export const ReviewerCommentSchema = z.object({
  /** Overall score on the benchmark's rubric scale. */
  score: z.number(),
  /** Optional per-dimension scores keyed by rubric dimension id. */
  dimensionScores: z.record(z.string(), z.number()).default({}),
  /** Free-form Markdown assessment. */
  comment: z.string().default(""),
  strength: z.string().default(""),
  weakness: z.string().default(""),
  notes: z.string().default(""),
});
export type ReviewerComment = z.infer<typeof ReviewerCommentSchema>;

/** A single blind review task (public — carries no model/backend identity). */
export interface ReviewTask {
  blindId: string;
  benchmarkId: string;
  category: string;
  state: ReviewState;
  /** Present once the task reaches REVIEWED. */
  comment: ReviewerComment | null;
}

export interface ReviewSet {
  schemaVersion: number;
  reviewSetId: string;
  campaignId: string;
  createdAt: string;
  tasks: ReviewTask[];
}

/** Private mapping from blind id back to the run (kept separate from the set). */
export interface ReviewMappingEntry {
  blindId: string;
  runId: string;
  backend: string;
  model: string;
  benchmarkId: string;
  repetitionIndex: number;
}

export interface ReviewMapping {
  schemaVersion: number;
  reviewSetId: string;
  campaignId: string;
  entries: ReviewMappingEntry[];
}

/** Minimal run shape the review set is built from. */
export interface ReviewableRun {
  runId: string;
  backend: string;
  model: string;
  benchmarkId: string;
  category: string;
  repetitionIndex: number;
}

export interface CreateReviewSetResult {
  set: ReviewSet;
  mapping: ReviewMapping;
}

/**
 * Create a blind review set from run records. Blind ids are assigned with the
 * given seed; runs are processed in sorted order for determinism. Every task
 * starts in CREATED.
 */
export function createReviewSet(
  runs: ReviewableRun[],
  options: { campaignId: string; reviewSetId: string; seed: string; createdAt: string },
): CreateReviewSetResult {
  const ids = runs.map((r) => r.runId);
  const blindIds = assignBlindIds(ids, options.seed, "R");

  const ordered = [...runs].sort((a, b) => a.runId.localeCompare(b.runId));

  const tasks: ReviewTask[] = ordered.map((r) => ({
    blindId: blindIds.get(r.runId)!,
    benchmarkId: r.benchmarkId,
    category: r.category,
    state: "CREATED",
    comment: null,
  }));

  const entries: ReviewMappingEntry[] = ordered.map((r) => ({
    blindId: blindIds.get(r.runId)!,
    runId: r.runId,
    backend: r.backend,
    model: r.model,
    benchmarkId: r.benchmarkId,
    repetitionIndex: r.repetitionIndex,
  }));

  return {
    set: {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      reviewSetId: options.reviewSetId,
      campaignId: options.campaignId,
      createdAt: options.createdAt,
      tasks,
    },
    mapping: {
      schemaVersion: REVIEW_MAPPING_SCHEMA_VERSION,
      reviewSetId: options.reviewSetId,
      campaignId: options.campaignId,
      entries,
    },
  };
}

function findTask(set: ReviewSet, blindId: string): ReviewTask {
  const task = set.tasks.find((t) => t.blindId === blindId);
  if (!task) throw new Error(`Unknown review task "${blindId}" in set ${set.reviewSetId}`);
  return task;
}

/** Advance a task to the next state, validating the transition. */
export function advanceTask(set: ReviewSet, blindId: string, to: ReviewState): ReviewTask {
  const task = findTask(set, blindId);
  if (!canTransition(task.state, to)) {
    throw new Error(`Illegal review transition ${task.state} → ${to} for ${blindId}`);
  }
  task.state = to;
  return task;
}

/**
 * Submit a reviewer comment: attaches the comment and moves the task to
 * REVIEWED. The task must be IN_REVIEW.
 */
export function submitReview(set: ReviewSet, blindId: string, comment: ReviewerComment): ReviewTask {
  const task = findTask(set, blindId);
  if (task.state !== "IN_REVIEW") {
    throw new Error(`Cannot submit review for ${blindId} in state ${task.state} (must be IN_REVIEW)`);
  }
  task.comment = ReviewerCommentSchema.parse(comment);
  task.state = "REVIEWED";
  return task;
}

/** Count tasks per state (for status reporting). */
export function reviewStateCounts(set: ReviewSet): Record<ReviewState, number> {
  const counts = Object.fromEntries(REVIEW_STATES.map((s) => [s, 0])) as Record<ReviewState, number>;
  for (const task of set.tasks) counts[task.state] += 1;
  return counts;
}
