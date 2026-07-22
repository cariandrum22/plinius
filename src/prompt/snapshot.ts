/**
 * Prompt snapshots.
 *
 * An evaluation is determined by the prompt as well as the model, so the exact
 * prompt is captured immutably. The snapshot id is a content hash (no timestamp)
 * — identical prompt inputs always yield the same id. A separate fingerprint
 * records per-part hashes for change detection.
 */
import { createHash } from "crypto";
import { PromptFingerprint, computeFingerprint, renderTemplate } from "./fingerprint.js";

export const PROMPT_SCHEMA_VERSION = 1;

export interface FewShotExample {
  role: string;
  content: string;
}

export interface PromptSnapshot {
  schemaVersion: number;
  promptId: string;
  systemPrompt: string;
  userPrompt: string;
  fewShot: FewShotExample[];
  rubric: string | null;
  variables: Record<string, string>;
  renderedPrompt: string;
  fingerprint: PromptFingerprint;
}

function canonicalStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function computePromptId(parts: {
  systemPrompt: string;
  userPrompt: string;
  fewShot: FewShotExample[];
  rubric: string | null;
  variables: Record<string, string>;
  renderedPrompt: string;
}): string {
  const digest = createHash("sha256").update(canonicalStringify(parts), "utf-8");
  return `prompt-${digest.digest("hex").slice(0, 16)}`;
}

export interface BuildPromptSnapshotInput {
  systemPrompt?: string;
  userPrompt: string;
  fewShot?: FewShotExample[];
  rubric?: string | null;
  variables?: Record<string, string>;
  /** Optional pre-rendered prompt; otherwise userPrompt is rendered with variables. */
  renderedPrompt?: string;
}

export function buildPromptSnapshot(input: BuildPromptSnapshotInput): PromptSnapshot {
  const systemPrompt = input.systemPrompt ?? "";
  const userPrompt = input.userPrompt;
  const fewShot = input.fewShot ?? [];
  const rubric = input.rubric ?? null;
  const variables = input.variables ?? {};
  const renderedPrompt = input.renderedPrompt ?? renderTemplate(userPrompt, variables);

  const parts = { systemPrompt, userPrompt, fewShot, rubric, variables, renderedPrompt };
  return {
    schemaVersion: PROMPT_SCHEMA_VERSION,
    promptId: computePromptId(parts),
    ...parts,
    fingerprint: computeFingerprint({ systemPrompt, userPrompt, renderedPrompt }),
  };
}
