## Intent

Probes stating a representation invariant of the right strength, proving it inductive across every transition case, and connecting it to the user-visible safety property -- a core data-structure verification skill.

## Assumptions

Assume single-threaded use, N>=1, counters wide enough that overflow is out of scope unless the answer raises it, and that push/pop are the only mutators.

## Reviewer notes

A strong answer offers a representation invariant strong enough to reprove itself, proves preservation in every case including the rejected operations, and connects the invariant to the safety property, illustrating what breaks if a guard is removed. A weak answer offers an invariant too weak to be inductive, skips the rejected-call cases, or asserts safety without grounding it in the invariant.
