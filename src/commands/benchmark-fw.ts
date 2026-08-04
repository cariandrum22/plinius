/**
 * `plinius benchmark list|show` — inspect framework benchmark assets.
 *
 * Distinct from the legacy `plinius benchmark` prompt runner: these subcommands
 * operate on the `benchmark/<category>/` asset tree.
 */
import { benchmarkRelativePath, loadAllBenchmarks, loadBenchmarkById } from "../framework/loader.js";

export async function runBenchmarkList(): Promise<void> {
  const benchmarks = await loadAllBenchmarks();
  if (benchmarks.length === 0) {
    console.log("No framework benchmarks found under benchmark/<category>/.");
    return;
  }

  console.log(`\n=== Benchmarks (${benchmarks.length}) ===\n`);
  const byCategory = new Map<string, typeof benchmarks>();
  for (const b of benchmarks) {
    const list = byCategory.get(b.asset.category) ?? [];
    list.push(b);
    byCategory.set(b.asset.category, list);
  }

  for (const [category, list] of [...byCategory].sort()) {
    const golden = list.filter((b) => b.asset.golden).length;
    console.log(`## ${category}  (${list.length}, golden ${golden})`);
    for (const b of list) {
      const a = b.asset;
      const flags = [a.golden ? "★golden" : null, `v${a.version}`, a.difficulty, `~${a.estimatedTokens} tok`, ...(a.tags.length ? [a.tags.join(",")] : [])]
        .filter(Boolean)
        .join(" · ");
      console.log(`  ${a.id} — ${a.title}`);
      console.log(`    ${flags}`);
      console.log(`    ${benchmarkRelativePath(b.dir)}  hash=${b.contentHash.slice(0, 19)}…`);
    }
    console.log("");
  }
}

export async function runBenchmarkShow(id: string): Promise<void> {
  const b = await loadBenchmarkById(id);
  const a = b.asset;
  console.log(`\n=== ${a.id} — ${a.title} ===\n`);
  console.log(`Version:      ${a.version}`);
  console.log(`Category:     ${a.category}`);
  console.log(`Difficulty:   ${a.difficulty}`);
  console.log(`Golden:       ${a.golden ? "yes" : "no"}`);
  console.log(`Est. tokens:  ${a.estimatedTokens}`);
  console.log(`Tags:         ${a.tags.join(", ") || "—"}`);
  console.log(`Author:       ${a.author}`);
  console.log(`License:      ${a.license}`);
  console.log(`Content hash: ${b.contentHash}`);
  if (a.description) console.log(`\nDescription:\n  ${a.description}`);

  console.log(`\nRubric (criteria + weights only, no scores):`);
  for (const c of b.rubric.criteria) {
    console.log(`  ${c.name}: ${c.weight}${c.description ? `  (${c.description})` : ""}`);
  }

  const systemPreview = b.systemPrompt ? b.systemPrompt.slice(0, 200) : "(none)";
  const userPreview = b.userPrompt.slice(0, 200);
  console.log(`\nPrompt:`);
  console.log(`  system: ${systemPreview}${b.systemPrompt.length > 200 ? "…" : ""}`);
  console.log(`  user:   ${userPreview}${b.userPrompt.length > 200 ? "…" : ""}`);
  console.log(`\nReferences: ${b.references ? `${b.references.length} chars` : "(none)"}`);
  console.log("");
}
