A team is adding end-to-end encryption to a messaging feature so the server cannot read message contents. They are not cryptographers and want to use existing, well-vetted building blocks correctly rather than invent a protocol. Their draft design:

- Each user generates a long-term key pair on their device; the public key is uploaded to the server.
- To message someone, the sender fetches the recipient's public key from the server and encrypts each message directly to it.
- Group chats encrypt each message separately to every member's public key.
- Key backup: the private key is encrypted with the user's login password and stored on the server so users can restore on a new device.

Review this E2EE design at the protocol/architecture level. Address: what security properties E2EE should provide here (confidentiality against the server, integrity/authenticity, and ideally forward secrecy and post-compromise security) and where the draft falls short; the risks in server-mediated public-key distribution (and how identity/keys are verified to defeat a malicious server substituting keys); group-messaging key management; and the key-backup scheme's trade-offs. Recommend a direction using established primitives/protocols by name, justify the properties it provides, and be explicit about the residual trust in the server and the usability trade-offs. Do not design new cryptographic primitives.
