## Intent

Probes designing for long-term API maintainability under uncontrollable clients: distinguishing compatible from breaking changes and choosing an evolution/versioning strategy with a responsible deprecation path.

## Assumptions

Assume a public API, many long-lived clients the team cannot force to upgrade, and continuous pressure to evolve. No mandated scheme.

## Reviewer notes

A strong answer defines compatible vs breaking changes concretely, justifies a scheme for uncontrollable clients, and gives a real deprecation/sunset process with usage-based safety checks and CI guards against accidental breaks. A weak answer just says 'use /v2' without defining compatibility, ignores how to retire versions, or has no way to catch breaking changes before release.
