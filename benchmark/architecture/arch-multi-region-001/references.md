## Intent

Probes cloud multi-region design where the real difficulty is stateful data: reasoning about single-writer vs multi-writer replication, conflict, latency, and realistic RPO/RTO.

## Assumptions

Assume a stateful relational core plus stateless services, a desire to survive a full region loss, and unavoidable cross-region latency. No mandated cloud vendor.

## Reviewer notes

A strong answer is honest that active-active *data* is the crux, weighs single-writer vs multi-writer with conflict and write-latency implications, states concrete RPO/RTO, and handles failback/split-brain. A weak answer makes only the stateless tier multi-region, claims zero-RPO active-active writes with no conflict cost, or ignores split-brain on region recovery.
