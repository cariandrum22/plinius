## Context

You are the API lead for a fintech platform that exposes a public REST API to third-party integrators (accounting software, budgeting apps, and internal dashboards). One of the most heavily used endpoints lists a merchant's transactions:

```
GET /v1/transactions?offset=0&limit=25&account_id=acct_9f21&sort=amount
```

The current response shape, as documented for integrators, is:

```ts
interface Transaction {
  id: string;
  account_id: string;
  amount: number;      // minor units, e.g. cents
  currency: string;     // ISO 4217
  merchant_name: string;
  status: "pending" | "settled" | "reversed";
  created_at: string;   // RFC 3339
}

interface TransactionListResponse {
  data: Transaction[];
  total: number;   // total rows matching the filter, before pagination
  offset: number;  // echoed back
  limit: number;   // echoed back
}
```

Server-side, `offset`/`limit` are passed almost directly into a SQL `OFFSET`/`LIMIT` clause against the primary transactions table, ordered by whatever column `sort` names (`amount`, `created_at`, or `id`; default `created_at`). `total` is computed with a separate `COUNT(*)` over the filtered query. Filtering is currently limited to exact-match query parameters (`account_id`, `status`, `currency`), each translated directly into a `WHERE` clause; there is no formal schema for which combinations are valid, and invalid or unknown filter parameters are silently ignored rather than rejected.

Integrators and internal teams have filed several complaints and bugs against this endpoint:

- Paginating through results (e.g., building a "load more" UI, or a nightly export job walking every page) sometimes skips transactions or shows the same transaction on two consecutive pages. This gets worse for merchants with high transaction volume, where new transactions are inserted and existing ones change `status` (e.g., `pending` -> `settled`) continuously while a client is still paging through.
- Sorting by `amount` is ambiguous when multiple transactions share the exact same amount: the relative order of tied rows is not guaranteed to be stable across requests, which compounds the skipping/duplication problem above.
- The `total` count is expensive on large accounts (some merchants have tens of millions of transactions) and integrators have asked whether it can be made optional, but no one has defined what the contract should look like if it is.
- There is no defined behavior for what happens when a client requests an `offset` beyond the end of the result set, when `limit` exceeds some maximum, when `sort` names an unsupported column, or when filter parameters are malformed (e.g., an invalid `status` value).
- The endpoint has real external integrators today who depend on the current `offset`/`limit`/`total` shape, and the API has a stated backward-compatibility policy: existing integrations must not break without a deprecation window.

Your team has decided this endpoint's pagination, filtering, and sorting contract needs to be redesigned from scratch to be correct under concurrent writes, efficient at scale, and stable for long-lived client integrations, while respecting the compatibility constraint above.

## Deliverable

Produce an API design covering:

1. **Request contract** — the query parameters (or other mechanism) for pagination, filtering, and sorting, including validation rules and defaults.
2. **Response envelope** — the full shape of a page of results, including whatever pagination metadata you choose to include (and, if you keep any form of `total`, how and when it is computed).
3. **Cursor/offset semantics** — precisely how a client moves from one page to the next, including how ties and concurrent inserts/updates/deletes are handled so that a client walking every page gets a well-defined, explainable guarantee (state exactly what guarantee you are making, e.g., about duplicates, omissions, or ordering, and why).
4. **Error cases** — the full set of client-facing error conditions this endpoint should define (malformed pagination state, invalid sort/filter values, limits exceeded, etc.), with status codes and response shapes.
5. **Compatibility and migration** — how you would introduce this contract given the existing integrators and the no-break policy: what changes, what stays, how clients discover and adopt the new contract, and over what kind of timeline.

Justify your choices, in particular:
- Why you chose the pagination mechanism you did over the alternatives, and what you are giving up by doing so (e.g., random access to an arbitrary page, exact total counts, implementation simplicity).
- What "correct" means for this endpoint under concurrent writes, and how your design achieves it.

Assume the underlying data store is a conventional relational database with standard B-tree indexing capabilities (you may assume reasonable indexes can be added), and that transaction volume for the largest merchants is high enough that full table scans or unindexed sorts are not acceptable.
