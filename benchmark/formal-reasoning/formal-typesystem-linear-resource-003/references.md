## Intent

Probes reasoning about substructural (linear) typing and resource safety: how context management interacts with branching, and what a correct branching rule must guarantee.

## Assumptions

Assume a substructural type system with no implicit weakening/contraction on linear variables, that only one branch of an if executes at runtime, and that the goal is exactly-once consumption of every Handle.

## Reviewer notes

A strong answer analyzes how the proposed rule manages the branch contexts, either exhibits a well-typed program that leaks or double-consumes a resource or argues soundness, and (if a fix is needed) states a corrected rule with an argument for why it restores exactly-once, including post-branch uses. A weak answer accepts the proposed rule uncritically, offers an example that does not type-check, or 'fixes' the rule without explaining the branching principle.
