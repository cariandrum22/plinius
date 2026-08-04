## Context

Your team runs a support-ticketing system. A nightly export job and an internal "browse tickets" API both page through the `tickets` table for a given `queue_id`, ordered by most-recently-updated first, using classic offset/limit pagination. Support agents actively work tickets (which updates `updated_at`) throughout the export window, and new tickets are created continuously as customers submit them.

Two related bug reports have come in:

- The nightly export (which walks every page until an empty page is returned) is intermittently missing tickets that definitely existed in the queue during the export window, and separately, some tickets are appearing twice in the exported file.
- Support agents browsing page 2, then page 3, of the ticket list sometimes see a ticket they already saw on page 2 show up again at the top of page 3, and occasionally a ticket disappears entirely between pages during a single browsing session.

Here is the repository function both code paths call:

```python
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Ticket


@dataclass
class Page:
    items: list[Ticket]
    has_more: bool


def list_tickets_page(
    session: Session,
    queue_id: int,
    page: int,
    page_size: int = 50,
    status: Optional[str] = None,
) -> Page:
    """Return one page of tickets for a queue, most-recently-updated first.

    `page` is 1-indexed. Callers iterate page=1, 2, 3, ... until
    `has_more` is False to walk the full result set (used by both the
    nightly export job and the paginated browse API).
    """
    query = select(Ticket).where(Ticket.queue_id == queue_id)
    if status is not None:
        query = query.where(Ticket.status == status)

    query = query.order_by(Ticket.updated_at.desc())

    offset = (page - 1) * page_size
    rows = session.execute(
        query.offset(offset).limit(page_size + 1)
    ).scalars().all()

    has_more = len(rows) > page_size
    items = rows[:page_size]
    return Page(items=items, has_more=has_more)
```

Relevant facts about the schema and workload:

- `tickets.updated_at` is a plain `TIMESTAMP` column, updated by application code every time a ticket is edited (status change, agent comment, priority change, etc.), and it is not guaranteed unique — many tickets can share the same `updated_at` value, especially when a bulk action touches several tickets in the same request.
- `queue_id` and `updated_at` are covered by a composite index, but `updated_at` values are not stable over the lifetime of an export or browsing session: any ticket can be updated (and thus reordered) at any moment by any agent, independent of the reader.
- The export job and the browse API both call `list_tickets_page` repeatedly with increasing `page` values and no other state carried between calls.

## Deliverable

Provide:

1. A precise explanation of the mechanism by which tickets are skipped and/or duplicated across pages, grounded in what `ORDER BY updated_at DESC` combined with `OFFSET`/`LIMIT` actually guarantees (and does not guarantee) when the underlying data changes between queries.
2. An explanation of why this shows up as both missing tickets and duplicate tickets, rather than only one of the two, and why bulk actions (many tickets updated near-simultaneously) make it noticeably worse.
3. A concrete recommendation for a pagination approach that would eliminate this class of drift for both the export job and the interactive browse API, including any schema, index, or API-contract changes required. If there is more than one reasonable approach, compare them and explain the trade-offs (e.g., consistency guarantees, implementation complexity, behavior when the sort key itself changes mid-session, impact on "jump to arbitrary page" functionality, index requirements).
