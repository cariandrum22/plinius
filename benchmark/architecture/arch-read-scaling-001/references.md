## Intent

Probes read-path scaling under a high read-to-write ratio, including the classic fan-out-on-write vs fan-out-on-read tension and cache freshness.

## Assumptions

Assume large scale, a heavy skew from celebrity accounts, and tolerance for some staleness. No specific datastore is mandated.

## Reviewer notes

A strong answer picks a materialization strategy deliberately, handles the celebrity fan-out as a special case (hybrid push/pull), reasons about write amplification and storage, and defines acceptable staleness with an invalidation story. A weak answer caches vaguely, ignores the high-follower skew, or claims a single approach with no trade-off discussion.
