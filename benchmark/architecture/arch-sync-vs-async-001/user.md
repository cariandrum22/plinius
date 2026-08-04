# Context

At **Cartwright**, the checkout service must hand off completed orders to a
fulfillment service that picks, packs, and ships. Today checkout calls
fulfillment with a synchronous HTTP request inside the checkout transaction. When
fulfillment is slow or down, checkouts fail and customers cannot complete
purchases even though payment succeeded. The team is debating whether to switch
to an asynchronous, message-based handoff.

# Your task

1. Compare the synchronous request/response approach with an asynchronous
   message-based approach for this handoff. Lay out the trade-offs across
   coupling, latency, failure isolation, consistency, and operational
   complexity.
2. Recommend one approach for *this* scenario and justify it against the stated
   pain (checkout failing when fulfillment is unavailable).
3. Whatever you choose, address the consequences: if async, how does the
   customer learn the order's status and how do you handle a fulfillment failure
   *after* checkout returned success? If sync, how do you stop fulfillment
   outages from failing checkouts?
4. State clearly what your recommendation gives up.

Both approaches are defensible; the quality is in the trade-off reasoning.
