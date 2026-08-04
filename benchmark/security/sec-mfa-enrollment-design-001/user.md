A consumer SaaS product with roughly 2 million accounts wants to add multi-factor authentication. Leadership wants strong protection for high-value actions without locking legitimate users out. You are asked to design the authenticator lifecycle end to end.

Constraints and context:
- Users range from non-technical consumers to security-conscious power users.
- The product already supports TOTP as an optional second factor; adoption is low.
- Support handles a high volume of "I lost my phone" tickets today, currently resolved by a support agent verifying "security questions".
- The company wants to offer phishing-resistant options and eventually make MFA mandatory for admin-like actions.

Design the MFA program covering: which authenticator types to support and their relative assurance; enrollment (including binding a new authenticator to a verified identity); step-up authentication for sensitive actions versus login; and account recovery when a user loses a factor. The recovery path is the crux: it must not silently become the weakest link. Justify assurance-level decisions against recognized guidance, and make the trade-offs between security, usability, and support cost explicit.
