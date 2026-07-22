/**
 * `plinius reproduce` — judge whether a saved evaluation manifest can be
 * reproduced against the current catalog / prompt / environment state.
 */
import { readFile } from "fs/promises";
import { validateManifest } from "../manifest/manifest.js";
import { CurrentState, compareManifest } from "../manifest/reproduce.js";
import { captureEnvironment } from "../environment/environment.js";
import { loadSnapshot, findModel } from "../catalog/snapshot.js";
import { classifyLifecycle } from "../campaign/lifecycle.js";

export interface ReproduceOptions {
  manifest: string;
  catalog?: string;
  prompt?: string;
  backend?: string;
}

export async function runReproduce(options: ReproduceOptions): Promise<void> {
  const manifest = validateManifest(JSON.parse(await readFile(options.manifest, "utf-8")));
  const current: CurrentState = { environment: captureEnvironment() };
  if (options.backend) current.backend = options.backend;

  if (options.catalog) {
    const snapshot = await loadSnapshot(options.catalog);
    current.catalogSnapshotId = snapshot.snapshotId;
    const nowMs = Date.now();
    const lifecycle: Record<string, string> = {};
    const canonicalSlugs: Record<string, string | null> = {};
    for (const t of manifest.targetModels) {
      const model = findModel(snapshot, t.canonicalSlug ?? t.requestedSlug ?? t.targetId);
      lifecycle[t.targetId] = classifyLifecycle(model, nowMs);
      if (t.requestedSlug) canonicalSlugs[t.requestedSlug] = model?.canonicalSlug ?? null;
    }
    current.lifecycle = lifecycle as CurrentState["lifecycle"];
    current.canonicalSlugs = canonicalSlugs;
  }

  if (options.prompt) {
    const promptSnapshot = JSON.parse(await readFile(options.prompt, "utf-8")) as { promptId: string };
    current.promptSnapshotId = promptSnapshot.promptId;
  }

  const result = compareManifest(manifest, current);

  console.log(`\n=== Reproducibility: ${manifest.runId} ===`);
  console.log(`Verdict: ${result.verdict}`);
  console.log(`Catalog match:     ${result.catalogMatch === null ? "not checked" : result.catalogMatch}`);
  console.log(`Prompt match:      ${result.promptMatch === null ? "not checked" : result.promptMatch}`);
  console.log(`Backend match:     ${result.backendMatch === null ? "not checked" : result.backendMatch}`);
  console.log(`Environment diffs: ${result.environmentDiffs.length}${result.criticalEnvDiff ? " (CRITICAL)" : ""}`);
  for (const d of result.environmentDiffs) console.log(`  ~ ${d.field}: ${d.from} → ${d.to}`);
  console.log(`Lifecycle diffs:   ${result.lifecycleDiffs.length}`);
  for (const d of result.lifecycleDiffs) console.log(`  ~ ${d.targetId}: ${d.from} → ${d.to}`);
  console.log(`Alias diffs:       ${result.aliasDiffs.length}`);
  for (const d of result.aliasDiffs) console.log(`  ~ ${d.targetId}: ${d.was} → ${d.now}`);
  console.log(`Provider diffs:    ${result.providerDiffs.length}`);
  for (const d of result.providerDiffs) console.log(`  ~ ${d.targetId}: ${d.was} → ${d.now}`);
  if (result.reasons.length > 0) console.log(`Reasons: ${result.reasons.join("; ")}`);
}
