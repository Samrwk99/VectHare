# VectHare C03 — Chat-scoped jobs and cancellation

**Checkpoint:** 2026-10-27 · **Base:** `VectHare-I18-Phase0-C01-Return-Safety-Checkpoint.zip` · **Plugin:** unchanged; reference only.

## Scope and implemented changes

1. **Job ownership:** Added `core/job-context.js` and `core/chat-job-runtime.js`. Each job captures a frozen chat identity (persisted integrity UUID when present, otherwise current chat ID), character/group scope, collection key, generation version and its own AbortController. `assertCurrent()` prevents stale callbacks crossing chat boundaries; filename renames do not invalidate a stable integrity UUID.
2. **Manual, background and retrieval integration:** `synchronizeChat`, `vectorizeAll`, `repairChatVectors` and `rearrangeChat` use captured job contexts. Identity/generation checks protect post-await reads, database writes, search-debug output, prompt injection and progress reporting. Switching chats or editing/deleting/swiping messages invalidates affected jobs.
3. **Queue cancellation:** P0-9's existing FIFO mutex remains authoritative. C03 passes an AbortSignal into the collection locks for both vector inserts and targeted deletes, preventing aborted queued requests from beginning their backend calls when their turn arrives.
4. **Write uncertainty:** `trackWrite` records an operation marker **before** transport, with no message bodies or credentials, and retains it after cancellation, network failure, missing ACK or `status:'uncertain'`. Confirmed receipts alone clear the marker. Interrupted markers are read back at startup as uncertain, with no automatic write replay. Large uncertain histories compact into conservative per-collection counts.
5. **Global purge ordering:** When a verified contract becomes available, the guard now closes admission first, aborts jobs, awaits tracked operations, then checks the Phase 0 write barrier. Uncertain or incomplete writes block purge; `finally` reopens admission. The current unverified live purge remains disabled.
6. **Lifecycle:** Idempotent top-level initialization guard, event-listener registry, status-timer guard and pagehide teardown. Teardown records pending write state synchronously; it does not attempt to await network work during unload.
7. **Stale UI and history:** Scene cache reads use per-refresh versions and chat identity checks. Resume/status lookups use chat identity as well as collection ID. Frequency counters are isolated by chat, qualified collection, and session/conversation scope in memory.
8. **Regression compatibility:** Isolated I03/I04/I06/I10/I15/I18 VM fixtures were updated to supply the new job/runtime dependencies. No prior backend capabilities were promoted to verified.

## Safety invariants

- An aborted client request is **not** proof of server-side noncommit. Lost acknowledgements and unknown results need reconciliation.
- A collection key cannot be used to bypass the Phase 0 FIFO lock. A cancelled waiter never starts its backend callback.
- A late retrieval cannot inject prompt text or debugger state into a different chat or generation.
- A pending operation marker is never automatically interpreted as success or replayed.
- Live destructive purge/deletion stays blocked by the existing C01/plugin contract restrictions.

## Remaining limitations and Phase 2 dependencies

- **C02:** durable server-correlated operation journal, cross-reload write reconciliation, idempotence, confirmation/read-back and safe old-to-new replacement mapping. C03's browser-local markers provide conservative warning and purge blocking, **not** a completed durable transaction system.
- **C01/C06/C11:** no live destructive acceptance while the plugin may purge shared collections or return non-authoritative inventory/acknowledgements; no backend plugin edits were made.
- **C08:** full frequency semantics and persistence across browser reloads; C03's counters are currently in-memory, and frequency filtering still occurs before final prompt injection as in the prior code.
- **Host runtime testing:** real SillyTavern lifecycle event names/ordering, chat rename/branch/import behaviour, pagehide timing and deployed backend contracts must still be tested with disposable data. Some event hooks are registered only if that event name exists in the host's `event_types`.
- If browser localStorage is unavailable/unwritable, C03 keeps in-tab uncertainty but cannot guarantee a marker survives a crash; safe purge remains blocked in that tab.

## New files

- `core/job-context.js`
- `core/chat-job-runtime.js`
- `utils/activation-history.js`
- `tests/c03-jobs.node.test.mjs`
- `tests/c03-purge.node.test.mjs`

Run: `npm run test:c03`. Also run all earlier suites listed in `C03-VERIFICATION.md`.
