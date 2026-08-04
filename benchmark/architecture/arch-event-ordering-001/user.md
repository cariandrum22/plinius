# Context

**Payflow** processes account events through an asynchronous pipeline: money
in/out, holds, releases, and reversals all flow as events into downstream
consumers that maintain each account's running balance and ledger. Correctness
requires that, *per account*, events are applied in the right order -- applying a
reversal before the original debit, or a withdrawal before the deposit that funds
it, corrupts the balance. The system is high-throughput and must scale
horizontally across many consumer instances, so a single global ordered stream is
not viable.

# Your task

1. Design how the pipeline preserves the ordering that correctness actually
   requires. Be explicit about the *scope* of ordering you guarantee (global?
   per-account? per-entity?) and why that scope is sufficient.
2. Explain how partitioning/keying enables horizontal scale while preserving the
   needed order, and what happens to ordering when you add or remove consumers
   (rebalancing).
3. Address out-of-order arrival, duplicates, and redeliveries: how do consumers
   stay correct if the transport can deliver at-least-once and occasionally out
   of order?
4. Explain how you detect and handle a genuinely late or missing event, and how
   downstream state recovers.
5. Give the trade-offs (throughput vs strictness of ordering, partition-key skew)
   and one rejected alternative.

There is more than one valid design; the reasoning is judged.
