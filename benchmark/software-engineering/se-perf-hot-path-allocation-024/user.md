## Context

You are reviewing the request hot path of a Go service that sits in front of a real-time bidding system, handling incoming ad-request events. The handler validates a request, builds a structured audit-log entry, records a few metrics labels, and serializes a response fragment. It runs on every request, at sustained volumes of several thousand requests per second per instance.

```go
package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
)

type AuditEntry struct {
	Fields map[string]interface{}
}

var metricLabels []string

// HandleAdRequest is invoked on every incoming ad request. It validates the
// request, appends a metrics label, builds an audit entry, and writes a
// small JSON acknowledgement back to the caller.
func HandleAdRequest(w http.ResponseWriter, r *http.Request) {
	requestID := r.URL.Query().Get("rid")
	placementID := r.URL.Query().Get("pid")
	bidFloorRaw := r.URL.Query().Get("floor")

	bidFloor, err := strconv.ParseFloat(bidFloorRaw, 64)
	if err != nil {
		http.Error(w, "invalid floor", http.StatusBadRequest)
		return
	}

	// Build a human-readable summary for logging/tracing.
	summary := "request " + requestID + " placement=" + placementID + " floor=" + bidFloorRaw

	// Record a metrics label for this request's placement.
	metricLabels = append(metricLabels, "placement:"+placementID)

	// Build a structured audit entry with boxed values.
	entry := AuditEntry{
		Fields: map[string]interface{}{
			"request_id":  requestID,
			"placement":   placementID,
			"bid_floor":   bidFloor,
			"summary":     summary,
			"served_from": "edge-1",
		},
	}

	logAuditEntry(entry)

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	if err := enc.Encode(map[string]interface{}{
		"request_id": requestID,
		"accepted":   true,
	}); err != nil {
		http.Error(w, "encode error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(buf.Bytes())
}

// logAuditEntry formats and writes an audit entry. In production this is
// wired to an async log shipper; the formatting itself happens synchronously
// on the request path.
func logAuditEntry(entry AuditEntry) {
	line := fmt.Sprintf("audit: %v", entry.Fields)
	_ = line // written to the log shipper's buffered channel elsewhere
}
```

`HandleAdRequest` is registered as the handler for the highest-volume route in the service. It is invoked directly per HTTP request with no additional buffering in front of it beyond the standard library's server.

## Observed symptoms

Profiling data collected from production during peak traffic (roughly 8,000 requests/sec per instance) shows:

- A CPU and heap profile taken with `net/http/pprof` attributes a significant share of both CPU time and allocated bytes to this handler and its callees, with an average of roughly 18 heap allocations and 3.4 KB allocated per request, essentially all attributable to this function and the two helper calls it makes.
- Running the service with `GODEBUG=gctrace=1` shows garbage collection cycles firing roughly every 350-450ms during peak load, with each cycle briefly consuming multiple CPU cores; the reported GC CPU fraction is approximately 11-13% during this period, compared to under 2% at low traffic.
- Latency measurements show a median (p50) response time of about 12ms, but p99 latency during peak traffic spikes to 100-140ms, and these spikes are visibly correlated in time with the logged GC cycles rather than with any single slow dependency.
- The `metricLabels` slice's backing array is observed (via heap profile growth over the lifetime of the process) to be reallocated and copied repeatedly as it grows, and its retained memory only resets on process restart.

## Deliverable

Provide:

1. An analysis of the specific sources of per-request heap allocation and unnecessary retained memory in this code, explaining the mechanism behind each one (e.g., why a particular construct allocates on the heap rather than the stack, why a particular data structure requires boxing, and why a particular pattern causes repeated growth/copy behavior) and how each connects to the observed allocs/op, GC frequency, GC CPU fraction, and p99 latency correlation with GC cycles.
2. A set of targeted optimizations to reduce allocation pressure on this path, addressing the sources you identified. For each optimization, state any correctness or safety caveats it introduces (e.g., object reuse and pooling safety across goroutines, data lifetime/retention when reusing buffers, or behavior changes visible to callers) and be explicit about which changes you expect to meaningfully reduce allocations versus which are minor or situational.
3. A measurement and benchmarking plan to validate that your changes actually reduce allocation pressure and improve tail latency, and to catch regressions going forward — including what you would measure, at what level (micro-benchmark vs. profiling vs. production load), and what you would consider a meaningful before/after result versus noise.
