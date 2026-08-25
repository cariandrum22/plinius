import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  localCanaryRequestBody,
  localCanaryRequestSha256,
  readExecutionAttestationFile,
  validateExecutionAttestation,
  type ExecutionAttestation,
  type ExpectedExecutionAttestation,
} from "../src/qualification/execution-attestation.js";
import {
  buildExpectedExecutionAttestationFromParent,
  ONE_SHOT_STAGE_ID,
  prepareOneShotBootstrap,
  resolveDriverMode,
} from "../qualification-driver.mjs";

const NOW = "2026-08-25T08:00:00.000Z";
const QWEN = "Qwen/Qwen3.8-27B";
const GPT_OSS = "openai/gpt-oss-20b";
const roots: string[] = [];
const REAL_PARENT_ROOT = process.env.PLINIUS_R7_PARENT_ROOT;

const expected: ExpectedExecutionAttestation = {
  campaignId: "plinius-qualification-2026-08-22-v1",
  stageId: "plinius-qualification-2026-08-22-diagnostic-one-shot-r1",
  host: {
    instanceId: "i-020008472625521bd",
    instanceType: "p4d.24xlarge",
    availabilityZone: "us-west-2b",
    operatingSystem: "Ubuntu",
    gpuModel: "NVIDIA A100-SXM4-40GB",
    gpuCount: 8,
  },
  targets: [
    {
      requestedSlug: QWEN,
      endpoint: "http://localhost:8001/v1",
      servedModelId: QWEN,
      checkpointRevision: "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0",
      weightManifestSha256: `sha256:${"a".repeat(64)}`,
      ociImageDigest: `sha256:${"b".repeat(64)}`,
      engineArgv: ["serve", "--model", QWEN],
      canaryRequestSha256: localCanaryRequestSha256(QWEN),
    },
    {
      requestedSlug: GPT_OSS,
      endpoint: "http://localhost:8002/v1",
      servedModelId: GPT_OSS,
      checkpointRevision: "6cee5e81ee83917806bbde320786a8fb61efebee",
      weightManifestSha256: `sha256:${"c".repeat(64)}`,
      ociImageDigest: `sha256:${"b".repeat(64)}`,
      engineArgv: ["serve", "--model", GPT_OSS],
      canaryRequestSha256: localCanaryRequestSha256(GPT_OSS),
    },
  ],
};

function validAttestation(): ExecutionAttestation {
  return {
    schemaVersion: 1,
    campaignId: expected.campaignId,
    stageId: expected.stageId,
    supervisor: "Fable",
    observationSource: "live-ubuntu",
    capturedAtUtc: "2026-08-25T07:59:30.000Z",
    host: { ...expected.host },
    targets: expected.targets.map((target) => ({
      requestedSlug: target.requestedSlug,
      endpoint: target.endpoint,
      servedModelId: target.servedModelId,
      checkpointRevision: target.checkpointRevision,
      weightManifestSha256: target.weightManifestSha256,
      ociImageDigest: target.ociImageDigest,
      ociProcess: {
        path: "/usr/local/bin/vllm",
        args: [...target.engineArgv],
        engineArgvSource: "args-only",
        engineArgv: [...target.engineArgv],
      },
      canary: {
        campaignExternal: true,
        requestSha256: target.canaryRequestSha256,
        responseSha256: `sha256:${"d".repeat(64)}`,
        responseBytes: 42,
        responseModelId: target.servedModelId,
        finishReason: "stop",
        outputNonEmpty: true,
        passed: true,
        completedAtUtc: "2026-08-25T07:59:20.000Z",
      },
    })),
  };
}

