# Similharity P-B.1 — Source-Bound Managed Record Browser

- New authenticated `POST /v2/m1/records/browse` route. It uses M1 source/embedding/binding verification and the physical record-read adapters, with signed cursor and 50-record pages. Browser-supplied owner, content, vectors, model, physical IDs or arbitrary pagination are not accepted.
- Page entries include current saved text (display capped at 8192 characters), stable server record UUID, provenance/readback state and allowed managed actions. The route refuses when a backend read fails and never pretends a failed read means missing.
- Re-attests source file and selected model, plus managed registry fingerprint, after reading the page. Cursor includes backend, model-selection generation, physical generation, owner, logical key, source revision, total count and physical-mode flag. Stale cursor/revision is rejected.
- `inventoryVerified:false`, `physicalInventoryComplete:false` remain explicit even at the last saved-source page. Whole physical inventory/backup is independent M3/M4 evidence.
- Zero new mutation routes or capabilities. Existing M1 record plan/execute and M3/M4 lifecycle code remains unchanged.

**Tests:** plugin's 878 tests, extension's 1,259 tests pass on bounded Node.js runs. Live host certification is pending.
