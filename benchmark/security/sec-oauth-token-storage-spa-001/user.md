A single-page application (React, served from `app.example.com`) authenticates users via an OAuth 2.0 / OIDC provider and calls a first-party API at `api.example.com` plus a few third-party APIs. The team currently stores the access token and refresh token in `localStorage` and attaches the access token as a bearer header from JavaScript. They ask you to review and redesign token handling.

Additional context:
- The SPA loads a handful of third-party scripts (analytics, a support widget).
- The team wants "seamless" sessions that survive page reloads and don't prompt the user often.
- They are open to adding a lightweight backend if it is justified.

Review the current approach and design a secure token-handling architecture for this SPA. Explain the threat that makes browser-accessible token storage dangerous, and compare the realistic architectural options (for example a backend-for-frontend that keeps tokens server-side versus in-memory tokens with a hardened refresh strategy). Recommend one, justify it, and specify how tokens are stored, transmitted, refreshed, and revoked, and how the design contains the impact of a script compromise. Make the trade-offs (complexity, session longevity, third-party scripts) explicit.
