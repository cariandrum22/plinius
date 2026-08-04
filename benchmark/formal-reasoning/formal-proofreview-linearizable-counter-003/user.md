# Review a Linearizability Proof Sketch for a Concurrent Counter

A concurrent counter offers `inc()` and `read()`, implemented with an atomic
fetch-and-add and an atomic load:

```
val: shared integer, initially 0
inc():   fetch_and_add(val, 1)          # atomic
read():  return atomic_load(val)
```

A colleague claims the counter is **linearizable** (every operation appears to
take effect atomically at some instant between its call and return, consistent
with a sequential counter) and offers this sketch:

> "fetch_and_add is atomic, so each inc takes effect at one instant. read is a
> single atomic load, so it also takes effect at one instant. Since every
> operation is a single atomic instruction, we can just use the instant each
> instruction executes as its linearization point, and the resulting order is a
> valid sequential counter history. Therefore the counter is linearizable."

Your task is to review this argument rigorously.

Please produce:

1. A precise statement of what **linearizability** requires here: the existence
   of a linearization point for each operation within its call-return interval,
   such that the induced sequential history obeys the counter's sequential
   specification (a `read` returns the number of `inc`s linearized before it).
   State the sequential spec precisely.

2. An assessment of the sketch's **core claim** that "single atomic instruction
   implies linearizable with the instruction as the linearization point." Is this
   reasoning **valid** for this counter? Check that the chosen points lie within
   each operation's interval and that the induced order really satisfies the
   sequential spec. Address whether concurrent `read`s and `inc`s can produce an
   ordering the sketch's argument does not actually justify (e.g. two reads
   between the same two increments).

3. A verdict distinguishing **'the counter is linearizable'** from **'this sketch
   proves it'**. If the sketch is essentially correct, state precisely which
   facts it leaves implicit (atomicity giving a total order on memory effects;
   the linearization point lying in-interval) that a rigorous proof must invoke.
   If it is flawed, exhibit the hole. Do not rewrite the proof; assess it.

State your assumptions about the memory model.
