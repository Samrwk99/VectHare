# VectHare C13 — Chunking strategy implementation (Step 13)

**Baseline:** `VectHare-Step12-C12-Cumulative-Scenes-Temporal-Checkpoint.zip`.
**Scope:** C13 #57, #107 and #148. **Plugin:** untouched, not included.

## #57 — Real strategy-specific overlap

- Size-based adaptive, sentence, and dialogue splitting now apply the configured `chunkOverlap` to actual output instead of ignoring it. A splitter emits overlapping, bounded segments and keeps natural pre-split segment boundaries where practical; consecutive semantic blocks receive a word separator rather than being glued together.
- Zero overlap remains zero. Invalid overlap, non-integral sizes, zero-length progress, and impossible configurations raise errors. UTF-16 surrogate pairs are not cut in half. Test coverage includes long paragraphs, unbroken words, sentence and dialogue strategies, overlapping spans, empty/duplicate windows, and Unicode.
- Chunk metadata records strategy version and overlap provenance (`overlapPrefixLength` and source positions). Collection metadata persists the **effective** overlap and chunker version. Unit-based strategies do not claim overlap support. Uploaded adaptive-chat grouping remains message-membership-based rather than inventing overlap between unrelated messages.

## #107 — Adaptive chat as a versioned strategy

- Added deterministic adaptive chat grouping that respects the chosen character-size budget and preserves message IDs, stable message references, original-text fingerprint input, and segment offsets; oversized messages split into bounded pieces.
- Uploaded chat adaptive mode creates a **separate versioned chat collection ID**, never silently reuses the active chat's physical collection. Imported chat collections require ownership review before activation.
- A fail-closed dry-run rebuild planner (`planChunkStrategyRebuild`) requires distinct qualified source/destination keys, increasing chunker versions, and a supplied verified count; it requires an independently verified C02 commit and complete reference migration before activation. The planner does **not** mutate or delete the old collection.
- Existing live chats cannot switch to adaptive in-place. Adaptive is excluded from the live-chat settings dropdown and explicitly refused by the live grouping runtime. A previously saved unsupported value stays visible as unavailable for deliberate user action rather than falling back unnoticed.

## #148 — Imported scene marker support

- Imported chat content can use explicit per-message `sceneStart`/`sceneEnd`, `extra.vecthare` flags, `[SCENE START]`/`[SCENE END]` textual markers, or indexed `metadata.scenes` ranges.
- Source metadata and marker fields are preserved through JSON/JSONL upload normalization, preparation, preview, and vectorization. An imported scene creates a non-empty chunk containing the members with explicit `isScene`, start/end, scene index, title, and message membership metadata.
- The upload strategy appears only when **complete, valid** markers have been found. Empty, malformed, nested, overlapping, out-of-bounds or orphan boundaries fail closed with an explicit reason. Indexed ranges whose positions would change when removing system or empty messages are rejected.
- Existing live-chat scene marker operation remains separate from uploaded-scene parsing.

## Compatibility and release safety

No existing project files were removed. Previous tests were preserved; three prior tests were adapted to their new dependency/contract without weakening the original safety invariant. Previously saved settings are not destructively migrated. No plugin source has been edited. C01/C02/C05/C06 backend- and credential-related gates are unchanged.

**Still blocked:** Verified live backend writes, old-collection migration, automatic reference rewrites, and live rebuilt-collection activation. C13 provides local strategy implementations and conservative new-collection/dry-run paths, **not** a claim of completed server-side replacement transactions.
