# F09 — Read-only ordinary-memory candidate integration

**Baseline:** F08 matched build. **Versions:** VectHare `2.2.0-alpha.s11.14-f09`, Similharity `3.2.10-s10.13-f09`.

## Implemented

- Added plugin route `POST /v2/workflows/preview`. It accepts only a saved source file selector, exact embedding profile, backend/config selector, numeric query vector and bounded `topK`; it cannot accept owner, physical collection, record deletion, arbitrary paths, API keys or ordinary write authorization.
- Refactored F02's scoped read execution into `executeF02ScopedRead`, reused by F09. Each query goes through fresh F01 source attestation, S02 explicit source-to-collection binding, the backend's v2 schema inspection, and strict physical ownership filters.
- Converts the returned rows into bounded prompt **candidates** identified exclusively by stable v2 record UUID and revision. Refuses malformed, duplicate, unscored or textless rows. No synthesized legacy hashes.
- Added a GUI preview for saved chats and user-owned lorebooks with exact embedding model, dimension, metric and backend selection. Numeric query vectors can be entered manually; an existing configured local WebLLM embedding provider can generate a query vector from text. Rendered record contents use `textContent` rather than HTML injection.
- Added a strict E02 gateway allowlist, build fingerprint pin, capability discovery and regression tests; no blanket read/write matrix changes.
- The preview **does not modify prompt content**. Its candidates are a bridge toward later use of the full prompt-selection, budget and injection pipeline.

## Explicitly NOT completed

- No automatic insertion, editing, deletion, reindexing, summary/World Info writes, linked-memory migration or legacy-record import; these remain behind the prior safety gates.
- No general host-managed embedding generation for server providers or automatic query text embedding for every provider.
- No real running Termux/LanceDB/Standard/Vectra/Milvus acceptance; offline tests do not prove external-writer atomicity or crash recovery.
- No production automatic retrieval-to-final-prompt integration; hash-based old pipeline must not be fed fabricated identities.

**Decision:** F09 partial implementation / guarded read-only candidate. The originally planned full ordinary memory activation still requires an F09 completion stage, as listed in `F09-REMAINING-WORK.md`.
