# Context

**Chirp** is a social product where users follow each other and see a
reverse-chronological feed of posts from the people they follow. The product is
growing fast: 20 million daily active users, an average of 400 follows per user,
and a read-to-write ratio of roughly 100:1 -- people scroll far more than they
post. Some accounts (celebrities, brands) have millions of followers. The
current design builds each feed on read by querying the posts of everyone a user
follows, and it is falling over during peak hours.

# Your task

1. Design a read path that serves feeds at scale. Explain your caching and/or
   materialization strategy and where the work happens (read time vs write time).
2. Address the **fan-out problem** directly: how do you handle a user with
   millions of followers posting, versus an ordinary user? Justify any hybrid
   approach.
3. Explain what data you cache, how it is invalidated or kept fresh, and what
   staleness the product can tolerate.
4. State the trade-offs of your approach in terms of write amplification,
   storage, latency, and freshness, and describe how it degrades under a sudden
   traffic spike.
5. Describe one alternative you rejected and why.

Assume you can add infrastructure but not change the core product behavior.
