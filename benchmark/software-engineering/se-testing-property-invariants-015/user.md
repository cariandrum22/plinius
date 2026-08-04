## Context

Your team maintains a billing utility library used across several services: splitting an invoice's total among its line items when a discount is prorated, splitting a shared subscription charge among cohabiting accounts, and distributing a bulk refund across the original order's items. All of these reduce to the same underlying problem: divide an integer amount (always expressed in the smallest currency unit, e.g. cents) into a fixed number of integer parts, in proportion to a set of weights, such that the parts always sum back to exactly the original amount.

The function currently has a single example-based test file that checks a handful of hand-picked inputs. Finance has asked for much stronger test coverage before this library is used for regulatory reporting, because a rounding discrepancy of even one cent, multiplied across millions of invoices, is treated as a reportable defect.

Here is the function:

```typescript
/**
 * Splits an integer `total` (e.g. cents) into `ratios.length` integer parts,
 * distributed as proportionally as possible to `ratios`, such that the parts
 * always sum exactly to `total`.
 */
export function allocate(total: number, ratios: number[]): number[] {
  if (!Number.isInteger(total) || total < 0) {
    throw new RangeError(`total must be a non-negative integer, got ${total}`);
  }
  if (ratios.length === 0) {
    throw new RangeError("ratios must not be empty");
  }
  if (ratios.some((r) => r < 0 || !Number.isFinite(r))) {
    throw new RangeError("ratios must be non-negative finite numbers");
  }

  const sumRatios = ratios.reduce((a, b) => a + b, 0);
  if (sumRatios === 0) {
    throw new RangeError("sum of ratios must be greater than zero");
  }

  const rawShares = ratios.map((r) => (total * r) / sumRatios);
  const floors = rawShares.map((s) => Math.floor(s));
  const allocated = floors.reduce((a, b) => a + b, 0);
  const remainder = total - allocated;

  const fractionalParts = rawShares.map((s, i) => ({ index: i, frac: s - floors[i] }));
  fractionalParts.sort((a, b) => b.frac - a.frac);

  const result = [...floors];
  for (let i = 0; i < remainder; i++) {
    result[fractionalParts[i % fractionalParts.length].index] += 1;
  }

  return result;
}
```

And here is the existing example-based test file, in full:

```typescript
import { describe, it, expect } from "vitest";
import { allocate } from "./allocate";

describe("allocate", () => {
  it("splits evenly when ratios are equal", () => {
    expect(allocate(100, [1, 1, 1, 1])).toEqual([25, 25, 25, 25]);
  });

  it("distributes the remainder when it does not divide evenly", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it("handles a single recipient", () => {
    expect(allocate(100, [1])).toEqual([100]);
  });

  it("throws for a negative total", () => {
    expect(() => allocate(-1, [1, 1])).toThrow(RangeError);
  });
});
```

The engineer who wrote `allocate` has moved to another team, and nobody currently maintaining the library is fully confident it is correct for arbitrary weight distributions, large numbers of recipients, or ratios with very different magnitudes (e.g. `[1, 1000000]`).

## Deliverable

Provide:

1. The key properties/invariants that `allocate` must satisfy for it to be trustworthy for financial use, independent of any specific input example. State each property precisely enough that it could be turned into an executable assertion.
2. A concrete property-based test design: the generators/arbitraries you would use for `total` and `ratios` (including how you would cover edge cases like zero-weight entries, highly skewed ratios, large recipient counts, and boundary totals), what each property-based test asserts, and any considerations around shrinking (what a minimal, debuggable failing case should look like) and around test performance (property-based tests run many iterations, so runtime and generator cost matter).
3. An explanation of what "oracle" you are checking each property against — i.e., how the test determines a candidate output is correct without simply re-implementing `allocate` itself — and where, if anywhere, you would still rely on example-based tests as a complement rather than a replacement.
4. A discussion of what classes of bugs your property-based tests would catch that the existing example-based tests would not, and, conversely, anything a property-based approach alone would be unlikely to catch.
