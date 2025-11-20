import { OpenRouter } from "@openrouter/sdk";
import { readdir } from "fs/promises";
import { join } from "path";
import { env, validateEnv } from "./env.js";
import { OpenRouterModels, OpenRouterModel } from "./types/openrouter.js";
import { EvaluationTask, EvaluationResult } from "./types/evaluation.js";
import { parseFilename } from "./evaluation/parser.js";
import { evaluateWithRetry } from "./evaluation/evaluator.js";
import {
  loadEvaluationProgress,
  saveEvaluationProgress,
  isEvaluationCompleted,
  saveEvaluationResult,
  saveEvaluationSummary,
} from "./evaluation/progress.js";

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute tasks in parallel with concurrency limit and staggered timing
 */
async function executeWithConcurrency<T, R>(
  tasks: T[],
  concurrency: number,
  executor: (task: T, index: number) => Promise<R>,
  options: {
    taskStartDelay?: number; // Delay between task starts within a worker
    workerStartDelay?: number; // Delay between worker starts
  } = {}
): Promise<R[]> {
  const results: R[] = [];
  let taskIndex = 0;

  const { taskStartDelay = 0, workerStartDelay = 0 } = options;

  // Create worker pool with staggered start
  const workers = Array(Math.min(concurrency, tasks.length))
    .fill(null)
    .map(async (_, workerIndex) => {
      // Stagger worker starts to avoid simultaneous API hits
      if (workerIndex > 0 && workerStartDelay > 0) {
        await sleep(workerStartDelay * workerIndex);
      }

      while (taskIndex < tasks.length) {
        const index = taskIndex++;
        const task = tasks[index];

        try {
          results[index] = await executor(task, index);

          // Add delay before next task to avoid rate limits
          if (taskIndex < tasks.length && taskStartDelay > 0) {
            await sleep(taskStartDelay);
          }
        } catch (error) {
          console.error(`Task ${index} failed:`, error);
          // Store error result
          results[index] = error as R;

          // On error, wait a bit longer before next attempt
          if (taskIndex < tasks.length) {
            await sleep(Math.max(taskStartDelay * 2, 2000));
          }
        }
      }
    });

  // Wait for all workers to complete
  await Promise.all(workers);

  return results;
}

/**
 * Configuration for evaluation
 */
const EVALUATOR_MODELS: OpenRouterModel[] = [
  OpenRouterModels.GPT_5_1,          // OpenAI GPT-5.1
  OpenRouterModels.CLAUDE_4_5_SONNET, // Anthropic Claude Sonnet 4.5
  OpenRouterModels.GEMINI_2_5_PRO,   // Google Gemini 2.5 Pro
]; // Multiple evaluators for cross-validation
const CONCURRENT_EVALUATIONS = 5; // Number of parallel evaluations
const TASK_START_DELAY_MS = 500; // Delay between task starts (stagger)
const WORKER_START_DELAY_MS = 1000; // Delay between worker starts

/**
 * Discover all benchmark result files
 */
async function discoverBenchmarkResults(): Promise<EvaluationTask[]> {
  const resultDir = join(process.cwd(), "benchmark", "artifacts", "result");
  const files = await readdir(resultDir);

  const tasks: EvaluationTask[] = [];

  for (const file of files) {
    if (!file.endsWith(".md") || file === "progress.json") {
      continue;
    }

    const parsed = parseFilename(file);
    if (!parsed) {
      console.warn(`  ⚠ Skipping invalid filename: ${file}`);
      continue;
    }

    tasks.push({
      benchmarkId: parsed.benchmarkId,
      model: parsed.model,
      resultFilePath: join(resultDir, file),
    });
  }

  return tasks;
}

/**
 * Run evaluation for all benchmark results with multiple evaluators
 */
async function runEvaluation(): Promise<void> {
  console.log(`\n=== Plinius Benchmark Multi-Evaluator Assessment ===\n`);

  // Validate environment
  validateEnv(["OPENROUTER_API_KEY"]);

  // Discover benchmark results
  console.log(`Discovering benchmark result files...`);
  const allTasks = await discoverBenchmarkResults();
  console.log(`Found ${allTasks.length} benchmark results`);

  if (allTasks.length === 0) {
    console.log(`\n⚠ No benchmark results found in benchmark/artifacts/result/`);
    console.log(`Please run the benchmark first: pnpm run dev`);
    return;
  }

  console.log(`\n=== Evaluation Plan ===`);
  console.log(`Evaluator models: ${EVALUATOR_MODELS.length}`);
  for (let i = 0; i < EVALUATOR_MODELS.length; i++) {
    console.log(`  ${i + 1}. ${EVALUATOR_MODELS[i]}`);
  }
  console.log(`Total benchmark results: ${allTasks.length}`);
  console.log(`Total evaluations to perform: ${allTasks.length * EVALUATOR_MODELS.length}`);

  // Initialize OpenRouter client (shared across all evaluators)
  const openRouter = new OpenRouter({
    apiKey: env.OPENROUTER_API_KEY!,
  });

  // Run evaluation for each evaluator model
  for (let evalIdx = 0; evalIdx < EVALUATOR_MODELS.length; evalIdx++) {
    const evaluatorModel = EVALUATOR_MODELS[evalIdx];

    console.log(`\n\n${"=".repeat(80)}`);
    console.log(`EVALUATOR ${evalIdx + 1}/${EVALUATOR_MODELS.length}: ${evaluatorModel}`);
    console.log(`${"=".repeat(80)}\n`);

    await runSingleEvaluatorPass(openRouter, evaluatorModel, allTasks);
  }

  console.log(`\n\n${"=".repeat(80)}`);
  console.log(`ALL EVALUATIONS COMPLETE`);
  console.log(`${"=".repeat(80)}\n`);
  console.log(`✅ All ${EVALUATOR_MODELS.length} evaluators have completed their assessments`);
  console.log(`Results saved to benchmark/artifacts/evaluation/`);
}

