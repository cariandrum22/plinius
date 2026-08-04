## Intent
Probes recognition of broken object-level authorization (IDOR/BOLA) and the ability to prescribe a systematic, generalizable ownership-check design rather than endpoint-by-endpoint patches.

## Assumptions
Authentication is trusted (gateway-injected identity) but object-level authorization is missing; identifiers are guessable and appear in URLs. The reviewer treats server-side authorization as mandatory.

## Reviewer notes
A strong answer names broken object-level authorization precisely, notes that every route omits an ownership/permission check, prescribes a centralized enforcement pattern that scales across routes, and flags the implicit trust in the gateway header. A weak answer only tells the team to 'add a check' per endpoint, misses the write endpoint's additional privilege-escalation risk, or fixates on the guessable IDs as the root cause rather than the missing authorization.
