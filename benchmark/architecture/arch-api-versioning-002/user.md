# Context

A company exposes a public REST API used by thousands of third-party integrators
and its own mobile apps. Old app versions stay installed for years, and partners
integrate slowly and rarely update. The team keeps needing to evolve the API --
add fields, change response shapes, rename things, tighten validation -- but every
change risks breaking clients they don't control and can't force to upgrade.

# Your task

1. Recommend an API versioning and compatibility strategy that lets the API
   evolve while old clients keep working. Define what counts as a
   backward-compatible change versus a breaking change, with concrete examples.
2. Choose a versioning scheme (e.g. URL path, header/media-type, or an
   additive/no-versioning evolution model) and justify it for a public API with
   uncontrollable, long-lived clients.
3. Explain your deprecation and sunset process: how do you retire an old version
   or field responsibly, and how do you know when it is safe?
4. Address how you prevent accidental breaking changes from shipping.
5. State the trade-offs of your scheme and one alternative you considered.

Multiple schemes are defensible; the reasoning is judged.
