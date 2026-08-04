# State and Defend the Conservation Invariant for Transfers

Consider an in-memory ledger of account balances and a single operation:

```
transfer(from, to, amt):
    if amt <= 0: reject
    if balance[from] < amt: reject
    balance[from] -= amt
    balance[to]   += amt
```

All balances start at some fixed non-negative values, and `transfer` is the only
operation that mutates balances. Your task is to state the key correctness
invariants and argue they hold.

Please produce:

1. Two invariants stated precisely over the `balance` map: (a) a **conservation**
   invariant about the total of all balances, and (b) a **non-negativity**
   invariant about each individual balance.

2. An **inductive argument** for each: show it holds in the initial state, and
   that any single (accepted or rejected) `transfer` call preserves it. Be
   explicit about which guard in the code is doing the work in each case.

3. A note on why a naive statement of the conservation invariant could be
   **vacuous or wrong** -- for instance if `from == to`, or if you stated it only
   about the two touched accounts rather than the whole ledger.

State any assumptions (e.g. about integer arithmetic).
