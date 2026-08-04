## Context

You are reviewing the dependency setup of `billing-invoicer`, an internal Node.js service, after a production incident: invoices generated for customers in the `Pacific/Auckland` timezone were dated one calendar day off for a period of about two weeks. The bug was traced to a behavior change between major versions of the `date-fns` library, even though the team believed their manifest pinned `date-fns` to a `2.x` range. During the incident review, the team pulled the following files from the commit that introduced the regression — a routine dependency-bump PR from a contractor, merged four weeks prior — and has asked you to audit them for how this could have happened and what else might be wrong.

`package.json` (relevant excerpt):

```json
{
  "name": "billing-invoicer",
  "version": "3.2.0",
  "engines": { "node": ">=18" },
  "dependencies": {
    "csv-stringify": "^6.4.0",
    "date-fns": "^2.30.0",
    "left-pad-ng": "1.3.0"
  }
}
```

`package-lock.json` (`lockfileVersion: 3`, relevant excerpt):

```json
{
  "name": "billing-invoicer",
  "version": "3.2.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "billing-invoicer",
      "version": "3.2.0",
      "dependencies": {
        "csv-stringify": "^6.4.0",
        "date-fns": "^2.30.0",
        "left-pad-ng": "1.3.0"
      }
    },
    "node_modules/csv-stringify": {
      "version": "6.4.0",
      "resolved": "https://registry.npmjs.org/csv-stringify/-/csv-stringify-6.5.1.tgz",
      "integrity": "sha512-QpwG6P4wZR9CetlR2vt1cS7wSbqxbNe4NC/JLoRQfHRQE1n7wJ6ZzIY8m1FvzE0P8n6C1r2xVdxG9L8h0mS4uQ=="
    },
    "node_modules/date-fns": {
      "version": "3.6.0",
      "resolved": "https://registry.npmjs.org/date-fns/-/date-fns-3.6.0.tgz",
      "integrity": "sha512-fRHTG8g/Gif+kSh50gaGEdToemgfj74aFVsYIiKj8DhOKfN8h1t4uwj2mfhsPPqxc2PmwiJnBuG5FoM4nUdeVQ=="
    },
    "node_modules/left-pad-ng": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/left-pad-ng/-/left-pad-ng-1.3.0.tgz",
      "integrity": "sha512-9k1xdVczM3vJtZaFjZOr2X1G8VuTxKr5Y1KZmYQKQmL2XyBz9dQxCkC1yzq7bqA3hXK4C0nn1uYQwqk3nqK1zg=="
    },
    "node_modules/legacy-formatter": {
      "version": "0.9.2",
      "resolved": "https://registry.npmjs.org/legacy-formatter/-/legacy-formatter-0.9.2.tgz",
      "integrity": "sha512-1bC3q2fW0K3sVzYyPz9g0i0rW3z3vN1o0nQe9tS8g6b8ihR0kQxA5dS2mUeJc4G3fQe1jv2yE7Yz9bY0z0m3dQ=="
    }
  }
}
```

The team also shares the relevant portion of their CI workflow, which they note was changed about two months ago "to speed up cold-cache builds":

```yaml
# .github/workflows/ci.yml (relevant step)
- name: Install dependencies
  run: npm install --no-audit --prefer-offline
```

This step used to run `npm ci`. No one on the current team recalls approving the switch, and there is no record of `legacy-formatter` appearing in any recent PR diff of `package.json` — it does not appear as a dependency of `csv-stringify`, `date-fns`, or `left-pad-ng` at the versions currently declared, and nothing in the codebase imports it.

## Deliverable

Provide:

1. An enumeration of every distinct integrity or pinning weakness you can identify from the manifest, lockfile, and CI configuration given — including but not limited to what caused the `date-fns` incident — with a precise explanation of the mechanism behind each one (why the tooling allowed it, not just that it looks wrong).
2. An assessment of how each weakness could have been prevented or caught automatically, given the tools already in play (`npm`, the lockfile format shown, CI).
3. A concrete hardening strategy going forward: pinning policy, lockfile hygiene practices, verification steps, and review/CI gates. Prioritize your recommendations and explain what trade-offs (build speed, developer friction, false-positive risk) you are accepting for each.
