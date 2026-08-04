# Justify the Greedy Choice in Dijkstra's Algorithm

Dijkstra's single-source shortest-path algorithm on a graph with
**non-negative** edge weights maintains a tentative distance `dist[v]` for each
vertex and a set `S` of finalized vertices:

```
dist[src] = 0; dist[v] = +inf for v != src; S = {}
while some vertex is not in S:
    u = a vertex not in S with the smallest dist[u]   # greedy pick
    add u to S                                        # finalize dist[u]
    for each edge (u, w) with weight c(u,w) >= 0:
        dist[w] = min(dist[w], dist[u] + c(u,w))      # relax
```

Your task is to give a rigorous correctness argument for the greedy step, and to
probe where it depends on the non-negativity assumption.

Please produce:

1. The **key invariant** that makes the algorithm correct: for every vertex `u`
   at the moment it is added to `S`, `dist[u]` equals the true shortest-path
   distance from `src` to `u`. State also the supporting invariant about
   `dist[v]` for vertices not yet in `S`.

2. A rigorous proof of the finalization invariant, by induction on the size of
   `S`. In the inductive step, consider the vertex `u` picked, suppose for
   contradiction a shorter path to `u` exists, and use the **non-negativity of
   edge weights** to derive a contradiction. Make the exact point where
   non-negativity is used unmistakable.

3. A precise explanation of **what breaks with a single negative edge**: exhibit
   the step of your proof that fails, and describe (in words or a tiny example)
   a graph where the greedy finalization gives a wrong `dist`. Distinguish this
   from why re-running with a different algorithm (e.g. one that re-relaxes)
   would be needed.

State your assumptions.
