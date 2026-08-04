## Intent

Probes rigorous reasoning about boolean constraint encodings: proving a biconditional both directions, counting clauses, and reasoning about what must be preserved when auxiliary variables are introduced.

## Assumptions

Assume standard propositional semantics, that clauses are conjoined, and that 'at most one' includes the zero-true case as satisfying. Auxiliary variables are fresh (do not occur elsewhere).

## Reviewer notes

A strong answer proves the biconditional in both directions with the boundary cases handled, states the clause count precisely, and correctly characterizes what an auxiliary-variable encoding must preserve with respect to the original variables rather than over-claiming. A weak answer proves only one direction, miscounts, or overstates the relationship the fresh variables provide.
