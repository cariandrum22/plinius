/**
 * Model lifecycle status.
 *
 *   ACTIVE     — normal evaluation target.
 *   DEPRECATED — warned in new campaigns (has a future expiration, or the
 *                catalog marks it deprecated).
 *   RETIRED    — past its expiration date; new evaluation is forbidden, only
 *                historical viewing is allowed.
 *   UNKNOWN    — not determinable (e.g. model absent from the snapshot).
 *
 * Discovery only auto-proposes ACTIVE models.
 */
import { NormalizedModel } from "../catalog/schema.js";

export type ModelLifecycle = "ACTIVE" | "DEPRECATED" | "RETIRED" | "UNKNOWN";

export function classifyLifecycle(model: NormalizedModel | undefined, nowMs: number): ModelLifecycle {
  if (!model) return "UNKNOWN";
  if (model.expirationDate) {
    const exp = Date.parse(model.expirationDate);
    if (Number.isFinite(exp)) {
      return exp < nowMs ? "RETIRED" : "DEPRECATED";
    }
  }
  if (/\b(deprecated|legacy|retired)\b/i.test(model.description)) return "DEPRECATED";
  return "ACTIVE";
}

/** True when a model may be used in a NEW evaluation (ACTIVE or DEPRECATED w/ warning). */
export function isEvaluable(status: ModelLifecycle): boolean {
  return status === "ACTIVE" || status === "DEPRECATED";
}

/** True when a NEW evaluation must be blocked. */
export function isNewEvaluationForbidden(status: ModelLifecycle): boolean {
  return status === "RETIRED";
}

export function activeModels(models: NormalizedModel[], nowMs: number): NormalizedModel[] {
  return models.filter((m) => classifyLifecycle(m, nowMs) === "ACTIVE");
}
