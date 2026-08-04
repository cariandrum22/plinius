## Intent
Probes recognition of SQL injection across both value and identifier positions and the ability to prescribe correct fixes, including why parameter binding cannot cover column/order identifiers.

## Assumptions
User input flows into both value and identifier positions in dynamically built SQL; the reviewer knows parameter binding covers values but not identifiers. Language/driver idioms apply.

## Reviewer notes
A strong answer parameterizes value positions and handles the sort column and direction via allow-listing (not binding), tracing each dangerous input and pointing to specific lines. A weak answer says 'use prepared statements' uniformly and misses that the ORDER BY identifiers cannot be parameter-bound, or overlooks the dynamic filter keys.
