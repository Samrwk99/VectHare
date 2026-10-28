# VectHare Step 12 — verification report

Source: `VectHare-Step11-C11-Cumulative-Export-Checkpoint.zip` plus C12 changes. The separate `VectHare-Similharity-Plugin.zip` was used as previously supplied read-only contract evidence; plugin not modified.

## Executed checks

- I01–I18 tests: **199/199 passed** in 18 isolated serial node test runs. Parallel test runner previously produced a process-level SIGSEGV in I17 without an assertion failure; isolated I17 passed **7/7**.
- Phase 0: **33/33**.
- C01: **50/50**.
- C04/C06/C11-A: **24/24**.
- C04/C06/C11-B: **31/31**.
- C03: **38/38**.
- C07: **40/40**.
- C02: **61/61** (50 operation + 11 integration).
- Step 6: **37/37** (35 base + 2 cache).
- C05: **47/47**.
- C08: **44/44**.
- C09: **47/47**.
- C10: **58/58**.
- C11: **33/33**.
- **Earlier total: 742/742 passing**.
- C12 pure-unit, safety and contract tests: **30/30 passing**.
- C12 isolated scene timeline / actual retrieval-stage integration: **7/7 passing** (invoked with `node --experimental-vm-modules tests/c12-integration.node.test.mjs`, avoiding an intermittently crashing child test worker).
- **Cumulative: 779/779 passing**.
- JavaScript/ESM syntax: **169/169 files passed** (includes test modules).

## Fault cases

Wrong-chat/cross-collection timeline, stale scene anchors after copy, stable anchors after insertion, overlapping/out-of-range scenes, duplicate physical hash across collections, per-collection nostalgia/decay, metadata-only edit avoiding embeddings, unverified metadata receipts, failed reindex keeping old metadata, incomplete reference remap, rejected local settings persistence, invalid/oversized grouped-message membership.

## Unverified integration and capability gates

No live SillyTavern browser test or actual Similharity server test was performed. No pinned deployed backend version, authoritative point update/readback, atomic physical record+reference mutation, or durable host settings save contract was provided. Live C12 scene mutation remains **fail-closed**. Temporal weights rely on collection metadata and advisory chat-origin scene timelines; they are tested locally, not runtime-certified.

No existing test was intentionally weakened or deleted; no plugin source was modified.