function clone(): ExecutionAttestation {
  return structuredClone(validAttestation());
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Fable execution attestation", () => {
  it("pins the external canary body and model-specific digests", () => {
    expect(JSON.parse(localCanaryRequestBody(QWEN))).toMatchObject({
      model: QWEN,
      max_tokens: 1024,
      temperature: 0,
      top_p: 1,
      seed: 1,
    });
    expect(localCanaryRequestSha256(QWEN)).toBe(
      "sha256:062446ab5bee921c528bb1d1448435d495349e53d72cbd120bb32ab90d75bc64",
    );
    expect(localCanaryRequestSha256(GPT_OSS)).toBe(
      "sha256:f3457bf9e72c120878a390cd13691aab954087b000666e719b6fe087344b32c0",
    );
  });

  it("accepts one fresh exact Ubuntu observation", () => {
    expect(validateExecutionAttestation(validAttestation(), expected, NOW)).toEqual({
      ok: true,
      attestation: validAttestation(),
    });
  });

  it.each([
    ["stale", (a: ExecutionAttestation) => { a.capturedAtUtc = "2026-08-25T07:54:59.000Z"; }],
    ["future", (a: ExecutionAttestation) => { a.capturedAtUtc = "2026-08-25T08:00:01.000Z"; }],
    ["wrong campaign", (a: ExecutionAttestation) => { a.campaignId = "wrong-campaign"; }],
    ["wrong stage", (a: ExecutionAttestation) => { a.stageId = "wrong-stage"; }],
    ["wrong instance", (a: ExecutionAttestation) => { a.host.instanceId = "i-deadbeef"; }],
    ["wrong host type", (a: ExecutionAttestation) => { a.host.instanceType = "g5.48xlarge"; }],
    ["wrong zone", (a: ExecutionAttestation) => { a.host.availabilityZone = "us-west-2a"; }],
    ["wrong GPU", (a: ExecutionAttestation) => { a.host.gpuModel = "NVIDIA H100 80GB HBM3"; }],
    ["wrong GPU count", (a: ExecutionAttestation) => { a.host.gpuCount = 7; }],
    ["missing target", (a: ExecutionAttestation) => { a.targets.pop(); }],
    ["extra target", (a: ExecutionAttestation) => { a.targets.push(structuredClone(a.targets[0])); }],
    ["duplicate target", (a: ExecutionAttestation) => { a.targets[1].requestedSlug = a.targets[0].requestedSlug; }],
    ["wrong endpoint", (a: ExecutionAttestation) => { a.targets[0].endpoint = "http://localhost:9999/v1"; }],
    ["wrong served model", (a: ExecutionAttestation) => { a.targets[0].servedModelId = "wrong/model"; }],
    ["wrong checkpoint", (a: ExecutionAttestation) => { a.targets[0].checkpointRevision = "f".repeat(40); }],
    ["wrong weights", (a: ExecutionAttestation) => { a.targets[0].weightManifestSha256 = `sha256:${"f".repeat(64)}`; }],
    ["wrong image", (a: ExecutionAttestation) => { a.targets[0].ociImageDigest = `sha256:${"f".repeat(64)}`; }],
    ["wrong engine argv", (a: ExecutionAttestation) => { a.targets[0].ociProcess.engineArgv.push("--quantization", "awq"); }],
    ["argv not derived", (a: ExecutionAttestation) => { a.targets[0].ociProcess.args.push("--dtype", "float16"); }],
    ["wrong canary request", (a: ExecutionAttestation) => { a.targets[0].canary.requestSha256 = `sha256:${"e".repeat(64)}`; }],
    ["wrong canary model", (a: ExecutionAttestation) => { a.targets[0].canary.responseModelId = "wrong/model"; }],
    ["canary after attestation", (a: ExecutionAttestation) => { a.targets[0].canary.completedAtUtc = "2026-08-25T07:59:31.000Z"; }],
    ["stale canary", (a: ExecutionAttestation) => { a.targets[0].canary.completedAtUtc = "2026-08-25T07:54:29.000Z"; }],
  ])("rejects %s", (_name, mutate) => {
    const attestation = clone();
    mutate(attestation);
    const result = validateExecutionAttestation(attestation, expected, NOW);
    expect(result.ok).toBe(false);
  });

  it("rejects a failed or empty canary at the strict schema boundary", () => {
    const attestation = clone() as unknown as Record<string, unknown>;
    const targets = attestation.targets as Array<Record<string, unknown>>;
    const canary = targets[0].canary as Record<string, unknown>;
    canary.passed = false;
    canary.outputNonEmpty = false;
    expect(validateExecutionAttestation(attestation, expected, NOW).ok).toBe(false);
  });

  it("reads only an absolute, owner-only, regular JSON file", () => {
    const root = mkdtempSync(join(tmpdir(), "plinius-fable-attestation-"));
    roots.push(root);
    const path = join(root, "attestation.json");
    const body = JSON.stringify(validAttestation(), null, 2);
    writeFileSync(path, body, { mode: 0o600 });
    const loaded = readExecutionAttestationFile(path, expected, NOW);
    expect(loaded.attestation).toEqual(validAttestation());
    expect(loaded.bytes).toBe(Buffer.byteLength(body));
    expect(loaded.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    chmodSync(path, 0o644);
    expect(() => readExecutionAttestationFile(path, expected, NOW)).toThrow(/mode 0600/);
    chmodSync(path, 0o700);
    expect(() => readExecutionAttestationFile(path, expected, NOW)).toThrow(/mode 0600/);
    expect(() => readExecutionAttestationFile("relative.json", expected, NOW)).toThrow(/absolute/);

    chmodSync(path, 0o600);
    const link = join(root, "attestation-link.json");
    symlinkSync(path, link);
    expect(() => readExecutionAttestationFile(link, expected, NOW)).toThrow(/non-symlink/);
  });
});

