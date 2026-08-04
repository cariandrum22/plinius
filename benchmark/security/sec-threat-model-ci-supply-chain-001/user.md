You are asked to threat-model the software supply chain for a company that builds and ships a widely used application. The pipeline pulls source and third-party dependencies, builds artifacts, signs and publishes them, and deploys to production. Recent industry incidents have made leadership want a rigorous model.

Context:
- Builds run in a hosted CI system triggered by pull requests and tags; build jobs can run contributor-submitted code.
- Dependencies come from public package registries and a few internal registries.
- Release artifacts are signed and published to a distribution channel that customers pull from.
- Secrets (signing keys, registry credentials, deploy tokens) are available to some pipeline stages.

Produce a supply-chain threat model. Identify the assets (source integrity, build integrity, the signing keys, the published artifacts, and the customer trust in them) and the trust boundaries across the pipeline. Enumerate the realistic threats using a systematic method and, where useful, frameworks such as SLSA, covering at least: compromised or malicious dependencies (including typosquatting and dependency confusion), poisoned build environments and untrusted PR-triggered execution, tampering between build and publish, theft or misuse of signing keys and pipeline secrets, and insufficient provenance/verifiability of released artifacts. For each major threat give a concrete scenario and a proportionate mitigation, distinguish must-have controls from maturity improvements, and be explicit about where residual trust remains.
