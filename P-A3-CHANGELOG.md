# VectHare / Similharity — P-A.3 development release (30 October 2026)

## What P-A.3 finishes in code

This is a matched extension/plugin release based on P-A.2. P01–P03, P05–P06 and the **P-A embedding half** of P19 are code-ready for real host acceptance. P04's **P-A managed chat retrieval bridge** is code-ready; its full World Info/linked/condition execution acceptance extends into P-D/M6 and is not represented as complete. There are **no claims of user-host live verification**.

- **P01:** source-scoped authenticated `/v2/m1/preflight` validates configured and tested profiles **before** ordinary Sync, Repair, Content Vectorizer, record GUI, or DB provisioning. Respects M3 source-specific profile selection, actionable missing/unverified messages.
- **P02/P03:** server-local llama.cpp on arbitrary configured loopback port; Ollama `/api/embed`, vLLM/KoboldCpp OpenAI-style `/v1/embeddings`, exact model/dimension check, private server-managed setup and test GUI. Local HTTP fixtures verify shape/error handling; actual installs must be tested.
- **P04:** source-bound text-query embedding stays on plugin server and goes through F02 read authorization; refuses profile generation races. Extension refuses selected-chat changes before prompt registration, applies strict prompt token caps and escaped untrusted memory fences. Plugin stable-sorts matches by score/UUID and skips unevaluated conditional or disabled records (M6 must later evaluate conditions).
- **P05:** Repair Chat button and direct `repairChatVectors()` go through the same M1/S04 verified operations for managed Qdrant/LanceDB/Vectra/Milvus. Repairs both changed ACTIVE records (update) and missing UNTRACKED records (insert). Deleted/orphan/ambiguous records remain **review**, not automatically deleted; uncertain mutation never auto retries. Stop/Pause panel integrated; review shows non-success status.
- **P06:** server-signed 50-record pagination cursors bound to owner/backend/source/fingerprint, with private signing key persisted on disk, replace the old 80-record bound. Source full count and fingerprint are checked on each page and plan. Explicit consent, bounded 250/1000-record test, abort at safe checkpoints, verified per-record receipts, no false completion after interruption. No implicit uncertain-write replay.
- **P19 (embedding half):** diagnostics call read-only server embedding test, and the old legacy `/chunks/insert` storage diagnostic route has been removed. Storage test explicitly reports `SKIPPED / UNVERIFIED` until a safe server-issued fixture with verified cleanup exists.

## Boundaries and deferred work

- **Production acceptance remains conditional on the user's live test:** SillyTavern/Termux/Windows/Linux hosting, real llama.cpp/Ollama/vLLM/KoboldCpp endpoints, empty and existing database state for all four managed backends, real generated prompt use, edited/swiped chats, restarted batch workflows, and provider changeover.
- **P04 full completion in P-D/M6:** live World Info activation and linked/condition traversal are not enabled; condition-bearing records fail closed rather than being injected with unverified activation.
- **P19 storage fixture:** requires a server-authenticated disposable managed collection + verified cleanup. This release intentionally SKIPS storage-write diagnostics instead of performing legacy mutations.
- **P06 recovery:** persisted S04 operation receipts provide crash-safe verification/reconciliation. An interrupted run is not silently resumed by a browser-held cursor; user must review uncertain receipts before beginning a new explicit pass.
- No changes to the obsolete purge button. No new vector mutation safety exemptions or capability matrix enablement. Original **32 ENABLED / 33 BLOCKED / 5 UNSUPPORTED_BY_DESIGN** retained.

## Verification

- **Extension:** 88 test files, 5 bounded batches, **1,244 assertions passing, 0 failed**. Some earlier monolithic runs hit an intermittent unrelated native `SIGSEGV` in Node's emotion-cache test; the test passed standalone and in final batches.
- **Plugin:** 99 test files, six bounded groups, **861 assertions passing, 0 failed**. Monolithic run passed 832 subtests but did not terminate before the execution timeout; subsequent separately executed remaining groups (including all S10 tests) passed. Do **not** represent the interrupted monolithic invocation as a completed run.
- Local provider HTTP fixtures and mocked backend evidence are not live production certification.

See `P-A3-HOST-ACCEPTANCE-RUNBOOK.md` and updated P01–P37 register.
