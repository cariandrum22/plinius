# Specify a Token-Bucket Rate Limiter Precisely

A service wants a token-bucket rate limiter with this informal description:

```
A bucket holds up to CAPACITY tokens and starts full. Tokens are added at a
constant REFILL rate (tokens per second), never exceeding CAPACITY. Each
admitted request removes exactly one token. A request that arrives when the
bucket has at least one token is ADMITTED (and consumes a token); otherwise it
is REJECTED and consumes nothing.
```

Two teams are arguing about what behaviour is actually guaranteed. Write a
precise specification that resolves the ambiguity.

Please produce:

1. A precise model of the **state** (what quantities define the bucket at a
   moment in time) and how each of the two events -- a refill tick and a request
   arrival -- updates it. Make the CAPACITY cap and the "consume nothing on
   reject" rule explicit.

2. A precise **safety property** bounding how many requests can be admitted in
   any time window of length T. State it as an inequality with the constants,
   and justify why it follows from your model.

3. A discussion of at least two **under-specified points** in the informal
   description that materially change behaviour, and a defensible choice for
   each -- for example: is refill continuous or in discrete ticks; if two
   requests arrive "simultaneously" with one token left, which is admitted; may
   the token count be fractional.

Your specification should be precise enough to adjudicate conformance disputes.
State your assumptions.
