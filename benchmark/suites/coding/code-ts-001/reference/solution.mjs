// Reference implementation of a fixed-capacity LRU cache.
// Relies on the insertion-order guarantee of the built-in Map.

export class LRUCache {
  #capacity;
  #map;

  constructor(capacity) {
    if (
      typeof capacity !== "number" ||
      !Number.isInteger(capacity) ||
      capacity < 1
    ) {
      throw new TypeError("capacity must be a positive integer");
    }
    this.#capacity = capacity;
    this.#map = new Map();
  }

  get capacity() {
    return this.#capacity;
  }

  get size() {
    return this.#map.size;
  }

  has(key) {
    // Membership test must NOT change recency.
    return this.#map.has(key);
  }

  get(key) {
    if (!this.#map.has(key)) {
      return undefined;
    }
    const value = this.#map.get(key);
    // Touch: move to most-recently-used position.
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.#map.has(key)) {
      // Update existing entry and mark most-recently-used.
      this.#map.delete(key);
      this.#map.set(key, value);
      return this;
    }
    this.#map.set(key, value);
    if (this.#map.size > this.#capacity) {
      // Evict the least-recently-used entry (first in insertion order).
      const oldest = this.#map.keys().next().value;
      this.#map.delete(oldest);
    }
    return this;
  }

  delete(key) {
    return this.#map.delete(key);
  }

  clear() {
    this.#map.clear();
  }

  keys() {
    // Least-recently-used first, most-recently-used last.
    return [...this.#map.keys()];
  }
}
