## Intent

Probes formulating a size/rank invariant at the right granularity and carrying out a careful multi-branch inductive case analysis, including the delicate rank-changing merge case.

## Assumptions

Assume the given code (no path compression) unless part 3 is discussed, distinct elements, and that ranks only change in the equal-rank union branch. Trees are always the result of a sequence of unions from singletons.

## Reviewer notes

A strong answer formulates the rank-versus-size relationship at the right granularity and handles the rank-changing merge case explicitly in the induction, keeping rank and depth distinct. A weak answer conflates depth with rank, mishandles or skips the increment case, or proposes an invariant that is not actually preserved by every union branch.
