# Task

Your team owns the `charge-service`, which creates payment charges on behalf of a mobile checkout app. The mobile client retries charge requests aggressively on any network error or timeout, so the service has always relied on client-supplied idempotency keys to avoid creating duplicate charges. That logic currently lives ad hoc inside the charge-creation code path and is being pulled out into a dedicated idempotency-key store as part of a larger reliability project. You have been asked to write the Architecture Decision Record (ADR) that will be reviewed by the platform architecture group before implementation starts.

## System context

- `charge-service` exposes `POST /v1/charges`. Every request carries a client-generated `Idempotency-Key` header, scoped per-merchant (i.e., uniqueness is `(merchant_id, idempotency_key)`, not global).
- The service must guarantee that two concurrent requests with the same `(merchant_id, idempotency_key)` result in exactly one charge being created; the second (and any subsequent) request must return the same result as the first, not create a second charge or error out.
- Idempotency records must be retrievable for at least 90 days after creation, because the disputes/chargebacks team uses them during manual investigation, and this is a contractual requirement with the acquiring bank, not a soft preference.
- Charge creation, when it happens, must be recorded atomically with the idempotency claim: it must never be possible for a charge to exist without a corresponding idempotency record, or vice versa in a way that causes a duplicate charge.
- Current infrastructure:
  - A single-writer Postgres cluster in `us-east-1`, already the system of record for the `orders` and `charges` tables. It is at roughly 55% CPU utilization at peak traffic today.
  - A Redis cluster used elsewhere in the platform strictly as an ephemeral session/rate-limit cache: no persistence is enabled (no RDB snapshots, no AOF), no cross-AZ replication, and entries are evicted under memory pressure with an LRU policy. The team that owns this Redis cluster has said enabling persistence and replication is possible but would require a separate change-managed project with its own timeline.
- Traffic: sustained ~400 requests/second, with spikes to ~2500 requests/second during flash sales (roughly 4x/year, each lasting 1-3 hours).
- Latency budget: the `POST /v1/charges` endpoint has a p99 latency budget of 120ms end-to-end. Whatever mechanism is used to check/claim the idempotency key is expected to fit within a 20ms slice of that budget at p99.
- Team: 4 backend engineers who collectively have deep, multi-year operational experience running the Postgres cluster (schema migrations, index tuning, replication failover), but comparatively little production experience operating Redis for anything beyond simple caching (no one on the team has run Redis persistence or Redis Cluster failover in production). The team has 2 sprints (4 weeks) before this must ship behind a feature flag.
- Cost: no hard budget constraint was given, but any proposal that requires provisioning a new managed data store from scratch will need a separate procurement/security-review cycle that takes a minimum of 3 weeks and is not guaranteed to land within the 2-sprint window.

## Options already scoped by the team

**Option A — Postgres-backed idempotency table.**
A new `idempotency_keys` table in the existing Postgres cluster:

```sql
create table idempotency_keys (
  merchant_id     bigint not null,
  idempotency_key text   not null,
  request_hash    bytea  not null,
  status          text   not null check (status in ('in_progress', 'completed', 'failed')),
  charge_id       bigint references charges(id),
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (merchant_id, idempotency_key)
);
```
The charge-creation code would insert a row with `status = 'in_progress'` in the same transaction that later inserts the `charges` row and updates `status = 'completed'`, using `INSERT ... ON CONFLICT DO NOTHING` to detect a concurrent duplicate and then polling/blocking briefly on the existing row until it reaches a terminal status.

**Option B — Redis-backed claim with a durable follow-up write.**
The request path would first attempt `SET idem:{merchant_id}:{key} <request_hash> NX PX 90000` (a 90-second claim TTL) against the existing Redis cluster to cheaply detect in-flight duplicates, then perform the actual charge creation and idempotency bookkeeping against Postgres as the durable record once the charge completes. Redis here acts purely as a short-lived, low-latency "is this already being processed right now" lock, not as the 90-day durable store.

The team has not yet decided between treating this as a strict either/or, or documenting why one alone is insufficient. Both options above are real candidates that have been discussed in past design conversations; a third possibility (some kind of hybrid, or an entirely different mechanism) is also open for you to consider if the constraints above lead you there.

## Deliverable

Write the ADR as a single Markdown document. Structure it with the sections your organization conventionally expects in an ADR: a title, status, context, the options considered (with their concrete trade-offs given the constraints above — durability, latency, consistency guarantees, operational risk, and delivery timeline), the decision, and the consequences (both positive and negative, including anything the team is explicitly accepting as a risk or deferring to a future ADR). Ground every trade-off claim in the specific numbers and constraints given above rather than generic statements about Postgres or Redis in the abstract.
