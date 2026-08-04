# Specify Idempotency for a Payment Submission API

A payments API exposes a single write endpoint:

```
POST /charges
Headers: Idempotency-Key: <client-supplied string>
Body:    { amount, currency, source }
Response: 200 { charge_id, status } | 4xx/5xx errors
```

Clients retry on network failures, so the same logical request may reach the
server more than once with the same `Idempotency-Key`. The product requirement
is: "the same key must never charge the customer twice, and retries should
return the original result." Write a precise specification of the idempotency
contract.

Please produce:

1. A precise definition of what it means for two requests to be **"the same
   logical request"** for idempotency purposes, and what the server must do when
   it receives a repeat of a key it has already seen -- including the case where
   the first request is still in flight (concurrent duplicate) and the case
   where the repeat carries a **different body** than the original.

2. A precise statement of the **at-most-once effect** guarantee (no double
   charge) as a property over the sequence/set of processed requests, and a
   statement of the **read-your-original-result** guarantee for retries. Make
   clear which of these is a safety property and which relies on liveness.

3. An analysis of the failure modes the specification must pin down: a crash
   *after* charging but *before* recording the result; expiry/GC of stored keys;
   and key reuse by the client for a genuinely new charge. For each, state what
   your specification requires.

The goal is a contract precise enough that an auditor could classify any server
behaviour as conformant or not. State your assumptions.
