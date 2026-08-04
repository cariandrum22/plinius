## Context

You are reviewing a Go HTTP service's in-process metrics collector. It wraps each route handler with middleware that records a request count and cumulative latency per route, plus a running total request count across all routes. A `/debug/metrics` endpoint periodically calls `Snapshot()` to expose the aggregated numbers to an internal dashboard.

The service handles requests concurrently (the standard library's `net/http` server runs each request in its own goroutine). Since this collector was added, the team has noticed two things: occasionally the process crashes outright with a runtime error during load testing, and separately, the numbers shown on the dashboard are sometimes visibly inconsistent with what load-testing tools report (e.g., the dashboard undercounts total requests by a small but nonzero margin compared to the load generator's own count of requests sent). Running the service's test suite with `go test -race` under a concurrent load simulation reliably reports a data race in this code.

Here is the collector:

```go
package metrics

import (
	"net/http"
	"time"
)

// Collector aggregates per-route request counts and cumulative latency
// for a lightweight in-process metrics endpoint, scraped every 15s by
// an internal dashboard.
type Collector struct {
	Total     int64
	byRoute   map[string]int64
	latencyNs map[string]int64
}

func NewCollector() *Collector {
	return &Collector{
		byRoute:   make(map[string]int64),
		latencyNs: make(map[string]int64),
	}
}

// Middleware wraps an http.Handler and records the request count and
// cumulative latency for the given route pattern.
func (c *Collector) Middleware(route string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		elapsed := time.Since(start).Nanoseconds()

		c.Total++
		c.byRoute[route]++
		c.latencyNs[route] += elapsed
	})
}

// Snapshot returns a point-in-time copy of the aggregated stats for the
// /debug/metrics endpoint.
func (c *Collector) Snapshot() (total int64, byRoute map[string]int64, avgLatencyNs map[string]int64) {
	byRoute = make(map[string]int64, len(c.byRoute))
	avgLatencyNs = make(map[string]int64, len(c.latencyNs))
	for route, n := range c.byRoute {
		byRoute[route] = n
		if n > 0 {
			avgLatencyNs[route] = c.latencyNs[route] / n
		}
	}
	return c.Total, byRoute, avgLatencyNs
}
```

A single `*Collector` is constructed once at startup and shared across all route handlers via `Middleware`.

## Deliverable

Provide:

1. A precise identification of every data race present in this code (there is more than one distinct kind), stating exactly which operations conflict and under what conditions.
2. An explanation grounded in Go's memory model and runtime behavior of why these races produce the two observed symptoms: (a) an outright process crash under load, and (b) a dashboard total that quietly undercounts real traffic rather than crashing.
3. A corrected implementation, or a precise enough description to implement one, along with a discussion of the trade-offs between at least two of the following approaches to fixing it: guarding the shared state with a `sync.Mutex`/`sync.RWMutex`, using `sync/atomic` counters, and sharding the counters (e.g., per-goroutine or per-CPU shards merged on read). Address how each option behaves under high contention (many concurrent requests across many distinct routes) versus the current low-cardinality route set.
