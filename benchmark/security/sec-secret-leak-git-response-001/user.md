A developer discovers that a cloud provider access key and a database password were committed months ago in a `config.yaml` file, pushed to a repository that is mirrored to a few forks and has been cloned by several engineers and a CI system. The file was "deleted" in a later commit, but the values are still in history. The team asks you what to do.

```yaml
# config.yaml (historical commit)
aws_access_key_id: AKIA................
aws_secret_access_key: wJalr................
database_url: postgres://app:S3cr3tP@ss@db.internal:5432/app
```

Advise the team on the correct response. Cover the ordering and reasoning of the actions: what to do first and why, how to treat the exposed credentials, why removing the file from the latest commit is insufficient, and what history rewriting can and cannot achieve given the mirrors, forks, clones, and CI. Then describe how to prevent recurrence (developer workflow and automated controls) without relying on people simply "being careful". Explain the trust/impact reasoning behind prioritizing revocation over cleanup.
