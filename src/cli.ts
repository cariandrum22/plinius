#!/usr/bin/env node
/**
 * Plinius CLI - Unified entry point for benchmark, evaluation, and comparison
 */

import { runBenchmarks } from "./commands/benchmark.js";
import { runEvaluation } from "./commands/evaluate.js";
import { runComparison } from "./commands/compare.js";

const VERSION = "0.2.0";

const HELP = `
Plinius - AI Model Benchmark & Evaluation System

Usage:
  plinius <command> [options]

Commands:
  benchmark    Run benchmark prompts against models
  evaluate     Evaluate benchmark results with multiple evaluators
  compare      Compare evaluations across evaluators

Options:
  -h, --help     Show this help message
  -v, --version  Show version number

Examples:
  plinius benchmark              # Run all benchmarks
  plinius evaluate               # Evaluate results with all evaluators
  plinius compare                # Generate comparison report

For more information, visit: https://github.com/your-repo/plinius
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // Handle flags
  if (!command || command === "-h" || command === "--help") {
    console.log(HELP);
    process.exit(0);
  }

  if (command === "-v" || command === "--version") {
    console.log(`Plinius v${VERSION}`);
    process.exit(0);
  }

  // Execute command
  try {
    switch (command) {
      case "benchmark":
        await runBenchmarks();
        break;

      case "evaluate":
        await runEvaluation();
        break;

      case "compare":
        await runComparison();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.log(`Run 'plinius --help' for usage information.`);
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
