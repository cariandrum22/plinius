/**
 * Generation provenance client + normalizer.
 *
 * Reads the OpenRouter Generation API (`GET /generation?id=<id>`) and normalizes
 * whatever it returns. Fields the API omits stay `null`. A resolution context
 * supplies the requested/canonical slug (those are not part of the generation
 * response).
 */
import { FetchFn } from "../catalog/client.js";
import {
  GENERATION_PROVENANCE_SCHEMA_VERSION,
  GenerationProvenance,
  classifyProvenance,
  ProvenanceStatus,
} from "./schema.js";

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface ResolutionContext {
  requestedSlug?: string | null;
  canonicalSlug?: string | null;
}

/** Normalize a raw generation record (the `data` object) into provenance. */
export function normalizeGeneration(
  raw: Record<string, unknown> | null | undefined,
  ctx: ResolutionContext = {},
): GenerationProvenance {
  const data = raw ?? {};
  const createdAtRaw = data.created_at ?? data.created;
  return {
    schemaVersion: GENERATION_PROVENANCE_SCHEMA_VERSION,
    provider: str(data.provider_name) ?? str(data.provider),
    endpoint: str(data.endpoint) ?? str(data.endpoint_name),
    generationId: str(data.id),
    model: str(data.model),
    canonicalSlug: ctx.canonicalSlug ?? null,
    requestedSlug: ctx.requestedSlug ?? null,
    pricing: {
      totalCostUsd: num(data.total_cost),
      promptCostUsd: num(data.prompt_cost ?? data.usage_prompt),
      completionCostUsd: num(data.completion_cost ?? data.usage_completion),
    },
    latencyMs: num(data.latency) ?? num(data.generation_time),
    createdAt: typeof createdAtRaw === "string" ? createdAtRaw : null,
    region: str(data.region),
    contextLength: num(data.context_length),
    quantization: str(data.quantization),
    providerMetadata: str(data.provider_name) || str(data.provider) ? { ...data } : null,
  };
}

export function generationProvenanceStatus(p: GenerationProvenance): ProvenanceStatus {
  return classifyProvenance(p);
}

export interface GenerationClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: FetchFn;
}

/** Minimal client for the Generation API. Fetch is injectable for tests. */
export class GenerationClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: FetchFn;

  constructor(options: GenerationClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** Fetch and normalize provenance for a generation id. Never guesses. */
  async getProvenance(generationId: string, ctx: ResolutionContext = {}): Promise<GenerationProvenance> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchFn(`${this.baseUrl}/generation?id=${encodeURIComponent(generationId)}`, { headers });
    if (!res.ok) {
      throw new Error(`generation lookup failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { data?: Record<string, unknown> };
    return normalizeGeneration(json.data, ctx);
  }
}
