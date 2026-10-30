# P-B.9 automated verification

- Plugin: 101 `tests/*.test.mjs` files in 11 bounded Node 22 `--no-opt --experimental-vm-modules --test` batches, **889 passed, zero failed or cancelled**. Plugin M4 runtime was not changed; only version and regenerated source-integrity manifest.
- Extension: 98 `tests/*.node.test.mjs` files in 10 bounded Node 22 batches with the same VM flags, **1,313 passed, zero failed or cancelled**.
- Total: **2,202 passing automated tests**.
- New `tests/pb9-m4-lifecycle.node.test.mjs` has nine tests, including end-to-end session orchestration for all three backends and all three actions; stale physical inventory; foreign selections; disabled delete; backup mismatch; lost acknowledgement; plan expiry; receipt forgery; and exact M4 gateway request-shape checks. The test adapter uses synthetic HTTP responses; it does not run destructive operations on live databases.
- Verification artifacts: `plugin/S10-BUILD-MANIFEST.json` recalculated from actual source files, and separately downloadable ZIP checksum manifest. Archive integrity is checked at package time.

**Not performed:** real SillyTavern/UI save/reload, real physical LanceDB/Vectra/Milvus destructive operations, real crash with operation receipt recovery. These are required manual acceptance conditions.
