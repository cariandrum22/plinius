# Bounded-Buffer Safety Specification in TLA+

You are formalizing the core safety contract of a classic **bounded buffer**
(single-producer / single-consumer FIFO queue) so it can be model-checked with
TLC.

## The protocol

A shared buffer holds an ordered sequence of items and has a fixed positive
capacity `Capacity`. Two atomic operations mutate it:

- **Produce** — enabled only when the buffer is **not full**
  (`Len(buffer) < Capacity`). It appends one new item to the tail of the buffer
  and increments a running `produced` counter.
- **Consume** — enabled only when the buffer is **not empty**
  (`Len(buffer) > 0`). It removes the item at the head of the buffer and
  increments a running `consumed` counter.

Nothing else changes the buffer. The system starts empty with both counters at
zero.

## Your task

Write a **complete, self-contained TLA+ module** that formalizes this protocol:

1. Declare the state variables (at minimum: the buffer sequence and the
   `produced` / `consumed` counters) and a `CONSTANT Capacity`, with an
   `ASSUME` that pins it to a positive natural number.
2. Define **`Init`** describing the unique initial state.
3. Define the **`Produce`** and **`Consume`** actions with their correct
   enabling guards, and combine them into **`Next`**. Every action must assign a
   primed value (or `UNCHANGED`) to *every* declared variable.
4. Define a temporal **`Spec == Init /\\ [][Next]_vars`** formula.
5. State a **named safety invariant** capturing the real correctness property of
   this protocol. A strong invariant relates the buffer length to the counters,
   e.g. the buffer never exceeds capacity **and** its length equals
   `produced - consumed`. It must be a genuine constraint on reachable states —
   **not** `TRUE`, not `x = x`, and not merely a restatement of the type
   signature.

Then write a prose **Explanation** that:

- maps each variable, `Init`, `Next` action, and the invariant back to the
  informal protocol, and
- argues concretely **why the invariant is non-vacuous** — describe a plausible
  buggy variant of the spec (for instance, one that drops the `Len(buffer) <
  Capacity` guard) whose reachable states would violate the invariant.

## Deliverables

- One fenced ```` ```tla ```` code block containing the full module.
- A Markdown `## Explanation` section as described above.
- The same module emitted as a file named exactly **`spec.tla`** (via a
  `{"files":[...]}` JSON envelope or a `File: spec.tla` marker). Its contents
  must match the fenced block byte-for-byte.

## Notes

- A passing TLC run is **necessary but not sufficient**: a vacuous invariant
  also passes. Fidelity to the protocol and the substance of the invariant are
  what matter.
- Keep the module parametric in `Capacity`; do not hard-code a single size into
  the actions.
