## Intent

Probes specifying exactly-once-effect semantics precisely: defining request identity, stating the effect guarantee as a safety property, and pinning the crash and concurrency cases where naive idempotency specs silently break.

## Assumptions

Assume an unreliable network (retries, reordering, duplication), a server that can crash between any two steps, and durable-but-finite storage for idempotency records. The customer must never be charged twice for one logical request.

## Reviewer notes

A strong answer treats the effect-and-record as a single atomic step, is explicit about the same-key-different-body conflict and the in-flight duplicate race, and distinguishes which guarantees are safety and which depend on liveness. A weak answer reduces idempotency to response caching, ignores the crash-between-steps window, or states a guarantee that is vacuously satisfiable.
