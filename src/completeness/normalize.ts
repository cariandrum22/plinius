/**
 * Response completeness — reasoning / final-answer separation.
 *
 * Providers deliver a model's chain of thought in three different shapes: a
 * dedicated `reasoning` (or `reasoning_content`) field, a structured
 * `reasoning_details` array, or inline `<think>…</think>` markup embedded in the
 * message content. All three are recognised here and lifted into their own
 * field, so reasoning is never mistaken for — or silently substituted for — the
 * final answer.
 *
 * The final answer is whatever remains once reasoning has been removed. It is
 * NOT trimmed into existence: if nothing but whitespace remains, that is an
 * empty final answer and the run is a failure, regardless of the provider's
 * finish reason.
 */

/** Where the final answer text was recovered from. */
export type FinalAnswerSource = "message_content" | "content_after_think_strip" | "none";

/** Where reasoning text was recovered from, when present. */
export type ReasoningSource =
  "reasoning_field" | "reasoning_content_field" | "reasoning_details" | "think_tags" | "none";

export interface NormalizedCompletion {
  /** Chain of thought, verbatim. Null when the provider emitted none. */
  reasoningText: string | null;
  reasoningSource: ReasoningSource;
  /** The answer proper, with any reasoning removed. Never null — may be "". */
  finalAnswer: string;
  finalAnswerSource: FinalAnswerSource;
  /** True when the final answer is empty or whitespace only. */
  finalAnswerIsEmpty: boolean;
  /** True when reasoning exists but the final answer is empty. */
  reasoningOnly: boolean;
  /** Set when the payload could not be interpreted. Never thrown. */
  normalizerError: string | null;
}

const THINK_BLOCK = /<think>([\s\S]*?)<\/think>/gi;
/** An unterminated <think> — the generation was cut off mid-reasoning. */
const OPEN_THINK = /<think>([\s\S]*)$/i;
/**
 * A closing tag with no opener. Several chat templates (Qwen3 among them)
 * pre-fill the opening `<think>` into the prompt, so the model only ever emits
 * the closer: everything before it is reasoning, everything after is the answer.
 * Without this case the whole chain of thought would be read as the final
 * answer — exactly the substitution this module exists to prevent.
 */
const ORPHAN_CLOSE_THINK = /^([\s\S]*?)<\/think>([\s\S]*)$/i;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Pull the first choice's message object out of an OpenAI-shaped payload. */
function firstMessage(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const choices = (raw as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  if (!choice || typeof choice !== "object") return null;
  const message = (choice as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  return message as Record<string, unknown>;
}

/** Concatenate the text of a `reasoning_details` array, when present. */
function reasoningFromDetails(message: Record<string, unknown>): string | null {
  const details = message.reasoning_details ?? message.reasoningDetails;
  if (!Array.isArray(details) || details.length === 0) return null;
  const parts: string[] = [];
  for (const d of details) {
    if (!d || typeof d !== "object") continue;
    const rec = d as Record<string, unknown>;
    const t = asString(rec.text) ?? asString(rec.summary) ?? asString(rec.content);
    if (t) parts.push(t);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

export interface NormalizeInput {
  /** The provider's raw response payload, unmodified. */
  rawResponse: unknown;
  /** The message content the transport layer already extracted, if any. */
  text: string | null | undefined;
}

/**
 * Split one provider response into reasoning and final answer.
 *
 * Never throws: an uninterpretable payload yields an empty final answer and a
 * populated `normalizerError`, which callers must treat as a failure.
 */
export function normalizeCompletion(input: NormalizeInput): NormalizedCompletion {
  const base: NormalizedCompletion = {
    reasoningText: null,
    reasoningSource: "none",
    finalAnswer: "",
    finalAnswerSource: "none",
    finalAnswerIsEmpty: true,
    reasoningOnly: false,
    normalizerError: null,
  };

  let message: Record<string, unknown> | null = null;
  try {
    message = firstMessage(input.rawResponse);
  } catch (error) {
    return {
      ...base,
      normalizerError: `failed to read provider payload: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 1. Reasoning carried in its own field always wins — it is unambiguous.
  let reasoning: string | null = null;
  let reasoningSource: ReasoningSource = "none";
  if (message) {
    const r = asString(message.reasoning);
    const rc = asString(message.reasoning_content) ?? asString(message.reasoningContent);
    const rd = reasoningFromDetails(message);
    if (r !== null) {
      reasoning = r;
      reasoningSource = "reasoning_field";
    } else if (rc !== null) {
      reasoning = rc;
      reasoningSource = "reasoning_content_field";
    } else if (rd !== null) {
      reasoning = rd;
      reasoningSource = "reasoning_details";
    }
  }

  // 2. Content: prefer the transport-extracted text, else the raw message.
  let content = input.text;
  if (typeof content !== "string" && message) {
    const c = message.content;
    content = typeof c === "string" ? c : null;
  }
  if (typeof content !== "string") {
    // No usable content at all. Reasoning may still be present.
    return {
      ...base,
      reasoningText: reasoning,
      reasoningSource,
      reasoningOnly: reasoning !== null,
      normalizerError: message === null ? "provider payload carried no readable message" : null,
    };
  }

  // 3. Inline <think> markup, used by several open-weight models.
  let finalAnswer = content;
  let finalAnswerSource: FinalAnswerSource = "message_content";
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  THINK_BLOCK.lastIndex = 0;
  while ((match = THINK_BLOCK.exec(content)) !== null) blocks.push(match[1]);
  if (blocks.length > 0) {
    finalAnswer = content.replace(THINK_BLOCK, "");
    finalAnswerSource = "content_after_think_strip";
    if (reasoning === null) {
      reasoning = blocks.join("\n");
      reasoningSource = "think_tags";
    }
  } else if (ORPHAN_CLOSE_THINK.test(content)) {
    // A closer with no opener: the template supplied the opening tag.
    const m = ORPHAN_CLOSE_THINK.exec(content)!;
    finalAnswer = m[2];
    finalAnswerSource = "content_after_think_strip";
    if (reasoning === null) {
      reasoning = m[1];
      reasoningSource = "think_tags";
    }
  } else {
    // An unterminated <think> means the whole content is reasoning.
    const open = OPEN_THINK.exec(content);
    if (open) {
      finalAnswer = content.slice(0, open.index);
      finalAnswerSource = "content_after_think_strip";
      if (reasoning === null) {
        reasoning = open[1];
        reasoningSource = "think_tags";
      }
    }
  }

  const isEmpty = finalAnswer.trim().length === 0;
  return {
    reasoningText: reasoning,
    reasoningSource,
    finalAnswer,
    finalAnswerSource: isEmpty ? "none" : finalAnswerSource,
    finalAnswerIsEmpty: isEmpty,
    reasoningOnly: isEmpty && reasoning !== null && reasoning.trim().length > 0,
    normalizerError: null,
  };
}
