## Intent
Probes design of an OAuth scope and consent model that balances least privilege, usability, and comprehensibility for a third-party developer platform.

## Assumptions
A platform exposing heterogeneous resources to external developers with varied access patterns; there are many defensible scope decompositions. OAuth 2.0 and its security BCP inform the design.

## Reviewer notes
A strong answer finds a granularity that is meaningful without being unusable, isolates sensitive actions (payments, admin), designs consent that users can actually reason about, handles long-lived versus occasional access and revocation, and pushes back on a blanket 'full access' scope with reasoning. A weak answer produces either one giant scope or hundreds of trivial ones, ignores consent comprehension, or accepts full-access without qualification.
