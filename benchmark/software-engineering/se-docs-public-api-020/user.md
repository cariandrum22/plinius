# Task

You are documenting a small Rust concurrency primitive for an internal systems library used by several teams. The type below currently has no doc comments, and other engineers keep misusing it because its contract lives only in the head of the original author. Your job is to write the missing API documentation.

## Code

```rust
use std::sync::{Arc, Condvar, Mutex};
use std::collections::VecDeque;

pub struct BoundedQueue<T> {
    inner: Mutex<Inner<T>>,
    not_full: Condvar,
    not_empty: Condvar,
    capacity: usize,
}

struct Inner<T> {
    items: VecDeque<T>,
    closed: bool,
}

#[derive(Debug)]
pub enum PushError<T> {
    Closed(T),
}

impl<T> BoundedQueue<T> {
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "BoundedQueue capacity must be greater than zero");
        BoundedQueue {
            inner: Mutex::new(Inner { items: VecDeque::with_capacity(capacity), closed: false }),
            not_full: Condvar::new(),
            not_empty: Condvar::new(),
            capacity,
        }
    }

    pub fn push(&self, item: T) -> Result<(), PushError<T>> {
        // ...
    }

    pub fn pop(&self) -> Option<T> {
        // ...
    }

    pub fn close(&self) {
        // ...
    }

    pub fn len(&self) -> usize {
        // ...
    }
}

unsafe impl<T: Send> Send for BoundedQueue<T> {}
unsafe impl<T: Send> Sync for BoundedQueue<T> {}
```

## Behavioral contract (confirmed with the original author)

- `new`: Panics if `capacity` is `0`. The queue pre-allocates storage for `capacity` items.
- `push`: Takes ownership of `item`. If the queue currently holds fewer than `capacity` items and is not closed, the item is enqueued immediately and `Ok(())` is returned. If the queue is full and open, the calling thread **blocks** (not spins) until space becomes available or the queue is closed. If the queue is or becomes closed while the calling thread is waiting, `push` returns `Err(PushError::Closed(item))`, handing ownership of the item back to the caller — the item is never silently dropped. Multiple concurrent `push` callers may block on the same queue; the order in which they wake and successfully enqueue is not guaranteed (no FIFO fairness guarantee across producers).
- `pop`: If the queue holds at least one item, removes and returns `Some(item)` (FIFO order among enqueued items). If the queue is empty and open, the calling thread blocks until an item is pushed or the queue is closed. Returns `None` only once the queue is both closed and empty — i.e., `None` is the drain-completion signal, not a "would block" signal. `pop` never blocks forever on a queue that has been closed: once `close` has been observed, a `pop` call that finds the queue empty returns `None` immediately rather than waiting.
- `close`: Marks the queue closed. Idempotent — calling it more than once, including from multiple threads concurrently, has no additional effect and never panics. Wakes all threads currently blocked in `push` or `pop` so they can observe the closed state and return per the rules above. `close` does not clear items already in the queue; a `pop` after `close` still drains any remaining items before returning `None`.
- `len`: Returns the number of items currently enqueued at the time of the call. Because other threads may concurrently push or pop, the returned value can be stale immediately after the call returns; it must not be used as a precondition for deciding whether a subsequent `push` or `pop` will block.
- Concurrency/ownership: `BoundedQueue<T>` is `Send + Sync` whenever `T: Send` (it does not require `T: Sync`, since at most one thread accesses a given item at a time via the internal mutex). It is not `Clone`; callers who need to share one queue across threads are expected to wrap it in an `Arc`. Dropping a `BoundedQueue` while other threads are still blocked inside `push`/`pop` on it is a caller bug (those threads hold a reference — via `Arc` — that keeps the value alive, so this is only reachable if the queue is used without `Arc` and a thread is holding a raw borrow, which will not compile; there is no runtime "use after drop" hazard, only the logical hazard of orphaned blocked threads if the last handle's owner never calls `close`).

## Deliverable

Write the missing Rust doc comments (`///`) for `BoundedQueue::new`, `BoundedQueue::push`, `BoundedQueue::pop`, `BoundedQueue::close`, `BoundedQueue::len`, and the `PushError<T>` enum (including its `Closed` variant), as they would appear directly above each item in the source file. Follow standard Rust documentation conventions (a summary line, expanded explanation, `# Panics`, `# Errors`, and `# Examples` sections where applicable). The documentation must accurately and completely reflect the contract above, including the blocking behavior, the closed-queue semantics, panics, and the ownership/concurrency guarantees — do not add behavior that was not described, and do not omit any of the caveats above.
