## Intent

Probes cost-aware architecture: identifying dominant cost drivers and reducing them via elasticity, storage tiering, and egress reduction while respecting the reliability/latency cost of each move.

## Assumptions

Assume peak-provisioned variable compute, egress-heavy media serving, and a hot tier of cold data. No mandated vendor or pricing.

## Reviewer notes

A strong answer prioritizes by leverage, matches each change to a driver, and is explicit that aggressive cost cuts trade against latency, complexity, and spike-resilience -- sequencing low-risk high-return moves first. A weak answer lists generic 'use spot instances' tips with no driver linkage, ignores the trade-offs, or risks under-provisioning without acknowledging it.
