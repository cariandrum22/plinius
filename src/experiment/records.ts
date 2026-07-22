/**
 * Load persisted experiment run records with a stable per-record id.
 *
 * The record id is the JSON file's basename (without extension) — a stable,
 * content-independent handle used by the blind-review mapping.
 */
import { readFile, readdir } from "fs/promises";
import { basename, join } from "path";
import { BenchmarkRunRecord } from "../types/benchmark.js";

export interface LoadedRunRecord {
  runRecordId: string;
  record: BenchmarkRunRecord;
}

export function experimentRecordsDir(experimentId: string, baseDir?: string): string {
  return join(
    baseDir ?? join(process.cwd(), "benchmark", "artifacts", "experiments"),
    experimentId,
  );
}

export async function loadExperimentRecords(
  experimentId: string,
  baseDir?: string,
): Promise<LoadedRunRecord[]> {
  const dir = experimentRecordsDir(experimentId, baseDir);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const records: LoadedRunRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const raw = await readFile(join(dir, file), "utf-8");
    records.push({
      runRecordId: basename(file, ".json"),
      record: JSON.parse(raw) as BenchmarkRunRecord,
    });
  }
  records.sort((a, b) => a.runRecordId.localeCompare(b.runRecordId));
  return records;
}
