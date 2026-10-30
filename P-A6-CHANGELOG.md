# P-A.6 — Source-authoritative managed Repair reconciliation

**Date:** 30 October 2026  
**Packages:** VectHare `2.2.0-alpha.p-a.6` + Similharity `3.2.11-p-a.6`

## Changes

- Saved-chat snapshot is authoritative for the desired current records; UUID, source scope, pinned embedding profile and file fingerprint stay server-attested.
- P05 Repair preview now reads the physical managed record for *every* source entry, including UNTRACKED and DELETED registry states (not just ACTIVE). A missing ACTIVE record is eligible for the narrowly scoped `repair-missing` action, which requires a fresh plan, independently confirmed absence on execution, certified insert capability, a single S04 mutation, verified readback and managed registry `finish`.
- An existing, proven owned/source-current v2 record whose registry is absent/stale/deleted can use `repair-registry`. This is an exact ticketed server-side compare-and-set on the registry, **not a database write**; the record's source scope, embedding, provenance, content and physical state are checked at plan and execution time. The claimed ticket is one-shot; a persisted registry state on retry is handled by fresh preview.
- Changed records still use guarded M1 update; formerly deleted owned records with confirmed physical absence can use explicit restore. Records with unverified ownership, different source content/provenance, physical contradictions or outstanding WRITE_PENDING/DELETE_PENDING states are review-only. Read transport/schema failures still abort rather than masquerade as missing records.
- Repair continues over unaffected records, reports the number restored/updated/registry-reconciled/already healthy, and distinguishes `fullyReconciled` from having processed the whole inventory. No implicit orphan deletion and no retry of uncertain writes.
- Exact allowlists in the extension's request gateway and managed GUI cover the two new M1 reconciliation action names. The capability matrix and obsolete purge button are **unchanged**.

## Safety boundaries

- `repair-missing` never reuses a previously submitted uncertain operation: it is allowed only for an ACTIVE registry record with a physically absent owned ID at the time of both preview and execution; the operation uses the normal M1/S04 ticket, receipt and exclusive backend writer.
- `repair-registry` cannot adopt a foreign, unowned or stale-content vector. It requires an exact physical V2 record matching the saved source and profile, a fresh source and an unchanged registry fingerprint; it refuses pending states. Registry corrections require the corresponding existing admin-held capability evidence.
- Records not in the saved chat are listed as orphan review, not deleted; already-issued writes with unknown outcomes cannot be blindly retried. Physical reads that throw (e.g., connection timeout) stop rather than certify success.
- Automatic repair is **not** a general legacy migration, arbitrary vector overwrite, full cross-backend physical inventory reconciliation, storage diagnostic fixture or unattended M5 sync.

## Verification

See `P-A6-TEST-RESULTS.md`. Live host/provider/Qdrant/LanceDB/Vectra/Milvus acceptance remains outstanding. P04 linked/World Info behavior and P19 disposable storage-test fixture remain deferred. Do not mark P-A as live certified.
