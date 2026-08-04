A mobile app team is integrating with a first-party OAuth 2.0 authorization server. They send you the parameters their app uses to start and complete login and ask if it is secure. The app is a native mobile client with no way to keep a client secret confidential.

Authorization request (as the app builds it):
```
GET /authorize?
  response_type=code&
  client_id=mobile-app&
  redirect_uri=myapp://callback&
  scope=profile%20orders%20admin&
  state=xyz
```

Token request (after receiving the code):
```
POST /token
  grant_type=authorization_code&
  code=<code>&
  redirect_uri=myapp://callback&
  client_id=mobile-app&
  client_secret=SHIPPED_IN_THE_APK
```

Review this flow for a native public client. Identify what is missing, misused, or risky, citing the relevant specifications, and explain the concrete attack each issue enables. Then specify the correct parameters and handling for this flow, including how the client should prove it initiated the request and how the redirect should be secured on the platform. Address the scope request as part of your review.
