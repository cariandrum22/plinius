/**
 * Backend capability model.
 *
 * Capabilities are recorded as facts only: `supported`, `unsupported`, or
 * `unknown`. A backend must never guess — anything it cannot actually confirm
 * is `unknown`. This preserves Plinius's fact/inference separation.
 */
export const CAPABILITIES = [
  "chat",
  "completion",
  "reasoning",
  "jsonMode",
  "structuredOutput",
  "vision",
  "audio",
  "toolCalling",
  "seed",
  "temperature",
  "topP",
  "topK",
  "minP",
  "logprobs",
  "streaming",
  "batch",
  "multimodal",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export interface BackendCapabilities {
  /** Capability -> support. Every capability key is present. */
  capabilities: Record<Capability, CapabilitySupport>;
  maxContextLength: number | null;
  maxOutputLength: number | null;
}

/** A capability map with every capability set to `unknown`. */
export function unknownCapabilities(): Record<Capability, CapabilitySupport> {
  const out = {} as Record<Capability, CapabilitySupport>;
  for (const cap of CAPABILITIES) out[cap] = "unknown";
  return out;
}

/** Build a BackendCapabilities with all-unknown defaults, then apply overrides. */
export function buildCapabilities(
  overrides: Partial<Record<Capability, CapabilitySupport>> = {},
  limits: { maxContextLength?: number | null; maxOutputLength?: number | null } = {},
): BackendCapabilities {
  const capabilities = unknownCapabilities();
  for (const [cap, support] of Object.entries(overrides)) {
    capabilities[cap as Capability] = support as CapabilitySupport;
  }
  return {
    capabilities,
    maxContextLength: limits.maxContextLength ?? null,
    maxOutputLength: limits.maxOutputLength ?? null,
  };
}

/**
 * Map an OpenAI-style `supported_parameters` list to capability support.
 * Parameters present => supported; the rest stay `unknown` (NOT unsupported),
 * because absence from the list is not proof of non-support.
 */
export function capabilitiesFromSupportedParameters(params: string[]): Partial<Record<Capability, CapabilitySupport>> {
  const has = (p: string) => params.includes(p);
  const overrides: Partial<Record<Capability, CapabilitySupport>> = {};
  if (has("temperature")) overrides.temperature = "supported";
  if (has("top_p")) overrides.topP = "supported";
  if (has("top_k")) overrides.topK = "supported";
  if (has("min_p")) overrides.minP = "supported";
  if (has("seed")) overrides.seed = "supported";
  if (has("logprobs") || has("top_logprobs")) overrides.logprobs = "supported";
  if (has("reasoning") || has("include_reasoning")) overrides.reasoning = "supported";
  if (has("tools") || has("tool_choice")) overrides.toolCalling = "supported";
  if (has("response_format")) {
    overrides.jsonMode = "supported";
    overrides.structuredOutput = "supported";
  }
  return overrides;
}
