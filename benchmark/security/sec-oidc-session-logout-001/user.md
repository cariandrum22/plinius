An organization runs single sign-on across several relying-party applications backed by one OpenID Connect provider. Users complain that "logout doesn't really log me out": clicking logout in one app leaves them signed into others, and sometimes a back button restores a session. You are asked to design coherent session and logout behavior across the SSO estate.

Context:
- Relying parties include server-rendered apps and a couple of SPAs; there is also a native mobile app.
- Requirements: logging out should reliably end the session at the provider and across apps where expected; sessions should have sane lifetimes; and a stolen session should be revocable centrally.
- The team has heard of "front-channel" and "back-channel" logout but is unsure what applies.

Design the session and logout model. Address: the relationship between provider sessions and relying-party sessions; how single logout should propagate (and its realistic limits); the trade-offs between front-channel and back-channel logout mechanisms; how token/session lifetimes and refresh interact with logout; and how a compromised session is centrally revoked. Cite the relevant OIDC specifications. Be honest about what single logout can and cannot guarantee, and design for fail-closed behavior where propagation is uncertain.
