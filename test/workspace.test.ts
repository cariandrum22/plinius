import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";
import { createWorkspace, destroyWorkspace } from "../src/coding/workspace.js";
import { BenchmarkFile } from "../src/suite/loader.js";
import { bytesHash } from "../src/suite/hash.js";

describe("createWorkspace", () => {
  it("writes validated files and rejects traversal", async () => {
    const output = JSON.stringify({
      files: [
        { path: "src/index.ts", content: "export const x = 1;" },
        { path: "../escape.ts", content: "evil" },
      ],
    });
    const ws = await createWorkspace(output);
    try {
      expect(ws.extraction.written).toEqual(["src/index.ts"]);
      expect(ws.extraction.rejected.some((r) => /traversal/.test(r.reason))).toBe(true);
      const written = await readFile(join(ws.dir, "src/index.ts"), "utf-8");
      expect(written).toBe("export const x = 1;");
    } finally {
      await destroyWorkspace(ws);
    }
  });

  it("copies fixtures into the workspace", async () => {
    const fixtureBytes = Buffer.from("fixture-content");
    const fixture: BenchmarkFile = {
      relPath: "package.json",
      absPath: join(process.cwd(), "package.json"),
      sha256: bytesHash(fixtureBytes),
      size: fixtureBytes.length,
    };
    const ws = await createWorkspace('{"files":[]}', [fixture]);
    try {
      const copied = await readFile(join(ws.dir, "package.json"), "utf-8");
      expect(copied).toContain("\"name\": \"plinius\"");
    } finally {
      await destroyWorkspace(ws);
    }
  });

  it("refuses to overwrite a fixture (collision defense)", async () => {
    const fixtureBytes = Buffer.from("original");
    const fixture: BenchmarkFile = {
      relPath: "config.txt",
      absPath: join(process.cwd(), "package.json"),
      sha256: bytesHash(fixtureBytes),
      size: fixtureBytes.length,
    };
    const output = JSON.stringify({ files: [{ path: "config.txt", content: "overwritten" }] });
    const ws = await createWorkspace(output, [fixture]);
    try {
      expect(ws.extraction.written).not.toContain("config.txt");
      expect(ws.extraction.rejected.some((r) => /collision/.test(r.reason))).toBe(true);
      // Fixture content is preserved.
      const content = await readFile(join(ws.dir, "config.txt"), "utf-8");
      expect(content).toContain("plinius");
    } finally {
      await destroyWorkspace(ws);
    }
  });
});
