import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const script = resolve("scripts/qualification-local-runtime.sh");

interface DeploymentPlan {
  schemaVersion: number;
  stageId: string;
  image: string;
  imageTag: string;
  networkDownloads: boolean;
  targets: Array<{
    container: string;
    model: string;
    revision: string;
    endpoint: string;
    gpus: number[];
    snapshot: string;
    engineArgv: string[];
  }>;
  hostPortRequirement: string;
  deepwikiAction: string;
}

function plan(): DeploymentPlan {
  return JSON.parse(execFileSync("bash", [script, "plan"], { encoding: "utf8" })) as DeploymentPlan;
}

function inspectFixture(
  value: DeploymentPlan,
  target: DeploymentPlan["targets"][number],
  hostPort: string,
  cacheRoot: string,
  deviceIds: string[],
): unknown[] {
  return [
    {
      Config: {
        Image: value.image,
        Labels: { "org.plinius.qualification-stage": value.stageId },
        Env: [`HF_HUB_CACHE=${cacheRoot}/hub`, "HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1"],
      },
      Path: "vllm",
      Args: target.engineArgv,
      HostConfig: {
        RestartPolicy: { Name: "no" },
        IpcMode: "host",
        PortBindings: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }] },
        DeviceRequests: [{ DeviceIDs: deviceIds }],
      },
      Mounts: [{ Type: "bind", Source: cacheRoot, Destination: cacheRoot, RW: false }],
    },
  ];
}

function verifyInspectFixture(
  fixture: unknown[],
  target: DeploymentPlan["targets"][number],
  hostPort: string,
  cacheRoot: string,
  expectedDeviceIds: string[],
) {
  return spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; docker() { printf %s "$INSPECT_JSON"; }; ' +
        'verify_container_plan "$NAME" "$EXPECTED_ARGS" "$HOST_PORT" "$CACHE_ROOT" "$DEVICE_IDS"',
      "bash",
      script,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        INSPECT_JSON: JSON.stringify(fixture),
        NAME: target.container,
        EXPECTED_ARGS: JSON.stringify(target.engineArgv),
        HOST_PORT: hostPort,
        CACHE_ROOT: cacheRoot,
        DEVICE_IDS: JSON.stringify(expectedDeviceIds),
      },
    },
  );
}

describe("qualification local-runtime deployment", () => {
  it("emits the frozen two-target plan without GPU 0", () => {
    const value = plan();
    expect(value.schemaVersion).toBe(2);
    expect(value.stageId).toBe("plinius-qualification-2026-08-22-diagnostic-one-shot-r1");
    expect(value.image).toBe(
      "vllm/vllm-openai@sha256:0a51ea5b4ae2dc5d81890e5173f54203d2a3ae0cfffe51b8fd2afd4391bfd967",
    );
    expect(value.imageTag).toBe("vllm/vllm-openai:v0.27.1");
    expect(value.networkDownloads).toBe(false);
    expect(value.hostPortRequirement).toBe("8001-and-8002-free");
    expect(value.deepwikiAction).toBe("untouched");
    expect(value.targets.map((target) => target.gpus)).toEqual([[1, 2], [3]]);
    expect(value.targets.flatMap((target) => target.gpus)).not.toContain(0);
  });

  it("pins endpoints, revisions, snapshots and effective engine argv", () => {
    const [qwen, gptoss] = plan().targets;
    expect(qwen).toMatchObject({
      container: "vllm-qwen",
      model: "Qwen/Qwen3.8-27B",
      revision: "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0",
      endpoint: "http://localhost:8001/v1",
      snapshot:
        "/data/hf-cache/hub/models--Qwen--Qwen3.8-27B/snapshots/1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0",
    });
    expect(qwen.engineArgv.join(" ")).toBe(
      "serve --model Qwen/Qwen3.8-27B --revision 1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0 " +
        "--served-model-name Qwen/Qwen3.8-27B --tensor-parallel-size 2 --dtype bfloat16 " +
        "--max-model-len 49152 --gpu-memory-utilization 0.90 --seed 1",
    );
    expect(gptoss).toMatchObject({
      container: "vllm-gptoss",
      model: "openai/gpt-oss-20b",
      revision: "6cee5e81ee83917806bbde320786a8fb61efebee",
      endpoint: "http://localhost:8002/v1",
      snapshot:
        "/home/ubuntu/.cache/huggingface/hub/models--openai--gpt-oss-20b/snapshots/6cee5e81ee83917806bbde320786a8fb61efebee",
    });
    expect(gptoss.engineArgv.join(" ")).toBe(
      "serve --model openai/gpt-oss-20b --revision 6cee5e81ee83917806bbde320786a8fb61efebee " +
        "--served-model-name openai/gpt-oss-20b --tensor-parallel-size 1 " +
        "--max-model-len 49152 --gpu-memory-utilization 0.90 --seed 1",
    );
  });

  it("contains no image pull, model download or bare-process kill path", () => {
    const source = readFileSync(script, "utf8");
    expect(source).not.toMatch(/docker\s+(?:image\s+)?pull/);
    expect(source).not.toMatch(/huggingface-cli|hf\s+download|snapshot_download/);
    expect(source).not.toMatch(/\bkill(?:all)?\b|\bpkill\b/);
    expect(source).not.toContain("PLINIUS_DEEPWIKI_CONTAINER");
    expect(source).not.toContain("verify_deepwiki");
    expect(source).toContain("HF_HUB_OFFLINE=1");
    expect(source).toContain("TRANSFORMERS_OFFLINE=1");
  });

  it("accepts a free host port under set -e", () => {
    const output = execFileSync(
      "bash",
      ["-c", 'source "$1"; port_is_listening() { return 1; }; assert_port_free 8001; printf FREE', "bash", script],
      { encoding: "utf8" },
    );
    expect(output).toBe("FREE");
  });

  it("rejects a listening host port", () => {
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; port_is_listening() { return 0; }; assert_port_free 8001', "bash", script],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TCP port 8001 is already listening");
  });

  it("accepts the exact Qwen and gpt-oss Docker device requests", () => {
    const value = plan();
    const cases = [
      { target: value.targets[0], port: "8001", cache: "/data/hf-cache", devices: ["1", "2"] },
      { target: value.targets[1], port: "8002", cache: "/home/ubuntu/.cache/huggingface", devices: ["3"] },
    ];
    for (const item of cases) {
      const fixture = inspectFixture(value, item.target, item.port, item.cache, item.devices);
      const result = verifyInspectFixture(fixture, item.target, item.port, item.cache, item.devices);
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it("rejects a Docker device request that differs from the frozen plan", () => {
    const value = plan();
    const qwen = value.targets[0];
    const fixture = inspectFixture(value, qwen, "8001", "/data/hf-cache", ["1", "3"]);
    const result = verifyInspectFixture(fixture, qwen, "8001", "/data/hf-cache", ["1", "2"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("created container does not match the frozen plan");
  });
});
