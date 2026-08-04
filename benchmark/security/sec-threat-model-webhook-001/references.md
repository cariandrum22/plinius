## Intent
Probes threat modeling of a state-changing inbound webhook: authenticity, replay, tampering, idempotency, request-handling abuse, and handling senders that cannot sign.

## Assumptions
A public, state-changing webhook endpoint with heterogeneous senders (some signing-capable, some not); a systematic method applies. Event data is untrusted input that drives real actions.

## Reviewer notes
A strong answer treats inbound events as untrusted, centers authenticity and replay defenses, addresses idempotency and duplicate/out-of-order delivery, covers request-handling abuse and SSRF from embedded URLs, and takes a defensible stance on unsigned senders. A weak answer trusts the source IP or a shared URL secret alone, ignores replay/idempotency, or omits the SSRF/DoS surface.
