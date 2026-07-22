/**
 * Experiment specification.
 *
 * Experiments describe *how* to run benchmarks against targets: repetitions,
 * seed strategy, sampling, timeout, and concurrency. YAML is only the input
 * transport; the Zod-validated {@link ExperimentSpec} is what the runner uses.
 *
 * `EXPERIMENT_SCHEMA_VERSION` is versioned independently.
 */
import { readFile } from "fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const EXPERIMENT_SCHEMA_VERSION = 1;

export const ExperimentSpecSchema = z.object({
  schemaVersion: z.literal(EXPERIMENT_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: "id must be kebab-case" }),
  description: z.string().default(""),
  /**
   * Why the experiment exists. `infrastructure-validation` runs are pipeline
   * smoke tests and must be excluded from rankings.
   */
  purpose: z
    .enum(["ranking", "infrastructure-validation", "exploration"])
    .default("ranking"),
  /** When true, results never contribute to serious rankings/qualification. */
  excludeFromRankings: z.boolean().default(false),
  /** Target ids (from the experiment/config targets). */
  targets: z.array(z.string().min(1)).min(1),
  /** Benchmark ids to run, or "all" for every discovered benchmark. */
  benchmarks: z.union([z.literal("all"), z.array(z.string().min(1))]).default("all"),
  promptProfile: z.string().default("none"),
  repetitions: z.number().int().positive().default(1),
  seedStrategy: z.enum(["fixed", "varying"]).default("fixed"),
  baseSeed: z.number().int().default(0),
  sampling: z
    .object({
      temperature: z.number().optional(),
      topP: z.number().optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .prefault({}),
  timeoutMs: z.number().int().positive().default(120_000),
  /** Phase 1 defaults to sequential execution. */
  concurrency: z.number().int().positive().default(1),
});

export type ExperimentSpec = z.infer<typeof ExperimentSpecSchema>;

export function parseExperimentSpec(raw: unknown): ExperimentSpec {
  return ExperimentSpecSchema.parse(raw);
}

export async function loadExperimentSpec(path: string): Promise<ExperimentSpec> {
  const rawYaml = await readFile(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (error) {
    throw new Error(
      `Invalid YAML in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return parseExperimentSpec(parsed);
  } catch (error) {
    throw new Error(
      `Experiment schema validation failed for ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Resolve the seed for a given repetition index per the seed strategy. */
export function seedForRepetition(spec: ExperimentSpec, repetitionIndex: number): number {
  return spec.seedStrategy === "fixed" ? spec.baseSeed : spec.baseSeed + repetitionIndex;
}

/** Whether this experiment's results should be excluded from rankings. */
export function isExcludedFromRankings(spec: ExperimentSpec): boolean {
  return spec.excludeFromRankings || spec.purpose === "infrastructure-validation";
}
