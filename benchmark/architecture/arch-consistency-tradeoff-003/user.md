# Context

**Rowline** sells reserved seats for events (concerts, trains, theaters). At sale
time, many buyers compete for the same limited, uniquely-numbered seats. The two
hard requirements are (a) **no seat is ever sold to two buyers**, and (b) the
system should remain **usable during infrastructure faults** -- a partial outage
should not take the whole product down. These two goals pull against each other.
Popular on-sales create intense contention on a small set of seats for a few
minutes, then quiet down.

# Your task

1. Analyze the tension between preventing double-booking and staying available.
   Be precise about where strong consistency is actually required and where it is
   not -- the whole system does not need one uniform consistency level.
2. Propose a design that guarantees no double-sell for confirmed bookings while
   maximizing availability everywhere that correctness permits. Explain the
   consistency model on the critical path.
3. Explain behavior under a network partition or datastore fault: what does the
   system do for the seat-selection path specifically, and what does it do for
   browsing/holding? What does the buyer experience?
4. Address holds/timeouts, retries and duplicate requests, and the reconciliation
   of abandoned holds.
5. State the trade-offs your design makes and one alternative you rejected.

More than one design is defensible; correctness of the reasoning is central.
