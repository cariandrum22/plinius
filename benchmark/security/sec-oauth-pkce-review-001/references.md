## Intent
Probes correct OAuth 2.0 usage for a native public client: PKCE, the futility of a shipped client secret, redirect security, and least-privilege scopes, grounded in the RFCs.

## Assumptions
A native mobile client that cannot keep a secret; a first-party authorization server. RFC 6749, RFC 7636, and RFC 8252 apply as authoritative.

## Reviewer notes
A strong answer identifies the missing PKCE and the meaningless shipped client secret as central, cites the correct RFCs, secures the custom-scheme redirect appropriately, and challenges the broad scope request. A weak answer treats the shipped secret as adequate confidentiality, omits PKCE or misstates its purpose, or ignores redirect and scope concerns.
