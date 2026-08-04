## Context

You are reviewing `OrderService`, a class in a mid-sized e-commerce backend (TypeScript, Node.js, running behind an internal RPC layer). It was originally a small "place an order" helper and has grown organically over two years as new requirements (bulk discounts, tax jurisdictions, backorder handling, order-confirmation emails) were bolted on. It is now the single largest class in the codebase, is imported from a dozen call sites, and has become the main source of merge conflicts and regressions: a change to tax logic recently broke inventory reservation because both live inside the same method and share local variables.

There is no test suite for this class beyond a handful of stale integration tests that mock the entire database layer, which makes changes risky to validate. Product and engineering want to invest in restructuring it before adding two more features that are already queued up (per-customer promotional pricing, and a second notification channel for SMS).

Here is the current implementation, trimmed to its essential behavior:

```typescript
import { Pool } from "pg";
import { sendEmail } from "../email/client";
import { getTaxRateForRegion } from "../tax/rates";

interface OrderLineInput {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

interface PlaceOrderInput {
  customerId: string;
  region: string;
  email: string;
  lines: OrderLineInput[];
  couponCode?: string;
}

interface PlaceOrderResult {
  orderId: string;
  totalCents: number;
  backorderedSkus: string[];
}

export class OrderService {
  private db: Pool;
  private lastAppliedDiscountCents = 0;

  constructor(db: Pool) {
    this.db = db;
  }

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    if (!input.customerId || input.customerId.trim() === "") {
      throw new Error("customerId is required");
    }
    if (!input.email || !input.email.includes("@")) {
      throw new Error("a valid email is required");
    }
    if (!input.lines || input.lines.length === 0) {
      throw new Error("order must contain at least one line item");
    }
    for (const line of input.lines) {
      if (line.quantity <= 0) {
        throw new Error(`invalid quantity for sku ${line.sku}`);
      }
      if (line.unitPriceCents < 0) {
        throw new Error(`invalid unit price for sku ${line.sku}`);
      }
    }

    const client = await this.db.connect();
    const backorderedSkus: string[] = [];
    try {
      await client.query("BEGIN");

      let subtotalCents = 0;
      for (const line of input.lines) {
        subtotalCents += line.unitPriceCents * line.quantity;

        const stockRes = await client.query(
          "SELECT quantity_available FROM inventory WHERE sku = $1 FOR UPDATE",
          [line.sku]
        );
        const available = stockRes.rows[0]?.quantity_available ?? 0;
        if (available < line.quantity) {
          backorderedSkus.push(line.sku);
          await client.query(
            "UPDATE inventory SET quantity_available = 0, on_backorder = true WHERE sku = $1",
            [line.sku]
          );
        } else {
          await client.query(
            "UPDATE inventory SET quantity_available = quantity_available - $1 WHERE sku = $2",
            [line.quantity, line.sku]
          );
        }
      }

      this.lastAppliedDiscountCents = 0;
      if (input.couponCode) {
        if (input.couponCode === "SAVE10") {
          this.lastAppliedDiscountCents = Math.round(subtotalCents * 0.1);
        } else if (input.couponCode === "SAVE20") {
          this.lastAppliedDiscountCents = Math.round(subtotalCents * 0.2);
        } else {
          const couponRes = await client.query(
            "SELECT percent_off, active FROM coupons WHERE code = $1",
            [input.couponCode]
          );
          const coupon = couponRes.rows[0];
          if (coupon && coupon.active) {
            this.lastAppliedDiscountCents = Math.round(
              subtotalCents * (coupon.percent_off / 100)
            );
          }
        }
      }
      if (subtotalCents >= 10000 && this.lastAppliedDiscountCents === 0) {
        // bulk order discount, stacks only when no coupon was applied
        this.lastAppliedDiscountCents = Math.round(subtotalCents * 0.05);
      }

      const discountedSubtotalCents = subtotalCents - this.lastAppliedDiscountCents;
      const taxRate = await getTaxRateForRegion(input.region);
      const taxCents = Math.round(discountedSubtotalCents * taxRate);
      const totalCents = discountedSubtotalCents + taxCents;

      const orderRes = await client.query(
        `INSERT INTO orders (customer_id, region, subtotal_cents, discount_cents, tax_cents, total_cents, has_backorder)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          input.customerId,
          input.region,
          subtotalCents,
          this.lastAppliedDiscountCents,
          taxCents,
          totalCents,
          backorderedSkus.length > 0,
        ]
      );
      const orderId = orderRes.rows[0].id;

      for (const line of input.lines) {
        await client.query(
          "INSERT INTO order_lines (order_id, sku, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)",
          [orderId, line.sku, line.quantity, line.unitPriceCents]
        );
      }

      await client.query("COMMIT");

      try {
        if (backorderedSkus.length > 0) {
          await sendEmail(input.email, "order-partially-backordered", {
            orderId,
            totalCents,
            backorderedSkus,
          });
        } else {
          await sendEmail(input.email, "order-confirmation", {
            orderId,
            totalCents,
          });
        }
      } catch (emailErr) {
        // Email failures should never fail the order; log and move on.
        console.error("failed to send order email", emailErr);
      }

      return { orderId, totalCents, backorderedSkus };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
```

Assume `getTaxRateForRegion` and `sendEmail` are stable, already-tested external modules whose signatures should not change. Assume `db` is a `pg.Pool` and the schema (`orders`, `order_lines`, `inventory`, `coupons`) is fixed and should not change. Assume `placeOrder` is called from several RPC handlers and its external signature (`PlaceOrderInput` in, `PlaceOrderResult` out) must remain compatible so existing callers keep working.

## Deliverable

Propose a decomposition of `OrderService` into a set of cohesive units (classes, functions, or modules — your choice) with clearly defined responsibilities and dependency boundaries. Your answer should:

1. Identify the distinct responsibilities currently tangled together in `placeOrder` and explain, specifically, why the current structure makes the codebase risky to change (point to concrete coupling in the code, not generic complaints).
2. Propose a target decomposition: what units you would introduce, what each one owns, what it depends on, and how they compose to reproduce the exact same observable behavior (same validation errors, same discount rules and precedence, same backorder handling, same transactional guarantees, same "email failures never fail the order" behavior).
3. Justify the seams you chose over plausible alternatives — explain the trade-offs (testability, coupling, transaction/consistency boundaries, how much of the SQL/transaction concerns should be hidden from the pricing and validation logic, and how this decomposition affects the ease of adding the two queued features).
4. Provide refactored code for the core of your decomposition (it does not need to reproduce every file in full, but the primary units and how `placeOrder`'s orchestration reads afterward should be concrete enough to evaluate, not just described in prose).

Be explicit about any behavior you preserve exactly versus any minor behavior you believe is safe to change and why (if any); do not silently change discount precedence, rounding, transaction scope, or error semantics.
