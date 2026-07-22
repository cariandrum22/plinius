# Why Unbounded Queues Cause Tail-Latency Collapse

## Facts

For a work-conserving single-server queue, utilization is `rho = lambda / mu`,
where `lambda` is the arrival rate and `mu` the service rate. Throughput is
bounded by `mu`; a system can be fully utilized (`rho` near 1) while its
throughput is merely `mu`, unchanged. Utilization, throughput, and queue
occupancy are three distinct quantities.

Little's Law states `L = lambda * W`: mean occupancy equals arrival rate times
mean time in system. For an M/M/1 queue, mean waiting time grows as
`W ~ 1 / (mu - lambda)`, which diverges as `lambda -> mu` (`rho -> 1`). Waiting
time is superlinear in `rho`: the second half of the utilization range
contributes far more latency than the first.

When `lambda > mu` even briefly, an unbounded queue accumulates backlog at rate
`lambda - mu`. That backlog does not self-correct while the overload persists;
queued requests are served in order but each waits behind the entire accumulated
backlog. Time in system is dominated by queueing delay, not service time, so the
tail (p99, p99.9) collapses while mean throughput at the server stays at `mu`
and looks healthy.

Queued work also ages. By the time a long-delayed request is served, the client
may have already timed out, making the completed work useless (goodput below
throughput).

## Assumptions

This explanation assumes a roughly FIFO queue with no per-request deadline
enforcement, so old and new requests are served in arrival order. It assumes
arrivals are bursty rather than perfectly smooth, so transient `lambda > mu`
episodes occur even when long-run mean load is below capacity. It assumes
service times have non-trivial variance; deterministic service reduces, though
does not eliminate, the effect. It assumes clients retry on timeout, which lifts
effective `lambda` precisely when the system is already saturated. It assumes
`mu` is fixed and does not degrade further under load (no thrashing feedback).

## Hypotheses

I hypothesize that the dominant cause of tail collapse is head-of-line aging:
bounding the queue and shedding excess load will restore the tail with only a
modest drop in successful throughput, because most shed requests would have
timed out anyway. This predicts that goodput under a bounded queue meets or
exceeds goodput under an unbounded queue during overload.

I further hypothesize that client retries dominate the runaway: disabling or
exponentially backing off retries will flatten the tail more than any
server-side buffering change. This is falsifiable by A/B testing retry policy
while holding queue size fixed.

## Trade-offs

A bounded queue with load-shedding caps waiting time by rejecting arrivals once
occupancy exceeds a threshold; it sacrifices some requests immediately and
requires clients to handle explicit rejection, but it keeps the tail bounded and
preserves goodput. Prefer it when fast failure is acceptable and clients can
degrade gracefully.

Admission control (rate limiting at the edge) prevents overload before it
reaches the queue; it sacrifices peak burst absorption and needs an accurate
capacity estimate, which is hard when `mu` varies. Prefer it when overload is
predictable and coordinated across clients.

Deadline-aware or LIFO scheduling drops stale work first, protecting the tail of
requests that can still complete usefully; it sacrifices FIFO fairness and can
starve old requests. Prefer it when request value decays sharply with age.

More buffering is the one non-solution: it raises `L` and `W` without raising
`mu`, deferring rejection into silent timeouts and making the tail worse.
