# Reason About an Elevator Door Controller State Machine

A single-car elevator door controller is modeled as:

```
States: CLOSED_IDLE, OPENING, OPEN, CLOSING, MOVING
Inputs:  call(floor), doors_fully_open, doors_fully_closed, obstruction, arrived
Sketch of transitions:
  CLOSED_IDLE --call at current floor--> OPENING
  CLOSED_IDLE --call at other floor-->   MOVING
  OPENING     --doors_fully_open-->      OPEN
  OPEN        --timeout-->               CLOSING
  CLOSING     --obstruction-->           OPENING
  CLOSING     --doors_fully_closed-->    CLOSED_IDLE
  MOVING      --arrived-->               OPENING
```

Your task is to reason about the safety and liveness of this controller.

Please produce:

1. A precise **safety invariant** that must never be violated -- the critical one
   being "the car is never in MOVING while the doors are not fully closed". State
   it over the states/inputs, and argue whether the given transitions can ever
   violate it (consider the CLOSING->OPENING obstruction path and how MOVING is
   entered).

2. An analysis of **liveness**: under what assumptions is a passenger's `call`
   eventually served (doors eventually OPEN at their floor)? Identify a scenario
   (e.g. a persistent obstruction, or repeated calls) under which liveness could
   fail, and state the fairness/environment assumption needed to rule it out.

3. A note on at least one **under-specified transition** you had to interpret
   (e.g. a `call` arriving during OPENING or MOVING) and a defensible choice,
   explaining how your choice affects the safety invariant.

State your assumptions.
