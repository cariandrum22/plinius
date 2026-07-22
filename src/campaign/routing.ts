/**
 * Provider-routing control and provenance.
 *
 * Reproducibility mode pins one provider endpoint and rejects fallback unless
 * explicitly enabled; availability mode allows fallback but records the actual
 * provider used. The two must not be mixed in analysis. When the actual provider
 * cannot be determined, provenance is marked incomplete — never assumed.
 */
import { RoutingConfig } from "./cohort.js";

export interface ProviderRoutingProvenance {
  mode: "reproducibility" | "availability";
  requestedProvider: string | null;
  actualProvider: string | null;
  quantization: string | null;
  fallbackOccurred: boolean;
  fallbackEvents: Array<{ from: string | null; to: string | null; reason: string }>;
  routingPreferences: Record<string, unknown>;
  /** False when the actual provider/quantization could not be determined. */
  provenanceComplete: boolean;
  warnings: string[];
}

/** Build the OpenRouter `provider` routing fragment for a request. */
export function buildProviderRequest(routing: RoutingConfig): Record<string, unknown> {
  const provider: Record<string, unknown> = {};
  if (routing.mode === "reproducibility") {
    if (routing.provider) provider.order = [routing.provider];
    provider.allow_fallbacks = routing.allowFallback === true;
  } else {
    provider.allow_fallbacks = true;
  }
  return Object.keys(provider).length > 0 ? { provider } : {};
}

export interface RoutingResponseMeta {
  actualProvider?: string;
  quantization?: string;
  /** Providers OpenRouter attempted, in order, when exposed. */
  attemptedProviders?: string[];
}

/** Record provider provenance from a response, detecting fallback. */
export function recordRouting(
  routing: RoutingConfig,
  response: RoutingResponseMeta = {},
): ProviderRoutingProvenance {
  const requestedProvider = routing.provider ?? null;
  const actualProvider = response.actualProvider ?? null;
  const warnings: string[] = [];
  const fallbackEvents: ProviderRoutingProvenance["fallbackEvents"] = [];

  const provenanceComplete = actualProvider !== null;
  if (!provenanceComplete) warnings.push("actual provider could not be determined; provenance incomplete");

  let fallbackOccurred = false;
  if (requestedProvider && actualProvider && requestedProvider !== actualProvider) {
    fallbackOccurred = true;
    fallbackEvents.push({ from: requestedProvider, to: actualProvider, reason: "provider substitution" });
    if (routing.mode === "reproducibility" && routing.allowFallback !== true) {
      warnings.push(
        `reproducibility violated: routed to "${actualProvider}" instead of pinned "${requestedProvider}"`,
      );
    }
  }

  return {
    mode: routing.mode,
    requestedProvider,
    actualProvider,
    quantization: response.quantization ?? null,
    fallbackOccurred,
    fallbackEvents,
    routingPreferences: buildProviderRequest(routing),
    provenanceComplete,
    warnings,
  };
}
