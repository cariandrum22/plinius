# Context

**Vector** has grown from a monolith into ~30 microservices. When something is
slow or failing, engineers cannot tell *where* -- a single user request now
crosses eight services, and each team only sees its own logs. Incidents drag on
because nobody can follow a request end-to-end or tell which service is the real
culprit versus a victim of an upstream problem.

# Your task

1. Design an observability strategy across the three pillars -- **metrics, logs,
   and traces** -- and explain what each is good for and how they complement each
   other. Avoid treating them as interchangeable.
2. Explain how a single request is followed end-to-end across services
   (correlation/trace propagation), and what has to be instrumented at each hop
   for that to work.
3. Recommend what to measure by default so on-call can quickly localize a problem
   (e.g. per-service latency/error/saturation signals) and distinguish a failing
   service from a downstream victim.
4. Address the practicalities: data volume and cost, sampling, and cardinality of
   labels/tags.
5. State the trade-offs and one alternative you considered.

Multiple valid strategies exist; the reasoning is judged.
