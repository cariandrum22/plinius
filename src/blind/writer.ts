/**
 * Persist a generated blind-review set to disk.
 *
 * Layout (public/ is reviewer-facing, private/ must never be shared):
 *
 *   <baseDir>/<review-set-id>/
 *     public/
 *       review-set.json
 *       review-guide.ja.md
 *       scoring-sheet.json
 *       items/<blindId>.md
 *       pairwise/ (optional)
 *     private/
 *       mapping.json
 *       generation-manifest.json
 */
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { GenerateOutput } from "./generator.js";
import {
  renderItemMarkdownJa,
  renderPairwiseGuideJa,
  renderPairwiseItemMarkdownJa,
  renderReviewGuideJa,
  renderScoringSheet,
} from "./render.js";

export function reviewSetDir(baseDir: string, reviewSetId: string): string {
  return join(baseDir, reviewSetId);
}

export async function writeBlindReviewSet(
  baseDir: string,
  output: GenerateOutput,
): Promise<{ dir: string; publicDir: string; privateDir: string }> {
  const dir = reviewSetDir(baseDir, output.set.reviewSetId);
  const publicDir = join(dir, "public");
  const privateDir = join(dir, "private");
  const itemsDir = join(publicDir, "items");
  await mkdir(itemsDir, { recursive: true });
  await mkdir(privateDir, { recursive: true });

  // Public packet.
  await writeFile(join(publicDir, "review-set.json"), JSON.stringify(output.set, null, 2), "utf-8");
  await writeFile(join(publicDir, "review-guide.ja.md"), renderReviewGuideJa(output.set), "utf-8");
  await writeFile(
    join(publicDir, "scoring-sheet.json"),
    JSON.stringify(renderScoringSheet(output.set), null, 2),
    "utf-8",
  );
  for (const item of output.set.items) {
    await writeFile(join(itemsDir, `${item.blindId}.md`), renderItemMarkdownJa(item), "utf-8");
  }

  // Optional pairwise packet (still public — contains no identity).
  if (output.pairwiseSet) {
    const pwDir = join(publicDir, "pairwise");
    const pwItems = join(pwDir, "items");
    await mkdir(pwItems, { recursive: true });
    await writeFile(
      join(pwDir, "pairwise-set.json"),
      JSON.stringify(output.pairwiseSet, null, 2),
      "utf-8",
    );
    await writeFile(join(pwDir, "pairwise-guide.ja.md"), renderPairwiseGuideJa(output.pairwiseSet), "utf-8");
    for (const item of output.pairwiseSet.items) {
      await writeFile(join(pwItems, `${item.blindId}.md`), renderPairwiseItemMarkdownJa(item), "utf-8");
    }
  }

  // Private artifacts.
  await writeFile(join(privateDir, "mapping.json"), JSON.stringify(output.mapping, null, 2), "utf-8");
  await writeFile(
    join(privateDir, "generation-manifest.json"),
    JSON.stringify(output.manifest, null, 2),
    "utf-8",
  );

  return { dir, publicDir, privateDir };
}
