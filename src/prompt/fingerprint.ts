/**
 * Prompt fingerprints: independent SHA-256 hashes of the system, user, and
 * rendered prompt text, so a single-character change is detectable.
 */
import { createHash } from "crypto";

export interface PromptFingerprint {
  systemHash: string;
  userHash: string;
  renderedHash: string;
}

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf-8").digest("hex")}`;
}

export function computeFingerprint(input: {
  systemPrompt: string;
  userPrompt: string;
  renderedPrompt: string;
}): PromptFingerprint {
  return {
    systemHash: sha256(input.systemPrompt),
    userHash: sha256(input.userPrompt),
    renderedHash: sha256(input.renderedPrompt),
  };
}

/** Expand `{{variable}}` placeholders. Missing variables are left intact. */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match,
  );
}
