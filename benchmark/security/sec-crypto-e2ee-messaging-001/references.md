## Intent
Probes protocol-level review of an E2EE design: required security properties (forward secrecy, authenticity), server-mediated key-distribution MITM risk, group key management, and backup trade-offs, using established primitives.

## Assumptions
A non-expert team wanting correct use of vetted building blocks, not novel cryptography; the server is untrusted for content but mediates key distribution. Standard protocols (e.g. the double-ratchet family) exist as references.

## Reviewer notes
A strong answer identifies missing forward secrecy and post-compromise security, the server-as-MITM key-substitution risk and the need for key verification, the scaling and forward-secrecy issues of encrypting to each member individually, and the tension in password-wrapped key backup, then points to established protocols by name without inventing primitives. A weak answer accepts static per-message public-key encryption as sufficient, ignores key verification, or proposes bespoke cryptography.
