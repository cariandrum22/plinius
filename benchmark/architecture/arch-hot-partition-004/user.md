# Context

**Ledgerly** offers a multi-tenant SaaS backed by a horizontally partitioned
(sharded) key-value/NoSQL store where the partition key determines which
physical node holds the data. Tenants vary enormously in size: most are small,
but a handful of enterprise tenants generate 1000x the traffic and data volume
of a typical tenant. The current partition key is `tenant_id`, which means a
single large tenant's data and traffic all land on one partition, creating **hot
partitions** that throttle while the rest of the fleet is idle. Some access
patterns also concentrate on the most-recent time window, creating a moving
hotspot.

# Your task

1. Diagnose why the current partition-key choice produces hot partitions, both
   from tenant skew and from time-based access concentration.
2. Propose a partition-key / data-modeling strategy that spreads load evenly
   while still supporting the required query patterns (per-tenant reads, recent-
   activity reads). Explain the write-distribution vs query-locality tension your
   choice creates.
3. Address the large tenants specifically -- should they be isolated, split, or
   handled differently? Justify.
4. Explain how you would migrate from the current key scheme to the new one
   without downtime or data loss.
5. Analyze the trade-offs (query fan-out, hot-key mitigation, operational
   complexity) and give one rejected alternative.

Assume you cannot switch database technologies, only the data model and keys.
