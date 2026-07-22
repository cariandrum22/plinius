/**
 * Alias resolution.
 *
 * A requested model may be a canonical slug/id (`moonshotai/kimi-k3`) or a
 * mutable alias (`~anthropic/claude-sonnet-latest`, or any id whose
 * canonical_slug differs). Resolution pins the alias to the current canonical
 * slug and records enough metadata that a completed run stays understandable
 * even after the alias later points at a newer model.
 */
import { CatalogSnapshot } from "./schema.js";
import { findModel } from "./snapshot.js";

export interface ResolvedModel {
  /** The exact string the cohort requested (alias or canonical). */
  requestedModel: string;
  /** Whether the request used the `~alias` convention. */
  isAlias: boolean;
  /** Resolved canonical slug, when found. */
  resolvedSlug: string | null;
  /** The model id actually matched in the snapshot. */
  matchedId: string | null;
  snapshotId: string;
  resolvedAt: string;
  created: number | null;
  found: boolean;
  /**
   * True when the requested identifier differs from the resolved canonical slug
   * (i.e. the alias moved). Recorded as an evaluation warning, not an error.
   */
  aliasMismatch: boolean;
  warnings: string[];
}

/** Resolve one requested model against a snapshot. */
export function resolveModel(
  requestedModel: string,
  snapshot: CatalogSnapshot,
  resolvedAt: string,
): ResolvedModel {
  const isAlias = requestedModel.startsWith("~") || /(?:^|\/)[^/]*latest/i.test(requestedModel);
  const lookup = requestedModel.replace(/^~/, "");
  const model = findModel(snapshot, lookup);

  const warnings: string[] = [];
  if (!model) {
    warnings.push(`model "${lookup}" not found in snapshot ${snapshot.snapshotId}`);
    return {
      requestedModel,
      isAlias,
      resolvedSlug: null,
      matchedId: null,
      snapshotId: snapshot.snapshotId,
      resolvedAt,
      created: null,
      found: false,
      aliasMismatch: false,
      warnings,
    };
  }

  const resolvedSlug = model.canonicalSlug;
  const aliasMismatch = resolvedSlug !== lookup;
  if (aliasMismatch) {
    warnings.push(
      `requested "${lookup}" resolved to canonical "${resolvedSlug}" (alias moved or slug differs)`,
    );
  }

  return {
    requestedModel,
    isAlias,
    resolvedSlug,
    matchedId: model.id,
    snapshotId: snapshot.snapshotId,
    resolvedAt,
    created: model.created,
    found: true,
    aliasMismatch,
    warnings,
  };
}

/**
 * Compare the model a provider actually returned against the resolved slug, so a
 * silent server-side substitution surfaces as a warning.
 */
export function reconcileReturnedModel(
  resolved: ResolvedModel,
  actualModelReturned: string | undefined,
): string[] {
  if (!actualModelReturned || !resolved.resolvedSlug) return [];
  const a = actualModelReturned.replace(/^~/, "");
  if (a !== resolved.resolvedSlug && a !== resolved.matchedId) {
    return [`response model "${actualModelReturned}" != resolved "${resolved.resolvedSlug}"`];
  }
  return [];
}
