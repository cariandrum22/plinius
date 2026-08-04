## Intent
Probes correct OIDC id_token validation: signature verification, issuer/audience/nonce/expiry checks, and the danger of trusting an unverified JWT, especially when received via the browser.

## Assumptions
An OIDC relying party establishing sessions from id_tokens; some tokens arrive directly from the token endpoint and some via the browser. OpenID Connect Core and JOSE specs are authoritative.

## Reviewer notes
A strong answer enumerates the full validation set (signature against the provider's keys, iss, aud, exp/iat/nbf, and nonce where applicable), refutes the 'TLS means we can skip the signature' reasoning, and treats browser-delivered tokens as untrusted input. A weak answer accepts skipping signature verification, forgets audience/issuer/nonce, or treats channel security as a substitute for token validation.
