# Context

**Fleetsense** collects telemetry from 2 million IoT devices in the field. Each
device emits a batch of sensor readings every 10 seconds, producing a sustained
~200k writes/second with bursts to 600k/second when large fleets reconnect after
a network outage. The data is time-series in nature, is queried later for
dashboards and alerting (mostly recent-window and aggregate queries), and must
not be silently lost. Today a single relational database is the write target and
it is saturated; ingestion lag during bursts has caused missed alerts.

# Your task

1. Design an ingestion architecture that sustains the steady write rate and
   absorbs reconnection bursts without data loss.
2. Explain your approach to **backpressure and buffering**: what happens when a
   downstream component is slower than the incoming rate?
3. Choose a storage strategy appropriate for time-series data and the query
   patterns described, and justify it (partitioning, retention, rollups/
   downsampling).
4. Explain your durability guarantees: where can data be lost, and how do you
   bound or eliminate that? Distinguish acknowledged vs unacknowledged writes.
5. Analyze the trade-offs of your design -- cost, latency to queryability,
   operational complexity -- and describe one alternative you rejected.

Assume you may introduce new infrastructure components.
