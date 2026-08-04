A company stores service credentials (database passwords, third-party API keys, and an internal signing key) in a secret manager, but nothing is rotated on a schedule and rotation has caused outages before, so it is avoided. Leadership now wants regular rotation without downtime. You are asked to design the strategy.

Context:
- Dozens of services read secrets at startup and cache them in memory for the process lifetime.
- Some credentials are used by many services simultaneously (a shared database user); others are per-service.
- The signing key verifies tokens that remain valid for a while after issuance.
- Rotation must not require simultaneous redeploys of every consumer.

Design the rotation strategy. Address: how to rotate without downtime given that consumers cache secrets and cannot all be redeployed at once (for example overlapping validity / dual-secret windows); the differences between rotating shared versus per-service credentials; how the signing key must be rotated given outstanding valid tokens (key overlap and verification against multiple keys); how consumers learn about new secret versions; rotation cadence and emergency (compromise-driven) rotation; and how to make rotation safe enough that the team stops avoiding it. Be explicit about the trade-offs and failure modes.
