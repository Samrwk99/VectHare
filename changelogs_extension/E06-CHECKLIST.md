# E06 — Checklist and gates

## Completed locally

- [x] Inspected the actual E05 code and supplied Similharity JS source; pinned the specific reference file SHA-256 hashes.
- [x] Kept Similharity unmodified and E02 shared-backend write gates DENIED.
- [x] Blocked ambiguous Milvus tenant-ID fallback; reused strict owner parsing for Qdrant.
- [x] Added per-result owner-field enforcement for Milvus query, hybrid, multi-query and display list; preserved Qdrant query checks.
- [x] Labeled shared display lists nonauthoritative; withheld shared-backend saved-hash inventory.
- [x] Added explicit empty-query uncertainty labels (no destructive decisions based on a lack of hits).
- [x] Implemented locally constrained, non-mutating diagnostic probe and tests.
- [x] Added offline static verification and E06 contract tests.
- [x] Recorded Qdrant physical name normalization and Milvus result projection hazards.
- [x] Produced source-backed plugin improvement proposal for later approval.

## Not complete — real backend/host acceptance

- [ ] Verify installed Similharity code matches the recorded hashes. The `/health` version alone is not sufficient.
- [ ] Run read-only diagnostic on a **disposable** SillyTavern installation for both shared backends, with sanitized logs, after host credentials/CSRF have been established via a safe procedure.
- [ ] Test known A/B tenant records and filter behavior, missing fields, server failures, and backend restarts; do not run destructive probes against non-disposable data.
- [ ] Verify whether Milvus can safely expose *authoritative* owner fields using a future plugin revision; E06 does **not** modify the server projection.
- [ ] Demonstrate real host prompt inclusion and correct handling of unverified/empty retrieval.
- [ ] E05 Standard and LanceDB write probes still outstanding.
- [ ] E07 final live integration, multi-user test and end-to-end certification outstanding.
- [ ] **Do not unlock Qdrant/Milvus mutations until the server contract is corrected and retested.**

## User impact

Qdrant retrieval with explicit ownership data can continue in guarded mode, though it is not yet live-certified. Milvus reads returning ownerless metadata now explicitly fail rather than possibly returning another tenant's content. Shared-backend saved hash enumeration is disabled because it can otherwise mistake a failed backend query for an empty collection. This is a further limitation on preexisting data management workflows, not a restoration of vector-writing capability.
