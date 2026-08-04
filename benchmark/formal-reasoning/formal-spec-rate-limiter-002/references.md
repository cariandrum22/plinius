## Intent

Probes precise specification of a stateful throughput contract, including a quantitative safety bound over time windows and disciplined resolution of genuine ambiguities in an informal spec.

## Assumptions

Assume real-valued time, adversarial arrival timing, and that the reviewer cares about worst-case admission counts, not average behaviour. Constants CAPACITY and REFILL are positive.

## Reviewer notes

A strong answer states the window admission bound as a precise inequality in the given constants, tied to its state model, and confronts the real ambiguities (refill discretization, simultaneous arrivals) with defensible, clearly-stated choices. A weak answer gives a bound that ignores the bucket's initial contents or the capacity cap, hand-waves burst behaviour, or leaves the ambiguities unresolved.
