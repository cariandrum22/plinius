## Intent

This benchmark probes supply-chain hygiene judgement: the ability to audit a manifest, lockfile, and CI configuration purely as data, find every place where the stated pinning and integrity guarantees have silently failed, distinguish symptom from root cause (the production date bug is a symptom; the CI tooling change is the mechanism that let it and other drift through), and design a hardening strategy grounded in the actual failure modes shown rather than generic "use a lockfile" advice.

## Assumptions

- The reviewer should treat the `package.json`, lockfile excerpt, and CI snippet as complete and accurate for the files and packages shown; no other manifest or lockfile entries are relevant to the anomalies present.
- The reviewer should assume ordinary npm semver-range semantics (a caret range like `^2.30.0` never matches a `3.x.x` version) and that a lockfile entry's `resolved` URL is expected to agree with its own `version` field for the same package.
- The reviewer should assume the narrative facts are accurate and given, not to be second-guessed: no PR diff introduced `legacy-formatter`, it is not a dependency of anything else in the tree, and the CI step was changed from `npm ci` to `npm install --no-audit --prefer-offline` roughly two months ago.
- The reviewer should not assume any single anomaly is "the" answer — the deliverable explicitly asks for every distinct weakness found in the given data.

## Reviewer notes

A strong answer treats the lockfile itself as evidence and reads it carefully rather than skimming: it should notice that the `date-fns` entry's resolved major version falls outside the range declared in `package.json`, that the `csv-stringify` entry's `version` field and its own `resolved` tarball URL disagree with each other (an internal inconsistency, not merely "an old version"), and that `legacy-formatter` is present in the lockfile with no path connecting it to any declared dependency — an orphaned entry that a faithful install would still pull in. It should then correctly identify the CI change from `npm ci` to `npm install --no-audit --prefer-offline` as the mechanism that let this drift happen silently, rather than treating the CI change as an unrelated detail, since the two install modes differ in whether a lockfile/manifest mismatch is treated as a hard failure or quietly reconciled.

Reward answers that connect the incident (a symptom of exactly one of these weaknesses) to the other latent weaknesses that have not yet caused a visible incident but represent equal or greater risk, particularly the orphaned package as an unreviewed, unexplained addition to the install graph. Penalize answers that address only the `date-fns` version and stop there, that offer generic advice ("commit your lockfile," "use a lockfile") without engaging the specific mechanisms shown, or that recommend restoring the previous CI install step without also addressing how the existing drift in the repository should be reconciled and reviewed rather than merely prevented from recurring.
