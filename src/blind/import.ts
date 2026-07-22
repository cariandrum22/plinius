/**
 * Human-review import, validation, and (explicit) unblinding.
 *
 * Validation enforces score ranges/increments, rubric-version match, blind-id
 * existence, blocking↔qualification consistency, and duplicate rejection.
 * Unblinding — joining reviews to model identities via the private mapping — is
 * a separate, explicit operation.
 */
import {
  BlindReviewMapping,
  BlindReviewSet,
  HumanReviewRecord,
  HumanReviewRecordSchema,
} from "./schema.js";

export interface ImportError {
  index: number;
  blindId?: string;
  reviewerId?: string;
  errors: string[];
}

export interface ImportResult {
  accepted: HumanReviewRecord[];
  rejected: ImportError[];
}

function reviewKey(r: { reviewerId: string; blindId: string }): string {
  return `${r.reviewerId}::${r.blindId}`;
}

/** Validate one record against the review set. Returns a list of errors. */
export function validateHumanReviewRecord(
  record: HumanReviewRecord,
  set: BlindReviewSet,
): string[] {
  const errors: string[] = [];
  const item = set.items.find((i) => i.blindId === record.blindId);

  if (record.reviewSetId !== set.reviewSetId) {
    errors.push(`reviewSetId "${record.reviewSetId}" does not match "${set.reviewSetId}"`);
  }
  if (!item) {
    errors.push(`blindId "${record.blindId}" does not exist in the review set`);
    return errors; // cannot validate further without the item
  }

  const rubric = item.scoringRubric;
  if (record.rubricVersion !== rubric.version) {
    errors.push(`rubricVersion "${record.rubricVersion}" != item rubric "${rubric.version}"`);
  }

  // Dimension scores: present, in range, on the configured increment.
  for (const dim of rubric.dimensions) {
    const value = record.scores[dim.id];
    if (typeof value !== "number") {
      errors.push(`missing score for dimension "${dim.id}"`);
      continue;
    }
    if (value < rubric.scaleMin || value > rubric.scaleMax) {
      errors.push(`score "${dim.id}"=${value} out of range [${rubric.scaleMin},${rubric.scaleMax}]`);
    }
    const steps = (value - rubric.scaleMin) / rubric.increment;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      errors.push(`score "${dim.id}"=${value} not on increment ${rubric.increment}`);
    }
  }

  if (record.overallScore < rubric.scaleMin || record.overallScore > rubric.scaleMax) {
    errors.push(`overallScore ${record.overallScore} out of range [0,${rubric.scaleMax}]`);
  }
  if (record.confidence < 0 || record.confidence > 1) {
    errors.push(`confidence ${record.confidence} out of range [0,1]`);
  }

  // Blocking findings must be consistent with the recommendation.
  const hasBlocking = record.findings.some((f) => f.severity === "blocking");
  if (hasBlocking && record.qualificationRecommendation === "qualified") {
    errors.push("a blocking finding is inconsistent with qualificationRecommendation=qualified");
  }

  return errors;
}

/**
 * Parse + validate imported human-review records. Duplicate (reviewer, blindId)
 * records are rejected unless `allowUpdate` is set, in which case a later record
 * supersedes an earlier one.
 */
export function importHumanReviews(
  raw: unknown,
  set: BlindReviewSet,
  existing: HumanReviewRecord[] = [],
  allowUpdate = false,
): ImportResult {
  const rawArray = Array.isArray(raw) ? raw : [raw];
  const accepted: HumanReviewRecord[] = [];
  const rejected: ImportError[] = [];
  const seen = new Set<string>(existing.map(reviewKey));

  rawArray.forEach((rawRecord, index) => {
    const parsed = HumanReviewRecordSchema.safeParse(rawRecord);
    if (!parsed.success) {
      rejected.push({
        index,
        errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      return;
    }
    const record = parsed.data;
    const errors = validateHumanReviewRecord(record, set);

    const key = reviewKey(record);
    if (seen.has(key) && !allowUpdate) {
      errors.push(`duplicate review for reviewer "${record.reviewerId}" / blindId "${record.blindId}"`);
    }

    if (errors.length > 0) {
      rejected.push({ index, blindId: record.blindId, reviewerId: record.reviewerId, errors });
      return;
    }
    seen.add(key);
    accepted.push(record);
  });

  return { accepted, rejected };
}

export interface UnblindedReview extends HumanReviewRecord {
  runRecordId: string;
  targetId: string;
  experimentId: string;
  repetitionIndex: number;
}

/**
 * Explicitly join validated reviews to their source identities via the private
 * mapping. Reviews with no mapping entry are dropped (and reported by count).
 */
export function unblindReviews(
  reviews: HumanReviewRecord[],
  mapping: BlindReviewMapping,
): { unblinded: UnblindedReview[]; unmatched: number } {
  const byBlindId = new Map(mapping.mapping.map((m) => [m.blindId, m]));
  const unblinded: UnblindedReview[] = [];
  let unmatched = 0;
  for (const review of reviews) {
    const m = byBlindId.get(review.blindId);
    if (!m) {
      unmatched++;
      continue;
    }
    unblinded.push({
      ...review,
      runRecordId: m.runRecordId,
      targetId: m.targetId,
      experimentId: m.experimentId,
      repetitionIndex: m.repetitionIndex,
    });
  }
  return { unblinded, unmatched };
}
