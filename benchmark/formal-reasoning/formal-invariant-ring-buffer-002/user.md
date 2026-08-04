# Prove a Ring-Buffer Index Invariant Is Inductive

A fixed-capacity ring buffer is implemented with a backing array of size
`N` and two monotonically increasing counters, `head` and `tail`:

```
N: fixed capacity, N >= 1
head, tail: unbounded non-negative integers, both start at 0
count()  = tail - head
empty()  = (head == tail)
full()   = (tail - head == N)

push(x):  if full():  reject
          buf[tail % N] = x
          tail += 1
pop():    if empty(): reject
          x = buf[head % N]
          head += 1
          return x
```

Your task is to identify and justify the invariant that makes this
implementation correct.

Please produce:

1. A precise **representation invariant** relating `head`, `tail`, and `N` that
   holds in every reachable state (at minimum, bounding `tail - head`). State it
   as a predicate.

2. A rigorous argument that your invariant is **inductive**: it holds initially,
   and every `push` (accepted or rejected) and `pop` (accepted or rejected)
   preserves it. Identify precisely which guard prevents the invariant from
   being violated.

3. An explanation of **why this invariant is the right strength**: show that it
   is strong enough to prove the safety property "the buffer never overwrites an
   unread element and never reads a stale slot", and explain what would go wrong
   (a concrete bad state) if the `full()` guard were dropped.

State assumptions, including any about integer overflow of the counters.
