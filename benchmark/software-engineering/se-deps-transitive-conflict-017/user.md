## Context

You are reviewing the dependency graph of `checkout-gateway`, an internal Node.js service that fronts several third-party payment providers. The service uses `@acme/http-client` (an internal HTTP wrapper with retry logic) to call providers, and `@acme/metrics-sdk` (an internal telemetry/alerting library) to classify and report on errors surfaced from those calls.

`package.json` (relevant excerpt):

```json
{
  "name": "checkout-gateway",
  "version": "5.8.2",
  "private": true,
  "dependencies": {
    "@acme/http-client": "^4.2.1",
    "@acme/metrics-sdk": "^2.5.3",
    "express": "^4.19.2"
  }
}
```

Both `@acme/http-client` and `@acme/metrics-sdk` depend on a shared internal package, `err-kit`, which defines a small hierarchy of error classes (`RetryableError`, `FatalError`, etc.) and helpers for classifying them. Their declared ranges are incompatible majors:

- `@acme/http-client@4.2.1` requires `err-kit@^3.1.0`
- `@acme/metrics-sdk@2.5.3` requires `err-kit@^1.6.0`

The resulting `npm ls err-kit --all` output:

```
checkout-gateway@5.8.2
├─┬ @acme/http-client@4.2.1
│ └── err-kit@3.1.4
└─┬ @acme/metrics-sdk@2.5.3
  └── err-kit@1.6.5
```

And the relevant `package-lock.json` entries (`lockfileVersion: 3`):

```json
"node_modules/@acme/http-client/node_modules/err-kit": {
  "version": "3.1.4",
  "resolved": "https://registry.npmjs.org/err-kit/-/err-kit-3.1.4.tgz",
  "integrity": "sha512-8h3F1z9pQeYQe0m2VZ2h2yq9xW1k3Nq0m3Z2r8h0kQeC1J5o9m1yV3q7c2r9h0m3Z2r8h0kQeC1J5o9m1yV3g=="
},
"node_modules/@acme/metrics-sdk/node_modules/err-kit": {
  "version": "1.6.5",
  "resolved": "https://registry.npmjs.org/err-kit/-/err-kit-1.6.5.tgz",
  "integrity": "sha512-2Qk9pRz1yV3q7c2r9h0m3Z2r8h0kQeC1J5o9m1yV3q7c2r9h0m3Z2r8h0kQeC1J5o9m1yV3q7c2r9h0m3g=="
}
```

The two relevant code paths:

```js
// node_modules/@acme/http-client/lib/fetchWithRetry.js
const { RetryableError, FatalError } = require('err-kit'); // resolves to err-kit@3.1.4

async function fetchWithRetry(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.status === 429 || res.status === 503) {
    throw new RetryableError(`upstream ${res.status} from ${url}`, { status: res.status });
  }
  if (!res.ok) {
    throw new FatalError(`upstream ${res.status} from ${url}`, { status: res.status });
  }
  return res.json();
}

module.exports = { fetchWithRetry };
```

```js
// src/lib/errorClassifier.js
const errKit = require('err-kit'); // resolves to err-kit@1.6.5 (hoisted to top-level node_modules)

function classifyAndReport(err, context) {
  if (errKit.isRetryable(err)) {
    metrics.increment('upstream.retryable_error', { provider: context.provider });
    return;
  }
  metrics.increment('upstream.fatal_error', { provider: context.provider });
  pagerduty.trigger(`Fatal upstream error from ${context.provider}: ${err.message}`);
  circuitBreaker.recordFailure(context.provider);
}

module.exports = { classifyAndReport };
```

Both versions of `err-kit` implement `isRetryable` the same way internally: `function isRetryable(err) { return err instanceof RetryableError; }`, where `RetryableError` is the class exported from that same package's own module.

## Symptom

Three weeks ago, `@acme/http-client` was bumped from `4.1.x` to `4.2.1` to pick up an unrelated bug fix in its connection-pooling logic. This bump also pulled in a new major version of `err-kit`. Since then, on-call has seen a sharp rise in PagerDuty alerts for "fatal upstream error" from `checkout-gateway`, along with more frequent circuit-breaker trips against providers that are otherwise healthy. Manual inspection of the flagged incidents shows the underlying errors are ordinary `429` rate-limit responses from providers — errors that had been correctly classified as retryable (logged, not paged) for over a year.

Reverting only `@acme/http-client` back to `4.1.x` resolves the symptom, but that also drops the connection-pooling fix the team wants to keep. Reverting only `@acme/metrics-sdk` does not help. Running `npm dedupe` was attempted and did not collapse the two `err-kit` installations.

## Deliverable

Provide:

1. A precise diagnosis of why `errKit.isRetryable(err)` fails to recognize the `RetryableError` instances thrown by `fetchWithRetry`, tracing exactly why two separate copies of `err-kit` end up installed in this tree and why `npm dedupe` did not collapse them.
2. An explanation of why this problem is coupled specifically to the `@acme/http-client` version bump, and why it is the retryable/fatal classification that broke rather than some other part of the request path.
3. A concrete set of resolution strategies available to the team (for example: forcing a single shared `err-kit` version via `overrides`/`resolutions`, coordinating a compatible range with one of the package owners, upgrading `@acme/metrics-sdk` to a version compatible with `err-kit@3`, or restructuring how errors are classified so it no longer depends on cross-package class identity). Recommend one, and explain the trade-offs and risks you are accepting — including what you would want to verify before shipping the fix.
