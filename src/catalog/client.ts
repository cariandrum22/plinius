/**
 * OpenRouter Models API client.
 *
 * The fetch implementation is injectable so the normal test suite never touches
 * the network. An API key is optional for the public models endpoints and is
 * NEVER required to parse an existing snapshot (see snapshot.ts).
 */
import { z } from "zod";
import {
  RawEndpointsResponseSchema,
  RawModel,
  RawModelsResponseSchema,
} from "./schema.js";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenRouterCatalogClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: FetchFn;
}

export class OpenRouterCatalogClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: FetchFn;

  constructor(options: OpenRouterCatalogClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`OpenRouter catalog request failed: ${res.status} ${res.statusText} (${path})`);
    }
    return res.json();
  }

  /** GET /models — the full model catalog. */
  async getModels(): Promise<RawModel[]> {
    const parsed = RawModelsResponseSchema.parse(await this.getJson("/models"));
    return parsed.data;
  }

  /** GET /model/{author}/{slug} — a single model's metadata. */
  async getModel(author: string, slug: string): Promise<RawModel> {
    const json = (await this.getJson(`/model/${author}/${slug}`)) as { data?: unknown };
    // The single-model endpoint wraps the model in { data }.
    return RawModelsResponseSchema.shape.data.element.parse(json.data ?? json);
  }

  /** GET /models/{author}/{slug}/endpoints — provider endpoints for a model. */
  async getEndpoints(
    author: string,
    slug: string,
  ): Promise<z.infer<typeof RawEndpointsResponseSchema>> {
    return RawEndpointsResponseSchema.parse(await this.getJson(`/models/${author}/${slug}/endpoints`));
  }
}
