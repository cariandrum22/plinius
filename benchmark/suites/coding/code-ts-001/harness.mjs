// Self-contained acceptance harness for the LRUCache benchmark.
// Run with: node harness.mjs
// Prints "ALL TESTS PASSED" and exits 0 on success; otherwise prints the
// failing assertion and exits 1.

import assert from "node:assert/strict";
import { LRUCache } from "./solution.mjs";

function run(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`FAILED: ${name}`);
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
}

// --- Construction & validation ---------------------------------------------
run("constructor rejects non-positive / non-integer capacity", () => {
  for (const bad of [0, -1, -5, 1.5, NaN, "3", null, undefined, {}]) {
    assert.throws(() => new LRUCache(bad), TypeError, `capacity=${String(bad)}`);
  }
});

run("constructor accepts a positive integer capacity", () => {
  const c = new LRUCache(2);
  assert.equal(c.size, 0);
  assert.equal(c.capacity, 2);
});

// --- Core get/set behavior --------------------------------------------------
run("set then get returns stored value", () => {
  const c = new LRUCache(2);
  const ret = c.set("a", 1);
  assert.equal(ret, c, "set must return the cache instance for chaining");
  assert.equal(c.get("a"), 1);
  assert.equal(c.size, 1);
});

run("get on missing key returns undefined", () => {
  const c = new LRUCache(2);
  assert.equal(c.get("missing"), undefined);
});

run("set updates value of an existing key without growing size", () => {
  const c = new LRUCache(2);
  c.set("a", 1).set("a", 2);
  assert.equal(c.get("a"), 2);
  assert.equal(c.size, 1);
});

// --- Eviction ---------------------------------------------------------------
run("evicts least-recently-used entry when over capacity", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3); // evicts "a"
  assert.equal(c.has("a"), false);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("b"), 2);
  assert.equal(c.get("c"), 3);
  assert.equal(c.size, 2);
});

run("get marks an entry as most-recently-used", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1); // "a" now most-recently-used
  c.set("c", 3); // should evict "b", not "a"
  assert.equal(c.has("a"), true);
  assert.equal(c.has("b"), false);
  assert.equal(c.has("c"), true);
});

run("updating an existing key marks it most-recently-used", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 10); // refresh "a"
  c.set("c", 3); // should evict "b"
  assert.equal(c.has("a"), true);
  assert.equal(c.get("a"), 10);
  assert.equal(c.has("b"), false);
  assert.equal(c.has("c"), true);
});

run("capacity of 1 evicts on every distinct insert", () => {
  const c = new LRUCache(1);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.has("a"), false);
  assert.equal(c.get("b"), 2);
  assert.equal(c.size, 1);
});

// --- has() must not affect recency -----------------------------------------
run("has does not change recency order", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.has("a"), true); // must NOT touch "a"
  c.set("c", 3); // "a" is still LRU -> evicted
  assert.equal(c.has("a"), false);
  assert.equal(c.has("b"), true);
  assert.equal(c.has("c"), true);
});

// --- keys() ordering --------------------------------------------------------
run("keys returns LRU-first, MRU-last ordering", () => {
  const c = new LRUCache(3);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.deepEqual(c.keys(), ["a", "b", "c"]);
  c.get("a"); // touch "a" -> most recent
  assert.deepEqual(c.keys(), ["b", "c", "a"]);
});

// --- delete -----------------------------------------------------------------
run("delete removes an existing key and returns true", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  assert.equal(c.delete("a"), true);
  assert.equal(c.has("a"), false);
  assert.equal(c.size, 0);
});

run("delete on missing key returns false", () => {
  const c = new LRUCache(2);
  assert.equal(c.delete("nope"), false);
});

run("delete frees a slot so no eviction occurs", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.delete("a");
  c.set("c", 3); // slot free, "b" must survive
  assert.equal(c.has("b"), true);
  assert.equal(c.has("c"), true);
  assert.equal(c.size, 2);
});

// --- clear ------------------------------------------------------------------
run("clear empties the cache but preserves capacity", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.get("a"), undefined);
  assert.deepEqual(c.keys(), []);
  c.set("x", 1);
  c.set("y", 2);
  c.set("z", 3); // eviction still works at original capacity
  assert.equal(c.size, 2);
});

// --- edge-case key values ---------------------------------------------------
run("supports falsy and special keys and values", () => {
  const c = new LRUCache(4);
  c.set(0, "zero");
  c.set(false, "no");
  c.set("", "empty");
  c.set(NaN, "nan");
  assert.equal(c.get(0), "zero");
  assert.equal(c.get(false), "no");
  assert.equal(c.get(""), "empty");
  assert.equal(c.get(NaN), "nan"); // SameValueZero: one NaN slot
  assert.equal(c.size, 4);
});

run("stores undefined as a real value distinct from absence", () => {
  const c = new LRUCache(2);
  c.set("a", undefined);
  assert.equal(c.has("a"), true);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.size, 1);
});

console.log("ALL TESTS PASSED");
process.exit(0);
