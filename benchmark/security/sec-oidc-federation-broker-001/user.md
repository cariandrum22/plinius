Your platform must let enterprise customers bring their own identity provider (some OIDC, some SAML) while your applications integrate with a single internal OIDC provider. You are designing an identity broker that sits between external IdPs and your relying parties. Each customer is a tenant; users must be correctly attributed to their tenant and never able to impersonate users in another tenant.

Context:
- Hundreds of customer IdPs, onboarded self-service; configuration (issuer, keys, claim mappings) is customer-supplied.
- You must map heterogeneous external claims (email, groups, employee attributes) to internal identity and authorization data.
- Some customers reuse email addresses that also exist under other tenants; account linking is requested but risky.
- Requirements include tenant isolation, no privilege leakage across tenants, resilience to a single misconfigured or malicious customer IdP, and auditability of the trust chain.

Design the identity-broker architecture and its trust model. Address: how upstream IdP trust is established and scoped per tenant; how tokens/assertions from external IdPs are validated and their claims safely mapped and namespaced; how you prevent cross-tenant identity collisions and impersonation (including the email-reuse and account-linking hazards); how a single malicious or misconfigured IdP is contained; and how the end-to-end trust chain is audited. Cite the relevant OIDC/federation specifications and take defensible positions on the linking and collision hazards.
