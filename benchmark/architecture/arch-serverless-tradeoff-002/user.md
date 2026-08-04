# Context

A team is choosing the compute model for a new backend that has a **spiky**
traffic profile: near-zero load overnight, sharp unpredictable bursts during the
day tied to customer campaigns, and a few latency-sensitive endpoints. They are
weighing function-as-a-service (serverless) against always-on containers behind
an autoscaler. The team is small and cares about operational overhead and cost,
but a subset of endpoints has strict tail-latency requirements.

# Your task

1. Compare serverless functions and container-based services for this workload
   across cost-at-idle, scale-to-burst behavior, tail latency (including cold
   starts), operational overhead, and vendor lock-in.
2. Recommend an approach -- which may be a *split*: some workloads serverless,
   some containerized. Justify the split criteria you use.
3. Address the latency-sensitive endpoints specifically and how your choice
   meets or fails their requirement.
4. State what your recommendation gives up and under what future conditions you
   would change it.

Both models are viable; the reasoning is judged.
