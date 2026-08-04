## Intent
Probes design of zero-downtime secret rotation with cached consumers, including dual-secret overlap windows, signing-key rollover against outstanding tokens, and emergency rotation.

## Assumptions
Consumers cache secrets and cannot be redeployed in lockstep; some credentials are shared, and a signing key has outstanding valid tokens. A secret manager exists. Multiple rotation designs are defensible.

## Reviewer notes
A strong answer uses overlapping validity / dual-secret windows so old and new secrets both work during transition, handles the signing key by verifying against current and previous keys while tokens age out, distinguishes shared from per-service rotation, and covers propagation and emergency rotation. A weak answer proposes a flag-day cutover, ignores cached consumers or outstanding tokens, or has no emergency path.
