# I07 — Backup/restore fidelity and PNG compatibility

**Base:** I06-fixed project. **Scope:** I07 only; previous I01–I06 changes retained.

| Issue | Correction |
|---|---|
| #203 | Export/import enabled, lockMode, forceMode, exclusiveWhenActive, exclusiveScope and existing behavior settings; legacy backups safely default. |
| #209 | Database Browser detects multi-backups and imports each member with per-collection outcomes. |
| #208 | Precomputed-vector imports reject non-finite elements, inconsistent dimensions, invalid declared dimensions and incomplete vector sets. |
| #212 | Malformed JSON structures return validation errors instead of crashing preview/import. |
| #154 | Character-card PNG Base64 decodes as UTF-8, preserving Unicode names/descriptions. |
| #204 | Export keeps grouped-message memberships, indices, strategies, scene boundaries and other supported chunk metadata. |
| #213 | Empty collections import as metadata-only records without embedding/insertion requests. |
| #62 | Multi-backups reuse the full single-collection export path, including vectors and model/source details. |
| #117 | PNG fallback uses UTF-8 bytes and bounded Base64 encoding. |
| #210 | New zTXt uses zlib-wrapped DEFLATE; decoder accepts both zlib and legacy raw-deflate where browser supports raw. |
| #123 | PNG re-export replaces older vecthare text chunks; extraction prefers newest valid chunk for legacy duplicates. |
| #100 | Streaming embeddings reject Infinity and -Infinity (Number.isFinite). |

### Validation
- `npm run test:repair` — **85/85 passed** (75 previous + 10 new tests).
- JavaScript and MJS syntax checks — passed.
- ZIP integrity — passed after packaging.
- Live SillyTavern / Similharity integration — **not run**.

### Known limits
- C02 transactional import/write recovery, C04 cross-backend collection identity and C11 complete paginated exports / malformed PNG bound-checked parsing remain future work.
- Imported overwrite still uses existing purge-before-write semantics; do not test on irreplaceable collections until C02.
- Legacy raw-DEFLATE decoding depends on browser support for `DecompressionStream('deflate-raw')`.
