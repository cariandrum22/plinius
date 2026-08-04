## Intent

Probes idempotency design for at-least-once clients: giving a retried/duplicated request single-effect semantics, including concurrent duplicates and record/side-effect atomicity.

## Assumptions

Assume unreliable networks, client retries on timeout, possible concurrent duplicates, and no guarantee the client saw the first response. No mandated datastore.

## Reviewer notes

A strong answer defines an idempotency key, atomically links the stored outcome to the actual charge, and handles concurrent duplicates (locking or unique constraint), the seen/unseen-response case, and mismatched bodies under a reused key. It addresses key retention. A weak answer just 'checks if it exists' with a race window, ignores the record/charge divergence, or misses the concurrent-duplicate case.
