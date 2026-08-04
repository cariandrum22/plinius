## Intent
Probes correct application of envelope encryption with a KMS: key hierarchy, authenticated encryption, IV management at scale, rotation, and crypto-shredding.

## Assumptions
A cloud environment with a KMS whose per-operation cost motivates data-key envelope encryption; recognized guidance (NIST SP 800-57, SP 800-38D) applies. The searchable-field requirement forces an explicit trade-off.

## Reviewer notes
A strong answer uses envelope encryption with wrapped data keys, chooses authenticated encryption and manages IVs safely at volume, scopes keys to enable crypto-shredding and limit blast radius, and designs rotation without a global re-encryption. It handles the searchable field as a deliberate, contained trade-off. A weak answer encrypts everything under one key, ignores IV reuse risk, uses an unauthenticated mode, or breaks security to make fields searchable.
