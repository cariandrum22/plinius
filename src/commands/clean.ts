/**
 * Clean command - Remove benchmark artifacts
 */
import { readdir, rm, stat } from "fs/promises";
import { join } from "path";

type CleanTarget = "benchmark" | "evaluate" | "reports" | "all";

/**
 * Get artifact directory paths
 */
function getArtifactPaths() {
  const base = join(process.cwd(), "benchmark", "artifacts");
  return {
    benchmark: join(base, "result"),
    evaluate: join(base, "evaluation"),
    reports: join(base, "reports"),
  };
}

/**
 * Count files in directory (excluding .gitkeep)
 */
async function countFiles(dirPath: string): Promise<number> {
  try {
    const files = await readdir(dirPath);
    return files.filter(f => f !== ".gitkeep").length;
  } catch {
    return 0;
  }
}

/**
 * Get directory size in bytes
 */
async function getDirSize(dirPath: string): Promise<number> {
  try {
    const files = await readdir(dirPath);
    let totalSize = 0;

    for (const file of files) {
      if (file === ".gitkeep") continue;
      const filePath = join(dirPath, file);
      const stats = await stat(filePath);
      totalSize += stats.size;
    }

    return totalSize;
  } catch {
    return 0;
  }
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Clean a specific directory (keep .gitkeep)
 */
async function cleanDirectory(dirPath: string, name: string): Promise<{ files: number; size: number }> {
  try {
    const files = await readdir(dirPath);
    let deletedFiles = 0;
    let deletedSize = 0;

    for (const file of files) {
      if (file === ".gitkeep") continue;

      const filePath = join(dirPath, file);
      const stats = await stat(filePath);
      deletedSize += stats.size;

      await rm(filePath, { recursive: true });
      deletedFiles++;
    }

    if (deletedFiles > 0) {
      console.log(`  ✓ ${name}: ${deletedFiles} files (${formatBytes(deletedSize)})`);
    } else {
      console.log(`  - ${name}: already empty`);
    }

    return { files: deletedFiles, size: deletedSize };
  } catch (error) {
    console.log(`  ✗ ${name}: error - ${error instanceof Error ? error.message : String(error)}`);
    return { files: 0, size: 0 };
  }
}

/**
 * Show cleanup summary before execution
 */
async function showSummary(targets: CleanTarget[]): Promise<{ totalFiles: number; totalSize: number }> {
  const paths = getArtifactPaths();
  let totalFiles = 0;
  let totalSize = 0;

  console.log("\n=== Cleanup Summary ===\n");

  const targetDirs: Array<{ name: string; path: string }> = [];

  if (targets.includes("all") || targets.includes("benchmark")) {
    targetDirs.push({ name: "Benchmark results", path: paths.benchmark });
  }
  if (targets.includes("all") || targets.includes("evaluate")) {
    targetDirs.push({ name: "Evaluation data", path: paths.evaluate });
  }
  if (targets.includes("all") || targets.includes("reports")) {
    targetDirs.push({ name: "Reports", path: paths.reports });
  }

  for (const { name, path } of targetDirs) {
    const files = await countFiles(path);
    const size = await getDirSize(path);
    totalFiles += files;
    totalSize += size;
    console.log(`  ${name}: ${files} files (${formatBytes(size)})`);
  }

  console.log(`\n  Total: ${totalFiles} files (${formatBytes(totalSize)})`);

  return { totalFiles, totalSize };
}

/**
 * Run cleanup
 */
export async function runClean(target?: string): Promise<void> {
  // Parse target
  const validTargets: CleanTarget[] = ["benchmark", "evaluate", "reports", "all"];
  const cleanTarget: CleanTarget = (target && validTargets.includes(target as CleanTarget))
    ? target as CleanTarget
    : "all";

  const targets: CleanTarget[] = cleanTarget === "all"
    ? ["benchmark", "evaluate", "reports"]
    : [cleanTarget];

  console.log(`\n=== Plinius Cleanup ===`);
  console.log(`Target: ${cleanTarget}`);

  // Show summary
  const { totalFiles } = await showSummary([cleanTarget]);

  if (totalFiles === 0) {
    console.log("\n✓ Nothing to clean.\n");
    return;
  }

  // Execute cleanup
  console.log("\n=== Cleaning ===\n");

  const paths = getArtifactPaths();
  let deletedFiles = 0;
  let deletedSize = 0;

  if (targets.includes("benchmark")) {
    const result = await cleanDirectory(paths.benchmark, "Benchmark results");
    deletedFiles += result.files;
    deletedSize += result.size;
  }

  if (targets.includes("evaluate")) {
    const result = await cleanDirectory(paths.evaluate, "Evaluation data");
    deletedFiles += result.files;
    deletedSize += result.size;
  }

  if (targets.includes("reports")) {
    const result = await cleanDirectory(paths.reports, "Reports");
    deletedFiles += result.files;
    deletedSize += result.size;
  }

  console.log(`\n✓ Cleanup complete: ${deletedFiles} files removed (${formatBytes(deletedSize)})\n`);
}
