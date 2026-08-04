## Intent
Probes deep SSRF understanding: why naive host blocklists fail against alternate encodings, DNS rebinding, and redirects, and how to combine resolution-time validation with network egress controls.

## Assumptions
A URL fetcher running in a cloud VPC with a reachable metadata endpoint and internal services; the reviewer understands DNS resolution timing and redirect handling. Both application- and network-layer controls are available.

## Reviewer notes
A strong answer explains why a static hostname blocklist and parse-time checks fail (encodings, DNS rebinding, redirects, IPv6/decimal forms, the metadata address), validates the resolved IP against private/link-local ranges at connection time, controls redirects, and layers network egress restrictions as defense in depth. A weak answer just extends the blocklist, checks the hostname before resolution, or ignores redirects and the metadata endpoint.
