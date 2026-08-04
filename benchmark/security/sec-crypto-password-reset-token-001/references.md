## Intent
Probes secure design of password-reset tokens: unpredictability, server-side single-use state, expiry, session invalidation, and avoidance of user enumeration.

## Assumptions
A conventional emailed reset-link flow; the reviewer treats reset tokens as bearer credentials that must be unpredictable, single-use, and short-lived.

## Reviewer notes
A strong answer identifies that a derivable MD5 of user id plus timestamp is predictable and that recomputing over a time window replaces real state, then prescribes a high-entropy random token stored hashed with expiry, single-use, and session invalidation, and notes enumeration in responses. A weak answer 'upgrades MD5 to SHA-256' while keeping the derivable input, or ignores single-use and session invalidation.
