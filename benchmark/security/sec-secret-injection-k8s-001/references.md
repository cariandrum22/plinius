## Intent
Probes expert design of secret delivery on Kubernetes: workload-identity federation and short-lived credentials over static secrets, per-workload scoping, injection choices, and blast-radius containment.

## Assumptions
A multi-cluster Kubernetes estate with an external secret manager and cloud workload-identity federation available; native K8s Secrets are only base64-encoded, not encrypted by trust. Several architectures are defensible.

## Reviewer notes
A strong answer shifts toward workload-identity federation and short-lived dynamic credentials, minimizes and scopes remaining static secrets per workload, keeps secrets out of Git and images, chooses injection methods with their trade-offs, authorizes and audits per workload identity, and contains blast radius while naming residual control-plane trust. A weak answer treats base64 K8s Secrets as secure, keeps long-lived static credentials broadly shared, or ignores per-pod containment and audit.
