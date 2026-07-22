/**
 * Catalog filtering and sorting.
 *
 * Sort keys mirror the OpenRouter discovery UI. Intelligence/popularity draw on
 * whatever benchmark metadata a snapshot carries; when absent, those models sort
 * last rather than being dropped.
 */
import { NormalizedModel } from "./schema.js";

export type SortKey =
  | "newest"
  | "intelligence-high-to-low"
  | "most-popular"
  | "context-high-to-low"
  | "pricing-low-to-high";

export interface FilterCriteria {
  requiredParameters?: string[];
  inputModality?: string;
  outputModality?: string;
  author?: string;
  maxPromptPrice?: number;
  minContextLength?: number;
  requireZdr?: boolean;
  nameContains?: string;
}

function metaNumber(model: NormalizedModel, keys: string[]): number | null {
  const meta = model.benchmarkMetadata;
  if (!meta) return null;
  for (const key of keys) {
    const v = meta[key];
    if (typeof v === "number") return v;
  }
  return null;
}

export function intelligenceScore(model: NormalizedModel): number | null {
  return metaNumber(model, ["intelligence", "intelligence_index", "elo", "design_arena_elo"]);
}

export function popularityScore(model: NormalizedModel): number | null {
  return metaNumber(model, ["weekly_usage", "popularity", "tokens_week"]);
}

export function filterModels(models: NormalizedModel[], c: FilterCriteria): NormalizedModel[] {
  return models.filter((m) => {
    if (c.requiredParameters && !c.requiredParameters.every((p) => m.supportedParameters.includes(p))) {
      return false;
    }
    if (c.inputModality && !m.inputModalities.includes(c.inputModality)) return false;
    if (c.outputModality && !m.outputModalities.includes(c.outputModality)) return false;
    if (c.author && m.author !== c.author) return false;
    if (c.maxPromptPrice !== undefined && (m.pricing.prompt ?? Infinity) > c.maxPromptPrice) return false;
    if (c.minContextLength !== undefined && (m.contextLength ?? 0) < c.minContextLength) return false;
    if (c.requireZdr && m.zdrAvailable !== true) return false;
    if (c.nameContains && !m.name.toLowerCase().includes(c.nameContains.toLowerCase())) return false;
    return true;
  });
}

/** Stable sort by the given key. Nulls always sort last. */
export function sortModels(models: NormalizedModel[], key: SortKey): NormalizedModel[] {
  const out = models.slice();
  const desc = (a: number | null, b: number | null) => (b ?? -Infinity) - (a ?? -Infinity);
  const asc = (a: number | null, b: number | null) => (a ?? Infinity) - (b ?? Infinity);
  switch (key) {
    case "newest":
      return out.sort((a, b) => desc(a.created, b.created));
    case "intelligence-high-to-low":
      return out.sort((a, b) => desc(intelligenceScore(a), intelligenceScore(b)));
    case "most-popular":
      return out.sort((a, b) => desc(popularityScore(a), popularityScore(b)));
    case "context-high-to-low":
      return out.sort((a, b) => desc(a.contextLength, b.contextLength));
    case "pricing-low-to-high":
      return out.sort((a, b) => asc(a.pricing.prompt, b.pricing.prompt));
  }
}
