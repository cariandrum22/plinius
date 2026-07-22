/**
 * Validation harness for the benchmark suites.
 *
 * - Loads and schema-validates every benchmark under benchmark/suites/.
 * - For coding benchmarks with a reference solution, materializes the reference
 *   into a workspace and runs the deterministic checks to prove the benchmark's
 *   own acceptance test is satisfiable.
 *
 * Run with: npx tsx scripts/validate-suites.mts
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { loadAllBenchmarks } from "../src/suite/loader.js";
import { createWorkspace, destroyWorkspace } from "../src/coding/workspace.js";
import { runDeterministicChecks, summarizeDeterministic } from "../src/evaluators/registry.js";
import { LocalProcessSandbox } from "../src/evaluators/sandbox.js";

async function main() {
  const benchmarks = await loadAllBenchmarks();
  console.log(`Loaded ${benchmarks.length} benchmark(s).\n`);
  const sandbox = new LocalProcessSandbox();
  let failures = 0;

  for (const b of benchmarks) {
    const d = b.definition;
    console.log(`✓ ${d.id} [${d.domain}/${d.difficulty}] v${d.version} prototype=${d.prototype}`);
    console.log(`    checks=${d.deterministicChecks.length} hash=${b.contentHash.slice(0, 24)}…`);

    // For coding benchmarks, run the reference solution through the checks.
    const refSolution = b.references.find((r) => /solution\.mjs$/.test(r.relPath));
    if (d.domain === "coding" && refSolution) {
      const content = await readFile(refSolution.absPath, "utf-8");
      const output = JSON.stringify({ files: [{ path: "solution.mjs", content }] });
      const ws = await createWorkspace(output, b.fixtures);
      try {
        const evals = await runDeterministicChecks(d.deterministicChecks, {
          outputText: output,
          workspaceDir: ws.dir,
          sandbox,
        });
        const summary = summarizeDeterministic(evals);
        for (const e of evals) {
          console.log(`      [${e.status}] ${e.checkId}: ${e.message}`);
        }
        if (summary.hasBlockingFailure) {
          console.log(`    ✗ reference solution FAILS its own blocking checks`);
          failures++;
        } else {
          console.log(`    ✓ reference solution satisfies blocking checks`);
        }
      } finally {
        await destroyWorkspace(ws);
      }
    }
    console.log("");
  }

  if (failures > 0) {
    console.error(`${failures} benchmark(s) failed reference validation.`);
    process.exit(1);
  }
  console.log("All benchmarks validated.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
