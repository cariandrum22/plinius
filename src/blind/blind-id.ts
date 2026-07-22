/**
 * Opaque blind-ID generation.
 *
 * IDs look like `R-7K3M9Q` (pairwise: `P-7K3M9Q`) and are derived from an
 * HMAC of the source run-record id keyed by the blinding seed. They therefore:
 *   - encode no model / benchmark-family / order information,
 *   - are stable for the same (seed, run record),
 *   - differ when the seed differs,
 *   - and have collisions resolved deterministically.
 */
import { createHmac } from "crypto";

// Crockford base32 without the ambiguous I, L, O, U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_LEN = 7;

function encode(buf: Buffer, length: number): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
    if (out.length >= length) break;
  }
  return out;
}

function rawId(seed: string, runRecordId: string, salt: number): string {
  const mac = createHmac("sha256", seed)
    .update(salt === 0 ? runRecordId : `${runRecordId}#${salt}`)
    .digest();
  return encode(mac, ID_LEN);
}

/**
 * Assign opaque blind IDs to run-record ids. Records are processed in a stable
 * sorted order so collisions resolve deterministically. Returns a Map keyed by
 * runRecordId.
 */
export function assignBlindIds(
  runRecordIds: string[],
  seed: string,
  prefix: "R" | "P" = "R",
): Map<string, string> {
  const assigned = new Map<string, string>();
  const used = new Set<string>();

  for (const runRecordId of [...runRecordIds].sort()) {
    let salt = 0;
    let id = `${prefix}-${rawId(seed, runRecordId, salt)}`;
    while (used.has(id)) {
      salt += 1;
      id = `${prefix}-${rawId(seed, runRecordId, salt)}`;
    }
    used.add(id);
    assigned.set(runRecordId, id);
  }
  return assigned;
}

/** Generate a single pairwise blind id from the two record ids + seed. */
export function pairwiseBlindId(
  seed: string,
  aRunRecordId: string,
  bRunRecordId: string,
): string {
  // Order-independent key so the id does not encode which side is A.
  const key = [aRunRecordId, bRunRecordId].sort().join("|");
  return `P-${rawId(seed, key, 0)}`;
}
