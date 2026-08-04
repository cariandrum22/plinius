## Intent

Probes finding an unstated load-bearing assumption in a plausible-sounding proof sketch, distinguishing a genuinely justified step from one that quietly relies on a fact the sketch never establishes.

## Assumptions

Assume the merge sort splits by position (a prefix/suffix split the reviewer should pin down), records carry stable original indices, and the <= tie-break is as written.

## Reviewer notes

A strong answer states the stability property across the recursion, distinguishes cross-half ties from within-half order, and identifies the precise unstated assumption the argument depends on, judging whether the conclusion is nonetheless true. A weak answer accepts the sketch, focuses only on the tie-break rule, or claims the algorithm is unstable without cause.
