/**
 * Byte-preserving wire evidence — pure, offline helpers (Stage C1 r5).
 *
 * WHY THIS MODULE EXISTS (recorded before it was added, per the Allowed-Source-
 * Changes rule and r5 authority-bindings.json): C1-R4-F02 requires storing not
 * just the digest but the byte-preserving PREIMAGE of each request / response /
 * cost-lookup body — the exact bytes (base64, with the encoding name, SHA-256 and
 * byte length) — captured with an arrayBuffer()-equivalent rather than a .text()
 * decode/re-encode, so every parsed field (finish reason, usage, generation id,
 * model, provider, cost, routing) is RE-DERIVABLE from the stored bytes. C1-R4-F03
 * requires resume to recompute the digest/length from those stored bytes and
 * re-parse the request / response / every cost-lookup poll instead of trusting the
 * parsed rawResponse or a persisted verdict.
 *
 * Isolating the byte-preserving encode/decode, the wire-evidence shape, and the
 * from-stored-bytes re-derivation here (src/continuation/, a permitted new path)
 * keeps each a pure Buffer-only function the offline tests drive directly — no I/O,
 * no network, no clock, no credential. Credential-bearing headers are never
 * accepted into the evidence: {@link sanitizeHeaders} is a strict allowlist.
 */
import { createHash } from "crypto";

/** The exact bytes of one body, preserved so its parse and digests are reproducible. */
export interface WireBodyPreimage {
  /** Only "base64" — a byte-preserving encoding, never a .text() decode/re-encode. */
  encoding: "base64";
  base64: string;
  /** "sha256:<hex>" over the RAW bytes (not a re-encoded string). */
  sha256: string;
  bytes: number;
}

export interface RequestWireEvidence {
  url: string | null;
  method: string | null;
  body: WireBodyPreimage | null;
}

export interface ResponseWireEvidence {
  httpStatus: number | null;
  receivedAtUtc: string | null;
  /** Allowlisted response headers only — never authorization / cookie / set-cookie. */
  headers: Record<string, string>;
  body: WireBodyPreimage | null;
}

/**
 * One generation-cost lookup poll as a DISCRIMINATED UNION (C1-R6-F02): a poll is
 * either a `transport_error` (the fetch never produced an HTTP response) or an
 * `http_response` (an HTTP status was received). This stops `parseOk` from
 * conflating three independent facts — JSON syntax validity (`jsonParsed`), the HTTP
 * outcome (`httpStatus`) and data presence (`dataPresent`) are recorded separately,
 * so a non-200 JSON body or a fetch error is preserved whole and never masked. The
 * discriminant fixes each variant's nullability.
 */
export type CostLookupPollEvidence =
  | {
      pollIndex: number;
      kind: "transport_error";
      url: string;
      method: "GET";
      receivedAtUtc: string;
      error: string;
    }
  | {
      pollIndex: number;
      kind: "http_response";
      url: string;
      method: "GET";
      receivedAtUtc: string;
      httpStatus: number;
      headers: Record<string, string>;
      body: WireBodyPreimage;
      /** true iff the body is syntactically valid JSON (independent of HTTP status). */
      jsonParsed: boolean;
      jsonError: string | null;
      /** true iff the parsed JSON carries a `data` object (independent of jsonParsed). */
      dataPresent: boolean;
    };

export interface CostLookupWireEvidence {
  polls: CostLookupPollEvidence[];
  /** true iff the final poll is a data-bearing 200 http_response. */
  finalOk: boolean;
}

/** The wire evidence attached to ONE attempt (request + response + cost-lookup polls). */
export interface AttemptWireEvidence {
  request: RequestWireEvidence;
  response: ResponseWireEvidence;
  costLookup: CostLookupWireEvidence | null;
}

const HEX = /^sha256:[0-9a-f]{64}$/;

