## Intent

Probes turning an informal concurrent primitive into a precise, non-vacuous pre/post-condition contract and articulating an atomicity guarantee -- a foundation of specifying concurrent operations.

## Assumptions

Assume a shared-memory model with a single word at `addr` and other threads that may concurrently read or CAS the same word. No specific memory-ordering model is mandated unless the answer chooses to state one.

## Reviewer notes

A strong answer specifies both the success and the failure outcomes completely, including the obligation on the returned value in each, and frames atomicity as a single-instant/linearization guarantee rather than vaguely. It is candid about the limits of the primitive with respect to a word that changes and returns to its original value. A weak answer gives a one-branch or vacuous postcondition, is silent on the returned value, or conflates atomicity with locking the whole call region.
