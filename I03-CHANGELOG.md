# I03 — Chat identity, switching and automatic synchronization

**Base:** `VectHare-I02-Fixed.zip` (retains I01 and I02 patches). Only I03 implementation files and tests were changed.

| Issue | Repair | Main files |
|---|---|---|
| **#30** | Keep confirmation `action` in scope throughout the auto-sync handler; safely handle cancel, re-vectorize and reconnect instead of referencing a block-scoped `result`. | `ui/ui-manager.js` |
| **#25** | Version resume/status checks to discard superseded or wrong-chat replies; guard delayed auto-sync checkbox imports and confirmation results against chat changes. | `index.js`, `ui/ui-manager.js` |
| **#11** | Serialize one toggle operation, disable the checkbox while pending, await Continue vectorization, propagate `true`/`false` from `vectorizeAll`, and restore the prior auto-sync setting on error. | `ui/ui-manager.js`, `index.js`, `core/chat-vectorization.js` |
| **#43** | Reverse-sync throttle tracks successful passes separately by backend, embedding source and collection ID; edits/deletes force only the current collection. | `core/chat-vectorization.js`, `utils/reverse-sync-throttle.js`, `index.js` |
| **#114** | Start the five-minute cooldown only when a metadata-backed reverse-sync pass completes successfully. Missing metadata, throws, or explicit deletion failure do not start cooldown; forced cleanup remains eligible for retry. | `core/chat-vectorization.js`, `utils/reverse-sync-throttle.js` |

## Validation

- `npm run test:i03`: **13/13** I03 focused tests passed.
- `npm run test:repair`: **31/31** cumulative tests passed (9 I01 + 9 I02 + 13 I03).
- `node --check` passed for every `.js` and `.mjs` source file.
- ZIP integrity checked at packaging time.
- No live SillyTavern or real backend integration tests were performed.

## Known limits and Phase 2 dependencies

- I03 only prevents stale **UI** refreshes; jobs may still write to a changed chat while running. Full chat-scoped job contexts, cancellation, and write/purge coordination remain in Phase 2 **C03**.
- The reverse-sync path still depends on existing metadata completeness and backend acknowledgement behavior; C01/C02/C06 will provide stronger deletion and write guarantees.
- `vectorizeAll` now returns `false` for aborted, blocked or failed runs (including user Stop) and `true` on completed runs. The Continue handler uses this status to avoid reporting a failed run as an enabled-and-completed success.
