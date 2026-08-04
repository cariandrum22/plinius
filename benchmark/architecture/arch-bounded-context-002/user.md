# Context

**Aegis Insurance** is building a new platform to replace a patchwork of legacy
systems. The domain spans: quoting, underwriting, policy issuance and
administration, billing and payments, claims intake and adjudication,
reinsurance, fraud detection, and regulatory reporting. Different departments
use the same words to mean different things -- a "policy" to underwriting means a
risk assessment in progress, to billing it means a payment schedule, and to
claims it means the coverage terms in force at the time of loss. A "customer"
means a prospect to sales, an insured party to claims, and a payer to billing.

The engineering leadership has read about Domain-Driven Design and wants a
context map before any code is written.

# Your task

1. Propose a set of **bounded contexts** for this domain. For each, state the
   language and core concepts that are consistent *inside* it.
2. Draw or describe a **context map**: how the contexts relate (upstream/
   downstream, shared kernel, customer/supplier, anticorruption layer,
   conformist, etc.), and where translation between models must happen.
3. Show explicitly how the *same term* ("policy", "customer") is modeled
   differently across contexts, and how you avoid a single bloated shared model.
4. Recommend which contexts should be developed by dedicated teams and which
   integration style (synchronous, asynchronous, batch) fits each relationship,
   with justification.
5. Discuss the strongest objection to your context boundaries and how you would
   respond to it.

Multiple valid context maps exist; the quality is in the reasoning.
