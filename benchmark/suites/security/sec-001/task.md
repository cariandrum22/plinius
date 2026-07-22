# OAuth 2.0 + OpenID Connect Token/Session Lifecycle Threat Model (PKCE, Public Client)

You are a senior application-security engineer. A product team is building a
**public client** (a single-page web app with an optional native mobile
companion, i.e. no client secret can be safely embedded) that authenticates
users and calls a first-party API. They have chosen the **OAuth 2.0
authorization-code flow with PKCE** and **OpenID Connect** for authentication.

Your job is to author the authoritative **security design document** that the
implementation team will build against. It must threat-model and specify the
complete **token and session lifecycle**, detect and mitigate protocol misuse,
analyze the attack surface, and mandate secure, fail-closed defaults.

## Governing specifications

Ground every normative claim in the relevant specification and cite it inline:

- **RFC 6749** — The OAuth 2.0 Authorization Framework (roles, grants,
  authorization-code flow, refresh tokens).
- **RFC 6750** — OAuth 2.0 Bearer Token Usage (how access tokens are presented).
- **RFC 7636** — Proof Key for Code Exchange (PKCE): `code_verifier`,
  `code_challenge`, and the `code_challenge_method` (`S256` vs `plain`).
- **OpenID Connect Core** — `id_token` issuance and validation, `nonce`,
  issuer/audience checks.

Use RFC-correct terminology throughout. Distinguish the **authorization server**,
**resource server**, **client**, and **resource owner**; and distinguish
`access_token`, `refresh_token`, and `id_token` — they are not interchangeable.

## What to deliver

A single Markdown document with **exactly these five top-level sections, in this
order**:

### 1. Threat Model
Enumerate the realistic adversaries and attacks against this flow, each with a
concrete attack path and the property it violates. At minimum cover:
authorization-code injection and replay, **PKCE downgrade / removal**, CSRF via a
missing/unbound `state`, `id_token` replay via a missing `nonce`, `redirect_uri`
manipulation and open redirects, authorization-server **mix-up**, token leakage
and substitution, and **refresh-token theft**. Note how each is *detected* as
protocol misuse, not merely prevented.

### 2. Token Lifecycle
Specify issuance, presentation/use, **refresh with rotation**, revocation, and
expiry — separately for `access_token`, `refresh_token`, and `id_token`. Cover
token lifetimes, binding, refresh-token **reuse detection**, and session
termination / logout.

### 3. Attack Surface
Map the trust boundaries and surfaces: the browser/native runtime, the redirect
and callback, front-channel vs back-channel, token storage and transport, the
authorization endpoint, the token endpoint, and the resource server. State what
an attacker who reaches each surface can and cannot do.

### 4. Secure Defaults
Specify the defaults the implementation ships with. These must be secure without
further configuration: PKCE `S256` mandatory (explain why `plain` is a weaker
default), `state` and `nonce` always present and validated, exact `redirect_uri`
matching, least-privilege scopes, TLS-only bearer transport (RFC 6750), short
access-token lifetimes, and a token-storage posture that **does not** persist
tokens in browser `localStorage`. Justify the chosen storage/transport model
(e.g. `HttpOnly` + `Secure` + `SameSite` cookies, in-memory tokens, or a
backend-for-frontend).

### 5. Fail-Closed
Define behavior when validation is ambiguous or fails. Signature, issuer,
audience, and `nonce` checks; clock-skew bounds; and misuse detection must all
**deny by default** and never fall back to an insecure path. State exactly what
the client and resource server do on each failure.

## Constraints

- This is a **public client**: no client secret. Do **not** propose the implicit
  flow or `response_type=token`.
- PKCE (RFC 7636) is mandatory; treat `S256` as the default `code_challenge_method`.
- Do **not** recommend storing tokens in browser `localStorage` or
  `sessionStorage`.
- Cite at least the governing RFCs by number inline (e.g. "RFC 7636").
- Keep it implementation-grade and specific; avoid generic security platitudes.

Write the document in English.
