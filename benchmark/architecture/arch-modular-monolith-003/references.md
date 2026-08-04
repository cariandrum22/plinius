## Intent

Probes basic decomposition and cohesion judgment at small scale, and the distinction between logical modularity and physical distribution.

## Assumptions

Assume a small team, single deployable, no immediate need for services. The reviewer should reward pragmatism over architectural ambition.

## Reviewer notes

A strong answer gives cohesive modules with explicit interaction rules (e.g. public interfaces, no reaching into another module's tables) and explains how clean seams reduce future extraction cost without adopting distribution prematurely. A weak answer either recommends microservices anyway, defines modules with tangled cross-dependencies, or gives layers (controllers/services/models) instead of domain modules.
