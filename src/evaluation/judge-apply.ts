/**
 * Applies LLM judges to a stored run record.
 *
 * This is deliberately independent of generation and of on-disk layout: it only
 * needs the persisted candidate text plus the benchmark's rubric context, so it
 * can be run inline right after a benchmark, or much later over records loaded
 * from disk (re-judging with a different or newer judge).
 */
import { BenchmarkRunRecord } from "../types/benchmark.js";
import { LoadedBenchmark } from "../suite/loader.js";
import { Judge, JudgeInput } from "./judge.js";

export interface RubricContext {
  taskText: string;
  expectedOutputFormat: string;
  rubric: JudgeInput["rubric"];
}

export function rubricContextFromBenchmark(loaded: LoadedBenchmark): RubricContext {
  return {
    taskText: loaded.taskText,
    expectedOutputFormat: loaded.definition.expectedOutputFormat,
    rubric: loaded.definition.rubric,
  };
}

/**
 * Return a copy of `record` with `judgeEvaluations` populated. Records without
 * a successful response are returned unchanged (nothing to judge).
 */
export async function applyJudgesToRecord(
  record: BenchmarkRunRecord,
  context: RubricContext,
  judges: Judge[],
): Promise<BenchmarkRunRecord> {
  if (!record.response || judges.length === 0) return record;

  const input: JudgeInput = {
    taskText: context.taskText,
    expectedOutputFormat: context.expectedOutputFormat,
    candidateOutput: record.response.text,
    rubric: context.rubric,
  };

  const judgeEvaluations = [];
  for (const judge of judges) {
    judgeEvaluations.push(await judge.evaluate(input));
  }
  return { ...record, judgeEvaluations };
}
