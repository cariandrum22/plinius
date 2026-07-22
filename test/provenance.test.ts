import { describe, it, expect } from "vitest";
import {
  parseProvenance,
  redactUrl,
} from "../src/types/provenance.js";
import { OpenAICompatibleBackend } from "../src/backends/openai-compatible.js";

const CAPTURED_AT = "2026-07-19T00:00:00.000Z";

const vllmProvenance = {
  runtime: { name: "vllm", version: "0.6.3" },
  container: {
    image: "vllm/vllm-openai:v0.6.3",
    digest: "sha256:deadbeef",
  },
  model: {
    repo: "Qwen/Qwen2.5-0.5B-Instruct",
    revision: "main",
    servedName: "Qwen/Qwen2.5-0.5B-Instruct",
  },
  engine: {
    dtype: "bfloat16",
    quantization: null,
    tensorParallelSize: 1,
    maxModelLen: 32768,
  },
  gpu: { count: 1, model: "NVIDIA A10G" },
  vllmArgs: { "--gpu-memory-utilization": 0.9 },
};

describe("parseProvenance", () => {
  it("maps a full vLLM runtime-provenance payload", () => {
    const p = parseProvenance(vllmProvenance, {
      backendType: "openai-compatible",
      backendUrl: "http://vllm:8000/v1",
      capturedAt: CAPTURED_AT,
    });

    expect(p.runtime).toEqual({ name: "vllm", version: "0.6.3" });
    expect(p.containerImage).toBe("vllm/vllm-openai:v0.6.3");
    expect(p.containerDigest).toBe("sha256:deadbeef");
    expect(p.modelRepo).toBe("Qwen/Qwen2.5-0.5B-Instruct");
    expect(p.modelRevision).toBe("main");
    expect(p.servedModelName).toBe("Qwen/Qwen2.5-0.5B-Instruct");
    expect(p.dtype).toBe("bfloat16");
    expect(p.quantization).toBeNull(); // explicitly unquantized
    expect(p.tensorParallelSize).toBe(1);
    expect(p.maxModelLen).toBe(32768);
    expect(p.gpu).toEqual({ count: 1, model: "NVIDIA A10G" });
    expect(p.runtimeArgs).toEqual({ "--gpu-memory-utilization": 0.9 });
    expect(p.missingFields).toEqual([]);
  });

  it("tolerates snake_case / flat key spellings", () => {
    const p = parseProvenance(
      {
        runtimeName: "vllm",
        served_model_name: "m",
        max_model_len: 4096,
        tensor_parallel_size: 2,
      },
      {
        backendType: "openai-compatible",
        backendUrl: "http://x/v1",
        capturedAt: CAPTURED_AT,
      },
    );
    expect(p.runtime?.name).toBe("vllm");
    expect(p.servedModelName).toBe("m");
    expect(p.maxModelLen).toBe(4096);
    expect(p.tensorParallelSize).toBe(2);
  });

  it("marks missing fields without throwing", () => {
    const p = parseProvenance(
      {},
      {
        backendType: "openai-compatible",
        backendUrl: "http://x/v1",
        capturedAt: CAPTURED_AT,
      },
    );
    expect(p.missingFields).toContain("runtime.name");
    expect(p.missingFields).toContain("containerImage");
    expect(p.missingFields).toContain("gpu.model");
    expect(p.runtime).toBeUndefined();
  });

  it("handles non-object payloads gracefully", () => {
    const p = parseProvenance("not-json", {
      backendType: "openai-compatible",
      capturedAt: CAPTURED_AT,
    });
    expect(p.missingFields.length).toBeGreaterThan(0);
  });
});

describe("redactUrl (secret redaction)", () => {
  it("strips embedded credentials and query strings", () => {
    expect(redactUrl("http://user:pass@vllm:8000/v1?token=abc")).toBe(
      "http://vllm:8000/v1",
    );
  });

  it("returns undefined for undefined input", () => {
    expect(redactUrl(undefined)).toBeUndefined();
  });

  it("keeps a clean URL intact", () => {
    expect(redactUrl("http://vllm:8000/v1")).toBe("http://vllm:8000/v1");
  });
});

describe("OpenAICompatibleBackend.inspect", () => {
  it("captures provenance from the provenance endpoint without secrets", async () => {
    const backend = new OpenAICompatibleBackend({
      id: "local-vllm",
      baseUrl: "http://vllm:8000/v1",
      apiKey: "super-secret",
      provenanceUrl: "http://vllm:8000/runtime-provenance",
      fetchFn: async (url) => {
        expect(url).toBe("http://vllm:8000/runtime-provenance");
        return new Response(JSON.stringify(vllmProvenance), { status: 200 });
      },
    });

    const p = await backend.inspect();
    expect(p.modelRepo).toBe("Qwen/Qwen2.5-0.5B-Instruct");
    expect(p.backendUrl).toBe("http://vllm:8000/v1");
    // Serialized provenance must never contain the API key.
    expect(JSON.stringify(p)).not.toContain("super-secret");
  });

  it("returns minimal provenance (no throw) when the endpoint fails", async () => {
    const backend = new OpenAICompatibleBackend({
      id: "local-vllm",
      baseUrl: "http://vllm:8000/v1",
      provenanceUrl: "http://vllm:8000/runtime-provenance",
      fetchFn: async () => {
        throw new Error("connection refused");
      },
    });
    const p = await backend.inspect();
    expect(p.backendType).toBe("openai-compatible");
    expect(p.missingFields.length).toBeGreaterThan(0);
  });

  it("returns minimal provenance when no provenance URL is configured", async () => {
    const backend = new OpenAICompatibleBackend({
      id: "open-server",
      baseUrl: "http://localhost:11434/v1",
      fetchFn: async () => new Response("{}"),
    });
    const p = await backend.inspect();
    expect(p.backendUrl).toBe("http://localhost:11434/v1");
    expect(p.runtime).toBeUndefined();
  });
});
