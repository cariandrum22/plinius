import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  BENCHMARK_SCHEMA_VERSION,
  parseBenchmarkDefinition,
} from "../src/suite/schema.js";
import { loadBenchmarkFromDir, loadAllBenchmarks } from "../src/suite/loader.js";

function baseDef(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    id: "arch-001",
    version: "1.0.0",
    domain: "architecture",
    difficulty: "advanced",
    title: "Example",
    ...overrides,
  };
}

describe("benchmark schema", () => {
  it("applies nested defaults for rubric and qualification", () => {
    const def = parseBenchmarkDefinition(baseDef());
    expect(def.rubric.scaleMax).toBe(5);
    expect(def.qualification.deterministicPassRate).toBe(1);
    expect(def.prototype).toBe(false);
    expect(def.deterministicChecks).toEqual([]);
  });

  it("rejects a non-kebab id", () => {
    expect(() => parseBenchmarkDefinition(baseDef({ id: "Arch_001" }))).toThrow();
  });

  it("rejects a non-semver version", () => {
    expect(() => parseBenchmarkDefinition(baseDef({ version: "1.0" }))).toThrow();
  });

  it("rejects an unknown domain", () => {
    expect(() => parseBenchmarkDefinition(baseDef({ domain: "poetry" }))).toThrow();
  });

  it("rejects a regex check whose pattern does not compile in JS", () => {
    expect(() =>
      parseBenchmarkDefinition(
        baseDef({
          deterministicChecks: [
            // PCRE inline flag — invalid in JS.
            { kind: "regex", id: "bad", pattern: "(?s).{10,}", mustMatch: true },
          ],
        }),
      ),
    ).toThrow(/invalid regex/);
  });

  it("validates a discriminated deterministic check", () => {
    const def = parseBenchmarkDefinition(
      baseDef({
        deterministicChecks: [
          { kind: "required_sections", id: "s1", sections: ["Summary"] },
        ],
      }),
    );
    expect(def.deterministicChecks[0].kind).toBe("required_sections");
    // default authority + blocking applied
    expect(def.deterministicChecks[0].authority).toBe("structural");
    expect(def.deterministicChecks[0].blocking).toBe(true);
  });
});

describe("benchmark loader + canonical hash", () => {
  async function writeBench(dir: string, taskText: string, refText: string) {
    await writeFile(join(dir, "benchmark.yaml"), [
      `schemaVersion: ${BENCHMARK_SCHEMA_VERSION}`,
      "id: arch-001",
      "version: 1.0.0",
      "domain: architecture",
      "difficulty: advanced",
      "title: Example",
      "referenceFiles:",
      "  - reference/answer.md",
    ].join("\n"));
    await writeFile(join(dir, "task.md"), taskText);
    await mkdir(join(dir, "reference"), { recursive: true });
    await writeFile(join(dir, "reference", "answer.md"), refText);
  }

  it("hashes definition + task + reference; changes when any input changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "plinius-suite-"));
    try {
      const dir = join(root, "arch-001");
      await mkdir(dir, { recursive: true });
      await writeBench(dir, "Design a system.", "Reference A");
      const first = await loadBenchmarkFromDir(dir, "architecture");
      expect(first.contentHash).toMatch(/^sha256:/);
      expect(first.references).toHaveLength(1);

      // Changing the reference file changes the canonical hash.
      await writeFile(join(dir, "reference", "answer.md"), "Reference B");
      const second = await loadBenchmarkFromDir(dir, "architecture");
      expect(second.contentHash).not.toBe(first.contentHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an id / folder mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "plinius-suite-"));
    try {
      const dir = join(root, "wrong-folder");
      await mkdir(dir, { recursive: true });
      await writeBench(dir, "x", "y");
      await expect(loadBenchmarkFromDir(dir, "architecture")).rejects.toThrow(/does not match/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a domain / folder mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "plinius-suite-"));
    try {
      const dir = join(root, "arch-001");
      await mkdir(dir, { recursive: true });
      await writeBench(dir, "x", "y");
      await expect(loadBenchmarkFromDir(dir, "security")).rejects.toThrow(/domain/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns [] when the suites dir does not exist", async () => {
    const missing = join(tmpdir(), "plinius-does-not-exist-xyz");
    expect(await loadAllBenchmarks(missing)).toEqual([]);
  });
});
