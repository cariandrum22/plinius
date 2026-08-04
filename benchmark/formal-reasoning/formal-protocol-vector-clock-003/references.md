## Intent

Probes reasoning about the defining characterization property of vector clocks in both directions, grounded in the increment/merge rules.

## Assumptions

Assume messages carry full vectors; the happens-before relation is exactly the transitive closure of program order and send-before-corresponding-receive; each event has a distinct timestamp.

## Reviewer notes

A strong answer states the happens-before relation and the characterization precisely, argues the forward direction by induction along a causal chain using a monotonicity property, and argues the reverse and the concurrency claim rigorously, keeping the strict and non-strict orderings distinct. A weak answer proves only one direction, confuses the two orderings, or gives a rule justification that does not actually establish the biconditional.
