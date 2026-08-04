## Intent
Probes secure token handling for browser clients: why localStorage token storage is dangerous, the BFF pattern versus in-memory tokens, and containment of front-end compromise.

## Assumptions
A first-party SPA with third-party scripts loaded, calling first- and third-party APIs; the team will accept a backend if justified. OAuth 2.0 Security BCP applies.

## Reviewer notes
A strong answer explains that any script-readable storage collapses under XSS and that refresh tokens especially must not live there, compares BFF against in-memory approaches on their merits, recommends and specifies one concretely, and addresses revocation and blast-radius containment. A weak answer just says 'use sessionStorage instead of localStorage', omits refresh-token handling, or ignores the third-party-script exposure.
