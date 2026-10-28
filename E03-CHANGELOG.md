# VectHare E03 — Verified Persistence and Recovery Foundations

28 October 2026 · Based on the E02 cumulative extension. Similharity is unchanged.

## Implemented

1. **Committed C02 journal readback** (`utils/c02-operation-journal.js`): `create` and `put` now complete their IndexedDB write transactions and then independently reread the operation record in a new read transaction. `get` and `list` wait for their respective transaction completion. A missing or altered persisted checkpoint is an error, not proof of persistence. Duplicate-key protection still relies on atomic `objectStore.add`.
2. **Cross-tab mutation mutex** (`utils/e03-mutation-lock.js`): an exclusive browser Web Lock is required for production insert, targeted delete, collection deletion and C02 record replacement. The existing in-tab FIFO lock is retained inside the Web Lock, with careful abort ordering (a cancellation cannot release the Web Lock while queued in-tab work remains). Unsupported/insecure browsers fail closed. Waiting for the Web Lock has a bounded timeout; dispatched callback work is never cut off simply because the lock-acquire timeout expired.
3. **Shared-physical-collection serialization**: Qdrant writes from this browser origin share one Web Lock regardless of logical collection; Milvus likewise. Standard and LanceDB use qualified per-collection lock names. This cannot protect against uncooperative clients, separate origins or server-side plugin operations.
4. **C02 coordinator lock injection** (`utils/c02-replacement.js`): preserves the existing default for isolated unit tests; the actual extension passes the cross-tab lock explicitly. C01 deletion supports the same injection and the runtime supplies it. No cross-tab lease is claimed from localStorage or BroadcastChannel.
5. **C03 write-marker readback** (`core/job-context.js`): browser-local marker saves now verify the written bytes can be reread. If a deferred write has not started and its marker cannot be saved, the callback is rejected before dispatch. Already-started promises cannot be safely undone and remain uncertain. Browser-local marker verification is not a SillyTavern server-save receipt.
6. **Explicit persistence adapters** (`utils/e03-persistence.js`): `createVerifiedReceiptStore` commits a small, secret-filtered browser-local IndexedDB receipt and checks a separate read transaction; `createHostSettingsVerifier` requires both an affirmative **server-side** save acknowledgement and a **fresh server-side** readback. No host verifier is configured without a verified deployed-host API. Consequently C01/C04 host-settings mutations remain denied by their existing durable-save guard.
7. **Consolidated read-only startup recovery** (`utils/e03-recovery.js` and `index.js`): reports pending C01 deletion markers, incomplete C02 journal entries, uncertain C03 write markers and journal-unavailable state in `globalThis.__vecthareRecoveryReport`. Existing user-facing startup warnings remain. No replay, deletion or automatic reconciliation request is sent.
8. **New verification**: 27 E03 tests including simulated dropped/altered IndexedDB writes, absent host acknowledgement, cross-tab serialization, cancellation, deferred write failure, recovery, plus static integration source checks (`tools/e03-verify.mjs`). Legacy VM test fixtures were updated for the new import and lock signature, without weakening production enforcement.

## Important limitations

- **No mutating operation has been unlocked.** E02's default-deny matrix continues to block unproven Standard/LanceDB writes and unsafe Qdrant/Milvus mutations.
- **SillyTavern settings durability is NOT verified.** Debounced `saveSettingsDebounced()` is not an acknowledgement; E03 adds a fail-closed host adapter but does not claim a supported fresh-read endpoint exists. No live host was available for that acceptance test.
- Browser IndexedDB readback proves only that the committed bytes were observable in a separate browser transaction. It is not a server disk fsync guarantee and is not a reliable substitute for host persistence or remote backend inventory proof.
- Web Locks protect cooperating tabs on the same browser origin only, not other SillyTavern users on other devices/browsers, plugin clients, or server processes. A browser without Web Locks now refuses guarded production mutation rather than silently using an in-tab-only mutex.
- Current C03 deferred writes use localStorage markers; E03 verifies their readback but does not claim localStorage commits are transactional or crash-proof. Durable cross-tab coordination of other non-vector settings writes awaits real-host assessment.
- No Qdrant/Milvus dimension-mismatch, tenant-scoped delete, idempotency or authentication defect was fixed; these are plugin issues.
- Existing C04 registry migration still has an intentionally disabled live write path, pending a validated host persistence transport. This is not silently marked done.

## Verification

- 937 total Node cases across 49 test files: 926 cases passed in the stable combined run, with the two VM-sensitive suites run separately (4 + 7 passed). The normal all-files runner intermittently reported **SIGSEGV** in older C09/C12 tests, despite those files passing independently. This is not reported as a clean single-run result.
- E01 historical source audit, E02 enforcement static audit and E03 integration source audit passed.
- 128 production `.js` sources passed `node --check`.
- No browser/SillyTavern session or real Qdrant/Milvus/LanceDB/Vectra backend acceptance was performed.
