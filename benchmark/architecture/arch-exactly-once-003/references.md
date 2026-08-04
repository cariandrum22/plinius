## Intent

Probes the crucial distinction between exactly-once delivery (unattainable) and exactly-once effect (attainable via idempotency, dedup, or transactional commit), and end-to-end correctness across a crash-prone read-process-write cycle.

## Assumptions

Assume at-least-once transport, crashable components, and a non-transactional external database that cannot enlist in the broker's transaction. No mandated framework.

## Reviewer notes

A strong answer reframes the goal as exactly-once effect, then makes the read-process-write cycle safe across crashes (atomic offset+output commit, or idempotent/keyed writes with dedup), and honestly places transaction boundaries where they really are. It pushes idempotency to downstream consumers too. A weak answer claims exactly-once delivery is achievable, assumes the DB joins the broker transaction, or ignores the crash-between-steps window.
