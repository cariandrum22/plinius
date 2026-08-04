## Intent

Probes proving that a cache is transparent: stating a caching invariant, a strong-induction correctness argument, and surfacing the assumptions that make memoization sound.

## Assumptions

Assume single-threaded execution, integer arithmetic without overflow unless raised, and that `memo` is only written by this function. Prior contents of `memo` may exist from earlier calls.

## Reviewer notes

A strong answer states a caching invariant capturing that stored entries are trustworthy, runs a clean strong induction covering both the hit and the compute branch, shows each write preserves the invariant, and surfaces the purity and single-writer assumptions the result depends on. A weak answer inducts only over the compute path, ignores the cache-hit branch's dependence on the invariant, or misses the assumptions that make memoization transparent.
