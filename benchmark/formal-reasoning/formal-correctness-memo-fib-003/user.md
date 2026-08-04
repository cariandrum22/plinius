# Correctness of a Memoized Recursion

A memoized Fibonacci is written as:

```
memo: map from int to int, initially empty

fib(n):                 # assume n >= 0
    if n < 2: return n
    if n in memo: return memo[n]
    r = fib(n-1) + fib(n-2)
    memo[n] = r
    return r
```

The team wants a rigorous argument that memoization does not change the computed
result -- i.e. that `fib(n)` returns the true nth Fibonacci number for all
`n >= 0`, regardless of what is already in `memo` from prior calls.

Please produce:

1. A precise **caching invariant**: a property of the `memo` map that, if it
   holds before a call, is enough to conclude the cache never returns a wrong
   answer. State it (e.g. "every stored entry maps `k` to the true F(k)").

2. An argument that `fib(n)` returns the true F(n), by **strong induction** on
   `n`, using the caching invariant for the memo-hit branch and the recursive
   calls for the compute branch. Show that each write to `memo` preserves the
   caching invariant.

3. A note on the **assumptions the argument secretly relies on** -- e.g. that
   entries are never mutated to wrong values elsewhere, that `fib` is pure apart
   from the cache write, and that concurrent calls are out of scope (or, if not,
   what could break). Explain why the result is independent of call history only
   under those assumptions.

State any assumptions.
