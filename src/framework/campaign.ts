/**
 * Benchmark Framework — Campaign specification.
 *
 * A Campaign is an *execution plan* over Benchmarks: it selects which benchmarks
 * to run, on which backends, against which models, with which sampling, and how
 * many repetitions. Benchmarks are backend-independent assets; the Campaign is
 * where backend/model selection happens.
 *
 * The Campaign may pin benchmark, prompt, and rubric versions so a run asserts
 * exactly which asset versions it evaluated (reproducibility first). YAML is an
 * input transport only.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { camelizeKeys } from "./benchmark.js";

export const CAMPAIGN_SCHEMA_VERSION = 1;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

export const CampaignSamplingSchema = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  /** Base seed; repetition r uses seed = seed + r when seedStrategy=varying. */
  seed: z.number().int().default(0),
  seedStrategy: z.enum(["fixed", "varying"]).default("fixed"),
});
export type CampaignSampling = z.infer<typeof CampaignSamplingSchema>;

/**
 * A pinned benchmark reference. `version` (optional) asserts the on-disk asset
 * must match; a mismatch fails the run rather than silently evaluating a
 * different version.
 */
export const CampaignBenchmarkRefSchema = z.object({
  id: z.string().regex(KEBAB),
  version: z.string().regex(SEMVER).optional(),
  /** Assert the rubric version too, when set. */
  rubricVersion: z.string().regex(SEMVER).optional(),
});
export type CampaignBenchmarkRef = z.infer<typeof CampaignBenchmarkRefSchema>;

export const CampaignSpecSchema = z.object({
  schemaVersion: z.literal(CAMPAIGN_SCHEMA_VERSION),
  id: z.string().regex(KEBAB, { message: "campaign id must be kebab-case" }),
  title: z.string().min(1),
  description: z.string().default(""),
  /** Benchmarks to run: "all", a list of ids, or pinned refs. */
  benchmarks: z
    .union([
      z.literal("all"),
      z.array(z.union([z.string().regex(KEBAB), CampaignBenchmarkRefSchema])),
    ])
    .default("all"),
  /** Backends to execute against (registry names, e.g. "vllm", "openrouter"). */
  backends: z.array(z.string().min(1)).min(1),
  /** Models to evaluate. Interpreted per backend at run time. */
  models: z.array(z.string().min(1)).min(1),
  sampling: CampaignSamplingSchema.prefault({}),
  repetitions: z.number().int().positive().default(1),
  /** Records never contribute to rankings when true (pilots, smoke runs). */
  excludeFromRankings: z.boolean().default(false),
});
export type CampaignSpec = z.infer<typeof CampaignSpecSchema>;

/** Normalize the benchmarks field into a list of refs ("all" resolved later). */
export function campaignBenchmarkRefs(spec: CampaignSpec): CampaignBenchmarkRef[] | "all" {
  if (spec.benchmarks === "all") return "all";
  return spec.benchmarks.map((b) => (typeof b === "string" ? { id: b } : b));
}

export function parseCampaignSpec(raw: unknown): CampaignSpec {
  return CampaignSpecSchema.parse(camelizeKeys(raw));
}

/** Default campaign directory (repo root). */
export function getCampaignDir(): string {
  return join(process.cwd(), "campaign");
}

/**
 * Resolve a campaign reference to a file path. Accepts a bare id
 * (`campaign/<id>.yaml`) or an explicit path.
 */
export function resolveCampaignPath(idOrPath: string, dir: string = getCampaignDir()): string {
  if (idOrPath.endsWith(".yaml") || idOrPath.endsWith(".yml") || idOrPath.includes("/")) {
    return idOrPath;
  }
  return join(dir, `${idOrPath}.yaml`);
}

export async function loadCampaignSpec(idOrPath: string): Promise<CampaignSpec> {
  const path = resolveCampaignPath(idOrPath);
  const raw = await readFile(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new Error(`Invalid YAML in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseCampaignSpec(parsed);
  } catch (error) {
    throw new Error(
      `Campaign schema validation failed for ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
