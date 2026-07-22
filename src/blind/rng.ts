/**
 * Deterministic, seedable PRNG and shuffle for reproducible blinding.
 *
 * The same seed always yields the same sequence, so a public packet is fully
 * reproducible from (source records, config, seed). Node's Math.random is never
 * used here.
 */
import { createHash } from "crypto";

/** Derive a 32-bit seed from an arbitrary string via sha256. */
function seedUint32(seed: string): number {
  const hex = createHash("sha256").update(seed, "utf-8").digest("hex");
  return parseInt(hex.slice(0, 8), 16) >>> 0;
}

/** mulberry32 PRNG: fast, deterministic, good enough for shuffling. */
export function makeRng(seed: string): () => number {
  let a = seedUint32(seed);
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle producing a new array; does not mutate the input. */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}
