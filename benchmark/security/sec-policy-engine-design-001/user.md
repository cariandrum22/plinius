A company running dozens of microservices has authorization logic duplicated and drifting across services, leading to inconsistent enforcement and audit gaps. You are asked to design a centralized authorization architecture that these services will adopt incrementally.

Context:
- Services are written in several languages; latency budgets are tight (single-digit milliseconds for common checks).
- Policies must express roles, resource ownership, relationships (sharing, group membership), and some contextual conditions.
- Requirements include: consistent decisions across services, the ability to answer "why was this allowed/denied", changes reviewable like code, and no single point of failure that takes down all traffic.
- A regulated business unit needs strong auditability and change control.

Design the authorization architecture. Address: where policy decisions are made and enforced (decision vs enforcement separation), how policy and the data needed to evaluate it are distributed to be both consistent and fast, how you avoid a hard availability dependency, how policies are authored/reviewed/versioned, and how decisions are logged for audit and debugging. Discuss the central tension between freshness/consistency of authorization data and latency/availability, and justify where you land. Name concrete failure modes (stale permissions, fail-open vs fail-closed under partition) and how you handle them.
