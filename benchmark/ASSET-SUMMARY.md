# Benchmark Asset Summary

First production benchmark asset library for Plinius. 100 benchmarks across four
categories (25 each), authored for the framework at `benchmark/<category>/<id>/`.
Golden benchmarks (★) are held stable across releases for longitudinal comparison.

| Category | Benchmarks | Golden | easy/medium/hard/expert |
|---|---|---|---|
| software-engineering | 25 | 5 | 3/8/9/5 |
| architecture | 25 | 5 | 3/8/9/5 |
| security | 25 | 5 | 3/8/9/5 |
| formal-reasoning | 25 | 5 | 3/8/9/5 |
| **Total** | **100** | **20** | **12/32/36/20** |

## Golden selection (20)

**software-engineering** — `se-api-pagination-contract-007`, `se-concurrency-atomic-stats-012`, `se-debug-goroutine-leak-001`, `se-perf-n-plus-one-023`, `se-refactor-god-object-004`

**architecture** — `arch-consistency-tradeoff-003`, `arch-distributed-tracing-001`, `arch-event-ordering-001`, `arch-exactly-once-003`, `arch-strangler-fig-001`

**security** — `sec-crypto-jwt-alg-review-001`, `sec-idor-review-001`, `sec-oauth-pkce-review-001`, `sec-oidc-id-token-validation-001`, `sec-password-storage-review-001`

**formal-reasoning** — `formal-correctness-lru-cache-002`, `formal-invariant-ring-buffer-002`, `formal-protocol-two-phase-commit-001`, `formal-spec-idempotent-api-003`, `formal-typesystem-linear-resource-003`

## software-engineering

| ID | Difficulty | Golden | Title |
|---|---|---|---|
| se-api-error-model-009 | medium |  | Design a Coherent Machine-Readable Error Model for a REST API |
| se-api-idempotency-008 | hard |  | Design Idempotency-Key Semantics for a Charge Creation Endpoint |
| se-api-pagination-contract-007 | hard | ★ | Design a Stable Pagination and Filtering Contract for a Transactions Endpoint |
| se-concurrency-async-cancellation-013 | hard |  | Fix task leaks and swallowed errors in an asyncio fan-out coordinator with a deadline |
| se-concurrency-atomic-stats-012 | medium | ★ | Diagnose and fix a data race in a concurrent request metrics collector |
| se-concurrency-lock-ordering-010 | expert |  | Diagnose a cross-subsystem deadlock caused by inconsistent lock acquisition order |
| se-concurrency-worker-pool-011 | hard |  | Redesign a worker pool for correct backpressure and graceful shutdown |
| se-debug-float-accumulation-003 | easy |  | Diagnose a one-cent invoice total mismatch caused by floating-point summation |
| se-debug-goroutine-leak-001 | hard | ★ | Diagnose a goroutine leak in a fan-out aggregation handler |
| se-debug-pagination-drift-002 | medium |  | Explain and fix record drift in offset-based pagination under concurrent writes |
| se-deps-lockfile-integrity-019 | expert |  | Audit a drifted lockfile for supply-chain integrity weaknesses |
| se-deps-semver-policy-018 | expert |  | Classify and plan a breaking API change for a widely-depended library |
| se-deps-transitive-conflict-017 | hard |  | Diagnose a duplicated transitive dependency causing instanceof failures |
| se-docs-adr-tradeoffs-021 | medium |  | ADR for an Idempotency-Key Storage Strategy in a Payments Service |
| se-docs-public-api-020 | easy |  | API Doc Comments for a Bounded Concurrent Queue |
| se-docs-runtime-migration-022 | hard |  | Major-Version Migration Guide for the octoq Background Job Library |
| se-perf-cache-invalidation-025 | expert |  | Design a caching and invalidation strategy to eliminate stampedes and stale reads |
| se-perf-hot-path-allocation-024 | expert |  | Reduce allocation pressure and GC-correlated tail latency in a Go request hot path |
| se-perf-n-plus-one-023 | medium | ★ | Diagnose and resolve an N+1 query pattern in an order-history endpoint |
| se-refactor-callback-pyramid-005 | medium |  | Convert a nested-callback order-fulfillment workflow to async/await |
| se-refactor-god-object-004 | hard | ★ | Decompose a tangled OrderService god class into cohesive units |
| se-refactor-primitive-obsession-006 | medium |  | Replace primitive-obsessed parameters in a billing service with value objects |
| se-testing-flaky-clock-014 | medium |  | Redesign a flaky time-dependent test suite for deterministic execution |
| se-testing-property-invariants-015 | hard |  | Design property-based tests for a proportional money allocation function |
| se-testing-seam-boundary-016 | easy |  | Introduce a testing seam into a promotion eligibility service |

