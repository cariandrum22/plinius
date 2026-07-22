/**
 * Dynamic model discovery and recommendation.
 *
 * Discovery rules produce PROPOSALS only — they never silently pin a model into
 * a cohort. A recommendation report retains the source metadata and a
 * transparent reason for each candidate. Popularity alone is never a quality
 * signal; it is one input among several.
 */
import { CatalogSnapshot, NormalizedModel } from "./../catalog/schema.js";
import { diffSnapshots } from "./../catalog/diff.js";
import { filterModels, intelligenceScore, popularityScore, sortModels, SortKey } from "./../catalog/filter.js";
import { classifyLifecycle } from "./lifecycle.js";

export interface DiscoveryQuery {
  sort?: SortKey;
  sortAny?: SortKey[];
  maxRank?: number;
  minContextLength?: number;
  requiredOutputModalities?: string[];
  requiredParameters?: string[];
  addedWithinDays?: number;
  author?: string;
  nameContains?: string;
}

/** Apply a discovery rule to a snapshot, returning proposed models (ranked). */
export function proposeCandidates(
  snapshot: CatalogSnapshot,
  rule: DiscoveryQuery,
  nowMs: number,
): NormalizedModel[] {
  let models = filterModels(snapshot.models, {
    minContextLength: rule.minContextLength,
    requiredParameters: rule.requiredParameters,
    author: rule.author,
    nameContains: rule.nameContains,
  });

  if (rule.requiredOutputModalities) {
    models = models.filter((m) => rule.requiredOutputModalities!.every((o) => m.outputModalities.includes(o)));
  }
  if (rule.addedWithinDays !== undefined) {
    const cutoff = nowMs - rule.addedWithinDays * 86_400_000;
    models = models.filter((m) => m.created !== null && m.created * 1000 >= cutoff);
  }

  const sortKey = rule.sort ?? rule.sortAny?.[0] ?? "newest";
  models = sortModels(models, sortKey);
  if (rule.maxRank !== undefined) models = models.slice(0, rule.maxRank);
  return models;
}

export interface Candidate {
  id: string;
  name: string;
  reason: string;
  intelligence: number | null;
  popularity: number | null;
  contextLength: number | null;
  created: number | null;
}

export interface RecommendationReport {
  generatedAt: string;
  currentSnapshotId: string;
  previousSnapshotId: string | null;
  newlyAdded: string[];
  removed: string[];
  expired: string[];
  aliasDrift: Array<{ id: string; canonicalSlug: string }>;
  pricingChanges: Array<{ id: string; from: unknown; to: unknown }>;
  contextChanges: Array<{ id: string; from: unknown; to: unknown }>;
  parameterChanges: string[];
  endpointChanges: string[];
  candidateAdditions: Candidate[];
  candidateRemovals: Candidate[];
}

function toCandidate(m: NormalizedModel, reason: string): Candidate {
  return {
    id: m.id,
    name: m.name,
    reason,
    intelligence: intelligenceScore(m),
    popularity: popularityScore(m),
    contextLength: m.contextLength,
    created: m.created,
  };
}

export interface GenerateRecommendationInput {
  current: CatalogSnapshot;
  previous?: CatalogSnapshot;
  /** Model ids currently pinned in cohorts. */
  cohortModelIds: Set<string>;
  rules: Record<string, DiscoveryQuery>;
  generatedAt: string;
  nowMs: number;
}

/** Build a human-reviewable recommendation. Never mutates any cohort. */
export function generateRecommendation(input: GenerateRecommendationInput): RecommendationReport {
  const { current, previous, cohortModelIds, rules } = input;
  const diff = previous ? diffSnapshots(previous, current) : null;

  const aliasDrift = current.models
    .filter((m) => m.canonicalSlug !== m.id)
    .map((m) => ({ id: m.id, canonicalSlug: m.canonicalSlug }));

  const pricingChanges: RecommendationReport["pricingChanges"] = [];
  const contextChanges: RecommendationReport["contextChanges"] = [];
  const parameterChanges: string[] = [];
  const endpointChanges: string[] = [];
  for (const change of diff?.changed ?? []) {
    for (const c of change.changes) {
      if (c.field.startsWith("pricing")) pricingChanges.push({ id: change.id, from: c.from, to: c.to });
      if (c.field === "contextLength") contextChanges.push({ id: change.id, from: c.from, to: c.to });
      if (c.field === "supportedParameters") parameterChanges.push(change.id);
      if (c.field === "providers") endpointChanges.push(change.id);
    }
  }

  // Candidate additions: rule matches not already in a cohort.
  const seen = new Set<string>();
  const candidateAdditions: Candidate[] = [];
  for (const [ruleName, rule] of Object.entries(rules)) {
    for (const model of proposeCandidates(current, rule, input.nowMs)) {
      if (cohortModelIds.has(model.id) || seen.has(model.id)) continue;
      // Only ACTIVE models are auto-proposed for a new campaign.
      if (classifyLifecycle(model, input.nowMs) !== "ACTIVE") continue;
      seen.add(model.id);
      candidateAdditions.push(toCandidate(model, `matched rule "${ruleName}"`));
    }
  }

  // Candidate removals: cohort models now expired or removed from the catalog.
  const currentIds = new Set(current.models.map((m) => m.id));
  const expiredIds = new Set(diff?.expired ?? []);
  const candidateRemovals: Candidate[] = [];
  for (const id of cohortModelIds) {
    const model = current.models.find((m) => m.id === id);
    if (!currentIds.has(id)) {
      candidateRemovals.push({ id, name: id, reason: "no longer present in catalog", intelligence: null, popularity: null, contextLength: null, created: null });
    } else if (expiredIds.has(id) && model) {
      candidateRemovals.push(toCandidate(model, "past its expiration date"));
    }
  }

  return {
    generatedAt: input.generatedAt,
    currentSnapshotId: current.snapshotId,
    previousSnapshotId: previous?.snapshotId ?? null,
    newlyAdded: diff?.added ?? [],
    removed: diff?.removed ?? [],
    expired: diff?.expired ?? [],
    aliasDrift,
    pricingChanges,
    contextChanges,
    parameterChanges,
    endpointChanges,
    candidateAdditions,
    candidateRemovals,
  };
}

/** The documented initial discovery rules. */
export const INITIAL_DISCOVERY_RULES: Record<string, DiscoveryQuery> = {
  frontier_candidate: {
    sortAny: ["intelligence-high-to-low"],
    maxRank: 15,
    minContextLength: 131072,
    requiredOutputModalities: ["text"],
  },
  agent_candidate: {
    requiredParameters: ["tools"],
    minContextLength: 131072,
    sort: "most-popular",
  },
  new_model_candidate: {
    addedWithinDays: 45,
    sort: "newest",
  },
};
