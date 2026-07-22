/**
 * Public-archive assembly.
 *
 * The reviewer-shareable archive contains ONLY the `public/` subtree. The
 * `private/` subtree (mapping + generation manifest) is never copied, so a
 * mapping can never leak through the default archive.
 */
import { copyFile, mkdir, readdir, stat } from "fs/promises";
import { join, relative } from "path";

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/** List absolute file paths that belong in the public archive. */
export async function listPublicArchiveFiles(setDir: string): Promise<string[]> {
  const publicDir = join(setDir, "public");
  try {
    await stat(publicDir);
  } catch {
    return [];
  }
  return walk(publicDir);
}

/**
 * Copy the public subtree of a review set into `destDir`, preserving the
 * relative layout. The private subtree is excluded by construction.
 */
export async function buildPublicArchive(
  setDir: string,
  destDir: string,
): Promise<string[]> {
  const publicDir = join(setDir, "public");
  const files = await listPublicArchiveFiles(setDir);
  const copied: string[] = [];
  for (const file of files) {
    const rel = relative(publicDir, file);
    const dest = join(destDir, rel);
    await mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
    await copyFile(file, dest);
    copied.push(rel);
  }
  return copied;
}
