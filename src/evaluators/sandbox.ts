/**
 * Execution sandbox boundary.
 *
 * All process execution goes through an {@link ExecutionSandbox}. This is a
 * replaceable boundary: a future implementation could run commands inside a
 * container, microVM, or seccomp jail. The initial {@link LocalProcessSandbox}
 * runs commands as ordinary local child processes.
 *
 * IMPORTANT: {@link LocalProcessSandbox} is NOT a security sandbox. It provides
 * isolation of the *working directory* and enforces timeouts, but it does not
 * confine filesystem, network, or syscall access. It must only ever run
 * benchmark-author-defined, allowlisted executables with author-defined argv —
 * never commands or arguments derived from model output.
 */
import { execFile } from "child_process";

export interface SandboxExecRequest {
  /** Allowlist key the executable was resolved from (for provenance). */
  tool: string;
  /** Resolved executable (bare name looked up on PATH, or absolute path). */
  executable: string;
  /** Fixed argument vector. Never contains model-derived content. */
  args: string[];
  /** Working directory the process runs in. */
  cwd: string;
  /** Hard timeout in milliseconds. */
  timeoutMs: number;
  /** Extra environment variables (merged over a minimal base env). */
  env?: Record<string, string>;
}

export type SandboxExecStatus = "completed" | "timeout" | "spawn_error";

export interface SandboxExecResult {
  status: SandboxExecStatus;
  /** Process exit code, or null if it was killed / never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ExecutionSandbox {
  readonly id: string;
  /**
   * Whether this sandbox provides real security confinement. The local
   * implementation returns false; callers surface this in provenance so results
   * are never mistaken for having run under confinement.
   */
  readonly isSecuritySandbox: boolean;
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>;
}

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024; // 8 MiB of stdout/stderr

/**
 * Runs commands as local child processes via `execFile` (no shell, so there is
 * no argument interpolation or globbing). Not a security boundary.
 */
export class LocalProcessSandbox implements ExecutionSandbox {
  readonly id = "local-process";
  readonly isSecuritySandbox = false;

  private readonly maxBuffer: number;

  constructor(options: { maxBuffer?: number } = {}) {
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  }

  exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    const start = Date.now();
    return new Promise((resolve) => {
      execFile(
        request.executable,
        request.args,
        {
          cwd: request.cwd,
          timeout: request.timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: this.maxBuffer,
          // Minimal, explicit environment. No shell is spawned.
          env: { PATH: process.env.PATH ?? "", ...request.env },
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - start;
          const out = stdout.toString();
          const err = stderr.toString();

          if (error) {
            const err2 = error as NodeJS.ErrnoException & {
              killed?: boolean;
              signal?: string | null;
            };
            // Timeout: execFile kills the process; error.code is a string/null.
            if (err2.killed || (err2.signal && typeof err2.code !== "number")) {
              resolve({
                status: "timeout",
                exitCode: null,
                stdout: out,
                stderr: err,
                durationMs,
                timedOut: true,
              });
              return;
            }
            // Executable not found / could not spawn.
            if (err2.code === "ENOENT" || err2.code === "EACCES") {
              resolve({
                status: "spawn_error",
                exitCode: null,
                stdout: out,
                stderr: err || String(error.message),
                durationMs,
                timedOut: false,
              });
              return;
            }
            // Normal non-zero exit: error.code holds the numeric exit code.
            resolve({
              status: "completed",
              exitCode: typeof err2.code === "number" ? err2.code : 1,
              stdout: out,
              stderr: err,
              durationMs,
              timedOut: false,
            });
            return;
          }

          resolve({
            status: "completed",
            exitCode: 0,
            stdout: out,
            stderr: err,
            durationMs,
            timedOut: false,
          });
        },
      );
    });
  }
}
