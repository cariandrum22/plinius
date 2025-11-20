import { OpenRouter } from "@openrouter/sdk";
import { mkdir, writeFile, readFile, readdir } from "fs/promises";
import { join } from "path";
import { env, validateEnv } from "./env.js";
import { OpenRouterModels, OpenRouterModel } from "./types/openrouter.js";
import { BenchmarkId } from "./types/benchmark.js";
import { loadBenchmark } from "./benchmark/loader.js";

/**
 * Models to evaluate
 */
const EvaluateModels: OpenRouterModel[] = [
  OpenRouterModels.GPT_5_1,
  OpenRouterModels.CLAUDE_4_5_HAIKU,
  OpenRouterModels.GEMINI_2_5_PRO,
  OpenRouterModels.LLAMA_4_MAVERIC,
  OpenRouterModels.MISTRAL_MEDIUM_3_1,
  OpenRouterModels.DEEPSEEK_R1_0528,
  OpenRouterModels.GROK_4,
  OpenRouterModels.KIMI_K2_THINKING,
  OpenRouterModels.QWEN_3_MAX,
  OpenRouterModels.MINIMAX_M2,
  OpenRouterModels.PHI_4_REASONING_PLUS,
  OpenRouterModels.MAI_DS_R1, // Re-enabled with data policy header
];

/**
 * Benchmark prompts to evaluate
 */
const BenchmarkPrompts: BenchmarkId[] = [
  "A1",
  "A2",
  "A3",
  "B1",
  "B2",
  "B3",
  "C1",
  "C2",
  "C3",
];

/**
 * Configuration for benchmark execution
 */
interface BenchmarkConfig {
  // API parameters
  maxTokens: number;
  temperature: number;
  topP: number;

  // Cost estimation
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  costPerMillionPromptTokens: number;
  costPerMillionCompletionTokens: number;
}

const config: BenchmarkConfig = {
  // Optimized for maximum reasoning performance
  maxTokens: 16000, // Support reasoning models (DeepSeek R1, Kimi K2)
  temperature: 0.1, // Low randomness for consistent reasoning
  topP: 0.95, // Slight diversity control

  // Realistic cost estimation for reasoning models
  estimatedPromptTokens: 2000, // Complex prompts with context
  estimatedCompletionTokens: 12000, // Reasoning models generate long outputs
  costPerMillionPromptTokens: 2.0, // Conservative estimate
  costPerMillionCompletionTokens: 6.0, // Reasoning models are more expensive
};

/**
 * Cartesian product of models and prompts
 */
interface BenchmarkTask {
  model: OpenRouterModel;
  promptId: BenchmarkId;
}

/**
 * Generate Cartesian product
 */
function generateTasks(): BenchmarkTask[] {
  const tasks: BenchmarkTask[] = [];
  for (const model of EvaluateModels) {
    for (const promptId of BenchmarkPrompts) {
      tasks.push({ model, promptId });
    }
  }
  return tasks;
}

/**
 * Estimate total cost
 */
function estimateCost(totalTasks: number): {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCost: number;
  costPerTask: number;
} {
  const totalPromptTokens = totalTasks * config.estimatedPromptTokens;
  const totalCompletionTokens = totalTasks * config.estimatedCompletionTokens;

  const promptCost =
    (totalPromptTokens / 1_000_000) * config.costPerMillionPromptTokens;
  const completionCost =
    (totalCompletionTokens / 1_000_000) *
    config.costPerMillionCompletionTokens;
  const totalCost = promptCost + completionCost;

  return {
    totalPromptTokens,
    totalCompletionTokens,
    totalCost,
    costPerTask: totalCost / totalTasks,
  };
}

/**
 * Generate safe filename from model name
 */
