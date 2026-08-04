# Reason About a Boolean Encoding of an At-Most-One Constraint

In many combinatorial problems you must encode "at most one of the boolean
variables `x_1, ..., x_n` is true" into a conjunction of clauses (disjunctions of
literals) for a SAT solver. A common 'pairwise' encoding is:

```
For every pair i < j:   (not x_i) OR (not x_j)
```

Your task is to reason precisely about this encoding and its alternatives.

Please produce:

1. A precise argument that the pairwise encoding is **correct**: state, as a
   logical equivalence, that an assignment satisfies all the pairwise clauses if
   and only if at most one `x_i` is true. Prove both directions. Be explicit
   about the boundary cases: zero variables true, and exactly one true.

2. A **size analysis**: how many clauses does the pairwise encoding produce as a
   function of `n`, and why can this be a problem at scale? State the count
   precisely.

3. An analysis of an **auxiliary-variable ("commander"/sequential) encoding**
   that introduces fresh variables to reduce clause count. Without giving a full
   construction, argue what property such an encoding must preserve to be
   correct -- specifically, **equisatisfiability** with respect to the original
   variables (the fresh variables may take any consistent value), and why
   introducing fresh variables does not change the set of satisfying assignments
   *projected onto* the original `x_i`. Explain the subtle difference between
   logical equivalence and equisatisfiability here.

State your assumptions.
