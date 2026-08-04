## Intent

Probes deep data-modeling judgment for partitioned stores: reconciling even write distribution against query locality under extreme tenant skew and time-based hotspots.

## Assumptions

Assume a fixed partitioned datastore, extreme tenant size skew, and mixed per-tenant and recent-window query patterns. No downtime for migration.

## Reviewer notes

A strong answer explains the mechanism of hot partitions precisely, then chooses a key scheme (e.g. composite/salted keys, tenant-tier isolation, write-sharding of recent data) that trades a controlled amount of query fan-out for even distribution, and gives a live migration path. It treats the largest tenants distinctly. A weak answer suggests just adding capacity, proposes a random key that breaks per-tenant queries, or ignores migration and the locality cost.