/**
 * Run evaluation pass for a single evaluator model
 */
async function runSingleEvaluatorPass(
  openRouter: OpenRouter,
  evaluatorModel: OpenRouterModel,
  allTasks: EvaluationTask[]
): Promise<void> {
  // Load progress
  const progress = await loadEvaluationProgress();

  // Filter out already completed evaluations for this specific evaluator
  const pendingTasks = [];
  const skippedTasks = [];

  for (const task of allTasks) {
    const completed = await isEvaluationCompleted(
      task.benchmarkId,
      task.model,
      evaluatorModel // Now checking by specific evaluator
    );
    if (completed) {
      skippedTasks.push(task);
    } else {
      pendingTasks.push(task);
    }
  }

  console.log(`Already evaluated by ${evaluatorModel}: ${skippedTasks.length}`);
  console.log(`Pending evaluations: ${pendingTasks.length}`);

  if (skippedTasks.length > 0) {
    console.log(`\n⏭ Skipping ${skippedTasks.length} completed evaluations`);
  }

  if (pendingTasks.length === 0) {
    console.log(`\n✅ All evaluations for ${evaluatorModel} already completed!`);
    return;
  }

  // Estimate cost (rough)
  const estimatedTokensPerEval = 3000; // Prompt + response from evaluator
  const totalTokens = pendingTasks.length * estimatedTokensPerEval;
  const estimatedCost = (totalTokens / 1_000_000) * 3.0; // Rough $3/M tokens

  console.log(`\n=== Cost Estimation for ${evaluatorModel} ===`);
  console.log(
    `Estimated total tokens: ${totalTokens.toLocaleString()} (~${estimatedTokensPerEval.toLocaleString()} per evaluation)`
  );
  console.log(`Estimated cost: $${estimatedCost.toFixed(2)}`);
  console.log(
    `Estimated cost per evaluation: $${(estimatedCost / pendingTasks.length).toFixed(4)}`
  );

  console.log(
    `\n=== Starting Evaluation with ${evaluatorModel} (${CONCURRENT_EVALUATIONS} parallel) ===\n`
  );

  // Execute pending evaluations in parallel
  let completed = 0;
  let failed = 0;
  const completedResults: EvaluationResult[] = [];

  await executeWithConcurrency(
    pendingTasks,
    CONCURRENT_EVALUATIONS,
    async (task, index) => {
      const overallIndex = skippedTasks.length + index + 1;

      console.log(
        `[${overallIndex}/${allTasks.length}] Evaluating: ${task.benchmarkId} - ${task.model} [Evaluator: ${evaluatorModel}]`
      );

      const result = await evaluateWithRetry(openRouter, evaluatorModel, task);

      if (result.success && result.result) {
        completed++;
        completedResults.push(result.result);

        // Save evaluation result with evaluator-specific naming
        const filename = await saveEvaluationResult(result.result);

        // Update progress with evaluator information
        progress.completed.push({
          benchmarkId: task.benchmarkId,
          model: task.model,
          evaluatedBy: evaluatorModel,
          evaluationFile: filename,
        });

        console.log(
          `✓ Completed: ${task.benchmarkId} - ${task.model} (Score: ${result.result.totalScore}/25) [${evaluatorModel}]\n`
        );
      } else {
        failed++;
        progress.failed.push({
          benchmarkId: task.benchmarkId,
          model: task.model,
          evaluatedBy: evaluatorModel,
          error: result.error || "Unknown error",
        });
        console.log(`✗ Failed: ${task.benchmarkId} - ${task.model} [${evaluatorModel}]\n`);
      }

      // Save progress periodically (every 5 completions to reduce file I/O)
      if ((completed + failed) % 5 === 0) {
        await saveEvaluationProgress(progress);
      }

      return result;
    },
    {
      taskStartDelay: TASK_START_DELAY_MS,
      workerStartDelay: WORKER_START_DELAY_MS,
    }
  );

  // Final progress save
  await saveEvaluationProgress(progress);

  console.log(`\n=== Evaluation Complete ===`);
  console.log(
    `Total evaluated: ${skippedTasks.length + completed}/${allTasks.length}`
  );
  console.log(`Successfully evaluated this run: ${completed}`);
  console.log(`Failed this run: ${failed}`);

  if (failed > 0) {
    console.log(`\n⚠ Failed evaluations can be retried by running again`);
    console.log(`Failed evaluations:`);
    for (const f of progress.failed) {
      console.log(`  - ${f.benchmarkId} - ${f.model}: ${f.error}`);
    }
  }

  // Generate summary if we have results
  if (completedResults.length > 0) {
    console.log(`\nGenerating evaluation summary...`);
    await saveEvaluationSummary(completedResults);
  }

  console.log(`\n✅ Evaluation results saved to benchmark/artifacts/evaluation/`);
}

// Execute evaluation
runEvaluation().catch(console.error);

export {};
