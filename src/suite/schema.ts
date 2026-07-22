/**
 * Benchmark suite schema.
 *
 * YAML is only an *input* transport. Every benchmark definition is parsed from
 * YAML and then validated + normalized through these Zod schemas. The rest of
 * the codebase only ever handles the inferred domain types below — never raw
 * YAML/JSON shapes.
 *
 * `BENCHMARK_SCHEMA_VERSION` is versioned independently from the run-record,
 * experiment, and matrix schemas.
 */
import { z } from "zod";

/** Independent schema version for benchmark definitions. */
export const BENCHMARK_SCHEMA_VERSION = 1;

/** Evaluation domains. Fiction lives in its own namespace. */
export const DomainSchema = z.enum([
  "architecture",
  "security",
  "coding",
  "formal",
  "writing",
  "fiction",
]);
export type Domain = z.infer<typeof DomainSchema>;

/**
 * Difficulty reflects realistic professional task complexity, not academic
 * puzzle difficulty.
 */
export const DifficultySchema = z.enum(["medium", "advanced", "expert"]);
export type Difficulty = z.infer<typeof DifficultySchema>;

/**
 * Authority of an evaluator's verdict. Higher authority wins: an executable
 * verifier failure can never be silently overridden by a judge.
 */
export const AuthoritySchema = z.enum([
  "executable", // 1 — ran a real tool/build/test
  "structural", // 2 — deterministic structural checker
  "rule", // 3 — domain-specific rule evaluator
  "pairwise_judge", // 4 — pairwise LLM judge
  "scalar_judge", // 5 — scalar LLM score
]);
export type Authority = z.infer<typeof AuthoritySchema>;

/** Numeric rank for an authority (lower = more authoritative). */
export const AUTHORITY_RANK: Record<Authority, number> = {
  executable: 1,
  structural: 2,
  rule: 3,
  pairwise_judge: 4,
  scalar_judge: 5,
};

/**
 * A deterministic check. `blocking` checks gate qualification; a blocking
 * failure disqualifies, while a blocking check that cannot run (tool missing)
 * makes the result inconclusive rather than a failure.
 */
const CheckBase = {
  id: z.string().min(1),
  /** Human description of what the check asserts. */
  description: z.string().default(""),
  /** Blocking checks gate qualification. */
  blocking: z.boolean().default(true),
};

/**
 * Run an allowlisted tool with a fixed argv inside the execution sandbox.
 *
 * `tool` names an entry in the executable allowlist (see evaluators/tools.ts).
 * `args` is author-defined and validated — model output never contributes any
 * part of the executable or its argv.
 */
export const CommandCheckSchema = z.object({
  ...CheckBase,
  kind: z.literal("command"),
  authority: z.literal("executable").default("executable"),
  /** Allowlisted tool key, e.g. "node", "cargo", "tlc", "apalache", "lean". */
  tool: z.string().min(1),
  /** Fixed argument vector. No shell, no interpolation of model output. */
  args: z.array(z.string()).default([]),
  /** Expected process exit code for a pass. */
  expectExitCode: z.number().int().default(0),
  /** Per-command timeout (ms). */
  timeoutMs: z.number().int().positive().default(60_000),
  /** Optional regex the combined stdout+stderr must match to pass. */
  expectOutputMatches: z.string().optional(),
  /** Optional regex the combined stdout+stderr must NOT match (e.g. vacuity). */
  forbidOutputMatches: z.string().optional(),
});
export type CommandCheck = z.infer<typeof CommandCheckSchema>;

/** Validate model output (or an extracted file) against an embedded JSON Schema. */
export const JsonSchemaCheckSchema = z.object({
  ...CheckBase,
  kind: z.literal("json_schema"),
  authority: z.literal("structural").default("structural"),
  /** Where the JSON to validate comes from. */
  source: z.enum(["output", "file"]).default("output"),
  /** Required when source === "file": path within the extracted workspace. */
  path: z.string().optional(),
  /** Embedded JSON Schema (draft-07 subset supported by the checker). */
  schema: z.record(z.string(), z.unknown()),
});
export type JsonSchemaCheck = z.infer<typeof JsonSchemaCheckSchema>;

/** Require that the prose output contains the given section headings. */
export const RequiredSectionsCheckSchema = z.object({
  ...CheckBase,
  kind: z.literal("required_sections"),
  authority: z.literal("structural").default("structural"),
  /** Section titles that must appear (case-insensitive, as headings). */
  sections: z.array(z.string().min(1)).min(1),
});
export type RequiredSectionsCheck = z.infer<typeof RequiredSectionsCheckSchema>;

/** Assert the output matches / does not match a regular expression. */
export const RegexCheckSchema = z.object({
  ...CheckBase,
  kind: z.literal("regex"),
  authority: z.literal("structural").default("structural"),
  pattern: z.string().min(1),
  flags: z.string().default(""),
  /** true → must match; false → must NOT match. */
  mustMatch: z.boolean().default(true),
});
export type RegexCheck = z.infer<typeof RegexCheckSchema>;