## architecture

| ID | Difficulty | Golden | Title |
|---|---|---|---|
| arch-api-versioning-002 | medium |  | API Versioning and Backward-Compatibility Strategy |
| arch-bounded-context-002 | hard |  | Identify Bounded Contexts for an Insurance Platform |
| arch-build-vs-buy-002 | easy |  | Build vs Buy for a Product Search Subsystem |
| arch-consistency-tradeoff-003 | hard | ★ | Consistency vs Availability for a Seat-Booking System |
| arch-cost-optimization-003 | hard |  | Cost-Aware Architecture for a Variable Workload |
| arch-decompose-monolith-001 | medium |  | Decompose a Monolithic Order-Management System |
| arch-distributed-lock-002 | expert |  | Coordination for a Leader-Based Job Scheduler |
| arch-distributed-tracing-001 | medium | ★ | Observability for a Microservices Platform |
| arch-event-ordering-001 | hard | ★ | Guarantee Event Ordering in a Payments Pipeline |
| arch-event-schema-evolution-003 | medium |  | Event Schema Evolution Strategy |
| arch-exactly-once-003 | hard | ★ | Exactly-Once Effects in a Stream-Processing Pipeline |
| arch-hot-partition-004 | expert |  | Mitigate Hot Partitions in a Multi-Tenant Key-Value Store |
| arch-idempotency-001 | medium |  | Idempotent Payment Processing Across Retries |
| arch-incident-observability-003 | expert |  | Observability to Diagnose Intermittent Cross-Service Latency |
| arch-modular-monolith-003 | easy |  | Define Module Boundaries for a SaaS Billing App |
| arch-multi-region-001 | hard |  | Active-Active Multi-Region Deployment |
| arch-rate-limiter-003 | expert |  | Design a Distributed Rate Limiter |
| arch-read-scaling-001 | medium |  | Scale a Read-Heavy Social Activity Feed |
| arch-saga-orchestration-002 | hard |  | Design a Saga for a Multi-Service Order Workflow |
| arch-serverless-tradeoff-002 | medium |  | Serverless vs Containers for a Bursty Workload |
| arch-slo-design-002 | expert |  | Define SLOs, SLIs, and Error Budgets for a Platform |
| arch-strangler-fig-001 | hard | ★ | Incrementally Replace a Legacy Core System |
| arch-sync-vs-async-001 | medium |  | Synchronous vs Asynchronous Integration for Checkout and Fulfillment |
| arch-tech-debt-003 | easy |  | Refactoring Plan for a Tangled Service |
| arch-write-scaling-002 | hard |  | Scale Write-Heavy Telemetry Ingestion |

## security

