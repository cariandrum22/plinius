/**
 * Manifest audit: completeness checks with OK / WARNING / ERROR classification.
 */
import { EvaluationManifest } from "./manifest.js";
import { PromptSnapshot, computePromptId } from "../prompt/snapshot.js";

export type AuditLevel = "OK" | "WARNING" | "ERROR";

export interface AuditItem {
  check: string;
  level: AuditLevel;
  detail: string;
}

export interface AuditResult {
  items: AuditItem[];
  ok: number;
  warnings: number;
  errors: number;
}

export interface AuditOptions {
  /** When provided, verifies the prompt fingerprint/id against the manifest. */
  promptSnapshot?: PromptSnapshot;
}

export function auditManifest(manifest: EvaluationManifest, options: AuditOptions = {}): AuditResult {
  const items: AuditItem[] = [];

  items.push(
    manifest.catalogSnapshotId
      ? { check: "Catalog Snapshot", level: "OK", detail: manifest.catalogSnapshotId }
      : { check: "Catalog Snapshot", level: "ERROR", detail: "missing catalogSnapshotId" },
  );

  items.push(
    manifest.promptSnapshotId
      ? { check: "Prompt Snapshot", level: "OK", detail: manifest.promptSnapshotId }
      : { check: "Prompt Snapshot", level: "ERROR", detail: "missing promptSnapshotId" },
  );

  items.push(
    manifest.budget
      ? { check: "Budget Recorded", level: "OK", detail: `total=${manifest.budget.maximumTotalUsd}` }
      : { check: "Budget Recorded", level: "WARNING", detail: "no budget recorded" },
  );

  // Provenance completeness across targets.
  const statuses = manifest.targetModels.map((t) => t.provenanceStatus);
  if (statuses.length === 0) {
    items.push({ check: "Provenance Complete", level: "WARNING", detail: "no targets recorded" });
  } else if (statuses.every((s) => s === "complete")) {
    items.push({ check: "Provenance Complete", level: "OK", detail: "all targets complete" });
  } else if (statuses.some((s) => s === "missing")) {
    items.push({ check: "Provenance Complete", level: "ERROR", detail: `missing provenance for ${statuses.filter((s) => s === "missing").length} target(s)` });
  } else {
    items.push({ check: "Provenance Complete", level: "WARNING", detail: "some targets only partial" });
  }

  // Fingerprint / prompt-id match.
  if (options.promptSnapshot) {
    const recomputed = computePromptId({
      systemPrompt: options.promptSnapshot.systemPrompt,
      userPrompt: options.promptSnapshot.userPrompt,
      fewShot: options.promptSnapshot.fewShot,
      rubric: options.promptSnapshot.rubric,
      variables: options.promptSnapshot.variables,
      renderedPrompt: options.promptSnapshot.renderedPrompt,
    });
    items.push(
      recomputed === manifest.promptSnapshotId
        ? { check: "Fingerprint Match", level: "OK", detail: recomputed }
        : { check: "Fingerprint Match", level: "ERROR", detail: `recomputed ${recomputed} != ${manifest.promptSnapshotId}` },
    );
  } else {
    items.push({ check: "Fingerprint Match", level: "WARNING", detail: "no prompt snapshot supplied to verify" });
  }

  // Backend presence + health.
  items.push(
    manifest.backend
      ? { check: "Backend Present", level: "OK", detail: `${manifest.backend}${manifest.backendVersion ? ` v${manifest.backendVersion}` : ""}` }
      : { check: "Backend Present", level: "WARNING", detail: "no backend recorded (legacy manifest)" },
  );
  if (manifest.backend) {
    const health = manifest.backendHealth;
    items.push(
      health
        ? { check: "Backend Healthy", level: health.healthy ? "OK" : "WARNING", detail: health.healthy ? `checked ${health.checkedAt}` : "backend reported unhealthy" }
        : { check: "Backend Healthy", level: "WARNING", detail: "no health record" },
    );
    items.push(
      manifest.backendCapabilities
        ? { check: "Capabilities Recorded", level: "OK", detail: "present" }
        : { check: "Capabilities Recorded", level: "WARNING", detail: "no capabilities recorded" },
    );
  }

  // Runtime metrics: at least one provenance entry carries latency.
  const hasRuntime = manifest.generationProvenance.some((p) => p.latencyMs !== null);
  items.push(
    manifest.generationProvenance.length === 0
      ? { check: "Runtime Metrics Recorded", level: "WARNING", detail: "no generation provenance" }
      : hasRuntime
        ? { check: "Runtime Metrics Recorded", level: "OK", detail: "latency present" }
        : { check: "Runtime Metrics Recorded", level: "WARNING", detail: "provenance present but no latency" },
  );

  // Lifecycle.
  const retired = manifest.targetModels.filter((t) => t.lifecycle === "RETIRED");
  const deprecated = manifest.targetModels.filter((t) => t.lifecycle === "DEPRECATED" || t.lifecycle === "UNKNOWN");
  if (retired.length > 0) {
    items.push({ check: "Lifecycle", level: "ERROR", detail: `RETIRED: ${retired.map((t) => t.targetId).join(", ")}` });
  } else if (deprecated.length > 0) {
    items.push({ check: "Lifecycle", level: "WARNING", detail: `DEPRECATED/UNKNOWN: ${deprecated.map((t) => t.targetId).join(", ")}` });
  } else {
    items.push({ check: "Lifecycle", level: "OK", detail: "all ACTIVE" });
  }

  return {
    items,
    ok: items.filter((i) => i.level === "OK").length,
    warnings: items.filter((i) => i.level === "WARNING").length,
    errors: items.filter((i) => i.level === "ERROR").length,
  };
}
