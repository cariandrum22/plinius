## Intent

Probes write-path scaling for a high-throughput, bursty, durability-sensitive workload, including buffering/backpressure and time-series storage design.

## Assumptions

Assume sustained high write rates with sharp bursts, a no-silent-loss requirement, and recent-window/aggregate query patterns. No specific vendor product is required.

## Reviewer notes

A strong answer decouples ingest from storage with a durable buffer, reasons explicitly about backpressure and acknowledgement semantics, and picks a time-series-appropriate storage/retention/rollup scheme tied to the query profile. It is honest about where loss is still possible. A weak answer scales the single database, ignores bursts or backpressure, or provides no durability reasoning.
