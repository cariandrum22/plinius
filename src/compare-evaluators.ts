import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

/**
 * Evaluation result from JSON file
 */
interface EvaluationResultData {
  benchmarkId: string;
  model: string;
  evaluatedBy: string;
  timestamp: string;
  scores: {
    structure: number;
    depth: number;
    consistency: number;
    creativity: number;
    domainCorrectness: number;
  };
  totalScore: number;
  commentary: string;
}

/**
 * Aggregated data for analysis
 */
interface ModelScores {
  model: string;
  evaluatorScores: Map<string, number[]>; // evaluator -> scores array
  benchmarkScores: Map<string, Map<string, number>>; // benchmarkId -> evaluator -> score
}

/**
 * Load all evaluation results
 */
async function loadAllEvaluations(): Promise<EvaluationResultData[]> {
  const evaluationDir = join(process.cwd(), "benchmark", "artifacts", "evaluation");
  const files = await readdir(evaluationDir);

  const results: EvaluationResultData[] = [];

  for (const file of files) {
    if (!file.endsWith(".json") || file === "progress.json") {
      continue;
    }

    try {
      const content = await readFile(join(evaluationDir, file), "utf-8");
      const data = JSON.parse(content) as EvaluationResultData;

      // Only include files with evaluatedBy field (multi-evaluator format)
      if (data.evaluatedBy && data.totalScore !== undefined) {
        results.push(data);
      }
    } catch {
      // Skip invalid files
    }
  }

  return results;
}

/**
 * Group results by model and evaluator
 */
function groupByModelAndEvaluator(results: EvaluationResultData[]): Map<string, ModelScores> {
  const modelMap = new Map<string, ModelScores>();

  for (const result of results) {
    if (!modelMap.has(result.model)) {
      modelMap.set(result.model, {
        model: result.model,
        evaluatorScores: new Map(),
        benchmarkScores: new Map(),
      });
    }

    const modelData = modelMap.get(result.model)!;

    // Add to evaluator scores
    if (!modelData.evaluatorScores.has(result.evaluatedBy)) {
      modelData.evaluatorScores.set(result.evaluatedBy, []);
    }
    modelData.evaluatorScores.get(result.evaluatedBy)!.push(result.totalScore);

    // Add to benchmark scores
    if (!modelData.benchmarkScores.has(result.benchmarkId)) {
      modelData.benchmarkScores.set(result.benchmarkId, new Map());
    }
    modelData.benchmarkScores.get(result.benchmarkId)!.set(result.evaluatedBy, result.totalScore);
  }

  return modelMap;
}

/**
 * Calculate Pearson correlation coefficient
 */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n !== y.length || n === 0) return 0;

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Calculate mean absolute difference
 */
function meanAbsoluteDifference(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return 0;
  const sum = x.reduce((acc, xi, i) => acc + Math.abs(xi - y[i]), 0);
  return sum / x.length;
}

/**
 * Main comparison analysis
 */
