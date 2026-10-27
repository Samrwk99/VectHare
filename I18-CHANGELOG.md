# I18 — UI lifecycle, timers, observers and settings state

Cumulative build: I01–I18. Scope: independent fixes only; Phase 2 systems are not implemented.

| Issue | Change |
|---|---|
| #15 | Namespace and replace Chunk Visualizer detail-panel handlers when rebinding. |
| #20 | Share the same live settings object between the VectHare UI and background handlers, retaining merged defaults. |
| #13 | Namespace Content Vectorizer's delegated document listeners and release them on close/reopen. |
| #14 | Keep Database Browser's existing modal-bound handlers through close/reopen, attach/detach a unique Escape handler, and register activation-editor chat-change listener once. |
| #22 | Replace the old settings panel on re-render; make the Diagnostics Escape listener idempotent. |
| #23 | Initialize Health Dashboard handlers and periodic indicator timer once; expose explicit cleanup. |
| #113 | Clear timeout timer on either promise settlement or timeout. |
| #24 | Maintain one Scene Markers MutationObserver, disconnecting it before observing a replaced chat element; prevent duplicate host listeners. |
| #26 | Await the post-run resume/status check for manual sync and repair actions. |

## Verification

- I18 regression tests: **11/11 passed** (`npm run test:i18`).
- Cumulative I01–I18 regression tests: **199/199 passed** (`npm run test:repair`).
- Syntax checked: **101 JavaScript/MJS source and test files**; zero errors.
- Live SillyTavern / Similharity integration was **not tested**.

## Known limitations

Phase 2's centralized `JobContext`, reliable cancellation and teardown manager, and other broader concurrency mechanisms remain outstanding. These are local fixes rather than proof of production safety under live races.
