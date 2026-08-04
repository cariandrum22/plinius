# Context

**Nimbus** currently runs its SaaS in a single cloud region. A regional outage
last quarter took the whole product down for six hours. Leadership wants
**active-active** across two or more regions: users served from the nearest
region, and the product surviving the loss of any one region with minimal
disruption. The application has a stateful core -- a primary relational database
of accounts, subscriptions, and user-generated content -- plus stateless services
and a cache tier.

# Your task

1. Design a multi-region topology. Explain how traffic is routed to regions and
   how the stateless tier is handled.
2. Tackle the hard part -- **data**. How is the relational data replicated or
   partitioned across regions? Analyze the trade-off between a single-writer
   (primary/replica) model and a multi-writer/active-active data model, including
   conflict handling and cross-region latency on the write path.
3. Define your targets: what are the realistic RPO and RTO of your design, and
   what does a region loss actually look like to a user mid-session?
4. Address the failover mechanics and -- critically -- the *failback* and
   split-brain risks when the lost region returns.
5. State the trade-offs and one alternative topology you rejected.

More than one topology is defensible; the reasoning is judged.
