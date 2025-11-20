/**
 * Benchmark command - Run benchmark prompts against models
 */
import { OpenRouter } from "@openrouter/sdk";
import { mkdir, writeFile, readFile, readdir } from "fs/promises";
import { join } from "path";
import { env, validateEnv } from "../env.js";
import { OpenRouterModel } from "../types/openrouter.js";
import { BenchmarkId } from "../types/benchmark.js";
import { loadBenchmark } from "../benchmark/loader.js";
import {
  BENCHMARK_MODELS,
  discoverBenchmarkIds,
  defaultBenchmarkConfig,
  sanitizeModelName,
} from "../config.js";
import { executeWithConcurrency } from "../utils/executor.js";
import {
  fetchOpenRouterPricing,
  calculateCostBreakdown,
} from "../utils/pricing-fetcher.js";

interface BenchmarkTask {
  model: OpenRouterModel;
  promptId: BenchmarkId;
}

interface ProgressState {
  completed: Array<{ model: string; promptId: string }>;
  failed: Array<{ model: string; promptId: string; error: string }>;
  lastUpdate: string;
}

const CONCURRENT_BENCHMARKS = 5;
const TASK_START_DELAY_MS = 500;
const WORKER_START_DELAY_MS = 1000;

async function generateTasks(): Promise<BenchmarkTask[]> {
  const benchmarkIds = await discoverBenchmarkIds();
  const tasks: BenchmarkTask[] = [];
  for (const model of BENCHMARK_MODELS) {
    for (const promptId of benchmarkIds) {
      tasks.push({ model, promptId });
    }
  }
  return tasks;
}

async function isTaskCompleted(
  model: OpenRouterModel,
  promptId: BenchmarkId,
): Promise<boolean> {
  const outputDir = join(process.cwd(), "benchmark", "artifacts", "result");
  try {
    const files = await readdir(outputDir);
    const modelName = sanitizeModelName(model);
    const prefix = `${promptId}_${modelName}_`;
    return files.some((file) => file.startsWith(prefix));
  } catch {
    return false;
  }
}

async function loadProgress(): Promise<ProgressState> {
  const progressPath = join(
    process.cwd(),
    "benchmark",
    "artifacts",
    "result",
    "progress.json",
  );
  try {
    const content = await readFile(progressPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return { completed: [], failed: [], lastUpdate: new Date().toISOString() };
  }
}

async function saveProgress(progress: ProgressState): Promise<void> {
  const progressPath = join(
    process.cwd(),
    "benchmark",
    "artifacts",
    "result",
    "progress.json",
  );
  await mkdir(join(process.cwd(), "benchmark", "artifacts", "result"), {
    recursive: true,
  });
  progress.lastUpdate = new Date().toISOString();
  await writeFile(progressPath, JSON.stringify(progress, null, 2), "utf-8");
}

async function executeTaskWithRetry(
  openRouter: OpenRouter,
  task: BenchmarkTask,
  maxRetries = 3,
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`  Retry ${attempt}/${maxRetries}`);
      }

      const benchmark = await loadBenchmark(task.promptId);
      const startTime = Date.now();

      const completion = await openRouter.chat.send({
        model: task.model,
        messages: [
          {
            role: "system",
            content:
              "You are an expert reasoning system designed to demonstrate maximum analytical capability. " +
              "Show all intermediate steps, underlying assumptions, and alternative approaches. " +
              "Prioritize thoroughness, correctness, and depth of reasoning over brevity. " +
              "Use structured thinking: break down complex problems, consider edge cases, " +
              "and provide rigorous justification for your conclusions.",
          },
          {
            role: "user",
            content: benchmark.content,
          },
        ],
        maxTokens: defaultBenchmarkConfig.maxTokens,
        temperature: defaultBenchmarkConfig.temperature,
        topP: defaultBenchmarkConfig.topP,
      });

      const endTime = Date.now();
      const response =
        typeof completion.choices[0].message.content === "string"
          ? completion.choices[0].message.content
          : "";

      await saveResult(task.model, task.promptId, benchmark.content, response, {
        promptTokens: completion.usage?.promptTokens,
        completionTokens: completion.usage?.completionTokens,
        totalTokens: completion.usage?.totalTokens,
        latencyMs: endTime - startTime,
      });

      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (attempt === maxRetries) {
        return { success: false, error: errorMsg };
      }

      const backoffMs = Math.pow(2, attempt) * 1000;
      console.log(`  ⚠ Error: ${errorMsg}`);
      console.log(`  ⏳ Waiting ${backoffMs / 1000}s before retry...`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  return { success: false, error: "Max retries exceeded" };
}

