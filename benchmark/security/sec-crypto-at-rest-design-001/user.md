A team must encrypt a large volume of sensitive customer records (documents and structured fields) stored in a cloud object store and a database. They currently have "a single AES key in an environment variable that we AES-encrypt everything with". You are asked to design proper encryption at rest with a cloud KMS available.

Requirements and context:
- Millions of objects; some fields must be searchable by exact match; most are opaque blobs.
- A cloud KMS is available (can generate and wrap keys and perform crypto operations, but per-operation calls to it are relatively slow and rate-limited).
- The business needs the ability to rotate keys, to cryptographically "delete" a customer's data, and to limit the blast radius of any single key compromise.

Design the encryption-at-rest scheme. Address: key hierarchy (for example envelope encryption with data keys wrapped by KMS keys) and why; which algorithm and mode to use and how integrity is ensured; nonce/IV management at scale; how per-tenant or per-record key scoping supports crypto-shredding and blast-radius limits; and how rotation works without re-encrypting everything at once. Address the "searchable exact-match field" requirement without breaking the security of the rest. Justify choices against recognized key-management guidance and be explicit about trade-offs.
