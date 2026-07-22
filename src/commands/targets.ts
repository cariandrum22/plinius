/**
 * `plinius targets` — list configured benchmark targets.
 */
import {
  ExperimentConfig,
  defaultExperimentConfig,
  resolvedServedModelName,
} from "../experiment/config.js";

export async function runTargets(
  config: ExperimentConfig = defaultExperimentConfig,
): Promise<void> {
  console.log(`\n=== Configured Benchmark Targets ===\n`);

  if (config.targets.length === 0) {
    console.log("No targets configured.");
    return;
  }

  for (const target of config.targets) {
    const backendDef = config.backends[target.backend];
    const backendType = backendDef ? backendDef.type : "UNKNOWN BACKEND";
    console.log(`• ${target.id}`);
    console.log(`    backend:      ${target.backend} (${backendType})`);
    console.log(`    model:        ${target.model}`);
    console.log(`    servedModel:  ${resolvedServedModelName(target)}`);
    if (backendDef && backendDef.type === "openai-compatible") {
      console.log(`    baseUrl:      ${backendDef.baseUrl}`);
    }
    if (target.seed !== undefined) {
      console.log(`    seed:         ${target.seed}`);
    }
    console.log("");
  }

  console.log(`Run one with: plinius benchmark --target <id>`);
}
