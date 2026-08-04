## Intent

Probes pragmatic maintainability work: safely refactoring a tangled, poorly-tested, live service by separating concerns behind a test safety net, incrementally.

## Assumptions

Assume a live, business-critical service, a large tangled class, minimal tests, and no downtime for a rewrite.

## Reviewer notes

A strong answer establishes characterization/seam tests before changing behavior, separates I/O from business logic from external calls so pieces become testable, and sequences small shippable steps with an explicit risk. A weak answer proposes a rewrite, refactors with no tests to catch regressions, or only renames things without addressing testability.
