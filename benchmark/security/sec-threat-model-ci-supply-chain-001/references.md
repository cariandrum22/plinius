## Intent
Probes expert supply-chain threat modeling across a CI/CD pipeline: dependency risks, poisoned builds, PR-triggered execution, signing-key theft, and artifact provenance, informed by frameworks like SLSA.

## Assumptions
A modern CI/CD pipeline with PR-triggered builds, mixed public/internal registries, signing keys in-pipeline, and customer-consumed artifacts; frameworks like SLSA are available as references. Several control roadmaps are defensible.

## Reviewer notes
A strong answer models the full source-to-customer chain, covers dependency confusion/typosquatting, untrusted PR execution, build tampering, signing-key and secret exposure, and artifact provenance/verification, and prioritizes must-haves while naming residual trust. A weak answer reduces supply chain to 'scan dependencies', ignores PR-triggered execution or key exposure, or omits provenance and verification.
