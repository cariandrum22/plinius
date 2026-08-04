# Context

Placing an order at **Nomad Travel** spans four independently-owned services:
Payments (charge the card), Inventory (reserve the room/seat), Loyalty (apply and
deduct points), and Notification (confirm to the customer). There is no
distributed transaction across these services. If any step fails -- payment
declined, inventory gone, loyalty balance insufficient -- the already-completed
steps must be undone so the customer is not charged for nothing or granted points
for a failed booking.

# Your task

1. Design a saga to coordinate this workflow. Choose between **orchestration**
   (a central coordinator) and **choreography** (services react to each other's
   events), and justify the choice for this scenario.
2. Define the forward steps and the **compensating actions** for each. Address
   the fact that some actions are not cleanly reversible (a charge becomes a
   refund; a sent notification cannot be unsent).
3. Handle partial failure and retries: how do you make each step idempotent, and
   how do you avoid double-charging or double-compensating when messages are
   redelivered?
4. Address a compensation that itself fails, and how the system reaches a
   consistent terminal state (or flags for human intervention).
5. State the trade-offs of orchestration vs choreography here and what your
   design gives up.

Both coordination styles can work; defend your choice.
