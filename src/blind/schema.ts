/**
 * Blind human-review schemas.
 *
 * Blind-review data is a DERIVED artifact built from canonical run records; the
 * run records are never mutated. The reviewer-visible packet and the private
 * mapping manifest are always separate. Reviewer-facing types intentionally
 * omit every model/runtime-identifying field.
 *
 * Independently versioned:
 *   - BLIND_REVIEW_SCHEMA_VERSION  (public review set)
 *   - MAPPING_SCHEMA_VERSION       (private mapping manifest)
 *   - HUMAN_REVIEW_SCHEMA_VERSION  (imported human scoring records)
 */
import { z } from "zod";

export const BLIND_REVIEW_SCHEMA_VERSION = 1;
export const MAPPING_SCHEMA_VERSION = 1;
export const HUMAN_REVIEW_SCHEMA_VERSION = 1;
export const GENERATION_MANIFEST_SCHEMA_VERSION = 1;

// --- Human scoring rubric (Japanese-labelled) ---------------------------------

export interface HumanRubricDimension {
  id: string;
  labelJa: string;
  description: string;
}

export interface HumanRubric {
  version: string;
  scaleMin: number;
  scaleMax: number;
  /** Allowed score increment (1 = integers only). */
  increment: number;
  dimensions: HumanRubricDimension[];
}

/** Standard calibration rubric with natural Japanese labels. */
export const STANDARD_HUMAN_RUBRIC: HumanRubric = {
  version: "human-rubric-ja-1.0.0",
  scaleMin: 0,
  scaleMax: 5,
  increment: 1,
  dimensions: [
    { id: "accuracy", labelJa: "正確性", description: "主張・事実・計算が正しいか" },
    { id: "completeness", labelJa: "完全性", description: "課題の要求を漏れなく満たしているか" },
    { id: "instruction_adherence", labelJa: "指示遵守", description: "指示・出力形式に従っているか" },
    { id: "internal_consistency", labelJa: "内部整合性", description: "回答内で矛盾がないか" },
    { id: "clarity", labelJa: "明瞭性", description: "専門家にとって明快で読みやすいか" },
    { id: "practicality", labelJa: "実用性", description: "実務でそのまま使える水準か" },
    { id: "requirement_fidelity", labelJa: "要件忠実度", description: "必須条件を忠実に満たしているか" },
  ],
};

// --- Reviewer-visible packet --------------------------------------------------

export interface ReviewerArtifact {
  /** Sanitized relative path (must not encode model identity). */
  path: string;
  content: string;
  truncated?: boolean;
}

export interface TranslationMetadata {
  translatorType: "human" | "machine";
  translatorId: string;
  translatedAt: string;
  sourceHash: string;
}

export interface BlindReviewItem {
  blindId: string;
  benchmarkId: string;
  benchmarkVersion: string;
  domain: string;
  difficulty: string;
  taskText: string;
  expectedOutputFormat?: string;
  requiredConstraints?: string[];
  /** The ORIGINAL model answer, never auto-translated. Authoritative target. */
  responseText: string;
  /** Language tag of the original answer, when detectable ("ja", "und", ...). */
  responseLanguage?: string;
  extractedArtifacts?: ReviewerArtifact[];
  /** Optional, clearly-marked reference translation. Never the scoring target. */
  referenceTranslation?: string;
  translationMetadata?: TranslationMetadata;
  scoringRubric: HumanRubric;
}

export interface RandomizationMetadata {
  algorithm: string;
  algorithmVersion: string;
  /** Public: hash of the seed only (never the raw seed). */
  seedHash: string;
  shuffleResponses: boolean;
  shuffleBenchmarkOrder: boolean;
  pairwise: boolean;
  sourceRecordsHash: string;
  generatedSetHash: string;
}

export interface BlindReviewSet {
  schemaVersion: number;
  reviewSetId: string;
  createdAt: string;
  locale: string;
  purpose: string;
  excludeFromModelQualification: boolean;
  benchmarkIds: string[];
  /** benchmarkId -> benchmark definition version (provenance only). */
  rubricVersions: Record<string, string>;
  randomization: RandomizationMetadata;
  items: BlindReviewItem[];
}

// --- Pairwise packet ----------------------------------------------------------

export const PAIRWISE_CHOICES = [
  "a_clearly_better",
  "a_slightly_better",
  "equivalent",
  "b_slightly_better",
  "b_clearly_better",
] as const;
export type PairwiseChoice = (typeof PAIRWISE_CHOICES)[number];

export interface PairwiseItem {
  blindId: string;
  benchmarkId: string;
  benchmarkVersion: string;
  domain: string;
  difficulty: string;
  taskText: string;
  expectedOutputFormat?: string;
  requiredConstraints?: string[];
  responseA: string;
  responseB: string;
}

export interface PairwiseReviewSet {
  schemaVersion: number;
  reviewSetId: string;
  createdAt: string;
  locale: string;
  purpose: string;
  excludeFromModelQualification: boolean;
  benchmarkIds: string[];
  randomization: RandomizationMetadata;
  items: PairwiseItem[];
}

// --- Private mapping manifest --------------------------------------------------

export interface BlindReviewMappingEntry {
  blindId: string;
  runRecordId: string;
  experimentId: string;
  benchmarkId: string;
  targetId: string;
  repetitionIndex: number;
}

