## Intent

Probes understanding that ordering guarantees must be scoped to the entity that requires them (here, per-account) and delivered via partition keys, trading global order for scalable per-key order.

## Assumptions

Assume high throughput, horizontal consumers, at-least-once transport, and a per-account correctness requirement. No mandated broker.

## Reviewer notes

A strong answer identifies per-account (not global) ordering as sufficient, uses a partition key to get it, reasons about rebalancing effects, and makes consumers robust to duplicates/out-of-order via sequencing or idempotent application. It handles late/missing events and recovery. A weak answer insists on a single global ordered stream (unscalable), ignores redelivery, or assumes exactly-once transport with no mechanism.
