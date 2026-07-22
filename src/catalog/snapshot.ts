/**
 * Catalog snapshot assembly + persistence.
 *
 * A snapshot stores the raw API response verbatim AND a normalized, versioned
 * view. The snapshotId is a deterministic content hash of the normalized models
 * (independent of fetch time), so identical raw input always yields the same
 * snapshotId — snapshots are reproducible. Loading/parsing needs no API key.
 */
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import {
  CATALOG_SCHEMA_VERSION,
  CatalogSnapshot,
  NormalizedModel,
  RawModel,
  normalizeModel,
} from "./schema.js";

function canonicalStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sort((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Deterministic snapshot id from the normalized models (excludes fetch time). */
export function computeSnapshotId(models: NormalizedModel[]): string {
  const canonical = [...models]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({ ...m }));
  const digest = createHash("sha256").update(canonicalStringify(canonical), "utf-8");
  return `snap-${digest.digest("hex").slice(0, 16)}`;
}

export interface BuildSnapshotInput {
  rawModels: RawModel[];
  /** Optional per-model endpoints keyed by model id. */
  endpointsById?: Map<string, Parameters<typeof normalizeModel>[1]>;
  fetchedAt: string;
  source?: CatalogSnapshot["source"];
  backend?: string;
}

export function buildSnapshot(input: BuildSnapshotInput): CatalogSnapshot {
  const models = input.rawModels.map((raw) =>
    normalizeModel(raw, input.endpointsById?.get(raw.id)),
  );
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    snapshotId: computeSnapshotId(models),
    backend: input.backend ?? "openrouter",
    fetchedAt: input.fetchedAt,
    source: input.source ?? "live",
    modelCount: models.length,
    models,
  };
}

export function catalogDir(): string {
  return join(process.cwd(), "benchmark", "artifacts", "catalog");
}

/** Persist raw + normalized snapshot separately. Returns file paths. */
export async function saveSnapshot(
  snapshot: CatalogSnapshot,
  rawResponse: unknown,
  dir: string = catalogDir(),
): Promise<{ snapshotPath: string; rawPath: string }> {
  await mkdir(dir, { recursive: true });
  const snapshotPath = join(dir, `${snapshot.snapshotId}.json`);
  const rawPath = join(dir, `${snapshot.snapshotId}.raw.json`);
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
  await writeFile(rawPath, JSON.stringify(rawResponse, null, 2), "utf-8");
  return { snapshotPath, rawPath };
}

/** Load a normalized snapshot. No API key required. */
export async function loadSnapshot(path: string): Promise<CatalogSnapshot> {
  const snapshot = JSON.parse(await readFile(path, "utf-8")) as CatalogSnapshot;
  if (snapshot.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    // Tolerate older versions but surface the mismatch to the caller.
    snapshot.source = snapshot.source ?? "cache";
  }
  return snapshot;
}

export function findModel(snapshot: CatalogSnapshot, slugOrId: string): NormalizedModel | undefined {
  return snapshot.models.find(
    (m) => m.id === slugOrId || m.canonicalSlug === slugOrId,
  );
}
