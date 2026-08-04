# Context

**Continental Freight** runs its business on a 15-year-old logistics platform: a
large, poorly-documented codebase with a tangled shared database, brittle nightly
batch jobs, and original authors long gone. It still works and is
business-critical -- shipments move through it every day. A full rewrite was
attempted once and failed after two years. Leadership now wants an *incremental*
modernization that delivers value continuously and can be paused or stopped
without leaving the system broken.

# Your task

1. Propose an incremental modernization strategy (a strangler-fig-style approach)
   that stands up new capabilities alongside the legacy system and gradually
   redirects functionality, rather than replacing it all at once.
2. Explain how you choose *what* to extract first. What makes a slice a good
   early candidate (value, risk, coupling, clear seams)?
3. Address the **shared database** and the routing/interception layer: how do old
   and new implementations coexist and stay consistent while a capability is
   half-migrated? How do you route traffic and keep data in sync during the
   transition?
4. Explain how you keep the business running and avoid a second failed-rewrite
   outcome -- including how the effort survives being paused mid-flight.
5. State the trade-offs and one alternative you rejected.

There is more than one valid plan; the reasoning is judged.