export interface PairwiseMappingEntry {
  blindId: string;
  benchmarkId: string;
  /** Which run record was shown as A vs B. */
  aRunRecordId: string;
  bRunRecordId: string;
  aTargetId: string;
  bTargetId: string;
}

export interface RedactionRecord {
  blindId: string;
  field: string;
  reason: string;
  matched: string;
  action: "flagged" | "excluded" | "redacted";
}

export interface BlindReviewMapping {
  schemaVersion: number;
  reviewSetId: string;
  /** Hash of the public review set this mapping unblinds. */
  publicSetHash: string;
  mapping: BlindReviewMappingEntry[];
  pairwiseMapping?: PairwiseMappingEntry[];
  redactions: RedactionRecord[];
}

export interface GenerationManifest {
  schemaVersion: number;
  reviewSetId: string;
  createdAt: string;
  experimentId: string;
  algorithm: string;
  algorithmVersion: string;
  /** Full seed stored here (private) when requested. */
  seed?: string;
  seedHash: string;
  sourceRecordsHash: string;
  publicSetHash: string;
  selection: unknown;
  filter: unknown;
  redactionPolicy: string;
}

// --- Human review record (imported) -------------------------------------------

export const HumanReviewFindingSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["minor", "major", "blocking"]),
  category: z.string().min(1),
  evidence: z.string().optional(),
  comment: z.string().optional(),
});
export type HumanReviewFinding = z.infer<typeof HumanReviewFindingSchema>;

export const HumanReviewRecordSchema = z.object({
  schemaVersion: z.literal(HUMAN_REVIEW_SCHEMA_VERSION),
  reviewSetId: z.string().min(1),
  blindId: z.string().min(1),
  reviewerId: z.string().min(1),
  rubricVersion: z.string().min(1),
  reviewedAt: z.string().optional(),
  scores: z.record(z.string(), z.number()),
  findings: z.array(HumanReviewFindingSchema).default([]),
  overallScore: z.number(),
  qualificationRecommendation: z.enum(["qualified", "not_qualified", "inconclusive"]),
  confidence: z.number(),
  notes: z.string().optional(),
});
export type HumanReviewRecord = z.infer<typeof HumanReviewRecordSchema>;

export const PairwiseHumanReviewSchema = z.object({
  schemaVersion: z.literal(HUMAN_REVIEW_SCHEMA_VERSION),
  reviewSetId: z.string().min(1),
  blindId: z.string().min(1),
  reviewerId: z.string().min(1),
  choice: z.enum(PAIRWISE_CHOICES),
  confidence: z.number(),
  rationale: z.string().optional(),
  reviewedAt: z.string().optional(),
});
export type PairwiseHumanReview = z.infer<typeof PairwiseHumanReviewSchema>;

// --- Blind-review generation config -------------------------------------------

export const SelectionSchema = z.object({
  mode: z.enum(["all", "random", "stratified", "explicit"]).default("all"),
  countPerTargetBenchmark: z.number().int().positive().optional(),
  runRecordIds: z.array(z.string()).optional(),
  /** Set only if a future score-based mode is used (leaks evaluator bias). */
  scoreBased: z.boolean().default(false),
});
export type SelectionConfig = z.infer<typeof SelectionSchema>;

export const RandomizationConfigSchema = z.object({
  shuffleResponses: z.boolean().default(true),
  shuffleBenchmarkOrder: z.boolean().default(false),
  pairwise: z.boolean().default(false),
  storeFullSeedInPrivate: z.boolean().default(true),
});

export const FilterSchema = z.object({
  includePrototypes: z.boolean().default(true),
  includeInfraValidation: z.boolean().default(true),
  targets: z.array(z.string()).optional(),
  benchmarks: z.array(z.string()).optional(),
});

export const RenderingSchema = z.object({
  locale: z.string().default("ja"),
  includeReferenceTranslation: z.boolean().default(false),
});

export const RedactionSchema = z.object({
  policy: z.enum(["flag", "exclude", "redact"]).default("flag"),
  extraDenylist: z.array(z.string()).default([]),
});

export const PairwiseConfigSchema = z.object({
  enabled: z.boolean().default(false),
  avoidSameModel: z.boolean().default(true),
});

export const BlindReviewConfigSchema = z.object({
  schemaVersion: z.literal(1),
  reviewSetId: z.string().optional(),
  locale: z.string().default("ja"),
  purpose: z.string().default("rubric-and-benchmark-calibration"),
  excludeFromModelQualification: z.boolean().default(true),
  /** Explicit blinding seed (required for reproducibility). */
  seed: z.string().min(1),
  selection: SelectionSchema.prefault({}),
  randomization: RandomizationConfigSchema.prefault({}),
  filter: FilterSchema.prefault({}),
  rendering: RenderingSchema.prefault({}),
  redaction: RedactionSchema.prefault({}),
  pairwise: PairwiseConfigSchema.prefault({}),
});
export type BlindReviewConfig = z.infer<typeof BlindReviewConfigSchema>;

/** Recursively convert object keys from snake_case to camelCase. */
function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const camel = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      out[camel] = camelizeKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * Parse a blind-review config. YAML may use snake_case (as in the docs) or
 * camelCase — keys are normalized before validation. Only object keys are
 * converted; string values (denylist terms, ids) are left untouched.
 */
export function parseBlindReviewConfig(raw: unknown): BlindReviewConfig {
  return BlindReviewConfigSchema.parse(camelizeKeys(raw));
}
