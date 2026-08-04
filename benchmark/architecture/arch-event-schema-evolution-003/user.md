# Context

A company runs an event-driven platform where dozens of producer and consumer
services exchange events through a shared broker. Teams deploy independently and
frequently. Recently, a producer added a required field to an event and broke
three downstream consumers in production; another team renamed a field and caused
silent data loss. Leadership wants a durable strategy for evolving event schemas
without coordinated lockstep deploys.

# Your task

1. Propose a schema-evolution strategy that lets producers and consumers deploy
   independently. Define what changes are **backward compatible**, **forward
   compatible**, and **breaking**, with examples relevant to the incidents above.
2. Recommend how schemas are defined, validated, and governed (e.g. a registry,
   compatibility checks in CI). Explain what is enforced and when.
3. Explain how you introduce a genuinely breaking change when one is truly
   necessary, without a coordinated flag day.
4. Address old events already persisted in logs/stores under an earlier schema.
5. State the trade-offs and one alternative you considered.

Multiple valid strategies exist; the reasoning is judged.
