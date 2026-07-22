/**
 * Cost schema.
 *
 * Cost is intentionally NOT a single number. Provider (monetary) cost, latency,
 * GPU-seconds, and VRAM are kept as separable dimensions so a self-hosted vLLM
 * deployment (no per-token price, but real GPU cost) and a hosted API (per-token
 * price, no VRAM visibility) can both be described honestly. Any dimension may
 * be null when it is not measurable for a given deployment.
 */
import { BackendProvenance } from "../types/provenance.js";
import { BenchmarkRunRecord } from "../types/benchmark.js";

export interface CostBreakdown {
  /** Monetary provider cost in USD, when the backend prices per token. */
  providerCostUsd: number | null;
  /** Mean end-to-end latency (ms). */
  latencyMsMean: number | null;
  /** GPU-seconds consumed, when derivable from provenance/telemetry. */
  gpuSeconds: number | null;
  /** Peak VRAM footprint (GiB), when known. */
  vramGb: number | null;
  /** Output tokens per second, when usage + latency are available. */
  tokensPerSecond: number | null;
}

export function emptyCost(): CostBreakdown {
  return {
    providerCostUsd: null,
    latencyMsMean: null,
    gpuSeconds: null,
    vramGb: null,
    tokensPerSecond: null,
  };
}

/**
 * Derive a cost breakdown from a set of records for one target. GPU-seconds and
 * VRAM are only populated when provenance exposes them; otherwise they stay null
 * (never guessed).
 */
export function deriveCost(records: BenchmarkRunRecord[]): CostBreakdown {
  const cost = emptyCost();
  const latencies: number[] = [];
  const throughputs: number[] = [];

  for (const record of records) {
    const latency = record.response?.latencyMs;
    if (typeof latency === "number") latencies.push(latency);
    const completion = record.response?.usage?.completionTokens;
    if (typeof latency === "number" && typeof completion === "number" && latency > 0) {
      throughputs.push(completion / (latency / 1000));
    }
    const gpu = gpuSecondsFromProvenance(record.provenance, latency);
    if (gpu !== null) cost.gpuSeconds = (cost.gpuSeconds ?? 0) + gpu;
  }

  if (latencies.length > 0) {
    cost.latencyMsMean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  }
  if (throughputs.length > 0) {
    cost.tokensPerSecond = throughputs.reduce((a, b) => a + b, 0) / throughputs.length;
  }
  return cost;
}

function gpuSecondsFromProvenance(
  provenance: BackendProvenance | undefined,
  latencyMs: number | undefined,
): number | null {
  if (!provenance || typeof latencyMs !== "number") return null;
  const gpuCount = provenance.gpu?.count;
  if (typeof gpuCount !== "number" || gpuCount <= 0) return null;
  // GPU-seconds ≈ gpu_count × wall-clock seconds the request occupied.
  return gpuCount * (latencyMs / 1000);
}
