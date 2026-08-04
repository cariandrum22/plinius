# Specify the Contract of an Atomic Compare-and-Swap

A hardware/runtime primitive is described informally as follows:

```
// Atomically: if the memory word at `addr` currently equals `expected`,
// store `newval` there and report success; otherwise leave memory unchanged
// and report failure. Returns the value that was read at `addr`.
word compare_and_swap(addr, expected, newval)
```

Engineers keep disagreeing about the exact guarantees. Your task is to write a
precise specification of `compare_and_swap` suitable for a concurrency library's
reference documentation.

Please produce:

1. A precise statement of the **precondition(s)** and **postcondition(s)** in
   terms of the value of memory before the call (`old`), the value after
   (`new`), and the returned value (`ret`). Cover both the success and the
   failure outcomes.

2. A clear statement of the **atomicity** guarantee: what it means for this
   operation to appear to take effect at a single instant with respect to other
   concurrent operations on the same word, and what that rules out.

3. An explicit account of at least two subtleties that a naive specification
   gets wrong -- for example, what the return value must be on failure, or how
   the "ABA" situation (a word changing away from and back to `expected`)
   interacts with your specification.

Aim for a specification that a reader could use to decide, for any concrete
scenario, whether an implementation is conformant. State any assumptions.
