# Security Design: OAuth 2.0 + OIDC Authorization-Code + PKCE Token/Session Lifecycle (Public Client)

> Scope: a **public client** (SPA + optional native app, no client secret) using the
> OAuth 2.0 authorization-code grant (RFC 6749 §4.1) with PKCE (RFC 7636) and OpenID
> Connect Core for authentication. Bearer access tokens per RFC 6750. This document is
> the normative reference the implementation is built and reviewed against.
>
> Roles (RFC 6749 §1.1): **resource owner** (the user), **client** (our public app),
> **authorization server (AS)**, **resource server (RS)** (our API). Tokens are
> distinct artifacts: `access_token` (RS authorization, opaque or JWT), `refresh_token`
> (obtain new access tokens, AS-only), `id_token` (OIDC authentication assertion,
> client-only). They are **never** interchanged.

## Threat Model

Adversary classes: (A) network attacker (TLS-terminated, but can observe/replay
front-channel URLs, e.g. via logs, referrers, browser history); (B) malicious or
compromised web content (XSS, malicious extensions, other tabs); (C) a malicious
client/app registered with the AS; (D) a rogue or misconfigured authorization server
in a multi-AS deployment.

| # | Attack | Path | Property violated | Detection / mitigation |
|---|--------|------|-------------------|------------------------|
| T1 | **Authorization-code injection / replay** | Attacker obtains a victim's `code` (referrer leak, log, intercepted redirect) and redeems it in their own session, or injects a code into a victim session. | Authentication integrity (RFC 6749 §10.5; §4.1.3 single-use codes). | PKCE (RFC 7636): the token request must carry the `code_verifier` whose SHA-256 equals the `code_challenge` bound to the code. A stolen code without the verifier is useless; AS **rejects** on mismatch. Codes are single-use and short-lived; a second redemption triggers code-reuse revocation. |
| T2 | **PKCE downgrade / removal** | Attacker strips the `code_challenge`, or forces `code_challenge_method=plain` and then supplies a guessed/observed verifier. | Code-binding integrity (RFC 7636 §7.2, §4.4.2). | AS policy: PKCE **required** for public clients; missing `code_challenge` → reject. `plain` disabled by policy — with `plain` the challenge equals the verifier and a front-channel leak of the challenge is sufficient to redeem the code; `S256` sends only the hash. Client always sends `S256`. |
| T3 | **CSRF / code fixation via missing `state`** | Attacker initiates their own authorization, then feeds the resulting callback to the victim so the victim's client binds the attacker's identity/session. | Session integrity (RFC 6749 §10.12). | Cryptographically random, per-request `state`, bound to the user agent (e.g. in an `HttpOnly` cookie or PKCE-associated storage) and **verified on callback**; mismatch → reject. PKCE does **not** replace `state`: PKCE protects the code, `state` protects the request/session binding. |
| T4 | **`id_token` replay / injection via missing `nonce`** | Attacker replays a previously captured `id_token`, or injects one obtained elsewhere. | Authentication assertion freshness (OIDC Core §3.1.2.1, §3.1.3.7). | Client generates a per-request `nonce`, sends it in the authorization request, and verifies the `id_token.nonce` claim on return; mismatch → reject. `nonce` is distinct from `state` and both are mandatory. |
| T5 | **`redirect_uri` manipulation / open redirect** | Attacker registers or induces a `redirect_uri` that leaks the code to an attacker-controlled endpoint. | Code confidentiality (RFC 6749 §3.1.2, §10.6). | AS enforces **exact** string matching against pre-registered redirect URIs (no wildcards, no path suffixes). Client uses a single fixed callback. No open redirects on the callback host. |
| T6 | **Authorization-server mix-up** | In a multi-AS setup, attacker causes the client to send a code issued by AS-A to AS-B's token endpoint. | Issuer integrity (RFC 6749 §4; OAuth Security BCP; OIDC `iss` in response). | Client pins which AS a given `state`/request targets and validates the `iss` (authorization-response `iss` and `id_token.iss`) before redeeming; mismatch → reject. |
| T7 | **Token leakage / substitution** | Access token captured (logs, misdirected request) and presented to the RS by another party; or a token for audience X replayed to audience Y. | Confidentiality & audience binding (RFC 6750 §2.3, §5; OIDC `aud`). | Bearer tokens are transported over TLS only (RFC 6750 §5.2), never in URLs; short lifetimes; RS validates `aud`/`iss`/expiry and (for JWT) signature. Consider sender-constrained tokens (DPoP/mTLS) where feasible. `id_token` is never sent to the RS as an access token. |
| T8 | **Refresh-token theft** | A stored refresh token is exfiltrated (XSS, device compromise) and used to mint access tokens indefinitely. | Long-lived credential compromise (RFC 6749 §10.4). | For public clients, refresh tokens are **rotated** on every use (RFC 6749 §6 + rotation policy): each refresh returns a new refresh token and invalidates the prior. **Reuse detection**: presentation of an already-rotated refresh token indicates theft and revokes the entire token family (fail-closed). Tokens are not placed in `localStorage` (see Secure Defaults). |

Each row states how the misuse is **detected** (mismatch, reuse, exact-match failure)
and answered with rejection/revocation, not silent tolerance.

## Token Lifecycle

**access_token** (RFC 6750). *Issuance:* returned from the token endpoint after code
+ `code_verifier` validation. Short lifetime (5-15 min). Prefer a JWT with `iss`,
`aud`, `exp`, `scope`, or an opaque token validated by introspection. *Use:*
presented to the RS only in the `Authorization: Bearer` header over TLS (RFC 6750
§2.1); never in a query string. *Expiry:* on `exp`, the client silently obtains a new
one via refresh. *Revocation:* opaque tokens can be revoked at the AS; JWTs rely on
short TTL + optional deny-list on logout.

