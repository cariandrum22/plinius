/**
 * `plinius suites` — list discovered benchmark suites and their metadata.
 */
import { loadAllBenchmarks, suiteRelativePath } from "../suite/loader.js";

export async function runSuites(): Promise<void> {
  const benchmarks = await loadAllBenchmarks();
  if (benchmarks.length === 0) {
    console.log("No benchmark suites found under benchmark/suites/.");
    return;
  }

  console.log(`\n=== Benchmark Suites (${benchmarks.length}) ===\n`);
  const byDomain = new Map<string, typeof benchmarks>();
  for (const b of benchmarks) {
    const list = byDomain.get(b.definition.domain) ?? [];
    list.push(b);
    byDomain.set(b.definition.domain, list);
  }

  for (const [domain, list] of [...byDomain].sort()) {
    console.log(`## ${domain}`);
    for (const b of list) {
      const d = b.definition;
      const flags = [
        `v${d.version}`,
        d.difficulty,
        d.prototype ? "prototype" : null,
        `${d.deterministicChecks.length} checks`,
      ]
        .filter(Boolean)
        .join(" · ");
      console.log(`  ${d.id} — ${d.title}`);
      console.log(`    ${flags}`);
      console.log(`    ${suiteRelativePath(b.dir)}  hash=${b.contentHash.slice(0, 19)}…`);
    }
    console.log("");
  }
}
