## Intent

Probes safety-invariant reasoning for a controller interlock, plus liveness-under-fairness analysis and disciplined handling of an under-specified transition table.

## Assumptions

Assume inputs arrive from a physical environment (sensors/buttons), the transition table is as given and otherwise the state is unchanged, and the reviewer cares about the never-move-with-open-doors interlock above all.

## Reviewer notes

A strong answer states the door/motion interlock as a precise invariant and checks it is preserved on every path into the motion state, gives a concrete liveness-failure scenario with the fairness assumption that rules it out, and resolves an under-specified transition without breaking the interlock. A weak answer conflates safety with liveness, misses a path that could violate the interlock, or claims liveness with no fairness assumption.
