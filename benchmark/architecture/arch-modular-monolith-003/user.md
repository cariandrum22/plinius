# Context

A three-engineer startup is building a B2B SaaS product with a billing feature
set: plans and pricing, subscriptions, usage metering, invoicing, and payment
provider integration. They are deploying a single application (a *modular
monolith*) -- they explicitly do not want microservices at this stage -- but they
want internal module boundaries clean enough that they *could* extract a service
later without a painful untangling.

# Your task

1. Propose a set of internal modules for the billing domain and describe what
   each owns (data and behavior).
2. Define the rules for how modules may call each other and share data. What is
   allowed to cross a module boundary, and what is not?
3. Explain how these boundaries make a *future* extraction of one module into a
   separate service cheaper, without paying the cost of distribution today.
4. Note one boundary decision you found genuinely debatable and how you resolved
   it.

Keep it concrete and pragmatic for a small team.
