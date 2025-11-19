import { readFile } from "fs/promises";
import { BenchmarkId } from "../types/benchmark.js";
import { OpenRouterModel } from "../types/openrouter.js";
import { ParsedBenchmarkResult } from "../types/evaluation.js";

/**
 * Parse a benchmark result markdown file
 */
export async function parseBenchmarkResult(
  filePath: string
): Promise<ParsedBenchmarkResult> {
  const content = await readFile(filePath, "utf-8");

  // Extract metadata from header
  const timestampMatch = content.match(/\*\*Timestamp:\*\* (.+)/);
  const modelMatch = content.match(/\*\*Model:\*\* (.+)/);
  const promptIdMatch = content.match(/\*\*Prompt ID:\*\* (.+)/);
  const latencyMatch = content.match(/\*\*Latency:\*\* (.+)/);
  const tokensMatch = content.match(/\*\*Tokens:\*\* (.+)/);

  if (!modelMatch || !promptIdMatch) {
    throw new Error(`Failed to parse metadata from ${filePath}`);
  }

  const model = modelMatch[1].trim() as OpenRouterModel;
  const benchmarkId = promptIdMatch[1].trim() as BenchmarkId;

  // Extract prompt section
  const promptMatch = content.match(/## Prompt\s+```\s+([\s\S]+?)\s+```/);
  if (!promptMatch) {
    throw new Error(`Failed to extract prompt from ${filePath}`);
  }
  const prompt = promptMatch[1].trim();

  // Extract response section
  const responseMatch = content.match(/## Response\s+([\s\S]+)$/);
  if (!responseMatch) {
    throw new Error(`Failed to extract response from ${filePath}`);
  }
  const response = responseMatch[1].trim();

  return {
    benchmarkId,
    model,
    prompt,
    response,
    metadata: {
      timestamp: timestampMatch?.[1]?.trim() || "N/A",
      latency: latencyMatch?.[1]?.trim() || "N/A",
      tokens: tokensMatch?.[1]?.trim() || "N/A",
    },
  };
}

/**
 * Extract benchmark ID and model from filename
 * Format: A1_openai_gpt-5.1_2025-11-18T04-30-46-756Z.md
 */
export function parseFilename(filename: string): {
  benchmarkId: BenchmarkId;
  model: OpenRouterModel;
} | null {
  const match = filename.match(/^([A-C][1-3])_(.+)_\d{4}-\d{2}-\d{2}T.+\.md$/);
  if (!match) {
    return null;
  }

  const benchmarkId = match[1] as BenchmarkId;
  const modelPart = match[2]; // e.g., "openai_gpt-5.1"

  // Convert sanitized model name back to original format
  const model = modelPart.replace(/_/g, "/").replace(/-/g, ":") as OpenRouterModel;

  return { benchmarkId, model };
}
