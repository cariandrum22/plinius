/**
 * Concrete deterministic evaluators, one per check kind, plus a factory that
 * turns a validated {@link DeterministicCheck} into a {@link DeterministicEvaluator}.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import {
  CommandCheck,
  DeterministicCheck,
  FileExistsCheck,
  JsonSchemaCheck,
  RegexCheck,
  RequiredSectionsCheck,
} from "../suite/schema.js";
import {
  DeterministicEvaluation,
  DeterministicEvaluator,
  EvaluationInput,
  truncate,
} from "./types.js";
import { checkToolAvailability, resolveTool } from "./tools.js";
import { extractJson, validateJsonSchema } from "./json-schema-validate.js";

const EVALUATOR_VERSION = "1.0.0";

/** Compile a regex, returning null (never throwing) on an invalid pattern. */
function safeRegExp(pattern: string, flags: string): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/** Run an allowlisted tool inside the sandbox against the extracted workspace. */
export class CommandEvaluator implements DeterministicEvaluator {
  readonly id: string;
  readonly version = EVALUATOR_VERSION;
  readonly authority = "executable" as const;
  readonly blocking: boolean;

  constructor(private readonly check: CommandCheck) {
    this.id = `command:${check.id}`;
    this.blocking = check.blocking;
  }

  async evaluate(input: EvaluationInput): Promise<DeterministicEvaluation> {
    const base = {
      checkId: this.check.id,
      evaluatorId: this.id,
      version: this.version,
      authority: this.authority,
      blocking: this.blocking,
    };

    const spec = resolveTool(this.check.tool);
    if (!spec) {
      return {
        ...base,
        status: "error",
        message: `tool "${this.check.tool}" is not in the allowlist`,
        evidence: {},
      };
    }

    const availability = await checkToolAvailability(this.check.tool, input.sandbox);
    if (!availability.available) {
      return {
        ...base,
        status: "not_available",
        message: `required tool "${this.check.tool}" is not available`,
        evidence: { detail: availability.detail },
      };
    }

    if (!input.workspaceDir) {
      return {
        ...base,
        status: "error",
        message: "command check requires an extracted workspace but none was provided",
        evidence: {},
      };
    }

    const exec = await input.sandbox.exec({
      tool: spec.key,
      executable: spec.executable,
      args: this.check.args,
      cwd: input.workspaceDir,
      timeoutMs: this.check.timeoutMs,
    });

    const combined = `${exec.stdout}\n${exec.stderr}`;
    const evidence = {
      exitCode: exec.exitCode,
      stdout: truncate(exec.stdout),
      stderr: truncate(exec.stderr),
      durationMs: exec.durationMs,
      timedOut: exec.timedOut,
      toolVersion: availability.version,
    };

    if (exec.status === "spawn_error") {
      return {
        ...base,
        status: "not_available",
        message: `could not spawn ${spec.executable}`,
        evidence,
      };
    }
    if (exec.status === "timeout") {
      return {
        ...base,
        status: "fail",
        message: `command timed out after ${this.check.timeoutMs}ms`,
        evidence,
      };
    }

    const reasons: string[] = [];
    if (exec.exitCode !== this.check.expectExitCode) {
      reasons.push(`exit code ${exec.exitCode} !== expected ${this.check.expectExitCode}`);
    }
    if (this.check.expectOutputMatches) {
      const re = safeRegExp(this.check.expectOutputMatches, "m");
      if (re && !re.test(combined)) {
        reasons.push(`output did not match /${this.check.expectOutputMatches}/`);
      }
    }
    if (this.check.forbidOutputMatches) {
      const re = safeRegExp(this.check.forbidOutputMatches, "m");
      if (re && re.test(combined)) {
        reasons.push(`output matched forbidden /${this.check.forbidOutputMatches}/`);
      }
    }

    return {
      ...base,
      status: reasons.length === 0 ? "pass" : "fail",
      score: reasons.length === 0 ? 1 : 0,
      message: reasons.length === 0 ? "command succeeded" : reasons.join("; "),
      evidence,
    };
  }
}

export class JsonSchemaEvaluator implements DeterministicEvaluator {
  readonly id: string;
  readonly version = EVALUATOR_VERSION;
  readonly authority = "structural" as const;
  readonly blocking: boolean;

  constructor(private readonly check: JsonSchemaCheck) {
    this.id = `json_schema:${check.id}`;
    this.blocking = check.blocking;
  }

