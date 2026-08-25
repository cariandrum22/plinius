import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { z } from "zod";

export const EXECUTION_ATTESTATION_SCHEMA_VERSION = 1;
export const EXECUTION_ATTESTATION_MAX_AGE_SECONDS = 300;
export const EXECUTION_ATTESTATION_MAX_BYTES = 1_048_576;

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const checkpointSchema = z.string().regex(/^[0-9a-f]{40}$/);
const tokenSchema = z.string().min(1).refine((value) => !value.includes("\0"), "must not contain NUL");
const timestampSchema = z.string().datetime({ offset: true });

const ociProcessSchema = z.object({
  path: tokenSchema,
  args: z.array(tokenSchema),
  engineArgvSource: z.enum(["path-plus-args", "args-only"]),
  engineArgv: z.array(tokenSchema).min(1),
}).strict();

const canarySchema = z.object({
  campaignExternal: z.literal(true),
  requestSha256: sha256Schema,
  responseSha256: sha256Schema,
  responseBytes: z.number().int().positive(),
  responseModelId: tokenSchema,
  finishReason: z.literal("stop"),
  outputNonEmpty: z.literal(true),
  passed: z.literal(true),
  completedAtUtc: timestampSchema,
}).strict();

const targetSchema = z.object({
  requestedSlug: tokenSchema,
  endpoint: z.string().url(),
  servedModelId: tokenSchema,
  checkpointRevision: checkpointSchema,
  weightManifestSha256: sha256Schema,
  ociImageDigest: sha256Schema,
  ociProcess: ociProcessSchema,
  canary: canarySchema,
}).strict();

export const executionAttestationSchema = z.object({
  schemaVersion: z.literal(EXECUTION_ATTESTATION_SCHEMA_VERSION),
  campaignId: tokenSchema,
  stageId: tokenSchema,
  supervisor: z.literal("Fable"),
  observationSource: z.literal("live-ubuntu"),
  capturedAtUtc: timestampSchema,
  host: z.object({
    instanceId: z.string().regex(/^i-[0-9a-f]+$/),
    instanceType: tokenSchema,
    availabilityZone: tokenSchema,
    operatingSystem: z.literal("Ubuntu"),
    gpuModel: tokenSchema,
    gpuCount: z.number().int().positive(),
  }).strict(),
  targets: z.array(targetSchema).length(2),
}).strict();

export type ExecutionAttestation = z.infer<typeof executionAttestationSchema>;
export type ExecutionAttestationTarget = ExecutionAttestation["targets"][number];

export interface ExpectedExecutionTarget {
  requestedSlug: string;
  endpoint: string;
  servedModelId: string;
  checkpointRevision: string;
  weightManifestSha256: string;
  ociImageDigest: string;
  engineArgv: string[];
  canaryRequestSha256: string;
}

export interface ExpectedExecutionAttestation {
  campaignId: string;
  stageId: string;
  host: {
    instanceId: string;
    instanceType: string;
    availabilityZone: string;
    operatingSystem: "Ubuntu";
    gpuModel: string;
    gpuCount: number;
  };
  targets: ExpectedExecutionTarget[];
}

export type ExecutionAttestationValidation =
  | { ok: true; attestation: ExecutionAttestation }
  | { ok: false; reasons: string[] };

export interface LoadedExecutionAttestation {
  attestation: ExecutionAttestation;
  rawBody: string;
  sha256: string;
  bytes: number;
}

function sha256(body: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex")}`;
}

function sameTokens(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((token, index) => token === expected[index]);
}

function observedEngineArgv(target: ExecutionAttestationTarget): string[] {
  return target.ociProcess.engineArgvSource === "path-plus-args"
    ? [target.ociProcess.path, ...target.ociProcess.args]
    : [...target.ociProcess.args];
}

function mismatch(reasons: string[], label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) reasons.push(`${label}_mismatch`);
}

export function localCanaryRequestBody(model: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with exactly FABLE-CANARY-OK and nothing else." }],
    max_tokens: 1024,
    temperature: 0,
    top_p: 1,
    seed: 1,
  });
}

export function localCanaryRequestSha256(model: string): string {
  return sha256(localCanaryRequestBody(model));
}

