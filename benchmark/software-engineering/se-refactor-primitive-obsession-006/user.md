## Context

You are reviewing `BillingService`, a Java class in a payments backend that applies discounts, charges late fees, and transfers funds between merchant and customer accounts. It is called from several internal gRPC handlers. Over the past year there have been three separate incidents where the wrong value was passed into one of these methods at a call site — two `String` arguments were transposed (an `accountId` and a `merchantId`), a percentage was passed as a raw fraction (`0.1`) into a parameter that expected whole-percent units (`10`), and once, `amountMinorUnits` for a fee was accidentally populated from a variable holding a different currency's amount without a corresponding currency check. None of these were caught by the compiler; all were caught late, in QA or production, because every one of these values is represented as a bare `long`, `double`, or `String`. The team has decided the method signatures themselves are the problem and wants to make the same class of mistake impossible (or at least much harder) to make again, without changing what the service actually does for valid inputs.

Here is the class as it exists today, trimmed to the methods and validation relevant to this problem:

```java
package com.example.billing;

import java.math.BigDecimal;
import java.util.Objects;
import java.util.Set;

public class BillingService {

    private static final Set<String> SUPPORTED_CURRENCIES = Set.of("USD", "EUR", "GBP", "JPY");

    private final LedgerClient ledgerClient;

    public BillingService(LedgerClient ledgerClient) {
        this.ledgerClient = ledgerClient;
    }

    /**
     * Applies a percentage discount to an invoice and records the adjustment on the
     * merchant's ledger.
     *
     * @param accountId          the paying customer's account id
     * @param merchantId          the merchant account receiving payment
     * @param invoiceId          the invoice being discounted
     * @param amountMinorUnits   the invoice's original amount, in the currency's minor units (e.g. cents)
     * @param currency           ISO 4217 currency code, e.g. "USD"
     * @param discountPercentage whole-percent discount to apply, e.g. 10.0 for 10%
     */
    public void applyDiscount(String accountId,
                               String merchantId,
                               String invoiceId,
                               long amountMinorUnits,
                               String currency,
                               double discountPercentage) {
        validateId(accountId, "accountId");
        validateId(merchantId, "merchantId");
        validateId(invoiceId, "invoiceId");
        validateCurrency(currency);
        validateAmount(amountMinorUnits);
        validatePercentage(discountPercentage);

        long discountMinorUnits = computeShare(amountMinorUnits, discountPercentage);
        long netAmountMinorUnits = amountMinorUnits - discountMinorUnits;

        ledgerClient.recordAdjustment(accountId, merchantId, invoiceId,
                netAmountMinorUnits, currency, "DISCOUNT");
    }

    /**
     * Charges a late fee on an overdue invoice.
     *
     * @param accountId            the customer's account id
     * @param invoiceId            the overdue invoice
     * @param amountMinorUnits     the invoice's outstanding amount, in the currency's minor units
     * @param currency             ISO 4217 currency code
     * @param lateFeePercentage    whole-percent late fee to charge, e.g. 1.5 for 1.5%
     */
    public void chargeLateFee(String accountId,
                               String invoiceId,
                               long amountMinorUnits,
                               String currency,
                               double lateFeePercentage) {
        validateId(accountId, "accountId");
        validateId(invoiceId, "invoiceId");
        validateCurrency(currency);
        validateAmount(amountMinorUnits);
        validatePercentage(lateFeePercentage);

        long feeMinorUnits = computeShare(amountMinorUnits, lateFeePercentage);

        ledgerClient.recordAdjustment(accountId, invoiceId,
                feeMinorUnits, currency, "LATE_FEE");
    }

    /**
     * Transfers funds between two accounts in the same currency.
     *
     * @param fromAccountId     the paying account
     * @param toAccountId       the receiving account
     * @param amountMinorUnits  amount to transfer, in the currency's minor units
     * @param currency          ISO 4217 currency code; must match on both accounts
     */
    public void transferFunds(String fromAccountId,
                               String toAccountId,
                               long amountMinorUnits,
                               String currency) {
        validateId(fromAccountId, "fromAccountId");
        validateId(toAccountId, "toAccountId");
        validateCurrency(currency);
        validateAmount(amountMinorUnits);

        ledgerClient.transfer(fromAccountId, toAccountId, amountMinorUnits, currency);
    }

    private long computeShare(long amountMinorUnits, double wholePercent) {
        BigDecimal amount = BigDecimal.valueOf(amountMinorUnits);
        BigDecimal fraction = BigDecimal.valueOf(wholePercent).divide(BigDecimal.valueOf(100));
        return amount.multiply(fraction).longValue();
    }

    private void validateId(String id, String fieldName) {
        if (id == null || id.isBlank()) {
            throw new IllegalArgumentException(fieldName + " must not be blank");
        }
    }

    private void validateCurrency(String currency) {
        if (currency == null || !SUPPORTED_CURRENCIES.contains(currency)) {
            throw new IllegalArgumentException("unsupported or missing currency: " + currency);
        }
    }

    private void validateAmount(long amountMinorUnits) {
        if (amountMinorUnits < 0) {
            throw new IllegalArgumentException("amountMinorUnits must not be negative");
        }
    }

    private void validatePercentage(double percentage) {
        if (percentage < 0.0 || percentage > 100.0) {
            throw new IllegalArgumentException("percentage must be between 0 and 100");
        }
    }
}
```

Assume `LedgerClient` is a stable, already-tested external interface with the two overloads of `recordAdjustment` implied above (one taking a counterparty merchant id for discount adjustments, one without it for late fees) plus `transfer(String, String, long, String)`, and that its own signatures should not change, though you may introduce adapter/mapping code at the boundary if your new types need to be converted back to primitives to call it. Assume `BillingService`'s methods are called from several gRPC handler classes elsewhere in the codebase that currently pass in raw `String`, `long`, and `double` values extracted from protobuf messages.

## Deliverable

Propose a refactoring of `BillingService`'s public API toward stronger types (value objects) that make the three incident classes described above significantly harder to reproduce, while preserving all current validation behavior and business logic for valid inputs. Your answer should:

1. For each incident class (id transposition, percentage unit confusion, cross-currency amount mixing), explain precisely what type-level change would have prevented or caught it, and why a stronger type is a better fix than "just add a comment" or "just add a runtime check" alone.
2. Propose the concrete value objects/types you would introduce (e.g., for account identifiers, money amounts, currency, and percentages), including what invariants each type enforces at construction and what operations (if any) you'd expose on them.
3. Show the refactored `BillingService` (or the relevant methods) using your new types, including how validation moves from ad hoc runtime checks scattered through each method toward validation encoded in the types themselves, and how this interacts with the boundary to `LedgerClient` and to callers still working with raw protobuf-derived primitives.
4. Discuss the migration trade-offs honestly: what this costs in boilerplate, call-site churn, and serialization/boundary friction, versus what class of bugs it actually eliminates versus merely makes less likely. Be explicit about which of the three incidents your design would make a compile-time error, and which (if any) it would still only catch at runtime.
