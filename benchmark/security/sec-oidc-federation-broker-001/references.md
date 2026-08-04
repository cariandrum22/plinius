## Intent
Probes expert federation design: brokering many customer-supplied IdPs while preserving strict tenant isolation and preventing cross-tenant identity confusion.

## Assumptions
A multi-tenant broker with hundreds of self-service, customer-controlled IdPs of mixed protocol; external claims are untrusted input. Federation and OIDC specs apply; several architectures are defensible.

## Reviewer notes
A strong answer scopes trust strictly per tenant, treats external claims as untrusted and namespaces them, confronts email-reuse and account-linking as impersonation vectors, contains a rogue IdP to its own tenant, and makes the trust chain auditable. A weak answer trusts external claims globally, allows automatic linking on email, or lets one misconfigured IdP affect other tenants.
