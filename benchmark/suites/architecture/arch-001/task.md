# Task: Consistency Model + Failure Handling ADR/RFC for an Inventory Reservation Service

You are the lead architect for **Northstar Commerce**, a mid-size retailer that
runs high-volume *flash sales* (limited-quantity drops) across three cloud
regions: `us-east`, `eu-west`, and `ap-south`. Customers in every region hit
their nearest region for low checkout latency.

During a drop, thousands of shoppers try to reserve the same scarce SKUs within
a few seconds. Today each region runs its own inventory cache and reconciles
asynchronously; the result is regular **overselling** (more confirmed orders
than physical stock), which triggers costly manual cancellations and refunds.

You must produce **one Architecture Decision Record (ADR)** with an embedded
**lightweight RFC** that decides the **consistency model and failure-handling
strategy** for a new, dedicated **Inventory Reservation Service (IRS)**. The
scope is bounded to the reservation lifecycle only — you are *not* redesigning
the catalog, pricing, payments, or fulfillment systems.

## Reservation lifecycle (given)

1. `reserve` — a shopper places a hold on `qty` units of a SKU. A hold has a
   finite TTL (e.g. 10 minutes) and does not yet charge the customer.
2. `confirm` — payment succeeded; the hold becomes a committed decrement of
   stock.
3. `release` / `cancel` — the shopper abandons checkout, or the TTL expires;
   held units return to available stock.

## Business & technical requirements (given)

- **R1 — No oversell.** The count of confirmed + active-held units for a SKU
  MUST never exceed the physical stock for that SKU. This is the primary
  correctness requirement.
- **R2 — Bounded checkout latency.** p99 latency for `reserve` SHOULD stay
  under 150 ms for a shopper hitting their local region under normal operation.
- **R3 — Graceful partition behavior.** When a region is network-partitioned
  from the others, the system MUST remain *correct* (R1 still holds); it MAY
  sacrifice availability for the affected write path if necessary, but you must
  state exactly what degrades.
- **R4 — Idempotent, retry-safe API.** Clients and gateways retry aggressively
  during drops; duplicate requests MUST NOT double-reserve or double-confirm.
- **R5 — Automatic reclaim.** Expired or abandoned holds MUST be returned to
  available stock without manual intervention.
- **R6 — Auditability.** Every state transition of a reservation SHOULD be
  traceable for post-drop reconciliation.

## What to deliver

A single self-contained Markdown document. Decompose the requirements, then
commit to design decisions. Your document MUST include the following sections
(use `##` headings; the exact section names matter):

- **Context** — the problem, forces, and constraints (summarize R1–R6 in your
  own framing; state assumptions explicitly).
- **Requirements** — an explicit decomposition of functional vs. non-functional
  requirements and how they constrain the design.
- **Decision** — name **exactly one** primary consistency model for the
  reservation write path (e.g. strong/linearizable, sequential, causal,
  read-your-writes, or eventual) and justify it against R1–R3. Include **at
  least one Mermaid component diagram** (a ```` ```mermaid ```` fenced block)
  showing the IRS components, its datastore(s), the regions, and the
  replication/coordination boundary.
- **API Contract** — define at least `reserve`, `confirm`, and
  `release`/`cancel`, including request/response shapes, the idempotency
  mechanism (e.g. idempotency key), TTL/expiry semantics, and error responses.
  Use RFC 2119 keywords for normative behavior.
- **Failure Matrix** — a **Markdown table** with one row per failure mode.
  Cover at minimum: (a) inter-region network partition, (b) loss of the
  primary/leader for a SKU's data, (c) duplicate client retry, and (d)
  reservation-expiry timeout. Columns SHOULD include the failure, its effect,
  detection, and the handling strategy.
- **Invariants** — at least **three** invariants stated with RFC 2119 normative
  language, precise enough to be mechanically checkable (e.g. an assertion over
  counters that a monitor could evaluate). The oversell-prevention invariant
  (R1) MUST be among them.
- **Trade-offs** — an explicit analysis naming what your chosen consistency
  model **sacrifices** (latency, availability, or staleness), and at least one
  rejected alternative with the reason it lost.
- **Consequences** — positive and negative outcomes, operational impact, and
  follow-up work.

## Constraints

- Choose **exactly one** primary consistency model for the reservation write
  path and justify it — do not hedge across several.
- The design MUST prevent oversell (R1) while being explicit about the
  availability trade-off under partition (R3).
- Use RFC 2119 keywords (MUST / SHOULD / MAY and negations) for all normative
  statements.
- Keep the scope bounded to the reservation lifecycle. Do not redesign
  payments, catalog, or fulfillment.
- Output **only** the Markdown document — no preamble, no closing commentary.
