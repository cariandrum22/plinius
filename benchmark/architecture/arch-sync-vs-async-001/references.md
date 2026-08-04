## Intent

Probes the ability to reason about a foundational integration trade-off (sync coupling vs async decoupling) and to follow the chosen option's consequences through failure and status-visibility.

## Assumptions

Assume payment already succeeds before the handoff, and that customer experience during fulfillment outages is the core pain. No mandated messaging technology.

## Reviewer notes

A strong answer weighs coupling/latency/failure-isolation/consistency honestly, commits to one option for this pain, and then handles the hard consequence of that choice (post-success failure and status visibility for async; outage isolation for sync). A weak answer declares 'async is better' as dogma, ignores eventual-failure handling, or lists pros/cons without a decision.
