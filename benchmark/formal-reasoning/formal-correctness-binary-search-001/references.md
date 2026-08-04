## Intent

Probes the canonical partial-correctness-plus-termination reasoning for a search loop: a strong-enough loop invariant, its maintenance, and a strictly decreasing measure.

## Assumptions

Assume `a` is sorted ascending, indices are valid, and integer arithmetic does not overflow (the mid computation is written to avoid the classic overflow, which the answer may note). Duplicates are allowed.

## Reviewer notes

A strong answer states a loop invariant strong enough to justify both exit outcomes, uses sortedness to justify each window update, supplies a strictly-decreasing bounded measure, and checks the small-window cases where off-by-one errors hide. A weak answer argues from the equality check alone, uses an invariant too weak to justify the not-found return, or hand-waves termination.
