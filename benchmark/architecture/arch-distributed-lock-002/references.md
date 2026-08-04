## Intent

Probes the deep insight that distributed locks alone do not guarantee mutual exclusion of *effects* under process pauses -- correctness requires fencing and cooperation from the protected resource.

## Assumptions

Assume multiple replicas for availability, real GC/network pauses, clock skew, and an exactly-once-per-tick requirement. No mandated coordination service.

## Reviewer notes

A strong answer treats the lock as advisory, adds a monotonic fencing token validated at the resource, and explains that the resource -- not just the lock service -- must reject stale holders. It reasons about coordinator partition (stall vs risk double-run) and clock skew. A weak answer trusts a TTL lock to guarantee single execution, ignores the pause-past-lease scenario, or puts no protection at the resource.
