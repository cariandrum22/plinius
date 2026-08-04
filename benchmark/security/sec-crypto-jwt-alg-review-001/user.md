A service issues and verifies JSON Web Tokens for service-to-service and session use. A developer shares the verification code and configuration and asks whether the token setup is sound.

```javascript
const jwt = require("jsonwebtoken");

// Verification middleware
function verify(token) {
  // decode header to find the algorithm, then verify with it
  const decoded = jwt.decode(token, { complete: true });
  const alg = decoded.header.alg;
  return jwt.verify(token, SECRET_OR_PUBLIC_KEY, { algorithms: [alg] });
}
```

Configuration and context:
- `SECRET_OR_PUBLIC_KEY` currently holds an RSA public key; some older internal tokens were signed with HS256 using a shared secret and are "still floating around".
- Tokens carry `sub`, `role`, and `exp`; there is no `aud` or `iss` in most tokens.
- Tokens are also accepted from partner systems in a few endpoints.

Review the JWT signing and verification design. Explain the vulnerabilities in trusting the token's own header to select the verification algorithm and in the mixed HS256/RS256 history, and the concrete attacks they enable. Then specify how JWT verification should be configured and how claims should be validated, citing the relevant JOSE/JWT specifications. Address algorithm pinning, key selection, required claims, and the multi-issuer (partner) case.
