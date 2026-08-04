# Context

A payments API charges customer cards. Clients (mobile apps on flaky networks,
and internal services) retry requests when they don't get a response -- but a
timeout does not tell the client whether the charge actually happened. Without
protection, retries double-charge customers. The team wants an idempotency
mechanism so that a retried request has the same effect as a single request, even
across process restarts and concurrent duplicate submissions.

# Your task

1. Design an idempotency mechanism for the charge endpoint. Explain how a client
   identifies a logical operation and how the server recognizes a retry.
2. Handle the hard cases: two duplicate requests arriving **concurrently**; a
   retry arriving **after** the original succeeded but before the client saw the
   response; a retry with the *same* idempotency key but a *different* request
   body.
3. Explain how the stored idempotency record interacts with the actual charge so
   that the charge and the record cannot diverge (e.g. record says success but no
   charge, or vice versa).
4. Address retention: how long do you keep idempotency keys, and what happens
   after expiry?
5. State the trade-offs and one alternative you considered.

There is more than one workable design; the reasoning is judged.
