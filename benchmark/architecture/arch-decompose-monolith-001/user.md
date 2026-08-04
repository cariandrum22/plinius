# Context

**Meridian Retail** runs a single Rails monolith that handles the full order
lifecycle for a mid-size e-commerce business: catalog browsing, cart, checkout,
payment capture, inventory decrement, order fulfillment, returns, and customer
notifications. The codebase is ~400k lines, shares one PostgreSQL database, and
is maintained by four teams who increasingly step on each other's deploys.
Release cadence has slowed from daily to roughly weekly because any change
requires coordinating all four teams.

Leadership wants to move toward independently deployable services so teams can
ship on their own cadence. They are explicitly *not* asking for a rewrite --
customers must see no disruption, and the business cannot pause feature work.

# Your task

1. Propose a set of service boundaries for this domain and justify *why* you
   drew the lines where you did. Explain the principle you used to decide what
   belongs together and what should be split.
2. Identify which parts should be carved out *first* and which should stay in
   the monolith longest, with reasoning.
3. Address the shared database: how do services own their data over time, and
   how do you handle the joins and transactions that currently span what will
   become service boundaries?
4. Describe how you keep the system correct and deployable *during* the
   migration, not just at the end state.
5. Name the risks of your approach and at least one alternative decomposition
   you considered and rejected.

There is no single correct set of boundaries; defend your choices.
