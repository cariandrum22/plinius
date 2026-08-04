## Context

Your team owns a small Python library used by several internal services: it issues short-lived session tokens and enforces a per-client sliding-window rate limit on an internal API gateway. The code has shipped for months, but its test suite has a reputation for being unreliable: it passes locally most of the time, but fails intermittently in CI, and the failure pattern seems to depend on which CI runner picks up the job and what time of day it runs. Nobody currently trusts a red build from this suite, so failures are usually just re-run until they pass.

Here is the production code:

```python
# tokens.py
import os
from datetime import datetime, timedelta


class SessionToken:
    def __init__(self, value: str, expires_at: datetime):
        self.value = value
        self.expires_at = expires_at

    @classmethod
    def issue(cls, ttl_seconds: float) -> "SessionToken":
        expires_at = datetime.utcnow() + timedelta(seconds=ttl_seconds)
        return cls(value=os.urandom(8).hex(), expires_at=expires_at)

    def is_expired(self) -> bool:
        return datetime.now() > self.expires_at
```

```python
# rate_limiter.py
from datetime import datetime, timedelta


class SlidingWindowRateLimiter:
    """Allows at most `max_requests` calls per `window_seconds`, per client_id."""

    def __init__(self, max_requests: int, window_seconds: float):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._requests: dict[str, list[datetime]] = {}

    def allow(self, client_id: str) -> bool:
        now = datetime.now()
        window_start = now - timedelta(seconds=self.window_seconds)
        history = self._requests.setdefault(client_id, [])
        while history and history[0] < window_start:
            history.pop(0)
        if len(history) >= self.max_requests:
            return False
        history.append(now)
        return True

    def reset(self, client_id: str) -> None:
        self._requests.pop(client_id, None)
```

And here is the current test suite:

```python
# test_tokens_and_limiter.py
import time

from tokens import SessionToken
from rate_limiter import SlidingWindowRateLimiter


def test_session_token_not_expired_immediately():
    token = SessionToken.issue(ttl_seconds=5)
    assert token.is_expired() is False


def test_session_token_expires_after_ttl():
    token = SessionToken.issue(ttl_seconds=1)
    time.sleep(1.2)
    assert token.is_expired() is True


def test_rate_limiter_blocks_after_limit():
    limiter = SlidingWindowRateLimiter(max_requests=3, window_seconds=1)
    for _ in range(3):
        assert limiter.allow("client-1") is True
    assert limiter.allow("client-1") is False


def test_rate_limiter_resets_after_window():
    limiter = SlidingWindowRateLimiter(max_requests=2, window_seconds=1)
    assert limiter.allow("client-2") is True
    assert limiter.allow("client-2") is True
    assert limiter.allow("client-2") is False
    time.sleep(1.1)
    assert limiter.allow("client-2") is True
```

Additional facts an on-call engineer gathered while investigating:

- The CI fleet runs containers configured with `TZ=UTC`. Some engineers' laptops are configured with other local time zones (e.g. UTC+9). A few "it fails on my machine but not in CI" and "it fails in CI but not on my machine" reports have both been filed for `test_session_token_expires_after_ttl` and `test_session_token_not_expired_immediately`, depending on the reporter's machine and time of day.
- `test_rate_limiter_resets_after_window` fails a few times a week in CI, always with the final assertion, never the earlier ones. It has never failed locally for anyone.
- The full suite currently takes several seconds to run because of the `time.sleep` calls, and this module is one of the slower parts of the overall test run.
- Nobody has changed `window_seconds`, `ttl_seconds`, or the sleep durations recently; the flakiness has existed since these tests were written.

## Deliverable

Provide:

1. A precise diagnosis of every distinct source of non-determinism or environment-sensitivity in the code and tests above, explaining the exact mechanism by which each one can cause a test to pass or fail unpredictably (not just "it depends on timing" in general terms).
2. An explanation of why the reported failure patterns look the way they do — e.g., why the token tests are sensitive to the machine's configured time zone specifically, and why the rate-limiter test fails only in CI and only on the final assertion rather than intermittently throughout.
3. A redesign of the production code and/or its public surface, plus a redesigned test suite, so that all time-dependent behavior can be exercised and asserted deterministically, without relying on real sleeps, the machine's local time zone, or wall-clock races. Explain what changes to the code's API (if any) you are proposing, show the resulting tests, and discuss the trade-offs of your approach versus at least one plausible alternative (for example, effects on production code complexity, how realistic the tests remain, and how you would still gain confidence in behavior under real elapsed time, clock skew, or timezone edge cases such as DST transitions).
