A web application acts as an OpenID Connect relying party. After the authorization-code exchange, it receives an `id_token` (a signed JWT) and uses it to establish the user's session. A developer wrote the validation below and asks you to review it before it ships.

```javascript
function validateIdToken(idToken) {
  const [header, payload] = idToken.split(".").slice(0, 2)
    .map(p => JSON.parse(Buffer.from(p, "base64url").toString()));

  const claims = payload;              // trust the decoded payload
  if (claims.exp < Date.now() / 1000) {
    throw new Error("expired");
  }
  const userId = claims.sub;
  return userId;                       // establish session for this sub
}
```

The team's notes: "We already trust the provider, and we got the token over TLS directly from the token endpoint, so we don't think we need to check the signature. We use the same code path for tokens received later from the browser too."

Review this ID token validation. Explain precisely what must be validated for an OIDC `id_token` and why each check matters, citing the relevant specifications. Identify the assumptions in the team's note that are unsafe and the attacks they enable. Then specify a correct validation routine (the required checks and their order/consequences), and address the fact that the same code path is used for tokens that arrive from the browser.
