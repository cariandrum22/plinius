## Intent

Probes reliability-engineering judgment: defining user-centric SLIs/SLOs, using error budgets to drive alerting and feature/reliability trade-offs, and avoiding common SLI pitfalls.

## Assumptions

Assume services of differing criticality, a desire to reduce alert noise, and reliability run by measurement rather than heroics. No mandated tool.

## Reviewer notes

A strong answer grounds SLIs in user-visible behavior, argues why 100% is wrong, ties the error budget to concrete alerting (burn-rate) and to the feature-vs-reliability decision, differentiates by criticality, and names SLI pitfalls (averages, wrong vantage point). A weak answer conflates the terms, sets arbitrary uptime numbers, alerts on component CPU instead of user impact, or ignores error-budget policy.
