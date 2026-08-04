## Context

You are reviewing an order-fulfillment function in a Node.js/TypeScript backend. It coordinates several I/O steps against internal services (inventory, payments, shipping, notifications), two of which are independent and are run concurrently. The function predates the codebase's adoption of `async`/`await` and still uses classic Node-style `(err, result)` callbacks throughout, nested several levels deep. It works correctly in production today, but every recent change to it has introduced a regression (most recently, a double-invocation of the completion callback under a rare failure ordering), and the team wants it modernized before adding a new step.

Assume the following step functions are stable, already-tested externals with the exact signatures shown; you are not asked to reimplement them, only to call them correctly:

```typescript
interface Order {
  id: string;
  customerId: string;
  items: Array<{ sku: string; quantity: number }>;
  address: string;
  totalCents: number;
}

interface Customer {
  id: string;
  email: string;
  paymentMethodId: string;
}

interface InventoryCheckResult {
  allAvailable: boolean;
}

interface ShippingQuote {
  costCents: number;
  carrier: string;
}

interface Reservation {
  reservationId: string;
}

interface Charge {
  id: string;
}

interface Shipment {
  id: string;
  trackingNumber: string;
}

declare function fetchOrder(orderId: string, cb: (err: Error | null, order?: Order) => void): void;
declare function validateCustomer(customerId: string, cb: (err: Error | null, customer?: Customer) => void): void;
declare function checkInventory(items: Order["items"], cb: (err: Error | null, result?: InventoryCheckResult) => void): void;
declare function getShippingQuote(address: string, cb: (err: Error | null, quote?: ShippingQuote) => void): void;
declare function reserveInventory(items: Order["items"], cb: (err: Error | null, reservation?: Reservation) => void): void;
declare function releaseInventory(reservationId: string, cb: (err: Error | null) => void): void;
declare function chargePayment(paymentMethodId: string, amountCents: number, cb: (err: Error | null, charge?: Charge) => void): void;
declare function createShipment(orderId: string, reservationId: string, quote: ShippingQuote, cb: (err: Error | null, shipment?: Shipment) => void): void;
declare function notifyCustomer(email: string, orderId: string, shipment: Shipment, cb: (err: Error | null) => void): void;
```

Here is the function as it exists today:

```typescript
interface FulfillmentResult {
  orderId: string;
  shipmentId: string;
  chargeId: string;
}

function fulfillOrder(
  orderId: string,
  callback: (err: Error | null, result?: FulfillmentResult) => void
): void {
  fetchOrder(orderId, (err, order) => {
    if (err) return callback(err);

    validateCustomer(order!.customerId, (err, customer) => {
      if (err) return callback(err);

      let inventoryResult: InventoryCheckResult | undefined;
      let shippingResult: ShippingQuote | undefined;
      let inventoryDone = false;
      let shippingDone = false;
      let errored = false;

      checkInventory(order!.items, (err, result) => {
        if (errored) return;
        if (err) {
          errored = true;
          return callback(err);
        }
        if (!result!.allAvailable) {
          errored = true;
          return callback(new Error(`inventory unavailable for order ${order!.id}`));
        }
        inventoryResult = result;
        inventoryDone = true;
        if (shippingDone) proceed();
      });

      getShippingQuote(order!.address, (err, quote) => {
        if (errored) return;
        if (err) {
          errored = true;
          return callback(err);
        }
        shippingResult = quote;
        shippingDone = true;
        if (inventoryDone) proceed();
      });

      function proceed(): void {
        reserveInventory(order!.items, (err, reservation) => {
          if (err) return callback(err);

          const amountCents = order!.totalCents + shippingResult!.costCents;
          chargePayment(customer!.paymentMethodId, amountCents, (err, charge) => {
            if (err) {
              releaseInventory(reservation!.reservationId, (releaseErr) => {
                if (releaseErr) {
                  console.error("failed to release inventory after payment failure", releaseErr);
                }
                callback(err);
              });
              return;
            }

            createShipment(order!.id, reservation!.reservationId, shippingResult!, (err, shipment) => {
              if (err) return callback(err);

              notifyCustomer(customer!.email, order!.id, shipment!, (notifyErr) => {
                if (notifyErr) {
                  console.error("failed to notify customer of shipment", notifyErr);
                }
                callback(null, {
                  orderId: order!.id,
                  shipmentId: shipment!.id,
                  chargeId: charge!.id,
                });
              });
            });
          });
        });
      }
    });
  });
}
```

Note the behaviors that are load-bearing (not accidental):

- `checkInventory` and `getShippingQuote` run concurrently; whichever fails first invokes `callback` with that error, and the `errored` flag exists specifically to prevent a second, later result (success or failure) from the other concurrent call from invoking `callback` a second time.
- If inventory is unavailable, that is reported as an error through the same path as a transport/service error from `checkInventory`.
- If payment charging fails, the function attempts to release the already-made inventory reservation before reporting the original payment error to the caller; a failure to release inventory is logged but never replaces or suppresses the original payment error, and is never itself reported as the operation's failure.
- If customer notification fails after a successful shipment, the failure is logged but the overall operation is still reported as a success with the shipment and charge information.
- `callback` must be invoked exactly once, no matter which path is taken.

## Deliverable

Refactor `fulfillOrder` to use `async`/`await` instead of nested callbacks, while preserving every behavior listed above exactly. Your answer should:

1. Provide the refactored implementation (you may promisify the step functions as needed, and you may change `fulfillOrder`'s own public signature from callback-based to Promise-based if you think that is the right call — state explicitly whether you did, and what it means for existing callers).
2. Preserve the concurrent execution of the inventory check and shipping quote, the exact error-priority behavior between them, the compensating inventory release on payment failure, and the swallowed-but-logged notification failure.
3. Explicitly call out any subtle behavior-change traps that a naive async/await conversion of this code could introduce (for example, around how concurrent operations are joined, how a rejected promise that is not the one that determines the outcome is handled, or how exactly-once completion is guaranteed without the manual `errored` flag) and explain how your refactor avoids each one.
4. Note any part of the original behavior you believe is actually undesirable and would want to change in a follow-up, clearly separated from the behavior you preserved as-is in this refactor.
