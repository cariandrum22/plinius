/**
 * Executable allowlist and availability detection.
 *
 * Command checks may only reference tools defined here. The `tool` key in a
 * check is resolved to a concrete executable; author-defined argv is appended.
 * Model output never contributes any part of the executable or arguments.
 *
 * Availability is probed once per process. A tool that is not installed is
 * reported as `not_available` (never pass/fail), so a missing verifier makes a
 * result inconclusive rather than failing it.
 */
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ExecutionSandbox } from "./sandbox.js";

export interface ToolSpec {
  /** Allowlist key referenced by command checks. */
  key: string;
  /** Concrete executable resolved on PATH (or an absolute path). */
  executable: string;
  /** Arguments used to probe availability. */
  versionArgs: string[];
  description: string;
}

/**
 * The allowlist. Coding + formal-method tools required by Phase 1. Add entries
 * here to authorize new executables; benchmarks can never widen this set.
 */
export const TOOL_ALLOWLIST: Record<string, ToolSpec> = {
  node: {
    key: "node",
    executable: "node",
    versionArgs: ["--version"],
    description: "Node.js runtime (TypeScript/JS acceptance tests)",
  },
  python3: {
    key: "python3",
    executable: "python3",
    versionArgs: ["--version"],
    description: "CPython 3 interpreter",
  },
  cargo: {
    key: "cargo",
    executable: "cargo",
    versionArgs: ["--version"],
    description: "Rust cargo (check / test / clippy)",
  },
  tlc: {
    key: "tlc",
    executable: "tlc",
    versionArgs: ["-help"],
    description: "TLA+ TLC model checker",
  },
  "apalache-mc": {
    key: "apalache-mc",
    executable: "apalache-mc",
    versionArgs: ["version"],
    description: "Apalache symbolic model checker for TLA+",
  },
  lean: {
    key: "lean",
    executable: "lean",
    versionArgs: ["--version"],
    description: "Lean theorem prover",
  },
  coqc: {
    key: "coqc",
    executable: "coqc",
    versionArgs: ["--version"],
    description: "Coq compiler",
  },
  "tamarin-prover": {
    key: "tamarin-prover",
    executable: "tamarin-prover",
    versionArgs: ["--version"],
    description: "Tamarin security-protocol prover",
  },
  fst: {
    key: "fst",
    executable: "fstar.exe",
    versionArgs: ["--version"],
    description: "F* verification system",
  },
};

export function resolveTool(key: string): ToolSpec | undefined {
  return TOOL_ALLOWLIST[key];
}

export interface ToolAvailability {
  key: string;
  available: boolean;
  version?: string;
  detail?: string;
}

const availabilityCache = new Map<string, ToolAvailability>();

/**
 * Probe whether a tool is installed and runnable. Results are cached per key.
 */
export async function checkToolAvailability(
  key: string,
  sandbox: ExecutionSandbox,
): Promise<ToolAvailability> {
  const cached = availabilityCache.get(key);
  if (cached) return cached;

  const spec = TOOL_ALLOWLIST[key];
  if (!spec) {
    const result: ToolAvailability = {
      key,
      available: false,
      detail: `tool "${key}" is not in the allowlist`,
    };
    availabilityCache.set(key, result);
    return result;
  }

  const cwd = await mkdtemp(join(tmpdir(), "plinius-tool-"));
  const exec = await sandbox.exec({
    tool: spec.key,
    executable: spec.executable,
    args: spec.versionArgs,
    cwd,
    timeoutMs: 10_000,
  });

  const available = exec.status !== "spawn_error";
  const firstLine = (exec.stdout || exec.stderr).split("\n")[0]?.trim();
  const result: ToolAvailability = {
    key,
    available,
    version: available ? firstLine || undefined : undefined,
    detail: available ? undefined : `could not run ${spec.executable}`,
  };
  availabilityCache.set(key, result);
  return result;
}

/** Test-only: clear the availability cache. */
export function resetToolAvailabilityCache(): void {
  availabilityCache.clear();
}
