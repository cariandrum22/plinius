A platform team runs many services on Kubernetes across several clusters and wants a coherent, secure way to get secrets and cloud credentials to workloads. Today, secrets are pasted into Kubernetes `Secret` objects and referenced as environment variables, base64-encoded in manifests that sometimes land in Git.

Context:
- Workloads need database credentials, third-party API keys, and access to cloud services (object storage, queues).
- Some secrets are shared across services; some are per-service; a few are highly sensitive (a signing key).
- Requirements: least privilege per workload, minimal long-lived static secrets, no plaintext secrets in Git, auditability of secret access, and containment so a single compromised pod cannot read everything.
- An external secret manager and a cloud IAM system with workload-identity federation are available.

Design the secret-delivery and identity architecture for these workloads. Address: replacing static long-lived secrets with short-lived, dynamically issued credentials and cloud workload identity where possible; how remaining static secrets are stored, injected (environment variable versus mounted file versus fetched at runtime) and scoped per workload; how secrets stay out of Git and out of images; how access is authorized and audited per workload identity; blast-radius containment so a compromised pod is limited to its own secrets; and the residual trust in the cluster and its control plane. Justify choices and be explicit about trade-offs.
