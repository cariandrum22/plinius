# Argue Correctness of LRU Cache Eviction

An LRU cache with capacity `C >= 1` is specified informally as: "`get(k)` and
`put(k,v)` both count as uses; when a `put` would exceed capacity, evict the key
whose most recent use is oldest." A candidate implementation uses a hash map plus
a doubly linked list ordered most-recently-used (front) to least (back):

```
map:  key -> node        # node holds key, value, and list links
list: MRU at front ... LRU at back

get(k):    if k not in map: return MISS
           move node(k) to front; return node(k).value

put(k,v):  if k in map:  node(k).value = v; move node(k) to front; return
           if size == C: evict = list.back; remove evict from list and map
           create node(k,v) at front; add to map
```

Your task is to argue the implementation meets the specification -- or find where
it does not.

Please produce:

1. A precise statement of the **representation invariant** coupling the map and
   the list (e.g. the map's key set equals the list's key set, no duplicates,
   size bounded by C) and the **ordering invariant** that the list order reflects
   recency of use.

2. An argument that each operation **preserves** these invariants and
   **implements the spec**: in particular, that the element evicted on an
   overflow `put` is exactly the least-recently-used key per the specification's
   definition of "use". Be explicit about whether `get` on a miss counts as a
   use and whether updating an existing key's value counts as a use.

3. A **correctness verdict** on one subtle point: does re-`put`ting an existing
   key (value update) correctly refresh recency, and is the ordering invariant
   ever violated between the two mutations inside `put`? If you find a real gap
   or ambiguity against the spec, state it precisely; if not, argue why not.

State your assumptions.
