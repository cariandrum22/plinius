## Context

You are reviewing an invoicing module for a billing service. It computes an invoice total by summing line-item amounts. QA has an independent script (implemented separately, using decimal/fixed-point arithmetic) that recomputes the expected total for the same line items and compares it against the value produced by this module. For most invoices the two totals match exactly, but for a small, seemingly unpredictable fraction of invoices — usually ones with more line items, or with certain combinations of amounts — the module's total is off from the independently computed expected total by exactly one cent (sometimes high, sometimes low).

Here is the relevant code:

```rust
struct LineItem {
    description: String,
    amount: f64, // dollars, e.g. 19.99
}

fn invoice_total(items: &[LineItem]) -> f64 {
    items.iter().map(|item| item.amount).sum()
}

fn format_total(total: f64) -> String {
    format!("${:.2}", total)
}

fn main() {
    let items = vec![
        LineItem { description: "Widget A".into(), amount: 19.99 },
        LineItem { description: "Widget B".into(), amount: 4.30 },
        LineItem { description: "Service fee".into(), amount: 0.10 },
        LineItem { description: "Widget C".into(), amount: 100.05 },
    ];

    let total = invoice_total(&items);
    println!("Total: {}", format_total(total));
}
```

Amounts always originate as decimal dollar values (e.g., from a price list or a prior calculation already rounded to the nearest cent) before being stored in `amount: f64`.

## Deliverable

Provide:

1. A precise explanation of why summing these `f64` values can produce a total that differs from the mathematically correct decimal sum by one cent, referencing what actually happens at the bit/representation level for values like the ones shown (you do not need to hand-compute exact IEEE 754 bit patterns, but your explanation should demonstrate genuine understanding of why decimal fractions like these are not exact in binary floating point, and why summation order and count affect whether the error becomes visible after rounding).
2. An explanation of why the error appears only on some invoices (e.g., correlated with more line items or particular amount combinations) rather than on every invoice.
3. A recommended approach for representing and summing monetary amounts in this codebase that would eliminate this class of error, along with the trade-offs of your recommendation (e.g., performance, precision, ease of integrating with existing APIs/serialization, developer ergonomics, and any remaining edge cases to be careful about).
