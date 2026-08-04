# Context

**Brightpix** runs a media-processing SaaS whose cloud bill has grown to a point
where finance is demanding a serious reduction without degrading the product.
Costs come from: a large fleet of always-on compute doing on-demand image/video
transforms (highly variable load, provisioned for peak), egress bandwidth serving
processed media, and a warm data tier holding rarely-accessed originals. The
current architecture provisions statically for peak and keeps everything hot.

# Your task

1. Analyze where the money is likely going and identify the highest-leverage
   cost drivers to attack, given the description.
2. Propose architectural changes to reduce cost -- covering compute elasticity
   (matching capacity to actual load), storage tiering by access pattern, and
   egress/bandwidth reduction (e.g. caching/CDN, format choices). Tie each change
   to the driver it addresses.
3. Be explicit about the **trade-offs** each optimization introduces: latency,
   complexity, reliability, or the risk of under-provisioning during a spike.
   Cost cannot be optimized in a vacuum.
4. Recommend a sequencing: what to do first for the best return at lowest risk.
5. Name one optimization you deliberately did *not* recommend and why.

There is more than one valid plan; the reasoning is judged.
