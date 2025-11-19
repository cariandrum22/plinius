/**
 * Clean failed tasks from progress.json
 *
 * Usage:
 *   pnpm run dev src/utils/clean-failed.ts
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";

interface ProgressState {
  completed: Array<{ model: string; promptId: string }>;
  failed: Array<{ model: string; promptId: string; error: string }>;
  lastUpdate: string;
}

async function cleanFailedTasks() {
  const progressPath = join(
    process.cwd(),
    "artifacts",
    "result",
    "progress.json"
  );

  try {
    const content = await readFile(progressPath, "utf-8");
    const progress: ProgressState = JSON.parse(content);

    console.log(`Current state:`);
    console.log(`  Completed: ${progress.completed.length}`);
    console.log(`  Failed: ${progress.failed.length}`);

    if (progress.failed.length === 0) {
      console.log(`\n✅ No failed tasks to clean`);
      return;
    }

    console.log(`\nFailed tasks:`);
    for (const f of progress.failed) {
      console.log(`  - ${f.promptId} with ${f.model}`);
    }

    // Clear failed tasks
    progress.failed = [];
    progress.lastUpdate = new Date().toISOString();

    await writeFile(progressPath, JSON.stringify(progress, null, 2), "utf-8");

    console.log(`\n✅ Cleaned failed tasks from progress.json`);
  } catch (error) {
    console.error(
      `Failed to clean progress:`,
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

cleanFailedTasks();
