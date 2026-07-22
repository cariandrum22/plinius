/**
 * LLM-judge layer, fully decoupled from generation and deterministic checks.
 *
 * A judge takes a *stored* candidate output plus the benchmark rubric and
 * produces a {@link JudgeEvaluation}. Because it only needs the persisted text,
 * judges can be (re-)applied to already saved run records without re-running
 * the model under test. Judges are the lowest authority and can never override
 * an executable failure.
 */
import { InferenceBackend } from "../types/inference.js";
import { Rubric } from "../suite/schema.js";
import { extractJson } from "../evaluators/json-schema-validate.js";

export interface JudgeDimensionScore {
  id: string;
  score: number;
  rationale?: string;
}

export interface JudgeEvaluation {
  judgeId: string;
  judgeType: "scalar" | "pairwise";
  authority: "scalar_judge" | "pairwise_judge";
  version: string;
  rubricScaleMin: number;
  rubricScaleMax: number;
  dimensions: JudgeDimensionScore[];
  /** Weighted mean on the rubric's own scale. */
  overall: number;
  /** Weighted mean normalized to [0, 1]. */
  normalizedScore: number;
  /** The judge (or a heuristic) detected a refusal / non-answer. */
  refusal: boolean;
  /** Output parsed as the expected judge format. */
  formatValid: boolean;
  commentary: string;
  timestamp: string;
  error?: string;
}

const JUDGE_VERSION = "1.0.0";

const REFUSAL_PATTERNS = [
  /\bI\s+can(?:'|no)?t\s+(?:help|assist|comply|do that)\b/i,
  /\bI\s+(?:am|'m)\s+(?:unable|not able)\s+to\b/i,
  /\bI\s+(?:will|must)\s+not\b/i,
  /\bas an ai\b/i,
];

/** Heuristic refusal / empty-answer detection independent of the judge model. */
export function looksLikeRefusal(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed.length < 20) return true;
  return REFUSAL_PATTERNS.some((p) => p.test(trimmed));
}

export interface JudgeInput {
  taskText: string;
  expectedOutputFormat: string;
  candidateOutput: string;
  rubric: Rubric;
}

/** Common judge interface (scalar today; pairwise judges implement this too). */
export interface Judge {
  readonly id: string;
  evaluate(input: JudgeInput): Promise<JudgeEvaluation>;
}

function buildJudgePrompt(input: JudgeInput): string {
  const dims = input.rubric.dimensions
    .map((d) => `- ${d.id} (weight ${d.weight}): ${d.description}`)
    .join("\n");
  return [
    "You are an expert evaluator. Score the CANDIDATE answer against the rubric.",
    `Scoring scale: integers from ${input.rubric.scaleMin} to ${input.rubric.scaleMax}.`,
    input.rubric.guidance ? `Guidance: ${input.rubric.guidance}` : "",
    "",
    "Rubric dimensions:",
    dims || "- overall quality",
    "",
    "Respond with ONLY a JSON object of the form:",
    '{"dimensions":[{"id":"<dim>","score":<n>,"rationale":"<short>"}],"refusal":false,"commentary":"<short>"}',
    "",
    "=== TASK ===",
    input.taskText,
    "",
    "=== EXPECTED OUTPUT FORMAT ===",
    input.expectedOutputFormat || "(unspecified)",
    "",
    "=== CANDIDATE ANSWER ===",
    input.candidateOutput,
  ].join("\n");
}

interface ParsedJudge {
  dimensions: JudgeDimensionScore[];
  refusal: boolean;
  commentary: string;
}

function parseJudgeOutput(text: string): ParsedJudge | null {
  const extracted = extractJson(text);
  if (extracted.error || !extracted.value || typeof extracted.value !== "object") {
    return null;
  }
  const obj = extracted.value as Record<string, unknown>;
  if (!Array.isArray(obj.dimensions)) return null;
  const dimensions: JudgeDimensionScore[] = obj.dimensions
    .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
    .map((d) => ({
      id: String(d.id ?? "unknown"),
      score: Number(d.score ?? 0),
      rationale: d.rationale ? String(d.rationale) : undefined,
    }));
  return {
    dimensions,
    refusal: Boolean(obj.refusal),
    commentary: obj.commentary ? String(obj.commentary) : "",
  };
}

function weightedOverall(
  dims: JudgeDimensionScore[],
  rubric: Rubric,
): number {
  if (dims.length === 0) return rubric.scaleMin;
  const weightOf = (id: string) =>
    rubric.dimensions.find((d) => d.id === id)?.weight ?? 1;
  const totalWeight = dims.reduce((s, d) => s + weightOf(d.id), 0);
  if (totalWeight === 0) return rubric.scaleMin;
  return dims.reduce((s, d) => s + d.score * weightOf(d.id), 0) / totalWeight;
}

/**
 * A scalar LLM judge backed by an inference backend (dependency-injected, so it
 * is trivially mockable in tests).
 */
export class ScalarJudge implements Judge {
  readonly authority = "scalar_judge" as const;
  readonly version = JUDGE_VERSION;

  constructor(
    private readonly backend: InferenceBackend,
    private readonly options: { maxTokens?: number; temperature?: number } = {},
  ) {}

  get id(): string {
    return `scalar_judge:${this.backend.id}`;
  }

  async evaluate(input: JudgeInput): Promise<JudgeEvaluation> {
    const { rubric } = input;
    const scaleSpan = Math.max(1, rubric.scaleMax - rubric.scaleMin);
    const heuristicRefusal = looksLikeRefusal(input.candidateOutput);

    const base = {
      judgeId: this.id,
      judgeType: "scalar" as const,
      authority: this.authority,
      version: this.version,
      rubricScaleMin: rubric.scaleMin,
      rubricScaleMax: rubric.scaleMax,
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await this.backend.complete({
        model: this.backend.id,
        messages: [{ role: "user", content: buildJudgePrompt(input) }],
        sampling: {
          maxTokens: this.options.maxTokens ?? 1024,
          temperature: this.options.temperature ?? 0,
        },
      });
      const parsed = parseJudgeOutput(response.text);
      if (!parsed) {
        return {
          ...base,
          dimensions: [],
          overall: rubric.scaleMin,
          normalizedScore: 0,
          refusal: heuristicRefusal,
          formatValid: false,
          commentary: "judge output was not valid JSON",
        };
      }
      const overall = weightedOverall(parsed.dimensions, rubric);
      return {
        ...base,
        dimensions: parsed.dimensions,
        overall,
        normalizedScore: (overall - rubric.scaleMin) / scaleSpan,
        refusal: parsed.refusal || heuristicRefusal,
        formatValid: true,
        commentary: parsed.commentary,
      };
    } catch (error) {
      return {
        ...base,
        dimensions: [],
        overall: rubric.scaleMin,
        normalizedScore: 0,
        refusal: heuristicRefusal,
        formatValid: false,
        commentary: "judge invocation failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
