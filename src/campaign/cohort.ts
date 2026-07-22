/**
 * Versioned benchmark cohort definitions.
 *
 * A cohort binds a human-reviewed, versioned set of targets to inference
 * profiles and routing policy. A target is identified by exactly one of:
 *   - `model`            (a pinned canonical slug),
 *   - `requestedModel`   (a mutable alias, resolved before execution), or
 *   - `discoveryRule`    (a proposal rule — never silently pinned).
 *
 * Model identity and reasoning configuration are kept separate: two targets may
 * share one model but differ by profile.
 */
import { z } from "zod";

export const COHORT_SCHEMA_VERSION = 1;

export const DiscoveryRuleSchema = z.object({
  author: z.string().optional(),
  nameContains: z.string().optional(),
  choose: z.enum(["newest", "most-popular", "intelligence-high-to-low", "context-high-to-low"]).default("newest"),
  requiredParameters: z.array(z.string()).optional(),
  minContextLength: z.number().int().optional(),
  requiredOutputModalities: z.array(z.string()).optional(),
  addedWithinDays: z.number().int().optional(),
  maxRank: z.number().int().optional(),
});
export type DiscoveryRule = z.infer<typeof DiscoveryRuleSchema>;

export const RoutingConfigSchema = z.object({
  mode: z.enum(["reproducibility", "availability"]).default("reproducibility"),
  /** Pin to a specific provider endpoint (reproducibility mode). */
  provider: z.string().optional(),
  /** Allow OpenRouter to fall back to a different provider. */
  allowFallback: z.boolean().default(false),
});
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

export const CohortTargetSchema = z
  .object({
    id: z.string().min(1),
    model: z.string().optional(),
    requestedModel: z.string().optional(),
    requireCanonicalResolution: z.boolean().default(false),
    discoveryRule: DiscoveryRuleSchema.optional(),
    requireHumanConfirmation: z.boolean().default(false),
    backend: z.string().default("openrouter"),
    /** Profile ids to run for this target (overrides the cohort default). */
    profiles: z.array(z.string()).optional(),
    routing: RoutingConfigSchema.optional(),
  })
  .superRefine((t, ctx) => {
    const kinds = [t.model, t.requestedModel, t.discoveryRule].filter((v) => v !== undefined);
    if (kinds.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: `target "${t.id}" must set exactly one of model | requestedModel | discoveryRule`,
      });
    }
  });
export type CohortTarget = z.infer<typeof CohortTargetSchema>;

export const CohortSchema = z.object({
  schemaVersion: z.literal(COHORT_SCHEMA_VERSION),
  id: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, { message: "version must be semver" }),
  description: z.string().default(""),
  purpose: z.string().default("frontier-evaluation"),
  routing: RoutingConfigSchema.prefault({}),
  requireZdr: z.boolean().default(false),
  /** Default profile ids applied to targets that do not specify their own. */
  profiles: z.array(z.string()).default(["neutral-baseline"]),
  targets: z.array(CohortTargetSchema).min(1),
});
export type Cohort = z.infer<typeof CohortSchema>;

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

export function parseCohort(raw: unknown): Cohort {
  return CohortSchema.parse(camelizeKeys(raw));
}

/** Targets that carry a discovery rule or require confirmation before use. */
export function pendingConfirmationTargets(cohort: Cohort): CohortTarget[] {
  return cohort.targets.filter((t) => t.discoveryRule !== undefined || t.requireHumanConfirmation);
}
