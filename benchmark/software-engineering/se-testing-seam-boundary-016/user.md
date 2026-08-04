## Context

Your team owns a checkout service. One of its classes decides whether a customer's order qualifies for a promotion, by calling an internal pricing API to look up the promotion's rules and then applying those rules to the order. It currently has no automated tests at all: the previous author noted in a code comment that "this needs a real server running to test," and new changes to the discount logic are routinely verified only by manual QA against a staging environment, which is slow and has already missed at least one rounding bug that reached production.

Here is the class as it exists today, including its supporting types:

```java
public class PromotionEligibilityService {

    private static final String API_BASE_URL = "https://pricing.internal.example.com";

    public PromotionDecision evaluate(String promoCode, BigDecimal orderTotal) {
        LocalDate today = LocalDate.now();

        Promotion promo = fetchPromotion(promoCode);
        if (promo == null) {
            return PromotionDecision.rejected("Unknown promo code");
        }

        if (today.isBefore(promo.getStartDate()) || today.isAfter(promo.getEndDate())) {
            return PromotionDecision.rejected("Promotion is not currently active");
        }

        if (orderTotal.compareTo(promo.getMinimumOrderTotal()) < 0) {
            return PromotionDecision.rejected("Order total below promotion minimum");
        }

        BigDecimal discount = orderTotal
                .multiply(promo.getDiscountPercentage())
                .setScale(2, RoundingMode.HALF_UP);

        return PromotionDecision.approved(discount);
    }

    private Promotion fetchPromotion(String promoCode) {
        try {
            String apiKey = System.getenv("PRICING_API_KEY");
            HttpClient client = HttpClient.newHttpClient();
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(API_BASE_URL + "/promotions/" + promoCode))
                    .header("Authorization", "Bearer " + apiKey)
                    .GET()
                    .build();

            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                return null;
            }
            return Promotion.fromJson(response.body());
        } catch (IOException | InterruptedException e) {
            throw new PromotionServiceException("Failed to fetch promotion " + promoCode, e);
        }
    }
}
```

```java
public class Promotion {
    private final String code;
    private final LocalDate startDate;
    private final LocalDate endDate;
    private final BigDecimal minimumOrderTotal;
    private final BigDecimal discountPercentage; // e.g. 0.15 for 15%

    // constructor and getters omitted for brevity

    public static Promotion fromJson(String json) {
        // parses the pricing API's JSON response into a Promotion
        // (implementation omitted; assume it is correct and already tested)
    }

    public LocalDate getStartDate() { return startDate; }
    public LocalDate getEndDate() { return endDate; }
    public BigDecimal getMinimumOrderTotal() { return minimumOrderTotal; }
    public BigDecimal getDiscountPercentage() { return discountPercentage; }
}
```

```java
public class PromotionDecision {
    private final boolean approved;
    private final String reason;
    private final BigDecimal discount;

    public static PromotionDecision approved(BigDecimal discount) {
        return new PromotionDecision(true, null, discount);
    }

    public static PromotionDecision rejected(String reason) {
        return new PromotionDecision(false, reason, null);
    }

    // constructor and getters omitted for brevity
}
```

```java
public class PromotionServiceException extends RuntimeException {
    public PromotionServiceException(String message, Throwable cause) {
        super(message, cause);
    }
}
```

The business rules the team cares most about getting right are: a promotion is only valid within its date window (inclusive), the order must meet the promotion's minimum total, the discount amount must be rounded correctly, an unknown promo code is rejected with a clear reason, and a failure to reach the pricing API should not crash the checkout flow silently or produce an incorrect approval.

## Deliverable

Provide:

1. A specific explanation of what makes `PromotionEligibilityService` difficult to unit test as written, tying each difficulty to the exact line(s) of code responsible for it.
2. A revised design that introduces a testing seam (or seams) so the business rules above can be exercised with fast, deterministic unit tests, with no real network call, real environment variable, or dependence on today's actual calendar date. Show the resulting class structure (interfaces, constructor signatures, or other changes) precisely enough to implement.
3. A focused set of unit tests for the business logic — you may describe each test as a clear scenario (setup, action, expected outcome) rather than full Java source — covering at minimum the date-window boundaries, the minimum-order-total boundary, discount rounding, an unknown promo code, and a failure to fetch the promotion.
4. A brief justification of where you chose to place the seam (i.e., which collaborator or boundary you abstracted) and why that choice is preferable to the alternatives you considered.
