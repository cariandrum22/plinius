# Analyze a Linear Resource-Handling Type Rule

A language uses linear types to guarantee that a file handle is closed exactly
once and never used after closing. The intended discipline:

```
- A value of type Handle is LINEAR: it must be consumed exactly once.
- open() : Handle                        (produces a fresh linear Handle)
- read(h: Handle) : (Handle, Data)       (consumes h, returns a fresh Handle)
- close(h: Handle) : Unit                (consumes h, produces nothing)

Typing uses a context split: to type an expression using two linear values, the
context is split so each linear variable is used in exactly one subterm.
```

A contributor proposes adding this convenience rule for conditionals:

```
   G |- t1 : Bool     G1 |- t2 : T     G2 |- t3 : T
   ------------------------------------------------- (T-If-Linear, proposed)
              G, G1, G2 |- if t1 then t2 else t3 : T
```

where `G1` and `G2` are the linear contexts used by the two branches. Your task
is to analyze whether this rule preserves the exactly-once discipline.

Please produce:

1. A precise statement of the **safety property** the linear discipline is meant
   to enforce (each Handle is consumed exactly once; no use-after-close; no
   leak/double-close), and what "consumed exactly once" means across a branch
   where only one branch actually runs.

2. A rigorous analysis of the proposed **T-If-Linear** rule. Is combining the
   branch contexts as `G1, G2` correct, or should both branches be required to
   consume the *same* linear context? Construct a well-typed (under the proposed
   rule) program that closes a handle in one branch but leaks or double-uses it
   relative to the other, or argue why the rule is actually sound. Pin the exact
   context-management mistake if there is one.

3. A statement of the **corrected rule** (if needed) and an argument that it
   restores the invariant, including how it interacts with a handle that is used
   *after* the `if` expression. Explain the general principle for linear
   contexts and branching.

State your assumptions.
