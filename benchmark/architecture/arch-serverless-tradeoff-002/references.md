## Intent

Probes cloud compute-model selection driven by workload shape and requirements (idle cost, burst, cold-start tail latency) rather than fashion.

## Assumptions

Assume spiky/unpredictable load, a small team, cost sensitivity, and a latency-critical subset. No mandated vendor; a hybrid answer is acceptable.

## Reviewer notes

A strong answer maps each option's properties to this workload, is willing to split by criteria (idle cost favors serverless, tail latency may favor warm containers), and addresses cold starts for the latency-critical endpoints. A weak answer picks one model dogmatically, ignores cold-start tail latency, or omits idle-cost/lock-in considerations.
