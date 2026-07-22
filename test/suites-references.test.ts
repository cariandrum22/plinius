import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { basename } from "path";
import { loadAllBenchmarks } from "../src/suite/loader.js";
import {
  runDeterministicChecks,
  summarizeDeterministic,
} from "../src/evaluators/registry.js";
import { LocalProcessSandbox } from "../src/evaluators/sandbox.js";
import { createWorkspace, destroyWorkspace } from "../src/coding/workspace.js";

/**
 * Every shipped benchmark's reference answer must satisfy that benchmark's own
 * blocking deterministic checks — otherwise the checks are unsatisfiable and
 * would wrongly disqualify a correct model. `not_available` (e.g. tlc absent)
 * is acceptable; a blocking `fail` or evaluator `error` is not.
 */
describe("shipped benchmark suites", () => {
  it("discovers and validates all suites against the schema", async () => {
    const benchmarks = await loadAllBenchmarks();
    expect(benchmarks.length).toBeGreaterThanOrEqual(6);
    const domains = new Set(benchmarks.map((b) => b.definition.domain));
    for (const d of ["architecture", "security", "coding", "formal", "writing", "fiction"]) {
      expect(domains.has(d as never)).toBe(true);
    }
    // Phase 1 ships prototypes only.
    expect(benchmarks.every((b) => b.definition.prototype)).toBe(true);
  });

  it("reference answers satisfy their own blocking checks", async () => {
    const sandbox = new LocalProcessSandbox();
    const benchmarks = await loadAllBenchmarks();

    for (const b of benchmarks) {
      const checks = b.definition.deterministicChecks;
      const needsWs =
        b.fixtures.length > 0 ||
        checks.some(
          (c) =>
            c.kind === "command" ||
            c.kind === "file_exists" ||
            (c.kind === "json_schema" && c.source === "file"),
        );

      const codeFiles: { path: string; content: string }[] = [];
      let prose = "";
      for (const r of b.references) {
        const content = await readFile(r.absPath, "utf-8");
        if (/\.(md|txt)$/.test(r.relPath)) prose += content + "\n\n";
        else codeFiles.push({ path: basename(r.relPath), content });
      }
      const output =
        (codeFiles.length ? "```json\n" + JSON.stringify({ files: codeFiles }) + "\n```\n\n" : "") +
        prose;

      const ws = needsWs ? await createWorkspace(output, b.fixtures) : undefined;
      try {
        const evals = await runDeterministicChecks(checks, {
          outputText: output,
          workspaceDir: ws?.dir,
          sandbox,
        });
        const summary = summarizeDeterministic(evals);
        const blockingFails = evals.filter((e) => e.blocking && e.status === "fail");
        expect(
          summary.hasBlockingFailure,
          `${b.definition.id} blocking fail: ${blockingFails.map((e) => `${e.checkId}(${e.message})`).join("; ")}`,
        ).toBe(false);
        expect(
          summary.hasError,
          `${b.definition.id} evaluator error: ${evals.filter((e) => e.status === "error").map((e) => e.checkId).join(", ")}`,
        ).toBe(false);
      } finally {
        if (ws) await destroyWorkspace(ws);
      }
    }
  }, 60_000);
});
