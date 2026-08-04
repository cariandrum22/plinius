## Intent

Probes the quorum-intersection safety argument for uniqueness and the distinction between per-term safety and cross-term situations that election alone does not resolve.

## Assumptions

Assume crash-recovery nodes with durable last-voted-term records, asynchronous lossy links, terms that only increase, and majority = strictly more than N/2.

## Reviewer notes

A strong answer states the per-term uniqueness property, drives the quorum-intersection contradiction, pins exactly why a strict majority rather than a plurality is required, and correctly separates per-term uniqueness from the cross-term stale-leader situation. A weak answer asserts uniqueness without the intersection argument, misplaces the majority requirement, or claims partitions break per-term safety.
