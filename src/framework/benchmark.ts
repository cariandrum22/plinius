/**
 * Benchmark Framework — benchmark asset schema, prompts, rubric, references.
 *
 * A Benchmark is a backend-independent evaluation *asset* that carries no
 * scores. YAML is only an input transport; every asset is validated and
 * normalized through these Zod schemas. Keys may be authored in snake_case —
 * they are normalized to camelCase before validation.
 *
 * On disk, a benchmark lives at `benchmark/<category>/<id>/`:
 *
 *   metadata.yaml    — schema fields (this file's BenchmarkAssetSchema)
 *   system.md        — the reusable system prompt (kept separate from user.md)
 *   user.md          — the task-specific user prompt
 *   rubric.yaml      — evaluation criteria + weights only, never expected answers
 *   references.md    — intent / assumptions / reviewer notes (no leaked solution)
 *
 * `BENCHMARK_ASSET_SCHEMA_VERSION` is versioned independently.
 */
import { z } from "zod";

/** Independent schema version for framework benchmark assets. */
export const BENCHMARK_ASSET_SCHEMA_VERSION = 1;

/** Benchmark categories. `common` holds shared, non-runnable assets. */
export const CategorySchema = z.enum([
  "software-engineering",
  "architecture",
  "security",
  "formal-reasoning",
  "common",
]);
export type Category = z.infer<typeof CategorySchema>;

/** Difficulty levels (easy < medium < hard < expert). */
export const DifficultySchema = z.enum(["easy", "medium", "hard", "expert"]);
export type Difficulty = z.infer<typeof DifficultySchema>;

const SEMVER = /^\d+\.\d+\.\d+$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Benchmark metadata (metadata.yaml). Flat by design so the file stays easy to
 * author and review. `golden` marks longitudinal-comparison benchmarks that
 * stay stable across releases.
 */
export const BenchmarkAssetSchema = z.object({
  schemaVersion: z.literal(BENCHMARK_ASSET_SCHEMA_VERSION).default(BENCHMARK_ASSET_SCHEMA_VERSION),
  id: z.string().regex(KEBAB, { message: "id must be kebab-case" }),
  title: z.string().min(1),
  version: z.string().regex(SEMVER, { message: "version must be semver MAJOR.MINOR.PATCH" }),
  category: CategorySchema,
  difficulty: DifficultySchema,
  /** Rough token budget for a single run (author estimate). */
  estimatedTokens: z.number().int().positive(),
  tags: z.array(z.string()).default([]),
  author: z.string().min(1),
  license: z.string().min(1),
  /** Longitudinal golden benchmark — held stable across releases. */
  golden: z.boolean().default(false),
  description: z.string().default(""),
  /** Asset file names, relative to the benchmark directory. */
  systemFile: z.string().default("system.md"),
  userFile: z.string().default("user.md"),
  rubricFile: z.string().default("rubric.yaml"),
  referencesFile: z.string().default("references.md"),
});
export type BenchmarkAsset = z.infer<typeof BenchmarkAssetSchema>;

/**
 * A single rubric criterion. Holds the evaluation *criterion* and its relative
 * weight only — never a score or an expected answer.
 */
export interface RubricCriterion {
  name: string;
  weight: number;
  description: string;
}

export interface Rubric {
  criteria: RubricCriterion[];
}

/**
 * Parse the rubric.yaml map form:
 *
 *   Correctness:
 *     weight: 40
 *   Architecture:
 *     weight: 20
 *
 * Each entry maps a criterion name to `{ weight, description? }`. Weights are
 * relative and need not sum to 100. A bare number (`Correctness: 40`) is also
 * accepted. Rejects zero/negative weights and empty rubrics.
 */
export function parseRubric(raw: unknown): Rubric {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("rubric must be a mapping of criterion name to weight");
  }
  const criteria: RubricCriterion[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    let weight: number;
    let description = "";
    if (typeof value === "number") {
      weight = value;
    } else if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const w = obj.weight ?? obj.Weight;
      if (typeof w !== "number") {
        throw new Error(`rubric criterion "${name}" is missing a numeric weight`);
      }
      weight = w;
      if (typeof obj.description === "string") description = obj.description;
    } else {
      throw new Error(`rubric criterion "${name}" must be a number or an object with a weight`);
    }
    if (!(weight > 0)) throw new Error(`rubric criterion "${name}" must have a positive weight`);
    criteria.push({ name, weight, description });
  }
  if (criteria.length === 0) throw new Error("rubric must define at least one criterion");
  return { criteria };
}

/** Recursively convert object keys from snake_case to camelCase. */
export function camelizeKeys(value: unknown): unknown {
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

export function parseBenchmarkAsset(raw: unknown): BenchmarkAsset {
  return BenchmarkAssetSchema.parse(camelizeKeys(raw));
}
