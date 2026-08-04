## Intent

Probes stating conservation and non-negativity invariants precisely and giving a clean base-case/step inductive argument that ties each guard to the property it protects.

## Assumptions

Assume single-threaded execution, unbounded (no-overflow) integer arithmetic unless the answer chooses to reason about overflow, and that `transfer` is the only mutator.

## Reviewer notes

A strong answer states conservation over the whole ledger rather than only the touched accounts, checks both the rejected-call and the self-transfer cases in the induction, and ties non-negativity to the specific guard that protects it. A weak answer scopes conservation too narrowly, omits the rejection path, or gives a total that is trivially preserved without connecting the guard to non-negativity.