**refresh_token** (RFC 6749 §6). *Issuance:* only if `offline_access`/refresh scope
is granted; scoped to the client. *Use:* back-channel to the token endpoint only,
never sent to the RS. *Rotation:* every redemption issues a new refresh token and
invalidates the old (one-time use). *Reuse detection:* redeeming a superseded refresh
token → the AS revokes the whole family and forces re-authentication (theft signal).
*Expiry/revocation:* absolute max lifetime and idle timeout; revoked on logout,
password change, or admin action.

**id_token** (OIDC Core §2, §3.1.3.7). *Issuance:* returned with the token response;
a signed JWT asserting authentication. *Validation (client-only):* verify signature
against the AS JWKS, `iss` matches the expected AS, `aud` contains this client,
`exp`/`iat` within clock-skew bounds, and `nonce` matches the request. *Use:* to
establish the local user session **only**; it is not an API credential and is not
sent to the RS. *Expiry:* the local session is derived from it; renewal re-runs
validation.

**Session:** after `id_token` validation the client establishes a first-party
session (see storage posture below). Logout terminates the local session, revokes
refresh tokens, and where supported initiates OIDC RP-Initiated Logout at the AS.

## Attack Surface

- **Browser / native runtime (trust boundary: user agent).** Susceptible to XSS,
  malicious extensions, and shared-origin storage. An attacker here can read anything
  reachable from script — hence tokens must be outside script reach where possible
  (HttpOnly cookies / BFF) and never in `localStorage`.
- **Redirect / callback (front-channel).** Carries `code`, `state`. Leakable via
  referrer, history, logs. Mitigated by PKCE (code binding), exact `redirect_uri`
  matching, single-use short-lived codes, and `state` verification.
- **Front-channel vs back-channel.** The `code` traverses the front channel but is
  redeemed on the back channel with the `code_verifier`; secrets (verifier, tokens)
  stay off the front channel.
- **Token storage & transport.** The highest-value surface. Storage posture below;
  transport is TLS-only bearer (RFC 6750 §5).
- **Authorization endpoint (AS).** Enforces client/redirect registration, PKCE
  presence, and `state`/`nonce` pass-through. An attacker cannot forge codes without
  the AS.
- **Token endpoint (AS).** Validates `code` + `code_verifier`, enforces single-use
  and refresh rotation/reuse detection. Rate-limited; no client secret for public
  clients (PKCE is the substitute proof).
- **Resource server (RS).** Validates bearer tokens: signature (JWT), `iss`, `aud`,
  `exp`, scope. An attacker with a leaked short-lived access token gets a narrow,
  time-boxed window and nothing else.

## Secure Defaults

Defaults are secure with zero additional configuration:

1. **PKCE `S256` mandatory.** `code_challenge_method=S256` always; `plain` is
   disabled. Rationale: with `plain`, `code_challenge == code_verifier`, so any
   front-channel leak of the challenge lets an attacker redeem the code; `S256`
   transmits only `SHA-256(verifier)` (RFC 7636 §4.2, §7.2).
2. **`state` and `nonce` always generated, bound, and verified.** Missing or
   mismatched → reject. Neither is optional; PKCE does not replace them.
3. **Exact `redirect_uri` matching**, single fixed callback, no wildcards.
4. **Least-privilege scopes**; `offline_access`/refresh only when needed.
5. **TLS-only bearer transport** (RFC 6750 §5.2); tokens never in URLs or logs.
6. **Short access-token TTL** (5-15 min); refresh-token **rotation + reuse
   detection** on.
7. **Token storage posture (no `localStorage`).** Default: a **backend-for-frontend
   (BFF)** holds tokens server-side and issues the browser an `HttpOnly` + `Secure`
   + `SameSite=Lax/Strict` session cookie; the SPA never sees the tokens. If a pure
   SPA is unavoidable, keep the access token **in memory only** and the refresh
   token in an `HttpOnly` `Secure` cookie scoped to the token proxy. Browser
   `localStorage`/`sessionStorage` for tokens is **prohibited** — it is fully
   readable by any injected script, giving XSS a durable token-exfiltration primitive.
8. **Implicit flow / `response_type=token` disabled.** Authorization-code + PKCE only.

## Fail-Closed

Every validation denies by default; there is no insecure fallback path.

- **`id_token` validation.** Any failure of signature (against the pinned JWKS),
  `iss`, `aud`, `exp`/`iat` (within a bounded clock skew, e.g. +/-60s), or `nonce`
  → **reject the login**, discard tokens, do not establish a session. Never accept
  an unverified or `alg:none` token.
- **`state` / `nonce` mismatch or absence** → abort the callback, no session.
- **PKCE mismatch or missing verifier at the token endpoint** → AS returns
  `invalid_grant`; client treats it as a hard failure.
- **Code reuse** → AS revokes the code and any tokens minted from it.
- **Refresh-token reuse** → AS revokes the entire token family and forces
  re-authentication.
- **RS token validation** (signature/`iss`/`aud`/`exp`/scope) failure →
  `401`/`403`, no partial or cached-credential fallback. On introspection
  timeout/error for opaque tokens, **deny** rather than allow.
- **Ambiguity (e.g. mix-up, unexpected `iss`)** → refuse to redeem and restart the
  flow; do not guess the intended AS.

The controlling principle: when the protocol state cannot be positively verified,
the client and resource server both **deny access**, discard tokens, and require a
fresh, fully validated authorization.