export function validateExecutionAttestation(
  input: unknown,
  expected: ExpectedExecutionAttestation,
  nowUtc: string,
): ExecutionAttestationValidation {
  const parsed = executionAttestationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reasons: parsed.error.issues.map((issue) => `schema:${issue.path.join(".") || "root"}:${issue.code}`),
    };
  }

  const attestation = parsed.data;
  const reasons: string[] = [];
  const nowMs = Date.parse(nowUtc);
  const capturedMs = Date.parse(attestation.capturedAtUtc);
  if (!Number.isFinite(nowMs)) reasons.push("evaluation_time_invalid");
  else if (capturedMs > nowMs) reasons.push("captured_at_future");
  else if ((nowMs - capturedMs) / 1000 > EXECUTION_ATTESTATION_MAX_AGE_SECONDS) reasons.push("attestation_stale");

  mismatch(reasons, "campaign_id", attestation.campaignId, expected.campaignId);
  mismatch(reasons, "stage_id", attestation.stageId, expected.stageId);
  mismatch(reasons, "host_instance_id", attestation.host.instanceId, expected.host.instanceId);
  mismatch(reasons, "host_instance_type", attestation.host.instanceType, expected.host.instanceType);
  mismatch(reasons, "host_availability_zone", attestation.host.availabilityZone, expected.host.availabilityZone);
  mismatch(reasons, "host_operating_system", attestation.host.operatingSystem, expected.host.operatingSystem);
  mismatch(reasons, "host_gpu_model", attestation.host.gpuModel, expected.host.gpuModel);
  mismatch(reasons, "host_gpu_count", attestation.host.gpuCount, expected.host.gpuCount);

  const expectedBySlug = new Map(expected.targets.map((target) => [target.requestedSlug, target]));
  if (expectedBySlug.size !== expected.targets.length) reasons.push("expected_target_duplicate");
  const observedBySlug = new Map<string, ExecutionAttestationTarget>();
  for (const target of attestation.targets) {
    if (observedBySlug.has(target.requestedSlug)) reasons.push(`target_duplicate:${target.requestedSlug}`);
    observedBySlug.set(target.requestedSlug, target);
  }
  for (const slug of observedBySlug.keys()) {
    if (!expectedBySlug.has(slug)) reasons.push(`target_extra:${slug}`);
  }

  for (const [slug, exp] of expectedBySlug) {
    const target = observedBySlug.get(slug);
    if (!target) {
      reasons.push(`target_missing:${slug}`);
      continue;
    }
    mismatch(reasons, `${slug}:endpoint`, target.endpoint, exp.endpoint);
    mismatch(reasons, `${slug}:served_model`, target.servedModelId, exp.servedModelId);
    mismatch(reasons, `${slug}:checkpoint_revision`, target.checkpointRevision, exp.checkpointRevision);
    mismatch(reasons, `${slug}:weight_manifest`, target.weightManifestSha256, exp.weightManifestSha256);
    mismatch(reasons, `${slug}:oci_image`, target.ociImageDigest, exp.ociImageDigest);

    const derivedArgv = observedEngineArgv(target);
    if (!sameTokens(derivedArgv, target.ociProcess.engineArgv)) reasons.push(`${slug}:engine_argv_not_derived`);
    if (!sameTokens(target.ociProcess.engineArgv, exp.engineArgv)) reasons.push(`${slug}:engine_argv_mismatch`);

    mismatch(reasons, `${slug}:canary_request`, target.canary.requestSha256, exp.canaryRequestSha256);
    mismatch(reasons, `${slug}:canary_response_model`, target.canary.responseModelId, exp.servedModelId);
    const canaryCompletedMs = Date.parse(target.canary.completedAtUtc);
    if (canaryCompletedMs > capturedMs) reasons.push(`${slug}:canary_after_attestation`);
    else if (capturedMs - canaryCompletedMs > EXECUTION_ATTESTATION_MAX_AGE_SECONDS * 1000)
      reasons.push(`${slug}:canary_stale`);
  }

  return reasons.length === 0 ? { ok: true, attestation } : { ok: false, reasons };
}

export function readExecutionAttestationFile(
  path: string,
  expected: ExpectedExecutionAttestation,
  nowUtc: string,
): LoadedExecutionAttestation {
  if (!isAbsolute(path)) throw new Error("FABLE_EXECUTION_ATTESTATION_PATH must be absolute");
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error("Fable execution attestation must open as a regular non-symlink file");
  }

  let rawBody: string;
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("Fable execution attestation must be a regular non-symlink file");
    if (before.size > EXECUTION_ATTESTATION_MAX_BYTES) throw new Error("Fable execution attestation exceeds size limit");
    const permissions = before.mode & 0o777;
    if ((permissions & 0o177) !== 0 || (permissions & 0o400) === 0)
      throw new Error("Fable execution attestation must have mode 0600 or stricter");
    if (typeof process.getuid === "function" && before.uid !== process.getuid())
      throw new Error("Fable execution attestation must be owned by the executing uid");

    rawBody = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Fable execution attestation changed while being read");
    }
  } finally {
    closeSync(fd);
  }

  let input: unknown;
  try {
    input = JSON.parse(rawBody);
  } catch {
    throw new Error("Fable execution attestation is not valid JSON");
  }
  const validation = validateExecutionAttestation(input, expected, nowUtc);
  if (!validation.ok) throw new Error(`Fable execution attestation rejected: ${validation.reasons.join(",")}`);
  return {
    attestation: validation.attestation,
    rawBody,
    sha256: sha256(rawBody),
    bytes: Buffer.byteLength(rawBody, "utf8"),
  };
}
