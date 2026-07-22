/**
 * Data-retention (ZDR) enforcement.
 *
 * A campaign may require zero-data-retention endpoints. For benchmarks that
 * contain proprietary/confidential material, non-ZDR targets are rejected unless
 * an explicit override is present. The initial prototype suite has no
 * confidential data.
 */
import { NormalizedModel } from "../catalog/schema.js";

export interface ZdrDecision {
  allowed: boolean;
  reason: string;
}

export function enforceZdr(
  model: NormalizedModel | undefined,
  requireZdr: boolean,
  override = false,
): ZdrDecision {
  if (!requireZdr) return { allowed: true, reason: "ZDR not required" };
  const zdr = model?.zdrAvailable === true || model?.providers.some((p) => p.zdr === true);
  if (zdr) return { allowed: true, reason: "ZDR endpoint available" };
  if (override) return { allowed: true, reason: "ZDR requirement overridden explicitly" };
  return { allowed: false, reason: "ZDR required but no zero-data-retention endpoint available" };
}
