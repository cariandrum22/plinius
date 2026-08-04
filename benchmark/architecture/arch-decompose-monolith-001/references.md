## Intent

Probes whether the model can decompose a coupled domain into cohesive, loosely-coupled services using a defensible principle (e.g. business capability or bounded context) rather than arbitrary technical layers, and whether it can sequence an incremental migration.

## Assumptions

The reviewer should assume a real operating business that cannot stop for a rewrite, a shared relational database, and multiple teams. No specific framework or cloud is mandated. Exact service counts are not prescribed.

## Reviewer notes

A strong answer ties boundaries to cohesion/coupling reasoning and to team ownership, sequences the carve-out by value and risk, and confronts the shared-data problem concretely (ownership, dual-writes, or read models) rather than hand-waving. It preserves correctness during migration and names real risks. A weak answer splits by technical layer, ignores the database, proposes a big-bang rewrite, or lists services without rationale.
