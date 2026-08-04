## Context

You are reviewing the caching layer of a product-catalog service (TypeScript, Node.js) that sits in front of a Postgres read replica pool. The service runs behind a load balancer across 12 pods and serves product detail reads at high volume. Product data is updated both through routine catalog syncs and through an internal admin tool used by merchandising staff, including time-sensitive "flash sale" price changes.

Current implementation:

```typescript
import { createClient, RedisClientType } from "redis";

interface Product {
  id: string;
  name: string;
  priceCents: number;
  updatedAt: string;
}

interface ProductRepository {
  fetchProduct(productId: string): Promise<Product>;
  updateProduct(productId: string, patch: Partial<Product>): Promise<Product>;
}

export class ProductCatalogService {
  private readonly ttlSeconds = 60;

  constructor(
    private readonly redis: RedisClientType,
    private readonly db: ProductRepository,
  ) {}

  async getProduct(productId: string): Promise<Product> {
    const cacheKey = `product:${productId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Product;
    }

    const product = await this.db.fetchProduct(productId);
    await this.redis.set(cacheKey, JSON.stringify(product), { EX: this.ttlSeconds });
    return product;
  }

  async updateProduct(productId: string, patch: Partial<Product>): Promise<Product> {
    const updated = await this.db.updateProduct(productId, patch);
    // The cache entry is left untouched here; it is simply left to expire
    // naturally after ttlSeconds and will be repopulated on the next read.
    return updated;
  }
}
```

## Constraints and observed behavior

- Sustained traffic is roughly 6,000 `getProduct` reads per second per pod (about 72,000/sec aggregate across the 12 pods), for a long-tail catalog of hundreds of thousands of distinct products.
- Each pod's connection to the Postgres read replica pool is capped at 40 connections.
- Dashboards show a recurring pattern: every time a popular product's cache entry reaches its 60-second expiry, requests for that product across many pods miss the cache within the same short window, and the read-replica connection pool for that pod saturates for roughly 200-400ms, during which `getProduct` p99 latency jumps from about 25ms to over 900ms before recovering until the next expiry.
- Separately, merchandising has filed complaints that price corrections made via the admin tool (which calls `updateProduct`) are sometimes not reflected to customers for close to a minute. For most catalog attributes this is tolerable, but for flash-sale price changes, the business requirement is that the new price must be visible to all reads within 5 seconds of the update being committed, for regulatory and customer-trust reasons.
- The service must continue to tolerate the underlying database or an individual pod being briefly unavailable without every read failing outright.
- There is no requirement that all 12 pods see a write at the exact same instant — the requirement is a bounded staleness window, not linearizable reads.

## Deliverable

Provide a caching and invalidation design that addresses both problems above. Your answer should:

1. Explain, in terms of the specific mechanism in the code shown, why cache expiry produces a connection-pool-saturating spike rather than a single graceful cache miss, and why the current design cannot meet the 5-second freshness requirement for flash-sale price changes while still tolerating routine staleness elsewhere.
2. Propose a concrete strategy for cache population/refresh that avoids many concurrent requests independently regenerating the same cache entry on expiry, and a concrete strategy for propagating writes (including the urgent flash-sale case) that meets the stated freshness bound. If more than one credible approach exists for either problem (e.g., request coalescing/locking, probabilistic early refresh, stale-while-revalidate serving, jittered TTLs, explicit invalidation on write via pub/sub or direct cache deletion, write-through updates), name the plausible options and recommend a combination, rather than asserting there is only one correct design.
3. Justify your recommendation in terms of the trade-offs it accepts: consistency/staleness guarantees versus latency versus implementation and operational complexity versus behavior under partial failure (e.g., a pod or the cache being briefly unreachable, or an invalidation message being lost or delayed). Be explicit about what staleness bound your design actually guarantees for both the routine case and the flash-sale case, and under what failure conditions that bound could be violated.
4. Describe how you would validate, before and after rollout, that the stampede is actually eliminated and that the freshness requirements are actually met — what you would measure and what evidence would tell you the design is working versus merely appearing to work under light load.
