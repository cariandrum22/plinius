## Intent
Probes senior-level design of a centralized authorization system under real distributed-systems constraints, especially the consistency/latency/availability trade-off and fail-open versus fail-closed behavior.

## Assumptions
A polyglot microservice estate with tight latency budgets and strong audit needs; there is genuine tension between fresh authorization data and availability, with several defensible architectures.

## Reviewer notes
A strong answer separates the policy decision point from enforcement, confronts the staleness-versus-latency trade-off directly and defends a position, specifies fail-closed behavior under partition with justification, and treats policy as reviewable, versioned artifacts with an audit trail. A weak answer proposes a single synchronous service on the request path without addressing its availability blast radius, hand-waves consistency, or ignores the fail-open/closed decision.
