/**
 * System prompt profiles.
 *
 * System prompts are external experiment inputs, not baked into the runner.
 * Three built-in profiles are supported initially:
 *
 *   - "none":    no system prompt (only the user message)
 *   - "neutral": a minimal, neutral baseline system prompt
 *   - explicit:  any other profile id registered in `PROMPT_PROFILES`
 *
 * Chain-of-thought instructions are intentionally NOT added automatically.
 */
import { ChatMessage } from "../types/inference.js";

export type PromptProfileId = "none" | "neutral" | (string & {});

export interface PromptProfile {
  id: string;
  description: string;
  /** System prompt text, or null for no system prompt. */
  systemPrompt: string | null;
}

/**
 * Registered prompt profiles. Add entries here to define new named profiles.
 * A neutral baseline is provided; it deliberately avoids task-shaping or
 * chain-of-thought directives.
 */
export const PROMPT_PROFILES: Record<string, PromptProfile> = {
  none: {
    id: "none",
    description: "No system prompt.",
    systemPrompt: null,
  },
  neutral: {
    id: "neutral",
    description: "Minimal neutral baseline system prompt.",
    systemPrompt: "You are a helpful assistant.",
  },
};

export const DEFAULT_PROMPT_PROFILE: PromptProfileId = "none";

/** Resolve a prompt profile by id, throwing on unknown ids. */
export function getPromptProfile(id: PromptProfileId): PromptProfile {
  const profile = PROMPT_PROFILES[id];
  if (!profile) {
    const available = Object.keys(PROMPT_PROFILES).join(", ");
    throw new Error(
      `Unknown prompt profile "${id}". Available profiles: ${available}`,
    );
  }
  return profile;
}

/**
 * Render the exact chat messages for a benchmark run given a prompt profile
 * and the benchmark's user content. The returned array is what is sent to the
 * backend and what must be persisted verbatim with the result.
 */
export function renderMessages(
  profileId: PromptProfileId,
  userContent: string,
): ChatMessage[] {
  const profile = getPromptProfile(profileId);
  const messages: ChatMessage[] = [];
  if (profile.systemPrompt !== null) {
    messages.push({ role: "system", content: profile.systemPrompt });
  }
  messages.push({ role: "user", content: userContent });
  return messages;
}
