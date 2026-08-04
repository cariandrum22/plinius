A B2B SaaS platform is replacing ad-hoc permission checks scattered through its codebase. Each customer is a tenant; within a tenant there are users, teams, and resources (projects, documents, and billing). Requirements gathered from product:

- Roles like "owner", "admin", "member", "billing-only", and "read-only guest" exist per tenant.
- Some documents can be shared with specific individual users, including guests from other tenants.
- Enterprise customers want to say things like "engineers can edit documents tagged `internal` but only during business hours from a managed device".
- The platform must show each user exactly what they can do, and support an audit of "who can access this document and why".

Recommend an access-control model (or combination) for this system. Compare the realistic options (for example RBAC, ABAC, relationship-based access control), and justify your recommendation against these requirements. Then sketch how enforcement should be structured: where decisions are made, how policies are represented, and how the "who can access this and why" question is answered. Be explicit about the failure modes of the model you choose and how you contain them.
