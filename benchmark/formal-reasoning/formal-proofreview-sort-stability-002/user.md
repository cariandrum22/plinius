# Find the Gap in a Merge-Sort Stability Proof Sketch

'Stable' sorting means equal-key elements retain their original relative order.
Consider the merge step of a merge sort over records with a `key`:

```
merge(L, R):          # L and R are each already sorted and stable
    result = []
    i = j = 0
    while i < len(L) and j < len(R):
        if L[i].key <= R[j].key:      # note: <=
            result.append(L[i]); i += 1
        else:
            result.append(R[j]); j += 1
    append the remaining elements of L, then of R
    return result
```

A colleague argues merge sort is **stable** with this sketch:

> "Both halves are stable by induction. In merge, when keys are equal we take
> from L first (because of the `<=`), so elements from the left half -- which
> came earlier in the original array -- are placed before equal elements from the
> right half. Therefore equal elements keep their order, so merge is stable, and
> by induction the whole sort is stable."

Your task is to review this argument.

Please produce:

1. A precise definition of the **stability invariant** for the recursive sort: it
   is not only about a single merge but about how the recursion splits the array.
   State what must be true about which original indices land in `L` versus `R`
   for the "left came earlier" claim to hold, and check whether the sketch states
   this.

2. An analysis of whether the sketch's **key step is justified**: the `<=`
   tie-break preserves order between an L element and an R element -- but does the
   sketch address equal elements *within* L, or *within* R? Explain why those are
   covered (or not) and by what part of the induction. Identify the precise
   **gap**: an assumption the sketch relies on but never states (about the split
   preserving original order).

3. A verdict: is merge sort (with this merge) actually stable, and is the sketch
   a valid proof? If the conclusion is true but the proof has a gap, state the
   missing lemma precisely. If a different split (e.g. one that reorders) would
   break stability, say so. Do not rewrite the proof; pinpoint the gap.

State your assumptions.
