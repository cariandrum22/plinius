/**
 * Evaluation environment capture.
 *
 * Records the versions and runtime that produced a run. Anything not
 * determinable is `null` (never guessed). The environment is machine-specific by
 * design; it is captured, not hashed into ids.
 */
import { COHORT_SCHEMA_VERSION } from "../campaign/cohort.js";
import { CATALOG_SCHEMA_VERSION } from "../catalog/schema.js";
import { PROMPT_SCHEMA_VERSION } from "../prompt/snapshot.js";
import { CLI_VERSION, PLINIUS_VERSION, REASONING_NORMALIZER_VERSION } from "../version.js";

export const ENVIRONMENT_SCHEMA_VERSION = 1;

export interface EvaluationEnvironment {
  schemaVersion: number;
  pliniusVersion: string;
  campaignSchemaVersion: number;
  catalogSchemaVersion: number;
  promptSchemaVersion: number;
  reasoningNormalizerVersion: string;
  cliVersion: string;
  nodeVersion: string | null;
  platform: string | null;
  architecture: string | null;
  openRouterApiVersion: string | null;
}

export interface CaptureEnvironmentOptions {
  openRouterApiVersion?: string | null;
  /** Injectable runtime for testing. */
  runtime?: { version?: string; platform?: string; arch?: string };
}

export function captureEnvironment(options: CaptureEnvironmentOptions = {}): EvaluationEnvironment {
  const runtime = options.runtime ?? {
    version: typeof process !== "undefined" ? process.version : undefined,
    platform: typeof process !== "undefined" ? process.platform : undefined,
    arch: typeof process !== "undefined" ? process.arch : undefined,
  };
  return {
    schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
    pliniusVersion: PLINIUS_VERSION,
    campaignSchemaVersion: COHORT_SCHEMA_VERSION,
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    promptSchemaVersion: PROMPT_SCHEMA_VERSION,
    reasoningNormalizerVersion: REASONING_NORMALIZER_VERSION,
    cliVersion: CLI_VERSION,
    nodeVersion: runtime.version ?? null,
    platform: runtime.platform ?? null,
    architecture: runtime.arch ?? null,
    openRouterApiVersion: options.openRouterApiVersion ?? null,
  };
}

export interface EnvironmentDiff {
  field: string;
  from: unknown;
  to: unknown;
}

/** Compare two environments; version fields matter more than platform. */
export function diffEnvironment(a: EvaluationEnvironment, b: EvaluationEnvironment): EnvironmentDiff[] {
  const diffs: EnvironmentDiff[] = [];
  for (const key of Object.keys(a) as Array<keyof EvaluationEnvironment>) {
    if (a[key] !== b[key]) diffs.push({ field: key, from: a[key], to: b[key] });
  }
  return diffs;
}

/** Version fields that must match for results to be considered comparable. */
export const CRITICAL_ENV_FIELDS: Array<keyof EvaluationEnvironment> = [
  "campaignSchemaVersion",
  "catalogSchemaVersion",
  "promptSchemaVersion",
  "reasoningNormalizerVersion",
];
