/**
 * Runtime provenance for an inference deployment.
 *
 * Provenance is captured from a backend (for vLLM, from a machine-readable
 * runtime-provenance JSON endpoint) and persisted alongside benchmark results
 * so a run can be reproduced and audited. Optional fields that a deployment
 * does not expose are left undefined and listed in `missingFields`; a missing
 * field must never fail an otherwise valid benchmark. Credentials are never
 * stored.
 */

export interface GpuInfo {
  count?: number;
  model?: string;
}

export interface RuntimeInfo {
  name?: string;
  version?: string;
}

export interface BackendProvenance {
  /** Backend type, e.g. "openai-compatible" | "openrouter". */
  backendType: string;
  /** Backend URL identifier with credentials removed. */
  backendUrl?: string;

  runtime?: RuntimeInfo;
  containerImage?: string;
  containerDigest?: string;
  modelRepo?: string;
  modelRevision?: string;
  servedModelName?: string;
  dtype?: string;
  /** Quantization scheme, or null when the model is unquantized. */
  quantization?: string | null;
  tensorParallelSize?: number;
  maxModelLen?: number;
  gpu?: GpuInfo;
  /** Relevant runtime (e.g. vLLM engine) arguments. */
  runtimeArgs?: Record<string, unknown>;

  /** Canonical field names that were not available from the source. */
  missingFields: string[];
  /** ISO timestamp when provenance was captured. */
  capturedAt: string;
  /** Original payload as received, retained for auditing (never secrets). */
  raw?: Record<string, unknown>;
}

/**
 * Remove credentials and volatile query material from a URL so it can be
 * safely stored as an identifier. Falls back to a best-effort string strip
 * when the input is not a parseable absolute URL.
 */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // Not an absolute URL: strip any embedded "user:pass@" and query string.
    return url.replace(/\/\/[^/@]*@/, "//").replace(/[?#].*$/, "");
  }
}

/** Read a nested value from an untyped object using a dotted path. */
function pick(source: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

/** Return the first defined value among several candidate dotted paths. */
function firstDefined(
  source: Record<string, unknown>,
  paths: string[],
): unknown {
  for (const path of paths) {
    const value = pick(source, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The canonical provenance fields we attempt to populate. Any of these left
 * undefined after parsing is reported in `missingFields`.
 */
const CANONICAL_FIELDS = [
  "runtime.name",
  "runtime.version",
  "containerImage",
  "containerDigest",
  "modelRepo",
  "modelRevision",
  "servedModelName",
  "dtype",
  "quantization",
  "tensorParallelSize",
  "maxModelLen",
  "gpu.count",
  "gpu.model",
] as const;

export interface ParseProvenanceOptions {
  backendType: string;
  backendUrl?: string;
  capturedAt: string;
  /** Retain the raw payload in the result. */
  keepRaw?: boolean;
}

/**
 * Parse a runtime-provenance payload into a normalized {@link BackendProvenance}.
 *
 * Tolerant of several key spellings so a range of runtime-provenance emitters
 * (AI-Playground's vLLM endpoint and others) can be consumed without changes
 * here. Never throws on missing fields; unknown fields are simply omitted and
 * marked in `missingFields`.
 */
export function parseProvenance(
  raw: unknown,
  options: ParseProvenanceOptions,
): BackendProvenance {
  const source: Record<string, unknown> =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const runtimeName = asString(
    firstDefined(source, ["runtime.name", "runtimeName", "engine.name"]),
  );
  const runtimeVersion = asString(
    firstDefined(source, [
      "runtime.version",
      "runtimeVersion",
      "engine.version",
      "version",
    ]),
  );
  const containerImage = asString(
    firstDefined(source, [
      "container.image",
      "containerImage",
      "image",
    ]),
  );
  const containerDigest = asString(
    firstDefined(source, [
      "container.digest",
      "containerDigest",
      "imageDigest",
      "digest",
    ]),
  );
  const modelRepo = asString(
    firstDefined(source, ["model.repo", "modelRepo", "model.repository"]),
  );
  const modelRevision = asString(
    firstDefined(source, [
      "model.revision",
      "modelRevision",
      "revision",
      "model.commit",
    ]),
  );
  const servedModelName = asString(
    firstDefined(source, [
      "model.servedName",
      "servedModelName",
      "model.served_model_name",
      "served_model_name",
    ]),
  );
  const dtype = asString(firstDefined(source, ["engine.dtype", "dtype"]));

  const rawQuantization = firstDefined(source, [
    "engine.quantization",
    "quantization",
  ]);
  // Distinguish "explicitly unquantized" (null) from "unknown" (undefined).
  const quantization =
    rawQuantization === null ? null : asString(rawQuantization);

  const tensorParallelSize = asNumber(
    firstDefined(source, [
      "engine.tensorParallelSize",
      "tensorParallelSize",
      "tensor_parallel_size",
    ]),
  );
  const maxModelLen = asNumber(
    firstDefined(source, [
      "engine.maxModelLen",
      "maxModelLen",
      "max_model_len",
    ]),
  );
  const gpuCount = asNumber(
    firstDefined(source, ["gpu.count", "gpuCount", "gpus"]),
  );
  const gpuModel = asString(
    firstDefined(source, ["gpu.model", "gpuModel", "gpu.name"]),
  );
  const runtimeArgs = firstDefined(source, [
    "vllmArgs",
    "runtimeArgs",
    "engine.args",
    "args",
  ]);

  const provenance: BackendProvenance = {
    backendType: options.backendType,
    backendUrl: redactUrl(options.backendUrl),
    runtime:
      runtimeName || runtimeVersion
        ? { name: runtimeName, version: runtimeVersion }
        : undefined,
    containerImage,
    containerDigest,
    modelRepo,
    modelRevision,
    servedModelName,
    dtype,
    quantization,
    tensorParallelSize,
    maxModelLen,
    gpu:
      gpuCount !== undefined || gpuModel
        ? { count: gpuCount, model: gpuModel }
        : undefined,
    runtimeArgs:
      runtimeArgs && typeof runtimeArgs === "object"
        ? (runtimeArgs as Record<string, unknown>)
        : undefined,
    missingFields: [],
    capturedAt: options.capturedAt,
    raw: options.keepRaw ? source : undefined,
  };

  provenance.missingFields = CANONICAL_FIELDS.filter(
    (field) =>
      pick(provenance as unknown as Record<string, unknown>, field) ===
      undefined,
  );

  return provenance;
}

/**
 * Build a minimal provenance record for backends that expose no runtime
 * provenance endpoint (all canonical fields marked missing).
 */
export function minimalProvenance(options: ParseProvenanceOptions): BackendProvenance {
  return parseProvenance({}, options);
}
