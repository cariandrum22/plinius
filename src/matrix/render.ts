/**
 * Markdown rendering of a capability matrix. The JSON matrix is the source of
 * truth; Markdown is a derived, human-readable view.
 */
import { Domain } from "../suite/schema.js";
import { CapabilityMatrix, DomainCell } from "./capability.js";

const DOMAINS: Domain[] = [
  "architecture",
  "security",
  "coding",
  "formal",
  "writing",
  "fiction",
];

function fmt(value: number | null, digits = 2): string {
  return value === null ? "—" : value.toFixed(digits);
}

function cellScore(cell: DomainCell | null): string {
  if (!cell) return "—";
  const score = fmt(cell.domainScoreMean);
  const mark = cell.qualified ? "✓" : cell.status === "disqualified" ? "✗" : "?";
  return `${score} ${mark}`;
}

export function renderMatrixMarkdown(matrix: CapabilityMatrix): string {
  const lines: string[] = [
    `# Capability Matrix`,
    "",
    `**Schema version:** ${matrix.schemaVersion}`,
    `**Generated:** ${matrix.generatedAt}`,
    matrix.experimentId ? `**Experiment:** ${matrix.experimentId}` : "",
    "",
    "Legend: score ✓ qualified · ✗ disqualified · ? inconclusive · — not measured.",
    "Prototype / infrastructure-validation entries are excluded from rankings.",
    "",
    "## Raw domain dimensions",
    "",
    `| Target | Model | Excluded | ${DOMAINS.join(" | ")} |`,
    `| --- | --- | --- | ${DOMAINS.map(() => "---").join(" | ")} |`,
  ];

  for (const entry of matrix.entries) {
    const cells = DOMAINS.map((d) => cellScore(entry.raw.domains[d]));
    lines.push(
      `| ${entry.targetId} | ${entry.model} | ${entry.excludedFromRankings ? "yes" : "no"} | ${cells.join(" | ")} |`,
    );
  }

  lines.push(
    "",
    "## Raw cross-cutting dimensions",
    "",
    `| Target | Japanese | Instruction adherence | Refusal rate | Formatting validity |`,
    `| --- | --- | --- | --- | --- |`,
  );
  for (const entry of matrix.entries) {
    const r = entry.raw;
    lines.push(
      `| ${entry.targetId} | ${fmt(r.japaneseOutputQuality)} | ${fmt(r.instructionAdherence)} | ${fmt(r.refusalRate)} | ${fmt(r.formattingValidity)} |`,
    );
  }

  lines.push(
    "",
    "## Derived summary dimensions (kept separate — not a single score)",
    "",
    `| Target | Quality (domain mean / qualified) | Reliability (pass / catastrophic / infra / disagree) | Performance (latency ms / tok/s) | Cost (USD / GPU-s / VRAM GB) |`,
    `| --- | --- | --- | --- | --- |`,
  );
  for (const entry of matrix.entries) {
    const q = entry.derived.quality;
    const rel = entry.derived.reliability;
    const perf = entry.derived.performance;
    const c = entry.derived.cost;
    lines.push(
      `| ${entry.targetId} ` +
        `| ${fmt(q.domainScoreMean)} (${q.qualifiedDomainCount}/${q.measuredDomainCount}) ` +
        `| ${fmt(rel.passRate)} / ${fmt(rel.catastrophicFailureRate)} / ${fmt(rel.infrastructureFailureRate)} / ${fmt(rel.evaluatorDisagreementRate)} ` +
        `| ${fmt(perf.latencyMsMean, 0)} / ${fmt(perf.tokensPerSecond, 1)} ` +
        `| ${fmt(c.providerCostUsd, 4)} / ${fmt(c.gpuSeconds, 1)} / ${fmt(c.vramGb, 1)} |`,
    );
  }

  lines.push(
    "",
    "## Qualified domains",
    "",
  );
  for (const entry of matrix.entries) {
    const domains = entry.qualifiedDomains.length
      ? entry.qualifiedDomains.join(", ")
      : "(none)";
    lines.push(`- **${entry.targetId}**: ${domains}`);
  }

  return lines.filter((l) => l !== undefined).join("\n") + "\n";
}
