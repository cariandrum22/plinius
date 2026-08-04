Your company is opening its API to third-party developers via OAuth 2.0. Today the internal API uses a single coarse token that grants full account access. You are asked to design the scope and consent model so third-party apps can request only what they need and users can understand and control access.

Context:
- Resources include profile data, a user's documents (read and write), payments/billing, and administrative settings.
- Some integrations are long-lived background services; others are interactive apps used occasionally.
- Product wants an "app permissions" screen users can review and revoke, and the security team wants to prevent over-broad or confusing consent.
- There is pressure to allow a "full access" scope "for convenience".

Design the authorization-scope taxonomy and the consent and revocation experience. Address: how to decompose access into scopes that are neither too coarse nor unusably granular; how read versus write and sensitive actions (payments, admin) are separated; how consent is presented so it is meaningful; how long-lived versus occasional access is handled (including refresh and re-consent); and how users and the platform can review and revoke grants. Take a defensible position on the requested "full access" scope. Justify choices against least privilege and relevant OAuth guidance.
