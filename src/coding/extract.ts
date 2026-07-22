/**
 * Extraction of generated multi-file artifacts from model output.
 *
 * Parsing is pure (no filesystem access). Two input shapes are supported:
 *
 *   1. A fenced ```json block holding `{ "files": [{ "path", "content" }] }`.
 *   2. Labeled fenced code blocks, where the path comes from the info string
 *      (```ts path=src/a.ts) or a preceding `File: src/a.ts` marker line.
 *
 * Every candidate path is validated against traversal, absolute paths,
 * Windows/UNC paths, NUL bytes, and collisions before it is ever written.
 */
export interface ExtractedFile {
  path: string;
  content: string;
}

export interface RejectedFile {
  path: string;
  reason: string;
}

export interface ExtractionLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxFiles: 50,
  maxFileBytes: 1 * 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
};

export interface ExtractionResult {
  files: ExtractedFile[];
  rejected: RejectedFile[];
  totalBytes: number;
  truncated: boolean;
}

/**
 * Validate a candidate relative path. Returns an error string, or null if the
 * path is safe to write within an isolated workspace.
 */
export function validateRelPath(raw: string): string | null {
  if (!raw || raw.trim() === "") return "empty path";
  if (raw.includes("\0")) return "path contains NUL byte";
  if (raw.includes("\\")) return "backslash / Windows path separators not allowed";
  if (/^[a-zA-Z]:/.test(raw)) return "drive-letter (Windows) paths not allowed";
  if (raw.startsWith("/")) return "absolute paths not allowed";
  if (raw.startsWith("~")) return "home-relative (~) paths not allowed";
  if (raw.startsWith("//")) return "UNC paths not allowed";

  const segments = raw.split("/");
  for (const segment of segments) {
    if (segment === "..") return "path traversal (..) not allowed";
    if (segment === ".") return "single-dot segments not allowed";
    if (segment.trim() === "" && segment.length > 0) return "whitespace-only segment";
  }
  if (segments.some((s) => s === "")) {
    // Allow a single trailing slash? No — reject empty segments (e.g. "a//b").
    return "empty path segment";
  }
  return null;
}

function pushFile(
  file: ExtractedFile,
  seen: Set<string>,
  limits: ExtractionLimits,
  state: { total: number },
  out: ExtractedFile[],
  rejected: RejectedFile[],
): boolean {
  const err = validateRelPath(file.path);
  if (err) {
    rejected.push({ path: file.path, reason: err });
    return true;
  }
  if (seen.has(file.path)) {
    rejected.push({ path: file.path, reason: "duplicate path (collision)" });
    return true;
  }
  const bytes = Buffer.byteLength(file.content, "utf-8");
  if (bytes > limits.maxFileBytes) {
    rejected.push({ path: file.path, reason: `file exceeds ${limits.maxFileBytes} bytes` });
    return true;
  }
  if (out.length >= limits.maxFiles) {
    rejected.push({ path: file.path, reason: `exceeds max file count ${limits.maxFiles}` });
    return false; // stop
  }
  if (state.total + bytes > limits.maxTotalBytes) {
    rejected.push({ path: file.path, reason: `exceeds total size budget ${limits.maxTotalBytes}` });
    return false; // stop
  }
  seen.add(file.path);
  state.total += bytes;
  out.push(file);
  return true;
}

/** Try to parse a `{ files: [...] }` JSON envelope from a fenced json block. */
function parseJsonEnvelope(text: string): ExtractedFile[] | null {
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const candidates = fence ? [fence[1]] : [];
  candidates.push(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && Array.isArray(parsed.files)) {
        const files = parsed.files
          .filter(
            (f: unknown): f is ExtractedFile =>
              !!f &&
              typeof (f as ExtractedFile).path === "string" &&
              typeof (f as ExtractedFile).content === "string",
          )
          .map((f: ExtractedFile) => ({ path: f.path, content: f.content }));
        if (files.length > 0) return files;
      }
    } catch {
      // not this candidate
    }
  }
  return null;
}

/** Parse labeled fenced code blocks into files. */
function parseLabeledBlocks(text: string): ExtractedFile[] {
  const files: ExtractedFile[] = [];
  const lines = text.split("\n");
  let pendingPath: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // A `File:` / `Filename:` marker line captures the path for the next block.
    const marker = line.match(/^\s*(?:#+\s*)?(?:\*\*)?\s*(?:File|Filename|Path)\s*:\s*`?([^`*]+?)`?\s*(?:\*\*)?\s*$/i);
    if (marker) {
      pendingPath = marker[1].trim();
      continue;
    }

    const fenceOpen = line.match(/^\s*```(.*)$/);
    if (!fenceOpen) continue;

    // Determine the path: info-string token wins, else the pending marker.
    const info = fenceOpen[1].trim();
    let path: string | null = null;
    const infoPath = info.match(/(?:path|file|title)\s*=\s*"?([^"\s]+)"?/i);
    if (infoPath) {
      path = infoPath[1];
    } else if (/^[\w./-]+\.[\w]+$/.test(info)) {
      // Bare "src/a.ts" as the info string.
      path = info;
    } else if (pendingPath) {
      path = pendingPath;
    }

    // Collect until the closing fence.
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^\s*```\s*$/.test(lines[j])) break;
      body.push(lines[j]);
    }
    if (path) {
      files.push({ path, content: body.join("\n") });
    }
    pendingPath = null;
    i = j; // continue after the closing fence
  }
  return files;
}

/**
 * Extract and validate files from model output. Never touches the filesystem.
 */
export function extractFiles(
  text: string,
  limits: ExtractionLimits = DEFAULT_EXTRACTION_LIMITS,
): ExtractionResult {
  const raw = parseJsonEnvelope(text) ?? parseLabeledBlocks(text);

  const out: ExtractedFile[] = [];
  const rejected: RejectedFile[] = [];
  const seen = new Set<string>();
  const state = { total: 0 };
  let truncated = false;

  for (const file of raw) {
    const keepGoing = pushFile(file, seen, limits, state, out, rejected);
    if (!keepGoing) {
      truncated = true;
      break;
    }
  }

  return { files: out, rejected, totalBytes: state.total, truncated };
}
