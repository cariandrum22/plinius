# Context

**Groundwork** operates a platform of user-facing and internal services and wants
to run reliability with **SLOs, SLIs, and error budgets** instead of vague "keep
it up" goals and heroic firefighting. Different services matter differently: the
checkout path is critical, an internal analytics exporter is not. Leadership
wants reliability targets that are meaningful to users, drive engineering
decisions, and don't drown on-call in meaningless alerts.

# Your task

1. Explain the relationship between SLIs, SLOs, and error budgets, and why they
   are chosen from the *user's* perspective rather than from internal component
   health.
2. For a critical request path, propose concrete SLIs (what to measure, how) and
   the shape of good SLOs. Explain how you'd pick a target and why 100% is the
   wrong target.
3. Explain how the **error budget** drives decisions: alerting policy (e.g.
   burn-rate alerts vs threshold alerts), and the trade-off between shipping
   features and spending reliability budget.
4. Address differentiation across services of different criticality, and the
   pitfalls of badly-chosen SLIs (e.g. averages hiding tail pain, measuring
   server-side when users experience client-side).
5. State the trade-offs and one alternative you considered.

There is more than one valid framework; the reasoning is judged.
