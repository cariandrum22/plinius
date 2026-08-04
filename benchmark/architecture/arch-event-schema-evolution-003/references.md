## Intent

Probes the ability to keep an event-driven system evolvable: reasoning about compatibility directions and enabling independent deploys via schema governance.

## Assumptions

Assume many independently-deployed producers/consumers, a shared broker, and persisted historical events. No mandated serialization format.

## Reviewer notes

A strong answer distinguishes backward/forward/breaking changes precisely with examples, enforces compatibility (e.g. registry + CI checks), gives a safe path for unavoidable breaking changes (parallel versions/expand-contract) and handles historical events. A weak answer relies on everyone upgrading together, conflates the compatibility directions, or ignores already-persisted events.
