# Reason About Two-Phase Commit Safety and Blocking

Two-phase commit (2PC) coordinates an atomic decision across participants:

```
Phase 1 (prepare):
  Coordinator sends PREPARE to all participants.
  Each participant replies YES (and durably logs a prepared/ready record,
  promising it can commit) or NO.
Phase 2 (decide):
  If all replied YES, coordinator durably logs COMMIT and sends COMMIT to all.
  If any replied NO (or timed out), coordinator logs ABORT and sends ABORT.
  Participants apply the decision and acknowledge.
```

Your task is to reason precisely about what 2PC does and does not guarantee.

Please produce:

1. A precise statement of the **atomicity safety property** 2PC provides:
   informally "all participants reach the same decision (all commit or all
   abort)". State it as an invariant over participant decision states, and
   identify the single point at which the outcome becomes irrevocable (the
   commit point).

2. An argument that **no two participants decide differently**, reasoning about
   the ordering of the coordinator's durable COMMIT/ABORT log record relative to
   the messages sent. Address a participant that voted YES and then crashes: on
   recovery, how does it learn the decision, and why can it not unilaterally
   abort after voting YES?

3. An analysis of the well-known **blocking** problem: exhibit a failure scenario
   (which process crashes, at what point) in which surviving participants that
   voted YES cannot safely decide on their own and must wait. Explain precisely
   why they are stuck -- what they do not know -- and distinguish this liveness
   failure from any safety violation (there should be none).

State your assumptions about crashes, message loss, and durable logging.