describe("one-shot production boundary", () => {
  function bootstrapEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      CONTINUATION_OUTPUT_ROOT: "/tmp/output",
      PARENT_EVIDENCE_ROOT: "/tmp/parent",
      PARENT_BUNDLE_PATH: "/tmp/parent.tar.gz",
      FABLE_EXECUTION_ATTESTATION_PATH: "/tmp/attestation.json",
      OPENROUTER_API_KEY: "must-be-read-last",
      ...overrides,
    };
  }

  function loadedAttestation() {
    const attestation = validAttestation();
    const rawBody = JSON.stringify(attestation);
    return {
      attestation,
      rawBody,
      sha256: `sha256:${"a".repeat(64)}`,
      bytes: Buffer.byteLength(rawBody),
    };
  }

  it("accepts only the new one-shot continuation mode", () => {
    expect(resolveDriverMode("diagnostic-one-shot-r1")).toBe("diagnostic-one-shot-r1");
    expect(() => resolveDriverMode("diagnostic-continuation-r1")).toThrow(/retired/);
  });

  it("rejects any resume variable before reading the credential", () => {
    const reads: string[] = [];
    const env = bootstrapEnv({ CONTINUATION_RESUME: "0" });
    expect(() =>
      prepareOneShotBootstrap({
        readEnv: (name) => {
          reads.push(name);
          return env[name];
        },
      }),
    ).toThrow(/CONTINUATION_RESUME is prohibited/);
    expect(reads).not.toContain("OPENROUTER_API_KEY");
  });

  it("validates authority digests and attestation before reading the credential", () => {
    const events: string[] = [];
    const env = bootstrapEnv();
    const result = prepareOneShotBootstrap({
      readEnv: (name) => {
        events.push(`env:${name}`);
        return env[name];
      },
      now: () => NOW,
      buildExpected: () => {
        events.push("authority:local");
        return expected;
      },
      loadExpectedBindings: () => [],
      verifyHistorical: () => {
        events.push("authority:historical");
        return { ok: true, details: [] };
      },
      readAttestation: () => {
        events.push("attestation:validate");
        return loadedAttestation();
      },
    });
    expect(result.orKey).toBe("must-be-read-last");
    expect(events.indexOf("authority:historical")).toBeLessThan(events.indexOf("attestation:validate"));
    expect(events.indexOf("attestation:validate")).toBeLessThan(events.indexOf("env:OPENROUTER_API_KEY"));
  });

  it("does not read the credential after an authority or attestation failure", () => {
    for (const failure of ["authority", "attestation"] as const) {
      const reads: string[] = [];
      const env = bootstrapEnv();
      expect(() =>
        prepareOneShotBootstrap({
          readEnv: (name) => {
            reads.push(name);
            return env[name];
          },
          now: () => NOW,
          buildExpected: () => expected,
          loadExpectedBindings: () => [],
          verifyHistorical: () =>
            failure === "authority" ? { ok: false, details: [] } : { ok: true, details: [] },
          readAttestation: () => {
            if (failure === "attestation") throw new Error("invalid attestation");
            return loadedAttestation();
          },
        }),
      ).toThrow();
      expect(reads).not.toContain("OPENROUTER_API_KEY");
    }
  });

  it("pins the attestation and runtime stage identifiers together", () => {
    expect(expected.stageId).toBe(ONE_SHOT_STAGE_ID);
  });

  (REAL_PARENT_ROOT ? it : it.skip)("re-derives the exact two-target expectation from fixed-digest parent Evidence", () => {
    const derived = buildExpectedExecutionAttestationFromParent(REAL_PARENT_ROOT!);
    expect(derived.host).toEqual(expected.host);
    expect(derived.targets.map((target) => target.requestedSlug)).toEqual([QWEN, GPT_OSS]);
    expect(derived.targets[0].weightManifestSha256).toBe(
      "sha256:d67d740e1ce3a0eda51cadf908c3d9f42248ccf0648d7c91448b81a00d943eda",
    );
    expect(derived.targets[1].weightManifestSha256).toBe(
      "sha256:2e68a02214cd6eec14b8135f954e8a8d010d330f32bdbede4fd7b02b241647b9",
    );
    expect(derived.targets.every((target) => target.ociImageDigest ===
      "sha256:0a51ea5b4ae2dc5d81890e5173f54203d2a3ae0cfffe51b8fd2afd4391bfd967")).toBe(true);
    expect(derived.targets[0].engineArgv.slice(0, 3)).toEqual(["serve", "--model", QWEN]);
    expect(derived.targets[1].engineArgv.slice(0, 3)).toEqual(["serve", "--model", GPT_OSS]);
  });
});
