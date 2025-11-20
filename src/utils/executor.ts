/**
 * Shared parallel execution utilities with staggered starts
 */

export interface ExecutorOptions {
  /** Delay between task starts within a worker (ms) */
  taskStartDelay?: number;
  /** Delay between worker starts (ms) */
  workerStartDelay?: number;
}

export interface ExecutorConfig {
  concurrency: number;
  taskStartDelayMs: number;
  workerStartDelayMs: number;
}

export const defaultExecutorConfig: ExecutorConfig = {
  concurrency: 5,
  taskStartDelayMs: 500,
  workerStartDelayMs: 1000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute tasks in parallel with staggered starts to avoid rate limiting
 *
 * Features:
 * - Workers start with delay between them
 * - Tasks within workers start with delay
 * - Failed tasks get extra delay before next task
 *
 * @param tasks - Array of tasks to execute
 * @param concurrency - Number of parallel workers
 * @param executor - Function to execute each task
 * @param options - Delay options
 * @returns Array of results in same order as tasks
 */
export async function executeWithConcurrency<T, R>(
  tasks: T[],
  concurrency: number,
  executor: (task: T, index: number) => Promise<R>,
  options: ExecutorOptions = {},
): Promise<R[]> {
  const results: R[] = [];
  let taskIndex = 0;
  const { taskStartDelay = 0, workerStartDelay = 0 } = options;

  const workers = Array(Math.min(concurrency, tasks.length))
    .fill(null)
    .map(async (_, workerIndex) => {
      // Stagger worker starts
      if (workerIndex > 0 && workerStartDelay > 0) {
        await sleep(workerStartDelay * workerIndex);
      }

      while (taskIndex < tasks.length) {
        const index = taskIndex++;
        const task = tasks[index];

        try {
          results[index] = await executor(task, index);
          // Delay before next task
          if (taskIndex < tasks.length && taskStartDelay > 0) {
            await sleep(taskStartDelay);
          }
        } catch (error) {
          console.error(`Task ${index} failed:`, error);
          results[index] = error as R;
          // Extra delay after failure
          if (taskIndex < tasks.length) {
            await sleep(Math.max(taskStartDelay * 2, 2000));
          }
        }
      }
    });

  await Promise.all(workers);
  return results;
}

/**
 * Sleep utility for external use
 */
export { sleep };