async function saveResult(
  model: OpenRouterModel,
  promptId: BenchmarkId,
  prompt: string,
  response: string,
  metadata: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    latencyMs?: number;
  },
): Promise<string> {
  const outputDir = join(process.cwd(), "benchmark", "artifacts", "result");
  await mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const modelName = sanitizeModelName(model);
  const filename = `${promptId}_${modelName}_${timestamp}.md`;
  const filepath = join(outputDir, filename);

  const content = `# Benchmark Result: ${promptId} - ${model}

**Timestamp:** ${new Date().toISOString()}
**Model:** ${model}
**Prompt ID:** ${promptId}
**Latency:** ${metadata.latencyMs || "N/A"}ms
**Tokens:** ${metadata.totalTokens || "N/A"} (prompt: ${metadata.promptTokens || "N/A"}, completion: ${metadata.completionTokens || "N/A"})

---

## Prompt

\`\`\`
${prompt}
\`\`\`

---

## Response

${response}
`;

  await writeFile(filepath, content, "utf-8");
  return filename;
}

/**
 * Run all benchmarks with resume capability and parallel execution
 */
export async function runBenchmarks(): Promise<void> {
  console.log(`\n=== Plinius Benchmark Runner ===\n`);

  validateEnv(["OPENROUTER_API_KEY"]);

  const allTasks = await generateTasks();
  const progress = await loadProgress();
  const benchmarkIds = await discoverBenchmarkIds();

  const pendingTasks: BenchmarkTask[] = [];
  const skippedTasks: BenchmarkTask[] = [];

  for (const task of allTasks) {
    const completed = await isTaskCompleted(task.model, task.promptId);
    if (completed) {
      skippedTasks.push(task);
    } else {
      pendingTasks.push(task);
    }
  }

  console.log(`=== Benchmark Execution Plan ===`);
  console.log(`Total models: ${BENCHMARK_MODELS.length}`);
  console.log(`Total prompts: ${benchmarkIds.length}`);
  console.log(`Total tasks: ${allTasks.length}`);
  console.log(`Already completed: ${skippedTasks.length}`);
  console.log(`Pending tasks: ${pendingTasks.length}`);

  if (skippedTasks.length > 0) {
    console.log(`\n⏭ Skipping ${skippedTasks.length} completed tasks`);
  }

  // Fetch dynamic pricing from OpenRouter
  const pricingData = await fetchOpenRouterPricing();

  // Calculate actual prompt tokens by loading benchmarks
  console.log(`\n=== Cost Estimation (Pending Tasks) ===`);
  console.log(`Calculating costs with actual prompt sizes...`);

  const SYSTEM_PROMPT_TOKENS = 100; // Approximate system prompt
  const ESTIMATED_COMPLETION_TOKENS = 12000; // Output is estimated

  let totalPromptCost = 0;
  let totalCompletionCost = 0;
  const costByModel = new Map<
    string,
    { count: number; promptCost: number; completionCost: number }
  >();

  // Group tasks by promptId to avoid loading same prompt multiple times
  const promptTokensCache = new Map<string, number>();

  for (const task of pendingTasks) {
    // Get prompt tokens (cached)
    let promptTokens = promptTokensCache.get(task.promptId);
    if (promptTokens === undefined) {
      const benchmark = await loadBenchmark(task.promptId);
      // Rough token estimate: ~4 chars per token
      promptTokens =
        Math.ceil(benchmark.content.length / 4) + SYSTEM_PROMPT_TOKENS;
      promptTokensCache.set(task.promptId, promptTokens);
    }

    // Get model pricing
    const pricing = pricingData.get(task.model) || {
      promptPricePerMillion: 2.0,
      completionPricePerMillion: 6.0,
    };

    const breakdown = calculateCostBreakdown(
      pricing.promptPricePerMillion,
      pricing.completionPricePerMillion,
      promptTokens,
      ESTIMATED_COMPLETION_TOKENS,
    );

    totalPromptCost += breakdown.promptCost;
    totalCompletionCost += breakdown.completionCost;

    // Accumulate by model
    const existing = costByModel.get(task.model) || {
      count: 0,
      promptCost: 0,
      completionCost: 0,
    };
    costByModel.set(task.model, {
      count: existing.count + 1,
      promptCost: existing.promptCost + breakdown.promptCost,
      completionCost: existing.completionCost + breakdown.completionCost,
    });
  }

  const totalCost = totalPromptCost + totalCompletionCost;

  console.log(
    `\nInput cost:  $${totalPromptCost.toFixed(4)} (actual prompt sizes)`,
  );
  console.log(
    `Output cost: ~$${totalCompletionCost.toFixed(4)} (estimated ~${ESTIMATED_COMPLETION_TOKENS.toLocaleString()} tokens/task)`,
  );
  console.log(`Total:       $${totalCost.toFixed(2)} (output is estimated)`);

  console.log(`\nCost by model:`);
  for (const [model, data] of costByModel) {
    const pricing = pricingData.get(model);
    const modelTotal = data.promptCost + data.completionCost;
    if (pricing) {
      console.log(
        `  ${model}: ${data.count} tasks, $${modelTotal.toFixed(4)} ($${pricing.promptPricePerMillion}/$${pricing.completionPricePerMillion} per M)`,
      );
    } else {
      console.log(`  ${model}: ${data.count} tasks, $${modelTotal.toFixed(4)}`);
    }
  }

  if (pendingTasks.length === 0) {
    console.log(`\n✅ All tasks already completed!`);
    return;
  }

  console.log(
    `\n=== Starting Benchmark Execution (${CONCURRENT_BENCHMARKS} parallel) ===\n`,
  );

  const openRouter = new OpenRouter({
    apiKey: env.OPENROUTER_API_KEY!,
  });

  let completed = 0;
  let failed = 0;

  await executeWithConcurrency(
    pendingTasks,
    CONCURRENT_BENCHMARKS,
    async (task, index) => {
      const overallIndex = skippedTasks.length + index + 1;

      console.log(
        `[${overallIndex}/${allTasks.length}] Running: ${task.promptId} with ${task.model}`,
      );

      const result = await executeTaskWithRetry(openRouter, task);

      if (result.success) {
        completed++;
        progress.completed.push({ model: task.model, promptId: task.promptId });
        console.log(`✓ Completed: ${task.promptId} with ${task.model}\n`);
      } else {
        failed++;
        progress.failed.push({
          model: task.model,
          promptId: task.promptId,
          error: result.error || "Unknown error",
        });
        console.log(
          `✗ Failed: ${task.promptId} with ${task.model}: ${result.error}\n`,
        );
      }

      // Save progress periodically
      if ((completed + failed) % 5 === 0) {
        await saveProgress(progress);
      }

      return result;
    },
    {
      taskStartDelay: TASK_START_DELAY_MS,
      workerStartDelay: WORKER_START_DELAY_MS,
    },
  );

  await saveProgress(progress);

  console.log(`\n=== Benchmark Execution Complete ===`);
  console.log(
    `Total completed: ${skippedTasks.length + completed}/${allTasks.length} tasks`,
  );
  console.log(`Successfully completed this run: ${completed} tasks`);
  console.log(`Failed this run: ${failed} tasks`);

  if (failed > 0) {
    console.log(`\n⚠ Failed tasks can be retried by running again`);
    console.log(`Failed tasks:`);
    for (const f of progress.failed) {
      console.log(`  - ${f.promptId} with ${f.model}: ${f.error}`);
    }
  }

  console.log(`\n✅ Results saved to benchmark/artifacts/result/`);
}
