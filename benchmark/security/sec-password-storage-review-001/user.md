A team is shipping email-and-password login for a new web application. During review they hand you the credential-handling module below and ask whether it is safe to deploy. They store the result of `hash_password` in a `users.password` column.

```python
import hashlib, os

def hash_password(password: str) -> str:
    salt = os.urandom(8).hex()
    digest = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}${digest}"

def verify_password(password: str, stored: str) -> bool:
    salt, digest = stored.split("$")
    candidate = hashlib.sha256((salt + password).encode()).hexdigest()
    return candidate == digest
```

Additional context from the team:
- Passwords have a maximum length of 20 characters and are stripped of non-ASCII characters at signup.
- There is no rate limiting on the login endpoint yet; that is "a later ticket".
- They plan to add a "password hint" field shown before login to help users remember.

Review this design. Explain what is wrong or risky and why it matters, and specify what a correct password-storage and verification scheme should look like for this application. Cover both the cryptographic choices and the surrounding controls the team has raised. Where you constrain a policy (such as length or composition), justify it against current guidance rather than folklore.
