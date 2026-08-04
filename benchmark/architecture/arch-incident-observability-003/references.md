## Intent

Probes advanced observability/debuggability for rare tail-latency incidents: capturing outliers that aggregates and naive sampling hide, and attributing latency across shared resources to reach root cause.

## Assumptions

Assume intermittent, non-reproducible tail spikes, healthy-looking averages, happy-path-only instrumentation, and shared infrastructure with contention risk. No mandated vendor.

## Reviewer notes

A strong answer explains why aggregates and head-based sampling miss the rare slow requests, then designs tail-aware capture (tail-based sampling, exemplars, per-request causal traces, retained outliers) and attributes time across shared resources to separate saturation from slow dependencies from lock contention. It controls cost/cardinality honestly. A weak answer adds more dashboards, keeps head-based sampling that drops the outliers, or cannot connect signals to a specific root cause.
