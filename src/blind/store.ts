/**
 * On-disk store helpers for blind-review sets.
 *
 * Public artifacts live under `<base>/<id>/public`, private artifacts under
 * `<base>/<id>/private`, and imported human reviews under `<base>/<id>/reviews`.
 * The private subtree is only ever read by the explicit unblind/report paths.
 */
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";
import {
  BlindReviewMapping,
  BlindReviewSet,
  HumanReviewRecord,
  PairwiseHumanReview,
} from "./schema.js";

export function blindReviewBaseDir(): string {
  return join(process.cwd(), "benchmark", "artifacts", "blind-review");
}

export function setDir(reviewSetId: string): string {
  return join(blindReviewBaseDir(), reviewSetId);
}

export async function loadReviewSet(reviewSetId: string): Promise<BlindReviewSet> {
  const path = join(setDir(reviewSetId), "public", "review-set.json");
  return JSON.parse(await readFile(path, "utf-8")) as BlindReviewSet;
}

export async function loadMapping(reviewSetId: string): Promise<BlindReviewMapping> {
  const path = join(setDir(reviewSetId), "private", "mapping.json");
  return JSON.parse(await readFile(path, "utf-8")) as BlindReviewMapping;
}

export async function loadReviews(reviewSetId: string): Promise<HumanReviewRecord[]> {
  const dir = join(setDir(reviewSetId), "reviews");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const reviews: HumanReviewRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".json") && !f.startsWith("pairwise"))) {
    const parsed = JSON.parse(await readFile(join(dir, file), "utf-8"));
    if (Array.isArray(parsed)) reviews.push(...parsed);
    else reviews.push(parsed);
  }
  return reviews;
}

export async function loadPairwiseReviews(reviewSetId: string): Promise<PairwiseHumanReview[]> {
  const dir = join(setDir(reviewSetId), "reviews");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const reviews: PairwiseHumanReview[] = [];
  for (const file of files.filter((f) => f.startsWith("pairwise") && f.endsWith(".json"))) {
    const parsed = JSON.parse(await readFile(join(dir, file), "utf-8"));
    if (Array.isArray(parsed)) reviews.push(...parsed);
    else reviews.push(parsed);
  }
  return reviews;
}

export async function saveReviews(
  reviewSetId: string,
  records: HumanReviewRecord[],
): Promise<string> {
  const dir = join(setDir(reviewSetId), "reviews");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "imported.json");
  await writeFile(path, JSON.stringify(records, null, 2), "utf-8");
  return path;
}
