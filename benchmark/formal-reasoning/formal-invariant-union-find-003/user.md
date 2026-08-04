# Argue the Rank Invariant of Union-Find Is Inductive

Consider a union-find (disjoint-set) forest with union-by-rank but WITHOUT
path compression, so we can reason about rank cleanly:

```
parent[x]: initially x (each element its own root)
rank[x]:   initially 0

find(x):   while parent[x] != x: x = parent[x]
           return x            # the root

union(a,b):
    ra = find(a); rb = find(b)
    if ra == rb: return
    if rank[ra] < rank[rb]: parent[ra] = rb
    elif rank[ra] > rank[rb]: parent[rb] = ra
    else: parent[rb] = ra; rank[ra] += 1
```

A textbook claims: "a tree rooted at a node of rank r contains at least 2^r
nodes." Your task is to reason about the invariant machinery behind this claim.

Please produce:

1. A precise statement of the **invariant(s)** over the forest that you would
   maintain to establish the size bound -- at minimum, the relationship between a
   root's rank and the size of its tree, and any supporting facts about how rank
   changes.

2. An **inductive argument** that your invariant is preserved by `union`. Do a
   careful case split on the three branches (`rank[ra] < rank[rb]`, `>`, and the
   equal case that increments a rank). Show precisely why the size bound survives
   each, especially the rank-incrementing case.

3. A note on why **path compression** would or would not disturb your chosen
   invariant, and whether your invariant is stated over roots only or over all
   nodes -- and why that choice matters for the induction.

State your assumptions.
