/**
 * Supported-parameter validation.
 *
 * Before a request is sent, the profile's parameters are validated against the
 * target model's `supported_parameters`. An unsupported parameter is NEVER
 * silently treated as applied. The configured policy decides the outcome, and
 * the full decision is persisted with the run.
 */
import { InferenceProfile } from "./profiles.js";

export type UnsupportedParameterPolicy = "reject" | "omit" | "mark_not_comparable";

/** Map a Plinius profile field to its OpenRouter parameter name. */
const PARAM_MAP: Array<{ field: keyof InferenceProfile; orName: string }> = [
  { field: "temperature", orName: "temperature" },
  { field: "topP", orName: "top_p" },
  { field: "topK", orName: "top_k" },
  { field: "seed", orName: "seed" },
  { field: "maxTokens", orName: "max_tokens" },
  { field: "reasoning", orName: "reasoning" },
];

export interface ParameterValidation {
  policy: UnsupportedParameterPolicy;
  /** Parameters supported by the model and kept. */
  applied: string[];
  /** Requested but unsupported. */
  unsupported: string[];
  /** Unsupported parameters that were dropped (policy === "omit"). */
  omitted: string[];
  /** The target/profile combination is rejected outright. */
  rejected: boolean;
  /** The run is retained but flagged not comparable. */
  notComparable: boolean;
  warnings: string[];
}

export function validateProfileParameters(
  profile: InferenceProfile,
  supportedParameters: string[],
  policy: UnsupportedParameterPolicy,
): ParameterValidation {
  const supported = new Set(supportedParameters);
  const applied: string[] = [];
  const unsupported: string[] = [];

  for (const { field, orName } of PARAM_MAP) {
    if (profile[field] === undefined) continue;
    // A model with no advertised parameters is treated as "unknown" and we do
    // not fabricate support: absence => unsupported under strict policies.
    if (supported.has(orName)) applied.push(orName);
    else unsupported.push(orName);
  }

  const warnings: string[] = [];
  let rejected = false;
  let notComparable = false;
  const omitted: string[] = [];

  if (unsupported.length > 0) {
    switch (policy) {
      case "reject":
        rejected = true;
        warnings.push(`rejected: model does not support ${unsupported.join(", ")}`);
        break;
      case "omit":
        omitted.push(...unsupported);
        warnings.push(`omitted unsupported parameters: ${unsupported.join(", ")}`);
        break;
      case "mark_not_comparable":
        notComparable = true;
        warnings.push(`marked not comparable due to unsupported: ${unsupported.join(", ")}`);
        break;
    }
  }

  return { policy, applied, unsupported, omitted, rejected, notComparable, warnings };
}
