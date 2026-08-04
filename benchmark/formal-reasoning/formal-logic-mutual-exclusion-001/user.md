# Formalize Mutual Exclusion, Deadlock-Freedom, and Starvation-Freedom

Two processes each cycle through regions modeled by a location variable per
process, `pc_i in {IDLE, WAIT, CRITICAL}`. You are asked to formalize the
correctness requirements of a mutual-exclusion protocol as temporal properties,
independent of any particular algorithm.

Please produce, using precise temporal language (you may write operators as
'always' [], 'eventually' <>, and 'leads-to' ~>, with clearly stated meanings):

1. **Mutual exclusion (safety)**: formalize "the two processes are never in the
   CRITICAL region at the same time". State it precisely and explain why it is a
   safety property.

2. **Deadlock-freedom** and **starvation-freedom (liveness)**: formalize (a)
   "whenever some process is WAITing, some process eventually enters CRITICAL",
   and (b) the stronger "any process that WAITs eventually enters CRITICAL
   itself". State both, and explain precisely how they differ and why (b) is
   strictly stronger. Identify the **fairness assumption** on scheduling that a
   proof of (b) would need, and argue why (b) can fail without it.

3. A discussion of a **vacuity trap**: give a temporal formula that looks like a
   liveness guarantee but is actually vacuously satisfiable (e.g. an implication
   whose antecedent a trivial implementation never makes true), and explain how
   to reformulate so the property is non-vacuous. Distinguish "the protocol is
   correct" from "the property is meaningful".

State your assumptions.
