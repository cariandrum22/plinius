## Intent

Probes observability design for distributed systems: using metrics, logs, and traces for their distinct strengths and propagating trace context to follow a request end-to-end and localize faults.

## Assumptions

Assume many services, per-team-siloed logs, and requests spanning many hops. No mandated vendor or tool.

## Reviewer notes

A strong answer explains the complementary roles of the three pillars, describes trace-context propagation and per-hop instrumentation, chooses signals that separate a culprit from a victim, and confronts cost, sampling, and cardinality. A weak answer treats logs/metrics/traces as the same, offers no correlation across services, or ignores data-volume/cost realities.
