## Context

You are reviewing a Go service that powers a pricing-aggregation endpoint. For each incoming request, the handler fans out to several upstream provider clients concurrently, collects their quotes, and returns the best price. The service has been in production for several months. Over the last few weeks, on-call engineers have noticed that memory usage and the number of live goroutines (as reported by `runtime.NumGoroutine()` in the `/debug/pprof` endpoint) climb steadily over the course of a day under normal traffic and only reset when the process is restarted. CPU usage is unremarkable. The leak is worse on days with elevated upstream latency or timeouts from one or more providers.

Here is the relevant code, trimmed to the aggregation path:

```go
package pricing

import (
	"context"
	"fmt"
	"time"
)

type Quote struct {
	Provider string
	Price    float64
	Err      error
}

type ProviderClient interface {
	FetchQuote(ctx context.Context, sku string) (float64, error)
}

// AggregateBestQuote fans out to all configured providers and returns the
// lowest price quote received before ctx is done or all providers respond.
func AggregateBestQuote(ctx context.Context, sku string, providers []ProviderClient) (Quote, error) {
	results := make(chan Quote)

	for _, p := range providers {
		p := p
		go func() {
			start := time.Now()
			price, err := p.FetchQuote(ctx, sku)
			_ = start // used for latency metrics elsewhere
			results <- Quote{
				Provider: providerName(p),
				Price:    price,
				Err:      err,
			}
		}()
	}

	var best Quote
	haveBest := false

	for i := 0; i < len(providers); i++ {
		select {
		case q := <-results:
			if q.Err != nil {
				continue
			}
			if !haveBest || q.Price < best.Price {
				best = q
				haveBest = true
			}
		case <-ctx.Done():
			if haveBest {
				return best, nil
			}
			return Quote{}, fmt.Errorf("aggregate best quote: %w", ctx.Err())
		}
	}

	if !haveBest {
		return Quote{}, fmt.Errorf("no provider returned a usable quote")
	}
	return best, nil
}

func providerName(p ProviderClient) string {
	type named interface{ Name() string }
	if n, ok := p.(named); ok {
		return n.Name()
	}
	return "unknown"
}
```

The HTTP handler that calls this function sets a per-request context timeout of 800ms (`context.WithTimeout`) before calling `AggregateBestQuote`, and providers typically respond within 50-200ms, but one third-party provider has occasional latency spikes up to several seconds, and its client does not itself respect context cancellation when making its outbound HTTP call (it only uses `ctx` for logging/tracing, not for the request's `Timeout`/cancellation).

## Deliverable

Provide:

1. A precise diagnosis of why goroutines and memory accumulate over time, tracing the exact lifecycle of a goroutine spawned in `AggregateBestQuote` in the case where `ctx.Done()` fires before all providers have responded.
2. An explanation of why this problem is intermittent and correlated with upstream latency/timeouts rather than occurring on every request.
3. A concrete, production-ready fix (you may show a revised version of the function or describe the change precisely enough to implement). If multiple viable fixes exist, name them and recommend one, discussing the trade-offs (e.g., buffered channels sized to the fan-out, a `select` on `ctx.Done()` inside each goroutine's send, use of `sync.WaitGroup` plus a done channel, or restructuring to bound concurrent work). Address what happens to the slow provider's in-flight goroutine and any resources it holds under your proposed fix, given that its client does not honor context cancellation on the outbound call itself.
