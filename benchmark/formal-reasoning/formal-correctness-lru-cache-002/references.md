## Intent

Probes reasoning about a two-structure representation invariant and whether the operations implement an informal recency specification, including the subtle 'what counts as a use' and mid-operation-consistency questions.

## Assumptions

Assume single-threaded execution, C>=1, correct pointer plumbing (the focus is on the recency/eviction logic, not linked-list mechanics), and the spec's definition that both get and put count as uses.

## Reviewer notes

A strong answer couples the two structures with a joint invariant, argues eviction selects the least-recently-used element under the spec's own notion of 'use', and resolves the value-update and mid-operation-consistency questions precisely. A weak answer reasons about the two structures independently, is vague about what counts as a use, or alleges a bug without a concrete violating sequence.
