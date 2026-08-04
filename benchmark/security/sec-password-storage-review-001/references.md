## Intent
Probes whether the model can identify unsafe password storage (fast general-purpose hashing, weak salting, missing verification hardening) and specify a correct scheme grounded in current guidance.

## Assumptions
The reviewer holds current guidance (NIST SP 800-63B, OWASP) as authoritative and treats fast hashes as unsuitable for password storage. The application is a conventional web app with a relational store.

## Reviewer notes
A strong answer separates the cryptographic defect from the policy and operational defects, justifies each recommendation against a named standard, and challenges the folklore-driven policies (short max length, composition stripping, password hint) with reasons. A weak answer fixates on one issue, recommends a fast hash with more rounds, or accepts the surrounding controls uncritically.
