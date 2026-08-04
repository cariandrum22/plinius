## Context

You maintain `@acme/schema-kit`, an internal TypeScript validation library used to parse and validate configuration objects at service startup. It currently ships as major version 2 (`2.x`) and is consumed, directly or transitively, by roughly 120 internal services, with about 40,000 installs/week across CI and local development. Adoption is wide enough that you do not have a complete inventory of every call site.

The library's primary entry point has looked like this since `2.0.0`, released about 18 months ago:

```ts
// src/index.ts (v2.x, current)
export interface ParseOptions {
  /**
   * When true, coerce loosely-typed input (e.g. the strings "true"/"false",
   * or numeric strings) into the target field's declared type before
   * validating. Defaults to true for backward compatibility with configs
   * originally written for plain-JSON / environment-variable sources.
   */
  coerceTypes?: boolean;
}

/**
 * Parses and validates `input` against `schema`.
 * On success, returns the validated, typed config object.
 * On validation failure, logs a structured warning describing the first
 * failing field and returns `null`. Callers are expected to null-check
 * the result before use.
 */
export function parseConfig<T>(
  input: unknown,
  schema: Schema<T>,
  options?: ParseOptions
): T | null {
  // ...
}
```

Two changes are being proposed together for the next release, motivated by a pattern the platform team has traced through four separate production incidents:

- **Silent failure via `null` return.** Several incidents involved a service calling `parseConfig(...)` without null-checking the result, then dereferencing fields on `null` several stack frames later, or proceeding with `undefined` values silently substituted elsewhere. The proposal is for `parseConfig` to throw a new exported `ConfigValidationError` (containing the same structured failure detail currently only logged) on validation failure, instead of returning `null`.
- **Silent coercion via the `coerceTypes` default.** One incident involved an operator setting an environment variable to the string `"1t"` (a typo), which `coerceTypes` silently coerced into the numeric value `1` for a field expecting a small integer count, rather than failing validation — the service started with a nonsensical but "valid-looking" value instead of crashing loudly at startup. The proposal is to flip the default of `coerceTypes` to `false`, requiring callers to opt in explicitly to loose coercion.

Additional constraints you must work within:

- Company policy requires a minimum two-minor-version deprecation window (with a working, documented alternative available throughout that window) before any publicly documented behavior is removed in a major release. This policy applies to internal libraries above a usage threshold, and `@acme/schema-kit` is above it.
- A nightly "consumer contract" test suite runs the latest published `@acme/schema-kit` against real config fixtures pulled from roughly 30 of the largest consuming services, and treats any change in `parseConfig`'s observable behavior against those fixtures as a failing signal, whether or not the change was intentional.
- At least a dozen known consumers (likely more unknown) import an internal path directly, e.g. `@acme/schema-kit/lib/parseConfig`, bypassing the package's declared public entry point and its `main`/`exports` field. This limits how much can be enforced purely by curating the public API surface.
- Several consuming teams have historically been slow to adopt major version bumps (some services still pin `@acme/schema-kit@1.x`, two majors behind), and there is organizational pressure to reduce, not increase, the number of actively-supported major lines.

## Deliverable

Provide:

1. The correct semver classification for each of the two proposed changes individually (the `null`-return-to-throw change, and the `coerceTypes` default flip), with justification — including whether they should ship together in one release or be sequenced/staged separately, and why.
2. A concrete deprecation and release strategy that satisfies the two-minor-version deprecation policy and accounts for both the nightly consumer contract suite and the deep-import consumers who bypass the public entry point.
3. A migration path for consuming teams, including guidance for the deep-import consumers you cannot fully control, and a recommendation on how aggressively to push adoption given the organizational pressure to reduce actively-supported major lines. Justify the trade-offs you are accepting between migration churn across ~120 consumers and the ongoing cost of silent failures in production.
