## Intent

Probes distributed coordination under a tight latency budget: enforcing a global invariant (a limit) across stateless nodes without per-request strong consistency, and reasoning about the accuracy it costs.

## Assumptions

Assume many stateless nodes, any node can serve any customer, a low-latency requirement, and commercial sensitivity to enforcement errors. No mandated datastore.

## Reviewer notes

A strong answer picks a concrete algorithm, places counters deliberately, and confronts the fundamental accuracy-vs-latency tension (e.g. local buckets with async reconciliation, approximate windows) rather than claiming exactness for free. It handles store failure with a justified fail-open/closed stance, hot keys, and clock skew. A weak answer describes a single-node limiter, assumes a magic strongly-consistent global counter with no latency cost, or ignores failure modes.
