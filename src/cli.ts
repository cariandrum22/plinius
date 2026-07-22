#!/usr/bin/env node
/**
 * Plinius CLI - Unified entry point for benchmark, evaluation, and comparison
 */

import { runBenchmarks } from "./commands/benchmark.js";
import { runEvaluation } from "./commands/evaluate.js";
import { runComparison } from "./commands/compare.js";
import { runClean } from "./commands/clean.js";
import { runTargets } from "./commands/targets.js";

const VERSION = "0.3.0";

const HELP = `
Plinius - Backend-independent AI Model Benchmark & Evaluation System

Usage:
  plinius <command> [options]

Commands:
  benchmark    Run benchmark prompts against configured targets
  targets      List configured benchmark targets
  evaluate     Evaluate benchmark results with multiple evaluators
  compare      Compare evaluations across evaluators
  clean        Remove benchmark artifacts

Benchmark options:
  --target <id>            Run a single target (default: all configured targets)
  --prompt-profile <id>    System prompt profile: none | neutral | <custom>
                           (default: per-target, falling back to "none")

Global options:
  -h, --help     Show this help message
  -v, --version  Show version number

Examples:
  plinius targets                              # List configured targets
  plinius benchmark                            # Run all targets
  plinius benchmark --target qwen-smoke-vllm   # Run one target (vLLM)
  plinius benchmark --prompt-profile neutral   # Use the neutral baseline prompt
  plinius evaluate                             # Evaluate results
  plinius clean benchmark                      # Remove benchmark results

For more information, visit: https://github.com/cariandrum22/plinius
`;

/** Extract a `--flag value` option from an argument list. */
function getOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "-h" || command === "--help") {
    console.log(HELP);
    process.exit(0);
  }

  if (command === "-v" || command === "--version") {
    console.log(`Plinius v${VERSION}`);
    process.exit(0);
  }

  try {
    switch (command) {
      case "benchmark":
        await runBenchmarks({
          targetId: getOption(args, "--target"),
          promptProfile: getOption(args, "--prompt-profile"),
        });
        break;

      case "targets":
        await runTargets();
        break;

      case "evaluate":
        await runEvaluation();
        break;

      case "compare":
        await runComparison();
        break;

      case "clean":
        await runClean(args[1]);
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
