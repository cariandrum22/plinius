## Intent

Probes incremental legacy modernization: replacing a critical system slice by slice with continuous value and a safe interception/coexistence layer, avoiding a big-bang rewrite.

## Assumptions

Assume a business-critical, poorly-understood legacy system with a shared database, a prior failed rewrite, and a requirement to keep operating throughout. No mandated stack.

## Reviewer notes

A strong answer routes/intercepts to run old and new side by side, picks early slices by value and clean seams, keeps data consistent during half-migration (sync, dual-write, or read models), and ensures the effort is safe to pause. A weak answer proposes another big-bang rewrite, ignores the shared database, or has no interception/routing strategy for coexistence.
