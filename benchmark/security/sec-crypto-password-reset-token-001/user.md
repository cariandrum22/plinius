You are reviewing a password-reset feature. When a user requests a reset, the backend generates a token, emails a link, and later accepts the token to set a new password. The current implementation:

```python
import time, hashlib

def make_reset_token(user_id: int) -> str:
    raw = f"{user_id}:{int(time.time())}"
    return hashlib.md5(raw.encode()).hexdigest()

# stored: nothing; the link is emailed as
# https://app.example.com/reset?token=<token>&uid=<user_id>

def consume_reset_token(user_id: int, token: str) -> bool:
    # recompute the token for a range of recent timestamps and compare
    now = int(time.time())
    for t in range(now - 3600, now + 1):
        if hashlib.md5(f"{user_id}:{t}".encode()).hexdigest() == token:
            return True
    return False
```

Context: reset links are emailed; there is no expiry beyond the one-hour recompute window; requesting a reset does not invalidate existing sessions.

Review this password-reset token design. Explain what makes a reset token secure and where this implementation fails, including the predictability of the token, the lack of server-side state, and the surrounding lifecycle (expiry, single use, session invalidation, and information leakage in responses). Specify a correct design for generating, storing, validating, and expiring reset tokens, and justify the cryptographic choices.
