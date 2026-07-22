/**
 * Evaluation manifest.
 *
 * A single self-describing record of *what was evaluated*: campaign, run,
 * catalog + prompt snapshot ids, environment, targets (with resolved slugs and
 * lifecycle), profiles, budget, and per-target generation provenance. Building
 * is deterministic given its inputs (timestamp injected). The schema is
 * versioned and forward/backward tolerant.
 */
import { z } from "zod";
import { EvaluationEnvironment } from "../environment/environment.js";
import { GenerationProvenance, ProvenanceStatus } from "../provenance/schema.js";
import { ModelLifecycle } from "../campaign/lifecycle.js";
import { Budget } from "../campaign/budget.js";

export const MANIFEST_SCHEMA_VERSION = 1;

export interface ManifestTarget {
  targetId: string;
  requestedSlug: string | null;
  canonicalSlug: string | null;
  lifecycle: ModelLifecycle;
  provenanceStatus: ProvenanceStatus;
}

export interface EvaluationManifest {
  schemaVersion: number;
  campaignId: string;
  runId: string;
  catalogSnapshotId: string;
  promptSnapshotId: string;
  environment: EvaluationEnvironment;
  targetModels: ManifestTarget[];
  profiles: string[];
  budget: Budget | null;
  timestamp: string;
  generationProvenance: GenerationProvenance[];
}

export interface BuildManifestInput {
  campaignId: string;
  runId: string;
  catalogSnapshotId: string;
  promptSnapshotId: string;
  environment: EvaluationEnvironment;
  targetModels: ManifestTarget[];
  profiles: string[];
  budget?: Budget | null;
  timestamp: string;
  generationProvenance?: GenerationProvenance[];
}

export function buildManifest(input: BuildManifestInput): EvaluationManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    campaignId: input.campaignId,
    runId: input.runId,
    catalogSnapshotId: input.catalogSnapshotId,
    promptSnapshotId: input.promptSnapshotId,
    environment: input.environment,
    targetModels: input.targetModels,
    profiles: input.profiles,
    budget: input.budget ?? null,
    timestamp: input.timestamp,
    generationProvenance: input.generationProvenance ?? [],
  };
}

/**
 * Lenient manifest schema. Newly-added optional fields default to safe values so
 * older manifests still validate; unknown extra fields are preserved (loose).
 */
export const ManifestSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    campaignId: z.string(),
    runId: z.string(),
    catalogSnapshotId: z.string(),
    promptSnapshotId: z.string(),
    environment: z.record(z.string(), z.unknown()),
    targetModels: z
      .array(
        z
          .object({
            targetId: z.string(),
            requestedSlug: z.string().nullable().default(null),
            canonicalSlug: z.string().nullable().default(null),
            lifecycle: z.enum(["ACTIVE", "DEPRECATED", "RETIRED", "UNKNOWN"]).default("UNKNOWN"),
            provenanceStatus: z.enum(["complete", "partial", "missing"]).default("missing"),
          })
          .loose(),
      )
      .default([]),
    profiles: z.array(z.string()).default([]),
    budget: z.unknown().nullable().default(null),
    timestamp: z.string(),
    generationProvenance: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .loose();

export function validateManifest(raw: unknown): EvaluationManifest {
  return ManifestSchema.parse(raw) as unknown as EvaluationManifest;
}
