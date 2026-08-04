## Intent

Probes distributed-transaction reasoning without 2PC: modeling a saga with compensations, idempotency, and handling of non-reversible steps and failed compensations.

## Assumptions

Assume no cross-service ACID transaction, at-least-once messaging, and steps with differing reversibility. Either coordination style may be chosen.

## Reviewer notes

A strong answer justifies orchestration vs choreography for this case, defines concrete compensations, treats semantically-irreversible steps honestly (refund, not un-charge), makes steps idempotent against redelivery, and defines a terminal state when compensation fails. A weak answer assumes a distributed transaction, omits compensations for some steps, ignores double-execution under retry, or never addresses failed compensation.
