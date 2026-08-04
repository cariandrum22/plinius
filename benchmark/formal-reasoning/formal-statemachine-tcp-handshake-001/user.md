# Analyze a Simplified TCP Connection State Machine

Consider a simplified connection-setup state machine for one endpoint (a
subset of TCP), driven by application calls and received segments:

```
States: CLOSED, LISTEN, SYN_SENT, SYN_RCVD, ESTABLISHED
Transitions (event -> ):
  CLOSED   --app: connect / send SYN-->        SYN_SENT
  CLOSED   --app: listen-->                     LISTEN
  LISTEN   --recv SYN / send SYN+ACK-->         SYN_RCVD
  SYN_SENT --recv SYN+ACK / send ACK-->         ESTABLISHED
  SYN_SENT --recv SYN / send ACK-->             SYN_RCVD      (simultaneous open)
  SYN_RCVD --recv ACK-->                        ESTABLISHED
```

Your task is to reason precisely about this machine.

Please produce:

1. A statement of which states are **reachable** from CLOSED, and a **safety
   property** you would want to hold -- for example, "the endpoint only enters
   ESTABLISHED after evidence that the peer has agreed." State the property
   precisely in terms of the transition history that must precede ESTABLISHED.

2. An analysis of the **simultaneous-open** path (`SYN_SENT --recv SYN-->
   SYN_RCVD`): argue whether two endpoints that both actively connect can each
   still reach ESTABLISHED, and whether any interleaving leaves one endpoint
   stuck (no enabled transition) while the other is ESTABLISHED.

3. An identification of at least one **liveness concern** or missing transition:
   for instance, what happens on segment loss (no matching `recv` event fires),
   and what additional mechanism (not shown) the real protocol needs to avoid
   getting stuck. Distinguish the safety claim from the liveness gap.

State your assumptions about the channel (loss, reordering, duplication).