/** Require that extraction produced the given files. */
export const FileExistsCheckSchema = z.object({
  ...CheckBase,
  kind: z.literal("file_exists"),
  authority: z.literal("structural").default("structural"),
  paths: z.array(z.string().min(1)).min(1),
});
export type FileExistsCheck = z.infer<typeof FileExistsCheckSchema>;

export const DeterministicCheckSchema = z.discriminatedUnion("kind", [
  CommandCheckSchema,
  JsonSchemaCheckSchema,
  RequiredSectionsCheckSchema,
  RegexCheckSchema,
  FileExistsCheckSchema,
]);
export type DeterministicCheck = z.infer<typeof DeterministicCheckSchema>;

/** A single scored dimension in an LLM-judge rubric. */
export const RubricDimensionSchema = z.object({
  id: z.string().min(1),
  description: z.string().default(""),
  /** Relative weight when composing the rubric score. */
  weight: z.number().positive().default(1),
});
export type RubricDimension = z.infer<typeof RubricDimensionSchema>;

/**
 * LLM-judge rubric. Judges are the lowest authority; they can never override an
 * executable failure. The rubric is stored so it can be re-applied to already
 * persisted runs, fully decoupled from generation.
 */
export const RubricSchema = z.object({
  /** Scoring scale, inclusive. */
  scaleMin: z.number().default(0),
  scaleMax: z.number().default(5),
  dimensions: z.array(RubricDimensionSchema).default([]),
  /** Extra guidance handed to the judge model. */
  guidance: z.string().default(""),
});
export type Rubric = z.infer<typeof RubricSchema>;

/**
 * Mandatory qualification thresholds. A target qualifies for a benchmark only
 * when every mandatory threshold is satisfied.
 */
export const QualificationSchema = z.object({
  deterministicPassRate: z.number().min(0).max(1).default(1),
  minimumDomainScore: z.number().default(0),
  maximumCatastrophicFailureRate: z.number().min(0).max(1).default(0),
  maximumEvaluatorDisagreement: z.number().min(0).max(1).default(0.25),
});
export type Qualification = z.infer<typeof QualificationSchema>;

/**
 * A benchmark definition as authored on disk (before task text and referenced
 * files are loaded). `taskFile`/`referenceFiles`/`fixtures` are resolved by the
 * loader relative to the benchmark directory.
 */
export const BenchmarkDefinitionSchema = z.object({
  schemaVersion: z.literal(BENCHMARK_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "id must be kebab-case",
  }),
  /** Semantic version, e.g. 1.0.0. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, {
    message: "version must be semver MAJOR.MINOR.PATCH",
  }),
  domain: DomainSchema,
  difficulty: DifficultySchema,
  title: z.string().min(1),
  /** Relative path to the Markdown task file. */
  taskFile: z.string().default("task.md"),
  /** Expected output format (free text contract shown to the model). */
  expectedOutputFormat: z.string().default(""),
  /** Hard constraints the output must respect. */
  requiredConstraints: z.array(z.string()).default([]),
  /** Optional reference-answer files (relative paths). */
  referenceFiles: z.array(z.string()).default([]),
  /** Fixture files copied into the workspace before checks run. */
  fixtures: z.array(z.string()).default([]),
  deterministicChecks: z.array(DeterministicCheckSchema).default([]),
  // prefault (not default): feed {} through the schema so inner field defaults
  // apply when the whole block is omitted.
  rubric: RubricSchema.prefault({}),
  qualification: QualificationSchema.prefault({}),
  timeoutMs: z.number().int().positive().default(120_000),
  maxOutputTokens: z.number().int().positive().default(4096),
  tags: z.array(z.string()).default([]),
  knownFailureModes: z.array(z.string()).default([]),
  /**
   * Prototype benchmarks validate the pipeline only and are excluded from
   * serious rankings and qualification decisions.
   */
  prototype: z.boolean().default(false),
}).superRefine((def, ctx) => {
  // Fail fast on regex checks whose patterns/flags do not compile in JS.
  for (const check of def.deterministicChecks) {
    const patterns: [string, string][] = [];
    if (check.kind === "regex") patterns.push([check.pattern, check.flags]);
    if (check.kind === "command") {
      if (check.expectOutputMatches) patterns.push([check.expectOutputMatches, "m"]);
      if (check.forbidOutputMatches) patterns.push([check.forbidOutputMatches, "m"]);
    }
    for (const [pattern, flags] of patterns) {
      try {
        new RegExp(pattern, flags);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: `check "${check.id}" has an invalid regex /${pattern}/${flags}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
});
export type BenchmarkDefinition = z.infer<typeof BenchmarkDefinitionSchema>;

/**
 * Parse and validate a raw (YAML-derived) benchmark definition object.
 * Throws a ZodError with actionable messages on failure.
 */
export function parseBenchmarkDefinition(raw: unknown): BenchmarkDefinition {
  return BenchmarkDefinitionSchema.parse(raw);
}
