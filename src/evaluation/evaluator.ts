import { OpenRouter } from "@openrouter/sdk";
import {
  EvaluationResult,
  EvaluationScores,
  EvaluationTask,
} from "../types/evaluation.js";
import { OpenRouterModel } from "../types/openrouter.js";
import { EVALUATION_RUBRIC, generateEvaluationPrompt } from "./rubric.js";
import { parseBenchmarkResult } from "./parser.js";

/**
 * Sleep utility for retry backoff
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse JSON from model response, handling markdown code blocks and truncated JSON
 */
function parseEvaluationJSON(response: string): {
  scores: EvaluationScores;
  totalScore: number;
  commentary: string;
} {
  // Try to extract JSON from markdown code block
  const codeBlockMatch = response.match(/```json\s*([\s\S]+?)\s*```/);
  let jsonText = codeBlockMatch ? codeBlockMatch[1] : response;

  try {
    const parsed = JSON.parse(jsonText.trim());

    // Validate structure
    if (
      !parsed.scores ||
      typeof parsed.scores.structure !== "number" ||
      typeof parsed.scores.depth !== "number" ||
      typeof parsed.scores.consistency !== "number" ||
      typeof parsed.scores.creativity !== "number" ||
      typeof parsed.scores.domainCorrectness !== "number"
    ) {
      throw new Error("Invalid evaluation response structure");
    }

    return {
      scores: parsed.scores as EvaluationScores,
      totalScore: parsed.totalScore || 0,
      commentary: parsed.commentary || "",
    };
  } catch (error) {
    // If JSON is truncated (common with long commentary), try to recover scores
    console.log(
      `  ⚠ JSON parse failed, attempting to extract scores from partial JSON...`
    );

    // Try to extract scores object even if JSON is incomplete
    const scoresMatch = jsonText.match(
      /"scores"\s*:\s*\{[^}]*"structure"\s*:\s*(\d+)[^}]*"depth"\s*:\s*(\d+)[^}]*"consistency"\s*:\s*(\d+)[^}]*"creativity"\s*:\s*(\d+)[^}]*"domainCorrectness"\s*:\s*(\d+)/
    );

    if (scoresMatch) {
      const scores: EvaluationScores = {
        structure: parseInt(scoresMatch[1]),
        depth: parseInt(scoresMatch[2]),
        consistency: parseInt(scoresMatch[3]),
        creativity: parseInt(scoresMatch[4]),
        domainCorrectness: parseInt(scoresMatch[5]),
      };

      const totalScore =
        scores.structure +
        scores.depth +
        scores.consistency +
        scores.creativity +
        scores.domainCorrectness;

      // Extract whatever commentary we have
      const commentaryMatch = jsonText.match(
        /"commentary"\s*:\s*"((?:[^"\\]|\\.)*)"/
      );
      const commentary = commentaryMatch
        ? commentaryMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"')
        : "[Commentary truncated due to token limit]";

      console.log(`  ✓ Successfully extracted scores from partial JSON`);

      return { scores, totalScore, commentary };
    }

    throw new Error(
      `Failed to parse evaluation JSON: ${error instanceof Error ? error.message : String(error)}\n\nResponse preview: ${response.substring(0, 500)}`
    );
  }
}

/**
 * Execute evaluation with retry logic
 */
export async function evaluateWithRetry(
  openRouter: OpenRouter,
  evaluatorModel: OpenRouterModel,
  task: EvaluationTask,
  maxRetries = 3
): Promise<{ success: boolean; result?: EvaluationResult; error?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `  Attempt ${attempt}/${maxRetries}${attempt > 1 ? " (retry)" : ""}`
      );

      // Parse the benchmark result file
      const parsedResult = await parseBenchmarkResult(task.resultFilePath);

      // Generate evaluation prompt
      const evaluationPrompt = generateEvaluationPrompt(
        parsedResult.benchmarkId,
        parsedResult.prompt,
        parsedResult.response
      );

      // Execute evaluation
      const startTime = Date.now();
      const completion = await openRouter.chat.send({
        model: evaluatorModel,
        messages: [
          {
            role: "system",
            content: EVALUATION_RUBRIC,
          },
          {
            role: "user",
            content: evaluationPrompt,
          },
        ],
        maxTokens: 8000, // Increased for detailed commentary (was 4000)
        temperature: 0.1, // Low temperature for consistent evaluation
        topP: 0.95,
      });
      const endTime = Date.now();

      const responseText =
        typeof completion.choices[0].message.content === "string"
          ? completion.choices[0].message.content
          : "";

      // Parse evaluation JSON
      const { scores, totalScore, commentary } =
        parseEvaluationJSON(responseText);

      const result: EvaluationResult = {
        benchmarkId: task.benchmarkId,
        model: task.model,
        evaluatedBy: evaluatorModel,
        timestamp: new Date(),
        scores,
        totalScore,
        commentary,
        metadata: {
          evaluationLatencyMs: endTime - startTime,
          evaluationTokens: completion.usage?.totalTokens,
        },
      };

      return { success: true, result };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);

      // Check if it's a network/rate limit error
      const isNetworkError =
        errorMsg.includes("terminated") ||
        errorMsg.includes("ECONNRESET") ||
        errorMsg.includes("socket") ||
        errorMsg.includes("UND_ERR");

      if (attempt === maxRetries) {
        console.error(`  ✗ Failed after ${maxRetries} attempts: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      // Longer backoff for network errors: 5, 10, 15 seconds
      const backoffMs = isNetworkError
        ? 5000 * attempt
        : Math.pow(2, attempt) * 1000;

      console.log(`  ⚠ Error: ${errorMsg.substring(0, 100)}...`);
      console.log(
        `  ⏳ ${isNetworkError ? "Network error detected. " : ""}Waiting ${backoffMs / 1000}s before retry...`
      );
      await sleep(backoffMs);
    }
  }

  return { success: false, error: "Max retries exceeded" };
}
