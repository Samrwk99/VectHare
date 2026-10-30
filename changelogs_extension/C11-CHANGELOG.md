# Step 11 — C11 complete-inventory and bounded-export development checkpoint

Base: `VectHare-Step10-C10-Cumulative-Prompt-Safety-Checkpoint.zip`. The separate `VectHare-Similharity-Plugin.zip` is **read-only and unchanged**.

## Completed local implementation

1. Added `utils/c11-bounded-export.js`: verified pagination-to-NDJSON export, count-before/count-after, explicit positive end-of-list proof, qualified collection and per-record ownership checks, duplicate detection across pages, repeated cursor/no-progress protection, page limit, cancellation, and a terminal `{expectedCount,receivedCount,complete}` receipt. A failing writer is aborted; no complete receipt is produced on failure. No fixed 10k/50k cap on this verified path. Record data (including vectors where the adapter provides them) is emitted incrementally; only IDs are retained for deduplication.
2. Added a browser writer using File System Access API's `createWritable()` for backpressured disk streaming where available, with an explicitly bounded (32 MiB) Blob fallback elsewhere. Larger exports without streaming filesystem support are **refused**, rather than silently attempting unbounded memory allocation.
3. Added `core/c11-export.js`: capability-checked C06 adapter bridge. It requires certified `listPagination`, `completeInventory`, `tenantFilter`, `count`, and verified scoped record/count response envelopes. It rejects legacy ambiguous collection names and does **not** treat `chunks/list` alone as proof.
4. Added a verified NDJSON option to the database-browser export menu, with a preflight capability check before opening a save dialog. This option is deliberately unavailable with the unverified, unmodified plugin.
5. Marked legacy JSON exports as **UNVERIFIED** in the filename and result messaging; added an explicit incomplete inventory receipt to their statistics. Legacy JSON continues to be offered as a **partial/uncertified listing**, not an authoritative backup. Existing multi-collection exports keep their previous structure.
6. Added PNG export hard limits: at most 2,500 chunks and at most 6 MiB of uncompressed JSON payload; excess directs the user toward JSON/verified NDJSON. These checks run before creating the image and before compression. PNG export UI now warns when the underlying inventory is unverified.
7. Strengthened the existing P0 defensive PNG parser: requires IHDR first and a real IDAT/IEND, rejects duplicate/malformed IHDR, unknown chunk types, absurd/zero dimensions, bad lengths/CRC and trailing bytes. Existing decompression byte ceilings are preserved; oversize decompression now fails directly rather than trying legacy raw deflate after reaching the limit.
8. Applied existing recursive credential redaction to new NDJSON header metadata and records.
9. Added 33 focused C11 tests, including a fake backend with **120,001 records**, failure and progress scenarios, leak sentinel, and PNG guards. Updated two older regression fixtures to reflect the new parser and source declaration.

## Deliberate restrictions / not completed

- The real supplied plugin has an offset/hasMore listing interface, but its backend implementations do not provide verified uniform tenant-scoped pagination, independent scoped count, stable snapshot semantics, and deployed-server confirmation. **Do not mark #17/#198 live-accepted** and do not promote backend capability flags.
- The extension cannot truthfully generate a *certified complete* NDJSON backup from this plugin without those contracts. It is not a missing UI setting; the verified path will block by design.
- The new NDJSON archive is a streaming, receipt-based export format. A matching streaming NDJSON **import** is not in C11 and is **not yet implemented**. The original `.vecthare.json` remains the only supported import structure. Do not confuse the two formats.
- A stable physical snapshot is not proved by count-before/count-after alone. Real acceptance needs a documented snapshot, collection mutation barrier, or server version/readback guarantee.
- Large PNG imports are still limited by earlier Phase 0 safe-byte ceilings. PNG does not become a general large-dataset container.

## C11 status

- #17, #198: pagination framework implemented and mock-tested in prior stages; **live completeness blocked**.
- #63: bounded NDJSON export engine and gate implemented and locally tested; **live backend activation blocked**.
- #119, #118: defensive PNG parsing and bounded base64 already implemented in Phase 0; additional C11 limits and regression tests completed.

**Next planned development stage:** C12. Do not unlock C01/C02 destructive paths or treat the current plugin as an authoritative inventory source.
