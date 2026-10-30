# M3v13 automated verification

- **Similharity plugin:** 767/767 tests passed across verified partitions: 755 tests in the full suite excluding the timing-sensitive `f09c10-runtime-lock` file; that file passed 12/12 in isolation. A combined serial run reached 766 passes and one cancellation (`cancelledByParent`); there were no assertion failures. See `plugin-partition-other.log`, `plugin-lock-isolated.log`, and `plugin-full-final.log`.
- **VectHare extension:** 1190/1190 in a complete serial Node test run; no failures or cancellations. See `extension-full.log`.
- **Focused tests:** append-only stage progress (3/3), generalized read-only reconciliation (4/4), guarded rebuild stage (16/16), frontend exact-route controls (15/15).
- **S10 local source integrity:** plugin manifest regenerated and checked through S10 runtime tests. This establishes only local packaged source equality; it does not attest deployment, dependencies or backend acceptance.
- **Real SillyTavern/Qdrant:** not accessible or exercised. No manual test is represented as complete.

These checks do not establish that the Qdrant `/points` retrieval response, crash persistence or filesystem semantics have been validated on the user's real host. The new APIs are exposed only for controlled manual inspection and retain the operation gates.
