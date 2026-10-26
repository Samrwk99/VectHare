# I05 — Collection metadata identity and trustworthy records

**Base:** `VectHare-I04-Fixed.zip`. This cumulative release retains I01–I04.

| Issue | Implemented correction | Main source |
|---|---|---|
| #175 | Deep-copy nested collection defaults and stored settings when reading, creating, setting, listing and migrating collection metadata; callers no longer share mutable default arrays and nested objects. | `core/collection-metadata.js` |
| #199 | Preserve nested record metadata during backend insert unless a corresponding top-level value is **defined**. `false`, `0`, `null` and empty arrays remain deliberate overrides. Applied to Standard, Qdrant, Milvus and LanceDB. | `utils/chunk-record-metadata.js`, `backends/{standard,qdrant,milvus,lancedb}.js` |
| #200 | Construct single- and multi-query metadata so the backend's `hash`, `text` and `score` overwrite conflicting values from stored metadata. | `utils/chunk-record-metadata.js`, `backends/{qdrant,milvus,lancedb}.js` |
| #37 | Preserve outer `hash`, `text` and `index` when merging list results with nested metadata for `getSavedHashes(..., true)`. Empty text and index `0` remain intact. | `core/core-vector-api.js`, `utils/chunk-record-metadata.js` |
| #83 | Chunk Visualizer only reports complete success when all backend metadata updates succeed. Failed chunks stay pending, with a partial-save warning; successful chunks are removed from the pending queue. | `ui/chunk-visualizer.js` |

## Verification

- `npm run test:i05`: **15/15 passed** (isolated fake-backend and VM tests covering all five I05 issues).
- `npm run test:repair`: **65/65 passed** (cumulative I01–I05 regressions).
- JavaScript syntax checks: **passed** across `.js` and `.mjs` source files.
- ZIP integrity: **passed**.
- **Not tested:** live SillyTavern, Similharity or physical vector databases.

Run the cumulative suite from the `VectHare` directory: `npm run test:repair`.

## Remaining limitations / Phase 2

- This is not a transactional multi-step save: if text edits, summary vector changes and a metadata update are combined in one chunk, earlier successful steps can still require reconciliation after a later failure. Phase 2 C02 handles idempotent, recoverable multi-step edits (#146).
- Canonical cross-backend metadata identity and full migration are Phase 2 C04; this change addresses mutable objects and record serialization only.
- The Standard native API does not persist full per-chunk metadata without the plugin; this change does not add that unsupported capability.
