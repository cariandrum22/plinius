# Task

`octoq` is an internal Go background-job-processing library (comparable in spirit to Sidekiq/Celery) used by roughly 40 services across the company. You maintain it. Version 3.0.0 introduces several breaking changes that were necessary to support a second broker backend (SQS, in addition to Redis) and to close a set of long-standing operational footguns. The change is done and merged; your job now is to write the migration guide that will ship in the release notes and docs site, since every one of those ~40 service teams will need to upgrade during the deprecation window before v2 support ends.

## What changed, in detail

**1. Config file structure.**

v2 config (YAML) was flat:

```yaml
concurrency: 25
redis_url: "redis://cache.internal:6379/0"
queues:
  default: 10
  billing: 5
  low_priority: 2
retry:
  max: 25
  backoff_seconds: 30
metrics_port: 9090
```

v3 config groups related settings and changes several defaults and semantics:

```yaml
worker:
  queues:
    default:
      max_workers: 10
    billing:
      max_workers: 5
    low_priority:
      max_workers: 2
broker:
  driver: redis        # or "sqs"
  url: "redis://cache.internal:6379/0"
retry:
  max_attempts: 10
  backoff:
    strategy: exponential
    base_seconds: 2
    max_seconds: 300
    jitter: true
metrics:
  port: 9091
  path: "/internal/metrics"
```

Notes on the changes:
- The old top-level `concurrency` key (a single global worker-pool size) no longer exists in any form; concurrency is now only configurable per-queue via `worker.queues.<name>.max_workers`. There is no v3 equivalent of "one global number"; a v2 config that only set `concurrency: 25` and relied on it being divided automatically across queues has no direct v3 replacement value — each queue's `max_workers` must be set explicitly.
- `queues.<name>: <int>` (a bare integer) becomes `worker.queues.<name>.max_workers: <int>` (the same integer, now nested).
- `redis_url` becomes `broker.url`, and a new required key `broker.driver` must be set explicitly (`redis` or `sqs`); v2 assumed Redis implicitly and had no `driver` concept.
- `retry.max` (default `25` in v2) becomes `retry.max_attempts`, and the v3 *default* if omitted is `10`, not `25`. This is a behavior change even for teams who never explicitly set `retry.max` in v2 and were relying on the implicit default.
- `retry.backoff_seconds` (a fixed delay in seconds between every retry, default `30`) is replaced by `retry.backoff.*`, an exponential-with-jitter scheme: delay before attempt *n* is approximately `min(base_seconds * 2^(n-1), max_seconds)` with up to +/-20% random jitter applied. There is no config option to restore a fixed-delay retry schedule in v3.
- `metrics_port` becomes `metrics.port`, and the v3 default changes from `9090` to `9091` if the key is omitted. The metrics path also changes from the hardcoded `/metrics` (v2 had no path option) to a configurable `metrics.path`, defaulting to `/internal/metrics` in v3.
- **Strict validation**: in v2, unknown top-level keys in the config file were ignored, with a single `WARN unknown config key: %s` line logged at startup. In v3, any unrecognized key anywhere in the config (top-level or nested) causes the process to exit immediately with a nonzero status code and a fatal log line naming the offending key, before any worker starts.

**2. CLI flags.**

- `--legacy-heartbeat` (v2) allowed starting a worker process with heartbeat/liveness reporting to the coordinator disabled entirely — used by some teams for quick local runs against a shared dev coordinator without polluting its liveness dashboard. This flag has been **removed** in v3; heartbeat reporting is always on and cannot be disabled from the CLI or config.
- `--queues name:concurrency,name:concurrency` (v2) allowed overriding queue concurrency at process-start time without editing the config file — used in some deploy pipelines to scale a queue up for a batch job via a command-line override. This flag has been **removed** in v3; queue configuration (including `max_workers`) is read only from the config file, so any deploy-time override must now edit or template the config file itself.

**3. Programmatic Go API.**

v2:

```go
cfg := octoq.Config{
    Concurrency: 25,
    RedisURL:    "redis://cache.internal:6379/0",
    RetryMax:    25,
}
worker := octoq.Configure(cfg)
```

v3:

```go
cfg := octoq.Config{
    Broker: octoq.BrokerConfig{
        Driver: "redis",
        URL:    "redis://cache.internal:6379/0",
    },
    Retry: octoq.RetryConfig{
        MaxAttempts: 10,
    },
    Queues: map[string]octoq.QueueConfig{
        "default": {MaxWorkers: 10},
    },
}
worker := octoq.Configure(cfg)
```

`octoq.Config.Concurrency`, `octoq.Config.RedisURL`, and `octoq.Config.RetryMax` no longer exist as fields; the struct will fail to compile against v2 call sites. There is no deprecated-but-functional shim; v3 removed the old fields outright rather than aliasing them.

## Deliverable

Write the migration guide that will be published for the ~40 consuming teams upgrading from octoq v2 to v3. It should explain what changed and why it matters operationally (not just restate the diff), give step-by-step upgrade instructions covering the config file, CLI usage, and the Go API, show concrete before/after examples, call out the pitfalls a team could hit if they upgrade carelessly (including any change that is easy to miss because it's a default change rather than a removed key), and include guidance on how a team could roll back if the upgrade causes problems in production.
