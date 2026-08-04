A service offers a "fetch preview" feature: users submit a URL and the backend fetches it to generate a link preview (title, image). The team asks you to review the fetcher, which runs inside their cloud VPC.

```python
import requests
from urllib.parse import urlparse

BLOCKED_HOSTS = {"localhost", "127.0.0.1"}

def fetch_preview(user_url: str):
    parsed = urlparse(user_url)
    if parsed.hostname in BLOCKED_HOSTS:
        raise ValueError("blocked host")
    if parsed.scheme not in ("http", "https"):
        raise ValueError("bad scheme")
    resp = requests.get(user_url, timeout=5, allow_redirects=True)
    return extract_preview(resp.text)
```

Context: the service runs on cloud instances that expose an instance-metadata endpoint on a link-local address; there are internal-only services reachable from the VPC.

Review this fetcher for server-side request forgery. Explain the SSRF risk in this environment and why the current allow/deny approach is inadequate (consider alternative address encodings, DNS resolution and rebinding, redirects, non-public IP ranges, and the metadata endpoint). Then specify a robust approach to safely fetching user-supplied URLs: what to validate, at what layer, and how to prevent access to internal and link-local addresses despite DNS and redirect tricks. Discuss the trade-off between a validation-based approach and network-level egress controls, and recommend a defense-in-depth design.
