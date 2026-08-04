/**
 * Benchmark Framework — artifact store.
 *
 * Owns the on-disk layout for campaign execution artifacts, review sets, and
 * reports, and the read/write helpers the command layer uses. The public review
 * set and its private mapping are always written to separate paths (the mapping
 * under `private/`), mirroring the blind-review discipline.
 */
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { FrameworkRunRecord } from "./runner.js";
import { ReviewMapping, ReviewSet } from "./review.js";

export function reportsRoot(): string {
  return join(process.cwd(), "reports");
}
export function reviewsRoot(): string {
  return join(process.cwd(), "reviews");
}

export function campaignReportDir(campaignId: string): string {
  return join(reportsRoot(), campaignId);
}
export function campaignRunsDir(campaignId: string): string {
  return join(campaignReportDir(campaignId), "runs");
}
export function campaignReviewDir(campaignId: string): string {
  return join(reviewsRoot(), campaignId);
}

/** Load every run record for a campaign (ignores the catalog/ subdir). */
export async function loadRunRecords(campaignId: string): Promise<FrameworkRunRecord[]> {
  const dir = campaignRunsDir(campaignId);
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const records: FrameworkRunRecord[] = [];
  for (const name of entries.sort()) {
    records.push(JSON.parse(await readFile(join(dir, name), "utf-8")) as FrameworkRunRecord);
  }
  return records;
}

export async function writeReviewSet(set: ReviewSet, mapping: ReviewMapping): Promise<{ setPath: string; mappingPath: string }> {
  const dir = campaignReviewDir(set.campaignId);
  const privateDir = join(dir, "private");
  await mkdir(privateDir, { recursive: true });
  const setPath = join(dir, "review-set.json");
  const mappingPath = join(privateDir, "mapping.json");
  await writeFile(setPath, JSON.stringify(set, null, 2), "utf-8");
  await writeFile(mappingPath, JSON.stringify(mapping, null, 2), "utf-8");
  return { setPath, mappingPath };
}

export async function loadReviewSet(campaignId: string): Promise<ReviewSet | null> {
  try {
    return JSON.parse(await readFile(join(campaignReviewDir(campaignId), "review-set.json"), "utf-8")) as ReviewSet;
  } catch {
    return null;
  }
}

export async function loadReviewMapping(campaignId: string): Promise<ReviewMapping | null> {
  try {
    return JSON.parse(
      await readFile(join(campaignReviewDir(campaignId), "private", "mapping.json"), "utf-8"),
    ) as ReviewMapping;
  } catch {
    return null;
  }
}

export async function writeReport(campaignId: string, json: unknown, markdown: string): Promise<{ jsonPath: string; mdPath: string }> {
  const dir = campaignReportDir(campaignId);
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, "report.json");
  const mdPath = join(dir, "report.md");
  await writeFile(jsonPath, JSON.stringify(json, null, 2), "utf-8");
  await writeFile(mdPath, markdown, "utf-8");
  return { jsonPath, mdPath };
}
