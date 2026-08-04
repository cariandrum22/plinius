## Intent

Probes the correctness argument for a greedy algorithm: the finalization invariant, a contradiction/exchange proof, and precise identification of the single stated assumption the argument rests on.

## Assumptions

Assume a finite graph, non-negative weights for the main proof, a reachable-vertex framing (or +inf for unreachable), and a correct priority selection of the minimum tentative distance.

## Reviewer notes

A strong answer isolates the finalization invariant, runs a clean contradiction argument for the greedy pick, pinpoints the exact step that depends on the edge-weight assumption, and then shows precisely which step fails and gives a minimal counterexample when that assumption is dropped. A weak answer asserts greedy optimality, never localizes where the assumption is used, or offers a counterexample that does not actually defeat the finalization step.