/** Raw bytes → bare lowercase hex SHA-256, prefixed. */
function sha256OfBytes(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

/**
 * Encode a body's exact bytes into a {@link WireBodyPreimage}. A string is taken as
 * its UTF-8 bytes (the exact bytes fetch transmits for a string init.body); an
 * ArrayBuffer / Uint8Array (from response.arrayBuffer()) is preserved verbatim.
 */
export function encodeWireBody(raw: string | ArrayBuffer | Uint8Array): WireBodyPreimage {
  const bytes: Uint8Array =
    typeof raw === "string"
      ? Buffer.from(raw, "utf-8")
      : raw instanceof Uint8Array
        ? raw
        : new Uint8Array(raw);
  const buf = Buffer.from(bytes);
  return { encoding: "base64", base64: buf.toString("base64"), sha256: sha256OfBytes(buf), bytes: buf.byteLength };
}

/** Decode a preimage back to its exact bytes. */
export function decodeWireBody(p: WireBodyPreimage): Buffer {
  return Buffer.from(p.base64, "base64");
}

/**
 * Recompute a preimage's digest and byte length from its stored base64 and confirm
 * they match the recorded sha256 / bytes (F03) — a tampered digest, byte length, or
 * base64 payload is rejected.
 *
 * The base64 must be STRICT CANONICAL (C1-R5-F02/F05): decoding the stored string
 * and re-encoding it must reproduce the SAME string byte-for-byte. Node's
 * `Buffer.from(s,"base64")` is lenient — it silently drops whitespace, an embedded
 * newline, extra `=` padding and out-of-alphabet characters — so a non-canonical
 * payload could otherwise digest-match while carrying smuggled bytes; requiring the
 * round-trip to be an identity rejects every such alias.
 */
export function verifyWireBody(p: WireBodyPreimage | null | undefined): { ok: boolean; reason: string } {
  if (p == null || typeof p !== "object") return { ok: false, reason: "wire_body_missing" };
  if (p.encoding !== "base64") return { ok: false, reason: "wire_body_encoding" };
  if (typeof p.base64 !== "string" || typeof p.sha256 !== "string" || typeof p.bytes !== "number")
    return { ok: false, reason: "wire_body_shape" };
  if (!HEX.test(p.sha256)) return { ok: false, reason: "wire_body_digest_format" };
  const bytes = Buffer.from(p.base64, "base64");
  // Canonical base64 round-trip: a lenient decode that dropped whitespace / newline /
  // non-alphabet characters / non-minimal padding re-encodes to a DIFFERENT string.
  if (Buffer.from(bytes).toString("base64") !== p.base64) return { ok: false, reason: "wire_body_base64_noncanonical" };
  if (bytes.byteLength !== p.bytes) return { ok: false, reason: "wire_body_bytes_mismatch" };
  if (sha256OfBytes(bytes) !== p.sha256) return { ok: false, reason: "wire_body_digest_mismatch" };
  return { ok: true, reason: "ok" };
}

/**
 * Re-derive the request identity STRICTLY from the request wire bytes (C1-R5-F02):
 * the model, max output and sampling ACTUALLY transmitted, plus which sampling
 * fields were sent. Never read from a plan object or a persisted headline.
 */
export interface ReDerivedRequestIdentity {
  model: string | null;
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  seed: number | null;
  temperatureSent: boolean;
  topPSent: boolean;
  seedSent: boolean;
}

export function reDeriveRequestIdentity(
  p: WireBodyPreimage | null | undefined,
): { ok: true; identity: ReDerivedRequestIdentity } | { ok: false; reason: string } {
  const parsed = parseWireJson(p);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const o = (parsed.value ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    ok: true,
    identity: {
      model: typeof o.model === "string" ? o.model : null,
      maxTokens: num(o.max_tokens),
      temperature: num(o.temperature),
      topP: num(o.top_p),
      seed: num(o.seed),
      temperatureSent: "temperature" in o && o.temperature !== null && o.temperature !== undefined,
      topPSent: "top_p" in o && o.top_p !== null && o.top_p !== undefined,
      seedSent: "seed" in o && o.seed !== null && o.seed !== undefined,
    },
  };
}

/** Decode + verify + JSON.parse a preimage in one step. */
export function parseWireJson(p: WireBodyPreimage | null | undefined): { ok: true; value: unknown } | { ok: false; reason: string } {
  const v = verifyWireBody(p);
  if (!v.ok) return { ok: false, reason: v.reason };
  try {
    return { ok: true, value: JSON.parse(decodeWireBody(p as WireBodyPreimage).toString("utf-8")) };
  } catch {
    return { ok: false, reason: "wire_body_not_json" };
  }
}

/**
 * The response identity re-derived STRICTLY from the response wire bytes (F03):
 * model / generation id / provider, plus finish reason and usage. Never read from
 * the parsed rawResponse object or a persisted verdict.
 */
export interface ReDerivedResponseIdentity {
  model: string | null;
  generationId: string | null;
  provider: string | null;
  finishReason: string | null;
  usage: unknown;
}

export function reDeriveResponseIdentity(p: WireBodyPreimage | null | undefined): { ok: true; identity: ReDerivedResponseIdentity } | { ok: false; reason: string } {
  const parsed = parseWireJson(p);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const o = (parsed.value ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(o.choices) ? (o.choices as Array<Record<string, unknown>>) : [];
  return {
    ok: true,
    identity: {
      model: typeof o.model === "string" ? o.model : null,
      generationId: typeof o.id === "string" ? o.id : null,
      provider: typeof o.provider === "string" ? o.provider : null,
      finishReason: typeof choices[0]?.finish_reason === "string" ? (choices[0].finish_reason as string) : null,
      usage: o.usage ?? null,
    },
  };
}

/** Billed cost / routing re-derived STRICTLY from a cost-lookup poll's wire bytes (F03). */
export interface ReDerivedCost {
  generationId: string | null;
  model: string | null;
  provider: string | null;
  actualCostUsd: number | null;
}

export function reDeriveCost(p: WireBodyPreimage | null | undefined): { ok: true; cost: ReDerivedCost } | { ok: false; reason: string } {
  const parsed = parseWireJson(p);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const d = ((parsed.value ?? {}) as Record<string, unknown>).data as Record<string, unknown> | undefined;
  if (d == null || typeof d !== "object") return { ok: false, reason: "cost_lookup_no_data" };
  return {
    ok: true,
    cost: {
      generationId: typeof d.id === "string" ? d.id : null,
      model: typeof d.model === "string" ? d.model : null,
      provider: typeof d.provider_name === "string" ? d.provider_name : null,
      actualCostUsd: typeof d.total_cost === "number" ? d.total_cost : null,
    },
  };
}

/**
 * Verify a WHOLE cost-lookup poll chain from its stored bytes (C1-R5-F02). The
 * r5 gap was that only the FINAL poll was re-derived: a chain with a null-bodied
 * HTTP-500 first poll and a forged `parseOk` still passed. This walks EVERY poll:
 *
 *  - `pollIndex` is exactly its position (contiguous from 0, no gap, no reorder);
 *  - `url` / `method` / `httpStatus` / `receivedAtUtc` are present on every poll;
 *  - when a body is present its preimage round-trips (canonical base64 + digest);
 *  - `parseOk` is self-consistent with the body: a true `parseOk` REQUIRES a body
 *    that actually parses to JSON, and its `data` presence matches whether this was
 *    the terminal (data-bearing) poll — a forged parse flag is rejected;
 *  - exactly the last poll may be data-bearing, and `finalOk` must equal whether
 *    that last poll carried a `data` object.
 *
 * Returns the final data-bearing poll's re-derived cost when `finalOk`, so the
 * caller can bind it to the response without re-reading the parsed object.
 */
export function verifyCostLookupChain(
  cl: CostLookupWireEvidence | null | undefined,
): { ok: true; finalOk: boolean; finalCost: ReDerivedCost | null } | { ok: false; reason: string } {
  if (cl == null || typeof cl !== "object") return { ok: false, reason: "cost_lookup_missing" };
  if (!Array.isArray(cl.polls) || cl.polls.length === 0) return { ok: false, reason: "cost_lookup_no_polls" };
  let finalCost: ReDerivedCost | null = null;
  for (let i = 0; i < cl.polls.length; i++) {
    const poll = cl.polls[i] as CostLookupPollEvidence;
    if (poll == null || typeof poll !== "object") return { ok: false, reason: `cost_poll_${i}_shape` };
    if (poll.pollIndex !== i) return { ok: false, reason: `cost_poll_${i}_index` };
    if (poll.url == null || poll.method !== "GET") return { ok: false, reason: `cost_poll_${i}_url_or_method` };
    if (poll.receivedAtUtc == null) return { ok: false, reason: `cost_poll_${i}_time_missing` };
    const isLast = i === cl.polls.length - 1;
    let dataBearing = false;
    if (poll.kind === "transport_error") {
      // A fetch error carries only its message — never a body or status. It is a valid
      // NON-terminal outcome (the retry loop tried again); it can never be data-bearing.
      if (typeof poll.error !== "string" || poll.error.length === 0) return { ok: false, reason: `cost_poll_${i}_transport_error_message` };
    } else if (poll.kind === "http_response") {
      if (typeof poll.httpStatus !== "number") return { ok: false, reason: `cost_poll_${i}_status_missing` };
      // The body preimage must round-trip (canonical base64 + digest).
      const parsed = parseWireJson(poll.body);
      const jsonOk = parsed.ok;
      // jsonParsed must equal actual JSON validity (not the HTTP outcome).
      if (poll.jsonParsed !== jsonOk) return { ok: false, reason: `cost_poll_${i}_jsonParsed_inconsistent` };
      if (!jsonOk && poll.jsonError == null) return { ok: false, reason: `cost_poll_${i}_jsonError_missing` };
      const d = jsonOk ? ((parsed.value ?? {}) as Record<string, unknown>).data : undefined;
      const actualData = d != null && typeof d === "object";
      // dataPresent must equal actual data presence (not JSON validity, not HTTP status).
      if (poll.dataPresent !== actualData) return { ok: false, reason: `cost_poll_${i}_dataPresent_inconsistent` };
      // Success = 200 + valid JSON + data. A non-200 with a JSON body, or a 200 with no
      // data, is a legitimate non-terminal outcome (production non-200→success chain).
      dataBearing = poll.httpStatus === 200 && jsonOk && actualData;
    } else {
      return { ok: false, reason: `cost_poll_${i}_unknown_kind` };
    }
    if (dataBearing && !isLast) return { ok: false, reason: `cost_poll_${i}_data_before_final` };
    if (isLast) {
      if (cl.finalOk !== dataBearing) return { ok: false, reason: "cost_lookup_finalOk_inconsistent" };
      if (dataBearing && poll.kind === "http_response") {
        const c = reDeriveCost(poll.body);
        if (!c.ok) return { ok: false, reason: `cost_final_${c.reason}` };
        finalCost = c.cost;
      }
    }
  }
  return { ok: true, finalOk: cl.finalOk === true, finalCost };
}

/**
 * Strict allowlist for stored response / cost-lookup headers (F02): only these
 * non-secret header names survive. Authorization, Cookie, Set-Cookie, and any
 * API-key / credential-bearing header are dropped because they are not on the
 * list — an allowlist, never a denylist.
 */
const HEADER_ALLOWLIST = new Set([
  "content-type",
  "content-length",
  "date",
  "server",
  "x-request-id",
  "x-provider",
  "x-provider-name",
  "openai-model",
  "openai-organization",
  "openai-processing-ms",
  "openai-version",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
]);

/** Keep only allowlisted, non-secret headers (lower-cased names). */
export function sanitizeHeaders(headers: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers) {
    const key = k.toLowerCase();
    if (HEADER_ALLOWLIST.has(key)) out[key] = v;
  }
  return out;
}
