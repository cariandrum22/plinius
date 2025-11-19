import { readFile } from "fs/promises";
import { join } from "path";
import {
  Benchmark,
  BenchmarkId,
  BENCHMARKS_METADATA,
} from "../types/benchmark.js";

/**
 * Get the path to the benchmark prompt directory
 */
export function getBenchmarkPromptDir(): string {
  return join(process.cwd(), "benchmark", "prompt");
}

/**
 * Load a single benchmark by ID
 */
export async function loadBenchmark(id: BenchmarkId): Promise<Benchmark> {
  const metadata = BENCHMARKS_METADATA[id];
  const promptPath = join(getBenchmarkPromptDir(), `${id}.md`);

  try {
    const content = await readFile(promptPath, "utf-8");

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
  const ids = Object.keys(BENCHMARKS_METADATA) as BenchmarkId[];
  return Promise.all(ids.map((id) => loadBenchmark(id)));
}

/**
 * Load benchmarks by category
 */
export async function loadBenchmarksByCategory(
  category: string
): Promise<Benchmark[]> {
  const ids = (Object.keys(BENCHMARKS_METADATA) as BenchmarkId[]).filter(
    (id) => BENCHMARKS_METADATA[id].category === category
  );
  return Promise.all(ids.map((id) => loadBenchmark(id)));
}

/**
 * Get benchmark title from content (first H1 heading)
 */
export function extractTitleFromContent(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}
