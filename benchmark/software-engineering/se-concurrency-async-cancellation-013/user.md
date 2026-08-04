## Context

You are reviewing an `asyncio`-based Python service that assembles a user dashboard by fetching a profile, recent orders, and recommendations concurrently from three separate upstream services, then rendering all three sections together. To keep page load times predictable even if one upstream is slow, the coordinator caps the whole fan-out with an overall deadline.

Since this was deployed, two problems have been reported:

1. Under sustained load with one upstream running slow, memory and open-connection counts for the process climb over time and are only reset by a restart. Profiling shows a growing number of live `Task` objects that are not associated with any currently-active HTTP request.
2. A recurring bug where a single upstream (usually recommendations) intermittently returns malformed JSON has gone completely undetected in production logs for weeks, even though it should affect a visible fraction of dashboard loads, and was only found by accident during an unrelated investigation.

Here is the relevant coordinator code:

```python
import asyncio
import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

DASHBOARD_DEADLINE_SECONDS = 2.0


@dataclass
class DashboardData:
    profile: dict | None = None
    orders: list = field(default_factory=list)
    recommendations: list = field(default_factory=list)


async def fetch_profile(user_id: str, session) -> dict:
    async with session.get(f"/users/{user_id}") as resp:
        return await resp.json()


async def fetch_orders(user_id: str, session) -> list:
    async with session.get(f"/orders?user={user_id}") as resp:
        return await resp.json()


async def fetch_recommendations(user_id: str, session) -> list:
    async with session.get(f"/recs/{user_id}") as resp:
        return await resp.json()


async def load_dashboard(user_id: str, session) -> DashboardData:
    """Fetch profile, orders, and recommendations concurrently, capped by
    an overall deadline so the dashboard renders promptly even if one
    upstream is slow."""
    tasks = {
        "profile": asyncio.create_task(fetch_profile(user_id, session)),
        "orders": asyncio.create_task(fetch_orders(user_id, session)),
        "recommendations": asyncio.create_task(fetch_recommendations(user_id, session)),
    }

    done, pending = await asyncio.wait(
        tasks.values(), timeout=DASHBOARD_DEADLINE_SECONDS
    )

    result = DashboardData()
    name_by_task = {task: name for name, task in tasks.items()}

    for task in done:
        name = name_by_task[task]
        try:
            value = task.result()
        except Exception:
            # Upstream hiccup; degrade gracefully for this section.
            continue
        setattr(result, name, value)

    return result
```

`load_dashboard` itself runs as a coroutine inside a request handler for an async web framework; the framework cancels the handler's task if the client disconnects before the response is sent. `session` is a shared, long-lived HTTP client session reused across requests.

## Deliverable

Provide:

1. A precise explanation of the task/resource leak: trace what happens to the entries in `pending` after `asyncio.wait` returns due to the timeout, and explain why this produces the growing count of live, request-unassociated `Task` objects seen in profiling, including what happens to those tasks if the client disconnects and `load_dashboard`'s own task is cancelled while some of `tasks` are still outstanding.
2. A precise explanation of why the malformed-JSON bug in recommendations has been invisible in logs, tied to a specific piece of the code above.
3. A redesign of `load_dashboard` that correctly propagates cancellation and cleans up all resources in every exit path (deadline hit, one or more upstreams erroring, and the caller itself cancelling `load_dashboard`), while preserving the intent of returning a best-effort dashboard within the deadline when possible. Discuss the trade-offs of your approach — for example, between returning partial results on timeout versus treating a timeout as a hard failure for the whole request, and between manual task management versus structured-concurrency constructs, including what "cleanup" needs to guarantee for each of the three fetches given that they hold a shared HTTP session rather than owning their own connections.
