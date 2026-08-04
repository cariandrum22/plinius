# Context

A single service has become the team's biggest source of pain: a 6,000-line
'god' class handles request parsing, business rules, database access, and calls
to three external APIs, all interleaved. It has almost no tests because nothing
can be exercised in isolation. Every change is risky, and onboarding new
engineers takes weeks. The service is in active use and cannot be taken offline
for a rewrite.

# Your task

1. Propose a refactoring plan to make this service maintainable, working
   incrementally on a live system rather than rewriting it.
2. Explain your approach to the missing tests: how do you refactor safely when
   there is little test coverage to protect you? What do you test first?
3. Describe the structural target -- how you would separate the tangled concerns
   (I/O, business logic, external calls) so each is testable and changeable in
   isolation.
4. Give a sequencing of steps that keeps the service shippable at every point,
   and name the risk you are most worried about.

Keep it concrete and safe for a live system.
