# VectHare — Phase 0 cumulative change log

**Starting point:** user-uploaded `VectHare(4).zip` (contains I01–I18 baseline), SHA-256 `2b59de6aa7036c5e18caee672735dab68271b33b8185cddb86de6e84c543aa03`. Supersedes the earlier plan filename `VectHare-I18-Fixed.zip`.

**Release intention:** one cumulative local safety build, retaining all I01–I18 changes. Source `manifest.json` remains `2.2.0-alpha`; no schema version bump, registry migration, C01–C14 feature delivery or server contract certification. The archive's own SHA-256 is recorded in the companion external `VectHare-Phase0-SHA256SUMS.txt` and release checklist; an archive cannot embed its own checksum without changing it.

### Changes by execution order

1. **P0-10:** `tests/contracts/{standard,qdrant,milvus,lancedb}.json`, `tests/contracts/README.md`, `utils/backend-contracts.js`. Documented adapter-client evidence and explicitly `unknown` server capabilities. **External live verification blocked**, not falsely claimed complete.
2. **P0-2:** `utils/collection-keys.js`, `core/collection-ids.js`, `core/collection-loader.js`, `core/core-vector-api.js`. Qualified key parse/format/resolve, ambiguous legacy identity refusal, colons preserved. No saved registry rewrite.
3. **P0-1:** `tests/helpers/fake-backend.js`, `tests/p0-*.node.test.mjs`. Reproducible fault scenarios including commit-after-lost-ACK, partial acceptance, failed readback, conditional delete and cross-tenant preservation.
4. **P0-4:** `utils/backend-operation-validation.js`, `core/destructive-safety.js`. Shared result validator; strict count/capability ACK rules and fail-closed delete acknowledgement checks.
5. **P0-12:** `utils/operation-outcomes.js`, `core/core-vector-api.js`, `core/chat-vectorization.js`. Operation IDs, immutable terminal status, uncertain writes and redacted bounded event records; reconciliation required when ACK cannot be proven.
6. **P0-11:** `utils/phase0-rollout.js`, `core/constants.js`. `verboseOperationEvents=false`, safe fallback, non-mutating future-migration snapshot helper; no persisted flags or schema bump.
7. **P0-9:** `utils/keyed-mutex.js`, `core/core-vector-api.js`, `core/collection-loader.js`, `core/destructive-safety.js`. In-tab keyed lock, abortable queued requests, in-flight write barrier, cautious global purge drain and uncertainty awareness.
8. **P0-3:** `core/collection-loader.js`, `core/collection-export.js`, `core/destructive-safety.js`, `core/core-vector-api.js`, `ui/ui-manager.js`, `ui/content-vectorizer.js`, `core/content-vectorization.js`. Unverified deletion, global purge and import overwrite blocked; failure retains registry/settings; direct raw Qdrant UI purge removed; unsafe Replace All now stops rather than continuing.
9. **P0-5:** `utils/replacement-safety.js`, `core/chat-vectorization.js`, `diagnostics/production-tests.js`, `ui/content-vectorizer.js`. Insert-readback-set-difference-delete primitive; unverified chat reverse-sync and repair deletion deferred; duplicate-hash diagnostic fixer refuses delete-first; old vectors retained and status reported incomplete when proof missing.
10. **P0-6:** `utils/security.js`, `utils/operation-outcomes.js`, `core/collection-export.js`, `ui/ui-manager.js`. Redact tokens/credential URLs/headers in reports, exports and event records while leaving operative backend credentials untouched. Server-side secret migration remains C05.
11. **P0-7:** `utils/feature-support.js`, `core/content-types.js`, `core/chunking.js`, `core/content-vectorization.js`, `core/emotion-classifier.js`, `ui/ui-manager.js`. Disabled unsupported adaptive chat/per-scene upload/similarity-classifier choices; enforce runtime rejection with no silent fallback. C13/C14 still own implementation.
12. **P0-8:** `index.js` #106 swipe update; `core/png-export.js`, `utils/safe-png.js` #118/#119 bounded PNG conversion, strict CRC/type/length/zlib stream ceiling; `core/conditional-activation.js` #73/#80 roles/lookback; backend `getStats()` #42 unavailable without tenant proof; `core/core-vector-api.js` #101 incompatible fallback; `diagnostics/configuration.js`, `diagnostics/index.js` #167/#18 parser; `core/chat-vectorization.js` #47 truthful repair status; `core/collection-export.js` #120 multi-import override rejection.

### Regression tests and verification

The original 18 issue-group tests run under `npm run test:repair`, with limited harness adjustments to load the new test dependencies and to assert safer behavior. The new suite runs under `npm run test:p0` and exercises the actual pure modules plus integration-level mocks. Local outcomes: **199/199 original tests passing** and **33/33 Phase 0 tests passing**. JavaScript syntax/archive integrity results are recorded in the companion verification report.

**Important limits:** The source archive contains neither the deployed SillyTavern server/version nor a pinned Similharity backend server implementation. No disposal-safe live server smoke tests were run. No actual verified server purge/tenant-filtering/complete-list contract is claimed. Thus collection deletes, global purges, overwrites, portions of repair, and certain tenant-scoped stats remain **intentionally unavailable** until version-pinned validation. This is a safety restriction, not a functional compatibility certification. Re-enabling requires C01/C06/C11 contract proof and a fresh review.

**Rollback:** preserve the uploaded original archive and extension settings backup; restore original files only after accounting for pending uncertain operations. Phase 0 does not rewrite registry format, schema or stored secrets. Project does not contain git history, so task checkpoints are supplied as code areas and tests rather than invented per-task commits.

### P0-9 corrective checkpoint — queued cancellation ordering

After initial Phase 0 delivery, an additional three-waiter test demonstrated that cancelling the middle waiter released its queue position before the active holder finished, allowing a subsequent same-collection operation to overlap. This **violated the per-key serialization guarantee** despite the original 30 Phase 0 tests passing.

- **Fixed:** `utils/keyed-mutex.js`. Cancelling an operation that has not entered the lock now rejects its caller promptly but defers release of its queue position until the preceding operation finishes. Aborting after a callback has started does not release the key while the callback is running. Signal listeners are removed when the waiter reaches the lock.
- **Added three tests:** `tests/p0-integration.node.test.mjs` verifies A→B(cancelled)→C FIFO, cancellation during an active callback, and the same queue safety when A fails.
- **Verification:** existing I01–I18 tests **199/199 PASS**; Phase 0 tests **33/33 PASS**; JS syntax **PASS**. No live backend test was performed.
- **Not changed:** registry format, extension manifest version, backend capability declarations, destructive-operation gates, or C01–C14 scope. Ownership-proof / qualified-key deletion integration remains part of the C01/C06/C11 handoff rather than being silently considered solved.