function sanitizeModelName(model: string): string {
  return model.replace(/\//g, "_").replace(/:/g, "-");
}

/**
 * Progress tracking
 */
interface ProgressState {
  completed: Array<{ model: string; promptId: string }>;
  failed: Array<{ model: string; promptId: string; error: string }>;
  lastUpdate: string;
}

/**
 * Check if task is already completed
 */
async function isTaskCompleted(
  model: OpenRouterModel,
  promptId: BenchmarkId
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

/**
 * Load progress state
 */
async function loadProgress(): Promise<ProgressState> {
  const progressPath = join(
    process.cwd(),
    "artifacts",
    "result",
    "progress.json"
  );
  try {
    const content = await readFile(progressPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return { completed: [], failed: [], lastUpdate: new Date().toISOString() };
  }
}

/**
 * Save progress state
 */
async function saveProgress(progress: ProgressState): Promise<void> {
  const progressPath = join(
    process.cwd(),
    "artifacts",
    "result",
    "progress.json"
  );
  await mkdir(join(process.cwd(), "benchmark", "artifacts", "result"), { recursive: true });
  progress.lastUpdate = new Date().toISOString();
  await writeFile(progressPath, JSON.stringify(progress, null, 2), "utf-8");
}

/**
 * Sleep utility for retry backoff
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute task with retry logic
 */
async function executeTaskWithRetry(
  openRouter: OpenRouter,
  task: BenchmarkTask,
  maxRetries = 3
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `  Attempt ${attempt}/${maxRetries}${attempt > 1 ? " (retry)" : ""}`
      );

      // Load benchmark
      const benchmark = await loadBenchmark(task.promptId);

      // Execute query
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
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        topP: config.topP,
      });
      const endTime = Date.now();

      const response =
        typeof completion.choices[0].message.content === "string"
          ? completion.choices[0].message.content
          : "";

      // Save result
      await saveResult(task.model, task.promptId, benchmark.content, response, {
        promptTokens: completion.usage?.promptTokens,
        completionTokens: completion.usage?.completionTokens,
        totalTokens: completion.usage?.totalTokens,
        latencyMs: endTime - startTime,
      });

      return { success: true };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);

      if (attempt === maxRetries) {
        console.error(`  ✗ Failed after ${maxRetries} attempts: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      // Exponential backoff: 2^attempt seconds
      const backoffMs = Math.pow(2, attempt) * 1000;
      console.log(`  ⚠ Error: ${errorMsg}`);
      console.log(`  ⏳ Waiting ${backoffMs / 1000}s before retry...`);
      await sleep(backoffMs);
    }
  }

  return { success: false, error: "Max retries exceeded" };
}

/**
 * Save result as Markdown
 */
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
  }
): Promise<void> {
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
  console.log(`Saved result to: ${filename}`);
}

/**
 * Run all benchmarks with resume capability
 */
async function runBenchmarks(): Promise<void> {
  // Validate environment
  validateEnv(["OPENROUTER_API_KEY"]);

  // Generate tasks
  const allTasks = generateTasks();

  // Load progress
  const progress = await loadProgress();

  // Filter out already completed tasks
  const pendingTasks = [];
  const skippedTasks = [];

  for (const task of allTasks) {
    const completed = await isTaskCompleted(task.model, task.promptId);
    if (completed) {
      skippedTasks.push(task);
    } else {
      pendingTasks.push(task);
    }
  }

  console.log(`\n=== Benchmark Execution Plan ===`);
  console.log(`Total models: ${EvaluateModels.length}`);
  console.log(`Total prompts: ${BenchmarkPrompts.length}`);
  console.log(`Total tasks: ${allTasks.length}`);
  console.log(`Already completed: ${skippedTasks.length}`);
  console.log(`Pending tasks: ${pendingTasks.length}`);

  if (skippedTasks.length > 0) {
    console.log(`\n⏭ Skipping ${skippedTasks.length} completed tasks`);
  }

  // Estimate cost for pending tasks only
  const estimate = estimateCost(pendingTasks.length);
  console.log(`\n=== Cost Estimation (Pending Tasks) ===`);
  console.log(
    `Estimated total prompt tokens: ${estimate.totalPromptTokens.toLocaleString()}`
  );
  console.log(
    `Estimated total completion tokens: ${estimate.totalCompletionTokens.toLocaleString()}`
  );
  console.log(`Estimated total cost: $${estimate.totalCost.toFixed(2)}`);
  console.log(`Estimated cost per task: $${estimate.costPerTask.toFixed(4)}`);

  if (pendingTasks.length === 0) {
    console.log(`\n✅ All tasks already completed!`);
    return;
  }

  console.log(`\n=== Starting Benchmark Execution ===\n`);

  // Initialize OpenRouter client
  const openRouter = new OpenRouter({
    apiKey: env.OPENROUTER_API_KEY!,
  });

  // Execute pending tasks
  let completed = 0;
  let failed = 0;

  for (let i = 0; i < pendingTasks.length; i++) {
    const task = pendingTasks[i];
    const overallIndex = skippedTasks.length + i + 1;

    console.log(
      `[${overallIndex}/${allTasks.length}] Running: ${task.promptId} with ${task.model}`
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
      console.log(`✗ Failed: ${task.promptId} with ${task.model}\n`);
    }

    // Save progress after each task
    await saveProgress(progress);
  }

  console.log(`\n=== Benchmark Execution Complete ===`);
  console.log(
    `Total completed: ${skippedTasks.length + completed}/${allTasks.length} tasks`
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
}

// Execute benchmarks
runBenchmarks().catch(console.error);

export {};
