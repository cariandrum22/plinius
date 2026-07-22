#!/usr/bin/env node
/**
 * Plinius CLI - Unified entry point for benchmark, evaluation, and comparison
 */

import { runBenchmarks } from "./commands/benchmark.js";
import { runEvaluation } from "./commands/evaluate.js";
import { runComparison } from "./commands/compare.js";
import { runClean } from "./commands/clean.js";
import { runTargets } from "./commands/targets.js";
import { runSuites } from "./commands/suites.js";
import { runExperimentCommand } from "./commands/experiment.js";
import { runMatrixCommand } from "./commands/matrix.js";
import { runBlindCreate, runBlindInspect, runBlindValidate } from "./commands/blind.js";
import {
  runHumanReviewImport,
  runHumanReviewReport,
  runHumanReviewUnblind,
} from "./commands/human-review.js";
import {
  runModelsSync,
  runModelsList,
  runModelsInspect,
  runModelsDiff,
  runModelsRecommend,
} from "./commands/models.js";
import { runReproduce } from "./commands/reproduce.js";
import { runAudit } from "./commands/audit.js";
import { runBackendList, runBackendInfo, runBackendHealth } from "./commands/backend.js";
import { PLINIUS_VERSION } from "./version.js";

const VERSION = PLINIUS_VERSION;

