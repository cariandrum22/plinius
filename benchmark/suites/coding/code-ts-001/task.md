# Fixed-Capacity LRU Cache (Node.js ESM)

Implement a fixed-capacity **Least-Recently-Used (LRU) cache** as a pure
Node.js ES module. Your solution will be imported by an automated test harness
and must pass every assertion.

## Deliverable

Produce a single file named exactly **`solution.mjs`** at the workspace root.
It must be valid Node.js ESM, use only Node built-in modules (no third-party
packages, no build or transpile step), and export a **named** class:

```js
export class LRUCache { /* ... */ }
```

Do **not** output the test harness — it is provided for you and will be run
against your file.

## API contract

`LRUCache` must implement exactly this surface:

### `constructor(capacity)`
- `capacity` is the maximum number of entries the cache may hold.
- If `capacity` is not a **positive integer** (i.e. not an integer `>= 1`),
  throw a `TypeError`. This includes `0`, negatives, non-integers like `1.5`,
  `NaN`, and non-number values such as `"3"`, `null`, `undefined`, `{}`.

### `get capacity`
- Getter returning the configured capacity.

### `get size`
- Getter returning the current number of stored entries.

### `has(key)`
- Returns `true` if `key` is present, else `false`.
- **Must not** change recency ordering (a membership test is not a use).

### `get(key)`
- Returns the stored value, or `undefined` if the key is absent.
- On a hit, marks the entry as **most-recently-used**.

### `set(key, value)`
- Inserts a new entry or updates an existing key's value.
- Either way, marks the entry as **most-recently-used**.
- Updating an existing key must **not** grow `size` and must **not** trigger an
  eviction.
- Inserting a **new** key when the cache is already full must **evict the
  least-recently-used entry** (so `size` never exceeds `capacity`).
- Returns the cache instance (`this`) to allow chaining.

### `delete(key)`
- Removes `key` if present. Returns `true` if an entry was removed, else
  `false`.

### `clear()`
- Removes all entries. `capacity` is preserved and eviction continues to work
  afterward.

### `keys()`
- Returns an **array** of the current keys ordered from
  **least-recently-used first** to **most-recently-used last** (i.e. the first
  element is the next entry that would be evicted).

## Semantics and edge cases you must handle

- **Recency:** both `get` and `set` (including updates) refresh an entry to
  most-recently-used; `has` does not.
- **Capacity 1:** every insert of a distinct key evicts the previous one.
- **Key/value identity:** keys use `Map`/SameValueZero semantics. Falsy and
  special keys must work: `0`, `false`, `""`, and `NaN` (a single `NaN` slot).
- **`undefined` as a stored value:** `set(k, undefined)` stores a real entry —
  `has(k)` is `true`, `size` counts it, and it is distinct from an absent key.
- **Return values:** `delete` returns a boolean; `keys()` returns an array in
  the specified order; `set` returns the instance.

## Output format

Return `solution.mjs` in **one** of these forms:

- A JSON envelope, as the only content:
  `{"files":[{"path":"solution.mjs","content":"<full source>"}]}`
- Or a fenced code block whose info line is exactly `File: solution.mjs`
  containing the full source.

## How you are evaluated

An automated harness imports `LRUCache` from your `solution.mjs` and runs
assertions covering the core behavior and every edge case above. It prints
`ALL TESTS PASSED` and exits `0` on success. Your solution must make it pass.
