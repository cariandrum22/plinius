import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  ExecutionSandbox,
  LocalProcessSandbox,
  SandboxExecRequest,
  SandboxExecResult,
} from "../src/evaluators/sandbox.js";
import { CommandEvaluator, RegexEvaluator, RequiredSectionsEvaluator } from "../src/evaluators/checks.js";
import { summarizeDeterministic } from "../src/evaluators/registry.js";
import { resetToolAvailabilityCache } from "../src/evaluators/tools.js";
import { CommandCheck, RequiredSectionsCheck } from "../src/suite/schema.js";

/** Programmable sandbox: version probes succeed; the command returns `result`. */
class FakeSandbox implements ExecutionSandbox {
  readonly id = "fake";
  readonly isSecuritySandbox = false;
  calls: SandboxExecRequest[] = [];

  constructor(
    private readonly result: SandboxExecResult,
    private readonly probeSpawnError = false,
  ) {}

  async exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    this.calls.push(request);
    const isProbe =
      request.args.includes("--version") ||
      request.args.includes("-help") ||
      request.args.includes("version");
    if (isProbe) {
      return this.probeSpawnError
        ? { status: "spawn_error", exitCode: null, stdout: "", stderr: "", durationMs: 1, timedOut: false }
        : { status: "completed", exitCode: 0, stdout: "v1.0", stderr: "", durationMs: 1, timedOut: false };
    }
    return this.result;
  }
}

function commandCheck(overrides: Partial<CommandCheck> = {}): CommandCheck {
  return {
    kind: "command",
    id: "build",
    description: "",
    blocking: true,
    authority: "executable",
    tool: "cargo",
    args: ["check"],
    expectExitCode: 0,
    timeoutMs: 5000,
    ...overrides,
  };
}

beforeEach(() => resetToolAvailabilityCache());

describe("CommandEvaluator", () => {
  const completed = (exitCode: number, stdout = "", stderr = ""): SandboxExecResult => ({
    status: "completed",
    exitCode,
    stdout,
    stderr,
    durationMs: 5,
    timedOut: false,
  });

  it("errors when the tool is not in the allowlist", async () => {
    const evaluator = new CommandEvaluator(commandCheck({ tool: "rm-rf" }));
    const sandbox = new FakeSandbox(completed(0));
    const result = await evaluator.evaluate({ outputText: "", workspaceDir: "/tmp", sandbox });
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/allowlist/);
  });

  it("reports not_available when the tool cannot be probed (not a failure)", async () => {
    const evaluator = new CommandEvaluator(commandCheck());
    const sandbox = new FakeSandbox(completed(0), /* probeSpawnError */ true);
    const result = await evaluator.evaluate({ outputText: "", workspaceDir: "/tmp", sandbox });
    expect(result.status).toBe("not_available");
  });

  it("passes when the exit code matches", async () => {
    const evaluator = new CommandEvaluator(commandCheck());
    const sandbox = new FakeSandbox(completed(0, "ok"));
    const result = await evaluator.evaluate({ outputText: "", workspaceDir: "/tmp", sandbox });
    expect(result.status).toBe("pass");
    expect(result.authority).toBe("executable");
  });

  it("fails on a non-zero exit code", async () => {
    const evaluator = new CommandEvaluator(commandCheck());
    const sandbox = new FakeSandbox(completed(101, "", "error[E0308]"));
    const result = await evaluator.evaluate({ outputText: "", workspaceDir: "/tmp", sandbox });
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/exit code/);
  });

  it("fails on forbidden output (vacuity guard)", async () => {
    const evaluator = new CommandEvaluator(
      commandCheck({ forbidOutputMatches: "vacuous|trivially true" }),
    );
    const sandbox = new FakeSandbox(completed(0, "proof is trivially true"));
    const result = await evaluator.evaluate({ outputText: "", workspaceDir: "/tmp", sandbox });
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/forbidden/);
  });

  it("treats a timeout as a failure with evidence", async () => {
    const evaluator = new CommandEvaluator(commandCheck());
    const sandbox = new FakeSandbox({
      status: "timeout",
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 5000,
      timedOut: true,
    });
    const result = await evaluator.evaluate({ outputText: "", workspaceDir: "/tmp", sandbox });
    expect(result.status).toBe("fail");
    expect(result.evidence.timedOut).toBe(true);
  });
});

describe("LocalProcessSandbox (real execution)", () => {
  it("runs node without a shell and does not interpolate args", async () => {
    const sandbox = new LocalProcessSandbox();
    const dir = await mkdtemp(join(tmpdir(), "plinius-sbx-"));
    try {
      // $(...) would be evaluated by a shell; execFile passes it literally.
      const res = await sandbox.exec({
        tool: "node",
        executable: "node",
        args: ["-e", "process.stdout.write(process.argv[1])", "$(whoami)"],
        cwd: dir,
        timeoutMs: 10000,
      });
      expect(res.status).toBe("completed");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe("$(whoami)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports spawn_error for a missing executable", async () => {
    const sandbox = new LocalProcessSandbox();
    const res = await sandbox.exec({
      tool: "nope",
      executable: "definitely-not-a-real-binary-xyzzy",
      args: [],
      cwd: tmpdir(),
      timeoutMs: 5000,
    });
    expect(res.status).toBe("spawn_error");
  });
});

describe("RegexEvaluator", () => {
  const sandbox = new FakeSandbox({ status: "completed", exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false });

  it("returns error (not throw) on an invalid pattern", async () => {
    const evaluator = new RegexEvaluator({
      kind: "regex",
      id: "bad",
      description: "",
      blocking: true,
      authority: "structural",
      pattern: "(?s).+", // invalid inline flag in JS
      flags: "",
      mustMatch: true,
    });
    const result = await evaluator.evaluate({ outputText: "anything", sandbox });
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/invalid regex/);
  });
});

describe("summarizeDeterministic", () => {
  it("treats a blocking not_available as inconclusive, not a failure", async () => {
    const check: RequiredSectionsCheck = {
      kind: "required_sections",
      id: "s",
      description: "",
      blocking: true,
      authority: "structural",
      sections: ["Summary"],
    };
    const evaluator = new RequiredSectionsEvaluator(check);
    const pass = await evaluator.evaluate({
      outputText: "## Summary\nok",
      sandbox: new FakeSandbox({ status: "completed", exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }),
    });
    const summary = summarizeDeterministic([
      pass,
      {
        checkId: "c",
        evaluatorId: "command:c",
        version: "1.0.0",
        authority: "executable",
        blocking: true,
        status: "not_available",
        message: "missing tool",
        evidence: {},
      },
    ]);
    expect(summary.hasBlockingNotAvailable).toBe(true);
    expect(summary.hasBlockingFailure).toBe(false);
    // pass rate computed only over decided (pass/fail) blocking checks
    expect(summary.blockingPassRate).toBe(1);
  });
});
