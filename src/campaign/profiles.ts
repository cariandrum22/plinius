/**
 * Inference profiles.
 *
 * Profiles are independent, named sampling+reasoning configurations — NOT one
 * universal config. A logical model evaluated under two profiles (e.g. standard
 * vs high reasoning) is two distinct experiment targets sharing one model
 * identity. YAML input may use snake_case; it is normalized to these types.
 */
import { z } from "zod";

export const INFERENCE_PROFILE_SCHEMA_VERSION = 1;

export const ReasoningConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Normalized effort tier. */
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  /** Optional explicit token budget for reasoning, when a model supports it. */
  maxTokens: z.number().int().positive().optional(),
  /** Whether to exclude returned reasoning text from the response. */
  exclude: z.boolean().optional(),
});
export type ReasoningConfig = z.infer<typeof ReasoningConfigSchema>;

export const InferenceProfileSchema = z.object({
  id: z.string().min(1),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().int().optional(),
  seed: z.number().int().optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoning: ReasoningConfigSchema.optional(),
});
export type InferenceProfile = z.infer<typeof InferenceProfileSchema>;

export const InferenceProfilesFileSchema = z.object({
  schemaVersion: z.literal(INFERENCE_PROFILE_SCHEMA_VERSION),
  profiles: z.record(z.string(), InferenceProfileSchema.omit({ id: true })),
});

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

/** Parse a profiles file (YAML-derived) into id-keyed profiles. */
export function parseInferenceProfiles(raw: unknown): Record<string, InferenceProfile> {
  const parsed = InferenceProfilesFileSchema.parse(camelizeKeys(raw));
  const out: Record<string, InferenceProfile> = {};
  for (const [id, profile] of Object.entries(parsed.profiles)) {
    out[id] = { id, ...profile };
  }
  return out;
}

/** Built-in default profiles (mirror the documented set). */
export const DEFAULT_PROFILES: Record<string, InferenceProfile> = {
  "neutral-baseline": { id: "neutral-baseline", temperature: 0.1, topP: 0.95, reasoning: { enabled: true, effort: "medium" } },
  "high-reasoning": { id: "high-reasoning", temperature: 0.1, reasoning: { enabled: true, effort: "high" } },
  "maximum-reasoning": { id: "maximum-reasoning", temperature: 0.1, reasoning: { enabled: true, effort: "xhigh" } },
  "deterministic-where-supported": { id: "deterministic-where-supported", temperature: 0, seed: 42, reasoning: { enabled: false } },
  "fiction-controlled": { id: "fiction-controlled", temperature: 0.7, topP: 0.95, reasoning: { enabled: false } },
};
