import { execFileSync } from "node:child_process";
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
});
