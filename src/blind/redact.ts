/**
 * Identity-leakage detection and redaction for reviewer-facing artifacts.
 *
 * A denylist is derived from the experiment configuration (target ids, model
 * and provider names, served names, backend ids/types) plus explicit vendor
 * self-identification phrases. Reviewer-facing text is scanned; matches are
 * flagged, the item optionally excluded, or (only under an explicit redact
 * policy) the specific identity phrase is replaced. Model output is never
 * silently rewritten. Every redaction is recorded for the private manifest.
 */
import { ExperimentConfig } from "../experiment/config.js";
import { BlindReviewItem, RedactionRecord } from "./schema.js";

export interface Denylist {
  /** Case-insensitive substrings that must not appear (target/model/provider). */
  terms: string[];
  /** Explicit vendor self-identification phrases (regex, case-insensitive). */
  phrases: RegExp[];
}

const REDACTION_PLACEHOLDER = "［識別情報を削除］";

/** Known explicit self-identification phrases. */
const IDENTITY_PHRASES: RegExp[] = [
  /\bAs\s+Qwen\b/gi,
  /\bI\s+am\s+Qwen\b/gi,
  /\bI\s+am\s+DeepSeek\b/gi,
  /\bI'?m\s+DeepSeek\b/gi,
  /\bAs\s+DeepSeek\b/gi,
  /\bI\s+am\s+ChatGPT\b/gi,
  /\bI\s+am\s+GPT-?\d/gi,
  /\bAs\s+an?\s+AI\s+(?:language\s+)?model\s+(?:developed|created|trained|made)\s+by\s+\w+/gi,
  /\bAs\s+Claude\b/gi,
  /\bI'?m\s+Claude\b/gi,
  /\bAs\s+Gemini\b/gi,
  /\bAs\s+Llama\b/gi,
  /\bAs\s+Mistral\b/gi,
  /\bI\s+am\s+Kimi\b/gi,
];

function shortModelName(model: string): string {
  return model.split("/").pop() ?? model;
}
function providerName(model: string): string {
  return model.includes("/") ? model.split("/")[0] : "";
}

/** Build a denylist from the experiment config plus any extra terms. */
export function buildDenylist(
  config: ExperimentConfig,
  extraTerms: string[] = [],
): Denylist {
  const terms = new Set<string>();
  for (const target of config.targets) {
    terms.add(target.id);
    terms.add(target.model);
    terms.add(shortModelName(target.model));
    const provider = providerName(target.model);
    if (provider) terms.add(provider);
    if (target.servedModelName) {
      terms.add(target.servedModelName);
      terms.add(shortModelName(target.servedModelName));
    }
  }
  for (const [backendId, def] of Object.entries(config.backends)) {
    terms.add(backendId);
    terms.add(def.type);
  }
  for (const t of extraTerms) terms.add(t);

  // Drop trivially-short or empty terms that would over-match.
  const cleaned = [...terms].filter((t) => t && t.trim().length >= 3);
  return { terms: cleaned, phrases: IDENTITY_PHRASES };
}

export interface ScanHit {
  matched: string;
  reason: string;
}

/** Scan a text blob against the denylist. */
export function scanText(text: string, denylist: Denylist): ScanHit[] {
  const hits: ScanHit[] = [];
  const lower = text.toLowerCase();
  for (const term of denylist.terms) {
    if (lower.includes(term.toLowerCase())) {
      hits.push({ matched: term, reason: "denylisted identifier" });
    }
  }
  for (const phrase of denylist.phrases) {
    phrase.lastIndex = 0;
    const m = phrase.exec(text);
    if (m) hits.push({ matched: m[0], reason: "explicit self-identification" });
  }
  return hits;
}

export type RedactionPolicy = "flag" | "exclude" | "redact";

export interface RedactionResult {
  item: BlindReviewItem | null;
  redactions: RedactionRecord[];
  excluded: boolean;
}

/**
 * Apply the redaction policy to one item. Only the responseText is scanned for
 * self-identification phrases eligible for replacement; all reviewer-facing
 * fields are scanned for denylisted identifiers.
 */
export function applyRedaction(
  item: BlindReviewItem,
  denylist: Denylist,
  policy: RedactionPolicy,
): RedactionResult {
  const fields: [string, string][] = [
    ["taskText", item.taskText],
    ["responseText", item.responseText],
    ["expectedOutputFormat", item.expectedOutputFormat ?? ""],
    ["requiredConstraints", (item.requiredConstraints ?? []).join("\n")],
    ...(item.extractedArtifacts ?? []).map(
      (a, i): [string, string] => [`artifact[${i}]:${a.path}`, a.content],
    ),
  ];

  const redactions: RedactionRecord[] = [];
  let hasHit = false;
  for (const [field, text] of fields) {
    for (const hit of scanText(text, denylist)) {
      hasHit = true;
      redactions.push({
        blindId: item.blindId,
        field,
        reason: hit.reason,
        matched: hit.matched,
        action: policy === "exclude" ? "excluded" : policy === "redact" ? "redacted" : "flagged",
      });
    }
  }

  if (!hasHit) return { item, redactions: [], excluded: false };

  if (policy === "exclude") {
    return { item: null, redactions, excluded: true };
  }

  if (policy === "redact") {
    // Replace only explicit self-identification phrases in the response.
    let responseText = item.responseText;
    for (const phrase of denylist.phrases) {
      responseText = responseText.replace(phrase, REDACTION_PLACEHOLDER);
    }
    return { item: { ...item, responseText }, redactions, excluded: false };
  }

  // flag: keep the item unchanged; the caller surfaces the flag.
  return { item, redactions, excluded: false };
}
