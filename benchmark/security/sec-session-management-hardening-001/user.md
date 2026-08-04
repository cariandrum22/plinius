You are reviewing the session layer of a server-rendered web application (a monolith behind a load balancer, first-party domain `app.example.com`, with an admin area at `admin.example.com`). Sessions are server-side; the browser holds only an opaque session identifier. The current cookie is issued like this:

```
Set-Cookie: SID=b7c1...; Path=/; Domain=.example.com; Max-Age=2592000
```

Team notes:
- Login, logout, and "log out everywhere" all exist, but logout only clears the cookie client-side.
- The session identifier is not changed after a successful login; the same value is used before and after authentication.
- There is a "remember me" option that extends the session to 30 days.
- Some pages are served over plain HTTP inside the corporate network "for performance".

Produce a hardening review of the session lifecycle and cookie configuration. Address issuance, binding, renewal, idle and absolute timeouts, revocation, and the cookie attributes themselves. Explain the concrete attack each recommendation prevents, and be explicit about any trade-offs (for example between "remember me" convenience and exposure). Recommend a coherent target configuration the team can implement.
