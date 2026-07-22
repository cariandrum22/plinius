/**
 * OpenRouter catalog schemas.
 *
 * Two layers are kept apart:
 *   - the RAW API response (stored verbatim, tolerated loosely), and
 *   - a NORMALIZED, independently-versioned catalog snapshot used internally.
 *
 * Parsing an existing normalized snapshot never requires an API key.
 */
import { z } from "zod";

/** Independent schema version for the normalized catalog. */
export const CATALOG_SCHEMA_VERSION = 1;

// --- Normalized model ---------------------------------------------------------

export interface ModelPricing {
  /** USD per prompt token (as reported; OpenRouter uses per-token strings). */
  prompt: number | null;
  completion: number | null;
  request: number | null;
  cacheRead: number | null;
  maxCompletionTokens: number | null;
}

export interface ProviderEndpoint {
  providerName: string;
  contextLength: number | null;
  pricing: ModelPricing;
  quantization: string | null;
  supportedParameters: string[];
  uptime: number | null;
  throughput: number | null;
  /** Zero-data-retention endpoint availability, when exposed. */
  zdr: boolean | null;
}

export interface NormalizedModel {
  id: string;
  canonicalSlug: string;
  author: string;
  name: string;
  description: string;
  created: number | null;
  expirationDate: string | null;
  knowledgeCutoff: string | null;
  contextLength: number | null;
  inputModalities: string[];
  outputModalities: string[];
  tokenizer: string | null;
  instructType: string | null;
  supportedParameters: string[];
  defaultParameters: Record<string, unknown> | null;
  pricing: ModelPricing;
  moderated: boolean | null;
  /** Zero-data-retention availability across any endpoint. */
  zdrAvailable: boolean | null;
  providers: ProviderEndpoint[];
  /** Any benchmark/intelligence metadata OpenRouter exposes (kept opaque). */
  benchmarkMetadata: Record<string, unknown> | null;
}

export interface CatalogSnapshot {
  schemaVersion: number;
  snapshotId: string;
  backend: string;
  fetchedAt: string;
  source: "live" | "fixture" | "cache";
  modelCount: number;
  models: NormalizedModel[];
}

// --- Raw API (loose) ----------------------------------------------------------

/** Loose schema: OpenRouter fields vary; unknown keys are preserved as raw. */
export const RawModelSchema = z
  .object({
    id: z.string(),
    canonical_slug: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    created: z.number().optional(),
    expiration_date: z.string().nullish(),
    knowledge_cutoff: z.string().nullish(),
    context_length: z.number().nullish(),
    architecture: z
      .object({
        input_modalities: z.array(z.string()).optional(),
        output_modalities: z.array(z.string()).optional(),
        tokenizer: z.string().nullish(),
        instruct_type: z.string().nullish(),
        modality: z.string().nullish(),
      })
      .loose()
      .optional(),
    pricing: z
      .object({
        prompt: z.union([z.string(), z.number()]).nullish(),
        completion: z.union([z.string(), z.number()]).nullish(),
        request: z.union([z.string(), z.number()]).nullish(),
        input_cache_read: z.union([z.string(), z.number()]).nullish(),
      })
      .loose()
      .optional(),
    top_provider: z
      .object({
        context_length: z.number().nullish(),
        max_completion_tokens: z.number().nullish(),
        is_moderated: z.boolean().nullish(),
      })
      .loose()
      .optional(),
    supported_parameters: z.array(z.string()).optional(),
    default_parameters: z.record(z.string(), z.unknown()).nullish(),
    benchmarks: z.record(z.string(), z.unknown()).nullish(),
  })
  .loose();
export type RawModel = z.infer<typeof RawModelSchema>;

export const RawModelsResponseSchema = z.object({
  data: z.array(RawModelSchema),
});

/** Raw endpoints response (loose). */
export const RawEndpointsResponseSchema = z.object({
  data: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      endpoints: z
        .array(
          z
            .object({
              name: z.string().optional(),
              provider_name: z.string().optional(),
              context_length: z.number().nullish(),
              quantization: z.string().nullish(),
              supported_parameters: z.array(z.string()).optional(),
              uptime_last_30m: z.number().nullish(),
              pricing: z
                .object({
                  prompt: z.union([z.string(), z.number()]).nullish(),
                  completion: z.union([z.string(), z.number()]).nullish(),
                })
                .loose()
                .optional(),
              max_completion_tokens: z.number().nullish(),
            })
            .loose(),
        )
        .optional(),
    })
    .loose(),
});

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : null;
}

function authorOf(id: string): string {
  return id.includes("/") ? id.split("/")[0] : "";
}

function normalizePricing(pricing: RawModel["pricing"], top: RawModel["top_provider"]): ModelPricing {
  return {
    prompt: num(pricing?.prompt),
    completion: num(pricing?.completion),
    request: num(pricing?.request),
    cacheRead: num(pricing?.input_cache_read),
    maxCompletionTokens: num(top?.max_completion_tokens),
  };
}

/** Normalize one raw model (endpoints optional) into the internal shape. */
export function normalizeModel(
  raw: RawModel,
  endpoints?: z.infer<typeof RawEndpointsResponseSchema>,
): NormalizedModel {
  const providers: ProviderEndpoint[] = (endpoints?.data.endpoints ?? []).map((e) => ({
    providerName: e.provider_name ?? e.name ?? "unknown",
    contextLength: num(e.context_length),
    pricing: {
      prompt: num(e.pricing?.prompt),
      completion: num(e.pricing?.completion),
      request: null,
      cacheRead: null,
      maxCompletionTokens: num(e.max_completion_tokens),
    },
    quantization: e.quantization ?? null,
    supportedParameters: e.supported_parameters ?? [],
    uptime: num(e.uptime_last_30m),
    throughput: null,
    zdr: null,
  }));

  return {
    id: raw.id,
    canonicalSlug: raw.canonical_slug ?? raw.id,
    author: authorOf(raw.id),
    name: raw.name ?? raw.id,
    description: raw.description ?? "",
    created: raw.created ?? null,
    expirationDate: raw.expiration_date ?? null,
    knowledgeCutoff: raw.knowledge_cutoff ?? null,
    contextLength: num(raw.context_length) ?? num(raw.top_provider?.context_length),
    inputModalities: raw.architecture?.input_modalities ?? [],
    outputModalities: raw.architecture?.output_modalities ?? [],
    tokenizer: raw.architecture?.tokenizer ?? null,
    instructType: raw.architecture?.instruct_type ?? null,
    supportedParameters: raw.supported_parameters ?? [],
    defaultParameters: (raw.default_parameters as Record<string, unknown> | null) ?? null,
    pricing: normalizePricing(raw.pricing, raw.top_provider),
    moderated: raw.top_provider?.is_moderated ?? null,
    zdrAvailable: null,
    providers,
    benchmarkMetadata: (raw.benchmarks as Record<string, unknown> | null) ?? null,
  };
}
