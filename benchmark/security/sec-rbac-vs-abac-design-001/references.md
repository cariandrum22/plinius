## Intent
Probes the ability to choose an access-control model against real requirements (roles, per-resource sharing, contextual rules, auditability) and design enforcement, rather than reflexively picking RBAC.

## Assumptions
A multi-tenant B2B system where requirements genuinely span role-based, relationship-based, and attribute-based needs; there is no single correct model, only better-justified trade-offs.

## Reviewer notes
A strong answer maps each requirement to what a model can and cannot express, recognizes that per-document sharing and cross-tenant guests strain pure RBAC, separates the decision point from enforcement, and addresses the audit/explainability requirement directly. A weak answer picks one model dogmatically, ignores cross-tenant sharing, or conflates policy definition with enforcement.
