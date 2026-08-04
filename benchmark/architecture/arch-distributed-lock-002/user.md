# Context

**Cronus** runs scheduled jobs (billing runs, report generation, cleanup) that
must each execute **exactly once per schedule tick**, even though the scheduler
runs as multiple replicas for availability. If two replicas both think they own a
job, a customer gets billed twice. The team is considering a distributed lock so
that only one replica runs a given job at a time, but they are worried about the
classic failure: a replica acquires the lock, pauses (GC, network stall), its
lease expires, another replica takes over -- and then the first replica wakes up
believing it still holds the lock.

# Your task

1. Design a coordination mechanism so that at most one replica acts as the owner
   of a given job at a time. Explain leader/ownership election and lease/TTL
   semantics.
2. Confront the **stalled-holder** problem directly: a process that pauses past
   its lease and then resumes. Explain a fencing or validation mechanism that
   prevents the stale holder from corrupting shared state, and where that
   protection must live.
3. Explain why a lock alone is generally insufficient for correctness and what
   additional property the *protected resource* must provide.
4. Address clock skew, lease renewal, and what happens when the coordination
   service itself is partitioned or unavailable -- do jobs stall or risk
   double-run? Justify.
5. State the trade-offs and one alternative you considered.

There is more than one defensible design; the reasoning is central.
