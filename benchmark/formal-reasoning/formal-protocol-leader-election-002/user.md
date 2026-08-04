# Analyze Safety of a Quorum-Based Leader Election

Consider a simplified quorum-based leader election across `N` nodes (as in the
election phase of protocols like Raft):

```
- Time is divided into monotonically increasing 'terms'.
- A candidate for term t requests votes from all nodes.
- Each node grants at most ONE vote per term, to the first valid requester it
  sees for that term, and durably records the term it last voted in.
- A candidate that collects votes from a MAJORITY (> N/2) of nodes for term t
  becomes leader for term t.
```

Your task is to reason about the core safety property: at most one leader per
term.

Please produce:

1. A precise statement of the **safety property** "at most one leader per term",
   and the key structural fact that makes it hold. Identify the invariant on
   per-node voting that the argument relies on.

2. A rigorous argument using a **quorum-intersection** style of reasoning: show
   that two distinct leaders in the same term would each need a majority, derive
   that their vote sets must share at least one node, and reach a contradiction
   with the one-vote-per-term rule. Make explicit where the "> N/2" bound is
   essential and what fails if a mere plurality were allowed.

3. An analysis of a subtle failure case: reason about **network partitions** and
   whether two leaders could exist in *different* terms simultaneously (an old
   leader unaware it has been superseded). Explain why this does not violate the
   per-term safety property, and what an *additional* mechanism (beyond
   election) must do so that stale leaders cannot cause incorrect committed
   decisions.

State your assumptions about failures, durability, and message delivery.
