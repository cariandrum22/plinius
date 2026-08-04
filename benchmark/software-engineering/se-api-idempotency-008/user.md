## Context

You work on the payments platform for an online marketplace. Sellers' storefronts call your API to charge a buyer's saved payment method when an order is placed. The relevant endpoint is:

```
POST /v1/charges
```

A trimmed version of the current Go handler looks like this:

```go
package payments

import (
	"encoding/json"
	"net/http"
	"time"
)

type CreateChargeRequest struct {
	AccountID string `json:"account_id"`
	OrderID   string `json:"order_id"`
	Amount    int64  `json:"amount"`   // minor units
	Currency  string `json:"currency"`
	Source    string `json:"source"`   // saved payment method token
}

type Charge struct {
	ID        string    `json:"id"`
	AccountID string    `json:"account_id"`
	OrderID   string    `json:"order_id"`
	Amount    int64     `json:"amount"`
	Currency  string    `json:"currency"`
	Status    string    `json:"status"` // "succeeded" | "failed"
	CreatedAt time.Time `json:"created_at"`
}

func (s *Server) CreateCharge(w http.ResponseWriter, r *http.Request) {
	var req CreateChargeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Calls out to a third-party card network. Typical latency is
	// 300ms-1.5s, p99 up to 6s under network congestion. This call
	// itself is NOT idempotent: calling it twice with the same
	// parameters creates two separate charges against the buyer's card.
	charge, err := s.processor.Charge(r.Context(), req)
	if err != nil {
		http.Error(w, "charge failed", http.StatusInternalServerError)
		return
	}

	if err := s.store.Save(r.Context(), charge); err != nil {
		http.Error(w, "failed to persist charge", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusCreated, charge)
}
```

`s.processor.Charge` is a client for an external card network and is the only thing in this path that actually moves money; it is not idempotent on its own, and it does not expose any deduplication mechanism of its own that this team controls. `s.store` is a database shared by multiple stateless instances of this service running behind a load balancer.

Seller storefronts run on flaky mobile networks and are built to be resilient to failures, which in practice means: on any timeout, connection reset, or 5xx response from `POST /v1/charges`, the storefront's HTTP client automatically retries the exact same request up to 3 times with a short backoff. Support has confirmed multiple cases of buyers being charged more than once for a single order after a slow or dropped response, even though the underlying order was only placed once. The API already accepts an `Idempotency-Key` request header from callers, but the header is currently read and ignored — it has no effect on server behavior.

## Deliverable

Design the idempotency contract and server-side handling for this endpoint, covering:

1. **Key scope and semantics** — what an `Idempotency-Key` means for this endpoint (its scope, who chooses it, how long it is meaningful for), and how you distinguish a legitimate retry of the same logical request from two different requests that happen to reuse the same key.
2. **Concurrent duplicate handling** — what happens when two requests carrying the same key arrive at (approximately) the same time, possibly at two different service instances, before either has finished processing.
3. **Response replay** — how a retried request gets a response, and what guarantee you are making about that response relative to the original.
4. **Storage and expiry** — what you store about a given key, where, and for how long, and why.
5. **Interaction with the non-idempotent downstream call** — specifically address the ordering and failure-mode implications of calling `s.processor.Charge` (which is not idempotent and cannot be made so by this team) relative to recording the idempotency key, including what happens if the service crashes or a request times out partway through.

You are not required to produce a complete, compilable implementation. Go pseudocode or a structured design description (with representative code fragments where they clarify a specific mechanism, such as the storage schema or the critical section around the processor call) is expected. Where more than one reasonable design exists, name the alternatives and justify your recommendation, including what you are trading off (latency, storage cost, operational complexity, or risk of a duplicate charge versus risk of an order that appears to fail when it actually succeeded).
