# S08 — LanceDB and plugin Standard/Vectra local backend contracts

**Build:** 3.2.8-s08.0. **Base:** cumulative S07. **Mode:** source/offline-test checkpoint, NOT a safe production release.

## Changes

1. Added `lib/s08-local-contract.js`: immutable S04 plan and S05 binding checks; canonical identity, expected revision, payload and vector hash validation; float32-roundtrip preflight; consistent independent readback and explicit uncertain results.
2. Added `lib/s08-lancedb.js`: new internal v2 adapter using exact `vh2_...` mapped table names, Arrow schema/dimension inspection, physical ownership predicates, bounded offset pages, scoped similarity queries, disposable fixture insert/update/delete and post-mutation readback. No guessed table names, implicit table creation, direct filesystem deletion or table drop.
3. Added `lib/s08-vectra.js`: internal v2 adapter to a server-mapped physical Vectra LocalIndex; stable physical item IDs, record-level owner checks, display-only bounded pages and vector search, disposable fixture insert/upsert/delete under begin/end/cancel lifecycle and independent readback. The Vectra index is NOT SillyTavern's native `/api/vector` contract.
4. Added `tests/s08-local.test.mjs`: disposable tests for insert/edit/metadata/delete, ownership, same-record branch separation, schema mismatch, forged plan/payload refusal, backend failures, 1,090-record traversal, journal integration and existing public gates.
5. Updated `package.json` to `3.2.8-s08.0` and added `test:s08`, `check:s08`.
6. Updated S08 capability matrix. Preserved all prior S01–S07 files, v2 route gates, S01 legacy mutation blocks and server configuration requirements.

## Hard boundaries

- No public v2 read or mutation endpoint registered; `s08DisposableFixture` is a **test transport marker**, never an authorization grant.
- Both adapters require server-attested S05 bindings; real SillyTavern source rights, registry attestation and per-user root/path binding are NOT live-proven.
- No safe v2 table/index provisioner is exposed. Existing v2 schema must be provisioned by a separately approved, backend-verified workflow.
- LanceDB's update API and pagination support require an exact pinned SDK and native-version test; mocked methods do not certify Arrow serialization, optimistic concurrency or multi-process behavior.
- Vectra SDK version and physical index lifecycle need real-host verification; no global exclusive-writer contract has been proved.
- Offset pagination and in-memory list traversal do **not** certify consistent snapshots or complete export. No legacy collection was migrated or modified.
- Native SillyTavern Standard vector APIs are outside Similharity's S08 changes and require separate E05/E07 acceptance.
