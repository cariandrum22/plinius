# Diagnose Variance Soundness for a Mutable Container

A language has subtyping (`Cat <: Animal`) and a generic container:

```
class Box<T> {
    T get();
    void set(T x);
}
```

A designer proposes the rule: "`Box<S> <: Box<T>` whenever `S <: T`" (covariant
in `T`), reasoning that "a box of cats is a box of animals". Your task is to
analyze the soundness of this rule.

Please produce:

1. A precise statement of what **soundness** means here: well-typed programs do
   not perform an operation on a value of the wrong runtime type (no
   'wrong-type' stuck state). Frame it in terms of `get` returning a `T` and
   `set` accepting a `T`.

2. A rigorous argument about whether the proposed **covariant** rule is sound.
   Consider a program that, under the rule, treats a `Box<Cat>` as a
   `Box<Animal>` and then calls `set` with a `Dog` (a subtype of `Animal`).
   Trace the types the typing rules assign and explain precisely which
   subsumption step the type checker accepts that leads to a value of the wrong
   type flowing into the box. Name the general principle at work.

3. A statement of the **sound** variance for `get`-only and for `set`-only
   variants of `Box`, and for the read-write `Box`. Explain why an immutable box
   can be covariant, a write-only sink can be contravariant, and a mutable
   read-write box must be invariant -- tying each to which operation would
   otherwise be unsound.

State your assumptions.
