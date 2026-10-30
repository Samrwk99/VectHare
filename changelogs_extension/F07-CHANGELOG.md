# F07 — Standard/Vectra integration changelog

Baseline: F06 matched package. Delivered component versions: VectHare 2.2.0-alpha.s11.12-f07; Similharity 3.2.10-s10.11-f07.

## Similharity plugin Vectra (not native SillyTavern Standard)
- Added `lib/f07-vectra.js`: private, source-derived `vectra-v2/<physicalName>` paths; creation of NEW indexes only, explicit F03 receipt verification and server-generated schema seal for scoped v2 reads. Existing indexes are refused during provisioning.
- Extended F03 preview/provision/status to plugin Vectra, preserving one-time durable provisioning receipts and collection-wide locks.
- Connected guarded F02 Vectra read adapter to the F03 receipt-backed index factory; no browser-chosen path or physical ID.
- Corrected the Vectra SDK query call to `queryItems(vector, '', topK)`.
- Added a server-generated disposable Vectra lifecycle acceptance endpoint and an explicit source-bound manual mutation pilot (`insert`, `update`, `metadata`, `delete`) with S04 operation receipts and revision/readback validation.
- Registered F07 routes and conservative capability/contract discovery. Existing legacy routes, purge, automatic mutations and unsafe inventory/export remain denied.

## VectHare extension
- Added Vectra to the GUI-controlled F03 new-collection provisioner.
- Added F07 disposable Vectra acceptance and explicitly consented manual record pilot panels with read-only operation receipt inspection.
- Added precise E02 gateway rules for F07's narrow endpoints. Unknown routes and native Standard mutations remain denied.
- Fixed Standard endpoint diagnostics: only non-mutating list/query are probed; 403/500 are failures, NOT working endpoints; insert/delete/purge are marked NOT TESTED instead of attempting them.
- Updated plugin version, source fingerprint and contract verification. No capability gate widened for normal VectHare writes.

## Distinction and limitations
Plugin Vectra is **not** SillyTavern's native Standard `/api/vector/*` implementation. F07 does not certify or enable native mutation routes. Its Vectra SDK tests are simulated, not verified against the actual host installation. F07 does not re-enable normal chat vectorization, normal prompt retrieval, backups, migrations, or automatic summary/World Info CRUD.