async function runComparison(): Promise<void> {
  console.log("\n=== Multi-Evaluator Comparison Analysis ===\n");

  // Load all evaluations
  console.log("Loading evaluation results...");
  const results = await loadAllEvaluations();
  console.log(`Loaded ${results.length} evaluation results\n`);

  // Get unique evaluators
  const evaluators = [...new Set(results.map(r => r.evaluatedBy))].sort();
  console.log(`Evaluators: ${evaluators.join(", ")}\n`);

  // Group by model
  const modelData = groupByModelAndEvaluator(results);

  // Calculate per-model averages by evaluator
  console.log("=== Per-Model Scores by Evaluator ===\n");

  const modelAverages: Array<{
    model: string;
    byEvaluator: Map<string, number>;
    consensus: number;
    variance: number;
  }> = [];

  for (const [model, data] of modelData) {
    const byEvaluator = new Map<string, number>();
    const allScores: number[] = [];

    for (const evaluator of evaluators) {
      const scores = data.evaluatorScores.get(evaluator) || [];
      if (scores.length > 0) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        byEvaluator.set(evaluator, avg);
        allScores.push(avg);
      }
    }

    const consensus = allScores.length > 0
      ? allScores.reduce((a, b) => a + b, 0) / allScores.length
      : 0;

    const variance = allScores.length > 0
      ? allScores.reduce((sum, s) => sum + Math.pow(s - consensus, 2), 0) / allScores.length
      : 0;

    modelAverages.push({ model, byEvaluator, consensus, variance });
  }

  // Sort by consensus score
  modelAverages.sort((a, b) => b.consensus - a.consensus);

  // Print table header
  const shortNames: Record<string, string> = {
    "openai/gpt-5.1": "GPT-5.1",
    "anthropic/claude-sonnet-4.5": "Claude",
    "google/gemini-2.5-pro": "Gemini",
  };

  console.log("| Rank | Model | " + evaluators.map(e => shortNames[e] || e.split("/")[1]).join(" | ") + " | Consensus | Variance |");
  console.log("|------|-------|" + evaluators.map(() => "-------").join("|") + "|-----------|----------|");

  let rank = 1;
  for (const { model, byEvaluator, consensus, variance } of modelAverages) {
    const shortModel = model.split("/")[1] || model;
    const scores = evaluators.map(e => {
      const score = byEvaluator.get(e);
      return score !== undefined ? score.toFixed(2) : "N/A";
    });
    console.log(`| ${rank} | ${shortModel} | ${scores.join(" | ")} | ${consensus.toFixed(2)} | ${variance.toFixed(2)} |`);
    rank++;
  }

  // Calculate inter-evaluator correlations
  console.log("\n\n=== Inter-Evaluator Correlations ===\n");

  // Build paired scores for each evaluator pair
  for (let i = 0; i < evaluators.length; i++) {
    for (let j = i + 1; j < evaluators.length; j++) {
      const eval1 = evaluators[i];
      const eval2 = evaluators[j];

      const scores1: number[] = [];
      const scores2: number[] = [];

      // Collect paired scores across all models and benchmarks
      for (const [, data] of modelData) {
        for (const [, benchScores] of data.benchmarkScores) {
          const s1 = benchScores.get(eval1);
          const s2 = benchScores.get(eval2);
          if (s1 !== undefined && s2 !== undefined) {
            scores1.push(s1);
            scores2.push(s2);
          }
        }
      }

      const correlation = pearsonCorrelation(scores1, scores2);
      const mad = meanAbsoluteDifference(scores1, scores2);

      console.log(`${shortNames[eval1] || eval1} vs ${shortNames[eval2] || eval2}:`);
      console.log(`  Pearson Correlation: ${correlation.toFixed(3)}`);
      console.log(`  Mean Absolute Difference: ${mad.toFixed(2)} points`);
      console.log(`  Paired observations: ${scores1.length}\n`);
    }
  }

  // Detect potential bias (self-evaluation)
  console.log("\n=== Evaluator Bias Analysis ===\n");

  const biasResults: Array<{
    evaluator: string;
    company: string;
    ownModelScore: number;
    otherAverage: number;
    difference: number;
  }> = [];

  for (const evaluator of evaluators) {
    let ownScores: number[] = [];
    let otherScores: number[] = [];

    for (const result of results) {
      if (result.evaluatedBy !== evaluator) continue;

      // Match by company name in model string
      const evalCompany = evaluator.split("/")[0];
      const modelCompany = result.model.split("/")[0];

      if (evalCompany === modelCompany ||
          (evalCompany === "openai" && result.model.includes("gpt")) ||
          (evalCompany === "anthropic" && result.model.includes("claude")) ||
          (evalCompany === "google" && result.model.includes("gemini"))) {
        ownScores.push(result.totalScore);
      } else {
        otherScores.push(result.totalScore);
      }
    }

    if (ownScores.length > 0 && otherScores.length > 0) {
      const ownAvg = ownScores.reduce((a, b) => a + b, 0) / ownScores.length;
      const otherAvg = otherScores.reduce((a, b) => a + b, 0) / otherScores.length;

      biasResults.push({
        evaluator: shortNames[evaluator] || evaluator,
        company: evaluator.split("/")[0],
        ownModelScore: ownAvg,
        otherAverage: otherAvg,
        difference: ownAvg - otherAvg,
      });
    }
  }

  console.log("| Evaluator | Own Model Avg | Others Avg | Difference | Bias? |");
  console.log("|-----------|---------------|------------|------------|-------|");

  for (const { evaluator, ownModelScore, otherAverage, difference } of biasResults) {
    const biasIndicator = difference > 2 ? "HIGH" : difference > 1 ? "Moderate" : "Low";
    console.log(`| ${evaluator} | ${ownModelScore.toFixed(2)} | ${otherAverage.toFixed(2)} | ${difference > 0 ? "+" : ""}${difference.toFixed(2)} | ${biasIndicator} |`);
  }

  // Generate detailed report
  console.log("\n\n=== Generating Detailed Report ===\n");

  const report = await generateDetailedReport(results, modelAverages, evaluators, shortNames);

  const reportDir = join(process.cwd(), "benchmark", "artifacts", "reports");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, "MULTI_EVALUATOR_COMPARISON.md");
  await writeFile(reportPath, report, "utf-8");

  console.log(`Detailed report saved to: ${reportPath}`);
}

/**
 * Generate detailed markdown report
 */
