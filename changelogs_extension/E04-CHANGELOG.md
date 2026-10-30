# VectHare E04 — Read-Only Functionality and Host Integration Hardening
**Date:** 2026-10-28  
**Baseline:** E03 cumulative persistence/recovery checkpoint  
**Similharity:** unchanged; no backend capability was unlocked.

## Why this checkpoint
E01–E03 established restrictive operation routing and recovery. E04 improves retrieval and prompt-facing *read-only* behavior where defects could be identified and tested without a live SillyTavern deployment. Unlike a live acceptance run, these changes cannot establish host event ordering, source inventory completeness, or real backend contracts.

## Production changes
1. `utils/prompt-receipts.js` — parse assembled chat prompt into individual message text segments. A prompt marker split across *different* chat messages no longer counts as one included memory. Multiple content parts of the *same* message may represent one complete block. Continue rejecting dry runs, malformed events, chat switches, and expired registrations. Do not claim a host event is authenticated merely because it was observed.
2. `utils/world-info-identity.js` — safely accept explicit empty WI activation containers (`[]`, empty Set/Map, `{activatedEntries:[]}`, `{activeEntries:[]}`, etc.) as evidence that a prior observed scan is empty. Arbitrary malformed event objects cannot erase known observations. Cache remains chat-specific and marked `previous-observed-scan`, not current-turn.
3. `core/world-info-integration.js` — replace the WI-only “all exclusive lorebooks win” branch with the existing C09 deterministic single-winner priority resolver. Deduplicate repeated semantic hits with identical world-qualified UID, retaining the best-ranked hit. Tolerate non-array observed active entries; clamp oversized/invalid `top_k` and `max_entries` inputs. No new backend operations.
4. `core/retrieval-planner.js` — reject fetched hard-linked members if backend metadata itself states `disabled:true` or `enabled:false`, even if the outer row appears eligible. Existing verified tenant-scoped `getByIds` requirement remains in place.
5. `core/c11-export.js` — before opening a save file, run a read-only count preflight that requires qualified scope, capability proof, independently attested count, bounded integer count, working scoped adapter, and non-aborted request. The complete NDJSON exporter then independently recounts and validates each page as before; preflight is **not** a stable snapshot guarantee. No unverified collection is labelled backed up.

## New verification
- `tests/e04-readonly.node.test.mjs`: 23 cases (receipt boundaries, WI cache, bounded exclusive policy, metadata disabled hard links, export count/abort/refusal).
- `tests/e04-worldinfo-integration.node.test.mjs`: 5 cases exercising the actual World Info module against a simulated host through `vm.SourceTextModule` (winner selection, deterministic ties, semantic dedup, unexpected active payload, bounds).
- `tools/e04-verify.mjs`: 11 static guard assertions, including unchanged safety posture.

## User-visible impact
- Fewer falsely credited prompt inclusions and fewer duplicate/contradictory WI results under tested payload conditions.
- More predictable deterministic selection when several exclusive lorebooks are active.
- Fewer misleading empty export files after initial count verification fails; exports still require proven backend inventory contracts.
- Disabled hard-linked rows cannot re-enter retrieval solely through a linked lookup.

## What E04 deliberately does not do
- Does not alter Similharity or any E02 runtime mutation policy.
- Does not enable frequency-conditioned activation (`C08_FINAL_INCLUSION_RECEIPT_AVAILABLE=false`).
- Does not grant Standard/LanceDB/Qdrant/Milvus `getByIds`, pagination, inventory or mutation capabilities without evidence.
- Does not prove SillyTavern prompt events, WI event order, tokenizer output, actual memory inclusion in requests, multi-tab reconciliation, or verified exports using real backend data.
- Does not claim all read-only pathways are production-certified. See `E04-READ-ONLY-ACCEPTANCE.md` and `E04-HOST-TEST-PLAN.md`.
