## Intent
Probes secure session management: cookie attributes, session fixation, renewal, timeout policy, and server-side revocation for a first-party web app.

## Assumptions
Server-side sessions with opaque identifiers; a shared parent domain with a more sensitive subdomain; a browser client. Current best practice for cookie security applies.

## Reviewer notes
A strong answer catches session fixation (identifier not rotated at login) and server-side-only logout as first-order problems, reasons about cookie scope across the shared parent domain and the admin subdomain, and gives a coherent timeout and revocation model with named attributes. A weak answer only lists cookie flags, ignores fixation and revocation, or over-scopes the cookie to the parent domain without noticing the admin exposure.
