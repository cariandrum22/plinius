/**
 * Benchmark command - Run benchmark prompts against models
 */
import { OpenRouter } from "@openrouter/sdk";
import { mkdir, writeFile, readFile, readdir } from "fs/promises";
import { join } from "path";
import { env, validateEnv } from "../env.js";
import { OpenRouterModels, OpenRouterModel } from "../types/openrouter.js";
import { BenchmarkId } from "../types/benchmark.js";
import { loadBenchmark } from "../benchmark/loader.js";

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
  OpenRouterModels.MAI_DS_R1,
];

/**
 * Benchmark prompts to evaluate
 */
const BenchmarkPrompts: BenchmarkId[] = [
  "A1", "A2", "A3",
  "B1", "B2", "B3",
  "C1", "C2", "C3",
];

/**
 * Configuration for benchmark execution
 */
interface BenchmarkConfig {
  maxTokens: number;
  temperature: number;
  topP: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  costPerMillionPromptTokens: number;
  costPerMillionCompletionTokens: number;
}

const config: BenchmarkConfig = {
  maxTokens: 16000,
  temperature: 0.1,
  topP: 0.95,
  estimatedPromptTokens: 2000,
  estimatedCompletionTokens: 12000,
  costPerMillionPromptTokens: 2.0,
  costPerMillionCompletionTokens: 6.0,
};

interface BenchmarkTask {
  model: OpenRouterModel;
  promptId: BenchmarkId;
}

interface ProgressState {
  completed: Array<{ model: string; promptId: string }>;
  failed: Array<{ model: string; promptId: string; error: string }>;
  lastUpdate: string;
}

function generateTasks(): BenchmarkTask[] {
  const tasks: BenchmarkTask[] = [];
  for (const model of EvaluateModels) {
    for (const promptId of BenchmarkPrompts) {
      tasks.push({ model, promptId });
    }
  }
  return tasks;
}

function estimateCost(totalTasks: number) {
  const totalPromptTokens = totalTasks * config.estimatedPromptTokens;
  const totalCompletionTokens = totalTasks * config.estimatedCompletionTokens;
  const promptCost = (totalPromptTokens / 1_000_000) * config.costPerMillionPromptTokens;
  const completionCost = (totalCompletionTokens / 1_000_000) * config.costPerMillionCompletionTokens;
  const totalCost = promptCost + completionCost;

  return {
    totalPromptTokens,
    totalCompletionTokens,
    totalCost,
    costPerTask: totalCost / totalTasks,
  };
}

function sanitizeModelName(model: string): string {
  return model.replace(/\//g, "_").replace(/:/g, "-");
}

async function isTaskCompleted(model: OpenRouterModel, promptId: BenchmarkId): Promise<boolean> {
  const outputDir = join(process.cwd(), "artifacts", "result");
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
  const progressPath = join(process.cwd(), "artifacts", "result", "progress.json");
  try {
    const content = await readFile(progressPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return { completed: [], failed: [], lastUpdate: new Date().toISOString() };
  }
}

async function saveProgress(progress: ProgressState): Promise<void> {
  const progressPath = join(process.cwd(), "artifacts", "result", "progress.json");
  await mkdir(join(process.cwd(), "artifacts", "result"), { recursive: true });
  progress.lastUpdate = new Date().toISOString();
  await writeFile(progressPath, JSON.stringify(progress, null, 2), "utf-8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeTaskWithRetry(
  openRouter: OpenRouter,
  task: BenchmarkTask,
  maxRetries = 3
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`  Attempt ${attempt}/${maxRetries}${attempt > 1 ? " (retry)" : ""}`);

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
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        topP: config.topP,
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
        console.error(`  ✗ Failed after ${maxRetries} attempts: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      const backoffMs = Math.pow(2, attempt) * 1000;
      console.log(`  ⚠ Error: ${errorMsg}`);
      console.log(`  ⏳ Waiting ${backoffMs / 1000}s before retry...`);
      await sleep(backoffMs);
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
  }
): Promise<void> {
  const outputDir = join(process.cwd(), "artifacts", "result");
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
export async function runBenchmarks(): Promise<void> {
  console.log(`\n=== Plinius Benchmark Runner ===\n`);

  validateEnv(["OPENROUTER_API_KEY"]);

  const allTasks = generateTasks();
  const progress = await loadProgress();

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

  console.log(`=== Benchmark Execution Plan ===`);
  console.log(`Total models: ${EvaluateModels.length}`);
  console.log(`Total prompts: ${BenchmarkPrompts.length}`);
  console.log(`Total tasks: ${allTasks.length}`);
  console.log(`Already completed: ${skippedTasks.length}`);
  console.log(`Pending tasks: ${pendingTasks.length}`);

  if (skippedTasks.length > 0) {
    console.log(`\n⏭ Skipping ${skippedTasks.length} completed tasks`);
  }

  const estimate = estimateCost(pendingTasks.length);
  console.log(`\n=== Cost Estimation (Pending Tasks) ===`);
  console.log(`Estimated total prompt tokens: ${estimate.totalPromptTokens.toLocaleString()}`);
  console.log(`Estimated total completion tokens: ${estimate.totalCompletionTokens.toLocaleString()}`);
  console.log(`Estimated total cost: $${estimate.totalCost.toFixed(2)}`);
  console.log(`Estimated cost per task: $${estimate.costPerTask.toFixed(4)}`);

  if (pendingTasks.length === 0) {
    console.log(`\n✅ All tasks already completed!`);
    return;
  }

  console.log(`\n=== Starting Benchmark Execution ===\n`);

  const openRouter = new OpenRouter({
    apiKey: env.OPENROUTER_API_KEY!,
  });

  let completed = 0;
  let failed = 0;

  for (let i = 0; i < pendingTasks.length; i++) {
    const task = pendingTasks[i];
    const overallIndex = skippedTasks.length + i + 1;

    console.log(`[${overallIndex}/${allTasks.length}] Running: ${task.promptId} with ${task.model}`);

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

    await saveProgress(progress);
  }

  console.log(`\n=== Benchmark Execution Complete ===`);
  console.log(`Total completed: ${skippedTasks.length + completed}/${allTasks.length} tasks`);
  console.log(`Successfully completed this run: ${completed} tasks`);
  console.log(`Failed this run: ${failed} tasks`);

  if (failed > 0) {
    console.log(`\n⚠ Failed tasks can be retried by running again`);
    console.log(`Failed tasks:`);
    for (const f of progress.failed) {
      console.log(`  - ${f.promptId} with ${f.model}: ${f.error}`);
    }
  }

  console.log(`\n✅ Results saved to artifacts/result/`);
}
