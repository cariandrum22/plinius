/**
 * `plinius models` — OpenRouter catalog sync / list / inspect / diff / recommend.
 *
 * Synchronization only writes catalog snapshots; it never modifies experiment or
 * cohort definitions. `recommend` produces a proposal, not an automatic change.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { resolveEnv } from "../env.js";
import { OpenRouterCatalogClient } from "../catalog/client.js";
import { RawModelsResponseSchema } from "../catalog/schema.js";
import { buildSnapshot, catalogDir, findModel, loadSnapshot, saveSnapshot } from "../catalog/snapshot.js";
import { FilterCriteria, SortKey, filterModels, sortModels } from "../catalog/filter.js";
import { diffSnapshots } from "../catalog/diff.js";
import { parseCohort } from "../campaign/cohort.js";
import { INITIAL_DISCOVERY_RULES, generateRecommendation } from "../campaign/discovery.js";

async function latestSnapshotPath(dir = catalogDir()): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  const snapshots = files.filter((f) => f.endsWith(".json") && !f.endsWith(".raw.json"));
  if (snapshots.length === 0) return null;
  let latest: { path: string; mtime: number } | null = null;
  for (const f of snapshots) {
    const p = join(dir, f);
    const s = await stat(p);
    if (!latest || s.mtimeMs > latest.mtime) latest = { path: p, mtime: s.mtimeMs };
  }
  return latest?.path ?? null;
}

export interface ModelsSyncOptions {
  fixture?: string;
  fetchedAt?: string;
}

export async function runModelsSync(options: ModelsSyncOptions = {}): Promise<void> {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  let raw: unknown;
  let source: "live" | "fixture" = "live";

  if (options.fixture) {
    raw = JSON.parse(await readFile(options.fixture, "utf-8"));
    source = "fixture";
  } else {
    const client = new OpenRouterCatalogClient({ apiKey: resolveEnv("OPENROUTER_API_KEY") });
    raw = { data: await client.getModels() };
  }

  const parsed = RawModelsResponseSchema.parse(raw);
  const snapshot = buildSnapshot({ rawModels: parsed.data, fetchedAt, source });
  const { snapshotPath } = await saveSnapshot(snapshot, raw);

  console.log(`\n=== Catalog Sync (${source}) ===`);
  console.log(`Snapshot: ${snapshot.snapshotId}`);
  console.log(`Models: ${snapshot.modelCount}`);
  console.log(`Saved: ${snapshotPath}`);
  console.log(`(experiment/cohort definitions are untouched)`);
}

export interface ModelsListOptions {
  sort?: SortKey;
  author?: string;
  minContextLength?: number;
  maxPromptPrice?: number;
  requiredParameters?: string[];
  inputModality?: string;
  outputModality?: string;
  requireZdr?: boolean;
  limit?: number;
}

export async function runModelsList(options: ModelsListOptions = {}): Promise<void> {
  const path = await latestSnapshotPath();
  if (!path) { console.log("No catalog snapshot. Run `plinius models sync` first."); return; }
  const snapshot = await loadSnapshot(path);
  const criteria: FilterCriteria = {
    author: options.author,
    minContextLength: options.minContextLength,
    maxPromptPrice: options.maxPromptPrice,
    requiredParameters: options.requiredParameters,
    inputModality: options.inputModality,
    outputModality: options.outputModality,
    requireZdr: options.requireZdr,
  };
  let models = filterModels(snapshot.models, criteria);
  if (options.sort) models = sortModels(models, options.sort);
  const limited = models.slice(0, options.limit ?? 40);

  console.log(`\n=== Models (${snapshot.snapshotId}, ${models.length} matched) ===`);
  for (const m of limited) {
    const price = m.pricing.prompt !== null ? `$${(m.pricing.prompt * 1e6).toFixed(2)}/M` : "—";
    console.log(`  ${m.id}  ctx=${m.contextLength ?? "—"}  in=${price}  params=${m.supportedParameters.length}`);
  }
}

export async function runModelsInspect(slug: string): Promise<void> {
  const path = await latestSnapshotPath();
  if (!path) { console.log("No catalog snapshot. Run `plinius models sync` first."); return; }
  const snapshot = await loadSnapshot(path);
  const model = findModel(snapshot, slug);
  if (!model) { console.log(`Model "${slug}" not found in ${snapshot.snapshotId}.`); return; }
  console.log(`\n=== ${model.id} ===`);
  console.log(`canonical: ${model.canonicalSlug}`);
  console.log(`name: ${model.name}`);
  console.log(`context: ${model.contextLength}`);
  console.log(`modalities: in=${model.inputModalities.join("/")} out=${model.outputModalities.join("/")}`);
  console.log(`supported params: ${model.supportedParameters.join(", ")}`);
  console.log(`pricing: prompt=${model.pricing.prompt} completion=${model.pricing.completion} cacheRead=${model.pricing.cacheRead}`);
  console.log(`moderated: ${model.moderated}  expiration: ${model.expirationDate ?? "—"}`);
}

export async function runModelsDiff(pathA: string, pathB: string): Promise<void> {
  const a = await loadSnapshot(pathA);
  const b = await loadSnapshot(pathB);
  const diff = diffSnapshots(a, b);
  console.log(`\n=== Diff ${a.snapshotId} → ${b.snapshotId} ===`);
  console.log(`Added: ${diff.added.length}  Removed: ${diff.removed.length}  Changed: ${diff.changed.length}  Expired: ${diff.expired.length}`);
  for (const id of diff.added.slice(0, 20)) console.log(`  + ${id}`);
  for (const id of diff.removed.slice(0, 20)) console.log(`  - ${id}`);
  for (const c of diff.changed.slice(0, 20)) console.log(`  ~ ${c.id}: ${c.changes.map((x) => x.field).join(", ")}`);
}

async function loadCohortModelIds(): Promise<Set<string>> {
  const dir = join(process.cwd(), "benchmark", "campaign", "cohorts");
  const ids = new Set<string>();
  let files: string[];
  try { files = await readdir(dir); } catch { return ids; }
  for (const f of files.filter((x) => x.endsWith(".yaml") || x.endsWith(".yml"))) {
    try {
      const cohort = parseCohort(parseYaml(await readFile(join(dir, f), "utf-8")));
      for (const t of cohort.targets) {
        if (t.model) ids.add(t.model);
        if (t.requestedModel) ids.add(t.requestedModel.replace(/^~/, ""));
      }
    } catch {
      // skip invalid cohort files
    }
  }
  return ids;
}

export async function runModelsRecommend(): Promise<void> {
  const path = await latestSnapshotPath();
  if (!path) { console.log("No catalog snapshot. Run `plinius models sync` first."); return; }
  const current = await loadSnapshot(path);
  const cohortModelIds = await loadCohortModelIds();

  const report = generateRecommendation({
    current,
    cohortModelIds,
    rules: INITIAL_DISCOVERY_RULES,
    generatedAt: new Date().toISOString(),
    nowMs: Date.now(),
  });

  const dir = join(process.cwd(), "benchmark", "artifacts", "catalog", "recommendations");
  await mkdir(dir, { recursive: true });
  const out = join(dir, `recommendation_${current.snapshotId}.json`);
  await writeFile(out, JSON.stringify(report, null, 2), "utf-8");

  console.log(`\n=== Discovery Recommendation (${current.snapshotId}) ===`);
  console.log(`⚠ Proposal only — cohorts are NOT modified. Human approval + version bump required.`);
  console.log(`Candidate additions: ${report.candidateAdditions.length}`);
  for (const c of report.candidateAdditions.slice(0, 15)) console.log(`  + ${c.id} — ${c.reason}`);
  console.log(`Candidate removals: ${report.candidateRemovals.length}`);
  for (const c of report.candidateRemovals.slice(0, 15)) console.log(`  - ${c.id} — ${c.reason}`);
  console.log(`Alias drift: ${report.aliasDrift.length}`);
  console.log(`Saved: ${out}`);
}
