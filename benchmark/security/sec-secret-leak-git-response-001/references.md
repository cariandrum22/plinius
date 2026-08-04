## Intent
Probes correct incident response to leaked secrets in version control: prioritizing rotation/revocation over cleanup, the limits of history rewriting, and durable prevention.

## Assumptions
The secret is already distributed via mirrors, forks, clones, and CI; the reviewer knows that exposure must be treated as compromise and that cleanup does not undo exposure.

## Reviewer notes
A strong answer rotates/revokes the credentials first and explains why (the secret must be assumed compromised), then clarifies that deleting from the latest commit does nothing and that history rewriting cannot recall existing clones/forks, and proposes automated prevention (scanning, pre-commit, secret managers). A weak answer leads with history rewriting, treats file deletion as sufficient, or relies on developer diligence alone.
