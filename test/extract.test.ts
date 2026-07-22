import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXTRACTION_LIMITS,
  extractFiles,
  validateRelPath,
} from "../src/coding/extract.js";

describe("validateRelPath", () => {
  const bad: [string, string][] = [
    ["../etc/passwd", "traversal"],
    ["a/../../b", "traversal"],
    ["/etc/passwd", "absolute"],
    ["C:\\Windows", "drive"],
    ["\\\\server\\share", "backslash"],
    ["a\\b", "backslash"],
    ["~/secrets", "home"],
    ["a\0b", "NUL"],
    ["a//b", "segment"],
    ["", "empty"],
  ];
  for (const [path] of bad) {
    it(`rejects ${JSON.stringify(path)}`, () => {
      expect(validateRelPath(path)).not.toBeNull();
    });
  }

  it("accepts a normal nested path", () => {
    expect(validateRelPath("src/lib/index.ts")).toBeNull();
  });
});

describe("extractFiles", () => {
  it("parses a JSON files envelope", () => {
    const out = extractFiles(
      '```json\n{"files":[{"path":"src/a.ts","content":"export const a=1;"}]}\n```',
    );
    expect(out.files).toEqual([{ path: "src/a.ts", content: "export const a=1;" }]);
    expect(out.rejected).toHaveLength(0);
  });

  it("parses labeled fenced blocks with a File: marker", () => {
    const md = [
      "Here is the solution.",
      "File: src/index.ts",
      "```ts",
      "export const x = 1;",
      "```",
    ].join("\n");
    const out = extractFiles(md);
    expect(out.files).toHaveLength(1);
    expect(out.files[0].path).toBe("src/index.ts");
    expect(out.files[0].content).toContain("export const x = 1;");
  });

  it("rejects traversal paths from output", () => {
    const out = extractFiles('{"files":[{"path":"../evil.sh","content":"x"}]}');
    expect(out.files).toHaveLength(0);
    expect(out.rejected[0].reason).toMatch(/traversal/);
  });

  it("rejects duplicate paths (collision)", () => {
    const out = extractFiles(
      '{"files":[{"path":"a.ts","content":"1"},{"path":"a.ts","content":"2"}]}',
    );
    expect(out.files).toHaveLength(1);
    expect(out.rejected.some((r) => /collision/.test(r.reason))).toBe(true);
  });

  it("enforces the file-count limit", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.ts`, content: "x" }));
    const out = extractFiles(JSON.stringify({ files }), {
      ...DEFAULT_EXTRACTION_LIMITS,
      maxFiles: 3,
    });
    expect(out.files).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });

  it("enforces the total-size budget", () => {
    const big = "x".repeat(1024);
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, content: big }));
    const out = extractFiles(JSON.stringify({ files }), {
      maxFiles: 100,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 3 * 1024,
    });
    expect(out.totalBytes).toBeLessThanOrEqual(3 * 1024);
    expect(out.truncated).toBe(true);
  });

  it("enforces the per-file size limit", () => {
    const out = extractFiles(
      JSON.stringify({ files: [{ path: "big.ts", content: "x".repeat(2048) }] }),
      { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 1024 * 1024 },
    );
    expect(out.files).toHaveLength(0);
    expect(out.rejected[0].reason).toMatch(/exceeds/);
  });
});