  async evaluate(input: EvaluationInput): Promise<DeterministicEvaluation> {
    const base = {
      checkId: this.check.id,
      evaluatorId: this.id,
      version: this.version,
      authority: this.authority,
      blocking: this.blocking,
    };

    let raw: string;
    if (this.check.source === "file") {
      if (!this.check.path || !input.workspaceDir) {
        return { ...base, status: "error", message: "file source requires path + workspace", evidence: {} };
      }
      try {
        raw = await readFile(join(input.workspaceDir, this.check.path), "utf-8");
      } catch {
        return { ...base, status: "fail", message: `file not found: ${this.check.path}`, evidence: {} };
      }
    } else {
      raw = input.outputText;
    }

    const extracted = extractJson(raw);
    if (extracted.error) {
      return { ...base, status: "fail", message: extracted.error, evidence: {} };
    }

    const errors = validateJsonSchema(extracted.value, this.check.schema);
    return {
      ...base,
      status: errors.length === 0 ? "pass" : "fail",
      score: errors.length === 0 ? 1 : 0,
      message: errors.length === 0 ? "JSON matches schema" : `${errors.length} schema violation(s)`,
      evidence: { violations: errors.slice(0, 20) },
    };
  }
}

export class RequiredSectionsEvaluator implements DeterministicEvaluator {
  readonly id: string;
  readonly version = EVALUATOR_VERSION;
  readonly authority = "structural" as const;
  readonly blocking: boolean;

  constructor(private readonly check: RequiredSectionsCheck) {
    this.id = `required_sections:${check.id}`;
    this.blocking = check.blocking;
  }

  async evaluate(input: EvaluationInput): Promise<DeterministicEvaluation> {
    const haystack = input.outputText.toLowerCase();
    const missing = this.check.sections.filter(
      (section) => !haystack.includes(section.toLowerCase()),
    );
    return {
      checkId: this.check.id,
      evaluatorId: this.id,
      version: this.version,
      authority: this.authority,
      blocking: this.blocking,
      status: missing.length === 0 ? "pass" : "fail",
      score: 1 - missing.length / this.check.sections.length,
      message:
        missing.length === 0
          ? "all required sections present"
          : `missing sections: ${missing.join(", ")}`,
      evidence: { missing },
    };
  }
}

export class RegexEvaluator implements DeterministicEvaluator {
  readonly id: string;
  readonly version = EVALUATOR_VERSION;
  readonly authority = "structural" as const;
  readonly blocking: boolean;

  constructor(private readonly check: RegexCheck) {
    this.id = `regex:${check.id}`;
    this.blocking = check.blocking;
  }

  async evaluate(input: EvaluationInput): Promise<DeterministicEvaluation> {
    const base = {
      checkId: this.check.id,
      evaluatorId: this.id,
      version: this.version,
      authority: this.authority,
      blocking: this.blocking,
    };
    const re = safeRegExp(this.check.pattern, this.check.flags);
    if (!re) {
      return {
        ...base,
        status: "error",
        message: `invalid regex: /${this.check.pattern}/${this.check.flags}`,
        evidence: { pattern: this.check.pattern },
      };
    }
    const matched = re.test(input.outputText);
    const ok = matched === this.check.mustMatch;
    return {
      ...base,
      status: ok ? "pass" : "fail",
      score: ok ? 1 : 0,
      message: ok
        ? "regex constraint satisfied"
        : `expected pattern to ${this.check.mustMatch ? "match" : "not match"}`,
      evidence: { pattern: this.check.pattern, matched },
    };
  }
}

export class FileExistsEvaluator implements DeterministicEvaluator {
  readonly id: string;
  readonly version = EVALUATOR_VERSION;
  readonly authority = "structural" as const;
  readonly blocking: boolean;

  constructor(private readonly check: FileExistsCheck) {
    this.id = `file_exists:${check.id}`;
    this.blocking = check.blocking;
  }

  async evaluate(input: EvaluationInput): Promise<DeterministicEvaluation> {
    const base = {
      checkId: this.check.id,
      evaluatorId: this.id,
      version: this.version,
      authority: this.authority,
      blocking: this.blocking,
    };
    if (!input.workspaceDir) {
      return { ...base, status: "error", message: "no workspace to check files in", evidence: {} };
    }
    const missing: string[] = [];
    for (const rel of this.check.paths) {
      try {
        await readFile(join(input.workspaceDir, rel));
      } catch {
        missing.push(rel);
      }
    }
    return {
      ...base,
      status: missing.length === 0 ? "pass" : "fail",
      score: 1 - missing.length / this.check.paths.length,
      message: missing.length === 0 ? "all files present" : `missing files: ${missing.join(", ")}`,
      evidence: { missing },
    };
  }
}

/** Build a deterministic evaluator from a validated check spec. */
export function buildEvaluator(check: DeterministicCheck): DeterministicEvaluator {
  switch (check.kind) {
    case "command":
      return new CommandEvaluator(check);
    case "json_schema":
      return new JsonSchemaEvaluator(check);
    case "required_sections":
      return new RequiredSectionsEvaluator(check);
    case "regex":
      return new RegexEvaluator(check);
    case "file_exists":
      return new FileExistsEvaluator(check);
  }
}
