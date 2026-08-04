# Reason About Binary Search Loop Correctness and Termination

Here is an integer binary search over a sorted array `a[0..n-1]` (ascending,
possibly with duplicates), returning any index of `key` or -1 if absent:

```
lo = 0; hi = n - 1
while lo <= hi:
    mid = lo + (hi - lo) / 2      # integer division
    if a[mid] == key: return mid
    elif a[mid] < key: lo = mid + 1
    else: hi = mid - 1
return -1
```

Your task is to argue this is correct, rigorously.

Please produce:

1. A **loop invariant** precise enough to prove correctness -- capturing the
   property that if `key` is present at all, it lies within the current
   `[lo, hi]` window. State it as a predicate over `lo`, `hi`, and the array.

2. An argument that the invariant is **established** before the loop and
   **maintained** by each iteration, using the sortedness of `a`. Then use the
   invariant to justify the two exit outcomes (a `return mid` and the final
   `return -1`).

3. A **termination** argument: give a measure that strictly decreases each
   iteration and is bounded below, and confirm the loop cannot loop forever or
   skip over the key. Explicitly address why `mid` always lies in `[lo, hi]` and
   why progress is made even when the window has one or two elements.

State assumptions, including any about integer overflow.
