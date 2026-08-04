## Intent
Probes recognition of JWT algorithm-confusion and header-trust pitfalls (alg from token, HS/RS confusion, alg=none) and the ability to specify safe verification and claim validation.

## Assumptions
A service verifying JWTs from internal and partner sources with a mixed algorithm history; JOSE/JWT specs (RFC 7515/7519) are authoritative. The public key is exposed as a verification key.

## Reviewer notes
A strong answer identifies that selecting the algorithm from the token header enables RS256-to-HS256 confusion (and the alg=none family), pins algorithms server-side, ties key selection to a trusted key id/issuer rather than the token, and requires aud/iss/exp validation, handling partners as distinct trust anchors. A weak answer just says 'validate the token', misses the HS/RS confusion, or leaves algorithm selection to the header.
