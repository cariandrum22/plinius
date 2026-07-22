/**
 * Isolated workspace management for coding benchmarks.
 *
 * A workspace is a fresh temp directory. Fixtures (author-provided, trusted)
 * are copied in first, then validated model-generated files are written. All
 * writes are confined to the workspace root and refuse to follow or overwrite
 * existing entries (symlink / collision defense).
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve, sep } from "path";
import { BenchmarkFile } from "../suite/loader.js";
import {
  DEFAULT_EXTRACTION_LIMITS,
  ExtractionLimits,
  RejectedFile,
  extractFiles,
} from "./extract.js";

export interface WorkspaceExtractionSummary {
  written: string[];
  rejected: RejectedFile[];
  totalBytes: number;
  truncated: boolean;
}

export interface Workspace {
  dir: string;
  extraction: WorkspaceExtractionSummary;
}

/** Ensure `child` stays within `root`; throws on escape. */
function assertWithinRoot(root: string, child: string): void {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(child);
  if (resolvedChild !== resolvedRoot && !resolvedChild.startsWith(resolvedRoot + sep)) {
    throw new Error(`refusing to write outside workspace: ${child}`);
  }
}

/**
 * Create an isolated workspace, copy fixtures, and write validated model files.
 */
export async function createWorkspace(
  outputText: string,
  fixtures: BenchmarkFile[] = [],
  limits: ExtractionLimits = DEFAULT_EXTRACTION_LIMITS,
): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "plinius-ws-"));

  // Copy fixtures first (trusted author inputs).
  for (const fixture of fixtures) {
    const dest = join(dir, fixture.relPath);
    assertWithinRoot(dir, dest);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(fixture.absPath, dest);
  }

  const extraction = extractFiles(outputText, limits);
  const written: string[] = [];
  for (const file of extraction.files) {
    const dest = join(dir, file.path);
    assertWithinRoot(dir, dest);
    await mkdir(dirname(dest), { recursive: true });
    // flag "wx": fail if the path already exists (incl. through a symlink),
    // so a model file can never overwrite a fixture or follow a symlink.
    try {
      await writeFile(dest, file.content, { encoding: "utf-8", flag: "wx" });
      written.push(file.path);
    } catch {
      extraction.rejected.push({ path: file.path, reason: "collision with existing entry" });
    }
  }

  return {
    dir,
    extraction: {
      written,
      rejected: extraction.rejected,
      totalBytes: extraction.totalBytes,
      truncated: extraction.truncated,
    },
  };
}

/** Remove a workspace directory. Best-effort; never throws. */
export async function destroyWorkspace(workspace: Workspace): Promise<void> {
  try {
    await rm(workspace.dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
