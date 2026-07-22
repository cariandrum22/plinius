/**
 * Benchmark suite loader.
 *
 * Walks `benchmark/suites/<domain>/<id>/`, parses each `benchmark.yaml` as
 * YAML, validates + normalizes it through the Zod schema, then resolves the
 * task text and referenced files. Only normalized domain objects are returned;
 * raw YAML never escapes this module.
 *
 * The canonical content hash covers the *entire* reproducible input — the
 * validated definition (including rubric and checks), the task text, and the
 * bytes of every fixture and reference file — not just the task prose.
 */
import { readdir, readFile, stat } from "fs/promises";
import { basename, join, relative } from "path";
import { parse as parseYaml } from "yaml";
import {
  BenchmarkDefinition,
  Domain,
  parseBenchmarkDefinition,
} from "./schema.js";
import { bytesHash, canonicalHash } from "./hash.js";

/** A file referenced by a benchmark (fixture or reference answer). */
export interface BenchmarkFile {
  /** Path relative to the benchmark directory. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  sha256: string;
  size: number;
}

/** A fully loaded, validated benchmark ready to run and evaluate. */
export interface LoadedBenchmark {
  definition: BenchmarkDefinition;
  /** Absolute path to the benchmark directory. */
  dir: string;
  /** Task prose (contents of `taskFile`). */
  taskText: string;
  fixtures: BenchmarkFile[];
  references: BenchmarkFile[];
  /** Hash over the entire canonical input (definition + task + files). */
  contentHash: string;
}

/** Default location of the benchmark suites tree. */
export function getSuitesDir(): string {
  return join(process.cwd(), "benchmark", "suites");
}

const DEFINITION_FILE = "benchmark.yaml";

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function loadFiles(
  dir: string,
  relPaths: string[],
): Promise<BenchmarkFile[]> {
  const files: BenchmarkFile[] = [];
  for (const rel of relPaths) {
    const absPath = join(dir, rel);
    const bytes = await readFile(absPath);
    files.push({
      relPath: rel,
      absPath,
      sha256: bytesHash(bytes),
      size: bytes.byteLength,
    });
  }
  return files;
}

/**
 * Load a single benchmark from its directory. `expectedDomain`, when provided,
 * is checked against the definition's declared domain for integrity.
 */
export async function loadBenchmarkFromDir(
  dir: string,
  expectedDomain?: Domain,
): Promise<LoadedBenchmark> {
  const definitionPath = join(dir, DEFINITION_FILE);
  const rawYaml = await readFile(definitionPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (error) {
    throw new Error(
      `Invalid YAML in ${definitionPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let definition: BenchmarkDefinition;
  try {
    definition = parseBenchmarkDefinition(parsed);
  } catch (error) {
    throw new Error(
      `Schema validation failed for ${definitionPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const folder = basename(dir);
  if (definition.id !== folder) {
    throw new Error(
      `Benchmark id "${definition.id}" does not match its folder "${folder}" (${dir})`,
    );
  }
  if (expectedDomain && definition.domain !== expectedDomain) {
    throw new Error(
      `Benchmark ${definition.id} declares domain "${definition.domain}" but lives under "${expectedDomain}/"`,
    );
  }

  const taskText = (await readFile(join(dir, definition.taskFile), "utf-8")).trim();
  const fixtures = await loadFiles(dir, definition.fixtures);
  const references = await loadFiles(dir, definition.referenceFiles);

  const contentHash = canonicalHash({
    schemaVersion: definition.schemaVersion,
    definition,
    task: taskText,
    fixtures: fixtures
      .map((f) => ({ path: f.relPath, sha256: f.sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    references: references
      .map((f) => ({ path: f.relPath, sha256: f.sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });

  return { definition, dir, taskText, fixtures, references, contentHash };
}

/**
 * Discover and load every benchmark under the suites tree. Domain folders map
 * to the {@link Domain} enum; unknown folders are ignored.
 */
export async function loadAllBenchmarks(
  suitesDir: string = getSuitesDir(),
): Promise<LoadedBenchmark[]> {
  if (!(await isDir(suitesDir))) {
    return [];
  }

  const benchmarks: LoadedBenchmark[] = [];
  const domainEntries = await readdir(suitesDir, { withFileTypes: true });

  for (const domainEntry of domainEntries) {
    if (!domainEntry.isDirectory()) continue;
    const domain = domainEntry.name as Domain;
    const domainDir = join(suitesDir, domainEntry.name);
    const idEntries = await readdir(domainDir, { withFileTypes: true });

    for (const idEntry of idEntries) {
      if (!idEntry.isDirectory()) continue;
      const benchDir = join(domainDir, idEntry.name);
      // Only treat directories that actually contain a definition file.
      try {
        await stat(join(benchDir, DEFINITION_FILE));
      } catch {
        continue;
      }
      benchmarks.push(await loadBenchmarkFromDir(benchDir, domain));
    }
  }

  benchmarks.sort((a, b) => a.definition.id.localeCompare(b.definition.id));
  return benchmarks;
}

/** Load a single benchmark by id, searching all domains. */
export async function loadBenchmarkById(
  id: string,
  suitesDir: string = getSuitesDir(),
): Promise<LoadedBenchmark> {
  const all = await loadAllBenchmarks(suitesDir);
  const found = all.find((b) => b.definition.id === id);
  if (!found) {
    const available = all.map((b) => b.definition.id).join(", ");
    throw new Error(
      `Unknown benchmark "${id}". Available: ${available || "(none)"}`,
    );
  }
  return found;
}

/** Convenience: relative suite path for display. */
export function suiteRelativePath(dir: string): string {
  return relative(process.cwd(), dir);
}
