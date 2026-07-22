
# Technical Explainer: Unbounded Queues and Tail-Latency Collapse

## Audience

Senior distributed-systems and performance engineers. Assume the reader knows
basic queueing theory, percentile latency, and backpressure. Do not explain
undergraduate fundamentals; go straight to the subtle mechanism.

## The topic

Write a precise technical explainer answering: **why do unbounded (or
effectively very large) request queues cause tail-latency to collapse under
sustained load, even while mean throughput looks healthy?**

A strong answer explains the interaction between arrival rate, service rate,
and queue occupancy; why the failure is a *latency* failure long before it is a
*throughput* failure; and why simply "adding more buffering" makes the tail
worse, not better.

## What you must produce

A single Markdown document, **at most 700 words**, with exactly these four
level-2 sections, in this order:

1. `## Facts` — Established, verifiable claims: mathematical results
   (e.g. Little's Law, the behavior of waiting time as utilization rho -> 1),
   and empirically well-documented phenomena. State only what is genuinely known.
2. `## Assumptions` — The premises your explanation depends on but which are not
   universally true: workload shape, arrival process, service-time distribution,
   whether clients retry, whether the queue is FIFO, etc. Make them explicit so a
   reader can check whether your explanation applies to their system.
3. `## Hypotheses` — Falsifiable causal conjectures about mechanism and
   mitigation that you are proposing, not asserting as fact. Frame each so it
   could be tested and disproved.
4. `## Trade-offs` — Contrast **at least two** competing mitigations
   (for example: bounded queue + load-shedding, admission control, LIFO/
   deadline-aware scheduling, or client-side backpressure). For each, state what
   it sacrifices and under what conditions you would prefer it.

## Rules

- Keep the epistemic categories clean: do not smuggle a hypothesis into Facts,
  and do not hedge a genuine fact into Assumptions.
- Use queueing-theory terminology correctly: utilization `rho = lambda / mu`,
  arrival rate `lambda`, service rate `mu`, and Little's Law
  (`L = lambda * W`). Be precise about the difference between utilization,
  throughput, and occupancy.
- Prose only under each heading. No code blocks are required.
- Be concise. A dense, correct 500-word answer beats a padded 700-word one.
- Do not use promotional or marketing language.
