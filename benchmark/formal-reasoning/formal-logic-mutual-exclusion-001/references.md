## Intent

Probes precise temporal formalization of the classic mutual-exclusion requirements, the safety/liveness split, the fairness assumption a liveness property depends on, and awareness of vacuous 'liveness' properties.

## Assumptions

Assume an interleaving concurrency model with a scheduler, that a process in CRITICAL eventually leaves it, and that fairness must be stated explicitly (it is not free). Operator meanings are as the answer defines them.

## Reviewer notes

A strong answer writes mutual exclusion as a precise safety formula, distinguishes the two liveness properties and shows why one is strictly stronger, names the fairness assumption the stronger one requires, and exhibits a genuinely vacuous 'liveness' formula with a fix. A weak answer conflates the two liveness properties, omits fairness, or offers a vacuity example that is not actually vacuous.
