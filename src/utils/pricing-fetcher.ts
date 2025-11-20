/**
 * Dynamic pricing fetcher from OpenRouter API
 */

import { OpenRouterModel } from "../types/openrouter.js";

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  pricing: {
    prompt: string; // Price per token as string (e.g., "0.0000025")
    completion: string;
    request?: string;
    image?: string;
  };
  context_length: number;
  top_provider?: {
    max_completion_tokens?: number;
  };
}

export interface ModelPricingData {
  promptPricePerMillion: number;
  completionPricePerMillion: number;
}

// Cache for fetched pricing
let pricingCache: Map<string, ModelPricingData> | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetch model pricing from OpenRouter API
 */
export async function fetchOpenRouterPricing(): Promise<
  Map<string, ModelPricingData>
> {
  // Return cache if valid
  if (pricingCache && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return pricingCache;
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as { data: OpenRouterModelInfo[] };
    const pricingMap = new Map<string, ModelPricingData>();

    for (const model of data.data) {
      // Convert per-token price to per-million price
      const promptPrice = parseFloat(model.pricing.prompt) * 1_000_000;
      const completionPrice = parseFloat(model.pricing.completion) * 1_000_000;

      pricingMap.set(model.id, {
        promptPricePerMillion: promptPrice,
        completionPricePerMillion: completionPrice,
      });
    }

    // Update cache
    pricingCache = pricingMap;
    cacheTimestamp = Date.now();

    console.log(
      `✓ Fetched pricing for ${pricingMap.size} models from OpenRouter`,
    );
    return pricingMap;
  } catch (error) {
    console.warn(
      `⚠ Failed to fetch pricing from OpenRouter: ${error instanceof Error ? error.message : error}`,
    );
    console.warn(`  Using cached/fallback pricing data`);

    // Return existing cache or empty map
    return pricingCache || new Map();
  }
}

/**
 * Get pricing for a specific model (with fallback)
 */
export async function getModelPricingDynamic(
  model: OpenRouterModel,
): Promise<ModelPricingData> {
  const pricing = await fetchOpenRouterPricing();
  const modelPricing = pricing.get(model);

  if (modelPricing) {
    return modelPricing;
  }

  // Fallback pricing
  console.warn(`⚠ No pricing found for ${model}, using default`);
  return {
    promptPricePerMillion: 2.0,
    completionPricePerMillion: 6.0,
  };
}

/**
 * Calculate cost with clear distinction between actual and estimated
 */
export function calculateCostBreakdown(
  promptPricePerMillion: number,
  completionPricePerMillion: number,
  actualPromptTokens: number,
  estimatedCompletionTokens: number,
): {
  promptCost: number;
  completionCost: number;
  totalCost: number;
  isCompletionEstimated: boolean;
} {
  const promptCost = (actualPromptTokens / 1_000_000) * promptPricePerMillion;
  const completionCost =
    (estimatedCompletionTokens / 1_000_000) * completionPricePerMillion;

  return {
    promptCost,
    completionCost,
    totalCost: promptCost + completionCost,
    isCompletionEstimated: true,
  };
}

/**
 * Format cost display with estimation notes
 */
export function formatCostEstimate(
  promptCost: number,
  completionCost: number,
  promptTokens: number,
  completionTokens: number,
): string {
  const total = promptCost + completionCost;
  return [
    `Input: ${promptTokens.toLocaleString()} tokens = $${promptCost.toFixed(4)}`,
    `Output: ~${completionTokens.toLocaleString()} tokens = ~$${completionCost.toFixed(4)} (estimated)`,
    `Total: $${total.toFixed(4)} (output is estimated)`,
  ].join("\n");
}

/**
 * Clear pricing cache (for testing or forced refresh)
 */
export function clearPricingCache(): void {
  pricingCache = null;
  cacheTimestamp = 0;
}
