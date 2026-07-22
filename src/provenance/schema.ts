/**
 * Generation provenance schema (OpenRouter Generation API).
 *
 * Every field OpenRouter can return is captured; anything not returned is stored
 * as `null`. Values are never guessed or back-filled.
 */
export const GENERATION_PROVENANCE_SCHEMA_VERSION = 1;

export interface GenerationPricing {
  totalCostUsd: number | null;
  promptCostUsd: number | null;
  completionCostUsd: number | null;
}

export interface GenerationProvenance {
  schemaVersion: number;
  provider: string | null;
  endpoint: string | null;
  generationId: string | null;
  model: string | null;
  canonicalSlug: string | null;
  requestedSlug: string | null;
  pricing: GenerationPricing;
  latencyMs: number | null;
  createdAt: string | null;
  region: string | null;
  contextLength: number | null;
  quantization: string | null;
  /** Any additional provider metadata OpenRouter exposed, kept opaque. */
  providerMetadata: Record<string, unknown> | null;
}

/**
 * Provenance completeness classification:
 *   - complete: a generation id AND a provider are present.
 *   - partial:  only one of them is present.
 *   - missing:  neither is present.
 */
export type ProvenanceStatus = "complete" | "partial" | "missing";

export function classifyProvenance(p: GenerationProvenance): ProvenanceStatus {
  const hasId = p.generationId !== null && p.generationId !== "";
  const hasProvider = p.provider !== null && p.provider !== "";
  if (hasId && hasProvider) return "complete";
  if (hasId || hasProvider) return "partial";
  return "missing";
}

export function emptyGenerationProvenance(): GenerationProvenance {
  return {
    schemaVersion: GENERATION_PROVENANCE_SCHEMA_VERSION,
    provider: null,
    endpoint: null,
    generationId: null,
    model: null,
    canonicalSlug: null,
    requestedSlug: null,
    pricing: { totalCostUsd: null, promptCostUsd: null, completionCostUsd: null },
    latencyMs: null,
    createdAt: null,
    region: null,
    contextLength: null,
    quantization: null,
    providerMetadata: null,
  };
}
