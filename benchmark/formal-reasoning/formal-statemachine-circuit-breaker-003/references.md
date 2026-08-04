## Intent

Probes reasoning about a resilience state machine: the isolation safety property and failure bound, a bounded-trial invariant under concurrency, and oscillation/liveness toward recovery.

## Assumptions

Assume concurrent callers, a monotonic timer, and that counters are shared mutable state whose updates may interleave unless the answer specifies atomicity. Parameters F, T, K are positive.

## Reviewer notes

A strong answer states the isolation property and the failure bound precisely in the given parameters, gives a trial-admission invariant that survives concurrent success/failure interleavings, and characterizes flapping with a concrete condition plus the assumption needed for progress toward recovery. A weak answer ignores the half-open concurrency race, states bounds that are off by one or ignore interleaving, or treats oscillation only informally.
