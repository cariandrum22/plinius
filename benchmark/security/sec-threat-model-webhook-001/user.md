Your platform exposes an inbound webhook endpoint that external partners and third-party services call to notify you of events (for example payment or delivery updates). These events drive state changes in your system (marking orders paid, triggering fulfillment). You are asked to threat-model the webhook receiver.

Context:
- The endpoint is public on the internet and receives POSTs with JSON bodies.
- Some senders support signing webhooks with a shared secret; some do not.
- Handlers update databases and call internal services; some events fan out to other workers.
- The team wants events processed reliably and exactly once where possible.

Threat-model this webhook receiver. Identify assets, trust boundaries, and adversaries, then enumerate the realistic threats using a systematic method, covering at least: forged or spoofed events, replay of captured events, tampering with event contents, sender authentication when signing is and is not available, request-handling abuse (oversized payloads, slowloris-style abuse, SSRF via URLs embedded in events), idempotency and out-of-order/duplicate delivery, and the blast radius of a handler that trusts event data too much. For each significant threat give a concrete scenario and a proportionate mitigation, and take a position on how to handle senders that cannot sign. Prioritize by realistic risk.
