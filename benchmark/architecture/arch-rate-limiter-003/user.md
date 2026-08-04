# Context

A public API platform serves thousands of customers across a fleet of stateless
API gateway nodes behind a load balancer. Each customer has a plan-defined limit
(e.g. 10,000 requests/minute) that must be enforced *globally* across all
gateway nodes, not per node. Requests for a single customer can land on any node.
The platform also wants short-burst allowances (a token-bucket-like feel) and
must return correct `429` responses with accurate `Retry-After` hints.
Correctness of enforcement matters commercially, but the limiter must add
minimal latency (single-digit milliseconds) and must not become a single point
of failure that takes down the whole API.

# Your task

1. Design a distributed rate-limiting mechanism that enforces per-customer
   global limits across many nodes. Specify the algorithm (e.g. token bucket,
   sliding window) and where counters live.
2. Analyze the **consistency vs latency vs accuracy** trade-off: perfectly
   accurate global counting implies coordination on every request. How much
   accuracy do you sacrifice, and how, to hit the latency budget?
3. Explain behavior under failure: what happens if the shared counter store is
   slow or unreachable? Fail open or fail closed -- justify the choice and its
   business implications.
4. Address hot keys (a single very high-volume customer) and clock/skew issues
   across nodes.
5. Give the trade-offs of your design and one rejected alternative.

There is more than one defensible design; the reasoning is what matters.
