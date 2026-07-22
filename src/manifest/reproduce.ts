/**
 * Reproducibility comparison.
 *
 * Compares a saved manifest against the current state (environment, catalog
 * snapshot id, prompt snapshot id, per-target lifecycle / provider / canonical
 * slug) and classifies the result. Catalog or prompt mismatch, a critical schema
 * version change, or a now-RETIRED model breaks reproducibility.
 */
import {
  CRITICAL_ENV_FIELDS,
  EnvironmentDiff,
  EvaluationEnvironment,
  diffEnvironment,
} from "../environment/environment.js";
import { ModelLifecycle } from "../campaign/lifecycle.js";
import { EvaluationManifest } from "./manifest.js";

export type Reproducibility = "REPRODUCIBLE" | "PARTIALLY_REPRODUCIBLE" | "NOT_REPRODUCIBLE";

export interface CurrentState {
  environment?: EvaluationEnvironment;
  catalogSnapshotId?: string;
  promptSnapshotId?: string;
  /** Current execution backend. */
  backend?: string;
  /** Current lifecycle per targetId. */
  lifecycle?: Record<string, ModelLifecycle>;
  /** Current provider per targetId. */
  providers?: Record<string, string | null>;
  /** Current canonical slug per requested slug. */
  canonicalSlugs?: Record<string, string | null>;
}

export interface ReproducibilityResult {
  verdict: Reproducibility;
  catalogMatch: boolean | null;
  promptMatch: boolean | null;
  backendMatch: boolean | null;
  environmentDiffs: EnvironmentDiff[];
  criticalEnvDiff: boolean;
  lifecycleDiffs: Array<{ targetId: string; from: ModelLifecycle; to: ModelLifecycle }>;
  aliasDiffs: Array<{ targetId: string; requested: string; was: string | null; now: string | null }>;
  providerDiffs: Array<{ targetId: string; was: string | null; now: string | null }>;
  reasons: string[];
}

export function compareManifest(manifest: EvaluationManifest, current: CurrentState): ReproducibilityResult {
  const reasons: string[] = [];

  const catalogMatch = current.catalogSnapshotId === undefined ? null : current.catalogSnapshotId === manifest.catalogSnapshotId;
  const promptMatch = current.promptSnapshotId === undefined ? null : current.promptSnapshotId === manifest.promptSnapshotId;
  const backendMatch =
    current.backend === undefined || !manifest.backend ? null : current.backend === manifest.backend;
  if (catalogMatch === false) reasons.push("catalog snapshot changed");
  if (promptMatch === false) reasons.push("prompt snapshot changed");
  if (backendMatch === false) reasons.push(`execution backend changed (${manifest.backend} → ${current.backend})`);

  const environmentDiffs = current.environment
    ? diffEnvironment(manifest.environment, current.environment)
    : [];
  const criticalEnvDiff = environmentDiffs.some((d) => CRITICAL_ENV_FIELDS.includes(d.field as never));
  if (criticalEnvDiff) reasons.push("critical environment/schema version changed");

  const lifecycleDiffs: ReproducibilityResult["lifecycleDiffs"] = [];
  const aliasDiffs: ReproducibilityResult["aliasDiffs"] = [];
  const providerDiffs: ReproducibilityResult["providerDiffs"] = [];

  for (const target of manifest.targetModels) {
    const nowLifecycle = current.lifecycle?.[target.targetId];
    if (nowLifecycle && nowLifecycle !== target.lifecycle) {
      lifecycleDiffs.push({ targetId: target.targetId, from: target.lifecycle, to: nowLifecycle });
      if (nowLifecycle === "RETIRED") reasons.push(`target ${target.targetId} is now RETIRED`);
    }
    if (target.requestedSlug && current.canonicalSlugs) {
      const now = current.canonicalSlugs[target.requestedSlug];
      if (now !== undefined && now !== target.canonicalSlug) {
        aliasDiffs.push({ targetId: target.targetId, requested: target.requestedSlug, was: target.canonicalSlug, now });
      }
    }
    if (current.providers) {
      const prov = manifest.generationProvenance.find((p) => p.canonicalSlug === target.canonicalSlug || p.requestedSlug === target.requestedSlug);
      const nowProvider = current.providers[target.targetId];
      if (nowProvider !== undefined && prov && prov.provider !== null && nowProvider !== prov.provider) {
        providerDiffs.push({ targetId: target.targetId, was: prov.provider, now: nowProvider });
      }
    }
  }

  const anyRetired = lifecycleDiffs.some((d) => d.to === "RETIRED");
  const identityBroken = catalogMatch === false || promptMatch === false || criticalEnvDiff || anyRetired;

  let verdict: Reproducibility;
  if (identityBroken) {
    verdict = "NOT_REPRODUCIBLE";
  } else {
    const fullyVerified =
      catalogMatch === true &&
      promptMatch === true &&
      backendMatch !== false &&
      environmentDiffs.length === 0 &&
      lifecycleDiffs.length === 0 &&
      aliasDiffs.length === 0 &&
      providerDiffs.length === 0;
    verdict = fullyVerified ? "REPRODUCIBLE" : "PARTIALLY_REPRODUCIBLE";
    if (!fullyVerified && reasons.length === 0) reasons.push("some current-state fields could not be fully verified or differ non-critically");
  }

  return {
    verdict,
    catalogMatch,
    promptMatch,
    backendMatch,
    environmentDiffs,
    criticalEnvDiff,
    lifecycleDiffs,
    aliasDiffs,
    providerDiffs,
    reasons,
  };
}