| ID | Difficulty | Golden | Title |
|---|---|---|---|
| sec-code-deserialization-review-001 | hard |  | Review Untrusted Deserialization and Data Parsing |
| sec-code-sql-injection-review-001 | easy |  | Review a Data-Access Layer for Injection |
| sec-code-ssrf-review-001 | hard |  | Review a URL-Fetching Service for SSRF |
| sec-crypto-at-rest-design-001 | medium |  | Design Envelope Encryption for Data at Rest |
| sec-crypto-e2ee-messaging-001 | expert |  | Review an End-to-End Encrypted Messaging Design |
| sec-crypto-jwt-alg-review-001 | hard | ★ | Review JWT Signing and Verification Choices |
| sec-crypto-password-reset-token-001 | medium |  | Review a Password-Reset Token Design |
| sec-idor-review-001 | medium | ★ | Review an API for Broken Object-Level Authorization |
| sec-mfa-enrollment-design-001 | hard |  | Design MFA Enrollment, Step-Up, and Account Recovery |
| sec-oauth-pkce-review-001 | medium | ★ | Review an OAuth 2.0 Public-Client Authorization-Code Flow |
| sec-oauth-scope-design-001 | hard |  | Design Scopes and Consent for a Third-Party API Platform |
| sec-oauth-token-storage-spa-001 | hard |  | Design Token Storage and Handling for a Single-Page App |
| sec-oidc-federation-broker-001 | expert |  | Design a Federated Identity Broker |
| sec-oidc-id-token-validation-001 | medium | ★ | Review ID Token Validation in a Relying Party |
| sec-oidc-session-logout-001 | hard |  | Design OIDC Session Management and Logout Across Apps |
| sec-password-storage-review-001 | easy | ★ | Review a Password Storage and Verification Implementation |
| sec-policy-engine-design-001 | expert |  | Design a Centralized Authorization Policy Engine |
| sec-rbac-vs-abac-design-001 | medium |  | Select and Design an Access-Control Model for a Multi-Tenant API |
| sec-secret-injection-k8s-001 | expert |  | Design Secret Delivery and Workload Identity in Kubernetes |
| sec-secret-leak-git-response-001 | easy |  | Respond to a Secret Committed to Git History |
| sec-secret-rotation-design-001 | hard |  | Design a Secret Rotation and Distribution Strategy |
| sec-session-management-hardening-001 | medium |  | Harden Session Cookie and Lifecycle for a Web App |
| sec-threat-model-ci-supply-chain-001 | expert |  | Threat Model a CI/CD Build and Release Pipeline |
| sec-threat-model-file-upload-001 | medium |  | Threat Model a User File-Upload and Processing Feature |
| sec-threat-model-webhook-001 | hard |  | Threat Model an Inbound Webhook Receiver |

## formal-reasoning

| ID | Difficulty | Golden | Title |
|---|---|---|---|
| formal-correctness-binary-search-001 | medium |  | Reason About Binary Search Loop Correctness and Termination |
| formal-correctness-dijkstra-004 | expert |  | Justify the Greedy Choice in Dijkstra's Algorithm |
| formal-correctness-lru-cache-002 | hard | ★ | Argue Correctness of LRU Cache Eviction |
| formal-correctness-memo-fib-003 | medium |  | Correctness of a Memoized Recursion |
| formal-invariant-bank-transfer-001 | easy |  | State and Defend the Conservation Invariant for Transfers |
| formal-invariant-ring-buffer-002 | medium | ★ | Prove a Ring-Buffer Index Invariant Is Inductive |
| formal-invariant-union-find-003 | hard |  | Argue the Rank Invariant of Union-Find Is Inductive |
| formal-logic-mutual-exclusion-001 | hard |  | Formalize Mutual Exclusion, Deadlock-Freedom, and Starvation-Freedom |
| formal-logic-quantifier-scope-003 | easy |  | Analyze Quantifier Order in a Specification |
| formal-logic-sat-encoding-002 | medium |  | Reason About a Boolean Encoding of an At-Most-One Constraint |
| formal-proofreview-gcd-termination-001 | medium |  | Review a Termination Proof Sketch for the Euclidean GCD |
| formal-proofreview-linearizable-counter-003 | expert |  | Review a Linearizability Proof Sketch for a Concurrent Counter |
| formal-proofreview-sort-stability-002 | hard |  | Find the Gap in a Merge-Sort Stability Proof Sketch |
| formal-protocol-leader-election-002 | expert |  | Analyze Safety of a Quorum-Based Leader Election |
| formal-protocol-two-phase-commit-001 | hard | ★ | Reason About Two-Phase Commit Safety and Blocking |
| formal-protocol-vector-clock-003 | hard |  | Reason About Vector Clocks and Causal Ordering |
| formal-spec-atomic-swap-001 | easy |  | Specify the Contract of an Atomic Compare-and-Swap |
| formal-spec-idempotent-api-003 | hard | ★ | Specify Idempotency for a Payment Submission API |
| formal-spec-rate-limiter-002 | medium |  | Specify a Token-Bucket Rate Limiter Precisely |
| formal-statemachine-circuit-breaker-003 | hard |  | Reason About a Circuit-Breaker State Machine |
| formal-statemachine-elevator-002 | medium |  | Reason About an Elevator Door Controller State Machine |
| formal-statemachine-tcp-handshake-001 | medium |  | Analyze a Simplified TCP Connection State Machine |
| formal-typesystem-linear-resource-003 | expert | ★ | Analyze a Linear Resource-Handling Type Rule |
| formal-typesystem-preservation-001 | hard |  | Review a Preservation Argument for a Small Expression Language |
| formal-typesystem-variance-002 | expert |  | Diagnose Variance Soundness for a Mutable Container |
