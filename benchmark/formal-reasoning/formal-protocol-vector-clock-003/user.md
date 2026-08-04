# Reason About Vector Clocks and Causal Ordering

Vector clocks track causality among `N` processes. Each process `i` keeps a
vector `V_i` of length N:

```
- Initially V_i[k] = 0 for all k.
- Before an internal or send event, process i increments V_i[i] by 1.
- On sending a message, i attaches its current vector V_i.
- On receiving a message with attached vector W, process j sets
  V_j[k] = max(V_j[k], W[k]) for all k, then increments V_j[j] by 1.

Compare vectors: U <= V iff U[k] <= V[k] for all k.
U < V iff U <= V and U != V.  U and V are CONCURRENT if neither U < V nor V < U.
```

Your task is to reason about what these clocks capture.

Please produce:

1. A precise statement of the intended **characterization property**: for two
   events `a` and `b` with timestamps `V(a)` and `V(b)`, "`a` happened-before `b`
   (in Lamport's causal sense) **if and only if** `V(a) < V(b)`". State the
   happens-before relation precisely (program order, send-before-receive, and
   transitivity).

2. An argument for the **forward direction** (if `a` happened-before `b` then
   `V(a) < V(b)`), reasoning about how the increment and max/merge rules
   propagate along any causal chain. Identify the invariant on entries that makes
   the chain argument go through.

3. An argument for the **reverse direction** and the concurrency claim: explain
   why `V(a) < V(b)` implies a causal chain from `a` to `b` (so unrelated events
   yield incomparable vectors), and give the intuition for why two truly
   concurrent events must produce incomparable vectors. Point out precisely which
   clock rule would have to change to break the 'iff'.

State your assumptions.
