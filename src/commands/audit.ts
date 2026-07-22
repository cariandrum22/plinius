/**
 * `plinius audit` — completeness / integrity audit of an evaluation manifest.
 */
import { readFile } from "fs/promises";
import { validateManifest } from "../manifest/manifest.js";
import { auditManifest } from "../manifest/audit.js";
import { PromptSnapshot } from "../prompt/snapshot.js";

export interface AuditOptions {
  manifest: string;
  prompt?: string;
}

export async function runAudit(options: AuditOptions): Promise<void> {
  const manifest = validateManifest(JSON.parse(await readFile(options.manifest, "utf-8")));
  let promptSnapshot: PromptSnapshot | undefined;
  if (options.prompt) {
    promptSnapshot = JSON.parse(await readFile(options.prompt, "utf-8")) as PromptSnapshot;
  }

  const result = auditManifest(manifest, { promptSnapshot });

  console.log(`\n=== Audit: ${manifest.runId} ===`);
  for (const item of result.items) {
    const mark = item.level === "OK" ? "✔" : item.level === "WARNING" ? "WARNING" : "ERROR";
    console.log(`  ${mark} ${item.check}: ${item.detail}`);
  }
  console.log(`\nOK: ${result.ok}  WARNING: ${result.warnings}  ERROR: ${result.errors}`);
  if (result.errors > 0) process.exitCode = 1;
}
