## Intent
Probes design of coherent SSO session and logout semantics, including front-channel versus back-channel logout trade-offs and the realistic limits of single logout.

## Assumptions
One OIDC provider fronting several relying parties of different types (server-rendered, SPA, native). OIDC session-management and logout specifications apply.

## Reviewer notes
A strong answer distinguishes provider and relying-party sessions, explains how single logout propagates and where it cannot be guaranteed, compares front-channel and back-channel mechanisms honestly, ties short-lived tokens/refresh to effective logout, and provides a central revocation path. A weak answer promises perfect single logout, ignores the back/forward-cache session-restore issue, or omits the difference between clearing a local cookie and ending the provider session.