async function generateDetailedReport(
  results: EvaluationResultData[],
  modelAverages: Array<{
    model: string;
    byEvaluator: Map<string, number>;
    consensus: number;
    variance: number;
  }>,
  evaluators: string[],
  shortNames: Record<string, string>
): Promise<string> {
  let report = "# Multi-Evaluator Comparison Report\n\n";
  report += `**Generated:** ${new Date().toISOString()}\n`;
  report += `**Total Evaluations:** ${results.length}\n`;
  report += `**Evaluators:** ${evaluators.map(e => shortNames[e] || e).join(", ")}\n\n`;

  report += "---\n\n";

  // Overall Rankings
  report += "## Overall Rankings (Consensus Scores)\n\n";
  report += "| Rank | Model | " + evaluators.map(e => shortNames[e] || e.split("/")[1]).join(" | ") + " | **Consensus** | Variance |\n";
  report += "|------|-------|" + evaluators.map(() => "-------").join("|") + "|---------------|----------|\n";

  let rank = 1;
  for (const { model, byEvaluator, consensus, variance } of modelAverages) {
    const shortModel = model.split("/")[1] || model;
    const scores = evaluators.map(e => {
      const score = byEvaluator.get(e);
      return score !== undefined ? score.toFixed(2) : "N/A";
    });
    report += `| ${rank} | ${shortModel} | ${scores.join(" | ")} | **${consensus.toFixed(2)}** | ${variance.toFixed(2)} |\n`;
    rank++;
  }

  report += "\n---\n\n";

  // Key Findings
  report += "## Key Findings\n\n";

  // Find highest variance models (most disagreement)
  const sortedByVariance = [...modelAverages].sort((a, b) => b.variance - a.variance);

  report += "### Models with Highest Evaluator Disagreement\n\n";
  for (let i = 0; i < Math.min(5, sortedByVariance.length); i++) {
    const { model, variance, byEvaluator } = sortedByVariance[i];
    const shortModel = model.split("/")[1] || model;
    const scores = evaluators.map(e => {
      const score = byEvaluator.get(e);
      return `${shortNames[e] || e.split("/")[1]}: ${score?.toFixed(2) || "N/A"}`;
    });
    report += `${i + 1}. **${shortModel}** (Variance: ${variance.toFixed(2)})\n`;
    report += `   - ${scores.join(", ")}\n\n`;
  }

  // Find lowest variance models (most agreement)
  const sortedByVarianceAsc = [...modelAverages].sort((a, b) => a.variance - b.variance);

  report += "### Models with Highest Evaluator Agreement\n\n";
  for (let i = 0; i < Math.min(5, sortedByVarianceAsc.length); i++) {
    const { model, variance, consensus } = sortedByVarianceAsc[i];
    const shortModel = model.split("/")[1] || model;
    report += `${i + 1}. **${shortModel}** (Variance: ${variance.toFixed(2)}, Consensus: ${consensus.toFixed(2)})\n`;
  }

  report += "\n---\n\n";

  // Per-Evaluator Analysis
  report += "## Per-Evaluator Analysis\n\n";

  for (const evaluator of evaluators) {
    const evalName = shortNames[evaluator] || evaluator;
    report += `### ${evalName}\n\n`;

    // Get this evaluator's scores
    const evalResults = results.filter(r => r.evaluatedBy === evaluator);
    const avgScore = evalResults.reduce((sum, r) => sum + r.totalScore, 0) / evalResults.length;

    // Calculate score distribution
    const scoreDist = new Map<number, number>();
    for (const r of evalResults) {
      const bucket = Math.floor(r.totalScore / 5) * 5;
      scoreDist.set(bucket, (scoreDist.get(bucket) || 0) + 1);
    }

    report += `- **Average Score Given:** ${avgScore.toFixed(2)}/25\n`;
    report += `- **Total Evaluations:** ${evalResults.length}\n`;
    report += `- **Score Distribution:**\n`;

    for (const [bucket, count] of [...scoreDist.entries()].sort((a, b) => b[0] - a[0])) {
      const pct = ((count / evalResults.length) * 100).toFixed(1);
      report += `  - ${bucket}-${bucket + 4}: ${count} (${pct}%)\n`;
    }

    report += "\n";
  }

  report += "---\n\n";

  // Methodology
  report += "## Methodology\n\n";
  report += "### Metrics Used\n\n";
  report += "- **Consensus Score:** Average score across all evaluators for each model\n";
  report += "- **Variance:** Measure of disagreement between evaluators (lower = more agreement)\n";
  report += "- **Pearson Correlation:** Linear correlation between evaluator scores (-1 to 1)\n";
  report += "- **Mean Absolute Difference:** Average point difference between evaluator pairs\n\n";

  report += "### Evaluation Dimensions\n\n";
  report += "Each response was scored on 5 dimensions (0-5 points each, 25 total):\n";
  report += "1. **Structure** - Organization and logical flow\n";
  report += "2. **Depth** - Depth of reasoning and insights\n";
  report += "3. **Consistency** - Internal coherence\n";
  report += "4. **Creativity** - Novel approaches and concrete examples\n";
  report += "5. **Domain Correctness** - Technical accuracy\n\n";

  return report;
}

// Run comparison
runComparison().catch(console.error);

export {};