const HELP = `
Plinius - Backend-independent AI Model Benchmark & Evaluation System

Usage:
  plinius <command> [options]

Commands:
  benchmark    Run legacy benchmark prompts against configured targets
  targets      List configured benchmark targets
  suites       List versioned benchmark suites (benchmark/suites/)
  experiment   Run a versioned experiment (repeated suite runs)
  matrix       Build a capability matrix from experiment records
  backend      Execution backends (list | info | health)
  models       OpenRouter catalog (sync | list | inspect | diff | recommend)
  reproduce    Judge reproducibility of an evaluation manifest
  audit        Audit an evaluation manifest for completeness
  blind        Blind human-review packets (create | inspect | validate)
  human-review Human reviews (import | report | unblind)
  evaluate     Evaluate benchmark results with multiple evaluators
  compare      Compare evaluations across evaluators
  clean        Remove benchmark artifacts

Benchmark options:
  --target <id>            Run a single target (default: all configured targets)
  --prompt-profile <id>    System prompt profile: none | neutral | <custom>
                           (default: per-target, falling back to "none")

Experiment / matrix options:
  --experiment <id|path>   Experiment id (benchmark/experiments/<id>.yaml) or path

Blind review:
  blind create --experiment <id> --config <file>
  blind inspect --review-set <id>
  blind validate --review-set <id>
  human-review import --review-set <id> --input <path> [--update]
  human-review report --review-set <id> [--unblind]
  human-review unblind --review-set <id>

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

/** Extract a numeric `--flag value` option. */
function numOpt(args: string[], name: string): number | undefined {
  const v = getOption(args, name);
  return v === undefined ? undefined : Number(v);
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

      case "suites":
        await runSuites();
        break;

      case "experiment": {
        const experiment = getOption(args, "--experiment");
        if (!experiment) {
          console.error("experiment requires --experiment <id|path>");
          process.exit(1);
        }
        await runExperimentCommand({ experiment });
        break;
      }

      case "matrix": {
        const experiment = getOption(args, "--experiment");
        if (!experiment) {
          console.error("matrix requires --experiment <id>");
          process.exit(1);
        }
        await runMatrixCommand({ experiment });
        break;
      }

      case "models": {
        const sub = args[1];
        if (sub === "sync") {
          await runModelsSync({ fixture: getOption(args, "--fixture") });
        } else if (sub === "list") {
          const params = getOption(args, "--required-parameters");
          await runModelsList({
            sort: getOption(args, "--sort") as never,
            author: getOption(args, "--author"),
            minContextLength: numOpt(args, "--min-context"),
            maxPromptPrice: numOpt(args, "--max-price"),
            requiredParameters: params ? params.split(",") : undefined,
            inputModality: getOption(args, "--input-modality"),
            outputModality: getOption(args, "--output-modality"),
            requireZdr: args.includes("--zdr"),
            limit: numOpt(args, "--limit"),
          });
        } else if (sub === "inspect") {
          const slug = args[2];
          if (!slug) { console.error("models inspect requires <slug>"); process.exit(1); }
          await runModelsInspect(slug);
        } else if (sub === "diff") {
          const a = args[2];
          const b = args[3];
          if (!a || !b) { console.error("models diff requires <snapshot-a> <snapshot-b>"); process.exit(1); }
          await runModelsDiff(a, b);
        } else if (sub === "recommend") {
          await runModelsRecommend();
        } else {
          console.error(`Unknown 'models' subcommand: ${sub ?? "(none)"}. Use sync | list | inspect | diff | recommend.`);
          process.exit(1);
        }
        break;
      }

      case "backend": {
        const sub = args[1];
        const backendName = args[2] && !args[2].startsWith("--") ? args[2] : getOption(args, "--backend");
        if (sub === "list") {
          await runBackendList();
        } else if (sub === "info") {
          if (!backendName) { console.error("backend info requires a backend name (openrouter | vllm)"); process.exit(1); }
          await runBackendInfo(backendName);
        } else if (sub === "health") {
          await runBackendHealth(backendName);
        } else {
          console.error(`Unknown 'backend' subcommand: ${sub ?? "(none)"}. Use list | info | health.`);
          process.exit(1);
        }
        break;
      }

      case "reproduce": {
        const manifest = getOption(args, "--manifest");
        if (!manifest) { console.error("reproduce requires --manifest <path>"); process.exit(1); }
        await runReproduce({ manifest, catalog: getOption(args, "--catalog"), prompt: getOption(args, "--prompt"), backend: getOption(args, "--backend") });
        break;
      }

      case "audit": {
        const manifest = getOption(args, "--manifest");
        if (!manifest) { console.error("audit requires --manifest <path>"); process.exit(1); }
        await runAudit({ manifest, prompt: getOption(args, "--prompt") });
        break;
      }

      case "blind": {
        const sub = args[1];
        if (sub === "create") {
          const experiment = getOption(args, "--experiment");
          const config = getOption(args, "--config");
          if (!experiment || !config) {
            console.error("blind create requires --experiment <id> --config <file>");
            process.exit(1);
          }
          await runBlindCreate({ experiment, config });
        } else if (sub === "inspect") {
          const id = getOption(args, "--review-set");
          if (!id) { console.error("blind inspect requires --review-set <id>"); process.exit(1); }
          await runBlindInspect(id);
        } else if (sub === "validate") {
          const id = getOption(args, "--review-set");
          if (!id) { console.error("blind validate requires --review-set <id>"); process.exit(1); }
          await runBlindValidate(id);
        } else {
          console.error(`Unknown 'blind' subcommand: ${sub ?? "(none)"}. Use create | inspect | validate.`);
          process.exit(1);
        }
        break;
      }

      case "human-review": {
        const sub = args[1];
        const reviewSet = getOption(args, "--review-set");
        if (sub === "import") {
          const input = getOption(args, "--input");
          if (!reviewSet || !input) {
            console.error("human-review import requires --review-set <id> --input <path>");
            process.exit(1);
          }
          await runHumanReviewImport({ reviewSet, input, update: args.includes("--update") });
        } else if (sub === "report") {
          if (!reviewSet) { console.error("human-review report requires --review-set <id>"); process.exit(1); }
          await runHumanReviewReport({ reviewSet, unblind: args.includes("--unblind") });
        } else if (sub === "unblind") {
          if (!reviewSet) { console.error("human-review unblind requires --review-set <id>"); process.exit(1); }
          await runHumanReviewUnblind(reviewSet);
        } else {
          console.error(`Unknown 'human-review' subcommand: ${sub ?? "(none)"}. Use import | report | unblind.`);
          process.exit(1);
        }
        break;
      }

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
