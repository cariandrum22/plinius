## Intent

Probes the ability to reason precisely about the consistency/availability trade-off, and -- crucially -- to scope strong consistency to only the path that needs it rather than applying one uniform level.

## Assumptions

Assume a hard no-double-sell invariant, a desire for availability of non-critical paths during faults, and bursty contention on scarce items. No mandated datastore or vendor.

## Reviewer notes

A strong answer isolates the narrow critical section that truly needs serialization, keeps browsing/holding available, and stays internally consistent about what happens under partition (it does not claim both linearizable booking and full availability of that path simultaneously). It handles holds, duplicate requests, and abandoned-hold reclaim. A weak answer applies strong consistency everywhere (killing availability), claims to satisfy both goals fully with no sacrifice, or ignores retries and expiry.
