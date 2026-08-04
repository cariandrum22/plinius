# Reason About a Circuit-Breaker State Machine

A circuit breaker protecting a downstream service is modeled as three states
with counters:

```
States: CLOSED, OPEN, HALF_OPEN
Params: FAIL_THRESHOLD F, COOLDOWN T, TRIAL_SUCCESSES K
Sketch:
  CLOSED:    on success -> reset failure count
             on failure -> failcount++; if failcount >= F -> OPEN (start timer)
  OPEN:      reject all calls; when timer >= T -> HALF_OPEN (allow limited trials)
  HALF_OPEN: allow up to some trial calls;
             on a trial failure -> OPEN (restart timer)
             after K consecutive trial successes -> CLOSED (reset counts)
```

Your task is to reason about the guarantees and hazards of this machine.

Please produce:

1. A precise **safety-style property** the breaker is meant to provide -- e.g.
   "while OPEN, no calls reach the downstream" -- and the property that bounds
   how many failing calls hit the downstream before the breaker opens. State
   both precisely in terms of F and the counters.

2. An analysis of the **HALF_OPEN** state's hazards under concurrency: if many
   requests arrive while HALF_OPEN, how do you ensure only a bounded number of
   trials are admitted, and what invariant on the trial counter enforces that?
   Reason about the race between counting successes toward K and a concurrent
   trial failure.

3. A discussion of a **liveness/oscillation** concern: describe conditions under
   which the breaker flaps between OPEN and HALF_OPEN indefinitely, and what
   property (or parameter relationship) would you require to argue the system
   makes progress toward CLOSED when the downstream recovers.

State your assumptions about concurrency and timing.
