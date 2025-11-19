import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { EvaluationProgress, EvaluationResult } from "../types/evaluation.js";
import { BenchmarkId } from "../types/benchmark.js";

/**
 * Get evaluation output directory
 */
export function getEvaluationDir(): string {
  return join(process.cwd(), "artifacts", "evaluation");
}

/**
 * Get evaluation progress file path
 */
export function getProgressPath(): string {
  return join(getEvaluationDir(), "progress.json");
}

/**
 * Load evaluation progress
 */
export async function loadEvaluationProgress(): Promise<EvaluationProgress> {
  const progressPath = getProgressPath();
  try {
    const content = await readFile(progressPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return { completed: [], failed: [], lastUpdate: new Date().toISOString() };
  }
}

/**
 * Save evaluation progress
 */
export async function saveEvaluationProgress(
  progress: EvaluationProgress
): Promise<void> {
  await mkdir(getEvaluationDir(), { recursive: true });
  progress.lastUpdate = new Date().toISOString();
  await writeFile(
    getProgressPath(),
    JSON.stringify(progress, null, 2),
    "utf-8"
  );
}

/**
 * Check if evaluation task is already completed by a specific evaluator
 */
export async function isEvaluationCompleted(
  benchmarkId: BenchmarkId,
  model: string,
  evaluatedBy?: string // Optional: check for specific evaluator
): Promise<boolean> {
  const evaluationDir = getEvaluationDir();
  try {
    const files = await readdir(evaluationDir);
    const sanitizedModel = sanitizeModelName(model);

    if (evaluatedBy) {
      // Check for evaluator-specific file
      const sanitizedEvaluator = sanitizeModelName(evaluatedBy);
      const prefix = `${benchmarkId}_${sanitizedModel}_evaluation_${sanitizedEvaluator}_`;
      return files.some((file) => file.includes(prefix));
    } else {
      // Check for any evaluation file (backward compatibility)
      const prefix = `${benchmarkId}_${sanitizedModel}_evaluation`;
      return files.some((file) => file.startsWith(prefix));
    }
  } catch {
    return false;
  }
}

/**
 * Generate safe filename from model name
 */
export function sanitizeModelName(model: string): string {
  return model.replace(/\//g, "_").replace(/:/g, "-");
}

/**
 * Save evaluation result as JSON with evaluator-specific naming
 */
export async function saveEvaluationResult(
  result: EvaluationResult
): Promise<string> {
  const evaluationDir = getEvaluationDir();
  await mkdir(evaluationDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const modelName = sanitizeModelName(result.model);
  const evaluatorName = sanitizeModelName(result.evaluatedBy);
  const filename = `${result.benchmarkId}_${modelName}_evaluation_${evaluatorName}_${timestamp}.json`;
  const filepath = join(evaluationDir, filename);

  const content = {
    benchmarkId: result.benchmarkId,
    model: result.model,
    evaluatedBy: result.evaluatedBy,
    timestamp: result.timestamp.toISOString(),
    scores: result.scores,
    totalScore: result.totalScore,
    commentary: result.commentary,
    metadata: result.metadata,
  };

  await writeFile(filepath, JSON.stringify(content, null, 2), "utf-8");
  console.log(`Saved evaluation to: ${filename}`);

  return filename;
}

/**
 * Save evaluation summary markdown
 */
export async function saveEvaluationSummary(
  results: EvaluationResult[]
): Promise<void> {
  const evaluationDir = getEvaluationDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filepath = join(evaluationDir, `summary_${timestamp}.md`);

  // Group by model
  const byModel = new Map<string, EvaluationResult[]>();
  for (const result of results) {
    const existing = byModel.get(result.model) || [];
    existing.push(result);
    byModel.set(result.model, existing);
  }

  // Calculate averages
  let content = `# Evaluation Summary\n\n`;
  content += `**Generated:** ${new Date().toISOString()}\n`;
  content += `**Evaluator:** ${results[0]?.evaluatedBy || "N/A"}\n`;
  content += `**Total Evaluations:** ${results.length}\n\n`;

  content += `---\n\n## Overall Statistics\n\n`;

  for (const [model, modelResults] of byModel) {
    const avgTotal =
      modelResults.reduce((sum, r) => sum + r.totalScore, 0) /
      modelResults.length;
    const avgStructure =
      modelResults.reduce((sum, r) => sum + r.scores.structure, 0) /
      modelResults.length;
    const avgDepth =
      modelResults.reduce((sum, r) => sum + r.scores.depth, 0) /
      modelResults.length;
    const avgConsistency =
      modelResults.reduce((sum, r) => sum + r.scores.consistency, 0) /
      modelResults.length;
    const avgCreativity =
      modelResults.reduce((sum, r) => sum + r.scores.creativity, 0) /
      modelResults.length;
    const avgDomain =
      modelResults.reduce((sum, r) => sum + r.scores.domainCorrectness, 0) /
      modelResults.length;

    content += `### ${model}\n\n`;
    content += `- **Evaluations:** ${modelResults.length}\n`;
    content += `- **Average Total Score:** ${avgTotal.toFixed(2)}/25\n`;
    content += `- **Average Structure:** ${avgStructure.toFixed(2)}/5\n`;
    content += `- **Average Depth:** ${avgDepth.toFixed(2)}/5\n`;
    content += `- **Average Consistency:** ${avgConsistency.toFixed(2)}/5\n`;
    content += `- **Average Creativity:** ${avgCreativity.toFixed(2)}/5\n`;
    content += `- **Average Domain Correctness:** ${avgDomain.toFixed(2)}/5\n\n`;
  }

  content += `---\n\n## Detailed Results\n\n`;

  // Sort by benchmark ID
  const sortedResults = [...results].sort((a, b) => {
    if (a.benchmarkId !== b.benchmarkId) {
      return a.benchmarkId.localeCompare(b.benchmarkId);
    }
    return a.model.localeCompare(b.model);
  });

  for (const result of sortedResults) {
    content += `### ${result.benchmarkId} - ${result.model}\n\n`;
    content += `**Total Score:** ${result.totalScore}/25\n\n`;
    content += `**Scores:**\n`;
    content += `- Structure: ${result.scores.structure}/5\n`;
    content += `- Depth: ${result.scores.depth}/5\n`;
    content += `- Consistency: ${result.scores.consistency}/5\n`;
    content += `- Creativity: ${result.scores.creativity}/5\n`;
    content += `- Domain Correctness: ${result.scores.domainCorrectness}/5\n\n`;
    content += `**Commentary:**\n\n${result.commentary}\n\n`;
    content += `---\n\n`;
  }

  await writeFile(filepath, content, "utf-8");
  console.log(`\nSaved evaluation summary to: summary_${timestamp}.md`);
}
