/**
 * Deterministic evaluator abstraction and result types.
 *
 * Evaluators sit in an authority hierarchy (executable > structural > rule >
 * judge). Every result records its `version`, `authority`, whether it is
 * `blocking`, and structured `evidence`. Judges are handled separately and can
 * never override an executable failure.
 */
import { Authority } from "../suite/schema.js";
import { ExecutionSandbox } from "./sandbox.js";

/**
 * Outcome of a single deterministic check.
 * - `pass` / `fail`: the check ran and produced a verdict.
 * - `not_available`: the required tool/environment was missing — NOT a failure.
 * - `error`: an infrastructure error prevented a verdict (I/O, spawn, timeout).
 */
export type EvaluationStatus = "pass" | "fail" | "not_available" | "error";

export interface EvaluationEvidence {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  /** Free-form structured detail (matched text, missing sections, ...). */
  [key: string]: unknown;
}

export interface DeterministicEvaluation {
  checkId: string;
  evaluatorId: string;
  /** Evaluator implementation version (part of reproducibility). */
  version: string;
  authority: Authority;
  /** Whether this check gates qualification. */
  blocking: boolean;
  status: EvaluationStatus;
  /** Optional normalized score in [0, 1] when meaningful. */
  score?: number;
  message: string;
  evidence: EvaluationEvidence;
}

export interface EvaluationInput {
  /** The model's raw prose output. */
  outputText: string;
  /**
   * Isolated workspace directory containing extracted files + fixtures, when
   * the benchmark uses generated artifacts. Undefined for prose-only tasks.
   */
  workspaceDir?: string;
  /** Sandbox used for any process execution. */
  sandbox: ExecutionSandbox;
}

export interface DeterministicEvaluator {
  readonly id: string;
  readonly version: string;
  readonly authority: Authority;
  readonly blocking: boolean;
  evaluate(input: EvaluationInput): Promise<DeterministicEvaluation>;
}

/** Truncate captured output so evidence stays a reasonable size. */
export function truncate(text: string, max = 8_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}
