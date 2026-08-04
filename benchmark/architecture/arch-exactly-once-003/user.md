# Context

A stream-processing pipeline reads events from a durable log, transforms them,
and writes results to an external database and to a downstream topic. The
business needs each input event to affect the outputs **exactly once** in effect
-- no lost events, no duplicated side effects -- despite the reality that the
transport is at-least-once and that any component can crash and restart
mid-processing. Stakeholders keep saying "just make it exactly-once"; the team
knows this is subtler than it sounds.

# Your task

1. Clarify what "exactly-once" can and cannot mean here. Distinguish
   exactly-once *delivery* (generally impossible over an unreliable network) from
   exactly-once *effect/processing*, and frame the problem in the achievable
   terms.
2. Design the pipeline so each input produces its output effects exactly once.
   Address the read-process-write cycle: offsets/acknowledgement, the external
   database write, and the downstream publish. Explain how you avoid both loss
   and duplication across a crash between any two of these steps.
3. Explain the role of idempotency, deduplication, and/or transactional commits,
   and where the boundaries of any transaction actually lie (the external DB is
   not in the broker's transaction).
4. Address the output side: how do downstream consumers avoid acting twice on a
   duplicate the pipeline could not fully prevent?
5. State the trade-offs (throughput, latency, complexity) and one rejected
   alternative.

There is more than one valid approach; the reasoning is judged.
