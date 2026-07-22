# Bounded-Buffer Safety Specification -- Reference Answer

```tla
---------------------------- MODULE BoundedBuffer ----------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity

ASSUME CapacityOK == Capacity \in Nat /\ Capacity > 0

VARIABLES buffer, produced, consumed

vars == << buffer, produced, consumed >>

TypeOK ==
    /\ buffer \in Seq(Nat)
    /\ produced \in Nat
    /\ consumed \in Nat

Init ==
    /\ buffer = << >>
    /\ produced = 0
    /\ consumed = 0

Produce ==
    /\ Len(buffer) < Capacity
    /\ buffer' = Append(buffer, produced)
    /\ produced' = produced + 1
    /\ consumed' = consumed

Consume ==
    /\ Len(buffer) > 0
    /\ buffer' = Tail(buffer)
    /\ consumed' = consumed + 1
    /\ produced' = produced

Next == Produce \/ Consume

Spec == Init /\ [][Next]_vars

BufferInvariant ==
    /\ Len(buffer) <= Capacity
    /\ Len(buffer) = produced - consumed
    /\ consumed <= produced

=============================================================================
```

File: spec.tla

## State variables

- `buffer` -- the FIFO queue, modelled as a `Seq(Nat)`. Each element is the
  index of a produced item, so the sequence also records ordering.
- `produced` -- monotone count of items ever appended.
- `consumed` -- monotone count of items ever removed from the head.
- `Capacity` -- a `CONSTANT`, fixed by `ASSUME` to a positive natural number,
  keeping the spec parametric rather than hard-coding one buffer size.

## Init

`Init` pins the unique start state: an empty `buffer` and both counters at
zero. It is the only initial state, which keeps the reachable state space fully
determined by `Next`.

## Next

`Next == Produce \/ Consume` is the disjunction of the two atomic actions.
Each action assigns a primed value to all three variables, so no variable is
ever left undefined in a step:

- `Produce` is guarded by `Len(buffer) < Capacity` (not full). It appends a new
  item and increments `produced`, leaving `consumed` unchanged.
- `Consume` is guarded by `Len(buffer) > 0` (not empty). It drops the head and
  increments `consumed`, leaving `produced` unchanged.

`Spec == Init /\ [][Next]_vars` is the standard safety-style temporal formula:
start in `Init`, and every step is a `Next` step or a stuttering step.

## Invariant

`BufferInvariant` is the safety property checked with TLC as an `INVARIANT`:

1. `Len(buffer) <= Capacity` -- the buffer never overflows its bound.
2. `Len(buffer) = produced - consumed` -- the number of in-flight items is
   exactly what has been produced but not yet consumed (a conservation law).
3. `consumed <= produced` -- nothing is consumed before it is produced.

## Explanation

The invariant is **non-vacuous**: it genuinely constrains the reachable states
and a realistic bug would falsify it. Consider a buggy `Produce` that drops the
`Len(buffer) < Capacity` guard. That variant is still type-correct and still
defines a valid `Next`, so it does not fail on syntax -- but its reachable
states include buffers of length `Capacity + 1`, `Capacity + 2`, and beyond,
directly violating conjunct (1). TLC would report a concrete counterexample
trace ending in an over-full buffer. Likewise, a `Consume` that failed to
increment `consumed` (or a `Produce` that forgot to append) would break
conjunct (2), since `Len(buffer)` would drift away from `produced - consumed`.

Because each conjunct is refutable by a plausible mutation of the spec, the
invariant is doing real work -- it is not `TRUE`, not `x = x`, and not a mere
restatement of `TypeOK` (which only fixes the *types* of the variables, saying
nothing about the capacity bound or the counter relationship). A spec whose
"invariant" were simply `TRUE` would also pass TLC, which is exactly why the
substance of this invariant -- and its fidelity to the bounded-buffer
protocol -- is what makes the specification meaningful.
