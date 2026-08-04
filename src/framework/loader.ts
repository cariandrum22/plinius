/**
 * Benchmark Framework — asset loader.
 *
 * Walks `benchmark/<category>/<id>/`, loads and validates the benchmark
 * metadata, system/user prompts, and rubric, and computes a canonical content
 * hash over the executable input (metadata + system + user + rubric). Reviewer
 * references are documentation and are loaded but excluded from the hash. Raw
 * YAML/Markdown never escapes this module.
 */
import { readFile, readdir, stat } from "fs/promises";
import { basename, join, relative } from "path";
import { parse as parseYaml } from "yaml";
import { canonicalHash } from "../suite/hash.js";
import {
  BenchmarkAsset,
  Category,
  CategorySchema,
  Rubric,
  parseBenchmarkAsset,
  parseRubric,
} from "./benchmark.js";

const METADATA_FILE = "metadata.yaml";

/** A fully loaded, validated framework benchmark. */
export interface LoadedFrameworkBenchmark {
  asset: BenchmarkAsset;
  systemPrompt: string;
  userPrompt: string;
  rubric: Rubric;
  /** references.md content, or "" when absent. Documentation only. */
  references: string;
  /** Absolute path to the benchmark directory. */
  dir: string;
  /** Content hash over metadata + system + user + rubric (no timestamp). */
  contentHash: string;
}

/** Default location of the framework benchmark tree (repo root). */
export function getBenchmarkRoot(): string {
  return join(process.cwd(), "benchmark");
}

const CATEGORY_DIRS: Category[] = CategorySchema.options;

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function readOptional(p: string): Promise<string> {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Load one benchmark from its directory. `expectedCategory`, when provided, is
 * checked against the declared category for integrity.
 */
export async function loadBenchmarkFromDir(
  dir: string,
  expectedCategory?: Category,
): Promise<LoadedFrameworkBenchmark> {
  const metadataPath = join(dir, METADATA_FILE);
  const rawYaml = await readFile(metadataPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (error) {
    throw new Error(`Invalid YAML in ${metadataPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let asset: BenchmarkAsset;
  try {
    asset = parseBenchmarkAsset(parsed);
  } catch (error) {
    throw new Error(
      `Benchmark metadata validation failed for ${metadataPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const folder = basename(dir);
  if (asset.id !== folder) {
    throw new Error(`Benchmark id "${asset.id}" does not match its folder "${folder}" (${dir})`);
  }
  if (expectedCategory && asset.category !== expectedCategory) {
    throw new Error(
      `Benchmark ${asset.id} declares category "${asset.category}" but lives under "${expectedCategory}/"`,
    );
  }

  const systemPrompt = (await readFile(join(dir, asset.systemFile), "utf-8")).trim();
  const userPrompt = (await readFile(join(dir, asset.userFile), "utf-8")).trim();

  const rubricRaw = await readFile(join(dir, asset.rubricFile), "utf-8");
  let rubric: Rubric;
  try {
    rubric = parseRubric(parseYaml(rubricRaw));
  } catch (error) {
    throw new Error(
      `Rubric validation failed for ${join(dir, asset.rubricFile)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const references = (await readOptional(join(dir, asset.referencesFile))).trim();

  const contentHash = canonicalHash({
    schemaVersion: asset.schemaVersion,
    asset,
    system: systemPrompt,
    user: userPrompt,
    rubric,
  });

  return { asset, systemPrompt, userPrompt, rubric, references, dir, contentHash };
}

/**
 * Discover and load every framework benchmark under `benchmark/<category>/`.
 * Only known category folders are scanned; a folder without a `metadata.yaml`
 * is skipped. Results are sorted by id for determinism.
 */
export async function loadAllBenchmarks(
  root: string = getBenchmarkRoot(),
): Promise<LoadedFrameworkBenchmark[]> {
  const benchmarks: LoadedFrameworkBenchmark[] = [];

  for (const category of CATEGORY_DIRS) {
    const categoryDir = join(root, category);
    if (!(await isDir(categoryDir))) continue;
    const entries = await readdir(categoryDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const benchDir = join(categoryDir, entry.name);
      if (!(await fileExists(join(benchDir, METADATA_FILE)))) continue;
      benchmarks.push(await loadBenchmarkFromDir(benchDir, category));
    }
  }

  benchmarks.sort((a, b) => a.asset.id.localeCompare(b.asset.id));
  return benchmarks;
}

/** Load a single benchmark by id, searching all categories. */
export async function loadBenchmarkById(
  id: string,
  root: string = getBenchmarkRoot(),
): Promise<LoadedFrameworkBenchmark> {
  const all = await loadAllBenchmarks(root);
  const found = all.find((b) => b.asset.id === id);
  if (!found) {
    const available = all.map((b) => b.asset.id).join(", ");
    throw new Error(`Unknown benchmark "${id}". Available: ${available || "(none)"}`);
  }
  return found;
}

/** Relative benchmark path for display. */
export function benchmarkRelativePath(dir: string): string {
  return relative(process.cwd(), dir);
}
