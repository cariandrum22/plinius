---------------------------- MODULE BoundedBuffer ----------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity

ASSUME CapacityOK == Capacity \in Nat /\ Capacity > 0

VARIABLES buffer, produced, consumed

vars == << buffer, produced, consumed >>

-----------------------------------------------------------------------------
\* Type correctness of the state.
TypeOK ==
    /\ buffer \in Seq(Nat)
    /\ produced \in Nat
    /\ consumed \in Nat

\* The system starts empty, with both counters at zero.
Init ==
    /\ buffer = << >>
    /\ produced = 0
    /\ consumed = 0

\* Produce is enabled only when the buffer is not full.
Produce ==
    /\ Len(buffer) < Capacity
    /\ buffer' = Append(buffer, produced)
    /\ produced' = produced + 1
    /\ consumed' = consumed

\* Consume is enabled only when the buffer is not empty.
Consume ==
    /\ Len(buffer) > 0
    /\ buffer' = Tail(buffer)
    /\ consumed' = consumed + 1
    /\ produced' = produced

Next == Produce \/ Consume

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* Safety invariant: the buffer never exceeds capacity, and its length is
\* exactly the number of items produced but not yet consumed. This is a real
\* constraint on reachable states -- dropping the Produce guard would let
\* Len(buffer) climb past Capacity and violate the first conjunct.
BufferInvariant ==
    /\ Len(buffer) <= Capacity
    /\ Len(buffer) = produced - consumed
    /\ consumed <= produced

=============================================================================
