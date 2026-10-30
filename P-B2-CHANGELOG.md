# P-B.2 — canonical read audit checkpoint (30 October 2026)

Matched code versions: **VectHare 2.2.0-alpha.p-b.2** and **Similharity 3.2.11-p-b.2**.

## Implemented

1. **P13/P16 — paginated saved-source audit** in Database Browser. Uses the authenticated M1 saved-source browse route and verifies each page/physical record; walks multiple server-issued pages with deterministic ordinal offsets, duplicate-UUID detection, cursor replay checks, file fingerprint, registry fingerprint, generation, embedding-profile selection generation, and user-scope re-attestation. A repeat read of the initial page at the end catches source/registry/generation changes after the final page. Large scans have **an explicit UI 200,000-record refusal**, not silent truncation; one network page is processed at a time with cancellation on selection changes. Audit result explicitly says `SAVED_SOURCE_RECORDS`, not physical collection inventory.
2. **P13 — verified Qdrant entire physical collection evidence**. Adds a separate read-only Database Browser action using the *existing* M3 managed-inventory route. It requires server-authenticated saved-source ownership, an exclusive owned physical collection, complete double scans, registry/ledger/stage rechecks, and the returned digest. Extension request gateway now authorizes this exact **read-only** selector with source and configId only, and the client rejects false proof metadata or any exposed raw records. This is **Qdrant-only**; other backends remain physically `UNVERIFIED` in P-B.2.
3. **P13 — explicit status vocabulary**. `UNPROVISIONED` from the authoritative server is not displayed as an empty collection. Legacy scenes are labelled as `LEGACY_UNVERIFIED`; their metadata is never described as verified managed-v2/whole physical inventory. Current marker writes are NOT migrated by this release.
4. **P22 foundation — revision-aware browse cursors**. Read-only browse cursors now bind the **server registry fingerprint** as well as source fingerprint and active generation; a changed registry prevents pages from silently spanning different record inventories. The P06 ordinary vectorization cursor deliberately remains independent of registry fingerprint, because that workflow mutates managed registry state between batches. Extension rechecks chat/backend selection after the asynchronous capability read to avoid stale view painting.

## Safety/non-goals

- No new vector or collection mutation routes, backup, import, empty or delete capability. P08, P14, P29 durable group repair and P22 complete lifecycle cache are unfinished. The obsolete purge button and 32/33/5 matrix are untouched.
- Complete traversal of saved-source records **does not** imply entire physical inventory or absence of foreign/orphan/historical vectors.
- A Qdrant M3 double-scanned inventory proof is a separate read-only aggregate, not a plan/receipt/authorization for delete, purge or restore.
- Full physical inventory for LanceDB/Vectra/Milvus, managed scene-metadata patch/read, and verified scene timeline remain future P-B tasks. Existing legacy scene cache may only provide advisory metadata.

## Verification

Plugin Node tests: **879 passing, 0 failing**. Extension Node tests: **1,267 passing, 0 failing** (`node --no-opt --experimental-vm-modules --test --test-concurrency=4 tests/*.node.test.mjs`). Independent tests added for cross-page read consistency, stale- and forged-cursor handling, non-advancing/duplicate IDs, empty provisioned source, final source re-attestation, strict M3 proof, gateway spoof rejection, and P06 registry-cursor compatibility. Live host tests remain outstanding.
