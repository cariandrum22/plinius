/**
 * Placeholder registry of candidate local model families for Phase 1.
 *
 * These are *configuration placeholders only*. Plinius does not download,
 * deploy, or assume the availability of any of these models — model deployment
 * is owned by AI-Playground. Each entry documents the logical model identity
 * and a suggested served-model name so a deployment can be wired into a target
 * later without guessing identities.
 */
export type ModelKind = "reasoning" | "coder" | "general" | "smoke-test";

export interface ModelPlaceholder {
  /** Stable, filesystem-friendly key. */
  id: string;
  family: string;
  kind: ModelKind;
  /** Logical model identity (HF repo or vendor id), when known. */
  logicalModel: string;
  /** Suggested vLLM --served-model-name; deployment may override. */
  suggestedServedName: string;
  notes: string;
}

/** Deployment of all of these remains AI-Playground's responsibility. */
export const MODEL_PLACEHOLDERS: ModelPlaceholder[] = [
  {
    id: "deepseek-r1-distill-qwen-7b",
    family: "DeepSeek-R1 distill",
    kind: "reasoning",
    logicalModel: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
    suggestedServedName: "deepseek-r1-distill-qwen-7b",
    notes: "Reasoning distill; verify exact revision at deployment time.",
  },
  {
    id: "deepseek-r1-distill-llama-8b",
    family: "DeepSeek-R1 distill",
    kind: "reasoning",
    logicalModel: "deepseek-ai/DeepSeek-R1-Distill-Llama-8B",
    suggestedServedName: "deepseek-r1-distill-llama-8b",
    notes: "Alternate distill base.",
  },
  {
    id: "qwen-reasoning",
    family: "Qwen",
    kind: "reasoning",
    logicalModel: "Qwen/QwQ-32B",
    suggestedServedName: "qwen-reasoning",
    notes: "Qwen reasoning line; pin exact variant/revision at deployment.",
  },
  {
    id: "qwen-coder",
    family: "Qwen",
    kind: "coder",
    logicalModel: "Qwen/Qwen2.5-Coder-32B-Instruct",
    suggestedServedName: "qwen-coder",
    notes: "Coding-specialized Qwen variant.",
  },
  {
    id: "glm",
    family: "GLM",
    kind: "general",
    logicalModel: "THUDM/glm-4",
    suggestedServedName: "glm",
    notes: "GLM family; confirm served variant with AI-Playground.",
  },
  {
    id: "kimi",
    family: "Kimi",
    kind: "reasoning",
    logicalModel: "moonshotai/Kimi-K2",
    suggestedServedName: "kimi",
    notes: "Kimi family; large — deployment feasibility owned by AI-Playground.",
  },
  {
    id: "llama",
    family: "Llama",
    kind: "general",
    logicalModel: "meta-llama/Llama-3.1-8B-Instruct",
    suggestedServedName: "llama",
    notes: "General Llama baseline.",
  },
  {
    id: "qwen-smoke-0_5b",
    family: "Qwen",
    kind: "smoke-test",
    logicalModel: "Qwen/Qwen2.5-0.5B-Instruct",
    suggestedServedName: "Qwen/Qwen2.5-0.5B-Instruct",
    notes: "Tiny smoke-test model for pipeline validation only.",
  },
];

export function findModelPlaceholder(id: string): ModelPlaceholder | undefined {
  return MODEL_PLACEHOLDERS.find((m) => m.id === id);
}
