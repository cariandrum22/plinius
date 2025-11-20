import { readFile } from "fs/promises";
import { join } from "path";
import {
  Benchmark,
  BenchmarkId,
  createBenchmarkMetadata,
  inferCategory,
} from "../types/benchmark.js";
import { discoverBenchmarkIds, getPromptDir } from "../config.js";

/**
 * Get the path to the benchmark prompt directory
 */
export function getBenchmarkPromptDir(): string {
  return getPromptDir();
}

/**
 * Load a single benchmark by ID
 */
export async function loadBenchmark(id: BenchmarkId): Promise<Benchmark> {
  const metadata = createBenchmarkMetadata(id);
  const promptPath = join(getBenchmarkPromptDir(), `${id}.md`);

  try {
    const content = await readFile(promptPath, "utf-8");

    // Try to extract title from content
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      metadata.title = titleMatch[1].trim();
    }

    return {
      ...metadata,
      content: content.trim(),
    };
  } catch (error) {
    throw new Error(
      `Failed to load benchmark ${id}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load all benchmarks
 */
export async function loadAllBenchmarks(): Promise<Benchmark[]> {
  const ids = await discoverBenchmarkIds();
  return Promise.all(ids.map((id) => loadBenchmark(id)));
}

/**
 * Load benchmarks by category
 */
export async function loadBenchmarksByCategory(
  category: string
): Promise<Benchmark[]> {
  const ids = await discoverBenchmarkIds();
  const filteredIds = ids.filter(
    (id) => inferCategory(id) === category
  );
  return Promise.all(filteredIds.map((id) => loadBenchmark(id)));
}

/**
 * Get benchmark title from content (first H1 heading)
 */
export function extractTitleFromContent(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}
