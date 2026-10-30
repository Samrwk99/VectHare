# M3v9 — verified cross-model staging handoff

**Base:** M3v8; changes cover VectHare and Similharity. **No model activation enabled.**

## Server / Similharity

1. Stage now creates a separate managed-record registry keyed to the *target* embedding collection, rather than copying old registry identity without a target registry. It compares the full staged manifest against active managed records and refuses a populated target registry.
2. After Qdrant physical staging, require fixed smoke queries, independent immutable target receipt, and the committed target registry. An unverified stage does not reach `COMMITTED`.
3. Write a one-use, checksum-sealed staging result tied to the original operation, source fingerprint, profile fingerprint, target logical key, backup and physical target. Crash after dispatch leaves the retained locks and a review-required audit.
4. Add `GET /v2/m3/collections/rebuild/stages/:operationId`, scoped to authenticated host/user. It re-reads the immutable receipt, full physical Qdrant target, managed registry, saved source and active/staged embedding profiles. It never activates a model or releases locks.
5. Refuse an already-claimed stage before expensive recomputation, in addition to durable claim-time race handling. Preserve legacy S01/S04 denials.

## Extension / VectHare

1. Add exact read-only request guard for staged-operation verification. Reject caller-supplied owner, profile, vectors, paths or query parameters.
2. Add staging operation UUID and **Verify staged physical target and registry** action; expose `REVIEW_REQUIRED` without replay/unlock controls.
3. Keep new-model activation blocked in the GUI and capability matrix.

## Remaining / safety rationale

Stage-only remains a maximum of 256 records and is nonresumable. The system still requires a single atomic per-source model-and-physical collection selection across M1, F02, F03, S04, M2 and retrieval. Enabling model activation or allowing repeated destructive operations from a published alias without those contracts would be unsafe. No real Qdrant/SillyTavern installation was available in this environment.
