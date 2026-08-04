## Intent
Probes end-to-end authenticator lifecycle design, with emphasis on recovery flows that frequently undermine MFA, grounded in identity-assurance guidance.

## Assumptions
A large consumer population with mixed sophistication; a real support-cost constraint; recognized guidance such as NIST SP 800-63B on authenticator types and AAL applies. Phishing-resistant options (e.g. WebAuthn/passkeys) are available.

## Reviewer notes
A strong answer treats recovery as the central threat, avoids re-introducing knowledge-based verification as the fallback, differentiates authenticator assurance (including phishing resistance), and ties step-up to action risk. It weighs support cost honestly. A weak answer lists factor types without a recovery story, or proposes a recovery path that quietly downgrades the whole scheme.
