# Context

A platform suffers **intermittent** tail-latency spikes: a small fraction of user
requests occasionally take 10x longer, seemingly at random, across a system of
many services sharing databases, caches, queues, and a network. It is not
reproducible on demand, the p50 looks fine, dashboards show nothing obviously
wrong, and the current logging/metrics were designed for the happy path. On-call
has spent weeks unable to find root cause.

# Your task

1. Explain why the *current* observability likely fails to catch this class of
   problem (aggregate metrics hiding tail behavior, no per-request causal view,
   sampling that discards the rare slow requests).
2. Design an observability approach specifically aimed at **rare, tail, hard-to-
   reproduce** latency: how do you capture and retain the slow outliers, attribute
   time across services, and see contention on shared resources (locks, pools,
   queues, GC, noisy neighbors)?
3. Address sampling deliberately: how do you keep the interesting (slow, errored)
   requests instead of sampling them away, while controlling cost?
4. Propose how to move from symptom to root cause -- the signals and correlations
   that would distinguish, say, a saturated connection pool from a slow
   dependency from lock contention.
5. State the trade-offs (overhead, cost, cardinality) and one alternative you
   considered.

There is more than one valid approach; the reasoning is judged.
