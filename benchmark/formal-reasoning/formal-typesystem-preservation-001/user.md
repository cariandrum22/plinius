# Review a Preservation Argument for a Small Expression Language

A tiny expression language has booleans and naturals:

```
Terms  t ::= true | false | if t then t else t | 0 | succ t | pred t | iszero t
Values v ::= true | false | 0 | succ v
Types  T ::= Bool | Nat

Typing (selected):
  ---------------- (T-True/False)      --------- (T-Zero)
  |- true : Bool                        |- 0 : Nat

  |- t : Nat                            |- t : Nat
  ------------- (T-Succ)                ------------- (T-Pred)
  |- succ t : Nat                       |- pred t : Nat

  |- t1 : Bool   |- t2 : T   |- t3 : T
  ------------------------------------ (T-If)
  |- if t1 then t2 else t3 : T

Small-step rules include:  pred 0 -> 0 ;  pred (succ v) -> v ;
  iszero 0 -> true ;  iszero (succ v) -> false ;  plus congruence rules.
```

A colleague submits this proof sketch of **preservation** ("if `|- t : T` and
`t -> t'` then `|- t' : T`"):

> "By induction on the typing derivation. Most cases are immediate. For T-If,
> whichever branch we step into has type T by assumption, so we are done. For
> T-Succ and T-Pred the subterm keeps its type Nat, so the whole term keeps type
> Nat. Hence preservation holds."

Your task is to review this argument.

Please produce:

1. An assessment of whether the induction is set up correctly: is induction on
   the typing derivation (vs. on the evaluation step) appropriate here, and does
   the sketch actually use the right inductive hypothesis? Note any case the
   sketch **skips or hand-waves**.

2. A careful check of the **`pred (succ v) -> v`** and `iszero` reductions: does
   the result term have the claimed type given the typing rules? Identify what
   auxiliary fact (e.g. a canonical-forms or inversion lemma) the argument needs
   but does not state, and where exactly it is used.

3. A verdict: is preservation actually **true** for this language, and is the
   sketch a **valid proof** of it? These can differ -- a true theorem can have a
   bogus proof. If the sketch is incomplete or wrong, say precisely what is
   missing; if it is essentially right, say what must be added to make it
   rigorous.

State your assumptions.
